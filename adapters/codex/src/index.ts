import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult, getSkillContent,
  AdapterVerifyResult, AdapterUninstallResult,
  TOML_MARKER_START, TOML_MARKER_END, backupFileBeforeModify,
  upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent
} from '@projectmind/agent-sdk';

export class CodexAdapter implements AgentAdapter {
  public readonly agentId = 'codex' as const;
  public readonly displayName = 'OpenAI Codex (CLI / IDE / Desktop)';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: false, mcpServer: true, agentSkills: true, lifecycleHooks: false, instructionFile: true,
    automaticInvocationMechanism: 'mcp_instructions_and_skills',
    requiresRestartOnInstall: true,
    restartInstructions: 'Restart your Codex CLI session or select Restart in the Codex IDE/Desktop MCP servers menu.',
    officialDocsUrls: ['https://learn.chatgpt.com/docs/extend/mcp', 'https://github.com/openai/codex/blob/main/docs/config.md'],
    documentedLimitations: ['Codex cloud/managed orchestration restricts local command hooks via allow_managed_hooks_only; automatic invocation uses MCP initialize instructions + AGENTS.md + skill.']
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.codex'))) return { detected: true, reason: 'Found .codex directory' };
    if (homeDir && fs.existsSync(path.join(homeDir, '.codex'))) return { detected: true, reason: 'Found ~/.codex directory' };
    return { detected: false, reason: 'No existing .codex directory detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const configTomlPath = path.join(resolvedRoot, '.codex', 'config.toml');
    const tomlBackup = backupFileBeforeModify(resolvedRoot, configTomlPath, options?.backupDir);
    if (tomlBackup) backupsCreated.push(tomlBackup);

    const tomlBlock = [
      TOML_MARKER_START,
      '[mcp_servers.projectmind]',
      'command = "node"',
      `args = [${JSON.stringify(mcpScript)}, "--project-root", ${JSON.stringify(resolvedRoot)}]`,
      `cwd = ${JSON.stringify(resolvedRoot)}`,
      'startup_timeout_sec = 15',
      'tool_timeout_sec = 60',
      'enabled = true',
      TOML_MARKER_END
    ].join('\n');

    fs.mkdirSync(path.dirname(configTomlPath), { recursive: true });
    if (!fs.existsSync(configTomlPath)) {
      fs.writeFileSync(configTomlPath, tomlBlock + '\n', 'utf8');
    } else {
      const existing = fs.readFileSync(configTomlPath, 'utf8');
      const sIdx = existing.indexOf(TOML_MARKER_START);
      const eIdx = existing.indexOf(TOML_MARKER_END);
      if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
        fs.writeFileSync(configTomlPath, existing.slice(0, sIdx) + tomlBlock + existing.slice(eIdx + TOML_MARKER_END.length), 'utf8');
      } else {
        fs.writeFileSync(configTomlPath, existing + (existing.endsWith('\n') ? '\n' : '\n\n') + tomlBlock + '\n', 'utf8');
      }
    }
    filesCreatedOrUpdated.push('.codex/config.toml');

    const skillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, getSkillContent(), 'utf8');
    filesCreatedOrUpdated.push('.agents/skills/projectmind/SKILL.md');

    const agentsMdPath = path.join(resolvedRoot, 'AGENTS.md');
    const mdBackup = backupFileBeforeModify(resolvedRoot, agentsMdPath, options?.backupDir);
    if (mdBackup) backupsCreated.push(mdBackup);
    upsertMarkdownBlockIdempotent(agentsMdPath);
    filesCreatedOrUpdated.push('AGENTS.md');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId, displayName: this.displayName, installed: verification.verified,
      filesCreatedOrUpdated, backupsCreated, requiresRestart: true,
      restartMessage: this.capabilities.restartInstructions, verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const configTomlPath = path.join(resolvedRoot, '.codex', 'config.toml');
    const hasToml = fs.existsSync(configTomlPath) && fs.readFileSync(configTomlPath, 'utf8').includes('[mcp_servers.projectmind]');
    const hasSkill = fs.existsSync(path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md'));
    const agentsMdPath = path.join(resolvedRoot, 'AGENTS.md');
    const hasAgentsMd = fs.existsSync(agentsMdPath) && fs.readFileSync(agentsMdPath, 'utf8').includes('PROJECTMIND:START');
    const checks = [
      { name: 'Codex MCP Configuration (.codex/config.toml)', passed: hasToml, details: hasToml ? 'Verified' : 'Missing' },
      { name: 'Codex Skill (.agents/skills/projectmind/SKILL.md)', passed: hasSkill, details: hasSkill ? 'Verified' : 'Missing' },
      { name: 'Codex Instruction Reference (AGENTS.md)', passed: hasAgentsMd, details: hasAgentsMd ? 'Verified' : 'Missing' }
    ];
    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const configTomlPath = path.join(resolvedRoot, '.codex', 'config.toml');
    if (fs.existsSync(configTomlPath)) {
      const existing = fs.readFileSync(configTomlPath, 'utf8');
      const sIdx = existing.indexOf(TOML_MARKER_START);
      const eIdx = existing.indexOf(TOML_MARKER_END);
      if (sIdx !== -1 && eIdx !== -1) {
        const cleaned = (existing.slice(0, sIdx) + existing.slice(eIdx + TOML_MARKER_END.length)).trim();
        if (!cleaned) fs.rmSync(configTomlPath, { force: true });
        else fs.writeFileSync(configTomlPath, cleaned + '\n', 'utf8');
        modified.push('.codex/config.toml');
      }
    }
    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'AGENTS.md'))) modified.push('AGENTS.md');
    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}
