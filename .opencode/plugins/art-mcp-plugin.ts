/**
 * ART Bundle Plugin - Container Path Guard
 * Main entry point that registers the container path interception hooks
 */

import { tool, type Config, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import { containerPathGuard } from "../hooks/container-path-guard.ts";
import { initSessionLog, fileLog } from "../hooks/file-logger.ts";
import { createSyncEngine } from "../hooks/art-sync.ts";
import { createSyncTransport } from "../hooks/art-sync-transport.ts";
import type { MCPConfig } from "../hooks/types.ts";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * ARTBundlePlugin
 * Detects deployment mode at startup, then registers container path guard hooks.
 */
export const ARTBundlePlugin: Plugin = async (ctx: PluginInput) => {
  // Initialize session-based logging for the plugin and its hooks
  initSessionLog();

  let mcpConfig: MCPConfig | null = null;
  const guards = await containerPathGuard(ctx, () => mcpConfig);
  const engines = new Map<string, ReturnType<typeof createSyncEngine>>();
  const engine = (directory: string) => {
    if (!mcpConfig || !process.env.ARTMCP_AUTH_API_KEY) throw new Error("Configure remote art-mcp and ARTMCP_AUTH_API_KEY first");
    let current = engines.get(directory);
    if (!current) {
      const transport = {
        async inventory() {
          const state = await current!.binding();
          if (!state) throw new Error("Bind the project first");
          return createSyncTransport(mcpConfig!.url, process.env.ARTMCP_AUTH_API_KEY!, state.email, state.slug).inventory();
        },
        async download(file: any) {
          const state = await current!.binding();
          return createSyncTransport(mcpConfig!.url, process.env.ARTMCP_AUTH_API_KEY!, state!.email, state!.slug).download(file);
        },
        async upload(name: string, bytes: Buffer, generation: string) {
          const state = await current!.binding();
          return createSyncTransport(mcpConfig!.url, process.env.ARTMCP_AUTH_API_KEY!, state!.email, state!.slug).upload(name, bytes, generation);
        },
      };
      current = createSyncEngine(directory, transport);
      engines.set(directory, current);
    }
    return current;
  };
  const summarize = (result: Awaited<ReturnType<ReturnType<typeof createSyncEngine>["sync"]>>) =>
    JSON.stringify(result, null, 2);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writeWait: Promise<void> | undefined;
  let resolveWriteWait: (() => void) | undefined;
  const writeDelay = () => {
    if (!writeWait) writeWait = new Promise<void>(resolve => { resolveWriteWait = resolve; });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { resolveWriteWait?.(); writeWait = undefined; resolveWriteWait = undefined; }, 500);
    return writeWait;
  };
  const inProject = (name: string) => {
    const relative = path.relative(ctx.directory, name).split(path.sep).join("/");
    return relative && !relative.startsWith("..") && !relative.startsWith(".opencode/") && !relative.startsWith(".git/") && !path.isAbsolute(relative);
  };
  const sessions = new Set<string>();
  const failedCalls = new Set<string>();

  return {
    ...guards,
    event: async ({event}) => {
      if (event.type === "message.part.updated" && mcpConfig) {
        const part = event.properties.part;
        if (part.type === "tool" && part.tool.endsWith("execute_code") && part.state.status === "error" && !failedCalls.has(part.callID)) {
          failedCalls.add(part.callID);
          const active = engine(ctx.directory);
          try {
            if (await active.binding()) {
              const result = await active.sync();
              if (result.failed.length || result.conflicts.length) fileLog(`Failed execution sync needs attention: ${summarize(result)}`);
            }
          } catch { fileLog("Failed execution sync unavailable; run art_sync to retry"); }
        }
        return;
      }
      if (event.type === "file.edited" && mcpConfig) {
        const file = event.properties.file;
        if (inProject(file)) {
          void (async () => {
            await writeDelay();
            const active = engine(ctx.directory);
            if (await active.binding()) {
              const result = await active.sync();
              if (result.conflicts.length || result.failed.length) fileLog(`File edit sync needs attention: ${summarize(result)}`);
            }
          })().catch(() => fileLog("File edit sync failed; run art_sync to retry"));
        }
        return;
      }
      if (event.type === "session.deleted") {
        sessions.delete(event.properties.info.id);
        return;
      }
      if (event.type !== "session.created" || !mcpConfig) return;
      const id = (event as any).properties?.info?.id;
      if (!id || sessions.has(id)) return;
      sessions.add(id);
      const active = engine(ctx.directory);
      if (!(await active.binding())) return;
      try {
        const result = await active.sync();
        if (result.conflicts.length || result.failed.length) fileLog(`Startup sync needs attention: ${summarize(result)}`);
      } catch {
        fileLog("Startup sync unavailable; use art_sync to retry");
      }
    },
    tool: {
      art_sync_bind: tool({
        description: "Bind this local project folder to one ART cloud project. Run before first sync.",
        args: { user_email: tool.schema.string(), project_slug: tool.schema.string() },
        async execute(args, context) {
          await engine(context.directory).bind(args.user_email, args.project_slug);
          return `Bound ${context.directory} to ${args.user_email}/${args.project_slug}. ${summarize(await engine(context.directory).sync())}`;
        },
      }),
      art_sync: tool({
        description: "Reconcile local and cloud project files. Returns conflict preview paths; does not overwrite conflicts.",
        args: {},
        async execute(_args, context) { return summarize(await engine(context.directory).sync()); },
      }),
      art_sync_rebind: tool({
        description: "Explicitly switch this local folder to a different ART project; clears prior sync history without deleting local files.",
        args: {user_email: tool.schema.string(), project_slug: tool.schema.string()},
        async execute(args, context) {
          await engine(context.directory).rebind(args.user_email, args.project_slug);
          return `Rebound ${context.directory} to ${args.user_email}/${args.project_slug}. Run art_sync to compare files before executing.`;
        },
      }),
      art_sync_include: tool({
        description: "Register a project-relative file outside scripts/data/outputs/logs for upload.",
        args: {path: tool.schema.string()},
        async execute(args, context) { await engine(context.directory).include(args.path); return `Included ${args.path}`; },
      }),
      art_sync_resolve: tool({
        description: "Resolve a sync conflict after inspecting the cloud preview and local original.",
        args: {path: tool.schema.string(), choice: tool.schema.enum(["local", "cloud"]), preview: tool.schema.string(), generation: tool.schema.string(), local_hash: tool.schema.string()},
        async execute(args, context) {
          await engine(context.directory).resolve(args.path, args.choice, args.preview, args.generation, args.local_hash);
          return `Resolved ${args.path} using ${args.choice}`;
        },
      }),
    },
    "tool.execute.before": async (input, output) => {
      await guards["tool.execute.before"]?.(input, output);
      if (mcpConfig && input.tool === "read") {
        const name = output.args?.filePath;
        if (typeof name === "string" && path.isAbsolute(name) && !path.relative(ctx.directory, name).startsWith("..") && path.relative(ctx.directory, name) !== "" && !await fs.lstat(name).then(() => true, () => false)) {
          const relative = path.relative(ctx.directory, name).split(path.sep).join("/");
          if (!relative.startsWith(".opencode/") && !relative.startsWith(".git/") && !relative.includes("../")) {
            const active = engine(ctx.directory);
            if (await active.binding()) {
              const result = await active.sync();
              if (result.conflicts.length || result.failed.length) fileLog(`Missing-file sync needs attention: ${summarize(result)}`);
            }
          }
        }
      }
      if (!mcpConfig || !input.tool.endsWith("execute_code") || !output.args?.script_path) return;
      if (timer) { clearTimeout(timer); timer = undefined; resolveWriteWait?.(); writeWait = undefined; resolveWriteWait = undefined; }
      const active = engine(ctx.directory);
      const binding = await active.binding();
      if (!binding) throw new Error("Bind this folder with art_sync_bind before execute_code");
      const expected = `/shared/user_impl_alpha/${binding.email}/${binding.slug}/`;
      if (typeof output.args.script_path !== "string" || !output.args.script_path.startsWith(expected) || output.args.script_path.split("/").includes("..")) throw new Error("Script path must be inside the bound project");
      const result = await active.sync();
      if (result.conflicts.length || result.failed.length) throw new Error(`Resolve sync problems before execution: ${summarize(result)}`);
    },
    "tool.execute.after": async (input, output) => {
      if (!mcpConfig) return;
      if (input.tool.endsWith("execute_code")) {
        const active = engine(ctx.directory);
        if (await active.binding()) {
          try {
            const result = await active.sync();
            if (result.failed.length || result.conflicts.length) output.output += `\nART sync needs attention: ${summarize(result)}`;
          } catch (error) {
            output.output += `\nART sync failed after execution: ${String(error)}`;
          }
        }
      } else if (["write", "edit", "apply_patch"].includes(input.tool)) {
        const target = input.args?.filePath;
        if (typeof target !== "string") return;
        const relative = path.relative(ctx.directory, target).split(path.sep).join("/");
        if (relative.startsWith("..") || relative.startsWith(".opencode/") || relative.startsWith(".git/")) return;
        await writeDelay();
        const active = engine(ctx.directory);
        if (!(await active.binding())) return;
        try {
          const result = await active.sync();
          if (result.conflicts.length || result.failed.length) output.output += `\nART sync needs attention: ${summarize(result)}`;
        } catch {
          output.output += "\nART sync failed after write; run art_sync to retry";
        }
      }
    },
    config: async (config: Config) => {
      const configuredMCP = config.mcp?.["art-mcp"];
      if (configuredMCP?.type === "remote" && "url" in configuredMCP) {
        mcpConfig = configuredMCP;
        process.env.ARTMCP_DEPLOYMENT_MODE = "gcp_remote";
        fileLog(
          "[art-bundle-plugin] Remote MCP resolved from OpenCode config - container path guards enabled"
        );
      } else {
        mcpConfig = null;
        delete process.env.ARTMCP_DEPLOYMENT_MODE;
      }
    },
  };
};

// Default export for CommonJS compatibility
export default ARTBundlePlugin;
