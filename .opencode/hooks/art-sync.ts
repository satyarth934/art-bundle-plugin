import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const crcTable = Array.from({length: 256}, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  return value >>> 0;
});
function crc32c(bytes: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return result.toString("base64");
}
function verify(bytes: Buffer, file: CloudFile) {
  if (file.size !== bytes.length || (file.crc32c && file.crc32c !== crc32c(bytes))) throw new Error("Cloud object checksum or size changed");
}

export type CloudFile = { path: string; size: number; crc32c: string; generation: string };
export type SyncTransport = {
  inventory(): Promise<CloudFile[]>;
  download(file: CloudFile): Promise<Buffer>;
  upload(path: string, bytes: Buffer, generation: string): Promise<string>;
};
type RecordEntry = { hash: string; generation: string };
type State = { email: string; slug: string; records: Record<string, RecordEntry>; includes: string[] };
export type Conflict = { path: string; preview: string; generation: string; localHash: string; cloudHash: string; diff?: string };
export type SyncResult = { uploaded: string[]; downloaded: string[]; conflicts: Conflict[]; failed: { path: string; error: string }[] };

const projectQueues = new Map<string, Promise<unknown>>();
function queueProject<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  const settled = next.then(() => undefined, () => undefined);
  projectQueues.set(key, settled);
  void settled.then(() => { if (projectQueues.get(key) === settled) projectQueues.delete(key); });
  return next;
}
async function withFilesystemLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(root, ".opencode", "art-sync", "sync.lock");
  await fs.mkdir(path.dirname(lock), {recursive: true});
  const started = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started > 30_000) throw new Error("ART sync lock timed out; another process may still be syncing");
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
  try { return await action(); }
  finally { await fs.rm(lock, {recursive: true, force: true}); }
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const allowedUpload = (name: string, includes: string[]) =>
  ["scripts", "data", "outputs", "logs"].includes(name.split("/")[0]) || includes.includes(name);
const forbidden = (name: string) =>
  !name || name.startsWith("/") || name.includes("\\") || name.split("/").some((p) => !p || p === "." || p === "..") ||
  name.split("/").some((p) => p === ".git" || p === ".opencode") ||
  ["project.json", "user.json"].includes(path.posix.basename(name));

