# ART Bundle Plugin - Post-Installation Setup Guide

**After running `./install.sh`, complete these optional configuration steps**

---

## ⚠️ IMPORTANT: Project-Level Installation Only

This plugin **ONLY installs at the project level** to `.opencode/` in your current directory.

**Global installation to `~/.opencode/` is NOT supported.**

All configuration and files are local to your project. This ensures:
- ✅ Clean project organization
- ✅ No conflicts with other projects
- ✅ Easy to manage multiple experiments
- ✅ Simple cleanup (just delete the project directory)

---

## What Was Installed

✅ **Skills**:
- `media-optimization` — Complete pipeline for media composition optimization

✅ **Agents** (5 total):
- `art-specialist` — ART (Automated Recommendation Tool) optimization
- `liquid-handler-specialist` — Liquid handling calculations and robotic instructions
- `vantage-handler` — Integration handler for Vantage platform
- `literature-reviewer` — Literature search and analysis
- `subtask-generalist` — General subtask handling

✅ **MCP Integration**:
- Connected to art-mcp Cloud Run service
- User isolation configured (email + project slug pattern)
- Tools ready for execution

---

## Optional Configuration

### 1. Enable MCP Authentication (If Required)

If your MCP server requires API keys:

**Edit your local OpenCode configuration** (`.opencode/opencode.json` in your project directory):

```json
{
  "mcpServers": {
    "art-mcp": {
      "type": "stdio",
      "command": "curl",
      "args": ["--unix-socket", "/tmp/art-mcp.sock", "http://localhost/mcp"],
      "env": {
        "MCP_API_KEY": "your-api-key-here",
        "MCP_AUTH_TOKEN": "bearer-token-if-needed"
      }
    }
  }
}
```

Or if using environment variables:
```bash
export MCP_API_KEY="your-api-key-here"
export ARTMCP_AUTH_API_KEY="your-auth-key"
```

### 2. Configure Debug Logging (Optional)

For troubleshooting agent behavior:

**In your OpenCode configuration**:
```json
{
  "mcpServers": {
    "art-mcp": {
      ...
      "debug": true
    }
  }
}
```

This will log:
- MCP protocol messages
- Tool execution details
- Error stacks and stderr output

---

## Verify Installation

### Test 1: Check Files Are Copied

```bash
# Check skills installed
ls .opencode/skills/media-optimization/

# Expected output:
# SKILL.md
# media-optimization-reference.md
# templates/

# Check agents installed
ls .opencode/agents/*.md | grep -E "(art|liquid|vantage|literature|subtask)"

# Expected: 5 agent files listed
```

### Test 2: Check MCP Configuration

```bash
# View MCP server configuration
cat .opencode/opencode.json | grep -A 10 "art-mcp"

# Should show: type, command, args for art-mcp
```

### Test 3: Manual MCP Connectivity Test

```bash
# Test the MCP server endpoint
curl -X POST https://art-mcp-1005318772721.us-west1.run.app/mcp \
  -H "Authorization: Bearer your-api-key" \
  -d '{"method": "list_tools", "jsonrpc": "2.0"}'

# Should return: list of available tools (not an error)
```

---

## User Isolation & Project Context

### Understanding the Pattern

All work is organized by user email + project slug:

```
/shared/user_impl_alpha/{your_email}/{project_slug}/
```

**Example**:
```
/shared/user_impl_alpha/scientist@lab.edu/flaviolin_opt_v1/
├── scripts/
├── data/
├── outputs/
└── config/
```

### First Run: Provide Context

When you start the media-optimization skill, you'll be prompted:

1. **Your email**: `scientist@lab.edu`
   - Used to organize your projects
   - Enables multi-user isolation

2. **Project slug**: `flaviolin_opt_v1`
   - Short, memorable identifier
   - Alphanumeric + hyphens (no spaces)
   - Example: `media_opt_cycle2`, `strain_design_v3`

### Multi-User Example

Two scientists working on "flaviolin_opt":
```
alice@example.com/flaviolin_opt/      ← Alice's isolated space
bob@example.com/flaviolin_opt/        ← Bob's isolated space (can't see Alice's)
```

Same project name, but complete data isolation!

---

## Troubleshooting

### Installation Didn't Complete

**Problem**: `install.sh` exited with an error

**Solutions**:
1. Check your OpenCode directory exists:
   ```bash
   ls -la .opencode/
   # or
   ls -la .opencode/
   ```

2. Create it if missing:
   ```bash
   mkdir -p .opencode/{skills,agents}
   ```

3. Re-run `install.sh`:
   ```bash
   ./install.sh
   ```

### MCP Server Not Reachable

**Problem**: Connectivity test fails, or you see "MCP server unreachable"

**Solutions**:
1. Check network access:
   ```bash
   ping -c 1 art-mcp-1005318772721.us-west1.run.app
   ```

2. Test with curl directly:
   ```bash
   curl -v https://art-mcp-1005318772721.us-west1.run.app/mcp
   ```

3. Check firewall/proxy settings
   - Some networks block outbound connections
   - Ask your IT department to allowlist the art-mcp URL

4. Verify in OpenCode settings:
   - Click "Settings" → "MCP Servers"
   - Check `art-mcp` is listed and "enabled"

### "Skills Not Loading"

**Problem**: media-optimization skill doesn't appear in OpenCode

**Solutions**:
1. Verify files are installed:
   ```bash
   ls .opencode/skills/media-optimization/SKILL.md
   # Should exist, not show "No such file"
   ```

