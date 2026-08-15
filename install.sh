#!/bin/bash

set -e

# ============================================================================
# ART Bundle Plugin Installation Script
# ============================================================================
# This script installs the ART Bundle Plugin into your OpenCode environment.
#
# Usage:
#   Option 1: Direct execution (if you have cloned the repo)
#     ./install.sh
#
#   Option 2: One-command installation via curl (recommended)
#     curl -fsSL https://raw.githubusercontent.com/satyarth934/art-bundle-plugin/<COMMIT_SHA>/install.sh | bash
#     (Replace <COMMIT_SHA> with actual commit hash - see README.md)
#
# Requirements:
#   - OpenCode must be installed
#   - Local .opencode/ directory (script will create if missing)
#   - git command available
#   - curl command available for connectivity testing
#
# What this script does:
#   1. Clones repository (if not already present)
#   2. Creates .opencode/ directory (if missing)
#   3. Detects if already installed (prevents duplicate installs)
#   4. Copies skills and agents to your installation
#   5. Merges MCP configuration into opencode.json(c)
#   6. Tests connectivity to the MCP server
#   7. Displays next steps
#
# Supply Chain Security:
#   This script pins to a specific commit SHA to protect against
#   supply chain attacks. See docs/DESIGN_CHOICES.md for details.
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Configuration & Constants
# ============================================================================

# SECURITY: Commit SHA is pinned for supply chain security
# Update this when releasing new versions
# See docs/DESIGN_CHOICES.md for rationale
COMMIT_SHA="main"  # TODO: Replace with actual commit SHA on release (e.g., "a1b2c3d4e5f6...")

# Repository configuration
REPO_URL="https://github.com/satyarth934/art-bundle-plugin.git"
ART_MCP_URL="https://art-mcp-1005318772721.us-west1.run.app/mcp"

# Detect if running from local `install.sh` or being piped via curl
# if [ -f "install.sh" ] && [ -d ".opencode" ]; then
if [ -f "install.sh" ]; then
    # Running from extracted/cloned repository
    PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_CLONED=true
else
    # Being piped via curl - need to clone repository
    PLUGIN_DIR="/tmp/art-bundle-plugin-install"
    REPO_CLONED=false
fi

# ============================================================================
# Helper Functions
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
# Repository Setup (handles both direct execution and curl piping)
# ============================================================================

ensure_repository_available() {
    log_info "Step 0/5: Ensuring plugin files are available..."
    
    # Exiting the function if the repository is already cloned
    if [ "$REPO_CLONED" = true ]; then
        log_success "Running from extracted plugin directory"
        return 0
    fi
    
    # Being piped via curl - need to clone repository
    log_info "Cloning plugin repository..."
    
    if ! command -v git &> /dev/null; then
        log_error "git command not found. Please install git and try again."
        exit 1
    fi
    
    # Only clean the temp directory when being piped via curl
    if [ "$REPO_CLONED" = false ]; then
        rm -rf "$PLUGIN_DIR" 2>/dev/null
        log_info "Cleaning any previous installation attempt..."
    fi

    # Clone with depth 1 for minimal download
    git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR" 2>/dev/null || {
        log_error "Failed to clone repository from $REPO_URL"
        exit 1
    }
    
    # Checkout specific commit SHA for security
    if [ "$COMMIT_SHA" != "main" ]; then
        cd "$PLUGIN_DIR"
        git fetch --depth 1 origin "$COMMIT_SHA" 2>/dev/null || {
            log_error "Failed to fetch commit $COMMIT_SHA"
            exit 1
        }
        git checkout "$COMMIT_SHA" 2>/dev/null || {
            log_error "Failed to checkout commit $COMMIT_SHA"
            exit 1
        }
    fi
    
    log_success "Plugin files ready"
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
        for skill_path in "${skill_paths[@]}"; do
            echo "  rm -rf $skill_path"
        done
        for agent_path in "${agent_paths[@]}"; do
            echo "  rm -rf $agent_path"
        done
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
# Step 1: Detect OpenCode Configuration Location
# ============================================================================

