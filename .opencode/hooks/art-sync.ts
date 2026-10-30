import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

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
  initialize?(email: string, slug: string): Promise<void>;
  inventory(): Promise<CloudFile[]>;
  stat(path: string): Promise<CloudFile | undefined>;
  download(file: CloudFile): Promise<Buffer>;
  upload(path: string, bytes: Buffer, generation: string): Promise<string>;
};
type RecordEntry = { hash: string; generation: string };
type ConflictFingerprint = { localHash: string; cloudHash: string; generation: string };
type State = { email: string; slug: string; records: Record<string, RecordEntry>; includes: string[]; bootstrapCompleted?: boolean; conflicts?: Record<string, ConflictFingerprint> };
export type Conflict = { path: string; preview: string; generation: string; localHash: string; cloudHash: string; diff?: string };
export type SyncResult = {
  uploaded: string[]; downloaded: string[]; conflicts: Conflict[]; newConflicts: Conflict[]; pendingConflicts: Conflict[];
  failed: { path: string; error: string }[]; bootstrap: { completed: boolean; backedUp: string[] };
};

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
  name.split("/").some((p) => ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", ".art-sync"].includes(p) || p.includes(".tmp-") || p.includes(".art-sync-")) ||
  ["project.json", "user.json", ".DS_Store"].includes(path.posix.basename(name)) ||
  /\.(pyc|pyo|tmp|temp|part|swp)$/.test(path.posix.basename(name)) ||
  /(?:^|\/)[^/]+~$/.test(name);

export function createSyncEngine(root: string, transport: SyncTransport) {
  const stateFile = path.join(root, ".opencode", "art-sync", "state.json");
  let running: Promise<SyncResult> | undefined;
  let rerun = false;
  const previews = new Map<string, Conflict>();
  const ensureProjectDirectories = async () => {
    await Promise.all(["scripts", "data", "outputs", "logs"].map((directory) =>
      fs.mkdir(path.join(root, directory), {recursive: true})
    ));
  };
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
  const placeDownloaded = async (name: string, bytes: Buffer, replace: boolean, expectedLocalHash?: string) => {
    const target = await safeLocal(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.art-sync-${randomUUID()}`;
    await fs.writeFile(temp, bytes, { flag: "wx" });
    try {
      if (!replace && await fs.lstat(target).then(() => true, () => false)) throw new Error("Local file appeared during download; sync again");
      if (replace && expectedLocalHash && digest(await fs.readFile(target)) !== expectedLocalHash) throw new Error("Local file changed during sync");
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, {force: true});
      throw error;
    }
  };
  const backupLocal = async (name: string, bytes: Buffer, category = "bootstrap-backup") => {
    const relative = path.join(".opencode", "art-sync", category, ...name.split("/"));
    const backup = path.join(root, relative);
    await fs.mkdir(path.dirname(backup), {recursive: true});
    const existing = await fs.readFile(backup).catch(() => undefined);
    if (existing && digest(existing) === digest(bytes)) return;
    let target = backup;
    if (existing) target = `${backup}.local-${Date.now()}-${randomUUID()}`;
    await fs.writeFile(target, bytes, {flag: "wx"});
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
    // Legacy states with sync records already have a baseline; don't reinterpret them as new binds.
    if (state.bootstrapCompleted === undefined && Object.keys(state.records).length > 0) state.bootstrapCompleted = true;
    state.conflicts ??= {};
    const bootstrapping = state.bootstrapCompleted !== true;
    const result: SyncResult = { uploaded: [], downloaded: [], conflicts: [], newConflicts: [], pendingConflicts: [], failed: [], bootstrap: {completed: !bootstrapping, backedUp: []} };
    const remote = new Map((await transport.inventory()).filter((f) => !forbidden(f.path)).map((f) => [f.path, f]));
    const local = await localFiles(state);
    const paths = new Set([...remote.keys(), ...local.keys(), ...Object.keys(state.records).filter((name) => !forbidden(name)), ...Object.keys(state.conflicts).filter((name) => !forbidden(name))]);
    for (const name of paths) {
      try {
        const cloud = remote.get(name);
        const bytes = local.get(name) ?? await fs.readFile(await safeLocal(name)).catch(() => undefined);
        const record = state.records[name];
        if (!cloud && !bytes) {
          delete state.conflicts[name];
          previews.delete(name);
          await save(state);
          continue; // No automatic deletion.
        }
        if (bootstrapping) {
          if (cloud && bytes) {
            const cloudBytes = await transport.download(cloud);
            verify(cloudBytes, cloud);
            const cloudHash = digest(cloudBytes);
            const localHash = digest(bytes);
            if (localHash !== cloudHash) {
              const target = await safeLocal(name);
              if (digest(await fs.readFile(target)) !== localHash) throw new Error("Local file changed during bootstrap");
              await backupLocal(name, bytes);
              if (digest(await fs.readFile(target)) !== localHash) throw new Error("Local file changed during bootstrap");
              await placeDownloaded(name, cloudBytes, true, localHash);
              result.downloaded.push(name);
              result.bootstrap.backedUp.push(name);
            }
            state.records[name] = { hash: cloudHash, generation: cloud.generation };
          } else if (cloud && !bytes) {
            const downloaded = await transport.download(cloud);
            verify(downloaded, cloud);
            await placeDownloaded(name, downloaded, false);
            state.records[name] = { hash: digest(downloaded), generation: cloud.generation };
            result.downloaded.push(name);
          } else if (!cloud && bytes && allowedUpload(name, state.includes)) {
            const generation = await transport.upload(name, bytes, "0");
            if (digest(await fs.readFile(await safeLocal(name))) !== digest(bytes)) throw new Error("Local file changed during upload; sync again");
            state.records[name] = { hash: digest(bytes), generation };
            result.uploaded.push(name);
          }
          await save(state);
          continue;
        }
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
          await placeDownloaded(name, downloaded, false);
          state.records[name] = { hash: digest(downloaded), generation: cloud.generation };
          result.downloaded.push(name);
        } else if (cloud && bytes) {
          const localHash = digest(bytes);
          if (record && record.generation === cloud.generation && localHash === record.hash) {
            if (state.conflicts[name]) {
              delete state.conflicts[name];
              previews.delete(name);
              await save(state);
            }
            continue;
          }
          if (cloud.crc32c && cloud.size === bytes.length && cloud.crc32c === crc32c(bytes)) {
            state.records[name] = { hash: localHash, generation: cloud.generation };
            delete state.conflicts[name];
            previews.delete(name);
            await save(state);
            continue;
          }
          let cloudBytes: Buffer | undefined;
          if (!record || record.generation !== cloud.generation || (localHash !== record.hash && !allowedUpload(name, state.includes))) cloudBytes = await transport.download(cloud);
          if (cloudBytes) verify(cloudBytes, cloud);
          const cloudHash = cloudBytes ? digest(cloudBytes) : record!.hash;
          if (localHash === cloudHash) {
            state.records[name] = { hash: localHash, generation: cloud.generation };
          } else if (record && localHash === record.hash) {
            const target = await safeLocal(name);
            if (digest(await fs.readFile(target)) !== localHash) throw new Error("Local file changed during sync");
            await placeDownloaded(name, cloudBytes!, true, localHash);
            state.records[name] = { hash: cloudHash, generation: cloud.generation };
            result.downloaded.push(name);
          } else if (record && localHash !== record.hash && cloudHash === record.hash && allowedUpload(name, state.includes)) {
            const generation = await transport.upload(name, bytes, cloud.generation);
            if (digest(await fs.readFile(await safeLocal(name))) !== localHash) throw new Error("Local file changed during upload; sync again");
            state.records[name] = { hash: localHash, generation };
            result.uploaded.push(name);
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
            result.pendingConflicts.push(conflict);
            const previousFingerprint = state.conflicts[name];
            const unchanged = previousFingerprint?.localHash === localHash && previousFingerprint.cloudHash === cloudHash && previousFingerprint.generation === cloud.generation;
            state.conflicts[name] = {localHash, cloudHash, generation: cloud.generation};
            if (!unchanged) {
              result.conflicts.push(conflict);
              result.newConflicts.push(conflict);
            }
          }
        }
        if (!result.pendingConflicts.some((conflict) => conflict.path === name)) {
          delete state.conflicts[name];
          previews.delete(name);
        }
        await save(state);
      } catch (error) {
        result.failed.push({ path: name, error: "Transfer failed; retry sync or inspect the plugin log" });
      }
    }
    if (bootstrapping && result.failed.length === 0) {
      state.bootstrapCompleted = true;
      result.bootstrap.completed = true;
      await save(state);
    } else if (bootstrapping) {
      result.bootstrap.completed = false;
    }
    return result;
  };
  return {
    binding: load,
    async rebind(email: string, slug: string) {
      if (!/^[^/\s@]+@[^/\s@]+\.[^/\s@]+$/.test(email) || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("Invalid email or project slug");
      if (running) await running;
      return queueProject(root, async () => {
        const old = await load();
        await transport.initialize?.(email, slug);
        await ensureProjectDirectories();
        if (old?.email === email && old?.slug === slug) return;
        await save({email, slug, records: {}, includes: [], bootstrapCompleted: false});
      });
    },
    async bind(email: string, slug: string) {
      if (!/^[^/\s@]+@[^/\s@]+\.[^/\s@]+$/.test(email) || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("Invalid email or project slug");
      return queueProject(root, async () => {
        const old = await load();
        if (old && (old.email !== email || old.slug !== slug)) throw new Error("Folder already bound; explicitly unbind before changing projects");
        await transport.initialize?.(email, slug);
        await ensureProjectDirectories();
        await save(old ?? { email, slug, records: {}, includes: [], bootstrapCompleted: false });
      });
    },
    async include(name: string) {
      if (forbidden(name)) throw new Error("Invalid path");
      const state = await load();
      if (!state) throw new Error("Bind first");
      if (!state.includes.includes(name)) state.includes.push(name);
      await save(state);
    },
    async syncPaths(names: string[]): Promise<SyncResult> {
      if (running) await running;
      return queueProject(root, () => withFilesystemLock(root, async () => {
        const state = await load();
        if (!state) throw new Error("Bind this folder to an ART project before syncing");
        if (!transport.stat) throw new Error("Targeted ART stat is unavailable; update the ART sync transport");
        if (state.bootstrapCompleted === undefined && Object.keys(state.records).length > 0) state.bootstrapCompleted = true;
        state.conflicts ??= {};
        const result: SyncResult = {
          uploaded: [], downloaded: [], conflicts: [], newConflicts: [], pendingConflicts: [], failed: [],
          bootstrap: {completed: state.bootstrapCompleted === true, backedUp: []},
        };
        for (const name of [...new Set(names)]) {
          try {
            const target = await safeLocal(name);
            const bytes = await fs.readFile(target).catch(() => undefined);
            const cloud = await transport.stat(name);
            const record = state.records[name];
            if (!cloud && !bytes) {
              delete state.conflicts[name];
              previews.delete(name);
            } else if (!cloud && bytes) {
              if (record) result.failed.push({path: name, error: "Cloud file missing since last sync; no automatic restoration"});
              else if (allowedUpload(name, state.includes)) {
                const generation = await transport.upload(name, bytes, "0");
                if (digest(await fs.readFile(target)) !== digest(bytes)) throw new Error("Local file changed during upload");
                state.records[name] = {hash: digest(bytes), generation};
                result.uploaded.push(name);
              }
              delete state.conflicts[name];
              previews.delete(name);
            } else if (cloud && !bytes) {
              const downloaded = await transport.download(cloud);
              verify(downloaded, cloud);
              await placeDownloaded(name, downloaded, false);
              state.records[name] = {hash: digest(downloaded), generation: cloud.generation};
              result.downloaded.push(name);
              delete state.conflicts[name];
              previews.delete(name);
            } else if (cloud && bytes) {
              const localHash = digest(bytes);
              const fingerprintMatches = cloud.size === bytes.length && !!cloud.crc32c && cloud.crc32c === crc32c(bytes);
              if (record && record.generation === cloud.generation && localHash === record.hash && fingerprintMatches) {
                delete state.conflicts[name];
                previews.delete(name);
              } else if (fingerprintMatches) {
                state.records[name] = {hash: localHash, generation: cloud.generation};
                delete state.conflicts[name];
                previews.delete(name);
              } else {
                const cloudBytes = await transport.download(cloud);
                verify(cloudBytes, cloud);
                const cloudHash = digest(cloudBytes);
                if (!record && state.bootstrapCompleted !== true) {
                  if (localHash !== cloudHash) {
                    await backupLocal(name, bytes);
                    await placeDownloaded(name, cloudBytes, true, localHash);
                    result.downloaded.push(name);
                    result.bootstrap.backedUp.push(name);
                  }
                  state.records[name] = {hash: cloudHash, generation: cloud.generation};
                  delete state.conflicts[name];
                  previews.delete(name);
                } else if (localHash === cloudHash) {
                  state.records[name] = {hash: localHash, generation: cloud.generation};
                  delete state.conflicts[name];
                  previews.delete(name);
                } else if (record && localHash === record.hash) {
                  await backupLocal(name, bytes, "conflict-backup/local");
                  await placeDownloaded(name, cloudBytes, true, localHash);
                  state.records[name] = {hash: cloudHash, generation: cloud.generation};
                  result.downloaded.push(name);
                  delete state.conflicts[name];
                  previews.delete(name);
                } else if (record && cloudHash === record.hash && allowedUpload(name, state.includes)) {
                  const generation = await transport.upload(name, bytes, cloud.generation);
                  if (digest(await fs.readFile(target)) !== localHash) throw new Error("Local file changed during upload");
                  state.records[name] = {hash: localHash, generation};
                  result.uploaded.push(name);
                  delete state.conflicts[name];
                  previews.delete(name);
                } else if (record && record.generation === cloud.generation && allowedUpload(name, state.includes)) {
                  const generation = await transport.upload(name, bytes, cloud.generation);
                  if (digest(await fs.readFile(target)) !== localHash) throw new Error("Local file changed during upload");
                  state.records[name] = {hash: localHash, generation};
                  result.uploaded.push(name);
                  delete state.conflicts[name];
                  previews.delete(name);
                } else {
                  const previous = previews.get(name);
                  const unchangedPreview = previous?.generation === cloud.generation && previous.localHash === localHash && previous.cloudHash === cloudHash;
                  const dir = unchangedPreview ? path.dirname(previous.preview) : await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-conflict-"));
                  const preview = unchangedPreview ? previous.preview : path.join(dir, path.basename(name));
                  if (!unchangedPreview) await fs.writeFile(preview, cloudBytes);
                  const previousFingerprint = state.conflicts[name];
                  const unchanged = previousFingerprint?.localHash === localHash && previousFingerprint.cloudHash === cloudHash && previousFingerprint.generation === cloud.generation;
                  const localText = bytes.toString("utf8"), cloudText = cloudBytes.toString("utf8");
                  const diff = !localText.includes("\ufffd") && !cloudText.includes("\ufffd") && !localText.includes("\0") && !cloudText.includes("\0") && bytes.length < 64_000 && cloudBytes.length < 64_000
                    ? `--- local/${name}\n+++ cloud/${name}\n${localText.split("\n").map(line => `-${line}`).join("\n")}\n${cloudText.split("\n").map(line => `+${line}`).join("\n")}`
                    : undefined;
                  const conflict = {path: name, preview, generation: cloud.generation, localHash, cloudHash, diff};
                  previews.set(name, conflict);
                  state.conflicts[name] = {localHash, cloudHash, generation: cloud.generation};
                  result.pendingConflicts.push(conflict);
                  if (!unchanged) result.newConflicts.push(conflict);
                }
              }
            }
            await save(state);
          } catch {
            result.failed.push({path: name, error: "Targeted sync failed; retry or run art_sync"});
          }
        }
        result.conflicts = result.newConflicts;
        return result;
      }));
    },
    async sync(): Promise<SyncResult> {
      if (running) { rerun = true; return running; }
      running = queueProject(root, () => withFilesystemLock(root, async () => {
        let result = await perform();
        const discovered = new Map(result.newConflicts.map((conflict) => [conflict.path, conflict]));
        while (rerun) {
          rerun = false;
          result = await perform();
          for (const conflict of result.newConflicts) discovered.set(conflict.path, conflict);
        }
        result.newConflicts = [...discovered.values()];
        result.conflicts = result.newConflicts;
        return result;
      })).finally(() => { running = undefined; });
      return running;
    },
    async resolveBatch(options: {
      defaultChoice: "cloud" | "local" | "defer";
      perPathChoices?: Record<string, "cloud" | "local" | "defer">;
    }): Promise<{resolved: string[]; deferred: string[]; failed: {path: string; error: string}[]}> {
      if (running) await running;
      return queueProject(root, () => withFilesystemLock(root, async () => {
        const state = await load();
        if (!state) throw new Error("Bind first");
        state.conflicts ??= {};
        const choices = options.perPathChoices ?? {};
        if (!["cloud", "local", "defer"].includes(options.defaultChoice)) throw new Error("Invalid default conflict choice");
        for (const [name, choice] of Object.entries(choices)) {
          if (!state.conflicts[name]) throw new Error(`No pending conflict for ${name}`);
          if (!["cloud", "local", "defer"].includes(choice)) throw new Error(`Invalid conflict choice for ${name}`);
        }
        const pending = Object.keys(state.conflicts).sort().map((name) => ({
          name,
          fingerprint: state.conflicts![name],
          choice: choices[name] ?? options.defaultChoice,
        }));
        const deferred = pending.filter((item) => item.choice === "defer").map((item) => item.name);
        const selected = pending.filter((item) => item.choice !== "defer");
        if (!selected.length) return {resolved: [], deferred, failed: []};

        const remote = new Map((await transport.inventory()).filter((file) => !forbidden(file.path)).map((file) => [file.path, file]));
        const actions = [] as {name: string; fingerprint: ConflictFingerprint; choice: "cloud" | "local"; cloud: CloudFile; target: string; local: Buffer}[];
        for (const item of selected) {
          const cloud = remote.get(item.name);
          if (!cloud || cloud.generation !== item.fingerprint.generation) throw new Error(`Cloud changed for ${item.name}; sync again before resolving`);
          if (item.choice === "local" && !allowedUpload(item.name, state.includes)) throw new Error(`Register ${item.name} with art_sync_include before uploading a local resolution`);
          const target = await safeLocal(item.name);
          const local = await fs.readFile(target);
          if (digest(local) !== item.fingerprint.localHash) throw new Error(`Local file changed for ${item.name}; sync again before resolving`);
          actions.push({...item, choice: item.choice as "cloud" | "local", cloud, target, local});
        }

        const resolved: string[] = [];
        const failed: {path: string; error: string}[] = [];
        for (const action of actions) {
          try {
            if (action.choice === "local") {
              const cloudBytes = await transport.download(action.cloud);
              verify(cloudBytes, action.cloud);
              if (digest(cloudBytes) !== action.fingerprint.cloudHash) throw new Error("Cloud content changed; sync again");
              await backupLocal(action.name, cloudBytes, "conflict-backup/cloud");
              const generation = await transport.upload(action.name, action.local, action.cloud.generation);
              if (digest(await fs.readFile(action.target)) !== action.fingerprint.localHash) throw new Error("Local file changed during upload");
              state.records[action.name] = {hash: action.fingerprint.localHash, generation};
            } else {
              const bytes = await transport.download(action.cloud);
              verify(bytes, action.cloud);
              if (digest(bytes) !== action.fingerprint.cloudHash) throw new Error("Cloud content changed; sync again");
              await backupLocal(action.name, action.local, "conflict-backup/local");
              await placeDownloaded(action.name, bytes, true, action.fingerprint.localHash);
              state.records[action.name] = {hash: action.fingerprint.cloudHash, generation: action.cloud.generation};
            }
            delete state.conflicts[action.name];
            previews.delete(action.name);
            resolved.push(action.name);
            await save(state);
          } catch {
            failed.push({path: action.name, error: "Could not resolve conflict; sync again and retry"});
          }
        }
        return {resolved, deferred, failed};
      }));
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
         const cloudBytes = await transport.download(cloud);
         verify(cloudBytes, cloud);
         if (digest(cloudBytes) !== offered.cloudHash || digest(cloudBytes) !== digest(await fs.readFile(preview))) throw new Error("Cloud preview changed; sync again");
         await backupLocal(name, cloudBytes, "conflict-backup/cloud");
         const generation = await transport.upload(name, local, cloud.generation);
         state.records[name] = { hash: digest(local), generation };
      } else {
        const bytes = await transport.download(cloud);
        verify(bytes, cloud);
        if (digest(bytes) !== digest(await fs.readFile(preview))) throw new Error("Cloud preview changed; sync again");
        if (digest(await fs.readFile(target)) !== expectedLocalHash) throw new Error("Local changed during download; sync again");
         await backupLocal(name, local, "conflict-backup/local");
        await placeDownloaded(name, bytes, true, expectedLocalHash);
        state.records[name] = { hash: digest(bytes), generation: cloud.generation };
      }
      delete state.conflicts?.[name];
      await save(state);
      previews.delete(name);
      }));
    },
  };
}
