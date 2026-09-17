#!/bin/bash

set -eo pipefail

# ============================================================================
# ART Bundle Plugin Installation Script
# ============================================================================
# This script installs the ART Bundle Plugin into your OpenCode environment.
#
# Usage:
#   Option 1: Direct execution (if you have cloned the repo)
#     ./install.sh
#
#   Option 2: Local development source override
#     ART_BUNDLE_PLUGIN_DIR=/path/to/art-bundle-plugin ./install.sh
#     (Useful for testing uncommitted local changes.)
#
#   Option 3: One-command installation via curl (recommended)
#     curl -fsSL https://raw.githubusercontent.com/satyarth934/art-bundle-plugin/main/install.sh | bash
#
#   Option 4: Install specific version or pre-release candidate
#     curl -fsSL https://raw.githubusercontent.com/satyarth934/art-bundle-plugin/main/install.sh | ART_BUNDLE_PLUGIN_VERSION=v1.1.0-rc.1 bash
#     # or via CLI argument:
#     curl -fsSL https://raw.githubusercontent.com/satyarth934/art-bundle-plugin/main/install.sh | bash -s -- --version v1.1.0-rc.1
#
# Requirements:
#   - OpenCode must be installed
#   - Local .opencode/ directory (script will create if missing)
#   - curl and tar commands available
#
# What this script does:
#   1. Resolves target version & downloads plugin files
#   2. Creates .opencode/ directory (if missing)
#   3. Detects if already installed (prevents duplicate installs)
#   4. Copies skills, agents, and plugins to your installation
#   5. Merges MCP configuration into opencode.json(c)
#   6. Configures environment / path guards
#   7. Displays next steps
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions (Logging)
# ============================================================================

log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# ============================================================================
# Configuration & Constants
# ============================================================================

REPO_OWNER="satyarth934"
REPO_NAME="art-bundle-plugin"
REPO="${REPO_OWNER}/${REPO_NAME}"
REPO_URL="https://github.com/${REPO}"
ART_MCP_URL="https://art-mcp-1005318772721.us-west1.run.app/mcp"

# ============================================================================
# Argument Parsing & Environment Detection
# ============================================================================

parse_arguments() {
    REQUESTED_VERSION="${ART_BUNDLE_PLUGIN_VERSION:-}"
    while [ $# -gt 0 ]; do
        case "$1" in
            -v|--version)
                if [ -n "${2:-}" ]; then
                    REQUESTED_VERSION="$2"
                    shift 2
                else
                    log_error "Error: --version requires a version argument"
                    exit 1
                fi
                ;;
            *)
                if [ -z "$REQUESTED_VERSION" ]; then
                    REQUESTED_VERSION="$1"
                fi
                shift
                ;;
        esac
    done
}

detect_plugin_source() {
    if [ -n "${ART_BUNDLE_PLUGIN_DIR:-}" ]; then
        if [ ! -d "$ART_BUNDLE_PLUGIN_DIR" ]; then
            log_error "ART_BUNDLE_PLUGIN_DIR is not a directory: $ART_BUNDLE_PLUGIN_DIR"
            exit 1
        fi

        PLUGIN_DIR="$(cd "$ART_BUNDLE_PLUGIN_DIR" && pwd)"
        if [ ! -d "$PLUGIN_DIR/.opencode/skills" ] \
            || [ ! -d "$PLUGIN_DIR/.opencode/agents" ] \
            || [ ! -f "$PLUGIN_DIR/opencode-mcp-config.jsonc" ]; then
            log_error "ART_BUNDLE_PLUGIN_DIR does not appear to be a valid ART Bundle Plugin repository: $PLUGIN_DIR"
            log_error "Expected .opencode/skills, .opencode/agents, and opencode-mcp-config.jsonc"
            exit 1
        fi

        log_info "Using local plugin source: $PLUGIN_DIR"
        REPO_CLONED=true
    elif [ -f "install.sh" ] && [ -d ".opencode" ]; then
        # Running from extracted/cloned repository
        PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
        REPO_CLONED=true
    else
        # Being piped via curl - will be set to a temporary directory in ensure_repository_available
        PLUGIN_DIR=""
        REPO_CLONED=false
    fi
}

# ============================================================================
# Version Resolution & Repository Setup
# ============================================================================

