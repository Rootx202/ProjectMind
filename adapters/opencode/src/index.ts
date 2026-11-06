import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult,
  AdapterVerifyResult, AdapterUninstallResult, CONCISE_SKILL_CONTENT,
  backupFileBeforeModify, readJsonSafe, writeJsonPretty,
  upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class OpenCodeAdapter implements AgentAdapter {
  public readonly agentId = 'opencode' as const;
  public readonly displayName = 'OpenCode (anomalyco / opencode.ai)';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: false, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'mcp_instructions_and_skills',
    requiresRestartOnInstall: false,
    restartInstructions: 'OpenCode hot-reloads opencode.json and AGENTS.md automatically; run `/mcp list` in OpenCode session to verify.',
    officialDocsUrls: ['https://opencode.ai/docs/mcp', 'https://opencode.ai/docs/agents-md', 'https://github.com/anomalyco/opencode'],
    documentedLimitations: ['OpenCode requires local MCP servers to specify type: "local" with a command string array.']
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, 'opencode.json')) || fs.existsSync(path.join(projectRoot, 'opencode.jsonc'))) {
      return { detected: true, reason: 'Found opencode.json(c) configuration in project root' };
    }
    if (fs.existsSync(path.join(projectRoot, '.opencode'))) {
      return { detected: true, reason: 'Found .opencode directory' };
    }
    if (homeDir && (fs.existsSync(path.join(homeDir, '.config', 'opencode')) || fs.existsSync(path.join(homeDir, '.opencode')))) {
      return { detected: true, reason: 'Found global OpenCode configuration directory' };
    }
    return { detected: false, reason: 'No existing OpenCode configuration detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'opencode', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const configPath = path.join(resolvedRoot, 'opencode.json');
    const configBackup = backupFileBeforeModify(resolvedRoot, configPath, options?.backupDir);
    if (configBackup) backupsCreated.push(configBackup);

    const opencodeJson = readJsonSafe(configPath);
    if (!opencodeJson.$schema) {
      opencodeJson.$schema = 'https://opencode.ai/config.json';
    }
    opencodeJson.mcp = opencodeJson.mcp || {};
    opencodeJson.mcp.projectmind = {
      type: 'local',
      command: ['node', mcpScript, '--project-root', resolvedRoot],
      enabled: true
    };
    writeJsonPretty(configPath, opencodeJson);
    filesCreatedOrUpdated.push('opencode.json');

    const agentsMdPath = path.join(resolvedRoot, 'AGENTS.md');
    const agentsMdBackup = backupFileBeforeModify(resolvedRoot, agentsMdPath, options?.backupDir);
    if (agentsMdBackup) backupsCreated.push(agentsMdBackup);
    upsertMarkdownBlockIdempotent(agentsMdPath);
    filesCreatedOrUpdated.push('AGENTS.md');

    const opencodeSkillPath = path.join(resolvedRoot, '.opencode', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(opencodeSkillPath), { recursive: true });
    fs.writeFileSync(opencodeSkillPath, CONCISE_SKILL_CONTENT, 'utf8');
    filesCreatedOrUpdated.push('.opencode/skills/projectmind/SKILL.md');

    const agentsSkillPath = path.join(resolvedRoot, '.agents', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(agentsSkillPath), { recursive: true });
    fs.writeFileSync(agentsSkillPath, CONCISE_SKILL_CONTENT, 'utf8');
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
    const opencodeJson = readJsonSafe(path.join(resolvedRoot, 'opencode.json'));
    const pmMcp = opencodeJson?.mcp?.projectmind;
    const hasMcp = Boolean(
      pmMcp &&
      pmMcp.type === 'local' &&
      Array.isArray(pmMcp.command) &&
      pmMcp.command.length > 0 &&
      pmMcp.enabled !== false
    );

    const agentsMdPath = path.join(resolvedRoot, 'AGENTS.md');
    const hasAgentsMd = fs.existsSync(agentsMdPath) && fs.readFileSync(agentsMdPath, 'utf8').includes('PROJECTMIND:START');
    const hasSkill = fs.existsSync(path.join(resolvedRoot, '.opencode', 'skills', 'projectmind', 'SKILL.md'));

    const checks = [
      { name: 'OpenCode MCP Configuration (opencode.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing or invalid' },
      { name: 'OpenCode Instruction Reference (AGENTS.md)', passed: hasAgentsMd, details: hasAgentsMd ? 'Verified' : 'Missing' },
      { name: 'OpenCode Skill (.opencode/skills/projectmind/SKILL.md)', passed: hasSkill, details: hasSkill ? 'Verified' : 'Missing' }
    ];

    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const configPath = path.join(resolvedRoot, 'opencode.json');

    if (fs.existsSync(configPath)) {
      const opencodeJson = readJsonSafe(configPath);
      if (opencodeJson?.mcp?.projectmind) {
        delete opencodeJson.mcp.projectmind;
        if (Object.keys(opencodeJson.mcp).length === 0) {
          delete opencodeJson.mcp;
        }
        const remainingKeys = Object.keys(opencodeJson).filter((k) => k !== '$schema');
        if (remainingKeys.length === 0) {
          fs.rmSync(configPath, { force: true });
        } else {
          writeJsonPretty(configPath, opencodeJson);
        }
        modified.push('opencode.json');
      }
    }

    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'AGENTS.md'))) {
      modified.push('AGENTS.md');
    }

    const opencodeSkillDir = path.join(resolvedRoot, '.opencode', 'skills', 'projectmind');
    if (fs.existsSync(opencodeSkillDir)) {
      fs.rmSync(opencodeSkillDir, { recursive: true, force: true });
      modified.push('.opencode/skills/projectmind');
    }

    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}

