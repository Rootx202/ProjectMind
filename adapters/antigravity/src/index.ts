import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult,
  AdapterVerifyResult, AdapterUninstallResult, CONCISE_SKILL_CONTENT,
  CONCISE_INSTRUCTION_SNIPPET, backupFileBeforeModify, readJsonSafe,
  writeJsonPretty, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class AntigravityAdapter implements AgentAdapter {
  public readonly agentId = 'antigravity' as const;
  public readonly displayName = 'Google Antigravity';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: true, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'hooks_and_skills',
    requiresRestartOnInstall: false,
    restartInstructions: 'Run `/mcp` or `/skills reload` in Antigravity CLI/IDE, or start a new conversation.',
    officialDocsUrls: ['https://antigravity.google/docs/mcp/', 'https://antigravity.google/docs/skills/', 'https://antigravity.google/docs/build-plugins/'],
    documentedLimitations: ['Unconfigured MCP tools run in Ask mode by default unless allowed via policy (`mcp(projectmind/*)`).']
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.agents'))) return { detected: true, reason: 'Found .agents directory in workspace' };
    if (homeDir && fs.existsSync(path.join(homeDir, '.gemini', 'config'))) return { detected: true, reason: 'Found ~/.gemini/config directory' };
    return { detected: false, reason: 'No existing .agents workspace directory detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'antigravity', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const mcpConfigPath = path.join(resolvedRoot, '.agents', 'mcp_config.json');
    const mcpBackup = backupFileBeforeModify(resolvedRoot, mcpConfigPath, options?.backupDir);
    if (mcpBackup) backupsCreated.push(mcpBackup);
    const mcpConfig = readJsonSafe(mcpConfigPath);
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers.projectmind = { command: 'node', args: [mcpScript, '--project-root', resolvedRoot], cwd: resolvedRoot, timeoutSeconds: 180 };
    writeJsonPretty(mcpConfigPath, mcpConfig);
    filesCreatedOrUpdated.push('.agents/mcp_config.json');

    const skillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, CONCISE_SKILL_CONTENT, 'utf8');
    filesCreatedOrUpdated.push('.agents/skills/projectmind/SKILL.md');

    const pluginRoot = path.join(resolvedRoot, '.agents', 'plugins', 'projectmind');
    fs.mkdirSync(path.join(pluginRoot, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'projectmind'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });

    writeJsonPretty(path.join(pluginRoot, 'plugin.json'), {
      $schema: 'https://antigravity.google/schemas/v1/plugin.json',
      name: 'projectmind',
      displayName: 'ProjectMind',
      version: '1.0.0',
      description: 'Universal local-first project intelligence and persistent context engine for AI coding agents.',
      logo: 'assets/logo.svg',
      suggestedPrompts: ['Get the ProjectMind architecture overview for this repository'],
      author: { name: 'ProjectMind Engineering', url: 'https://example.com/projectmind' },
      license: 'MIT',
      keywords: ['project-intelligence', 'memory', 'context', 'mcp', 'architecture']
    });
    filesCreatedOrUpdated.push('.agents/plugins/projectmind/plugin.json');

    fs.writeFileSync(path.join(pluginRoot, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><rect width="128" height="128" rx="24" fill="#0F172A"/></svg>\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'skills', 'projectmind', 'SKILL.md'), CONCISE_SKILL_CONTENT, 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'rules', 'AGENTS.md'), CONCISE_INSTRUCTION_SNIPPET + '\n', 'utf8');
    writeJsonPretty(path.join(pluginRoot, 'mcp_config.json'), {
      mcpServers: { projectmind: { command: 'node', args: [mcpScript, '--project-root', resolvedRoot], timeoutSeconds: 180 } }
    });
    writeJsonPretty(path.join(pluginRoot, 'hooks.json'), {
      'projectmind-auto-lifecycle': {
        enabled: true,
        SessionStart: [{ type: 'command', command: `node "${hookScriptPath}" SessionStart`, timeout: 15 }],
        PreInvocation: [{ type: 'command', command: `node "${hookScriptPath}" PreInvocation`, timeout: 15 }],
        PostToolUse: [{ matcher: 'edit_file|write_to_file|replace_file_content|run_command', hooks: [{ type: 'command', command: `node "${hookScriptPath}" PostToolUse`, timeout: 15 }] }],
        Stop: [{ type: 'command', command: `node "${hookScriptPath}" Stop`, timeout: 15 }]
      }
    });
    filesCreatedOrUpdated.push('.agents/plugins/projectmind/hooks.json');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId, displayName: this.displayName, installed: verification.verified,
      filesCreatedOrUpdated, backupsCreated, requiresRestart: false,
      restartMessage: this.capabilities.restartInstructions, verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpJson = readJsonSafe(path.join(resolvedRoot, '.agents', 'mcp_config.json'));
    const hasMcp = Boolean(mcpJson?.mcpServers?.projectmind?.command);
    const skillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    const hasSkill = fs.existsSync(skillPath) && fs.readFileSync(skillPath, 'utf8').includes('name: projectmind');
    const hasPlugin = fs.existsSync(path.join(resolvedRoot, '.agents', 'plugins', 'projectmind', 'plugin.json')) &&
                      fs.existsSync(path.join(resolvedRoot, '.agents', 'plugins', 'projectmind', 'hooks.json'));
    const checks = [
      { name: 'Antigravity MCP Configuration (.agents/mcp_config.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing' },
      { name: 'Antigravity Agent Skill (.agents/skills/projectmind/SKILL.md)', passed: hasSkill, details: hasSkill ? 'Verified' : 'Missing' },
      { name: 'Antigravity Native Plugin & Hooks (.agents/plugins/projectmind/)', passed: hasPlugin, details: hasPlugin ? 'Verified' : 'Missing' }
    ];
    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const mcpPath = path.join(resolvedRoot, '.agents', 'mcp_config.json');
    if (fs.existsSync(mcpPath)) {
      const mcpJson = readJsonSafe(mcpPath);
      if (mcpJson?.mcpServers?.projectmind) {
        delete mcpJson.mcpServers.projectmind;
        writeJsonPretty(mcpPath, mcpJson);
        modified.push('.agents/mcp_config.json');
      }
    }
    for (const rel of ['.agents/skills/projectmind', '.agents/plugins/projectmind']) {
      const full = path.join(resolvedRoot, rel);
      if (fs.existsSync(full)) { fs.rmSync(full, { recursive: true, force: true }); modified.push(rel); }
    }
    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}
