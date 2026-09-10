/**
 * ART Bundle Plugin - Container Path Guard
 * Main entry point that registers the container path interception hooks
 */

import type { Config, Plugin, PluginInput } from "@opencode-ai/plugin";
import { containerPathGuard } from "../hooks/container-path-guard";
import { initSessionLog, fileLog } from "../hooks/file-logger";
import type { MCPConfig } from "../hooks/types";

/**
 * ARTBundlePlugin
 * Detects deployment mode at startup, then registers container path guard hooks.
 */
export const ARTBundlePlugin: Plugin = async (ctx: PluginInput) => {
  // Initialize session-based logging for the plugin and its hooks
  initSessionLog();

  let mcpConfig: MCPConfig | null = null;
  const guards = await containerPathGuard(ctx, () => mcpConfig);

  return {
    ...guards,
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
