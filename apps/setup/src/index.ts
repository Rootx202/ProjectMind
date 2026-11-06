#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  AgentAdapter, SupportedAgentId, AdapterInstallOptions,
  AdapterInstallResult, AdapterVerifyResult, AdapterUninstallResult,
  AdapterUpdateResult, AdapterDisableResult, AdapterEnableResult,
  AdapterRestoreResult, backupFileBeforeModify, readJsonSafe, writeJsonPretty
} from '@projectmind/agent-sdk';
import {
  PluginRegistry, PluginManifest, RuntimeResolver,
  getOsDirectoryLayout, detectPlatform, ConfigWriter,
  UpdateManager, UpdateManagerOptions, CoreUpdateCheckResult, CoreUpdateResult,
  OutdatedPluginsReport, PluginUpdateResult
} from '@projectmind/plugin-sdk';
import { AntigravityAdapter } from '@projectmind/adapter-antigravity';
import { CodexAdapter } from '@projectmind/adapter-codex';
import { ClaudeCodeAdapter } from '@projectmind/adapter-claude-code';
import { GeminiCliAdapter } from '@projectmind/adapter-gemini-cli';
import { CursorAdapter } from '@projectmind/adapter-cursor';
import { GitHubCopilotAdapter } from '@projectmind/adapter-github-copilot';
import { OpenCodeAdapter } from '@projectmind/adapter-opencode';
import { HermesAgentAdapter } from '@projectmind/adapter-hermes-agent';
import { DeepSeekHarnessAdapter } from '@projectmind/adapter-deepseek-harness';
import { PROJECTMIND_VERSION } from '@projectmind/shared';

export {
  AntigravityAdapter,
  CodexAdapter,
  ClaudeCodeAdapter,
  GeminiCliAdapter,
  CursorAdapter,
  GitHubCopilotAdapter,
  OpenCodeAdapter,
  HermesAgentAdapter,
  DeepSeekHarnessAdapter
};

export class SetupManager {
  private readonly adapters: Map<SupportedAgentId, AgentAdapter>;

  constructor() {
    this.adapters = new Map<SupportedAgentId, AgentAdapter>();
    for (const adapter of [
      new AntigravityAdapter(), new CodexAdapter(), new ClaudeCodeAdapter(),
      new GeminiCliAdapter(), new CursorAdapter(), new GitHubCopilotAdapter(),
      new OpenCodeAdapter(), new HermesAgentAdapter(), new DeepSeekHarnessAdapter()
    ]) {
      this.adapters.set(adapter.agentId, adapter);
    }
  }

  public normalizeAgentId(input: string): SupportedAgentId {
    const lower = input.toLowerCase().trim();
    if (lower === 'opencode' || lower === 'open-code') return 'opencode';
    if (lower === 'hermes' || lower === 'hermes-agent' || lower === 'hermes_agent') return 'hermes-agent';
    if (
      lower === 'deepseek' ||
      lower === 'deepseek-harness' ||
      lower === 'deepseek_harness' ||
      lower === 'deepseek-hermes' ||
      lower === 'deepseek_hermes' ||
      lower === 'deepseek-hernes' ||
      lower === 'dsh'
    ) {
      return 'deepseek-harness';
    }
    return lower as SupportedAgentId;
  }

  public getAllAdapters(): AgentAdapter[] { return Array.from(this.adapters.values()); }

  public getAdapter(agentId: string): AgentAdapter {
    const normalized = this.normalizeAgentId(agentId);
    const adapter = this.adapters.get(normalized);
    if (!adapter) throw new Error(`Unsupported agent adapter: ${agentId}`);
    return adapter;
  }

  public getManifest(agentId: string): PluginManifest | null {
    const normalized = this.normalizeAgentId(agentId);
    return PluginRegistry.loadManifest(normalized);
  }

