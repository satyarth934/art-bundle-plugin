import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ARTBundlePlugin } from "./art-mcp-plugin.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const projectScript = "/shared/user_impl_alpha/alice@example.com/demo/scripts/run.py";
const testCrcTable = Array.from({length: 256}, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  return value >>> 0;
});
function crc32c(value: string) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value)) crc = testCrcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return result.toString("base64");
}

async function seedSyncState(
  root: string,
  records: Record<string, {hash: string; generation: string}> = {},
  conflicts: Record<string, any> = {},
  email = "alice@example.com",
  slug = "demo",
) {
  await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
  await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email, slug, records, conflicts, includes: [], bootstrapCompleted: true}));
}

async function configuredPlugin(root: string) {
  const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
  await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
  return plugin;
}

function mcpResponse(request: any, data: any) {
  return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
}

test("plugin registers explicit binding and sync tools in a local project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  try {
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    assert.ok(plugin.tool?.art_sync_bind);
    assert.ok(plugin.tool?.art_sync);
    assert.ok(plugin.tool?.art_sync_resolve);
    assert.ok(plugin.tool?.art_sync_resolve_batch);
    await assert.rejects(
      plugin.tool!.art_sync_bind.execute({user_email: "alice@example.com", project_slug: "demo"}, {directory: root} as any),
      /Configure remote art-mcp/
    );
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    process.env.ARTMCP_AUTH_API_KEY = "test-key";
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.params.name);
      return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: {content: [{type: "text", text: JSON.stringify({files: [], next_page_token: null})}]}}));
    };
    try {
      await plugin.tool!.art_sync_bind.execute({user_email: "alice@example.com", project_slug: "demo"}, {directory: root} as any);
      assert.deepEqual(calls, ["sync_project_initialize", "sync_project_inventory"]);
    } finally { globalThis.fetch = original; delete process.env.ARTMCP_AUTH_API_KEY; }
    const state = JSON.parse(await fs.readFile(path.join(root, ".opencode/art-sync/state.json"), "utf8"));
    assert.equal(state.slug, "demo");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("failed cloud initialization does not persist a local bind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    const plugin = await configuredPlugin(root);
    process.env.ARTMCP_AUTH_API_KEY = "test-key";
    let called = "";
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      called = request.params.name;
      return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, error: {code: -32000, message: "initialization failed"}}));
    };

    await assert.rejects(
      plugin.tool!.art_sync_bind.execute({user_email: "alice@example.com", project_slug: "demo"}, {directory: root} as any),
      /ART MCP sync operation failed/
    );

    assert.equal(called, "sync_project_initialize");
    await assert.rejects(fs.readFile(path.join(root, ".opencode/art-sync/state.json")));
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY;
    else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("parent workflow owns full-sync checkpoints and specialists cannot call full-sync tools", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const skill = await fs.readFile(path.join(root, ".opencode/skills/media-optimization/SKILL.md"), "utf8");
  const artAgent = await fs.readFile(path.join(root, ".opencode/agents/art-specialist.md"), "utf8");
  const liquidAgent = await fs.readFile(path.join(root, ".opencode/agents/liquid-handler-specialist.md"), "utf8");
  assert.match(skill, /at pipeline start[\s\S]{0,180}run one full `art_sync`/i);
  assert.match(skill, /before dispatch/i);
  assert.match(skill, /after every output-producing phase/i);
  assert.match(skill, /art_sync_resolve_batch/);
  for (const agent of [artAgent, liquidAgent]) {
    assert.match(agent, /art_sync:\s*false/);
    assert.match(agent, /art_sync_resolve_batch:\s*false/);
    assert.match(agent, /do not call `?art_sync`?/i);
  }
});

