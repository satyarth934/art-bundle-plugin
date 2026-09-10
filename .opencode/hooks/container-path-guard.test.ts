import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginInput } from "@opencode-ai/plugin";
import { ARTBundlePlugin } from "../plugins/art-mcp-plugin.ts";
import { containerPathGuard } from "./container-path-guard.ts";

test("registers the guard when a resolved remote MCP config is provided", async () => {
  const originalFetch = globalThis.fetch;
  process.env.ARTMCP_DEPLOYMENT_MODE = "gcp_remote";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ result: { tools: [{ name: "execute_code" }] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const ctx = {
      client: { app: { log: async () => {} } },
      project: {
        id: "project",
        worktree: "/workspace",
        time: { created: 0, updated: 0 },
        sandboxes: [],
      },
      directory: "/workspace",
      worktree: "/workspace",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: (() => {}) as never,
    } as unknown as PluginInput;
    const guards = await containerPathGuard(
      ctx,
      () => ({
        type: "remote",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer test" },
      })
    );

    assert.equal(typeof guards["tool.execute.before"], "function");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ARTMCP_DEPLOYMENT_MODE;
  }
});

test("loads the guard MCP config from OpenCode's resolved config hook", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ result: { tools: [] } }), { status: 200 });

  try {
    const ctx = {
      client: { app: { log: async () => {} } },
      project: {
        id: "project",
        worktree: "/workspace",
        time: { created: 0, updated: 0 },
        sandboxes: [],
      },
      directory: "/workspace",
      worktree: "/workspace",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: (() => {}) as never,
    } as unknown as PluginInput;
    const hooks = await ARTBundlePlugin(ctx);

    await hooks.config?.({
      mcp: {
        "art-mcp": {
          type: "remote",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer test" },
        },
      },
    } as never);

    assert.equal(typeof hooks["tool.execute.before"], "function");
    await hooks["tool.execute.before"]?.(
      { tool: "execute_code", sessionID: "session", callID: "call" },
      { args: {} }
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ARTMCP_DEPLOYMENT_MODE;
  }
});