  public listPlugins(projectRoot?: string) {
    const root = projectRoot ? path.resolve(projectRoot) : process.cwd();
    return this.getAllAdapters().map((adapter) => {
      const manifest = PluginRegistry.loadManifest(adapter.agentId);
      const detection = adapter.detectEnvironment(root);
      const verification = adapter.verify(root);
      return {
        id: adapter.agentId,
        displayName: adapter.displayName,
        version: manifest?.version || '1.0.0',
        description: manifest?.description || '',
        detected: detection.detected,
        installed: verification.verified,
        capabilities: manifest?.capabilities || adapter.capabilities
      };
    });
  }

  public searchPlugins(query: string) {
    const matchedManifests = PluginRegistry.search(query);
    return matchedManifests.map((m) => {
      return {
        id: m.id,
        displayName: m.name,
        version: m.version,
        description: m.description,
        capabilities: m.capabilities
      };
    });
  }

  public detectAgents(projectRoot: string, homeDir?: string) {
    const resolvedRoot = path.resolve(projectRoot);
    return this.getAllAdapters().map((adapter) => {
      const det = adapter.detectEnvironment(resolvedRoot, homeDir);
      return { agentId: adapter.agentId, displayName: adapter.displayName, detected: det.detected, reason: det.reason };
    });
  }

  public checkVersionCompatibility() {
    const nodeVer = process.versions.node;
    const compatible = Number(nodeVer.split('.')[0]) >= 18;
    return { compatible, nodeVersion: nodeVer, projectMindVersion: PROJECTMIND_VERSION, details: `Node.js v${nodeVer}` };
  }

  public installAdapter(projectRoot: string, agentId: string, options?: AdapterInstallOptions): AdapterInstallResult {
    return this.getAdapter(agentId).install(path.resolve(projectRoot), options);
  }

  public installMultiple(projectRoot: string, agentIds: string[], options?: AdapterInstallOptions): AdapterInstallResult[] {
    return agentIds.map((id) => this.installAdapter(projectRoot, id, options));
  }

  public verifyAdapter(projectRoot: string, agentId: string, options?: AdapterInstallOptions): AdapterVerifyResult {
    return this.getAdapter(agentId).verify(path.resolve(projectRoot), options);
  }

  public updateAdapter(projectRoot: string, agentId: string, options?: AdapterInstallOptions): AdapterUpdateResult {
    const adapter = this.getAdapter(agentId);
    if (typeof adapter.update === 'function') {
      return adapter.update(path.resolve(projectRoot), options);
    }

    const resolvedRoot = path.resolve(projectRoot);
    const installRes = adapter.install(resolvedRoot, options);
    return {
      agentId: adapter.agentId,
      updated: installRes.installed,
      filesUpdated: installRes.filesCreatedOrUpdated,
      backupsCreated: installRes.backupsCreated,
      verification: installRes.verification
    };
  }

  public disableAdapter(projectRoot: string, agentId: string): AdapterDisableResult {
    const adapter = this.getAdapter(agentId);
    if (typeof adapter.disable === 'function') {
      return adapter.disable(path.resolve(projectRoot));
    }

    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];

