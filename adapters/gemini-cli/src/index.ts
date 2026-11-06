import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult, getSkillContent,
  AdapterVerifyResult, AdapterUninstallResult,
  backupFileBeforeModify, readJsonSafe, writeJsonPretty,
  upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class GeminiCliAdapter implements AgentAdapter {
  public readonly agentId = 'gemini-cli' as const;
  public readonly displayName = 'Google Gemini CLI';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: false, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'hooks_and_skills',
    requiresRestartOnInstall: true,
    restartInstructions: 'Restart Gemini CLI or run `/hooks` and `/settings` to reload project hooks and MCP servers.',
    officialDocsUrls: ['https://geminicli.com/docs/tools/mcp-server/', 'https://geminicli.com/docs/hooks/', 'https://geminicli.com/docs/cli/gemini-md/'],
    documentedLimitations: ['Gemini CLI fingerprints project hooks and prompts for user trust on first execution.']
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.gemini')) || fs.existsSync(path.join(projectRoot, 'GEMINI.md'))) return { detected: true, reason: 'Found .gemini or GEMINI.md' };
    if (homeDir && fs.existsSync(path.join(homeDir, '.gemini', 'settings.json'))) return { detected: true, reason: 'Found ~/.gemini/settings.json' };
    return { detected: false, reason: 'No existing .gemini settings detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'gemini-cli', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const settingsPath = path.join(resolvedRoot, '.gemini', 'settings.json');
    const backup = backupFileBeforeModify(resolvedRoot, settingsPath, options?.backupDir);
    if (backup) backupsCreated.push(backup);

    const settings = readJsonSafe(settingsPath);
    settings.mcpServers = settings.mcpServers || {};
    settings.mcpServers.projectmind = { command: 'node', args: [mcpScript, '--project-root', resolvedRoot], cwd: resolvedRoot };
    settings.hooks = settings.hooks || {};

    for (const { event, matcher } of [
      { event: 'SessionStart', matcher: '*' },
      { event: 'BeforeAgent', matcher: '*' },
      { event: 'AfterTool', matcher: 'write_file|replace|edit' },
      { event: 'AfterAgent', matcher: '*' }
    ]) {
      const existing: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const filtered = existing.filter((item) => !JSON.stringify(item).includes('gemini-cli-hook.js'));
      filtered.push({
        matcher,
        hooks: [{ name: `projectmind-${event.toLowerCase()}`, type: 'command', command: `node "${hookScriptPath}" ${event}`, timeout: 15000 }]
      });
      settings.hooks[event] = filtered;
    }
    writeJsonPretty(settingsPath, settings);
    filesCreatedOrUpdated.push('.gemini/settings.json');

    const skillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, getSkillContent(), 'utf8');
    filesCreatedOrUpdated.push('.agents/skills/projectmind/SKILL.md');

    const geminiMdPath = path.join(resolvedRoot, 'GEMINI.md');
    const mdBackup = backupFileBeforeModify(resolvedRoot, geminiMdPath, options?.backupDir);
    if (mdBackup) backupsCreated.push(mdBackup);
    upsertMarkdownBlockIdempotent(geminiMdPath);
    filesCreatedOrUpdated.push('GEMINI.md');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId, displayName: this.displayName, installed: verification.verified,
      filesCreatedOrUpdated, backupsCreated, requiresRestart: true,
      restartMessage: this.capabilities.restartInstructions, verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const settings = readJsonSafe(path.join(resolvedRoot, '.gemini', 'settings.json'));
    const hasMcp = Boolean(settings?.mcpServers?.projectmind?.command);
    const hasHooks = Boolean(settings?.hooks?.SessionStart) && Boolean(settings?.hooks?.BeforeAgent) && Boolean(settings?.hooks?.AfterTool);
    const geminiMdPath = path.join(resolvedRoot, 'GEMINI.md');
    const hasMd = fs.existsSync(geminiMdPath) && fs.readFileSync(geminiMdPath, 'utf8').includes('PROJECTMIND:START');
    const checks = [
      { name: 'Gemini CLI MCP Server (.gemini/settings.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing' },
      { name: 'Gemini CLI Lifecycle Hooks (.gemini/settings.json)', passed: hasHooks, details: hasHooks ? 'Verified' : 'Missing' },
      { name: 'Gemini CLI Context File (GEMINI.md)', passed: hasMd, details: hasMd ? 'Verified' : 'Missing' }
    ];
    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const settingsPath = path.join(resolvedRoot, '.gemini', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = readJsonSafe(settingsPath);
      if (settings?.mcpServers?.projectmind) delete settings.mcpServers.projectmind;
      if (settings?.hooks) {
        for (const evt of Object.keys(settings.hooks)) {
          if (Array.isArray(settings.hooks[evt])) {
            settings.hooks[evt] = settings.hooks[evt].filter((item: unknown) => !JSON.stringify(item).includes('gemini-cli-hook.js'));
          }
        }
      }
      writeJsonPretty(settingsPath, settings);
      modified.push('.gemini/settings.json');
    }
    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'GEMINI.md'))) modified.push('GEMINI.md');
    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}
