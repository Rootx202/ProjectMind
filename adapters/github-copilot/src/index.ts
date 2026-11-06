import * as fs from 'fs';
import * as path from 'path';
import {
  AgentAdapter, AgentCapabilities, AdapterInstallOptions, AdapterInstallResult,
  AdapterVerifyResult, AdapterUninstallResult, backupFileBeforeModify,
  readJsonSafe, writeJsonPretty, upsertMarkdownBlockIdempotent, removeMarkdownBlockIdempotent
} from '@projectmind/agent-sdk';

export class GitHubCopilotAdapter implements AgentAdapter {
  public readonly agentId = 'github-copilot' as const;
  public readonly displayName = 'GitHub Copilot (VS Code & Copilot CLI/Harness)';
  public readonly capabilities: AgentCapabilities = {
    nativePlugin: false, mcpServer: true, agentSkills: true, lifecycleHooks: false, instructionFile: true,
    automaticInvocationMechanism: 'instructions_and_mcp',
    requiresRestartOnInstall: false,
    restartInstructions: 'In VS Code Command Palette, run `MCP: List Servers` to confirm `projectmind` is running.',
    officialDocsUrls: ['https://code.visualstudio.com/docs/agents/reference/mcp-configuration', 'https://code.visualstudio.com/docs/agent-customization/custom-instructions'],
    documentedLimitations: ['Standard VS Code Copilot Chat relies on .github/copilot-instructions.md and MCP tool discovery rather than shell lifecycle hooks.']
  };

  public detectEnvironment(projectRoot: string): { detected: boolean; reason: string } {
    if (fs.existsSync(path.join(projectRoot, '.vscode')) || fs.existsSync(path.join(projectRoot, '.github'))) return { detected: true, reason: 'Found .vscode or .github' };
    return { detected: false, reason: 'No existing .vscode/.github directory detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const mcpScript = options?.mcpServerScriptPath || path.resolve(__dirname, '../../../packages/mcp-server/dist/cli.js');
    const filesCreatedOrUpdated: string[] = [];
    const backupsCreated: string[] = [];

    const vscodeMcpPath = path.join(resolvedRoot, '.vscode', 'mcp.json');
    const vscodeBackup = backupFileBeforeModify(resolvedRoot, vscodeMcpPath, options?.backupDir);
    if (vscodeBackup) backupsCreated.push(vscodeBackup);
    const vscodeMcp = readJsonSafe(vscodeMcpPath);
    vscodeMcp.servers = vscodeMcp.servers || {};
    vscodeMcp.servers.projectmind = { type: 'stdio', command: 'node', args: [mcpScript, '--project-root', resolvedRoot], cwd: '${workspaceFolder}' };
    writeJsonPretty(vscodeMcpPath, vscodeMcp);
    filesCreatedOrUpdated.push('.vscode/mcp.json');

    const portableMcpPath = path.join(resolvedRoot, '.mcp.json');
    const portableBackup = backupFileBeforeModify(resolvedRoot, portableMcpPath, options?.backupDir);
    if (portableBackup) backupsCreated.push(portableBackup);
    const portableMcp = readJsonSafe(portableMcpPath);
    portableMcp.mcpServers = portableMcp.mcpServers || {};
    portableMcp.mcpServers.projectmind = { command: 'node', args: [mcpScript, '--project-root', resolvedRoot] };
    writeJsonPretty(portableMcpPath, portableMcp);
    filesCreatedOrUpdated.push('.mcp.json');

    const copilotInstrPath = path.join(resolvedRoot, '.github', 'copilot-instructions.md');
    const instrBackup = backupFileBeforeModify(resolvedRoot, copilotInstrPath, options?.backupDir);
    if (instrBackup) backupsCreated.push(instrBackup);
    upsertMarkdownBlockIdempotent(copilotInstrPath);
    filesCreatedOrUpdated.push('.github/copilot-instructions.md');

    const promptPath = path.join(resolvedRoot, '.github', 'prompts', 'projectmind.prompt.md');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, '---\nmode: "agent"\ntools: ["projectmind/*"]\ndescription: "Retrieve selective ProjectMind context"\n---\nUse `projectmind` MCP tools (`get_relevant_context`, `sync_changed_files`).\n', 'utf8');
    filesCreatedOrUpdated.push('.github/prompts/projectmind.prompt.md');

    const verification = this.verify(resolvedRoot);
    return {
      agentId: this.agentId, displayName: this.displayName, installed: verification.verified,
      filesCreatedOrUpdated, backupsCreated, requiresRestart: false,
      restartMessage: this.capabilities.restartInstructions, verification
    };
  }

  public verify(projectRoot: string): AdapterVerifyResult {
    const resolvedRoot = path.resolve(projectRoot);
    const vscodeMcp = readJsonSafe(path.join(resolvedRoot, '.vscode', 'mcp.json'));
    const hasVscodeMcp = vscodeMcp?.servers?.projectmind?.type === 'stdio' && Boolean(vscodeMcp?.servers?.projectmind?.command);
    const portableMcp = readJsonSafe(path.join(resolvedRoot, '.mcp.json'));
    const hasPortableMcp = Boolean(portableMcp?.mcpServers?.projectmind?.command);
    const instrPath = path.join(resolvedRoot, '.github', 'copilot-instructions.md');
    const hasInstr = fs.existsSync(instrPath) && fs.readFileSync(instrPath, 'utf8').includes('PROJECTMIND:START');
    const checks = [
      { name: 'VS Code MCP Configuration (.vscode/mcp.json)', passed: hasVscodeMcp, details: hasVscodeMcp ? 'Verified' : 'Missing' },
      { name: 'Portable Copilot Harness MCP Configuration (.mcp.json)', passed: hasPortableMcp, details: hasPortableMcp ? 'Verified' : 'Missing' },
      { name: 'GitHub Copilot Custom Instructions (.github/copilot-instructions.md)', passed: hasInstr, details: hasInstr ? 'Verified' : 'Missing' }
    ];
    return { agentId: this.agentId, verified: checks.every((c) => c.passed), checks };
  }

  public uninstall(projectRoot: string): AdapterUninstallResult {
    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];
    const vscodeMcpPath = path.join(resolvedRoot, '.vscode', 'mcp.json');
    if (fs.existsSync(vscodeMcpPath)) {
      const vscodeMcp = readJsonSafe(vscodeMcpPath);
      if (vscodeMcp?.servers?.projectmind) { delete vscodeMcp.servers.projectmind; writeJsonPretty(vscodeMcpPath, vscodeMcp); modified.push('.vscode/mcp.json'); }
    }
    const portableMcpPath = path.join(resolvedRoot, '.mcp.json');
    if (fs.existsSync(portableMcpPath)) {
      const portableMcp = readJsonSafe(portableMcpPath);
      if (portableMcp?.mcpServers?.projectmind) { delete portableMcp.mcpServers.projectmind; writeJsonPretty(portableMcpPath, portableMcp); modified.push('.mcp.json'); }
    }
    if (removeMarkdownBlockIdempotent(path.join(resolvedRoot, '.github', 'copilot-instructions.md'))) modified.push('.github/copilot-instructions.md');
    const promptPath = path.join(resolvedRoot, '.github', 'prompts', 'projectmind.prompt.md');
    if (fs.existsSync(promptPath)) { fs.rmSync(promptPath, { force: true }); modified.push('.github/prompts/projectmind.prompt.md'); }
    return { agentId: this.agentId, uninstalled: true, filesModifiedOrRemoved: modified };
  }
}
