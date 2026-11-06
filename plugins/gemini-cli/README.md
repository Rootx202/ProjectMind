# ProjectMind for Google Gemini CLI

Universal project memory, MCP server, Strict JSON lifecycle hooks, and GEMINI.md instructions for Gemini CLI.

## Supported Capabilities
- **MCP Transport**: `stdio`
- **Native Plugin**: `false`
- **MCP Server**: `true`
- **Agent Skills**: `true`
- **Lifecycle Hooks**: `true`
- **Instruction File**: `true`
- **Automatic Invocation**: `hooks_and_skills`
- **Reload Mechanism**: `restart_required`

## Quick Start
```bash
# Install integration for this agent
projectmind plugin install gemini-cli

# Verify configuration and health
projectmind plugin verify gemini-cli

# Cleanly remove integration
projectmind plugin uninstall gemini-cli
```

## Documentation
- Official Docs: https://geminicli.com/docs/tools/mcp-server/, https://geminicli.com/docs/hooks/, https://geminicli.com/docs/cli/gemini-md/
