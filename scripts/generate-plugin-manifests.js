#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');

const pluginDefs = [
  {
    id: 'antigravity',
    name: 'ProjectMind for Google Antigravity',
    version: '1.0.0',
    description: 'Universal local-first project intelligence, persistent context engine, and autonomous lifecycle hooks for Google Antigravity.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: true,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'hooks_and_skills',
      reloadSupport: 'hot_reload',
      requiresRestartOnInstall: false,
      restartInstructions: 'Run `/mcp` or `/skills reload` in Antigravity CLI/IDE, or start a new conversation.',
      officialDocsUrls: [
        'https://antigravity.google/docs/mcp/',
        'https://antigravity.google/docs/skills/',
        'https://antigravity.google/docs/build-plugins/'
      ],
      documentedLimitations: [
        'Unconfigured MCP tools run in Ask mode by default unless allowed via policy (`mcp(projectmind/*)`).'
      ]
    },
    permissions: {
      filesystem: ['.agents', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: 'mcp/mcp_config.json',
      instructionsFile: 'rules/AGENTS.md',
      skillDir: 'skills/projectmind',
      hookRunner: 'hooks/antigravity-hook.js',
      nativePluginManifest: '.agents/plugins/projectmind/plugin.json'
    }
  },
  {
    id: 'claude-code',
    name: 'ProjectMind for Anthropic Claude Code',
    version: '1.0.0',
    description: 'Universal local-first project intelligence, MCP server, skills, and settings hooks for Anthropic Claude Code.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: true,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'hooks_and_skills',
      reloadSupport: 'restart_required',
      requiresRestartOnInstall: true,
      restartInstructions: 'Restart Claude Code or run `/mcp` and `/hooks` to confirm active status.',
      officialDocsUrls: [
        'https://code.claude.com/docs/en/settings',
        'https://code.claude.com/docs/en/hooks',
        'https://code.claude.com/docs/en/skills'
      ],
      documentedLimitations: [
        'When allowManagedHooksOnly is enforced by enterprise policy, Claude Code falls back to .claude/skills/projectmind/SKILL.md and CLAUDE.md.'
      ]
    },
    permissions: {
      filesystem: ['.mcp.json', '.claude', '.claude-plugin', 'CLAUDE.md', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.mcp.json',
      instructionsFile: 'CLAUDE.md',
      skillDir: '.claude/skills/projectmind',
      hookRunner: 'hooks/claude-code-hook.js',
      nativePluginManifest: '.claude-plugin/plugin.json'
    }
  },
  {
    id: 'codex',
    name: 'ProjectMind for OpenAI Codex (CLI / IDE / Desktop)',
    version: '1.0.0',
    description: 'Project intelligence, MCP stdio server integration, skills, and AGENTS.md instructions for OpenAI Codex.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: false,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: false,
      instructionFile: true,
      automaticInvocationMechanism: 'mcp_instructions_and_skills',
      reloadSupport: 'restart_required',
      requiresRestartOnInstall: true,
      restartInstructions: 'Restart your Codex CLI session or select Restart in the Codex IDE/Desktop MCP servers menu.',
      officialDocsUrls: [
        'https://learn.chatgpt.com/docs/extend/mcp',
        'https://github.com/openai/codex/blob/main/docs/config.md'
      ],
      documentedLimitations: [
        'Codex cloud/managed orchestration restricts local command hooks via allow_managed_hooks_only; automatic invocation uses MCP initialize instructions + AGENTS.md + skill.'
      ]
    },
    permissions: {
      filesystem: ['.codex/config.toml', 'AGENTS.md', '.agents/skills', '.projectmind'],
      network: false,
      executeCommands: false,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.codex/config.toml',
      instructionsFile: 'AGENTS.md',
      skillDir: '.agents/skills/projectmind'
    }
  },
  {
    id: 'cursor',
    name: 'ProjectMind for Cursor IDE & Agent CLI',
    version: '1.0.0',
    description: 'Project intelligence, Cursor MCP server, v1 lifecycle hooks, and projectmind.mdc rule integration.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: false,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'hooks_and_skills',
      reloadSupport: 'hot_reload',
      requiresRestartOnInstall: false,
      restartInstructions: 'Cursor watches `.cursor/hooks.json` and `.cursor/mcp.json` automatically; ensure workspace is trusted.',
      officialDocsUrls: [
        'https://cursor.com/docs/cli/mcp',
        'https://cursor.com/docs/hooks',
        'https://cursor.com/docs/rules'
      ],
      documentedLimitations: [
        'Project hooks require the workspace to be marked Trusted in Cursor.'
      ]
    },
    permissions: {
      filesystem: ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.cursor/mcp.json',
      instructionsFile: '.cursor/rules/projectmind.mdc',
      skillDir: '.agents/skills/projectmind',
      hookRunner: 'hooks/cursor-hook.js'
    }
  },
  {
    id: 'gemini-cli',
    name: 'ProjectMind for Google Gemini CLI',
    version: '1.0.0',
    description: 'Universal project memory, MCP server, Strict JSON lifecycle hooks, and GEMINI.md instructions for Gemini CLI.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: false,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'hooks_and_skills',
      reloadSupport: 'restart_required',
      requiresRestartOnInstall: true,
      restartInstructions: 'Restart Gemini CLI or run `/hooks` and `/settings` to reload project hooks and MCP servers.',
      officialDocsUrls: [
        'https://geminicli.com/docs/tools/mcp-server/',
        'https://geminicli.com/docs/hooks/',
        'https://geminicli.com/docs/cli/gemini-md/'
      ],
      documentedLimitations: [
        'Gemini CLI fingerprints project hooks and prompts for user trust on first execution.'
      ]
    },
    permissions: {
      filesystem: ['.gemini/settings.json', 'GEMINI.md', '.agents/skills', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.gemini/settings.json',
      instructionsFile: 'GEMINI.md',
      skillDir: '.agents/skills/projectmind',
      hookRunner: 'hooks/gemini-cli-hook.js'
    }
  },
  {
    id: 'github-copilot',
    name: 'ProjectMind for GitHub Copilot (VS Code & CLI/Harness)',
    version: '1.0.0',
    description: 'Persistent project intelligence, VS Code .vscode/mcp.json, portable .mcp.json, and custom instructions for Copilot.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: false,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: false,
      instructionFile: true,
      automaticInvocationMechanism: 'instructions_and_mcp',
      reloadSupport: 'hot_reload',
      requiresRestartOnInstall: false,
      restartInstructions: 'In VS Code Command Palette, run `MCP: List Servers` to confirm projectmind is running.',
      officialDocsUrls: [
        'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
        'https://code.visualstudio.com/docs/agent-customization/custom-instructions'
      ],
      documentedLimitations: [
        'Standard VS Code Copilot Chat relies on .github/copilot-instructions.md and MCP tool discovery rather than shell lifecycle hooks.'
      ]
    },
    permissions: {
      filesystem: ['.vscode/mcp.json', '.mcp.json', '.github', '.projectmind'],
      network: false,
      executeCommands: false,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.vscode/mcp.json',
      instructionsFile: '.github/copilot-instructions.md',
      skillDir: '.github/prompts'
    }
  },
  {
    id: 'deepseek-harness',
    name: 'ProjectMind for DeepSeek Harness (dsh / DeepSeek AI)',
    version: '1.0.0',
    description: 'Universal project memory, profile MCP server, profile plugin overlay, and DEEPSEEK.md instructions for DeepSeek Harness.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: true,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'mcp_instructions_and_skills',
      reloadSupport: 'restart_required',
      requiresRestartOnInstall: true,
      restartInstructions: 'Restart dsh session or reload profile with `dsh --dump-config` to confirm plugin/MCP server status.',
      officialDocsUrls: [
        'https://github.com/deepseek-ai/deepseek-harness',
        'https://github.com/deepseek-ai/dsh-superagent-prototype'
      ],
      documentedLimitations: [
        'DeepSeek Harness uses profile overlays; local .dsh/mcp.json and .deepseek/mcp.json are loaded into active profile stdio clients.'
      ]
    },
    permissions: {
      filesystem: ['.dsh', '.deepseek', 'DEEPSEEK.md', 'AGENTS.md', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.dsh/mcp.json',
      instructionsFile: 'DEEPSEEK.md',
      skillDir: '.dsh/skills/projectmind',
      hookRunner: 'hooks/deepseek-harness-hook.js'
    }
  },
  {
    id: 'hermes-agent',
    name: 'ProjectMind for Hermes Agent (Nous Research)',
    version: '1.0.0',
    description: 'Autonomous project intelligence, Native MCP client integration, HERMES.md instruction file, and self-improving memory loop.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: true,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'hooks_and_skills',
      reloadSupport: 'hot_reload',
      requiresRestartOnInstall: false,
      restartInstructions: 'Hermes Agent hot-reloads skills and HERMES.md; restart hermes or run `hermes mcp list` to verify.',
      officialDocsUrls: [
        'https://hermes-agent.nousresearch.com/docs/mcp',
        'https://github.com/NousResearch/hermes-agent',
        'https://hermes-agent.org'
      ],
      documentedLimitations: [
        'Hermes Agent prioritizes HERMES.md over AGENTS.md when both are present. ProjectMind installs into both to guarantee discoverability across all sessions.'
      ]
    },
    permissions: {
      filesystem: ['.hermes', 'HERMES.md', 'AGENTS.md', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: '.hermes/config.json',
      instructionsFile: 'HERMES.md',
      skillDir: '.hermes/skills/projectmind',
      hookRunner: 'hooks/hermes-agent-hook.js'
    }
  },
  {
    id: 'opencode',
    name: 'ProjectMind for OpenCode (anomalyco / opencode.ai)',
    version: '1.0.0',
    description: 'Universal local-first project intelligence, opencode.json local MCP server, and AGENTS.md rules for OpenCode.',
    capabilities: {
      mcpTransport: 'stdio',
      nativePlugin: false,
      mcpServer: true,
      agentSkills: true,
      lifecycleHooks: true,
      instructionFile: true,
      automaticInvocationMechanism: 'mcp_instructions_and_skills',
      reloadSupport: 'hot_reload',
      requiresRestartOnInstall: false,
      restartInstructions: 'OpenCode hot-reloads opencode.json and AGENTS.md automatically; run `/mcp list` in OpenCode session to verify.',
      officialDocsUrls: [
        'https://opencode.ai/docs/mcp',
        'https://opencode.ai/docs/agents-md',
        'https://github.com/anomalyco/opencode'
      ],
      documentedLimitations: [
        'OpenCode requires local MCP servers to specify type: "local" with a command string array.'
      ]
    },
    permissions: {
      filesystem: ['opencode.json', 'AGENTS.md', '.opencode', '.projectmind'],
      network: false,
      executeCommands: true,
      readEnv: true
    },
    entrypoints: {
      mcpConfigTemplate: 'opencode.json',
      instructionsFile: 'AGENTS.md',
      skillDir: '.opencode/skills/projectmind',
      hookRunner: 'hooks/opencode-hook.js'
    }
  }
];

