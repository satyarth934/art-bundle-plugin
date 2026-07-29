# Hybrid Migration Roadmap (v2)

**Plan for transitioning from separate repository (v1) to hybrid approach (v2)**

---

## Overview

**Current State (v1 - MVP)**:
- Separate repository: `art-bundle-plugin`
- Manual distribution and updates
- Users clone and run `install.sh`

**Target State (v2 - Future)**:
- Hybrid source: `ART_MCP/art-bundle-plugin/` subdir
- Automated distribution via GitHub Actions
- Users get updates automatically
- **Zero impact on user experience**

---

## Timeline

**When**: 1-2 months after v1 MVP ships (when stable)  
**Why Wait**: Allows v1 to stabilize, gather feedback, identify issues  
**Effort**: 2-3 hours implementation  

---

## Migration Plan

### Phase 1: Prepare Build Infrastructure (1 hour)

**Location**: In `ART_MCP/` repository

**Tasks**:

1. **Create source directory structure**
   ```bash
   mkdir -p ART_MCP/art-bundle-plugin/
   # Copy v1 files here (skills, agents, install.sh, docs)
   ```

2. **Create build distribution script**: `ART_MCP/scripts/build-distribution.sh`
   ```bash
   #!/bin/bash
   # Purpose: Package art-bundle-plugin for distribution
   # Input: Source files from ART_MCP/art-bundle-plugin/
   # Output: Deployable artifact
   
   set -e
   
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   REPO_ROOT="$(dirname "$SCRIPT_DIR")"
   
   # Source directory (in ART_MCP)
   SOURCE_DIR="$REPO_ROOT/art-bundle-plugin"
   
   # Build directory (temporary)
   BUILD_DIR="/tmp/art-bundle-plugin-build"
   
   # Distribution repo (separate)
   DIST_REPO="$HOME/repos/art-bundle-plugin-distribution"
   
   echo "Building distribution artifact..."
   
   # Clean and create build directory
   rm -rf "$BUILD_DIR"
   mkdir -p "$BUILD_DIR"
   
   # Copy source files
   cp -r "$SOURCE_DIR/.opencode" "$BUILD_DIR/"
   cp "$SOURCE_DIR/install.sh" "$BUILD_DIR/"
   cp "$SOURCE_DIR/README.md" "$BUILD_DIR/"
   cp "$SOURCE_DIR/PLUGIN_SETUP.md" "$BUILD_DIR/"
   cp "$SOURCE_DIR/HYBRID_MIGRATION.md" "$BUILD_DIR/"
   cp "$SOURCE_DIR/opencode-mcp-config.jsonc" "$BUILD_DIR/"
   cp "$SOURCE_DIR/.gitignore" "$BUILD_DIR/"
   cp "$SOURCE_DIR/LICENSE" "$BUILD_DIR/"
   
   # Optional: Strip unnecessary files
   find "$BUILD_DIR" -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
   find "$BUILD_DIR" -name "*.pyc" -delete
   
   echo "✅ Build complete: $BUILD_DIR"
   ```

3. **Create GitHub Actions workflow**: `.github/workflows/build-distribution.yml`
   ```yaml
   name: Build and Release Art-Bundle-Plugin Distribution
   
   on:
     push:
       branches:
         - main
       paths:
         - 'art-bundle-plugin/**'
         - '.github/workflows/build-distribution.yml'
   
   jobs:
     build-and-release:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3
         
         - name: Build distribution
           run: bash scripts/build-distribution.sh
         
         - name: Push to distribution repo
           env:
             DIST_REPO_TOKEN: ${{ secrets.DIST_REPO_TOKEN }}
           run: |
             # Clone distribution repo
             git clone https://x-access-token:$DIST_REPO_TOKEN@github.com/JBEI/art-bundle-plugin.git dist
             
             # Copy built files
             cp -r /tmp/art-bundle-plugin-build/* dist/
             
             # Commit and push
             cd dist
             git config user.name "GitHub Actions"
             git config user.email "actions@github.com"
             git add -A
             git commit -m "chore: Auto-generated distribution from ART_MCP $(date +%Y-%m-%d)"
             git push origin main
   ```

### Phase 2: Update Installation (30 minutes)

**Location**: In both `ART_MCP/` and `art-bundle-plugin/` distribution repo

**Tasks**:

1. **Update install.sh** to handle both source modes:
   ```bash
   # If running from ART_MCP (hybrid, v2)
   if [ -d "../.git" ] && [ -f "scripts/build-distribution.sh" ]; then
       PLUGIN_DIR="../art-bundle-plugin"
   # If running from distribution repo (v1)
   else
       PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   fi
   ```

2. **Add version detection**:
   ```bash
   # Detect version
   if [ -f "HYBRID_MIGRATION.md" ]; then
       VERSION="v2-hybrid"
   else
       VERSION="v1-separate"
   fi
   ```

