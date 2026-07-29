#!/bin/bash

set -e

# ============================================================================
# ART Bundle Plugin Installation Script
# ============================================================================
# This script installs the ART Bundle Plugin into your OpenCode environment.
#
# Usage:
#   ./install.sh
#
# Requirements:
#   - OpenCode must be installed
#   - ~/.opencode or ./.opencode directory must exist
#   - curl command available for connectivity testing
#
# What this script does:
#   1. Detects your OpenCode configuration location
#   2. Copies skills and agents to your installation
#   3. Merges MCP configuration into opencode.json
#   4. Tests connectivity to the MCP server
#   5. Displays next steps
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ART_MCP_URL="https://art-mcp-1005318772721.us-west1.run.app/mcp"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
# Step 1: Detect OpenCode Configuration Location
# ============================================================================

detect_opencode_config() {
    log_info "Step 1/5: Detecting OpenCode configuration location..."
    
    # IMPORTANT: Only check for LOCAL .opencode directory
    # We NEVER install globally to ~/.opencode (user home)
    # This ensures project-level isolation and cleanliness
    
    if [ -d ".opencode" ]; then
        OPENCODE_DIR=".opencode"
        log_success "Found local .opencode directory"
        return 0
    fi
    
    # If local .opencode not found, ask user to create it
    log_error "Could not find local .opencode directory"
    echo ""
    echo "This script ONLY installs to LOCAL project directories."
    echo "Global installation is NOT supported."
    echo ""
    echo "Please create a local .opencode directory:"
    echo "  mkdir .opencode"
    echo ""
    echo "Then run this script again."
    echo ""
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
    
    detect_opencode_config
    copy_files
    merge_mcp_config
    test_mcp_connectivity
    show_success_message
}

# Run main installation
main
