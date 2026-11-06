# ProjectMind for Cursor IDE & Agent CLI

Project intelligence, Cursor MCP server, v1 lifecycle hooks, and projectmind.mdc rule integration.

## Supported Capabilities
- **MCP Transport**: `stdio`
- **Native Plugin**: `false`
- **MCP Server**: `true`
- **Agent Skills**: `true`
- **Lifecycle Hooks**: `true`
- **Instruction File**: `true`
- **Automatic Invocation**: `hooks_and_skills`
- **Reload Mechanism**: `hot_reload`

## Quick Start
```bash
# Install integration for this agent
projectmind plugin install cursor

# Verify configuration and health
projectmind plugin verify cursor

# Cleanly remove integration
projectmind plugin uninstall cursor
```

## Documentation
- Official Docs: https://cursor.com/docs/cli/mcp, https://cursor.com/docs/hooks, https://cursor.com/docs/rules
