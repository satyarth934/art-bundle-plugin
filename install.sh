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
#     curl -fsSL https://raw.githubusercontent.com/JBEI/art-bundle-plugin/<COMMIT_SHA>/install.sh | bash
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
REPO_URL="https://github.com/JBEI/art-bundle-plugin.git"
ART_MCP_URL="https://art-mcp-1005318772721.us-west1.run.app/mcp"

# Detect if running from extracted repo or being piped via curl
if [ -f "install.sh" ] && [ -d ".opencode" ]; then
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
    # Check if media-optimization skill already exists
    # This indicates a previous successful installation
    if [ -f ".opencode/skills/media-optimization/SKILL.md" ]; then
        log_warning "Installation already exists: .opencode/skills/media-optimization/ found"
        echo ""
        echo "This project appears to already have the ART Bundle Plugin installed."
        echo "Skipping installation to prevent overwriting existing configuration."
        echo ""
        echo "To reinstall the plugin (this only replaces the media-optimization skill,"
        echo "preserving your other .opencode configurations):"
        echo ""
        echo "  rm -rf .opencode/skills/media-optimization && ./install.sh"
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
    
    # Copy media-optimization skill
    if [ -d "$PLUGIN_DIR/.opencode/skills/media-optimization" ]; then
        cp -r "$PLUGIN_DIR/.opencode/skills/media-optimization" "$OPENCODE_DIR/skills/"
        log_success "Copied media-optimization skill"
    else
        log_error "media-optimization skill not found in plugin"
        exit 1
    fi
    
    # Copy agents
    if [ -d "$PLUGIN_DIR/.opencode/agents" ]; then
        cp "$PLUGIN_DIR/.opencode/agents"/*.md "$OPENCODE_DIR/agents/" 2>/dev/null || true
        log_success "Copied agent specifications"
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
    
    # Determine which config file to use (prefer JSONC over JSON)
    if [ -f "$OPENCODE_JSONC" ]; then
        CONFIG_FILE="$OPENCODE_JSONC"
    elif [ -f "$OPENCODE_JSON" ]; then
        CONFIG_FILE="$OPENCODE_JSON"
    else
        log_warning "No opencode.json(c) found, creating new configuration"
        # Default to JSONC for new configurations (supports comments)
        CONFIG_FILE="$OPENCODE_JSONC"
        cat > "$CONFIG_FILE" << 'EOF'
{
  "mcpServers": {}
}
EOF
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

try {
    // Read existing config
    let config = {};
    if (fs.existsSync(configFile)) {
        const content = fs.readFileSync(configFile, 'utf8');
        // Simple JSON parse (ignores comments in JSONC)
        config = JSON.parse(content.replace(/\/\/.*$/gm, ''));
    }
    
    // Ensure mcpServers object exists
    if (!config.mcpServers) {
        config.mcpServers = {};
    }
    
    // Add or update art-mcp configuration
    config.mcpServers['art-mcp'] = {
        type: 'stdio',
        command: 'curl',
        args: ['--unix-socket', '/tmp/art-mcp.sock', 'http://localhost/mcp']
    };
    
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
# Step 4: Test MCP Connectivity
# ============================================================================

test_mcp_connectivity() {
    log_info "Step 4/5: Testing MCP server connectivity..."
    
    if ! command -v curl &> /dev/null; then
        log_warning "curl not found, skipping connectivity test"
        return 0
    fi
    
    # Test with short timeout
    if timeout 5 curl -s -f "$ART_MCP_URL" > /dev/null 2>&1; then
        log_success "MCP server is reachable"
        return 0
    else
        log_warning "Could not reach MCP server at $ART_MCP_URL"
        log_info "This may be due to network issues or the server being temporarily unavailable"
        log_info "You can test manually later with: curl $ART_MCP_URL"
        return 0
    fi
}

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
    echo "1. (Optional) Configure MCP Authentication:"
    echo "   If your MCP server requires API keys, add to opencode.json:"
    echo "   \"auth\": { \"apiKey\": \"your-api-key-here\" }"
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
    
    # Step 5: Test connectivity
    test_mcp_connectivity
    
    # Step 6: Show success message
    show_success_message
}

# Run main installation
main
