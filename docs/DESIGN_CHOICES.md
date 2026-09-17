# ART Bundle Plugin - Design Choices & Future Work

**Document Version**: 1.0  
**Last Updated**: July 29, 2026  
**Status**: Reference for future development

---

## Overview

This document captures key design decisions made during the development of the ART Bundle Plugin v1 MVP. It serves as a reference for future improvements and helps new contributors understand the rationale behind architectural choices.

---

## 1. Installation Approach: One-Command curl with Dynamic Version Resolution

### Decision

Users install via a single stable entrypoint URL on `main`:
```bash
curl -fsSL https://raw.githubusercontent.com/satyarth934/art-bundle-plugin/main/install.sh | bash
```

The installer dynamically resolves the latest stable release at runtime (skipping pre-release candidates) and downloads the corresponding release archive directly without requiring a Git client. Specific versions or pre-release candidates can be explicitly selected via `ART_BUNDLE_PLUGIN_VERSION` or `--version`.

### Rationale

**One-Command UX**: Lowers barrier to entry. Users don't need to clone repositories or manage manual paths. They copy-paste one stable line from documentation.

**Decoupled Release Workflow**: Decouples the installer bootstrap from the release payload, permanently solving the chicken-and-egg release tagging cycle. Creating a release tag on GitHub automatically becomes available to installer users without requiring a follow-up commit to update hardcoded versions inside the script.

**Rate-Limit-Safe Resolution**: Uses HTTP redirect inspection on `/releases/latest` rather than unauthenticated GitHub REST API calls, completely avoiding GitHub API rate limiting (HTTP 403) on shared corporate IPs or CI runners.

**Fast Tarball Streaming**: Directly streams and extracts `/archive/refs/tags/<version>.tar.gz` to a temporary directory with automatic `trap` cleanup on exit. Avoids `git clone` overhead and client Git dependencies.

**Pre-release Protection**: By default, `/releases/latest` resolves only official releases, preventing experimental `-rc` or `-beta` builds from reaching general users unless explicitly requested via `ART_BUNDLE_PLUGIN_VERSION=v1.1.0-rc.1`.

### Trade-offs

| Aspect | Trade-off |
|--------|-----------|
| **Network** | Requires HTTPS connectivity to GitHub to fetch archives |
| **Simplicity** | Script handles multiple execution modes (piped curl, local checkout, directory override) |
| **Namespace Isolation** | Requires namespaced variable `ART_BUNDLE_PLUGIN_VERSION` to prevent accidental shell collisions |

### Future Improvements

- [ ] **Signature verification**: Add GPG/cosign signature verification for release archives
- [ ] **Release notes integration**: Link to release notes showing what changed since last version
- [ ] **Checksum validation**: Verify SHA256 checksums of downloaded tarballs against release manifests

---

## 2. Project-Level Installation Only

### Decision

The plugin ONLY installs to local `.opencode/` directory. Global installation to `~/.opencode/` is explicitly NOT supported.

### Rationale

**Data Isolation**: Each project has its own configuration. Multiple projects can coexist without interference.

**Clarity**: Users know exactly where files are installed (current directory).

**Cleanup**: Removing a project is simple - just delete the directory. No need to uninstall from global location.

**Multi-Project Support**: Scientists often run multiple concurrent experiments. Project-level installation supports this without conflicts.

**No Pollution**: User's home directory remains clean. Only the project directory contains plugin files.

### Design Implementation

- `detect_opencode_config()` only checks for local `.opencode/`
- Script fails clearly if local `.opencode/` doesn't exist
- Script explicitly rejects global `~/.opencode/` locations
- Documentation emphasizes "project-level only"

### Future Improvements

- [ ] **Optional global mode**: Consider supporting opt-in global mode for power users (with clear warnings)
- [ ] **Multiple project management**: Command-line tool to manage multiple projects from one location
- [ ] **Project templates**: Pre-configured `.opencode/` templates for different experiment types

---

## 3. Configuration Priority: JSONC over JSON

### Decision

The script prioritizes `.opencode/jsonc` over `.opencode/json` when both exist.

New configurations default to `.jsonc` format.

### Rationale

**Comments**: JSONC supports comments, making configuration self-documenting.

**User Experience**: Users can understand and modify configuration without external documentation.

**Flexibility**: JSON is still supported as fallback for compatibility.

