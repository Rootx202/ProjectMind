# ProjectMind for GitHub Copilot (VS Code & CLI/Harness)

Persistent project intelligence, VS Code .vscode/mcp.json, portable .mcp.json, and custom instructions for Copilot.

## Supported Capabilities
- **MCP Transport**: `stdio`
- **Native Plugin**: `false`
- **MCP Server**: `true`
- **Agent Skills**: `true`
- **Lifecycle Hooks**: `false`
- **Instruction File**: `true`
- **Automatic Invocation**: `instructions_and_mcp`
- **Reload Mechanism**: `hot_reload`

## Quick Start
```bash
# Install integration for this agent
projectmind plugin install github-copilot

# Verify configuration and health
projectmind plugin verify github-copilot

# Cleanly remove integration
projectmind plugin uninstall github-copilot
```

## Documentation
- Official Docs: https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/docs/agent-customization/custom-instructions
