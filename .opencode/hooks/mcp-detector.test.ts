import assert from "node:assert/strict";
import { test } from "node:test";
import { clearMCPToolsCache, detectMCPTools } from "./mcp-detector.ts";

test("advertises MCP Streamable HTTP response formats", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "execute_code" }] },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  try {
    clearMCPToolsCache();
    const tools = await detectMCPTools({
      type: "remote",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer test" },
    });

    assert.deepEqual(tools, ["execute_code"]);
    assert.equal(
      request?.headers.get("Accept"),
      "application/json, text/event-stream"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearMCPToolsCache();
  }
});
