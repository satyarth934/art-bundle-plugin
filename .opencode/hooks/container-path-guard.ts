/**
 * Container Path Guard Hook
 * Intercepts local tool calls targeting remote container paths
 * and redirects to appropriate MCP tools
 */

import type { MCPConfig } from "./types";
import {
  loadContainerConfig,
  matchContainerPattern,
  extractPathFromArgs,
} from "./config-loader";
import { detectMCPTools, isMCPTool } from "./mcp-detector";
import { logIntercept, generateErrorMessage } from "./logger";

export async function containerPathGuard(ctx: any) {
  // Check if enabled via environment variable
  const isRemote = process.env.ARTMCP_DEPLOYMENT_MODE === "gcp_remote";

  if (!isRemote) {
    // Hook disabled, return empty hooks object
    return {};
  }

  // Get MCP configuration from OpenCode context
  const mcpConfig = extractMCPConfig(ctx);

  if (!mcpConfig) {
    console.debug(
      "[container-path-guard] Could not extract MCP configuration, disabling hook"
    );
    return {};
  }

  // Detect available MCP tools
  const mcpTools = await detectMCPTools(mcpConfig);

  if (mcpTools.length === 0) {
    console.debug(
      "[container-path-guard] Warning: Could not detect MCP tools from remote server"
    );
  }

  // Return hook implementation
  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
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

        // Throw error to block tool and provide guidance
        throw new Error(generateErrorMessage(input.tool, matchedPattern, suggestion));
      } catch (error) {
        // Re-throw to block the tool call
        throw error;
      }
    },
  };
}

/**
 * Extract MCP configuration from OpenCode context
 * Reads from the project's opencode.jsonc/.json config
 */
function extractMCPConfig(ctx: any): MCPConfig | null {
  try {
    // In OpenCode plugins, context contains project information
    // We need to read the MCP config from opencode.jsonc

    // Try to get from context (if available)
    if (ctx.project && ctx.project.mcpConfig) {
      return ctx.project.mcpConfig;
    }

    // Otherwise, we'll construct from known locations
    // This is a fallback - ideally ctx provides this
    return null;
  } catch (error) {
    console.debug("[container-path-guard] Error extracting MCP config:", error);
    return null;
  }
}
