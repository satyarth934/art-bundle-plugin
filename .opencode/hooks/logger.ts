/**
 * Structured logging for container path guard interceptions
 */

import type { InterceptEvent } from "./types";

export async function logIntercept(
  event: InterceptEvent,
  client: any
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "container-path-guard",
        level: "info",
        message: "Container path intercepted",
        extra: {
          tool: event.tool,
          detected_path: event.detected_path,
          matched_pattern: event.matched_pattern,
          suggested_routing: event.suggested_routing,
        },
      },
    });
  } catch (error) {
    // Silently fail logging to avoid breaking the hook
    console.debug("[container-path-guard] Logging failed:", error);
  }
}

export function generateErrorMessage(
  tool: string,
  pattern: ContainerPathPattern,
  suggestion: string
): string {
  return `[Container Path Interception]
The path "${pattern.pattern}" is a REMOTE container path located on GCP.
Local tool "${tool}" cannot access it.

✓ ROUTING SUGGESTION:
${suggestion}

Why? All paths matching "${pattern.pattern}" are isolated to the GCP runtime and must be accessed through MCP tools.`;
}

interface ContainerPathPattern {
  pattern: string;
  description: string;
}
