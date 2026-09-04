/**
 * ART Bundle Plugin - Container Path Guard
 * Main entry point that registers the container path interception hooks
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Plugin } from "@opencode-ai/plugin";
import { containerPathGuard } from "../hooks/container-path-guard";

/**
 * Detect whether the art-mcp server is configured as remote or local.
 *
 * Checks config files in this order (first match wins):
 *   1. <project-root>/opencode.jsonc
 *   2. <project-root>/opencode.json
 *   3. <project-root>/.opencode/opencode.jsonc
 *   4. <project-root>/.opencode/opencode.json
 *   5. ~/.config/opencode/opencode.json  (global fallback)
 *
 * If art-mcp.type === "remote" is found in any of these, sets
 * process.env.ARTMCP_DEPLOYMENT_MODE = "gcp_remote" for this session.
 * No shell profile modification required.
 */
/**
 * Strip JSONC comments and trailing commas to produce valid JSON.
 * Protects string values (including URLs) from being incorrectly stripped.
 */
function stripJsoncComments(jsonc: string): string {
  // Match quoted strings (leave untouched) OR comments (strip them)
  const noComments = jsonc.replace(
    /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
    (match, group1) => (group1 ? "" : match)
  );
  // Strip trailing commas (valid JSONC, invalid JSON)
  return noComments.replace(/,\s*([\]}])/g, "$1");
}

function detectDeploymentMode(): void {
  const projectRoot = process.cwd();

  const candidates = [
    path.join(projectRoot, "opencode.jsonc"),
    path.join(projectRoot, "opencode.json"),
    path.join(projectRoot, ".opencode", "opencode.jsonc"),
    path.join(projectRoot, ".opencode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  ];

  for (const configPath of candidates) {
    if (!fs.existsSync(configPath)) continue;

    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const cleaned = stripJsoncComments(content);
      const config = JSON.parse(cleaned);

      if (config?.mcp?.["art-mcp"]?.type === "remote") {
        process.env.ARTMCP_DEPLOYMENT_MODE = "gcp_remote";
        console.debug(
          `[art-bundle-plugin] Remote MCP detected from ${configPath} — container path guards enabled`
        );
        return;
      }
    } catch (err) {
      // Malformed config — skip and try next candidate
      console.debug(
        `[art-bundle-plugin] Could not parse ${configPath}, skipping: ${err}`
      );
      continue;
    }
  }

  // Not found in any config — guards stay disabled
  console.debug(
    "[art-bundle-plugin] No remote art-mcp config found — container path guards disabled"
  );
}

/**
 * ARTBundlePlugin
 * Detects deployment mode at startup, then registers container path guard hooks.
 */
export const ARTBundlePlugin: Plugin = async (ctx) => {
  // Detect deployment mode from config files — sets ARTMCP_DEPLOYMENT_MODE if remote
  detectDeploymentMode();

  // Initialize container path guard (reads ARTMCP_DEPLOYMENT_MODE)
  const guards = await containerPathGuard(ctx);

  return {
    ...guards,
  };
};

// Default export for CommonJS compatibility
export default ARTBundlePlugin;
