import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult,
  AdapterVerifyResult, AdapterUninstallResult, CONCISE_SKILL_CONTENT,
  backupFileBeforeModify, readJsonSafe, writeJsonPretty,
  upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent, writeHookRunnerScript
} from '@projectmind/agent-sdk';

export class DeepSeekHarnessAdapter implements AgentAdapter {
  public readonly agentId = 'deepseek-harness' as const;
  public readonly displayName = 'DeepSeek Harness (dsh / DeepSeek AI)';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: true, mcpServer: true, agentSkills: true, lifecycleHooks: true, instructionFile: true,
    automaticInvocationMechanism: 'mcp_instructions_and_skills',
    requiresRestartOnInstall: true,
    restartInstructions: 'Restart dsh session or reload profile with `dsh --dump-config` to confirm plugin/MCP server status.',
    officialDocsUrls: [
      'https://github.com/deepseek-ai/deepseek-harness',
      'https://github.com/deepseek-ai/dsh-superagent-prototype'
    ],
    documentedLimitations: [
      'DeepSeek Harness uses profile overlays; local .dsh/mcp.json and .deepseek/mcp.json are loaded into active profile stdio clients.'
    ]
  };

  public detectEnvironment(projectRoot: string, homeDir = process.env.HOME || ''): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.dsh')) || fs.existsSync(path.join(projectRoot, '.deepseek'))) {
      return { detected: true, reason: 'Found .dsh or .deepseek configuration directory' };
    }
    if (fs.existsSync(path.join(projectRoot, 'dsh.config.json')) || fs.existsSync(path.join(projectRoot, 'deepseek.json'))) {
      return { detected: true, reason: 'Found dsh.config.json or deepseek.json' };
    }
    if (fs.existsSync(path.join(projectRoot, 'DEEPSEEK.md')) || fs.existsSync(path.join(projectRoot, '.deepseek.md'))) {
      return { detected: true, reason: 'Found DEEPSEEK.md instructions file' };
    }
    if (homeDir && (fs.existsSync(path.join(homeDir, '.dsh')) || fs.existsSync(path.join(homeDir, '.deepseek')) || fs.existsSync(path.join(homeDir, '.config', 'dsh')))) {
      return { detected: true, reason: 'Found global ~/.dsh or ~/.deepseek directory' };
    }
    return { detected: false, reason: 'No existing DeepSeek Harness configuration detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const sdkDist = path.resolve(__dirname, '../../../packages/agent-sdk/dist/index.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const hookScriptPath = writeHookRunnerScript(resolvedRoot, 'deepseek-harness', sdkDist);
    filesCreatedOrUpdated.push(path.relative(resolvedRoot, hookScriptPath));

    const dshMcpPath = path.join(resolvedRoot, '.dsh', 'mcp.json');
    const dshBackup = backupFileBeforeModify(resolvedRoot, dshMcpPath, options?.backupDir);
    if (dshBackup) backupsCreated.push(dshBackup);

    const dshMcp = readJsonSafe(dshMcpPath);
    dshMcp.mcpServers = dshMcp.mcpServers || {};
    dshMcp.mcpServers.projectmind = {
      command: 'node',
      args: [mcpScript, '--project-root', resolvedRoot],
      cwd: resolvedRoot,
      enabled: true
    };
    writeJsonPretty(dshMcpPath, dshMcp);
    filesCreatedOrUpdated.push('.dsh/mcp.json');

    const deepseekMcpPath = path.join(resolvedRoot, '.deepseek', 'mcp.json');
    const deepseekBackup = backupFileBeforeModify(resolvedRoot, deepseekMcpPath, options?.backupDir);
    if (deepseekBackup) backupsCreated.push(deepseekBackup);

    const deepseekMcp = readJsonSafe(deepseekMcpPath);
    deepseekMcp.mcpServers = deepseekMcp.mcpServers || {};
    deepseekMcp.mcpServers.projectmind = {
      command: 'node',
      args: [mcpScript, '--project-root', resolvedRoot],
      cwd: resolvedRoot
    };
    writeJsonPretty(deepseekMcpPath, deepseekMcp);
    filesCreatedOrUpdated.push('.deepseek/mcp.json');

    const dshConfigPath = path.join(resolvedRoot, '.dsh', 'config.json');
    const dshConfigBackup = backupFileBeforeModify(resolvedRoot, dshConfigPath, options?.backupDir);
    if (dshConfigBackup) backupsCreated.push(dshConfigBackup);

    const dshConfig = readJsonSafe(dshConfigPath);
    dshConfig.plugins = dshConfig.plugins || {};
    dshConfig.plugins['@projectmind/dsh-plugin'] = {
      enabled: true,
      mcpServer: 'projectmind'
    };
    writeJsonPretty(dshConfigPath, dshConfig);
    filesCreatedOrUpdated.push('.dsh/config.json');

    const deepseekMdPath = path.join(resolvedRoot, 'DEEPSEEK.md');
    const deepseekMdBackup = backupFileBeforeModify(resolvedRoot, deepseekMdPath, options?.backupDir);
    if (deepseekMdBackup) backupsCreated.push(deepseekMdBackup);
    upsertMarkdownBlockIdempotent(deepseekMdPath);
    filesCreatedOrUpdated.push('DEEPSEEK.md');

    const agentsMdPath = path.join(resolvedRoot, 'AGENTS.md');
    const agentsMdBackup = backupFileBeforeModify(resolvedRoot, agentsMdPath, options?.backupDir);
    if (agentsMdBackup) backupsCreated.push(agentsMdBackup);
    upsertMarkdownBlockIdempotent(agentsMdPath);
    filesCreatedOrUpdated.push('AGENTS.md');

    const dshSkillPath = path.join(resolvedRoot, '.dsh', 'skills', 'projectmind', 'SKILL.md');
    fs.mkdirSync(path.dirname(dshSkillPath), { recursive: true });
    fs.writeFileSync(dshSkillPath, CONCISE_SKILL_CONTENT, 'utf8');
    filesCreatedOrUpdated.push('.dsh/skills/projectmind/SKILL.md');

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
      requiresRestart: true,
      restartMessage: this.capabilities.restartInstructions,
      verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const dshMcp = readJsonSafe(path.join(resolvedRoot, '.dsh', 'mcp.json'));
    const deepseekMcp = readJsonSafe(path.join(resolvedRoot, '.deepseek', 'mcp.json'));
    const hasMcp = Boolean(dshMcp?.mcpServers?.projectmind?.command || deepseekMcp?.mcpServers?.projectmind?.command);

    const deepseekMdPath = path.join(resolvedRoot, 'DEEPSEEK.md');
    const hasDeepSeekMd = fs.existsSync(deepseekMdPath) && fs.readFileSync(deepseekMdPath, 'utf8').includes('PROJECTMIND:START');
    const hasSkill = fs.existsSync(path.join(resolvedRoot, '.dsh', 'skills', 'projectmind', 'SKILL.md'));

    const checks = [
      { name: 'DeepSeek Harness MCP Configuration (.dsh/mcp.json or .deepseek/mcp.json)', passed: hasMcp, details: hasMcp ? 'Verified' : 'Missing' },
      { name: 'DeepSeek Instruction Reference (DEEPSEEK.md)', passed: hasDeepSeekMd, details: hasDeepSeekMd ? 'Verified' : 'Missing' },
      { name: 'DeepSeek Harness Skill (.dsh/skills/projectmind/SKILL.md)', passed: hasSkill, details: hasSkill ? 'Verified' : 'Missing' }
    ];

    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];

    const dshMcpPath = path.join(resolvedRoot, '.dsh', 'mcp.json');
    if (fs.existsSync(dshMcpPath)) {
      const dshMcp = readJsonSafe(dshMcpPath);
      if (dshMcp?.mcpServers?.projectmind) {
        delete dshMcp.mcpServers.projectmind;
        if (Object.keys(dshMcp.mcpServers).length === 0) {
          fs.rmSync(dshMcpPath, { force: true });
        } else {
          writeJsonPretty(dshMcpPath, dshMcp);
        }
        modified.push('.dsh/mcp.json');
      }
    }

    const deepseekMcpPath = path.join(resolvedRoot, '.deepseek', 'mcp.json');
    if (fs.existsSync(deepseekMcpPath)) {
      const deepseekMcp = readJsonSafe(deepseekMcpPath);
      if (deepseekMcp?.mcpServers?.projectmind) {
        delete deepseekMcp.mcpServers.projectmind;
        if (Object.keys(deepseekMcp.mcpServers).length === 0) {
          fs.rmSync(deepseekMcpPath, { force: true });
        } else {
          writeJsonPretty(deepseekMcpPath, deepseekMcp);
        }
        modified.push('.deepseek/mcp.json');
      }
    }

    const dshConfigPath = path.join(resolvedRoot, '.dsh', 'config.json');
    if (fs.existsSync(dshConfigPath)) {
      const dshConfig = readJsonSafe(dshConfigPath);
      if (dshConfig?.plugins?.['@projectmind/dsh-plugin']) {
        delete dshConfig.plugins['@projectmind/dsh-plugin'];
        if (Object.keys(dshConfig.plugins).length === 0) {
          delete dshConfig.plugins;
        }
        if (Object.keys(dshConfig).length === 0) {
          fs.rmSync(dshConfigPath, { force: true });
        } else {
          writeJsonPretty(dshConfigPath, dshConfig);
        }
        modified.push('.dsh/config.json');
      }
    }

    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'DEEPSEEK.md'))) {
      modified.push('DEEPSEEK.md');
    }
    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, 'AGENTS.md'))) {
      modified.push('AGENTS.md');
    }

    const dshSkillDir = path.join(resolvedRoot, '.dsh', 'skills', 'projectmind');
    if (fs.existsSync(dshSkillDir)) {
      fs.rmSync(dshSkillDir, { recursive: true, force: true });
      modified.push('.dsh/skills/projectmind');
    }

    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}