### Implementation

```bash
# Detection order
if [ -f "$OPENCODE_JSONC" ]; then
    CONFIG_FILE="$OPENCODE_JSONC"
elif [ -f "$OPENCODE_JSON" ]; then
    CONFIG_FILE="$OPENCODE_JSON"
else
    # Create new as JSONC (supports comments)
    CONFIG_FILE="$OPENCODE_JSONC"
fi
```

### Future Improvements

- [ ] **YAML support**: Consider YAML as alternative (more readable)
- [ ] **Config validation**: Schema validation to catch configuration errors early
- [ ] **Migration tool**: Automatically migrate .json → .jsonc with helpful comments

---

## 4. Idempotency & Duplicate Detection

### Decision

The install script detects if media-optimization skill already exists. If it does, installation is skipped with a clear warning.

Script is idempotent - safe to run multiple times.

### Rationale

**Safety**: Prevents accidentally overwriting existing configurations.

**User Understanding**: Clear message explains why installation was skipped and how to reinstall if needed.

**Development Friendly**: Developers can re-run script during development without worrying about side effects.

### Implementation

```bash
check_already_installed() {
    if [ -f ".opencode/skills/media-optimization/SKILL.md" ]; then
        log_warning "Installation already exists..."
        exit 0  # Exit cleanly, not as error
    fi
}
```

### Detection Mechanism

Checks for `.opencode/skills/media-optimization/SKILL.md` as the sentinel file indicating successful installation.

### Granular Reinstall - Never Delete Entire .opencode

**Critical Design Principle**: Users should ONLY reinstall the plugin skill, never the entire `.opencode/` directory.

**Why**: Users may have personal configurations in `.opencode/` (other skills, custom agents, personal settings) that we must never disturb or suggest deleting.

**Safe reinstall command** (plugin-only):
```bash
rm -rf .opencode/skills/media-optimization && ./install.sh
```

This preserves all other `.opencode/` content including custom skills, agents, and user configurations.

The install script warning message explicitly recommends this granular approach and never suggests deleting the entire `.opencode/` directory.

### Future Improvements

- [ ] **Upgrade support**: Detect existing installation and ask user if they want to upgrade
- [ ] **Version tracking**: Store version info in `.opencode/` to enable smart upgrades
- [ ] **Incremental updates**: Only update changed files instead of full re-copy
- [ ] **Backup on upgrade**: Automatically backup existing configuration before upgrade

---

## 5. Artifact Retrieval & Temporary Directory Strategy

### Decision

When script is piped via curl, it resolves the target release archive, creates a temporary directory using `mktemp -d`, streams and unpacks the tarball directly, and registers a `trap` to ensure complete cleanup on exit.

### Rationale

**Separation**: Temporary directory keeps installation files isolated from the user's workspace until selected files are deployed to `.opencode/`.

**Automatic Cleanup**: The `trap 'rm -rf "${TMP_DIR}"' EXIT` guarantees the temporary directory is removed whether the installation succeeds, fails, or is interrupted.

**Flexibility**: If running from a cloned repo or with `ART_BUNDLE_PLUGIN_DIR` set, the script skips remote downloading and installs directly from local files.

### Detection Logic

```bash
if [ -n "${ART_BUNDLE_PLUGIN_DIR:-}" ]; then
    PLUGIN_DIR="$(cd "$ART_BUNDLE_PLUGIN_DIR" && pwd)"
    REPO_CLONED=true
elif [ -f "install.sh" ] && [ -d ".opencode" ]; then
    PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
    REPO_CLONED=true
else
    # Being piped via curl - download archive to a temporary directory
    PLUGIN_DIR=""
    REPO_CLONED=false
fi
```

### Trade-offs

| Aspect | Trade-off |
|--------|-----------|
| **Tarball Generation** | Relies on GitHub archive endpoints to provide `.tar.gz` files |
| **Permissions** | Requires write permissions in the OS temporary directory (`/tmp`) |

### Future Improvements

- [ ] **Configurable temp directory**: Allow users to specify where temporary extraction happens
- [ ] **Persistent cache**: Option to cache tarballs for offline installation
- [ ] **Verbose mode**: Show users detailed extraction steps and file lists

---

## 6. Error Handling & User Messaging

### Decision

Script uses colored output (info, success, warning, error) to make messages clear and scannable.