test("parent can defer the unresolved batch through the registered resolver tool", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await seedSyncState(root, {}, {"scripts/run.py": {localHash: hash("local"), cloudHash: hash("cloud"), generation: "1"}});
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      return mcpResponse(request, {files: [], next_page_token: null});
    };
    const plugin = await configuredPlugin(root);
    const result = await plugin.tool!.art_sync_resolve_batch.execute({default_choice: "defer"}, {directory: root} as any);
    assert.match(String(result), /scripts\/run\.py/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("plugin config does not enable sync before remote MCP is resolved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  try {
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await assert.rejects(plugin.tool!.art_sync.execute({}, {directory: root} as any), /Configure remote/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("explicit art_sync updates tool title and metadata with transfer counts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await seedSyncState(root);
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return mcpResponse(request, {files: [], next_page_token: null});
    };
    const plugin = await configuredPlugin(root);
    const updates: any[] = [];
    const output = await plugin.tool!.art_sync.execute({}, {directory: root, metadata: (update: any) => updates.push(update)} as any);
    assert.match(String(output), /pendingConflicts/);
    assert.equal(updates[0].title, "ART sync: scanning cloud inventory");
    assert.match(updates[1].title, /0 downloaded, 0 uploaded, 0 new conflicts/);
    assert.deepEqual(updates[1].metadata, {downloaded: 0, uploaded: 0, newConflicts: 0, pendingConflicts: 0, failed: 0});
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("a previously bound folder reconciles on session creation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let inventories = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.params.name === "sync_project_inventory") inventories++;
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify({files: [], next_page_token: null})}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.event?.({event: {type: "session.created", properties: {info: {id: "s1"}}}} as any);
    assert.equal(inventories, 1);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("sub-agent session creation does not start an independent full inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await seedSyncState(root);
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let inventories = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.params.name === "sync_project_inventory") inventories++;
      return mcpResponse(request, {files: [], next_page_token: null});
    };
    const plugin = await configuredPlugin(root);
    await plugin.event?.({event: {type: "session.created", properties: {info: {id: "child", parentID: "parent"}}}} as any);
    assert.equal(inventories, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("a missing project file read triggers one targeted reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("recovered");
      const request = JSON.parse(String(init?.body));
      const data = request.params.name === "sync_project_stat"
        ? {path: "data/missing.csv", size: 9, crc32c: "", generation: "1"}
        : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin["tool.execute.before"]?.({tool: "read", sessionID: "s", callID: "c"}, {args: {filePath: path.join(root, "data/missing.csv")}});
    assert.equal(await fs.readFile(path.join(root, "data/missing.csv"), "utf8"), "recovered");
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("post-execution hook does not run a full-project sync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let inventories = 0;
    globalThis.fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.params.name === "sync_project_inventory") inventories++;
      const data = {files: [], next_page_token: null};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "failed", output: "script error", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c", args: {}}, output);
    assert.equal(output.output, "script error");
    assert.equal(inventories, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("post-execution hook preserves the execution result without sync error text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response("network failure", {status: 500}); };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "run", output: "script completed", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c", args: {}}, output);
    assert.equal(output.output, "script completed");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("pre-execution sync failure stops the cloud script from running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async () => new Response("unavailable", {status: 503});
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c"},
      {args: {script_path: "/shared/user_impl_alpha/alice@example.com/demo/scripts/run.py"}}
    ), /sync|MCP/i);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("write and file-edited hooks coalesce into one targeted sync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "hello");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let uploads = 0;
    let stats = 0;
    let inventories = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) {uploads++; return new Response(null, {status: 200, headers: {"x-goog-generation": "2"}});}
      const req = JSON.parse(String(init?.body));
      if (req.params.name === "sync_project_inventory") inventories++;
      if (req.params.name === "sync_project_stat") stats++;
      const data = req.params.name === "sync_project_stat" ? null : {url: "https://storage/upload", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin["tool.execute.after"]?.({tool: "write", sessionID: "s", callID: "c", args: {filePath: path.join(root, "scripts/run.py")}}, {title: "write", output: "ok", metadata: {}});
    await plugin.event?.({event: {type: "file.edited", properties: {file: path.join(root, "scripts/run.py")}}} as any);
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(uploads, 1);
    assert.equal(stats, 1);
    assert.equal(inventories, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("a pre-execution sync checks script path is inside the bound project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c"},
      {args: {script_path: "/shared/user_impl_alpha/bob@example.com/demo/scripts/run.py"}}
    ), /bound project/);
  } finally {
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("startup sync errors do not break new sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async () => new Response("unavailable", {status: 503});
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.event?.({event: {type: "session.created", properties: {info: {id: "s1"}}}} as any);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("post-write reconciliation records a target conflict without a full inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {"scripts/a.py": {hash: hash("base1"), generation: "1"}}, includes: [], conflicts: {}, bootstrapCompleted: true}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "local");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let inventories = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("cloud");
      const req = JSON.parse(String(init?.body));
      if (req.params.name === "sync_project_inventory") inventories++;
      const data = req.params.name === "sync_project_stat"
        ? {path: "scripts/a.py", size: 5, crc32c: "", generation: "2"}
        : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "write", output: "wrote file", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "write", sessionID: "s", callID: "c", args: {filePath: path.join(root, "scripts/a.py")}}, output);
    await new Promise(resolve => setTimeout(resolve, 650));
    const state = JSON.parse(await fs.readFile(path.join(root, ".opencode/art-sync/state.json"), "utf8"));
    assert.ok(state.conflicts["scripts/a.py"]);
    assert.equal(inventories, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("pre-execution hook waits for a pending debounced write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "hello");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let inventories = 0;
    let stats = 0;
    let uploaded = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) { uploaded = true; return new Response(null, {headers: {"x-goog-generation": "2"}}); }
      const req = JSON.parse(String(init?.body));
      if (req.params.name === "sync_project_inventory") inventories++;
      if (req.params.name === "sync_project_stat") stats++;
      const data = req.params.name === "sync_project_stat" ? null : {url: "https://storage/file", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const write = plugin["tool.execute.after"]?.({tool: "write", sessionID: "s", callID: "c", args: {filePath: path.join(root, "scripts/run.py")}}, {title: "write", output: "done", metadata: {}});
    const execute = plugin["tool.execute.before"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "x"}, {args: {script_path: "/shared/user_impl_alpha/alice@example.com/demo/scripts/run.py"}});
    await Promise.all([write, execute]);
    assert.equal(inventories, 0);
    assert.equal(stats, 1);
    assert.equal(uploaded, true);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("file.edited event queues a sync after OpenCode writes an eligible file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "hello");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let uploads = 0;
    let inventories = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) {uploads++; return new Response(null, {headers: {"x-goog-generation": "2"}});}
      const req = JSON.parse(String(init?.body));
      if (req.params.name === "sync_project_inventory") inventories++;
      const data = req.params.name === "sync_project_stat" ? null : {url: "https://storage/file", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.event?.({event: {type: "file.edited", properties: {file: path.join(root, "scripts/run.py")}}} as any);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(uploads, 1);
    assert.equal(inventories, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("failed execute_code tool event does not start a full-project sync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response("unavailable", {status: 503}); };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.event?.({event: {type: "message.part.updated", properties: {part: {type: "tool", tool: "mcp__art_mcp__execute_code", state: {status: "error", input: {}, error: "timeout"}}}}} as any);
    assert.equal(await fs.stat(path.join(root, "outputs/partial.txt")).then(() => true, () => false), false);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("a pre-execution target conflict preview is surfaced before execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {"scripts/run.py": {hash: hash("base1"), generation: "1"}}, includes: [], conflicts: {}, bootstrapCompleted: true}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("cloud");
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_stat"
        ? {path: "scripts/run.py", size: 5, crc32c: "", generation: "2"}
        : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c"},
      {args: {script_path: "/shared/user_impl_alpha/alice@example.com/demo/scripts/run.py"}}
    ), /preview/);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("repeated execute_code calls use targeted stat and never request full inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    const source = 'import os\nUSER_EMAIL = os.environ["ARTMCP_USER_EMAIL"]\nPROJECT_SLUG = os.environ["ARTMCP_PROJECT_SLUG"]\nPROJECT_ROOT = os.environ["ARTMCP_PROJECT_ROOT"]\n';
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), source);
    await seedSyncState(root, {"scripts/run.py": {hash: hash(source), generation: "1"}});
    process.env.ARTMCP_AUTH_API_KEY = "test";
    const calls: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.params.name);
      const data = request.params.name === "sync_project_stat"
        ? {path: "scripts/run.py", size: Buffer.byteLength(source), crc32c: crc32c(source), generation: "1"}
        : {files: [], next_page_token: null};
      return mcpResponse(request, data);
    };
    const plugin = await configuredPlugin(root);
    for (const callID of ["first", "second"]) {
      await plugin["tool.execute.before"]?.(
        {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID},
        {args: {script_path: projectScript}},
      );
    }
    assert.equal(calls.filter(name => name === "sync_project_inventory").length, 0);
    assert.equal(calls.filter(name => name === "sync_project_stat").length, 2);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("target script upload completes before execute_code proceeds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "print('new')");
    await seedSyncState(root);
    process.env.ARTMCP_AUTH_API_KEY = "test";
    const calls: string[] = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) {
        calls.push("GCS PUT");
        return new Response(null, {headers: {"x-goog-generation": "2"}});
      }
      const request = JSON.parse(String(init?.body));
      calls.push(request.params.name);
      const data = request.params.name === "sync_project_stat"
        ? null
        : {url: "https://storage/upload", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return mcpResponse(request, data);
    };
    const plugin = await configuredPlugin(root);
    await plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "upload"},
      {args: {script_path: projectScript}},
    );
    assert.deepEqual(calls.filter(Boolean), ["sync_project_stat", "sync_project_transfer", "GCS PUT"]);
    assert.equal((await JSON.parse(await fs.readFile(path.join(root, ".opencode/art-sync/state.json"), "utf8"))).records["scripts/run.py"].generation, "2");
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("unresolved target-script conflict blocks execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local edit");
    await seedSyncState(root, {"scripts/run.py": {hash: hash("baseline"), generation: "1"}});
    process.env.ARTMCP_AUTH_API_KEY = "test";
    const calls: string[] = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("cloud edit");
      const request = JSON.parse(String(init?.body));
      calls.push(request.params.name);
      const data = request.params.name === "sync_project_stat"
        ? {path: "scripts/run.py", size: 10, crc32c: "", generation: "2"}
        : {url: "https://storage/download", method: "GET", headers: {}};
      return mcpResponse(request, data);
    };
    const plugin = await configuredPlugin(root);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "conflict"},
      {args: {script_path: projectScript}},
    ), /target script|conflict/i);
    assert.equal(calls.includes("sync_project_inventory"), false);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("an unrelated unresolved conflict does not block the target script", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "baseline");
    await seedSyncState(root,
      {"scripts/run.py": {hash: hash("baseline"), generation: "1"}},
      {"scripts/other.py": {localHash: hash("local"), cloudHash: hash("cloud"), generation: "7"}},
    );
    process.env.ARTMCP_AUTH_API_KEY = "test";
    const calls: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.params.name);
      const data = request.params.name === "sync_project_stat"
        ? {path: "scripts/run.py", size: 8, crc32c: crc32c("baseline"), generation: "1"}
        : {files: [], next_page_token: null};
      return mcpResponse(request, data);
    };
    const plugin = await configuredPlugin(root);
    await plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "unrelated"},
      {args: {script_path: projectScript}},
    );
    assert.equal(calls.includes("sync_project_inventory"), false);
    assert.equal(calls.includes("sync_project_stat"), true);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("pre-execution fills identity arguments from the bound project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "print('ok')");
    await seedSyncState(root, {"scripts/run.py": {hash: hash("print('ok')"), generation: "1"}});
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return mcpResponse(request, {path: "scripts/run.py", size: 11, crc32c: crc32c("print('ok')"), generation: "1"});
    };
    const plugin = await configuredPlugin(root);
    const output = {args: {script_path: projectScript}};
    await plugin["tool.execute.before"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "identity"}, output);
    assert.equal(output.args.user_email, "alice@example.com");
    assert.equal(output.args.project_slug, "demo");
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("pre-execution rejects identity arguments that disagree with the binding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await seedSyncState(root);
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let syncRequests = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (String(request.params?.name).startsWith("sync_project_")) syncRequests++;
      return mcpResponse(request, null);
    };
    const plugin = await configuredPlugin(root);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "identity-mismatch"},
      {args: {script_path: projectScript, user_email: "satty_test_102@example.com", project_slug: "flav_test_102"}},
    ), /identity|binding/i);
    assert.equal(syncRequests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("pre-execution rejects stale literal user, project, and shared path constants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), [
      'USER_EMAIL = "satty_test_102@example.com"',
      'PROJECT_SLUG = "flav_test_102"',
      'PROJECT_ROOT = "/shared/user_impl_alpha/satty_test_102@example.com/flav_test_102/scripts"',
    ].join("\n"));
    const boundEmail = "satty102@example.com";
    const boundSlug = "flav_test_102";
    await seedSyncState(root, {}, {}, boundEmail, boundSlug);
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let syncRequests = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (String(request.params?.name).startsWith("sync_project_")) syncRequests++;
      return mcpResponse(request, null);
    };
    const plugin = await configuredPlugin(root);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "source-mismatch"},
      {args: {script_path: `/shared/user_impl_alpha/${boundEmail}/${boundSlug}/scripts/run.py`}},
    ), /source identity|bound project/i);
    assert.equal(syncRequests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("pre-execution rejects a stale project-root literal without a trailing slash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), [
      'USER_EMAIL = os.environ["ARTMCP_USER_EMAIL"]',
      'PROJECT_SLUG = os.environ["ARTMCP_PROJECT_SLUG"]',
      'PROJECT_ROOT = "/shared/user_impl_alpha/bob@example.com/other-project"',
    ].join("\n"));
    await seedSyncState(root);
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let syncRequests = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (String(request.params?.name).startsWith("sync_project_")) syncRequests++;
      return mcpResponse(request, null);
    };
    const plugin = await configuredPlugin(root);
    await assert.rejects(plugin["tool.execute.before"]?.(
      {tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "root-mismatch"},
      {args: {script_path: projectScript}},
    ), /source identity|source path/i);
    assert.equal(syncRequests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("explicit bind does not write cloud metadata files locally", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify({files: [], next_page_token: null})}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.tool!.art_sync_bind.execute({user_email: "alice@example.com", project_slug: "demo"}, {directory: root} as any);
    assert.equal(await fs.stat(path.join(root, "project.json")).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(root, "user.json")).then(() => true, () => false), false);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("post-execution hook preserves output and leaves phase reconciliation to the orchestrator", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "outputs"));
    await fs.writeFile(path.join(root, "outputs/a.txt"), "local");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response("unavailable", {status: 503}); };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "run", output: "EXECUTION ERROR: script failed", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c", args: {}}, output);
    assert.equal(output.output, "EXECUTION ERROR: script failed");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});