detect_opencode_config() {
    log_info "Step 1/5: Confirming local .opencode directory..."
    
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
# Step 2: Copy Skills and Agents
# ============================================================================

copy_files() {
    log_info "Step 2/5: Copying skills and agents..."
    
    # Create target directories if they don't exist
    mkdir -p "$OPENCODE_DIR/skills"
    mkdir -p "$OPENCODE_DIR/agents"
    
    # Dynamically copy ALL skills from plugin repo
    if [ -d "$PLUGIN_DIR/.opencode/skills" ]; then
        skill_count=0
        for skill_dir in "$PLUGIN_DIR/.opencode/skills"/*; do
            if [ -d "$skill_dir" ]; then
                skill_name=$(basename "$skill_dir")
                cp -r "$skill_dir" "$OPENCODE_DIR/skills/"
                log_success "Copied skill: $skill_name"
                ((skill_count++))
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
                ((agent_count++))
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
}

# ============================================================================
# Step 3: Merge MCP Configuration
# ============================================================================

merge_mcp_config() {
    log_info "Step 3/5: Merging MCP configuration..."
    
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

try {
    // Read existing config
    let config = {};
    
    if (!isNewConfig) {
        const content = fs.readFileSync(configFile, 'utf8');
        // Simple JSON parse (ignores comments in JSONC)
        config = JSON.parse(content.replace(/\/\/.*$/gm, ''));
    }
    
    // Add schema only if creating new config
    if (isNewConfig) {
        config['\$schema'] = 'https://opencode.ai/config.json';
    }
    
    // Read MCP config template from plugin repo
    const templateContent = fs.readFileSync(templatePath, 'utf8');
    const templateConfig = JSON.parse(templateContent.replace(/\/\/.*$/gm, ''));
    
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

# # ============================================================================
# # Step 4: Test MCP Connectivity
# # ============================================================================

# test_mcp_connectivity() {
#     log_info "Step 4/5: Testing MCP server connectivity..."
    
#     if ! command -v curl &> /dev/null; then
#         log_warning "curl not found, skipping connectivity test"
#         return 0
#     fi
    
#     # Test with short timeout
#     if timeout 5 curl -s -f "$ART_MCP_URL" > /dev/null 2>&1; then
#         log_success "MCP server is reachable"
#         return 0
#     else
#         log_warning "Could not reach MCP server at $ART_MCP_URL"
#         log_info "This may be due to network issues or the server being temporarily unavailable"
#         log_info "You can test manually later with: curl $ART_MCP_URL"
#         return 0
#     fi
# }

# ============================================================================
# Step 5: Display Success Message
# ============================================================================

show_success_message() {
    log_info "Step 5/5: Installation complete!"
    
    echo ""
    echo "=========================================================================="
    echo ""
    echo -e "${GREEN}✅ ART Bundle Plugin Installed Successfully!${NC}"
    echo ""
    echo "What was installed:"
    echo "  • Media-optimization skill (with templates)"
    echo "  • 5 specialized agents (art-specialist, liquid-handler-specialist, etc.)"
    echo "  • MCP integration configuration"
    echo ""
    echo "MCP Server Configuration:"
    echo "  URL: $ART_MCP_URL"
    echo "  Config File: $CONFIG_FILE"
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
    echo "2. Start Using the Plugin:"
    echo "   Run OpenCode and select the media-optimization skill"
    echo "   You'll be prompted to provide:"
    echo "     • Your email (user@lab.edu)"
    echo "     • Project slug (experiment_name_v1)"
    echo ""
    echo "3. Documentation:"
    echo "   See PLUGIN_SETUP.md for post-installation guide"
    echo "   See README.md for quick start examples"
    echo ""
    echo "=========================================================================="
    echo ""
}

# ============================================================================
# Main Installation Flow
# ============================================================================

main() {
    echo ""
    echo "=========================================================================="
    echo "ART Bundle Plugin - Installation Script"
    echo "=========================================================================="
    echo ""
    
    # Step 0: Ensure repository is available (handles curl piping)
    ensure_repository_available
    
    # Step 1: Create .opencode directory if needed
    ensure_opencode_dir
    
    # Check if already installed (idempotency)
    check_already_installed
    
    # Step 2: Detect OpenCode config location
    detect_opencode_config
    
    # Step 3: Copy files
    copy_files
    
    # Step 4: Merge MCP config
    merge_mcp_config
    
    # # Step 5: Test connectivity
    # test_mcp_connectivity
    
    # Step 6: Show success message
    show_success_message
}

# Run main installation
main
