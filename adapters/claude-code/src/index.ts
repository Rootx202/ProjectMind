import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult, getSkillContent,
  AdapterVerifyResult, AdapterUninstallResult,
  backupFileBeforeModify, readJsonSafe, writeJsonPretty,
  upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class ClaudeCodeAdapter implements AgentAdapter {
  public readonly agentId = 'claude-code' as const;
  public readonly displayName = 'Anthropic Claude Code';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: true, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'hooks_and_skills',
    requiresRestartOnInstall: true,
    restartInstructions: 'Restart Claude Code or run `/mcp` and `/hooks` to confirm active status.',
    officialDocsUrls: ['https://code.claude.com/docs/en/settings', 'https://code.claude.com/docs/en/hooks', 'https://code.claude.com/docs/en/skills'],
    documentedLimitations: ['When allowManagedHooksOnly is enforced by enterprise policy, Claude Code falls back to .claude/skills/projectmind/SKILL.md and CLAUDE.md.']
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.claude')) || fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))) return { detected: true, reason: 'Found .claude or CLAUDE.md' };
    if (homeDir && fs.existsSync(path.join(homeDir, '.claude'))) return { detected: true, reason: 'Found ~/.claude' };
    return { detected: false, reason: 'No existing .claude configuration detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'claude-code', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const mcpJsonPath = path.join(resolvedRoot, '.mcp.json');
    const mcpBackup = backupFileBeforeModify(resolvedRoot, mcpJsonPath, options?.backupDir);
    if (mcpBackup) backupsCreated.push(mcpBackup);
    const mcpJson = readJsonSafe(mcpJsonPath);
    mcpJson.mcpServers = mcpJson.mcpServers || {};
    mcpJson.mcpServers.projectmind = { command: 'node', args: [mcpScript, '--project-root', resolvedRoot] };
    writeJsonPretty(mcpJsonPath, mcpJson);
    filesCreatedOrUpdated.push('.mcp.json');

    const settingsPath = path.join(resolvedRoot, '.claude', 'settings.json');
    const settingsBackup = backupFileBeforeModify(resolvedRoot, settingsPath, options?.backupDir);
    if (settingsBackup) backupsCreated.push(settingsBackup);
    const settings = readJsonSafe(settingsPath);
    settings.hooks = settings.hooks || {};

    for (const evt of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      const existingArr: any[] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
      const filtered = existingArr.filter((item) => !JSON.stringify(item).includes('claude-code-hook.js'));
      filtered.push({
        matcher: evt === 'PostToolUse' ? 'Edit|Write|MultiEdit' : '*',
        hooks: [{ type: 'command', command: `node "${hookScriptPath}" ${evt}` }]
      });
      settings.hooks[evt] = filtered;
    }
    writeJsonPretty(settingsPath, settings);
    filesCreatedOrUpdated.push('.claude/settings.json');

    const skillPath = path.join(resolvedRoot, '.claude', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, getSkillContent(), 'utf8');
    filesCreatedOrUpdated.push('.claude/skills/projectmind/SKILL.md');

    writeJsonPretty(path.join(resolvedRoot, '.claude-plugin', 'plugin.json'), {
      name: 'projectmind', version: '1.0.0',
      description: 'ProjectMind universal project intelligence engine for Claude Code',
      skills: ['../.claude/skills/projectmind']
    });
    filesCreatedOrUpdated.push('.claude-plugin/plugin.json');

    const claudeMdPath = path.join(resolvedRoot, 'CLAUDE.md');
    const claudeMdBackup = backupFileBeforeModify(resolvedRoot, claudeMdPath, options?.backupDir);
    if (claudeMdBackup) backupsCreated.push(claudeMdBackup);
    upsertMarkdownBlockIdempotent(claudeMdPath);
    filesCreatedOrUpdated.push('CLAUDE.md');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId, displayName: this.displayName, installed: verification.verified,
      filesCreatedOrUpdated, backupsCreated, requiresRestart: true,
      restartMessage: this.capabilities.restartInstructions, verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpJson = readJsonSafe(path.join(resolvedRoot, '.mcp.json'));
    const hasMcp = Boolean(mcpJson?.mcpServers?.projectmind?.command);
    const settings = readJsonSafe(path.join(resolvedRoot, '.claude', 'settings.json'));
    const hasHooks = Boolean(settings?.hooks?.SessionStart) && Boolean(settings?.hooks?.UserPromptSubmit) && Boolean(settings?.hooks?.PostToolUse);
    const hasSkill = fs.existsSync(path.join(resolvedRoot, '.claude', 'skills', 'projectmind', 'SKILL.md'));
    const claudeMdPath = path.join(resolvedRoot, 'CLAUDE.md');
    const hasClaudeMd = fs.existsSync(claudeMdPath) && fs.readFileSync(claudeMdPath, 'utf8').includes('PROJECTMIND:START');
    const checks = [
      { name: 'Claude Code MCP Configuration (.mcp.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing' },
      { name: 'Claude Code Lifecycle Hooks (.claude/settings.json)', passed: hasHooks, details: hasHooks ? 'Verified' : 'Missing' },
      { name: 'Claude Code Skill (.claude/skills/projectmind/SKILL.md)', passed: hasSkill, details: hasSkill ? 'Verified' : 'Missing' },
      { name: 'Claude Code Instruction Reference (CLAUDE.md)', passed: hasClaudeMd, details: hasClaudeMd ? 'Verified' : 'Missing' }
    ];
    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const mcpPath = path.join(resolvedRoot, '.mcp.json');
    if (fs.existsSync(mcpPath)) {
      const mcpJson = readJsonSafe(mcpPath);
      if (mcpJson?.mcpServers?.projectmind) {
        delete mcpJson.mcpServers.projectmind;
        writeJsonPretty(mcpPath, mcpJson);
        modified.push('.mcp.json');
      }
    }
    const settingsPath = path.join(resolvedRoot, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = readJsonSafe(settingsPath);
      if (settings.hooks) {
        for (const evt of Object.keys(settings.hooks)) {
          if (Array.isArray(settings.hooks[evt])) {
            settings.hooks[evt] = settings.hooks[evt].filter((item: unknown) => !JSON.stringify(item).includes('claude-code-hook.js'));
          }
        }
        writeJsonPretty(settingsPath, settings);
        modified.push('.claude/settings.json');
      }
    }
    for (const rel of ['.claude/skills/projectmind', '.claude-plugin']) {
      const full = path.join(resolvedRoot, rel);
      if (fs.existsSync(full)) { fs.rmSync(full, { recursive: true, force: true }); modified.push(rel); }
    }
    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'CLAUDE.md'))) modified.push('CLAUDE.md');
    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}