resolve_target_version() {
    if [ -n "$REQUESTED_VERSION" ]; then
        TARGET_VERSION="$REQUESTED_VERSION"
        log_info "Target version explicitly specified: $TARGET_VERSION"
        return 0
    fi

    log_info "Resolving latest stable release..."

    # Method 1: Follow HTTP redirect for /releases/latest (skips pre-releases/RCs, avoids API rate limits)
    local latest_url
    latest_url=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "${REPO_URL}/releases/latest" 2>/dev/null || true)
    TARGET_VERSION="${latest_url##*/}"

    # Method 2: Fallback to GitHub tags API if no formal Release exists yet
    if [ -z "$TARGET_VERSION" ] || [ "$TARGET_VERSION" = "latest" ]; then
        TARGET_VERSION=$(curl -sL "https://api.github.com/repos/${REPO}/tags" 2>/dev/null \
            | grep '"name":' \
            | sed -E 's/.*"([^"]+)".*/\1/' \
            | grep -vE '-(rc|alpha|beta|dev)' \
            | sort -V \
            | tail -n 1 || true)
    fi

    # Method 3: Fallback to 'main' branch if repository has no release tags yet
    if [ -z "$TARGET_VERSION" ] || [ "$TARGET_VERSION" = "null" ]; then
        TARGET_VERSION="main"
        log_warning "Could not detect release tag. Defaulting to branch: ${TARGET_VERSION}"
    else
        log_success "Resolved latest stable version: ${TARGET_VERSION}"
    fi
}

ensure_repository_available() {
    log_info "Step 0/6: Ensuring plugin files are available..."
    
    # Exiting the function if the repository is already cloned / local
    if [ "$REPO_CLONED" = true ]; then
        log_success "Running from local plugin directory: $PLUGIN_DIR"
        return 0
    fi
    
    resolve_target_version

    # Being piped via curl - download archive to a temporary directory
    TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'art-bundle-plugin')
    trap 'rm -rf "${TMP_DIR}"' EXIT
    PLUGIN_DIR="${TMP_DIR}"

    log_info "Downloading ${REPO} (${TARGET_VERSION})..."

    # Download and extract archive (works for tags, branches, and commit SHAs)
    local tarball_url="${REPO_URL}/archive/${TARGET_VERSION}.tar.gz"
    if ! curl -sLf "${tarball_url}" | tar -xz -C "${TMP_DIR}" --strip-components=1 2>/dev/null; then
        log_error "Failed to download version '${TARGET_VERSION}' from ${REPO_URL}"
        log_info "Please verify the version, tag, or branch name exists."
        exit 1
    fi
    
    log_success "Plugin files ready (${TARGET_VERSION})"
}

# ============================================================================
# Idempotency Check (prevent duplicate installations)
# ============================================================================

