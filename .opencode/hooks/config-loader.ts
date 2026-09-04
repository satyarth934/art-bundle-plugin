/**
 * Config loader for container path patterns
 * Dynamically loads YAML configuration on each invocation
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import type { RemoteContainerConfig } from "./types";

const DEFAULT_CONFIG_PATH = ".opencode/config/remote-container-paths.yaml";

export async function loadContainerConfig(
  configPath?: string
): Promise<RemoteContainerConfig> {
  const resolvedPath = configPath || DEFAULT_CONFIG_PATH;

  try {
    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return { container_paths: [], enabled: false };
    }

    // Read and parse YAML
    const content = fs.readFileSync(resolvedPath, "utf-8");
    const config = yaml.parse(content);

    // Validate and return
    if (!config || !Array.isArray(config.container_paths)) {
      return { container_paths: [], enabled: false };
    }

    return {
      container_paths: config.container_paths,
      enabled: config.container_paths.length > 0,
    };
  } catch (error) {
    console.debug(
      `[container-path-guard] Failed to load config from ${resolvedPath}:`,
      error
    );
    return { container_paths: [], enabled: false };
  }
}

/**
 * Detect if a given path matches any container path patterns
 */
export function matchContainerPattern(
  targetPath: string,
  config: RemoteContainerConfig
): any | null {
  if (!config.enabled) return null;

  for (const pattern of config.container_paths) {
    if (matchesWildcard(targetPath, pattern.pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * Simple wildcard matching (glob-style)
 * Supports * (zero or more chars) and ? (exactly one char)
 */
function matchesWildcard(input: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(input);
}

/**
 * Extract actual file path from tool arguments
 */
export function extractPathFromArgs(tool: string, args: any): string | null {
  switch (tool) {
    case "read":
    case "edit":
    case "glob":
      return args.filePath || null;

    case "bash":
      return extractPathFromBashCommand(args.command);

    case "grep":
      return args.path || null;

    default:
      return null;
  }
}

/**
 * Extract paths from bash commands (basic parsing)
 * Looks for common patterns like /app/... or /shared/...
 */
function extractPathFromBashCommand(command: string): string | null {
  if (!command) return null;

  // Match paths in bash commands
  const pathRegex = /(?:^|\s)([/\w\-\.]+\/[^\s]*)/;
  const match = command.match(pathRegex);

  return match ? match[1] : null;
}