    switch (adapter.agentId) {
      case 'antigravity': {
        const mcpPath = path.join(resolvedRoot, '.agents', 'mcp_config.json');
        if (fs.existsSync(mcpPath)) {
          backupFileBeforeModify(resolvedRoot, mcpPath);
          const mcp = readJsonSafe(mcpPath);
          if (mcp.mcpServers?.projectmind) {
            mcp.mcpServers.projectmind.disabled = true;
            writeJsonPretty(mcpPath, mcp);
            modified.push('.agents/mcp_config.json');
          }
        }
        const hooksPath = path.join(resolvedRoot, '.agents', 'plugins', 'projectmind', 'hooks.json');
        if (fs.existsSync(hooksPath)) {
          backupFileBeforeModify(resolvedRoot, hooksPath);
          const h = readJsonSafe(hooksPath);
          if (h['projectmind-auto-lifecycle']) {
            h['projectmind-auto-lifecycle'].enabled = false;
            writeJsonPretty(hooksPath, h);
            modified.push('.agents/plugins/projectmind/hooks.json');
          }
        }
        break;
      }
      case 'opencode': {
        const p = path.join(resolvedRoot, 'opencode.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.mcp?.projectmind) {
            c.mcp.projectmind.enabled = false;
            writeJsonPretty(p, c);
            modified.push('opencode.json');
          }
        }
        break;
      }
      case 'claude-code': {
        const p = path.join(resolvedRoot, '.mcp.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            c.mcpServers.projectmind.disabled = true;
            writeJsonPretty(p, c);
            modified.push('.mcp.json');
          }
        }
        break;
      }
      case 'codex': {
        const p = path.join(resolvedRoot, '.codex', 'config.toml');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const content = fs.readFileSync(p, 'utf8');
          const updated = content.replace('enabled = true', 'enabled = false');
          fs.writeFileSync(p, updated, 'utf8');
          modified.push('.codex/config.toml');
        }
        break;
      }
      case 'cursor': {
        const p = path.join(resolvedRoot, '.cursor', 'mcp.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            c.mcpServers.projectmind.disabled = true;
            writeJsonPretty(p, c);
            modified.push('.cursor/mcp.json');
          }
        }
        break;
      }
      case 'gemini-cli': {
        const p = path.join(resolvedRoot, '.gemini', 'settings.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            c.mcpServers.projectmind.disabled = true;
            writeJsonPretty(p, c);
            modified.push('.gemini/settings.json');
          }
        }
        break;
      }
      case 'github-copilot': {
        const p = path.join(resolvedRoot, '.vscode', 'mcp.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.servers?.projectmind) {
            c.servers.projectmind.disabled = true;
            writeJsonPretty(p, c);
            modified.push('.vscode/mcp.json');
          }
        }
        break;
      }
      case 'hermes-agent': {
        const p = path.join(resolvedRoot, '.hermes', 'config.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.mcp_servers?.projectmind) {
            c.mcp_servers.projectmind.enabled = false;
            writeJsonPretty(p, c);
            modified.push('.hermes/config.json');
          }
        }
        break;
      }
      case 'deepseek-harness': {
        const p = path.join(resolvedRoot, '.dsh', 'mcp.json');
        if (fs.existsSync(p)) {
          backupFileBeforeModify(resolvedRoot, p);
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            c.mcpServers.projectmind.enabled = false;
            writeJsonPretty(p, c);
            modified.push('.dsh/mcp.json');
          }
        }
        break;
      }
    }

    return {
      agentId: adapter.agentId,
      disabled: modified.length > 0,
      filesModified: modified,
      message: modified.length > 0
        ? `Successfully disabled ProjectMind for ${adapter.displayName}.`
        : `No active configuration found to disable for ${adapter.displayName}.`
    };
  }

  public enableAdapter(projectRoot: string, agentId: string): AdapterEnableResult {
    const adapter = this.getAdapter(agentId);
    if (typeof adapter.enable === 'function') {
      return adapter.enable(path.resolve(projectRoot));
    }

    const resolvedRoot = path.resolve(projectRoot);
    const modified: string[] = [];

    switch (adapter.agentId) {
      case 'antigravity': {
        const mcpPath = path.join(resolvedRoot, '.agents', 'mcp_config.json');
        if (fs.existsSync(mcpPath)) {
          const mcp = readJsonSafe(mcpPath);
          if (mcp.mcpServers?.projectmind) {
            delete mcp.mcpServers.projectmind.disabled;
            writeJsonPretty(mcpPath, mcp);
            modified.push('.agents/mcp_config.json');
          }
        }
        const hooksPath = path.join(resolvedRoot, '.agents', 'plugins', 'projectmind', 'hooks.json');
        if (fs.existsSync(hooksPath)) {
          const h = readJsonSafe(hooksPath);
          if (h['projectmind-auto-lifecycle']) {
            h['projectmind-auto-lifecycle'].enabled = true;
            writeJsonPretty(hooksPath, h);
            modified.push('.agents/plugins/projectmind/hooks.json');
          }
        }
        break;
      }
      case 'opencode': {
        const p = path.join(resolvedRoot, 'opencode.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.mcp?.projectmind) {
            c.mcp.projectmind.enabled = true;
            writeJsonPretty(p, c);
            modified.push('opencode.json');
          }
        }
        break;
      }
      case 'claude-code': {
        const p = path.join(resolvedRoot, '.mcp.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            delete c.mcpServers.projectmind.disabled;
            writeJsonPretty(p, c);
            modified.push('.mcp.json');
          }
        }
        break;
      }
      case 'codex': {
        const p = path.join(resolvedRoot, '.codex', 'config.toml');
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8');
          const updated = content.replace('enabled = false', 'enabled = true');
          fs.writeFileSync(p, updated, 'utf8');
          modified.push('.codex/config.toml');
        }
        break;
      }
      case 'cursor': {
        const p = path.join(resolvedRoot, '.cursor', 'mcp.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            delete c.mcpServers.projectmind.disabled;
            writeJsonPretty(p, c);
            modified.push('.cursor/mcp.json');
          }
        }
        break;
      }
      case 'gemini-cli': {
        const p = path.join(resolvedRoot, '.gemini', 'settings.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            delete c.mcpServers.projectmind.disabled;
            writeJsonPretty(p, c);
            modified.push('.gemini/settings.json');
          }
        }
        break;
      }
      case 'github-copilot': {
        const p = path.join(resolvedRoot, '.vscode', 'mcp.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.servers?.projectmind) {
            delete c.servers.projectmind.disabled;
            writeJsonPretty(p, c);
            modified.push('.vscode/mcp.json');
          }
        }
        break;
      }
      case 'hermes-agent': {
        const p = path.join(resolvedRoot, '.hermes', 'config.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.mcp_servers?.projectmind) {
            c.mcp_servers.projectmind.enabled = true;
            writeJsonPretty(p, c);
            modified.push('.hermes/config.json');
          }
        }
        break;
      }
      case 'deepseek-harness': {
        const p = path.join(resolvedRoot, '.dsh', 'mcp.json');
        if (fs.existsSync(p)) {
          const c = readJsonSafe(p);
          if (c.mcpServers?.projectmind) {
            delete c.mcpServers.projectmind.disabled;
            c.mcpServers.projectmind.enabled = true;
            writeJsonPretty(p, c);
            modified.push('.dsh/mcp.json');
          }
        }
        break;
      }
    }

    return {
      agentId: adapter.agentId,
      enabled: modified.length > 0,
      filesModified: modified,
      message: modified.length > 0
        ? `Successfully enabled ProjectMind for ${adapter.displayName}.`
        : `No disabled configuration found to re-enable for ${adapter.displayName}.`
    };
  }

  public uninstallAdapter(projectRoot: string, agentId: string, options?: AdapterInstallOptions): AdapterUninstallResult {
    return this.getAdapter(agentId).uninstall(path.resolve(projectRoot), options);
  }

  public restoreBackup(projectRoot: string, targetFile: string): AdapterRestoreResult {
    const resolvedRoot = path.resolve(projectRoot);
    const restored = ConfigWriter.restoreLatestBackup(resolvedRoot, targetFile);
    return {
      agentId: 'antigravity',
      restored: Boolean(restored),
      restoredFiles: restored ? [restored] : [],
      message: restored
        ? `Successfully restored backup from ${restored}`
        : `No backup found to restore for ${targetFile}`
    };
  }

  public doctor(projectRootInput?: string) {
    const projectRoot = path.resolve(projectRootInput || process.cwd());
    const nodeVer = process.versions.node;
    const nodeMajor = Number(nodeVer.split('.')[0]);
    const nodePassed = nodeMajor >= 18;

    const osLayout = getOsDirectoryLayout();
    const platform = detectPlatform();

    let runtimeResolved = false;
    let runtimeDetails = '';
    try {
      const rt = RuntimeResolver.resolveRuntime();
      runtimeResolved = true;
      runtimeDetails = `${rt.source} (${rt.homeDir})`;
    } catch (err) {
      runtimeDetails = err instanceof Error ? err.message : String(err);
    }

    let writePermissions = false;
    try {
      const probe = path.join(projectRoot, `.probe-${Date.now()}.tmp`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      writePermissions = true;
    } catch (_) {}

    const adapterStatuses = this.getAllAdapters().map((adapter) => {
      const v = adapter.verify(projectRoot);
      const det = adapter.detectEnvironment(projectRoot);
      return {
        agentId: adapter.agentId,
        displayName: adapter.displayName,
        detected: det.detected,
        verified: v.verified,
        passedChecks: v.checks.filter((c) => c.passed).length,
        totalChecks: v.checks.length
      };
    });

    const healthy = nodePassed && runtimeResolved && writePermissions;

    return {
      healthy,
      platform,
      nodeVersion: nodeVer,
      projectMindVersion: PROJECTMIND_VERSION,
      projectRoot,
      checks: {
        nodeVersion: { passed: nodePassed, details: `Node.js v${nodeVer} (requires >= 18.0.0)` },
        runtimeResolved: { passed: runtimeResolved, details: runtimeDetails },
        filesystemPermissions: { passed: writePermissions, details: writePermissions ? 'Read/Write verified' : 'Permission denied' },
        osLayout: {
          platform,
          configDir: osLayout.configDir,
          dataDir: osLayout.dataDir,
          cacheDir: osLayout.cacheDir
        }
      },
      adapterStatuses
    };
  }

  public getUpdateManager(options?: UpdateManagerOptions): UpdateManager {
    return new UpdateManager(options);
  }

  public async checkCoreUpdate(options?: UpdateManagerOptions): Promise<CoreUpdateCheckResult> {
    const updater = this.getUpdateManager(options);
    return updater.checkCoreUpdate();
  }

  public async stageCoreUpdate(projectRoot: string, options?: UpdateManagerOptions & { targetVersion?: string }): Promise<CoreUpdateResult> {
    const updater = this.getUpdateManager(options);
    return updater.stageCoreUpdate(path.resolve(projectRoot), options?.targetVersion);
  }

  public applyCoreUpdate(
    installRoot: string,
    stagedDir: string,
    options?: { force?: boolean }
  ): CoreUpdateResult {
    const updater = this.getUpdateManager();
    return updater.applyCoreUpdate(path.resolve(installRoot), stagedDir, options);
  }

  public async checkOutdatedPlugins(projectRoot: string, options?: UpdateManagerOptions): Promise<OutdatedPluginsReport> {
    const updater = this.getUpdateManager(options);
    const resolvedRoot = path.resolve(projectRoot);
    const adapters = this.getAllAdapters().map((a) => ({
      agentId: a.agentId,
      displayName: a.displayName,
      verified: a.verify(resolvedRoot).verified
    }));
    return updater.checkOutdatedPlugins(resolvedRoot, adapters);
  }

  public async updatePluginFromRemote(
    projectRoot: string,
    agentId: string,
    options?: { targetVersion?: string; force?: boolean; updaterOptions?: UpdateManagerOptions }
  ): Promise<PluginUpdateResult> {
    const normalized = this.normalizeAgentId(agentId);
    const adapter = this.getAdapter(normalized);
    const updater = this.getUpdateManager(options?.updaterOptions);
    return updater.updatePlugin(path.resolve(projectRoot), normalized, adapter, options);
  }

  public async updateAllPluginsFromRemote(
    projectRoot: string,
    options?: { updaterOptions?: UpdateManagerOptions }
  ): Promise<PluginUpdateResult[]> {
    const updater = this.getUpdateManager(options?.updaterOptions);
    const resolvedRoot = path.resolve(projectRoot);
    const adapters = this.getAllAdapters().map((a) => ({
      agentId: a.agentId,
      adapter: a,
      verified: a.verify(resolvedRoot).verified
    }));
    return updater.updateAllPlugins(resolvedRoot, adapters);
  }
}