Failures exit cleanly with helpful error messages, not stack traces.

### Implementation

```bash
log_info()     # Blue - informational
log_success()  # Green - successful steps
log_warning()  # Yellow - potential issues
log_error()    # Red - critical failures
```

### Future Improvements

- [ ] **Quiet mode**: `--quiet` flag to suppress non-error output
- [ ] **Verbose mode**: `--verbose` flag to show more details (useful for debugging)
- [ ] **Log file**: Option to save installation log to file for support/debugging
- [ ] **Progress indicators**: Progress bars for long operations (cloning, copying)

---

## 7. User Context & Project Isolation

### Decision

The plugin requires users to provide email + project slug, enforced via `/shared/user_impl_alpha/{email}/{slug}/` path structure.

This is documented in agents and SKILL.md, not enforced at install time.

### Rationale

**Install-Time Agnostic**: Installation doesn't need to know about user context. That's a runtime concern.

**Agent Responsibility**: Each agent documents how to handle user context in its own documentation.

**Flexibility**: Different workflows can have different isolation strategies if needed.

### Documentation Location

- `SKILL.md` Phase 0 - prompts for email + slug
- `liquid-handler-specialist.md` - "User & Project Context" section
- `art-specialist.md` - identical context section
- `docs/USER_ISOLATION_PATTERN.md` - complete reference

### Future Improvements

- [ ] **Automatic context detection**: Agents could infer email/slug from environment or config
- [ ] **Interactive setup**: First-run wizard to configure email + slug
- [ ] **Profile management**: Store user profiles locally with quick-switch capability
- [ ] **Team mode**: Support team-level isolation in addition to user-level

---

## 8. MCP Configuration Management

### Decision

Script automatically merges MCP configuration into `opencode.json(c)`. If Node.js is missing, it prompts user to manually add configuration.

### Rationale

**Automatic When Possible**: Reduces user friction when Node.js is available.

**Graceful Fallback**: Doesn't fail if Node.js is missing - just requires manual step.

**Non-Destructive**: Uses JSON merge, not replacement. Existing configurations are preserved.

### JSONC Priority

Script prefers `.jsonc` over `.json` to support comments.

### Future Improvements

- [ ] **Shell-based JSON merge**: Replace Node.js with shell-native JSON manipulation (avoid Node.js dependency)
- [ ] **Config validation**: Verify MCP configuration is correct before marking installation complete
- [ ] **Interactive config**: Prompt for API key/authentication if needed
- [ ] **Config templates**: Multiple template options (e.g., with/without auth, different MCP versions)

---

## 9. Documentation Strategy

### Documentation Files Created

| File | Purpose |
|------|---------|
| `README.md` | User-facing installation and usage guide |
| `PLUGIN_SETUP.md` | Post-installation setup and troubleshooting |
| `docs/USER_ISOLATION_PATTERN.md` | Technical reference for user/project isolation |
| `HYBRID_MIGRATION.md` | Roadmap for v2 hybrid architecture |
| `docs/DESIGN_CHOICES.md` | This file - design decisions and future work |
| `TESTING_RESULTS.md` | Test results and validation checklist |

### Design Choice: Distributed Documentation

Rather than centralizing all documentation, we distribute it:
- **Installation**: README.md
- **Setup details**: PLUGIN_SETUP.md  
- **Architecture**: HYBRID_MIGRATION.md
- **Isolation**: USER_ISOLATION_PATTERN.md
- **Design**: DESIGN_CHOICES.md (this file)

### Rationale

**Context-Appropriate**: Users find information where they need it (README for installation, PLUGIN_SETUP for post-install, etc.).

**Maintenance**: Each document has a clear purpose and ownership.

**Discovery**: Distributed docs encourage reading relevant sections based on user role.

### Future Improvements

- [ ] **Central index**: Create documentation index/sitemap
- [ ] **API documentation**: Generate from code comments using tools like JSDoc
- [ ] **Video tutorials**: Complement text docs with short installation/usage videos
- [ ] **Interactive docs**: Web-based documentation with copy-to-clipboard buttons
- [ ] **Multilingual support**: Translate key docs to other languages

---

## 10. Release & Version Management

### Current Approach (v1)

