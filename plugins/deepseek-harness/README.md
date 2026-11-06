# ProjectMind for DeepSeek Harness (dsh / DeepSeek AI)

Universal project memory, profile MCP server, profile plugin overlay, and DEEPSEEK.md instructions for DeepSeek Harness.

## Supported Capabilities
- **MCP Transport**: `stdio`
- **Native Plugin**: `true`
- **MCP Server**: `true`
- **Agent Skills**: `true`
- **Lifecycle Hooks**: `true`
- **Instruction File**: `true`
- **Automatic Invocation**: `mcp_instructions_and_skills`
- **Reload Mechanism**: `restart_required`

## Quick Start
```bash
# Install integration for this agent
projectmind plugin install deepseek-harness

# Verify configuration and health
projectmind plugin verify deepseek-harness

# Cleanly remove integration
projectmind plugin uninstall deepseek-harness
```

## Documentation
- Official Docs: https://github.com/deepseek-ai/deepseek-harness, https://github.com/deepseek-ai/dsh-superagent-prototype
