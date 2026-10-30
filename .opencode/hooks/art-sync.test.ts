import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSyncEngine } from "./art-sync.ts";

test("downloads cloud-only files, uploads eligible local-only files and excludes metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  const cloud = new Map<string, Buffer>([["final_files/report.pdf", Buffer.from([0, 255])], ["project.json", Buffer.from("{}")]]);
  const transport = {
    inventory: async () => [...cloud].filter(([key]) => key !== "project.json").map(([key, bytes]) => ({path: key, size: bytes.length, crc32c: "", generation: "1"})),
    download: async (file: { path: string }) => cloud.get(file.path)!,
    upload: async (p: string, bytes: Buffer) => { cloud.set(p, bytes); return "2"; },
  };
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts", "run.py"), "hello");
    await fs.writeFile(path.join(root, "README.md"), "not uploaded");
    const engine = createSyncEngine(root, transport);
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.deepEqual(result.downloaded, ["final_files/report.pdf"]);
    assert.deepEqual(result.uploaded, ["scripts/run.py"]);
    assert.deepEqual(await fs.readFile(path.join(root, "final_files", "report.pdf")), Buffer.from([0, 255]));
    assert.equal(cloud.has("README.md"), false);
    assert.equal(await fs.stat(path.join(root, "project.json")).then(() => true, () => false), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("first-sync mismatch preserves originals and previews cloud version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  const cloud = Buffer.from("cloud\n");
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local\n");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: cloud.length, crc32c: "", generation: "1"}],
      download: async () => cloud,
      upload: async () => { throw new Error("should not overwrite"); },
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.conflicts.length, 1);
    assert.equal(await fs.readFile(path.join(root, "scripts/run.py"), "utf8"), "local\n");
    assert.equal(await fs.readFile(result.conflicts[0].preview, "utf8"), "cloud\n");
    assert.equal(result.conflicts[0].preview.startsWith(root), false);
    assert.match(result.conflicts[0].diff, /-local/);
    assert.match(result.conflicts[0].diff, /\+cloud/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a changed cloud file is downloaded after prior sync, and double edits remain conflicts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  let generation = "1";
  let cloud = Buffer.from("initial");
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/result.txt", size: cloud.length, crc32c: "", generation}],
      download: async () => cloud,
      upload: async (_p, bytes, expected) => { assert.equal(expected, generation); cloud = bytes; generation = String(+generation + 1); return generation; },
    });
    await engine.bind("alice@example.com", "demo");
    assert.deepEqual((await engine.sync()).downloaded, ["outputs/result.txt"]);
    cloud = Buffer.from("cloud update"); generation = "2";
    assert.deepEqual((await engine.sync()).downloaded, ["outputs/result.txt"]);
    await fs.writeFile(path.join(root, "outputs/result.txt"), "local update");
    cloud = Buffer.from("another cloud update"); generation = "3";
    const conflict = (await engine.sync()).conflicts[0];
    assert.equal(conflict.path, "outputs/result.txt");
    await engine.resolve(conflict.path, "local", conflict.preview, conflict.generation, conflict.localHash);
    assert.equal(cloud.toString(), "local update");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("upload-only paths do not overwrite unlisted cloud files without last-sync evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "data"));
    await fs.writeFile(path.join(root, "data/new.csv"), "original");
    let uploads = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => [],
      download: async () => Buffer.alloc(0),
      upload: async () => { uploads++; throw new Error("412: object appeared"); },
    });
    await engine.bind("alice@example.com", "demo");
    assert.equal((await engine.sync()).failed.length, 1);
    assert.equal(uploads, 1);
    assert.equal(await fs.readFile(path.join(root, "data/new.csv"), "utf8"), "original");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("does not place downloaded bytes when cloud checksum disagrees", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/bad.bin", size: 1, crc32c: "AAAAAA==", generation: "7"}],
      download: async () => Buffer.from([1]),
      upload: async () => "1",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.failed.length, 1);
    assert.equal(await fs.stat(path.join(root, "outputs/bad.bin")).then(() => true, () => false), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("local project metadata is never uploaded even if placed under a sync folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "data"));
    await fs.writeFile(path.join(root, "data/project.json"), "secret");
    const uploaded: string[] = [];
    const engine = createSyncEngine(root, {
      inventory: async () => [],
      download: async () => Buffer.alloc(0),
      upload: async (name) => { uploaded.push(name); return "1"; },
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    assert.deepEqual(uploaded, []);
    assert.equal(await fs.readFile(path.join(root, ".opencode/art-sync/.gitignore"), "utf8"), "*\n");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("records with vanished local files recover cloud copy without deleting remote", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const content = Buffer.from("saved");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/saved.csv", size: 5, crc32c: "", generation: "1"}],
      download: async () => content,
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.unlink(path.join(root, "outputs/saved.csv"));
    const result = await engine.sync();
    assert.deepEqual(result.downloaded, ["outputs/saved.csv"]);
    assert.equal(await fs.readFile(path.join(root, "outputs/saved.csv"), "utf8"), "saved");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("cloud-only inventory paths cannot escape local root via symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-outside-"));
  try {
    await fs.symlink(outside, path.join(root, "outputs"));
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/hijack.csv", size: 1, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("x"),
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    assert.equal((await engine.sync()).failed.length, 1);
    assert.equal(await fs.stat(path.join(outside, "hijack.csv")).then(() => true, () => false), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); await fs.rm(outside, {recursive: true, force: true}); }
});

test("sync requests arriving during a run are followed by a fresh pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let scans = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => { scans++; if (scans === 1) await gate; return []; },
      download: async () => Buffer.alloc(0), upload: async () => "1",
    });
    await engine.bind("alice@example.com", "demo");
    const first = engine.sync();
    const second = engine.sync();
    release();
    await Promise.all([first, second]);
    assert.equal(scans, 2);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a cloud-only file colliding with an unrelated local file becomes a conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "final_files"));
    await fs.writeFile(path.join(root, "final_files/report.md"), "local");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "final_files/report.md", size: 5, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("cloud"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.conflicts.length, 1);
    assert.equal(await fs.readFile(path.join(root, "final_files/report.md"), "utf8"), "local");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("local changes during an upload are not marked synchronized", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "first");
    let generation = "1";
    let cloud = Buffer.from("first");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: cloud.length, crc32c: "", generation}],
      download: async () => cloud,
      upload: async (_name, bytes, expected) => {
        assert.equal(expected, generation);
        await fs.writeFile(path.join(root, "scripts/run.py"), "second edit");
        cloud = bytes; generation = "2";
        return generation;
      },
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.writeFile(path.join(root, "scripts/run.py"), "changed");
    const result = await engine.sync();
    assert.equal(result.failed.length, 1);
    assert.equal(result.uploaded.length, 0);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("bind refuses silent switch of cloud projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => "1"});
    await engine.bind("alice@example.com", "demo");
    await assert.rejects(engine.bind("bob@example.com", "demo"), /already bound/);
    await engine.rebind("bob@example.com", "other");
    assert.equal((await engine.binding())!.email, "bob@example.com");
    assert.deepEqual((await engine.binding())!.records, {});
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("one engine waits for a different engine syncing the same project folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const transport = { inventory: async () => { calls++; if (calls === 1) await gate; return []; }, download: async () => Buffer.alloc(0), upload: async () => "1" };
    const a = createSyncEngine(root, transport), b = createSyncEngine(root, transport);
    await a.bind("alice@example.com", "demo");
    const first = a.sync();
    const second = b.sync();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a file created locally during download is never overwritten", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "data/new.csv", size: 5, crc32c: "", generation: "1"}],
      download: async () => {
        await fs.mkdir(path.join(root, "data"), {recursive: true});
        await fs.writeFile(path.join(root, "data/new.csv"), "local");
        return Buffer.from("cloud");
      },
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.failed.length, 1);
    assert.equal(await fs.readFile(path.join(root, "data/new.csv"), "utf8"), "local");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a second sync request preserves conflicts found on the first pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "local");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let scans = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => { scans++; if (scans === 1) await gate; return [{path: "scripts/a.py", size: 5, crc32c: "", generation: "1"}]; },
      download: async () => Buffer.from("cloud"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const first = engine.sync();
    const second = engine.sync();
    release();
    const [result] = await Promise.all([first, second]);
    assert.equal(result.conflicts.length, 1);
    assert.equal(scans, 2);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("sync keeps a first-pass transfer failure when a queued second pass succeeds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "local");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let scans = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => { scans++; if (scans === 1) await gate; return []; },
      download: async () => Buffer.alloc(0),
      upload: async () => { throw new Error("temporary outage"); },
    });
    await engine.bind("alice@example.com", "demo");
    const first = engine.sync();
    const second = engine.sync();
    release();
    const [result] = await Promise.all([first, second]);
    assert.equal(result.failed.length, 1);
    assert.equal(scans, 2);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("preview may not be substituted with an arbitrary local file during resolution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-unrelated-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: 5, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("cloud"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const conflict = (await engine.sync()).conflicts[0];
    const substitute = path.join(unrelated, "fake-preview");
    await fs.writeFile(substitute, "cloud");
    await assert.rejects(engine.resolve(conflict.path, "cloud", substitute, conflict.generation, conflict.localHash), /preview/i);
    assert.equal(await fs.readFile(path.join(root, "scripts/run.py"), "utf8"), "local");
  } finally { await fs.rm(root, {recursive: true, force: true}); await fs.rm(unrelated, {recursive: true, force: true}); }
});

