# ProjectMind for OpenAI Codex (CLI / IDE / Desktop)

Project intelligence, MCP stdio server integration, skills, and AGENTS.md instructions for OpenAI Codex.

## Supported Capabilities
- **MCP Transport**: `stdio`
- **Native Plugin**: `false`
- **MCP Server**: `true`
- **Agent Skills**: `true`
- **Lifecycle Hooks**: `false`
- **Instruction File**: `true`
- **Automatic Invocation**: `mcp_instructions_and_skills`
- **Reload Mechanism**: `restart_required`

## Quick Start
```bash
# Install integration for this agent
projectmind plugin install codex

# Verify configuration and health
projectmind plugin verify codex

# Cleanly remove integration
projectmind plugin uninstall codex
```

## Documentation
- Official Docs: https://learn.chatgpt.com/docs/extend/mcp, https://github.com/openai/codex/blob/main/docs/config.md
