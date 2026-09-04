/**
 * MCP tool detector - discovers available tools from remote MCP server
 * Uses FastMCP JSON-RPC protocol
 */

import type { MCPConfig } from "./types";

let mcpToolsCache: string[] | null = null;

/**
 * Detect available tools from the remote MCP server
 * Uses FastMCP's JSON-RPC tools/list method
 * Results are cached per OpenCode session
 */
export async function detectMCPTools(mcpConfig: MCPConfig): Promise<string[]> {
  // Return cached tools if available (same session)
  if (mcpToolsCache !== null) {
    return mcpToolsCache;
  }

  try {
    // Only detect if using remote MCP
    if (mcpConfig.type !== "remote") {
      return [];
    }

    // Query remote MCP server using FastMCP JSON-RPC protocol
    const response = await fetch(mcpConfig.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(mcpConfig.headers || {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    if (!response.ok) {
      console.debug(
        `[container-path-guard] MCP tool detection returned ${response.status}`
      );
      return [];
    }

    const data = await response.json();

    // FastMCP returns tools as array in response.result.tools
    if (data.result && Array.isArray(data.result.tools)) {
      const tools = data.result.tools.map((tool: any) => tool.name);
      mcpToolsCache = tools;
      return tools;
    }

    // Handle error response
    if (data.error) {
      console.debug(
        `[container-path-guard] MCP tool detection error:`,
        data.error
      );
      return [];
    }

    return [];
  } catch (error) {
    console.debug(`[container-path-guard] Failed to detect MCP tools:`, error);
    return [];
  }
}

/**
 * Check if a tool is an MCP tool (from remote server)
 */
export async function isMCPTool(toolName: string, mcpConfig: MCPConfig): Promise<boolean> {
  const tools = await detectMCPTools(mcpConfig);
  return tools.includes(toolName);
}

/**
 * Clear the MCP tools cache (useful for testing)
 */
export function clearMCPToolsCache(): void {
  mcpToolsCache = null;
}