test("sync waits for a filesystem lock held by another process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const lock = path.join(root, ".opencode", "art-sync", "sync.lock");
    const engine = createSyncEngine(root, {
      inventory: async () => { calls++; return []; },
      download: async () => Buffer.alloc(0), upload: async () => "1",
    });
    await engine.bind("alice@example.com", "demo");
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "pid"), String(process.pid));
    let calls = 0;
    const pending = engine.sync();
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(calls, 0);
    await fs.rm(lock, {recursive: true});
    await pending;
    assert.equal(calls, 1);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("the previous cloud object remains available for download when only local file exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "v1");
    let generation = "1";
    let cloud = Buffer.from("v1");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: cloud.length, crc32c: "", generation}],
      download: async () => cloud,
      upload: async (_name, bytes) => { cloud = bytes; generation = "2"; return generation; },
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.writeFile(path.join(root, "scripts/run.py"), "v2");
    await engine.sync();
    assert.equal(cloud.toString(), "v2");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("explicit rebind to the same project does not destroy sync history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => "1"});
    await engine.bind("alice@example.com", "demo");
    await engine.include("final_files/report.md");
    await engine.rebind("alice@example.com", "demo");
    assert.deepEqual((await engine.binding())?.includes, ["final_files/report.md"]);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("conflict resolution rejects cloud changes that happened while user inspected preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    let generation = "1";
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: 5, crc32c: "", generation}],
      download: async () => Buffer.from("cloud"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const conflict = (await engine.sync()).conflicts[0];
    generation = "2";
    await assert.rejects(engine.resolve(conflict.path, "local", conflict.preview, conflict.generation, conflict.localHash), /Cloud changed/);
    assert.equal(await fs.readFile(path.join(root, "scripts/run.py"), "utf8"), "local");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("failed sync on a cloud path is reported without leaking a signed URL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/result.csv", size: 5, crc32c: "", generation: "1"}],
      download: async () => { throw new Error("https://storage.googleapis.com/secret?signature=abc"); },
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.failed.length, 1);
    assert.equal(JSON.stringify(result).includes("signature=abc"), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("only an explicit project-relative file can be included for upload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => "1"});
    await engine.bind("alice@example.com", "demo");
    await assert.rejects(engine.include("../secrets.txt"), /Invalid path/);
    await assert.rejects(engine.include("/tmp/secret"), /Invalid path/);
    await engine.include("final_files/report.md");
    assert.deepEqual((await engine.binding())!.includes, ["final_files/report.md"]);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("resolving a conflict waits for an ongoing sync in the same project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    let block = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let uploads = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => { if (block) await gate; return [{path: "scripts/run.py", size: 5, crc32c: "", generation: "1"}]; },
      download: async () => Buffer.from("cloud"),
      upload: async () => { uploads++; return "2"; },
    });
    await engine.bind("alice@example.com", "demo");
    const conflict = (await engine.sync()).conflicts[0];
    block = true;
    const syncing = engine.sync();
    const resolving = engine.resolve(conflict.path, "local", conflict.preview, conflict.generation, conflict.localHash);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(uploads, 0);
    block = false; release();
    await Promise.all([syncing, resolving]);
    assert.equal(uploads, 1);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("keeping cloud version checks local content again before replacing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: 5, crc32c: "", generation: "1"}],
      download: async () => { await fs.writeFile(path.join(root, "scripts/run.py"), "new local"); return Buffer.from("cloud"); },
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    // Initial cloud download mutates local too, so create a valid conflict with a fresh sync.
    const first = await engine.sync();
    assert.equal(first.conflicts.length, 1);
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    const conflict = (await engine.sync()).conflicts[0];
    await assert.rejects(engine.resolve(conflict.path, "cloud", conflict.preview, conflict.generation, conflict.localHash), /Local changed/);
    assert.equal(await fs.readFile(path.join(root, "scripts/run.py"), "utf8"), "new local");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a downloaded-only path changed locally after sync still gets a cloud conflict preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let cloud = Buffer.from("first");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "final_files/result.md", size: cloud.length, crc32c: "", generation: "1"}],
      download: async () => cloud,
      upload: async () => { throw new Error("download-only path must not upload"); },
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.writeFile(path.join(root, "final_files/result.md"), "local edit");
    const result = await engine.sync();
    assert.equal(result.failed.length, 0);
    assert.equal(result.conflicts[0].path, "final_files/result.md");
    assert.equal(await fs.readFile(result.conflicts[0].preview, "utf8"), "first");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("failed upload after cloud generation changes is surfaced as conflict on retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "first");
    let generation = "1", cloud = Buffer.from("first");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: cloud.length, crc32c: "", generation}],
      download: async () => cloud,
      upload: async (_name, bytes) => { cloud = bytes; generation = "2"; throw new Error("lost response"); },
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.writeFile(path.join(root, "scripts/run.py"), "changed");
    assert.equal((await engine.sync()).failed.length, 1);
    const retry = await engine.sync();
    assert.equal(retry.conflicts.length, 0);
    assert.equal(retry.failed.length, 0);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a cloud generation change with identical bytes does not create a conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let generation = "1";
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/a.txt", size: 4, crc32c: "", generation}],
      download: async () => Buffer.from("same"), upload: async () => "3",
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    generation = "2";
    const result = await engine.sync();
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.failed, []);
    assert.equal((await engine.binding())!.records["outputs/a.txt"].generation, "2");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("manual cloud resolution does not overwrite a locally changed file during download", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    let downloadingResolution = false;
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/run.py", size: 5, crc32c: "", generation: "1"}],
      download: async () => {
        if (downloadingResolution) await fs.writeFile(path.join(root, "scripts/run.py"), "new edit");
        return Buffer.from("cloud");
      },
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const conflict = (await engine.sync()).conflicts[0];
    downloadingResolution = true;
    await assert.rejects(engine.resolve(conflict.path, "cloud", conflict.preview, conflict.generation, conflict.localHash), /Local changed/);
    assert.equal(await fs.readFile(path.join(root, "scripts/run.py"), "utf8"), "new edit");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("downloaded-only file edited locally requires explicit include before upload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let cloud = Buffer.from("first"), generation = "1";
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "final_files/result.md", size: cloud.length, crc32c: "", generation}],
      download: async () => cloud,
      upload: async (_name, bytes) => { cloud = bytes; generation = "2"; return generation; },
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.writeFile(path.join(root, "final_files/result.md"), "edited");
    const conflict = (await engine.sync()).conflicts[0];
    await assert.rejects(engine.resolve(conflict.path, "local", conflict.preview, conflict.generation, conflict.localHash), /include/);
    await engine.include("final_files/result.md");
    await engine.resolve(conflict.path, "local", conflict.preview, conflict.generation, conflict.localHash);
    assert.equal(cloud.toString(), "edited");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a cloud file in .opencode is excluded from local sync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let transfers = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: ".opencode/config.json", size: 3, crc32c: "", generation: "1"}],
      download: async () => {transfers++; return Buffer.from("foo");},
      upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(transfers, 0);
    assert.equal(result.downloaded.length, 0);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("download of an object with no checksum still verifies size", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/result.csv", size: 100, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("short"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    assert.equal((await engine.sync()).failed.length, 1);
    assert.equal(await fs.stat(path.join(root, "outputs/result.csv")).then(() => true, () => false), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("sync fails closed if the local binding state is corrupted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const stateFile = path.join(root, ".opencode/art-sync/state.json");
    await fs.mkdir(path.dirname(stateFile), {recursive: true});
    await fs.writeFile(stateFile, "not-json");
    const engine = createSyncEngine(root, {
      inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => "1",
    });
    await assert.rejects(engine.sync(), /state|JSON|binding/i);
    assert.equal(await fs.readFile(stateFile, "utf8"), "not-json");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("cloud side .git metadata is excluded from the local mirror", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/.git/config", size: 3, crc32c: "", generation: "1"}],
      download: async () => { throw new Error("never download"); }, upload: async () => "1",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.downloaded.length, 0);
    assert.equal(result.failed.length, 0);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a cloud-only file is discovered with matching relative path under nested folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "lh_outputs/cycle_2/plate1.csv", size: 5, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("plate"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.equal(result.downloaded.length, 1);
    assert.equal(await fs.readFile(path.join(root, "lh_outputs/cycle_2/plate1.csv"), "utf8"), "plate");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a local file edited after conflict preview can be re-reviewed without overwriting either original", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "one");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/a.py", size: 3, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("two"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const first = (await engine.sync()).conflicts[0];
    await fs.writeFile(path.join(root, "scripts/a.py"), "three");
    const next = (await engine.sync()).conflicts[0];
    assert.notEqual(next.localHash, first.localHash);
    assert.equal(await fs.readFile(path.join(root, "scripts/a.py"), "utf8"), "three");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("cloud-only files do not overwrite a directory already at the target path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "data"));
    await fs.mkdir(path.join(root, "data/result.csv"));
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "data/result.csv", size: 4, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("data"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    assert.equal((await engine.sync()).failed.length, 1);
    assert.equal((await fs.stat(path.join(root, "data/result.csv"))).isDirectory(), true);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a nested cloud file inside a symlinked parent is never downloaded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-outside-"));
  try {
    await fs.mkdir(path.join(root, "data"));
    await fs.symlink(outside, path.join(root, "data", "nested"));
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "data/nested/secret.csv", size: 4, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("data"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    assert.equal((await engine.sync()).failed.length, 1);
    assert.equal(await fs.stat(path.join(outside, "secret.csv")).then(() => true, () => false), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); await fs.rm(outside, {recursive: true, force: true}); }
});

test("resolving a conflict after a local file disappears requires a fresh sync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "local");
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/a.py", size: 5, crc32c: "", generation: "1"}],
      download: async () => Buffer.from("cloud"), upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    const conflict = (await engine.sync()).conflicts[0];
    await fs.unlink(path.join(root, "scripts/a.py"));
    await assert.rejects(engine.resolve(conflict.path, "cloud", conflict.preview, conflict.generation, conflict.localHash));
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("bind cannot silently switch to an invalid project slug", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => "1"});
    await assert.rejects(engine.bind("alice@example.com", "../demo"), /Invalid/);
    await assert.rejects(engine.bind("alice@example.com", "a..b"), /Invalid/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("sync ignores a cloud-only top-level user metadata file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "user.json", size: 2, crc32c: "", generation: "1"}],
      download: async () => {throw new Error("unexpected metadata download");}, upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    assert.deepEqual((await engine.sync()).downloaded, []);
    assert.equal(await fs.stat(path.join(root, "user.json")).then(() => true, () => false), false);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("a successfully downloaded file can be read without a second cloud transfer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    let downloads = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "outputs/a.txt", size: 4, crc32c: "", generation: "1"}],
      download: async () => {downloads++; return Buffer.from("same");}, upload: async () => "2",
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await engine.sync();
    assert.equal(downloads, 1);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("local-only file without a mirror target is not uploaded from root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.writeFile(path.join(root, "notes.md"), "notes");
    let uploads = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => {uploads++; return "1";},
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    assert.equal(uploads, 0);
    await engine.include("notes.md");
    await engine.sync();
    assert.equal(uploads, 1);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("file content identical on both sides on first sync establishes baseline without transfers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "same");
    let downloads = 0, uploads = 0;
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/a.py", size: 4, crc32c: "", generation: "1"}],
      download: async () => {downloads++; return Buffer.from("same");}, upload: async () => {uploads++; return "2";},
    });
    await engine.bind("alice@example.com", "demo");
    const result = await engine.sync();
    assert.deepEqual(result.conflicts, []);
    assert.equal(downloads, 1);
    assert.equal(uploads, 0);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("local edits to a previously synced script upload only the edited bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "one");
    let cloud = Buffer.from("one"), generation = "1";
    const engine = createSyncEngine(root, {
      inventory: async () => [{path: "scripts/a.py", size: cloud.length, crc32c: "", generation}],
      download: async () => cloud,
      upload: async (_name, bytes, expected) => {assert.equal(expected, "1"); cloud = bytes; generation = "2"; return generation;},
    });
    await engine.bind("alice@example.com", "demo");
    await engine.sync();
    await fs.writeFile(path.join(root, "scripts/a.py"), "two");
    assert.deepEqual((await engine.sync()).uploaded, ["scripts/a.py"]);
    assert.equal(cloud.toString(), "two");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("two concurrent binds on the same local folder cannot point at different projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-sync-test-"));
  try {
    const transport = {inventory: async () => [], download: async () => Buffer.alloc(0), upload: async () => "1"};
    const a = createSyncEngine(root, transport), b = createSyncEngine(root, transport);
    const results = await Promise.allSettled([a.bind("alice@example.com", "one"), b.bind("bob@example.com", "two")]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
