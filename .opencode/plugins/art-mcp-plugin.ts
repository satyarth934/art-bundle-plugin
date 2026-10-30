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

function verifyScriptIdentity(source: string, email: string, slug: string) {
  const literalAssignments = [
    {pattern: /\b(?:ARTMCP_)?USER_EMAIL\s*(?::[^=\n]+)?=\s*(["'])([^"']+)\1/g, expected: email},
    {pattern: /\b(?:ARTMCP_)?PROJECT_SLUG\s*(?::[^=\n]+)?=\s*(["'])([^"']+)\1/g, expected: slug},
  ];
  for (const {pattern, expected} of literalAssignments) {
    for (const match of source.matchAll(pattern)) {
      if (match[2] !== expected) throw new Error("Script source identity does not match the bound ART project");
    }
  }
  const paths = /\/shared\/user_impl_alpha\/([^/\s"'`]+)\/([^/\s"'`]+)(?=\/|["'`\s]|$)/g;
  for (const match of source.matchAll(paths)) {
    if (match[1] !== email || match[2] !== slug) throw new Error("Script source path does not match the bound ART project");
  }
}

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
        async stat(name: string) {
          const state = await current!.binding();
          if (!state) throw new Error("Bind the project first");
          return createSyncTransport(mcpConfig!.url, process.env.ARTMCP_AUTH_API_KEY!, state.email, state.slug).stat(name);
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
  let writeFlush: Promise<any> | undefined;
  const pendingWrites = new Set<string>();
  const inProject = (name: string) => {
    const relative = path.relative(ctx.directory, name).split(path.sep).join("/");
    return relative && !relative.startsWith("..") && !relative.startsWith(".opencode/") && !relative.startsWith(".git/") && !path.isAbsolute(relative);
  };
  const flushQueuedWrites = async (active: ReturnType<typeof createSyncEngine>, additional: string[] = []) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (writeFlush) await writeFlush;
    const paths = [...new Set([...pendingWrites, ...additional])];
    pendingWrites.clear();
    if (!paths.length || !(await active.binding())) return undefined;
    const task = (async () => {
      const result = await active.syncPaths(paths);
      if (result.conflicts.length || result.failed.length) fileLog(`Targeted write sync needs attention: ${summarize(result)}`);
      return result;
    })();
    writeFlush = task;
    try { return await task; }
    finally { if (writeFlush === task) writeFlush = undefined; }
  };
  const queueWrite = (relative: string) => {
    if (!relative || relative.startsWith("../") || relative.startsWith(".opencode/") || relative.startsWith(".git/")) return;
    pendingWrites.add(relative);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flushQueuedWrites(engine(ctx.directory)).catch(() => fileLog("Targeted write sync failed; run art_sync to retry"));
    }, 500);
  };
  const sessions = new Set<string>();

  return {
    ...guards,
    event: async ({event}) => {
      if (event.type === "file.edited" && mcpConfig) {
        const file = event.properties.file;
        if (inProject(file)) {
          queueWrite(path.relative(ctx.directory, file).split(path.sep).join("/"));
        }
        return;
      }
      if (event.type === "session.deleted") {
        sessions.delete(event.properties.info.id);
        return;
      }
      if (event.type !== "session.created" || !mcpConfig) return;
      const info = (event as any).properties?.info;
      if (info?.parentID || info?.parent_id) return;
      const id = info?.id;
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
        async execute(_args, context) {
          context.metadata?.({title: "ART sync: scanning cloud inventory"});
          const result = await engine(context.directory).sync();
          context.metadata?.({
            title: `ART sync: ${result.downloaded.length} downloaded, ${result.uploaded.length} uploaded, ${result.newConflicts.length} new conflicts`,
            metadata: {downloaded: result.downloaded.length, uploaded: result.uploaded.length, newConflicts: result.newConflicts.length, pendingConflicts: result.pendingConflicts.length, failed: result.failed.length},
          });
          return summarize(result);
        },
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
      art_sync_resolve_batch: tool({
        description: "Resolve the pending conflict batch with one default choice and optional per-path overrides; defer keeps conflicts pending.",
        args: {
          default_choice: tool.schema.enum(["cloud", "local", "defer"]),
          per_path_choices_json: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const perPathChoices = args.per_path_choices_json ? JSON.parse(args.per_path_choices_json) : {};
          const result = await engine(context.directory).resolveBatch({defaultChoice: args.default_choice, perPathChoices});
          return JSON.stringify(result, null, 2);
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
              const result = await active.syncPaths([relative]);
              if (result.conflicts.length || result.failed.length) fileLog(`Missing-file sync needs attention: ${summarize(result)}`);
            }
          }
        }
       }
       if (!mcpConfig || !input.tool.endsWith("execute_code") || !output.args?.script_path) return;
       const active = engine(ctx.directory);
       const binding = await active.binding();
       if (!binding) throw new Error("Bind this folder with art_sync_bind before execute_code");
       for (const key of ["user_email", "project_slug"] as const) {
         const expectedValue = key === "user_email" ? binding.email : binding.slug;
         if (output.args[key] !== undefined && output.args[key] !== expectedValue) throw new Error(`execute_code ${key} does not match the folder binding`);
         output.args[key] = expectedValue;
       }
       const expected = `/shared/user_impl_alpha/${binding.email}/${binding.slug}/`;
       if (typeof output.args.script_path !== "string" || !output.args.script_path.startsWith(expected) || output.args.script_path.split("/").includes("..")) throw new Error("Script path must be inside the bound project");
        const relative = output.args.script_path.slice(expected.length);
        if (!relative.startsWith("scripts/") || path.posix.isAbsolute(relative)) throw new Error("Execution requires a project-relative scripts/ path");
        const readBoundScript = async () => {
          let full = ctx.directory;
          const parts = relative.split("/");
          for (const [index, part] of parts.entries()) {
            full = path.join(full, part);
            const stat = await fs.lstat(full).catch(() => undefined);
            if (!stat) return undefined;
            if (stat.isSymbolicLink()) throw new Error("Execution script may not use symlinks");
            if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Execution script path is not a file path");
            if (index === parts.length - 1 && !stat.isFile()) throw new Error("Execution script path is not a regular file");
          }
          return fs.readFile(full, "utf8");
        };
        const localSource = await readBoundScript();
        if (localSource !== undefined) verifyScriptIdentity(localSource, binding.email, binding.slug);
        const result = await flushQueuedWrites(active, [relative]);
        if (!result) throw new Error("Targeted script sync did not run");
        const targetConflict = result.pendingConflicts.find(conflict => conflict.path === relative);
        const targetFailure = result.failed.find(failure => failure.path === relative);
        if (targetConflict || targetFailure) throw new Error(`Target script needs sync attention before execution: ${summarize(result)}`);
        if (result.conflicts.length || result.failed.length) fileLog(`Unrelated targeted sync needs attention: ${summarize(result)}`);
        const finalSource = await readBoundScript();
        if (finalSource === undefined) throw new Error("Target script is missing from the bound project");
        verifyScriptIdentity(finalSource, binding.email, binding.slug);
    },
    "tool.execute.after": async (input, output) => {
      if (!mcpConfig) return;
      if (["write", "edit", "apply_patch"].includes(input.tool)) {
        const target = input.args?.filePath;
        if (typeof target !== "string") return;
        const relative = path.relative(ctx.directory, target).split(path.sep).join("/");
        queueWrite(relative);
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