for (const def of pluginDefs) {
  const dir = path.join(PLUGINS_DIR, def.id);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    $schema: '../manifest.schema.json',
    id: def.id,
    name: def.name,
    version: def.version,
    description: def.description,
    publisher: {
      name: 'ProjectMind Engineering',
      url: 'https://github.com/projectmind/projectmind'
    },
    license: 'MIT',
    homepage: 'https://github.com/projectmind/projectmind',
    repository: 'https://github.com/projectmind/projectmind',
    supportedPlatforms: ['linux', 'windows', 'darwin'],
    supportedAgentVersions: '>= 1.0.0',
    runtimeRequirements: {
      node: '>= 18.0.0',
      projectmind: '>= 1.0.0'
    },
    capabilities: def.capabilities,
    permissions: def.permissions,
    entrypoints: def.entrypoints,
    installationInstructions: `Run \`projectmind plugin install ${def.id}\` in your project root.`,
    upgradeInstructions: `Run \`projectmind plugin update ${def.id}\` to refresh configs, skills, and hooks.`,
    removalInstructions: `Run \`projectmind plugin uninstall ${def.id}\` to cleanly remove integration while preserving project knowledge.`
  };

  const manifestToHash = { ...manifest };
  manifest.integrity = {
    algorithm: 'sha256',
    hash: crypto.createHash('sha256').update(JSON.stringify(manifestToHash)).digest('hex')
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const readmeContent = `# ${def.name}

${def.description}

## Supported Capabilities
- **MCP Transport**: \`${def.capabilities.mcpTransport}\`
- **Native Plugin**: \`${def.capabilities.nativePlugin}\`
- **MCP Server**: \`${def.capabilities.mcpServer}\`
- **Agent Skills**: \`${def.capabilities.agentSkills}\`
- **Lifecycle Hooks**: \`${def.capabilities.lifecycleHooks}\`
- **Instruction File**: \`${def.capabilities.instructionFile}\`
- **Automatic Invocation**: \`${def.capabilities.automaticInvocationMechanism}\`
- **Reload Mechanism**: \`${def.capabilities.reloadSupport}\`

## Quick Start
\`\`\`bash
# Install integration for this agent
projectmind plugin install ${def.id}

# Verify configuration and health
projectmind plugin verify ${def.id}

# Cleanly remove integration
projectmind plugin uninstall ${def.id}
\`\`\`

## Documentation
- Official Docs: ${def.capabilities.officialDocsUrls.join(', ')}
`;

  fs.writeFileSync(path.join(dir, 'README.md'), readmeContent, 'utf8');
  console.log(`Generated plugin package for [${def.id}] at ${dir}`);
}
