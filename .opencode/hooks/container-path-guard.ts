/**
 * Container Path Guard Hook
 * Intercepts local tool calls targeting remote container paths
 * and redirects to appropriate MCP tools
 */

import type { MCPConfig } from "./types";
import type { PluginInput } from "@opencode-ai/plugin";
import {
  loadContainerConfig,
  matchContainerPattern,
  extractPathFromArgs,
} from "./config-loader";
import { detectMCPTools, isMCPTool } from "./mcp-detector";
import { logIntercept, generateErrorMessage } from "./logger";
import { fileLog } from "./file-logger";

export async function containerPathGuard(
  ctx: PluginInput,
  getMCPConfig: () => MCPConfig | null
) {
  let mcpTools: string[] | null = null;

  // Return hook implementation
  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        const mcpConfig = getMCPConfig();
        if (!mcpConfig) return;

        if (mcpTools === null) {
          mcpTools = await detectMCPTools(mcpConfig);
          if (mcpTools.length === 0) {
            fileLog(
              "[container-path-guard] Warning: Could not detect MCP tools from remote server"
            );
          }
        }

        // Skip if this is an MCP tool call
        if (mcpTools.includes(input.tool)) {
          return;
        }

        // Load config (dynamically on each invocation)
        const config = await loadContainerConfig();

        if (!config.enabled) {
          return;
        }

        // Extract path from tool arguments
        const targetPath = extractPathFromArgs(input.tool, output.args);

        if (!targetPath) {
          return;
        }

        // Check if path matches any container patterns
        const matchedPattern = matchContainerPattern(targetPath, config);

        if (!matchedPattern) {
          return;
        }

        // Check if this tool is in the blocked list for this pattern
        if (!matchedPattern.tools.includes(input.tool)) {
          return;
        }

        // Get routing suggestion for this tool and pattern
        const suggestion =
          matchedPattern.mcp_routing[input.tool] ||
          "Use MCP tools to access this path";

        // Log the interception
        await logIntercept(
          {
            tool: input.tool,
            detected_path: targetPath,
            matched_pattern: matchedPattern.pattern,
            suggested_routing: suggestion,
          },
          ctx.client
        );

        const errorMsg = generateErrorMessage(input.tool, matchedPattern, suggestion);
        fileLog(errorMsg, { sessionID: input.sessionID, callID: input.callID });

        // Throw error to block tool and provide guidance
        throw new Error(errorMsg);
      } catch (error) {
        // Re-throw to block the tool call
        throw error;
      }
    },
  };
}