**Release Process**:
1. Merge feature branch to `main`
2. Create and push a Git tag (e.g., `v1.0.0` or `v1.1.0-rc.1` for release candidates)
3. Publish a GitHub Release targeting the tag (mark release candidates as "Pre-release")
4. The installer on `main/install.sh` automatically resolves the new stable release without requiring code changes or circular commits

### Rationale

**Zero Circular Dependencies**: Eliminates the chicken-and-egg commit cycle where the installer needed hardcoded commit SHAs or version strings before the release commit existed.

**Pre-release Isolation**: Releases marked as "Pre-release" on GitHub are automatically ignored by `/releases/latest`, ensuring only tested stable builds reach general users by default.

**Direct RC Testing**: Testers and developers can test pre-releases by passing `ART_BUNDLE_PLUGIN_VERSION=v1.1.0-rc.1` without disrupting stable users.

### Future Improvements (v2+)

- [ ] **Automated releases**: GitHub Actions to automate release process
- [ ] **Semantic versioning**: Adopt semver (v1.0.0, v1.1.0, etc.)
- [ ] **Changelog generation**: Automatically generate from commit messages
- [ ] **Release artifacts**: Create distribution artifacts (zip, tarball) in addition to GitHub releases
- [ ] **Update notifications**: Notify users when new versions are available

---

## 11. Architecture: Separate Repository (MVP) vs Hybrid (v2)

### Current Decision (v1): Separate Repository

ART Bundle Plugin is a separate GitHub repository from ART_MCP.

**Advantages**:
- Users see clean distribution (no dev artifacts)
- Independent release cycle
- Cleaner for end-user-focused projects

**Disadvantages**:
- Source of truth is split (ART_writing_agent → art-bundle-plugin)
- Manual sync needed for skill/agent updates
- Can get out of sync over time

### Future Decision (v2): Hybrid Approach

See `HYBRID_MIGRATION.md` for detailed plan to move to hybrid approach:
- Source lives in `ART_MCP/art-bundle-plugin/`
- Automated build script creates distribution repository
- GitHub Actions handles packaging and release

**Advantages**:
- Single source of truth
- Automated sync between source and distribution
- Easier to test changes before release

**Timeline**: 1-2 months after v1 stabilizes

### Implications for This Document

When v2 hybrid approach is implemented:
- Update this document with new architecture decisions
- Archive v1-specific notes in a "v1 Archive" section
- Create new sections for v2-specific choices

---

## 12. Future Work & Improvement Opportunities

### High Priority

1. **Automated releases** (v2 roadmap)
   - GitHub Actions workflow to tag and publish releases
   - Automated changelog generation
   - Status: Documented in HYBRID_MIGRATION.md

2. **Version tracking**
   - Store installed version in `.opencode/`
   - Enable smart upgrades that preserve config
   - Status: Design needed

3. **Upgrade support**
   - Detect existing installation and offer upgrade
   - Backup existing config before upgrade
   - Status: Design needed

### Medium Priority

1. **Configuration validation**
   - Schema validation for opencode.json(c)
   - Early error detection
   - Status: Design needed

2. **Verbose/quiet modes**
   - `--verbose` flag for debugging
   - `--quiet` flag for CI/CD integration
   - Status: Design needed

3. **Interactive setup**
   - First-run wizard for user email/project slug
   - Save profiles for quick-switch
   - Status: Design needed

### Lower Priority

1. **YAML configuration support**
   - More readable than JSON
   - Wider adoption than JSONC
   - Status: Consider for v2+

2. **Documentation improvements**
   - Central index/sitemap
   - Video tutorials
   - Multilingual support
   - Status: Post-v1

3. **Performance optimization**
   - Cache cloned repos
   - Incremental updates instead of full copy
   - Status: Only if needed

---

## Conclusion

The ART Bundle Plugin v1 MVP makes pragmatic design choices that prioritize:
1. **Security** (commit SHA pinning for supply chain safety)
2. **Simplicity** (one-command installation)
3. **Isolation** (project-level only)
4. **Safety** (idempotent, clear error handling)

These choices establish a solid foundation for future improvements documented in this file.

---

**Next Steps for Future Developers**:
1. Read this file before making architectural changes
2. Update this file when implementing improvements
3. Reference this file in PRs that change design decisions
4. Use "Future Improvements" sections as inspiration for v2+ planning

---

*Last Updated: July 29, 2026*  
*Document Owner: Development Team*  
*Version: 1.0*
