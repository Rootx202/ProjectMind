import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult, getSkillContent,
  AdapterVerifyResult, AdapterUninstallResult,
  backupFileBeforeModify, readJsonSafe, writeJsonPretty, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class CursorAdapter implements AgentAdapter {
  public readonly agentId = 'cursor' as const;
  public readonly displayName = 'Cursor IDE & Agent CLI';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: false, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'hooks_and_skills',
    requiresRestartOnInstall: false,
    restartInstructions: 'Cursor watches `.cursor/hooks.json` and `.cursor/mcp.json` automatically; ensure the workspace is marked Trusted.',
    officialDocsUrls: ['https://cursor.com/docs/cli/mcp', 'https://cursor.com/docs/hooks', 'https://cursor.com/docs/rules'],
    documentedLimitations: ['Project hooks require the workspace to be marked Trusted in Cursor.']
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.cursor'))) return { detected: true, reason: 'Found .cursor directory' };
    if (homeDir && fs.existsSync(path.join(homeDir, '.cursor'))) return { detected: true, reason: 'Found ~/.cursor directory' };
    return { detected: false, reason: 'No existing .cursor directory detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'cursor', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const mcpPath = path.join(resolvedRoot, '.cursor', 'mcp.json');
    const mcpBackup = backupFileBeforeModify(resolvedRoot, mcpPath, options?.backupDir);
    if (mcpBackup) backupsCreated.push(mcpBackup);
    const mcpJson = readJsonSafe(mcpPath);
    mcpJson.mcpServers = mcpJson.mcpServers || {};
    mcpJson.mcpServers.projectmind = { command: 'node', args: [mcpScript, '--project-root', resolvedRoot] };
    writeJsonPretty(mcpPath, mcpJson);
    filesCreatedOrUpdated.push('.cursor/mcp.json');

    const hooksPath = path.join(resolvedRoot, '.cursor', 'hooks.json');
    const hooksBackup = backupFileBeforeModify(resolvedRoot, hooksPath, options?.backupDir);
    if (hooksBackup) backupsCreated.push(hooksBackup);
    const hooksJson = readJsonSafe(hooksPath);
    hooksJson.version = 1;
    hooksJson.hooks = hooksJson.hooks || {};

    for (const evt of ['workspaceOpen', 'sessionStart', 'beforeSubmitPrompt', 'afterFileEdit', 'stop']) {
      const existing: any[] = Array.isArray(hooksJson.hooks[evt]) ? hooksJson.hooks[evt] : [];
      const filtered = existing.filter((item) => !JSON.stringify(item).includes('cursor-hook.js'));
      filtered.push({ type: 'command', command: `node "${hookScriptPath}" ${evt}`, timeout: 15, failClosed: false });
      hooksJson.hooks[evt] = filtered;
    }
    writeJsonPretty(hooksPath, hooksJson);
    filesCreatedOrUpdated.push('.cursor/hooks.json');

    const rulePath = path.join(resolvedRoot, '.cursor', 'rules', 'projectmind.mdc');
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, [
      '---',
      'description: ProjectMind automatic project memory retrieval and incremental synchronization',
      'globs: **/*',
      'alwaysApply: true',
      '---',
      '# ProjectMind Intelligence Protocol',
      '- Before planning or editing code in this repository, call `get_relevant_context` on the `projectmind` MCP server.',
      '- After editing, creating, renaming, or deleting files, call `sync_changed_files`.',
      ''
    ].join('\n'), 'utf8');
    filesCreatedOrUpdated.push('.cursor/rules/projectmind.mdc');

    const skillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, getSkillContent(), 'utf8');
    filesCreatedOrUpdated.push('.agents/skills/projectmind/SKILL.md');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId, displayName: this.displayName, installed: verification.verified,
      filesCreatedOrUpdated, backupsCreated, requiresRestart: false,
      restartMessage: this.capabilities.restartInstructions, verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpJson = readJsonSafe(path.join(resolvedRoot, '.cursor', 'mcp.json'));
    const hasMcp = Boolean(mcpJson?.mcpServers?.projectmind?.command);
    const hooksJson = readJsonSafe(path.join(resolvedRoot, '.cursor', 'hooks.json'));
    const hasHooks = hooksJson.version === 1 && Boolean(hooksJson?.hooks?.sessionStart) && Boolean(hooksJson?.hooks?.afterFileEdit);
    const hasRule = fs.existsSync(path.join(resolvedRoot, '.cursor', 'rules', 'projectmind.mdc'));
    const checks = [
      { name: 'Cursor MCP Configuration (.cursor/mcp.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing' },
      { name: 'Cursor Lifecycle Hooks (.cursor/hooks.json)', passed: hasHooks, details: hasHooks ? 'Verified' : 'Missing' },
      { name: 'Cursor Rule (.cursor/rules/projectmind.mdc)', passed: hasRule, details: hasRule ? 'Verified' : 'Missing' }
    ];
    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const mcpPath = path.join(resolvedRoot, '.cursor', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      const mcpJson = readJsonSafe(mcpPath);
      if (mcpJson?.mcpServers?.projectmind) {
        delete mcpJson.mcpServers.projectmind;
        writeJsonPretty(mcpPath, mcpJson);
        modified.push('.cursor/mcp.json');
      }
    }
    const hooksPath = path.join(resolvedRoot, '.cursor', 'hooks.json');
    if (fs.existsSync(hooksPath)) {
      const hooksJson = readJsonSafe(hooksPath);
      if (hooksJson?.hooks) {
        for (const evt of Object.keys(hooksJson.hooks)) {
          if (Array.isArray(hooksJson.hooks[evt])) {
            hooksJson.hooks[evt] = hooksJson.hooks[evt].filter((item: unknown) => !JSON.stringify(item).includes('cursor-hook.js'));
          }
        }
        writeJsonPretty(hooksPath, hooksJson);
        modified.push('.cursor/hooks.json');
      }
    }
    const rulePath = path.join(resolvedRoot, '.cursor', 'rules', 'projectmind.mdc');
    if (fs.existsSync(rulePath)) { fs.rmSync(rulePath, { force: true }); modified.push('.cursor/rules/projectmind.mdc'); }
    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}
