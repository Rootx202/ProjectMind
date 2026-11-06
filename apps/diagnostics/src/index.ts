#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { isSensitiveOrSecretPath, PROJECTMIND_VERSION } from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIdentityManager } from '@projectmind/core';
import { ProjectMindMcpServer } from '@projectmind/mcp-server';
import { SetupManager } from '@projectmind/setup';

export class DiagnosticsEngine {
  public static runDiagnostics(projectRootInput?: string) {
    const projectRoot = ProjectIdentityManager.detectProjectRoot(projectRootInput || process.cwd());
    const store = new ProjectMemoryStore(projectRoot);
    const core = store.getCoreMemory();
    const health = store.getHealthReport();
    const migrations = store.getAppliedMigrations();
    const schemaVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;

    let sqliteFts5Available = false;
    try { store.searchFts('diagnostics_probe', 1); sqliteFts5Available = true; } catch (_) {}

    const gitignoreProtected = fs.existsSync(path.join(store.dataDir, '.gitignore'));
    const secretLeakCheckPassed = store.getAllFiles().every((f) => !isSensitiveOrSecretPath(f.relativePath));

    const mcpServer = new ProjectMindMcpServer(projectRoot, true);
    const tools = mcpServer.listTools();
    const initResp = mcpServer.handleJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as Record<string, any> | null;
    const initializeHandshakePassed = Boolean(initResp?.result?.serverInfo?.name === 'projectmind-mcp-server' && initResp?.result?.instructions);

    const setup = new SetupManager();
    const adapterStatuses = setup.getAllAdapters().map((adapter) => {
      const v = adapter.verify(projectRoot);
      return {
        agentId: adapter.agentId, displayName: adapter.displayName,
        installedAndVerified: v.verified,
        passedChecks: v.checks.filter((c) => c.passed).length,
        totalChecks: v.checks.length
      };
    });

    const runtimePassed = Number(process.versions.node.split('.')[0]) >= 18 && sqliteFts5Available;
    const storagePassed = schemaVersion >= 4 && gitignoreProtected && secretLeakCheckPassed && health.eventChain.valid;
    const requiredTools = ['initialize_project', 'get_relevant_context', 'search_project_knowledge', 'get_health', 'get_memory_events'];
    const mcpPassed = tools.length >= 22 && requiredTools.every((name) => tools.some((t) => t.name === name)) && initializeHandshakePassed;

    return {
      healthy: runtimePassed && storagePassed && mcpPassed,
      projectMindVersion: PROJECTMIND_VERSION,
      projectRoot,
      runtimeCheck: { passed: runtimePassed, nodeVersion: process.versions.node, sqliteFts5Available },
      storageCheck: {
        passed: storagePassed,
        initialized: Boolean(core),
        schemaVersion,
        gitignoreProtected,
        secretLeakCheckPassed,
        sqliteIntegrity: health.integrity,
        eventChainValid: health.eventChain.valid,
        memoryEvents: health.stats.events,
        openConflicts: health.stats.conflictsOpen
      },
      mcpServerCheck: { passed: mcpPassed, toolCount: tools.length, initializeHandshakePassed },
      adapterStatuses
    };
  }
}
