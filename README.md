# ART Bundle Plugin

**A complete OpenCode plugin for media optimization using the Automated Recommendation Tool (ART)**

---

## What's Included

This plugin provides everything you need to design and execute media optimization experiments:

- 🎯 **Media-Optimization Skill** — End-to-end pipeline for media composition design
- 🤖 **5 Specialized Agents** — Handles liquid handling, ART optimization, and more
- 📋 **Pre-built Templates** — CSV templates, Python scripts, and configuration files
- 🔗 **MCP Integration** — Direct connection to ART-MCP server for execution
- 📚 **Complete Documentation** — Setup guides, reference docs, and examples

---

## Quick Start (4 Steps)

### 1. Prerequisites

- ✅ OpenCode installed and configured
- ✅ Network access to art-mcp server

### 2. Install the Plugin

```bash
# Clone or download this repository
git clone <repository-url> art-bundle-plugin
cd art-bundle-plugin

# Run the installation script
./install.sh
```

The script will:
- Detect your OpenCode configuration location
- Copy skills and agents to your OpenCode directory
- Configure MCP server connection
- Verify connectivity

### 3. Verify Installation

In OpenCode, you should see:
- `media-optimization` skill available
- All 5 agents loaded (art-specialist, liquid-handler-specialist, etc.)
- MCP server connection active

### 4. Start Your First Experiment

```
User: I want to optimize my media composition for higher titers
OpenCode: I'll use the media-optimization skill to guide you through...
```

The skill will prompt you for:
- Your email address (for user isolation)
- Project name/slug (to organize your work)
- Experimental parameters and constraints

---

## System Requirements

| Component | Requirement |
|-----------|------------|
| **OpenCode** | v1.0+ |
| **Node.js** | v14+ (optional, for automatic config merging) |
| **curl** | For MCP connectivity test |
| **Bash** | 4.0+ |
| **Network** | Access to `https://art-mcp-1005318772721.us-west1.run.app/mcp` |

---

## Installation Details

### What Gets Installed

```
~/.opencode/
├── skills/
│   └── media-optimization/        ← Your new skill
│       ├── SKILL.md               ← Orchestration guide
│       ├── templates/             ← 14 template files
│       └── media-optimization-reference.md
│
└── agents/
    ├── art-specialist.md          ← New agents
    ├── liquid-handler-specialist.md
    ├── vantage-handler.md
    ├── literature-reviewer.md
    └── subtask-generalist.md
```

### Configuration

MCP server configuration is automatically added to `~/.opencode/opencode.json`:

```json
{
  "mcpServers": {
    "art-mcp": {
      "type": "stdio",
      "command": "curl",
      "args": ["--unix-socket", "/tmp/art-mcp.sock", "http://localhost/mcp"]
    }
  }
}
```

If you need to manually configure, see `opencode-mcp-config.jsonc`.

---

## User Isolation & Multi-User Support

This plugin supports multiple scientists working simultaneously:

### How It Works

1. **You provide your email** when starting the skill
   - Example: `alice@example.com`

2. **You create a project slug** (experiment identifier)
   - Example: `flaviolin_opt_cycle1`

3. **All your work is stored in**:
   ```
   /shared/user_impl_alpha/alice@example.com/flaviolin_opt_cycle1/
   ```

4. **Other scientists' data is isolated**:
   ```
   /shared/user_impl_alpha/bob@example.com/flaviolin_opt_cycle1/
   ```
   Even with the same project name, Bob cannot see Alice's files.

### Key Benefits

- ✅ Multiple users can work on the same project names without interference
- ✅ Complete data privacy between scientists
- ✅ Team collaboration while maintaining isolation
- ✅ Easy to manage multiple experiments per scientist

---

## Documentation

### For New Users

Start here:
1. **[PLUGIN_SETUP.md](PLUGIN_SETUP.md)** — Post-installation guide with troubleshooting
2. **[README.md](README.md)** — This file

### For Developers

Understanding the system:
1. **[docs/USER_ISOLATION_PATTERN.md](docs/USER_ISOLATION_PATTERN.md)** — How user/project isolation works
2. **[HYBRID_MIGRATION.md](HYBRID_MIGRATION.md)** — Future v2 roadmap

### Reference Materials

In the media-optimization skill:
- `SKILL.md` — Complete orchestration workflow and phase descriptions
- `media-optimization-reference.md` — Technical formulas and API documentation
- `templates/liquid-handler-reference.md` — Liquid handling calculations guide

---

## Common Workflows

### Workflow 1: Run Complete Optimization Cycle

```
1. Provide: email + project slug
2. Provide: standard recipe CSV
3. Provide: historical training data (optional)
4. Skill dispatches to liquid-handler-specialist
   → Calculate stock concentrations and bounds
5. Skill dispatches to art-specialist
   → Run ART optimization
6. Skill generates robotic instructions
7. You validate and approve outputs
```

### Workflow 2: Skip to ART Recommendations Only

```
1. Provide: email + project slug
2. Provide: bounds and training data
3. Skip phases 1-3 (bounds calculation)
4. Go directly to phase 4 (ART optimization)
5. Get recommendations without robotic instructions
```

### Workflow 3: Generate Robotic Instructions from Existing Data

```
1. Provide: email + project slug
2. Provide: bounds + stock files from previous cycle
3. Skip phases 1-4
4. Go directly to phase 5 (target concentrations)
5. Generate and validate robotic instructions
```

---

## Troubleshooting

### Installation Issues

**Problem**: `install.sh` cannot find OpenCode directory
- **Solution**: Create `~/.opencode` manually and re-run install.sh

**Problem**: Node.js not found
- **Solution**: Install Node.js or manually add MCP config to opencode.json (see PLUGIN_SETUP.md)

**Problem**: MCP connectivity test fails
- **Solution**: Check network access to art-mcp server URL or see PLUGIN_SETUP.md

### Usage Issues

**Problem**: Agents say "media_compiler not found"
- **Solution**: Ensure art-core service is running and accessible

**Problem**: Scripts fail with permission errors
- **Solution**: Verify your user isolation path is correct (/shared/user_impl_alpha/{email}/{slug}/)

**Problem**: "File not found" when loading data
- **Solution**: Ensure files are in your project directory, not in other users' directories

See [PLUGIN_SETUP.md](PLUGIN_SETUP.md) for more troubleshooting steps.

---

## Support & Questions

For issues or questions:
1. Check [PLUGIN_SETUP.md](PLUGIN_SETUP.md) troubleshooting section
2. Review [docs/USER_ISOLATION_PATTERN.md](docs/USER_ISOLATION_PATTERN.md) for user/project context
3. Consult skill documentation in `.opencode/skills/media-optimization/`

---

## What's Next?

### Getting Started
```bash
# Follow Quick Start above, then:
opencode
# Select media-optimization skill
# Follow the prompted workflow
```

### Learning More
- Read PLUGIN_SETUP.md for detailed post-installation guide
- Explore media-optimization skill documentation
- Review template examples in `.opencode/skills/media-optimization/templates/`

### Future Enhancements (v2)

See [HYBRID_MIGRATION.md](HYBRID_MIGRATION.md) for planned improvements:
- Automated releases and updates
- Enhanced distribution packaging
- GitHub Actions integration

---

## License

This plugin is distributed under the BSD 3-Clause License. See [LICENSE](LICENSE) file for details.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | July 2026 | Initial MVP release |

---

**Ready to optimize your media?** Run `./install.sh` to get started! 🚀
