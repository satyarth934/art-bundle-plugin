import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ARTBundlePlugin } from "./art-mcp-plugin.ts";

test("plugin registers explicit binding and sync tools in a local project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  try {
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    assert.ok(plugin.tool?.art_sync_bind);
    assert.ok(plugin.tool?.art_sync);
    assert.ok(plugin.tool?.art_sync_resolve);
    await assert.rejects(
      plugin.tool!.art_sync_bind.execute({user_email: "alice@example.com", project_slug: "demo"}, {directory: root} as any),
      /Configure remote art-mcp/
    );
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    process.env.ARTMCP_AUTH_API_KEY = "test-key";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: {content: [{type: "text", text: JSON.stringify({files: [], next_page_token: null})}]}}));
    };
    try {
      await plugin.tool!.art_sync_bind.execute({user_email: "alice@example.com", project_slug: "demo"}, {directory: root} as any);
    } finally { globalThis.fetch = original; delete process.env.ARTMCP_AUTH_API_KEY; }
    const state = JSON.parse(await fs.readFile(path.join(root, ".opencode/art-sync/state.json"), "utf8"));
    assert.equal(state.slug, "demo");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("plugin config does not enable sync before remote MCP is resolved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  try {
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await assert.rejects(plugin.tool!.art_sync.execute({}, {directory: root} as any), /Configure remote/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
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
      const data = request.params.name === "sync_project_inventory"
        ? {files: [{path: "data/missing.csv", size: 9, crc32c: "", generation: "1"}], next_page_token: null}
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

test("post-execution hook syncs cloud outputs even when tool returned failure text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("partial");
      const request = JSON.parse(String(init?.body));
      const data = request.params.name === "sync_project_inventory"
        ? {files: [{path: "outputs/partial.txt", size: 7, crc32c: "", generation: "1"}], next_page_token: null}
        : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin["tool.execute.after"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c", args: {}}, {title: "failed", output: "script error", metadata: {}});
    assert.equal(await fs.readFile(path.join(root, "outputs/partial.txt"), "utf8"), "partial");
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("post-execution sync failures are reported to the agent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async () => new Response("network failure", {status: 500});
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "run", output: "script completed", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c", args: {}}, output);
    assert.match(output.output, /sync/i);
    assert.match(output.output, /failed|unavailable/i);
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

test("write hook queues a debounced sync after an eligible local edit", async () => {
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
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) {uploads++; return new Response(null, {status: 200, headers: {"x-goog-generation": "2"}});}
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_inventory" ? {files: [], next_page_token: null} : {url: "https://storage/upload", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin["tool.execute.after"]?.({tool: "write", sessionID: "s", callID: "c", args: {filePath: path.join(root, "scripts/run.py")}}, {title: "write", output: "ok", metadata: {}});
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(uploads, 1);
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

test("post-write sync reports conflicts to the agent instead of hiding them in logs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  const previous = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/a.py"), "local");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("cloud");
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_inventory" ? {files: [{path: "scripts/a.py", size: 5, crc32c: "", generation: "1"}], next_page_token: null} : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "write", output: "wrote file", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "write", sessionID: "s", callID: "c", args: {filePath: path.join(root, "scripts/a.py")}}, output);
    assert.match(output.output, /conflict/i);
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
    let calls = 0;
    let uploaded = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) { uploaded = true; return new Response(null, {headers: {"x-goog-generation": "2"}}); }
      const req = JSON.parse(String(init?.body));
      if (req.params.name === "sync_project_inventory") calls++;
      const data = req.params.name === "sync_project_inventory" ? {files: uploaded ? [{path: "scripts/run.py", size: 5, crc32c: "", generation: "2"}] : [], next_page_token: null} : {url: "https://storage/file", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const write = plugin["tool.execute.after"]?.({tool: "write", sessionID: "s", callID: "c", args: {filePath: path.join(root, "scripts/run.py")}}, {title: "write", output: "done", metadata: {}});
    const execute = plugin["tool.execute.before"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "x"}, {args: {script_path: "/shared/user_impl_alpha/alice@example.com/demo/scripts/run.py"}});
    await Promise.all([write, execute]);
    assert.ok(calls >= 1);
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
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) {uploads++; return new Response(null, {headers: {"x-goog-generation": "2"}});}
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_inventory" ? {files: [], next_page_token: null} : {url: "https://storage/file", method: "PUT", headers: {"x-goog-if-generation-match": "0"}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.event?.({event: {type: "file.edited", properties: {file: path.join(root, "scripts/run.py")}}} as any);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(uploads, 1);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("failed execute_code tool event still reconciles partial cloud outputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("partial");
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_inventory" ? {files: [{path: "outputs/partial.txt", size: 7, crc32c: "", generation: "1"}], next_page_token: null} : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    await plugin.event?.({event: {type: "message.part.updated", properties: {part: {type: "tool", tool: "mcp__art_mcp__execute_code", state: {status: "error", input: {}, error: "timeout"}}}}} as any);
    assert.equal(await fs.readFile(path.join(root, "outputs/partial.txt"), "utf8"), "partial");
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("a pre-execution conflict preview is surfaced before execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/run.py"), "local");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("cloud");
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_inventory" ? {files: [{path: "scripts/run.py", size: 5, crc32c: "", generation: "1"}], next_page_token: null} : {url: "https://storage/file", method: "GET", headers: {}};
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

test("post-execution sync preserves original execution output while adding conflicts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "art-plugin-test-"));
  const previous = globalThis.fetch;
  const oldKey = process.env.ARTMCP_AUTH_API_KEY;
  try {
    await fs.mkdir(path.join(root, ".opencode/art-sync"), {recursive: true});
    await fs.writeFile(path.join(root, ".opencode/art-sync/state.json"), JSON.stringify({email: "alice@example.com", slug: "demo", records: {}, includes: []}));
    await fs.mkdir(path.join(root, "outputs"));
    await fs.writeFile(path.join(root, "outputs/a.txt"), "local");
    process.env.ARTMCP_AUTH_API_KEY = "test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://storage")) return new Response("cloud");
      const req = JSON.parse(String(init?.body));
      const data = req.params.name === "sync_project_inventory" ? {files: [{path: "outputs/a.txt", size: 5, crc32c: "", generation: "1"}], next_page_token: null} : {url: "https://storage/file", method: "GET", headers: {}};
      return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify(data)}]}}));
    };
    const plugin = await ARTBundlePlugin({directory: root, client: {app: {log: async () => {}}}} as any);
    await plugin.config?.({mcp: {"art-mcp": {type: "remote", url: "https://mcp.example/mcp"}}} as any);
    const output = {title: "run", output: "EXECUTION ERROR: script failed", metadata: {}};
    await plugin["tool.execute.after"]?.({tool: "mcp__art_mcp__execute_code", sessionID: "s", callID: "c", args: {}}, output);
    assert.match(output.output, /EXECUTION ERROR/);
    assert.match(output.output, /conflicts/);
  } finally {
    globalThis.fetch = previous;
    if (oldKey === undefined) delete process.env.ARTMCP_AUTH_API_KEY; else process.env.ARTMCP_AUTH_API_KEY = oldKey;
    await fs.rm(root, {recursive: true, force: true});
  }
});
