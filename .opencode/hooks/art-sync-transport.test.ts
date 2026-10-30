import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyncTransport } from "./art-sync-transport.ts";

test("remote transport pages inventory and uploads using generation-conditional signed URL", async () => {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetcher = async (url: string, init: any) => {
    const headers = init?.headers ?? {};
    calls.push({url, method: init?.method, headers});
    if (url.startsWith("https://storage")) return new Response(null, {status: 200, headers: {"x-goog-generation": "9"}});
    const req = JSON.parse(init.body);
    const data = req.params.arguments;
    const result = req.params.name === "sync_project_inventory"
      ? data.page_token ? {files: [{path: "data/two.bin", size: 1, crc32c: "b", generation: "2"}], next_page_token: null}
        : {files: [{path: "scripts/one.py", size: 1, crc32c: "a", generation: "1"}], next_page_token: "next"}
      : {url: "https://storage/put", method: "PUT", headers: {"x-goog-if-generation-match": data.generation}};
    return new Response(JSON.stringify({jsonrpc: "2.0", id: req.id, result: {content: [{type: "text", text: JSON.stringify(result)}]}}), {status: 200});
  };
  const t = createSyncTransport("https://mcp.example/mcp", "my-key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.equal((await t.inventory()).length, 2);
  assert.equal(await t.upload("scripts/one.py", Buffer.from("x"), "1"), "9");
  assert.equal(calls[2].headers["Authorization"], "Bearer my-key");
  assert.equal(calls[3].headers["x-goog-if-generation-match"], "1");
});

test("transport parses FastMCP structuredContent envelopes", async () => {
  const fetcher = async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    return new Response(JSON.stringify({result: {structuredContent: {result: {files: [{path: "data/a.csv", size: 1, crc32c: "", generation: "4"}], next_page_token: null}}}}));
  };
  const transport = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.equal((await transport.inventory())[0].path, "data/a.csv");
});

test("transport stats one project-relative path without requesting a full inventory", async () => {
  const requests: {name: string; args: Record<string, unknown>}[] = [];
  const fetcher = async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    requests.push({name: req.params.name, args: req.params.arguments});
    return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify({path: "scripts/run.py", size: 11, crc32c: "checksum", generation: "8"})}]}}));
  };
  const transport = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.deepEqual(await transport.stat("scripts/run.py"), {path: "scripts/run.py", size: 11, crc32c: "checksum", generation: "8"});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, "sync_project_stat");
  assert.equal(requests[0].args.path, "scripts/run.py");
});

test("transport maps a missing project-scoped stat to undefined", async () => {
  const fetcher = async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    return new Response(JSON.stringify({jsonrpc: "2.0", id: req.id, result: {content: [{type: "text", text: "null"}]}}));
  };
  const transport = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.equal(await transport.stat("scripts/missing.py"), undefined);
});

test("transport initializes its bound ART project through the MCP control plane", async () => {
  let request: any;
  const fetcher = async (_url: string, init: any) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: {content: [{type: "text", text: JSON.stringify({initialized: true})}]}}));
  };
  const transport = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);

  await transport.initialize();

  assert.equal(request.params.name, "sync_project_initialize");
  assert.equal(request.params.arguments.user_email, "alice@example.com");
  assert.equal(request.params.arguments.project_slug, "demo");
});

test("transport preserves null in a FastMCP structured stat result", async () => {
  const fetcher = async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    return new Response(JSON.stringify({jsonrpc: "2.0", id: req.id, result: {structuredContent: {result: null}}}));
  };
  const transport = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.equal(await transport.stat("scripts/missing.py"), undefined);
});

test("transport accepts streamable HTTP SSE MCP responses", async () => {
  const fetcher = async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    const data = {jsonrpc: "2.0", id: req.id, result: {content: [{type: "text", text: JSON.stringify({files: [], next_page_token: null})}]}};
    return new Response(`event: message\ndata: ${JSON.stringify(data)}\n\n`, {headers: {"content-type": "text/event-stream"}});
  };
  const t = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.deepEqual(await t.inventory(), []);
});

test("signed download receives cloud bytes and upload precondition errors do not overwrite", async () => {
  const requests: {url: string; method: string}[] = [];
  const fetcher = async (url: string, init: any) => {
    requests.push({url, method: init.method});
    if (url.includes("storage") && init.method === "GET") return new Response(Buffer.from([0, 255]));
    if (url.includes("storage") && init.method === "PUT") return new Response("precondition", {status: 412});
    const req = JSON.parse(init.body);
    const method = req.params.arguments.method;
    return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify({url: "https://storage/item", method, headers: method === "PUT" ? {"x-goog-if-generation-match": "1"} : {}})}]}}));
  };
  const t = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  assert.deepEqual(await t.download({path: "outputs/result.bin", size: 2, crc32c: "", generation: "1"}), Buffer.from([0, 255]));
  await assert.rejects(t.upload("outputs/result.bin", Buffer.from([1]), "1"), /412/);
  assert.deepEqual(requests.map(r => r.method), ["POST", "GET", "POST", "PUT"]);
});

test("transport rejects an error response without displaying signed URLs", async () => {
  const fetcher = async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    return new Response(JSON.stringify({result: {isError: true, content: [{type: "text", text: "https://storage/secret?sig=abc"}]}}));
  };
  const t = createSyncTransport("https://mcp.example/mcp", "key", "alice@example.com", "demo", fetcher as typeof fetch);
  await assert.rejects(t.inventory(), (err: Error) => !err.message.includes("sig=abc"));
});

test("upload sends no MCP authentication token to the signed GCS URL", async () => {
  let cloudHeaders: Record<string, string> = {};
  const fetcher = async (url: string, init: any) => {
    if (url.startsWith("https://storage")) { cloudHeaders = init.headers; return new Response(null, {headers: {"x-goog-generation": "2"}}); }
    return new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify({url: "https://storage/item", method: "PUT", headers: {"x-goog-if-generation-match": "0"}})}]}}));
  };
  const t = createSyncTransport("https://mcp.example/mcp", "secret", "alice@example.com", "demo", fetcher as typeof fetch);
  await t.upload("scripts/run.py", Buffer.from("x"), "0");
  assert.equal(cloudHeaders.Authorization, undefined);
});