### Phase 3: Documentation (30 minutes)

**Tasks**:

1. **Update README.md** in distribution repo:
   - Note about automatic updates
   - Link to source in ART_MCP

2. **Update HYBRID_MIGRATION.md**:
   - Mark as "completed"
   - Document how to verify you're on v2

3. **Create migration guide for users** (if applicable):
   - How to update from v1 to v2
   - Benefits of automatic updates
   - Assurance: no breaking changes

### Phase 4: Testing (30 minutes)

**Tasks**:

1. **Test build script**:
   ```bash
   bash ART_MCP/scripts/build-distribution.sh
   # Verify artifact contains expected files
   ```

2. **Test GitHub Actions workflow** (on test branch):
   - Trigger workflow
   - Verify distribution repo is updated

3. **Test end-user experience**:
   - Clone distribution repo
   - Run install.sh
   - Verify installation works

---

## Architecture Comparison

### v1 (Current - Separate Repository)

```
GitHub:
  - JBEI/art-bundle-plugin (distribution repo)
    ├── .opencode/
    ├── install.sh
    ├── README.md
    └── docs/

Maintenance:
  - Manual sync between ART_writing_agent and art-bundle-plugin
  - Manual push to distribution repo
  - User clones from JBEI/art-bundle-plugin
```

### v2 (Future - Hybrid)

```
GitHub:
  - JBEI/ART_MCP (source)
    ├── art-bundle-plugin/        ← Source files move here
    │   ├── .opencode/
    │   ├── install.sh
    │   └── docs/
    └── scripts/
        └── build-distribution.sh

  - JBEI/art-bundle-plugin (distribution)
    ├── Auto-generated from build script
    ├── Triggers on ART_MCP changes
    └── Users still clone from here

Maintenance:
  - Single source of truth: ART_MCP/art-bundle-plugin/
  - Automatic distribution via GitHub Actions
  - Users still clone from distribution repo (same experience!)
```

---

## Benefits of v2

✅ **Single Source of Truth**
- All changes in ART_MCP
- Skills and agents develop with the tools they use

✅ **Automated Distribution**
- GitHub Actions builds on every commit
- No manual packaging steps
- Updates appear automatically

✅ **Better Testing**
- Test in ART_MCP context before distribution
- Integration testing easier
- Changes validated before release

✅ **Zero User Impact**
- install.sh works the same way
- Users clone from distribution repo as before
- No manual migration needed

✅ **Easier Maintenance**
- Two files to maintain (not separate repos)
- Changes tested immediately
- Clear build process

---

## Implementation Checklist

- [ ] Create `ART_MCP/art-bundle-plugin/` directory
- [ ] Move v1 files to `ART_MCP/art-bundle-plugin/`
- [ ] Create `ART_MCP/scripts/build-distribution.sh`
- [ ] Create `.github/workflows/build-distribution.yml`
- [ ] Test build script locally
- [ ] Set up `DIST_REPO_TOKEN` secret in GitHub
- [ ] Test workflow on test branch
- [ ] Update install.sh for dual-mode operation
- [ ] Update documentation
- [ ] Announce migration (no user action needed)
- [ ] Monitor first automated release
- [ ] Gather feedback

---

## Rollback Plan

If v2 causes issues:

1. **Revert to v1**:
   ```bash
   # Keep separate art-bundle-plugin repo active
   # Disable GitHub Actions workflow
   # Continue manual updates to distribution repo
   ```

2. **Partial rollback**:
   ```bash
   # Keep hybrid in ART_MCP
   # Revert workflow to manual testing
   # User experience unchanged
   ```

---

## Future Enhancements (Beyond v2)

### v3 (Possible)
- Automated semantic versioning
- Release notes generation
- Changelog automation
- Docker image distribution

### Community Contributions
- Open sourcing process documented
- Contribution guidelines
- Pull request templates
- Code review workflow

---

## Questions & Decisions

### Should distribution repo be public?
**Current**: Yes, users clone from there  
**v2 Status**: Remains public, content auto-generated

### Should we version the distribution?
**Current**: Implicit (git commits)  
**v2 Option**: Add semantic versioning (`v1.0.0`, `v1.1.0`, etc.)

### How to notify users of updates?
**Options**:
1. GitHub releases (auto-generated)
2. Email notification (requires subscription)
3. In-app notification (requires v2 in OpenCode)
4. Documentation (simple, no infrastructure)

**Recommendation**: GitHub releases + documentation update

---

## References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Semantic Versioning](https://semver.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)

---

## Status

**v1 (MVP)**: ✅ Shipped (July 2026)  
**v2 (Hybrid)**: 📋 Planned (1-2 months after v1)  
**v3+**: 🔮 Future consideration  

---

*This roadmap is a living document. Update as needed.*