export function createSyncEngine(root: string, transport: SyncTransport) {
  const stateFile = path.join(root, ".opencode", "art-sync", "state.json");
  let running: Promise<SyncResult> | undefined;
  let rerun = false;
  const previews = new Map<string, Conflict>();
  const load = async (): Promise<State | undefined> => fs.readFile(stateFile, "utf8").then(JSON.parse, () => undefined);
  const save = async (state: State) => {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(path.join(path.dirname(stateFile), ".gitignore"), "*\n", {flag: "wx"}).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const temp = stateFile + `.tmp-${process.pid}`;
    await fs.writeFile(temp, JSON.stringify(state));
    await fs.rename(temp, stateFile);
  };
  const safeLocal = async (name: string) => {
    if (forbidden(name)) throw new Error(`Invalid project path: ${name}`);
    const full = path.join(root, name);
    let parent = path.dirname(full);
    while (parent.startsWith(root) && parent !== root) {
      const stat = await fs.lstat(parent).catch(() => undefined);
      if (stat?.isSymbolicLink()) throw new Error(`Symlink parent: ${name}`);
      parent = path.dirname(parent);
    }
    const stat = await fs.lstat(full).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error(`Symlink file: ${name}`);
    return full;
  };
  const localFiles = async (state: State) => {
    const files = new Map<string, Buffer>();
    const walk = async (folder: string) => {
      const full = path.join(root, folder);
      for (const entry of await fs.readdir(full, { withFileTypes: true }).catch(() => [])) {
        const name = folder ? `${folder}/${entry.name}` : entry.name;
        if (forbidden(name) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile()) files.set(name, await fs.readFile(await safeLocal(name)));
      }
    };
    for (const dir of ["scripts", "data", "outputs", "logs"]) await walk(dir);
    for (const name of state.includes) {
      if (forbidden(name)) continue;
      const file = await safeLocal(name);
      const bytes = await fs.readFile(file).catch(() => undefined);
      if (bytes) files.set(name, bytes);
    }
    return files;
  };
  const perform = async (): Promise<SyncResult> => {
    const state = await load();
    if (!state) throw new Error("Bind this folder to an ART project before syncing");
    const result: SyncResult = { uploaded: [], downloaded: [], conflicts: [], failed: [] };
    const remote = new Map((await transport.inventory()).filter((f) => !forbidden(f.path)).map((f) => [f.path, f]));
    const local = await localFiles(state);
    const paths = new Set([...remote.keys(), ...local.keys(), ...Object.keys(state.records)]);
    for (const name of paths) {
      try {
        const cloud = remote.get(name);
        const bytes = local.get(name) ?? await fs.readFile(await safeLocal(name)).catch(() => undefined);
        const record = state.records[name];
        if (!cloud && !bytes) continue; // No automatic deletion.
        if (!cloud && bytes) {
          if (record) { result.failed.push({ path: name, error: "Cloud file missing since last sync; no automatic restoration" }); continue; }
          if (!allowedUpload(name, state.includes)) continue;
          const generation = await transport.upload(name, bytes, "0");
          if (digest(await fs.readFile(await safeLocal(name))) !== digest(bytes)) throw new Error("Local file changed during upload; sync again");
          state.records[name] = { hash: digest(bytes), generation };
          result.uploaded.push(name);
        } else if (cloud && !bytes) {
          const downloaded = await transport.download(cloud);
          verify(downloaded, cloud);
          const target = await safeLocal(name);
          if (await fs.lstat(target).then(() => true, () => false)) throw new Error("Local file appeared during download; sync again");
          await fs.mkdir(path.dirname(target), { recursive: true });
          const tmp = `${target}.art-sync-${process.pid}`;
          await fs.writeFile(tmp, downloaded, { flag: "wx" });
          await fs.rename(tmp, target);
          state.records[name] = { hash: digest(downloaded), generation: cloud.generation };
          result.downloaded.push(name);
        } else if (cloud && bytes) {
          const localHash = digest(bytes);
          if (record && record.generation === cloud.generation && localHash === record.hash) continue;
          let cloudBytes: Buffer | undefined;
          if (!record || record.generation !== cloud.generation || (localHash !== record.hash && !allowedUpload(name, state.includes))) cloudBytes = await transport.download(cloud);
          if (cloudBytes) verify(cloudBytes, cloud);
          const cloudHash = cloudBytes ? digest(cloudBytes) : record!.hash;
          if (localHash === cloudHash) {
            state.records[name] = { hash: localHash, generation: cloud.generation };
          } else if (record && localHash === record.hash) {
            const target = await safeLocal(name);
            if (digest(await fs.readFile(target)) !== localHash) throw new Error("Local file changed during sync");
            const tmp = `${target}.art-sync-${process.pid}`;
            await fs.writeFile(tmp, cloudBytes!, { flag: "wx" });
            await fs.rename(tmp, target);
            state.records[name] = { hash: cloudHash, generation: cloud.generation };
            result.downloaded.push(name);
          } else if (record && record.generation === cloud.generation && allowedUpload(name, state.includes)) {
            const generation = await transport.upload(name, bytes, cloud.generation);
            if (digest(await fs.readFile(await safeLocal(name))) !== localHash) throw new Error("Local file changed during upload; sync again");
            state.records[name] = { hash: localHash, generation };
            result.uploaded.push(name);
          } else {
            const previous = previews.get(name);
            const reusable = previous?.generation === cloud.generation && previous.localHash === localHash && previous.cloudHash === cloudHash;
            const dir = reusable ? path.dirname(previous.preview) : await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-conflict-"));
            const preview = reusable ? previous.preview : path.join(dir, path.basename(name));
            if (!reusable) await fs.writeFile(preview, cloudBytes!);
            const localText = bytes.toString("utf8"), cloudText = cloudBytes!.toString("utf8");
            const textDiff = !localText.includes("\ufffd") && !cloudText.includes("\ufffd") && !localText.includes("\0") && !cloudText.includes("\0") && bytes.length < 64_000 && cloudBytes!.length < 64_000
              ? `--- local/${name}\n+++ cloud/${name}\n${localText.split("\n").map(line => `-${line}`).join("\n")}\n${cloudText.split("\n").map(line => `+${line}`).join("\n")}`
              : undefined;
            const conflict = { path: name, preview, generation: cloud.generation, localHash, cloudHash, diff: textDiff };
            previews.set(name, conflict);
            result.conflicts.push(conflict);
          }
        }
        await save(state);
      } catch (error) {
        result.failed.push({ path: name, error: "Transfer failed; retry sync or inspect the plugin log" });
      }
    }
    return result;
  };
  return {
    binding: load,
    async rebind(email: string, slug: string) {
      if (!/^[^/\s@]+@[^/\s@]+\.[^/\s@]+$/.test(email) || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("Invalid email or project slug");
      if (running) await running;
      const old = await load();
      if (old?.email === email && old?.slug === slug) return;
      await save({email, slug, records: {}, includes: []});
    },
    async bind(email: string, slug: string) {
      if (!/^[^/\s@]+@[^/\s@]+\.[^/\s@]+$/.test(email) || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("Invalid email or project slug");
      const old = await load();
      if (old && (old.email !== email || old.slug !== slug)) throw new Error("Folder already bound; explicitly unbind before changing projects");
      await save(old ?? { email, slug, records: {}, includes: [] });
    },
    async include(name: string) {
      if (forbidden(name)) throw new Error("Invalid path");
      const state = await load();
      if (!state) throw new Error("Bind first");
      if (!state.includes.includes(name)) state.includes.push(name);
      await save(state);
    },
    async sync(): Promise<SyncResult> {
      if (running) { rerun = true; return running; }
      running = queueProject(root, () => withFilesystemLock(root, async () => {
        let result = await perform();
        while (rerun) {
          rerun = false;
          result = await perform();
        }
        return result;
      })).finally(() => { running = undefined; });
      return running;
    },
    async resolve(name: string, choice: "local" | "cloud", preview: string, expectedGeneration: string, expectedLocalHash: string) {
      if (running) await running;
      return queueProject(root, () => withFilesystemLock(root, async () => {
      const state = await load();
      if (!state) throw new Error("Bind first");
      const offered = previews.get(name);
      if (!offered || offered.preview !== preview || offered.generation !== expectedGeneration || offered.localHash !== expectedLocalHash) throw new Error("Unknown or stale conflict preview; run sync again");
      const cloud = (await transport.inventory()).find((f) => f.path === name);
      if (!cloud || cloud.generation !== expectedGeneration) throw new Error("Cloud changed; sync again before resolving");
      const target = await safeLocal(name);
      const local = await fs.readFile(target);
      if (digest(local) !== expectedLocalHash) throw new Error("Local changed; sync again before resolving");
      if (choice === "local") {
        if (!allowedUpload(name, state.includes)) throw new Error("Register this path with art_sync_include before uploading a local resolution");
        const generation = await transport.upload(name, local, cloud.generation);
        state.records[name] = { hash: digest(local), generation };
      } else {
        const bytes = await transport.download(cloud);
        verify(bytes, cloud);
        if (digest(bytes) !== digest(await fs.readFile(preview))) throw new Error("Cloud preview changed; sync again");
        if (digest(await fs.readFile(target)) !== expectedLocalHash) throw new Error("Local changed during download; sync again");
        const tmp = `${target}.art-sync-${process.pid}`;
        await fs.writeFile(tmp, bytes, { flag: "wx" });
        await fs.rename(tmp, target);
        state.records[name] = { hash: digest(bytes), generation: cloud.generation };
      }
      await save(state);
      previews.delete(name);
      }));
    },
  };
}