check_already_installed() {
    FRESH_INSTALL=true

    # Dynamically check if any skills from plugin repo are already installed
    # Scan the plugin repo's skills directory
    if [ -d ".opencode/skills" ]; then
        for skill_dir in ".opencode/skills"/*; do
            if [ -d "$skill_dir" ]; then
                skill_name=$(basename "$skill_dir")
                if [ -f "$skill_dir/SKILL.md" ]; then
                    log_warning "Skill already exists: $skill_name"
                    FRESH_INSTALL=false
                fi
            fi
        done
    fi

    # Dynamically check if any agents from plugin repo are already installed
    # Scan the plugin repo's agents directory
    if [ -d ".opencode/agents" ]; then
        for agent_file in ".opencode/agents"/*.md; do
            if [ -f "$agent_file" ]; then
                agent_name=$(basename "$agent_file" .md)
                log_warning "Agent already exists: $agent_name"
                FRESH_INSTALL=false
            fi
        done
    fi

    if ! $FRESH_INSTALL; then
        echo ""
        echo "This project already appears to have the ART Bundle Plugin installed."
        echo "Skipping installation to prevent overwriting existing configuration."
        echo ""
        echo "To reinstall the plugin, delete the existing files using the following commands "
        echo "(this only deletes the skills and agents corresponding to this plugin,"
        echo "preserving your other .opencode configurations):"
        echo ""
        if [ -d ".opencode/skills" ]; then
            for skill_dir in ".opencode/skills"/*; do
                echo "  rm -rf $skill_dir"
            done
        fi
        if [ -d ".opencode/agents" ]; then
            for agent_file in ".opencode/agents"/*.md; do
                echo "  rm -rf $agent_file"
            done
        fi
        echo ""
        exit 0
    fi
}

# ============================================================================
# Create Local OpenCode Directory
# ============================================================================

ensure_opencode_dir() {
    if [ ! -d ".opencode" ]; then
        log_info "Creating local .opencode directory..."
        mkdir -p ".opencode"
        log_success "Created .opencode directory"
    fi
}

# ============================================================================
# Detect OpenCode Configuration Location
# ============================================================================

detect_opencode_config() {
    log_info "Step 1/6: Confirming local .opencode directory..."
    
    # IMPORTANT: Only use LOCAL .opencode directory
    # We NEVER install globally to ~/.opencode (user home)
    # This ensures project-level isolation and cleanliness
    
    if [ -d ".opencode" ]; then
        OPENCODE_DIR=".opencode"
        log_success "Using local .opencode directory"
        return 0
    fi
    
    # This should not happen since ensure_opencode_dir() runs first
    # But if we get here, something is wrong
    log_error "Local .opencode directory missing"
    exit 1
}

# ============================================================================
# Detect Remote MCP and Set Environment Variable
# ============================================================================

detect_and_export_mcp_environment() {
    log_info "Step 4/6: Detecting MCP environment..."
    
    # Check if MCP configuration uses remote type
    OPENCODE_JSON="$OPENCODE_DIR/opencode.json"
    OPENCODE_JSONC="$OPENCODE_DIR/opencode.jsonc"
    
    # Determine which config file exists
    CONFIG_FILE=""
    if [ -f "$OPENCODE_JSONC" ]; then
        CONFIG_FILE="$OPENCODE_JSONC"
    elif [ -f "$OPENCODE_JSON" ]; then
        CONFIG_FILE="$OPENCODE_JSON"
    fi
    
    if [ -z "$CONFIG_FILE" ]; then
        log_warning "No OpenCode configuration found yet (will be created)"
        return 0
    fi
    
    # Check if remote MCP is configured
    if grep -q '"type".*:.*"remote"' "$CONFIG_FILE" 2>/dev/null; then
        # Remote MCP detected — export for this install session only.
        # At runtime, the plugin (plugins/index.ts) automatically detects
        # the deployment mode from config files — no shell profile setup needed.
        export ARTMCP_DEPLOYMENT_MODE="gcp_remote"
        log_success "Remote MCP detected - enabling container path guards"
        echo "   (ARTMCP_DEPLOYMENT_MODE=gcp_remote)"

        # Copy hook configuration files
        if [ -d "$PLUGIN_DIR/.opencode/config" ]; then
            mkdir -p "$OPENCODE_DIR/config"
            cp "$PLUGIN_DIR/.opencode/config"/*.yaml "$OPENCODE_DIR/config/" 2>/dev/null || true
            log_success "Container path configuration copied"
        fi
        
        # Copy hook files
        if [ -d "$PLUGIN_DIR/.opencode/hooks" ]; then
            mkdir -p "$OPENCODE_DIR/hooks"
            cp "$PLUGIN_DIR/.opencode/hooks"/*.ts "$OPENCODE_DIR/hooks/" 2>/dev/null || true
            log_success "Container path guard hooks installed"
        fi
    else
        log_success "Local MCP detected - container path guards disabled"
    fi
}

# ============================================================================
# Copy Skills, Agents, and Plugins
# ============================================================================

copy_files() {
    log_info "Step 2/6: Copying skills, agents, and plugins..."
    
    # Create target directories if they don't exist
    mkdir -p "$OPENCODE_DIR/skills"
    mkdir -p "$OPENCODE_DIR/agents"
    mkdir -p "$OPENCODE_DIR/plugins"
    
    # Dynamically copy ALL skills from plugin repo
    if [ -d "$PLUGIN_DIR/.opencode/skills" ]; then
        skill_count=0
        for skill_dir in "$PLUGIN_DIR/.opencode/skills"/*; do
            if [ -d "$skill_dir" ]; then
                skill_name=$(basename "$skill_dir")
                cp -r "$skill_dir" "$OPENCODE_DIR/skills/"
                log_success "Copied skill: $skill_name"
                skill_count=$((skill_count + 1))
            fi
        done
        if [ $skill_count -eq 0 ]; then
            log_error "No skills found in plugin"
            exit 1
        fi
    else
        log_error "skills directory not found in plugin"
        exit 1
    fi
    
    # Dynamically copy ALL agents from plugin repo
    if [ -d "$PLUGIN_DIR/.opencode/agents" ]; then
        agent_count=0
        for agent_file in "$PLUGIN_DIR/.opencode/agents"/*.md; do
            if [ -f "$agent_file" ]; then
                agent_name=$(basename "$agent_file")
                cp "$agent_file" "$OPENCODE_DIR/agents/"
                log_success "Copied agent: $agent_name"
                agent_count=$((agent_count + 1))
            fi
        done
        if [ $agent_count -eq 0 ]; then
            log_error "No agents found in plugin"
            exit 1
        fi
    else
        log_error "agents directory not found in plugin"
        exit 1
    fi
    
    # Copy plugins (ART MCP deployment mode detector, etc.)
    if [ -d "$PLUGIN_DIR/.opencode/plugins" ]; then
        plugin_count=0
        for plugin_file in "$PLUGIN_DIR/.opencode/plugins"/*.ts; do
            if [ -f "$plugin_file" ]; then
                plugin_name=$(basename "$plugin_file")
                cp "$plugin_file" "$OPENCODE_DIR/plugins/"
                log_success "Copied plugin: $plugin_name"
                plugin_count=$((plugin_count + 1))
            fi
        done
        if [ $plugin_count -eq 0 ]; then
            log_warning "No plugins found in plugin directory (this is optional)"
        fi
    else
        log_warning "plugins directory not found in plugin (optional feature)"
    fi
}

# ============================================================================
# Merge MCP Configuration
# ============================================================================

merge_mcp_config() {
    log_info "Step 3/6: Merging MCP configuration..."
    
    OPENCODE_JSON="$OPENCODE_DIR/opencode.json"
    OPENCODE_JSONC="$OPENCODE_DIR/opencode.jsonc"
    
    # Check if this is a new installation (no existing config)
    IS_NEW_CONFIG=false
    if [ ! -f "$OPENCODE_JSONC" ] && [ ! -f "$OPENCODE_JSON" ]; then
        IS_NEW_CONFIG=true
    fi
    
    # Determine which config file to use (prefer JSONC over JSON)
    if [ -f "$OPENCODE_JSONC" ]; then
        CONFIG_FILE="$OPENCODE_JSONC"
    elif [ -f "$OPENCODE_JSON" ]; then
        CONFIG_FILE="$OPENCODE_JSON"
    else
        # New configuration - default to JSONC (supports comments)
        CONFIG_FILE="$OPENCODE_JSONC"
    fi
    
    # Check if node is available for JSON manipulation
    if ! command -v node &> /dev/null; then
        log_warning "Node.js not found, skipping automatic MCP configuration merge"
        log_info "Please manually add the following to your $CONFIG_FILE:"
        echo ""
        cat "$PLUGIN_DIR/opencode-mcp-config.jsonc"
        echo ""
        return 0
    fi
    
    # Use Node.js to merge configuration
    node << EOF
const fs = require('fs');
const configFile = '$CONFIG_FILE';
const templatePath = '$PLUGIN_DIR/opencode-mcp-config.jsonc';
const isNewConfig = $([[ "$IS_NEW_CONFIG" == "true" ]] && echo true || echo false);

// Strip JSONC comments and trailing commas, protecting string values (e.g. URLs)
function stripJsoncComments(jsonc) {
    const noComments = jsonc.replace(
        /\\\\"|"(?:\\\\"|[^"])*"|(\/\/.*|\/\*[\\s\\S]*?\\*\/)/g,
        (match, group1) => group1 ? "" : match
    );
    return noComments.replace(/,\\s*([\\]}])/g, "\$1");
}

try {
    // Read existing config
    let config = {};
    
    if (!isNewConfig) {
        const content = fs.readFileSync(configFile, 'utf8');
        config = JSON.parse(stripJsoncComments(content));
    }
    
    // Add schema only if creating new config
    if (isNewConfig) {
        config['\$schema'] = 'https://opencode.ai/config.json';
    }
    
    // Read MCP config template from plugin repo
    let templateContent;
    try {
        templateContent = fs.readFileSync(templatePath, 'utf8');
    } catch (error) {
        throw new Error(\`MCP template not found at \${templatePath}. This file should be included in the art-bundle-plugin repository.\`);
    }
    
    let templateConfig;
    try {
        templateConfig = JSON.parse(stripJsoncComments(templateContent));
        
    } catch (error) {
        throw new Error(\`MCP template at \${templatePath} contains invalid JSON: \${error.message}\`);
    }
    
    // Merge MCP configs: template defaults first, then user's existing config (preserves user's settings)
    if (templateConfig.mcp) {
        config.mcp = {
            ...templateConfig.mcp,           // Load template defaults first
            ...(config.mcp || {})            // Apply existing config second (preserves existing keys)
        };
    }
    
    // Write updated config
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    console.log('✅ MCP configuration merged successfully');
} catch (error) {
    console.error('Error merging configuration:', error.message);
    process.exit(1);
}
EOF
    
    if [ $? -eq 0 ]; then
        log_success "MCP configuration merged"
    else
        log_error "Failed to merge MCP configuration"
        exit 1
    fi
}

# ============================================================================
# Display Success Message
# ============================================================================

show_success_message() {
    log_info "Step 6/6: Installation complete!"
    
    echo ""
    echo "======================================================================"
    echo ""
    echo -e "${GREEN}✅ ART Bundle Plugin Installed Successfully!${NC}"
    echo ""
    echo "What was installed:"
    echo "  • Media-optimization skill (with templates)"
    echo "  • 5 specialized agents (art-specialist, liquid-handler-specialist, etc.)"
    echo "  • MCP integration configuration"
    
    # Show container path guard info if remote MCP
    if [ "$ARTMCP_DEPLOYMENT_MODE" = "gcp_remote" ]; then
        echo "  • Container path guard hooks (for remote GCP MCP)"
        echo "    - Automatically intercepts /app/ and /shared/ paths"
        echo "    - Redirects to MCP tools with helpful guidance"
    fi
    
    echo ""
    echo "MCP Server Configuration:"
    echo "  URL: $ART_MCP_URL"
    echo "  Config File: $CONFIG_FILE"
    
    if [ "$ARTMCP_DEPLOYMENT_MODE" = "gcp_remote" ]; then
        echo "  Environment: Remote (GCP)"
    else
        echo "  Environment: Local"
    fi
    
    echo ""
    echo "Next Steps:"
    echo ""
    echo "1. ⚠️  REQUIRED: Set MCP Authentication"
    echo "   You must set the ARTMCP_AUTH_API_KEY environment variable:"
    echo ""
    echo "   export ARTMCP_AUTH_API_KEY=\"your-api-key-from-admin\""
    echo ""
    echo "   This key is required to communicate with the ART-MCP Cloud Run service."
    echo "   Contact your system administrator if you don't have it."
    echo ""
    
    if [ "$ARTMCP_DEPLOYMENT_MODE" = "gcp_remote" ]; then
        echo "2. ✅ Container Path Guards are Automatically Enabled"
        echo "   The plugin detects remote MCP from your config at startup — no manual"
        echo "   environment variable setup needed. The following paths will be intercepted:"
        echo "     • /app/* - GCP container application code"
        echo "     • /shared/* - GCP bucket mount paths"
        echo ""
        echo "   When you try to access these paths locally, OpenCode will:"
        echo "     • Block the local tool call"
        echo "     • Suggest the appropriate MCP tool (execute_code, etc.)"
        echo "     • Log the interception for debugging"
        echo ""
        echo "   To customize container paths, edit:"
        echo "     .opencode/config/remote-container-paths.yaml"
        echo ""
        echo "3. Start Using the Plugin:"
    else
        echo "2. Start Using the Plugin:"
    fi
    
    echo "   Run OpenCode and select the media-optimization skill"
    echo "   You'll be prompted to provide:"
    echo "     • Your email (user@lab.edu)"
    echo "     • Project slug (experiment_name_v1)"
    echo ""
    echo "4. Documentation:"
    echo "   See PLUGIN_SETUP.md for post-installation guide"
    echo "   See README.md for quick start examples"
    
    if [ "$ARTMCP_DEPLOYMENT_MODE" = "gcp_remote" ]; then
        echo "   See docs/CONTAINER_PATH_INTERCEPTION.md for guard configuration"
    fi
    
    echo ""
    echo "======================================================================"
    echo ""
}

# ============================================================================
# Main Installation Flow
# ============================================================================

main() {
    echo ""
    echo "======================================================================"
    echo "ART Bundle Plugin - Installation Script"
    echo "======================================================================"
    echo ""
    
    # Parse CLI arguments and environment variables
    parse_arguments "$@"

    # Detect execution environment (local checkout vs curl piping)
    detect_plugin_source

    # Step 0: Ensure repository is available (handles curl piping)
    ensure_repository_available
    
    # Step 1: Create .opencode directory if needed
    ensure_opencode_dir
    
    # Check if already installed (idempotency)
    check_already_installed
    
    # Step 2: Detect OpenCode config location
    detect_opencode_config
    
    # Step 3: Copy files (skills, agents, plugins)
    copy_files
    
    # Step 4: Merge MCP config
    merge_mcp_config
    
    # Step 5: Detect remote MCP and set environment
    detect_and_export_mcp_environment
    
    # Step 6: Show success message
    show_success_message
}

# Run main installation
main "$@"
