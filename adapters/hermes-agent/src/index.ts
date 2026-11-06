import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult, getSkillContent,
  AdapterVerifyResult, AdapterUninstallResult,
  backupFileBeforeModify, readJsonSafe, writeJsonPretty,
  upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class HermesAgentAdapter implements AgentAdapter {
  public readonly agentId = 'hermes-agent' as const;
  public readonly displayName = 'Hermes Agent (Nous Research)';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: true, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'hooks_and_skills',
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
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.hermes'))) return { detected: true, reason: 'Found .hermes directory' };
    if (fs.existsSync(path.join(projectRoot, 'HERMES.md')) || fs.existsSync(path.join(projectRoot, '.hermes.md'))) {
      return { detected: true, reason: 'Found HERMES.md configuration file' };
    }
    if (fs.existsSync(path.join(projectRoot, 'hermes.json'))) return { detected: true, reason: 'Found hermes.json file' };
    if (homeDir && (fs.existsSync(path.join(homeDir, '.hermes')) || fs.existsSync(path.join(homeDir, '.config', 'hermes')))) {
      return { detected: true, reason: 'Found global ~/.hermes configuration' };
    }
    return { detected: false, reason: 'No existing Hermes Agent configuration detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'hermes-agent', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const hermesConfigPath = path.join(resolvedRoot, '.hermes', 'config.json');
    const hermesConfigBackup = backupFileBeforeModify(resolvedRoot, hermesConfigPath, options?.backupDir);
    if (hermesConfigBackup) backupsCreated.push(hermesConfigBackup);

    const hermesConfig = readJsonSafe(hermesConfigPath);
    hermesConfig.mcp_servers = hermesConfig.mcp_servers || {};
    hermesConfig.mcp_servers.projectmind = {
      command: 'node',
      args: [mcpScript, '--project-root', resolvedRoot],
      cwd: resolvedRoot,
      enabled: true
    };
    hermesConfig.skills = hermesConfig.skills || {};
    hermesConfig.skills.external_dirs = Array.isArray(hermesConfig.skills.external_dirs)
      ? hermesConfig.skills.external_dirs
      : [];
    if (!hermesConfig.skills.external_dirs.includes('.hermes/skills')) {
      hermesConfig.skills.external_dirs.push('.hermes/skills');
    }
    if (!hermesConfig.skills.external_dirs.includes('.agents/skills')) {
      hermesConfig.skills.external_dirs.push('.agents/skills');
    }
    writeJsonPretty(hermesConfigPath, hermesConfig);
    filesCreatedOrUpdated.push('.hermes/config.json');

    const hermesMcpPath = path.join(resolvedRoot, '.hermes', 'mcp.json');
    const hermesMcpBackup = backupFileBeforeModify(resolvedRoot, hermesMcpPath, options?.backupDir);
    if (hermesMcpBackup) backupsCreated.push(hermesMcpBackup);

    const hermesMcp = readJsonSafe(hermesMcpPath);
    hermesMcp.mcpServers = hermesMcp.mcpServers || {};
    hermesMcp.mcpServers.projectmind = {
      command: 'node',
      args: [mcpScript, '--project-root', resolvedRoot],
      cwd: resolvedRoot
    };
    writeJsonPretty(hermesMcpPath, hermesMcp);
    filesCreatedOrUpdated.push('.hermes/mcp.json');

    const hermesMdPath = path.join(resolvedRoot, 'HERMES.md');
    const hermesMdBackup = backupFileBeforeModify(resolvedRoot, hermesMdPath, options?.backupDir);
    if (hermesMdBackup) backupsCreated.push(hermesMdBackup);
    upsertMarkdownBlockIdempotent(hermesMdPath);
    filesCreatedOrUpdated.push('HERMES.md');

    const agentsMdPath = path.join(resolvedRoot, 'AGENTS.md');
    const agentsMdBackup = backupFileBeforeModify(resolvedRoot, agentsMdPath, options?.backupDir);
    if (agentsMdBackup) backupsCreated.push(agentsMdBackup);
    upsertMarkdownBlockIdempotent(agentsMdPath);
    filesCreatedOrUpdated.push('AGENTS.md');

    const hermesSkillPath = path.join(resolvedRoot, '.hermes', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(hermesSkillPath), { recursive: true });
    fs.writeFileSync(hermesSkillPath, getSkillContent(), 'utf8');
    filesCreatedOrUpdated.push('.hermes/skills/projectmind/SKILL.md');

    const agentsSkillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(agentsSkillPath), { recursive: true });
    fs.writeFileSync(agentsSkillPath, getSkillContent(), 'utf8');
    filesCreatedOrUpdated.push('.agents/skills/projectmind/SKILL.md');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId,
      displayName: this.displayName,
      installed: verification.verified,
      filesCreatedOrUpdated,
      backupsCreated,
      requiresRestart: false,
      restartMessage: this.capabilities.restartInstructions,
      verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const configPath = path.join(resolvedRoot, '.hermes', 'config.json');
    const mcpPath = path.join(resolvedRoot, '.hermes', 'mcp.json');

    const configJson = readJsonSafe(configPath);
    const mcpJson = readJsonSafe(mcpPath);

    const hasMcpInConfig = Boolean(configJson?.mcp_servers?.projectmind?.command);
    const hasMcpInMcpJson = Boolean(mcpJson?.mcpServers?.projectmind?.command);
    const hasMcp = hasMcpInConfig || hasMcpInMcpJson;

    const hermesMdPath = path.join(resolvedRoot, 'HERMES.md');
    const hasHermesMd = fs.existsSync(hermesMdPath) && fs.readFileSync(hermesMdPath, 'utf8').includes('PROJECTMIND:START');
    const hasSkill = fs.existsSync(path.join(resolvedRoot, '.hermes', 'skills', 'projectmind', 'SKILL.md'));

    const checks = [
      { name: 'Hermes Agent MCP Configuration (.hermes/config.json or .hermes/mcp.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing' },
      { name: 'Hermes Agent Instruction Reference (HERMES.md)', passed: hasHermesMd, details: hasHermesMd ? 'Verified' : 'Missing' },
      { name: 'Hermes Agent Skill (.hermes/skills/projectmind/SKILL.md)', passed: hasSkill, details: hasSkill ? 'Verified' : 'Missing' }
    ];

    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];

    const configPath = path.join(resolvedRoot, '.hermes', 'config.json');
    if (fs.existsSync(configPath)) {
      const configJson = readJsonSafe(configPath);
      if (configJson?.mcp_servers?.projectmind) {
        delete configJson.mcp_servers.projectmind;
        if (Object.keys(configJson.mcp_servers).length === 0) {
          delete configJson.mcp_servers;
        }
        if (Object.keys(configJson).length === 0) {
          fs.rmSync(configPath, { force: true });
        } else {
          writeJsonPretty(configPath, configJson);
        }
        modified.push('.hermes/config.json');
      }
    }

    const mcpPath = path.join(resolvedRoot, '.hermes', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      const mcpJson = readJsonSafe(mcpPath);
      if (mcpJson?.mcpServers?.projectmind) {
        delete mcpJson.mcpServers.projectmind;
        if (Object.keys(mcpJson.mcpServers).length === 0) {
          fs.rmSync(mcpPath, { force: true });
        } else {
          writeJsonPretty(mcpPath, mcpJson);
        }
        modified.push('.hermes/mcp.json');
      }
    }

    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'HERMES.md'))) {
      modified.push('HERMES.md');
    }
    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'AGENTS.md'))) {
      modified.push('AGENTS.md');
    }

    const hermesSkillDir = path.join(resolvedRoot, '.hermes', 'skills', 'projectmind');
    if (fs.existsSync(hermesSkillDir)) {
      fs.rmSync(hermesSkillDir, { recursive: true, force: true });
      modified.push('.hermes/skills/projectmind');
    }

    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}