2. Restart OpenCode:
   ```bash
   # Close OpenCode completely
   # Wait 5 seconds
   # Reopen OpenCode
   ```

3. Check for syntax errors in SKILL.md:
   ```bash
   # Verify YAML front matter is valid
   head -10 .opencode/skills/media-optimization/SKILL.md
   # Should show: --- at start, proper YAML metadata
   ```

### "Agent Not Found" Error

**Problem**: Skill dispatches to an agent, but OpenCode says it's not available

**Solutions**:
1. Verify agent files exist:
   ```bash
   ls .opencode/agents/art-specialist.md
   ls .opencode/agents/liquid-handler-specialist.md
   # etc.
   ```

2. Check agent YAML is valid:
   ```bash
   head -25 .opencode/agents/art-specialist.md
   # Should have proper YAML metadata
   ```

3. Restart OpenCode and try again

### "Media_compiler Not Found" During Execution

**Problem**: Script execution fails with "import error: media_compiler not found"

**Solutions**:
1. This is expected if art-core service isn't running
2. Check with your administrator that art-core is deployed and accessible
3. Verify MCP server connectivity (see test above)
4. Check that script path is within your user's project directory:
   ```bash
   # Should be in: /shared/user_impl_alpha/{your_email}/{your_slug}/
   # NOT in: /app/
   ```

### "File Not Found" When Loading Data

**Problem**: Script says "file not found" even though you think you uploaded it

**Solutions**:
1. Verify file is in your project space:
   ```bash
   # List files in your project
   # (You would use list_shared_files MCP tool for this)
   ```

2. Check you're using the correct user email and project slug
   - Case-sensitive!
   - No spaces, only alphanumerics and hyphens

3. Verify file was actually uploaded:
   - Check that upload_script/upload_data_file returned success
   - Look for error messages in the upload response

### "Permission Denied" / "Cannot Access File"

**Problem**: Error says you don't have permission to access a file

**Solutions**:
1. You can only access files in your own project:
   - Path must contain: `/shared/user_impl_alpha/{your_email}/{your_slug}/`
   
2. Check the email is correct:
   - Is it exactly as you provided it to the skill?
   - Case-sensitive
   - No typos

3. You cannot access other users' projects
   - This is by design (security feature)
   - Share files by uploading to shared location if available

---

## Performance & Optimization

### Script Execution Time

Long-running scripts (ART optimization, LHS verification):
- Expected: 30 seconds to 5 minutes
- Varies by data size and complexity
- Check execution logs for progress

### Managing Disk Space

Your project directory can grow if you:
- Run many iterations
- Store large training datasets
- Keep multiple experimental runs

To manage:
```bash
# In your project directory, clean up old outputs:
# (This is done via the MCP tools, not direct filesystem)
```

### Improving Performance

For faster iterations:
1. Use smaller training datasets initially
2. Reduce `num_recommendations` in ART config
3. Use "fast-path" workflows when possible (skip unnecessary phases)

---

## Next Steps

### 1. Run Your First Experiment

```bash
# Open OpenCode
opencode

# Select media-optimization skill
# Follow the prompted workflow:
# - Provide email and project slug
# - Upload recipe CSV
# - Follow the orchestration pipeline
```

### 2. Review Documentation

Key files to read:
- **README.md** — Quick start and overview
- **.opencode/skills/media-optimization/SKILL.md** — Full workflow
- **docs/USER_ISOLATION_PATTERN.md** — How isolation works
- **.opencode/skills/media-optimization/media-optimization-reference.md** — Technical formulas

### 3. Explore Templates

Pre-built templates for common tasks:
```bash
ls .opencode/skills/media-optimization/templates/

# Examples:
# - art_config_template.csv
# - experiment_config_template.csv
# - standard_recipe_template.csv
```

### 4. Try Different Workflows

Three main workflows are supported:
1. **Full pipeline**: New experiment from scratch
2. **ART only**: Recommendations from existing bounds
3. **Robotic instructions only**: From existing data

See **README.md** for workflow examples.

---

## Getting Help

### Documentation

- [README.md](README.md) — Quick start guide
- [docs/USER_ISOLATION_PATTERN.md](docs/USER_ISOLATION_PATTERN.md) — User/project context
- [HYBRID_MIGRATION.md](HYBRID_MIGRATION.md) — Future roadmap

### Skill Documentation

Located in `.opencode/skills/media-optimization/`:
- **SKILL.md** — Complete orchestration guide
- **media-optimization-reference.md** — Technical reference
- **templates/** — Example configuration files

### Agent Documentation

Located in `.opencode/agents/`:
- Each `.md` file documents one agent
- Includes capabilities, requirements, and usage patterns

---

## Common Commands

```bash
# View MCP configuration
cat .opencode/opencode.json

# List installed skills
ls .opencode/skills/

# List installed agents
ls .opencode/agents/

# View skill documentation
cat .opencode/skills/media-optimization/SKILL.md

# Test MCP connectivity
curl https://art-mcp-1005318772721.us-west1.run.app/mcp
```

---

## Reporting Issues

If you encounter problems:

1. **Gather information**:
   - OpenCode version
   - Installation command and output
   - Error messages (full text)
   - Which step failed (setup, first run, etc.)

2. **Check troubleshooting** above first

3. **Contact support** with gathered info

---

**Ready to get started?** Open OpenCode and select the media-optimization skill! 🚀
