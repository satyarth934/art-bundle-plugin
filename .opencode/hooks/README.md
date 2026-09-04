# Container Path Guard Hooks

This directory contains the TypeScript hooks that intercept local tool calls targeting remote container paths and redirect them to appropriate MCP tools.

## Files Overview

### `types.ts`
Type definitions for the entire system:
- `MCPToolRouting` — Mapping of tools to MCP routing suggestions
- `ContainerPathPattern` — Pattern definition with tools and routing
- `RemoteContainerConfig` — Full configuration structure
- `InterceptEvent` — Logged event details
- `MCPConfig` — MCP server configuration

### `config-loader.ts`
Dynamically loads and parses the YAML configuration:
- `loadContainerConfig()` — Reads `.opencode/config/remote-container-paths.yaml`
- `matchContainerPattern()` — Tests if a path matches any patterns
- `extractPathFromArgs()` — Extracts file paths from different tool arguments
- Uses simple wildcard matching (glob-style: `*` and `?`)

### `mcp-detector.ts`
Auto-detects available MCP tools from the remote server:
- `detectMCPTools()` — Queries remote MCP using FastMCP JSON-RPC protocol
- `isMCPTool()` — Checks if a tool name is from the MCP server
- Uses session-level caching to avoid repeated network calls
- `clearMCPToolsCache()` — Clears cache (useful for testing)

### `logger.ts`
Structured logging for debugging:
- `logIntercept()` — Logs interceptions to OpenCode's logger
- `generateErrorMessage()` — Creates helpful error messages with context
- Includes path, pattern, and suggested MCP tool in logs

### `container-path-guard.ts`
Main hook implementation:
- `containerPathGuard()` — Returns the `tool.execute.before` hook
- Checks environment variable `ARTMCP_DEPLOYMENT_MODE=gcp_remote`
- Loads config dynamically on each invocation
- Detects MCP tools and skips them
- Extracts paths and matches against patterns
- Throws informative errors for blocked operations

## How It All Works Together

```
User Request
    ↓
OpenCode Tool Call (read, bash, edit, glob, grep)
    ↓
Hook: tool.execute.before fires
    ↓
container-path-guard.ts:
  1. Check if ARTMCP_DEPLOYMENT_MODE=gcp_remote
  2. Load config (config-loader.ts)
  3. Detect available MCP tools (mcp-detector.ts)
  4. Extract path from tool args (config-loader.ts)
  5. Match against patterns (config-loader.ts)
  6. If match: Log & throw error (logger.ts)
  7. Error routed to LLM → LLM calls MCP tool ✓
    ↓
Remote MCP Execution
```

## Plugin Integration

The plugin entry point (`.opencode/plugins/index.ts`) imports and registers these hooks:

```typescript
import { containerPathGuard } from "../hooks/container-path-guard";

export const ARTBundlePlugin = async (ctx) => {
  const guards = await containerPathGuard(ctx);
  return { ...guards };
};
```

## Configuration

Path patterns are defined in `../config/remote-container-paths.yaml`:

```yaml
container_paths:
  - pattern: "/app/*"
    description: "Application code"
    tools: ["read", "edit", "bash", "glob", "grep"]
    mcp_routing:
      read: "Use execute_code()..."
      # ...
```

## Environment Variables

- `ARTMCP_DEPLOYMENT_MODE` — Set to `"gcp_remote"` to enable hooks
- `REMOTE_CONTAINER_CONFIG_PATH` — Optional custom config path

## Development Notes

### Adding a New Tool Interception

1. Add tool name to `tools:` in config YAML
2. Add routing suggestion in `mcp_routing:` section
3. Update `extractPathFromArgs()` in `config-loader.ts` if needed (for new tool type)

### Testing

To test hooks locally without MCP:
```bash
unset ARTMCP_DEPLOYMENT_MODE
opencode
# Hooks will be disabled
```

To enable:
```bash
export ARTMCP_DEPLOYMENT_MODE="gcp_remote"
opencode
```

### Debugging

Enable debug logging by checking hook console output:
```bash
# Look for [container-path-guard] messages in OpenCode logs
```

## Performance Characteristics

- **Config loading**: ~1ms (YAML parsing)
- **Path matching**: Nanoseconds (regex)
- **MCP tool detection**: One query per session (~100ms first call, cached)
- **Overall overhead**: Negligible (<1ms per tool call)

## Future Enhancements

- [ ] Support for regex patterns (in addition to wildcards)
- [ ] Path-specific permission rules integration
- [ ] Custom interception handlers
- [ ] MCP tool parameter validation
- [ ] Analytics/metrics on interceptions

---

**Last updated:** August 2026
