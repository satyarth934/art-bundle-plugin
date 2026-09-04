/**
 * Type definitions for the container path guard system
 */

export interface MCPToolRouting {
  [toolName: string]: string;
}

export interface ContainerPathPattern {
  pattern: string;
  description: string;
  tools: string[];
  mcp_routing: MCPToolRouting;
}

export interface RemoteContainerConfig {
  container_paths: ContainerPathPattern[];
  enabled: boolean;
}

export interface InterceptEvent {
  tool: string;
  detected_path: string;
  matched_pattern: string;
  suggested_routing: string;
}

export interface MCPConfig {
  url: string;
  headers?: Record<string, string>;
  type?: "local" | "remote";
}
