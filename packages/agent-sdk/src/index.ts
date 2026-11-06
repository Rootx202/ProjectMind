export * from './adapter-base';
import * as fs from 'fs';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIdentityManager } from '@projectmind/core';
import { ProjectIndexer, BootstrapReport } from '@projectmind/indexing';
import { KnowledgeEngine } from '@projectmind/knowledge';
import { ImpactAnalyzer } from '@projectmind/impact-analysis';
import { KnowledgeRetriever } from '@projectmind/retrieval';
import { ContextEngine, RelevantContextPackage } from '@projectmind/context-engine';

export interface SmartAutoSessionResult {
  action: 'initial_bootstrap' | 'warm_reuse_unchanged' | 'warm_incremental_sync' | 'recovered_reinitialized';
  projectId: string;
  projectName: string;
  projectRoot: string;
  fullScanPerformed: boolean;
  syncedFilesCount: number;
  summary: string;
  compactContext: Record<string, unknown>;
}

export class SmartAutoModeEngine {
  public readonly projectRoot: string;
  public readonly store: ProjectMemoryStore;
  public readonly indexer: ProjectIndexer;
  public readonly knowledge: KnowledgeEngine;
  public readonly impact: ImpactAnalyzer;
  public readonly retriever: KnowledgeRetriever;
  public readonly contextEngine: ContextEngine;

  constructor(projectRoot: string) {
    this.projectRoot = ProjectIdentityManager.detectProjectRoot(projectRoot);
    this.store = new ProjectMemoryStore(this.projectRoot);
    ProjectIdentityManager.reconcileMovedProject(this.store, this.projectRoot);
    this.indexer = new ProjectIndexer(this.projectRoot, this.store);
    this.knowledge = new KnowledgeEngine(this.projectRoot, this.store);
    this.impact = new ImpactAnalyzer(this.store);
    this.retriever = new KnowledgeRetriever(this.store);
    this.contextEngine = new ContextEngine(this.store, this.retriever, this.impact, this.indexer);
  }

  public onProjectOpen(): SmartAutoSessionResult {
    const existingCore = this.store.getCoreMemory();

    if (!existingCore) {
      const report: BootstrapReport = this.indexer.bootstrapProject();
      const core = this.store.getCoreMemory()!;
      return {
        action: this.store.recoveredFromCorruption ? 'recovered_reinitialized' : 'initial_bootstrap',
        projectId: core.projectId,
        projectName: core.projectName,
        projectRoot: this.projectRoot,
        fullScanPerformed: true,
        syncedFilesCount: report.indexedFilesCount,
        summary: `Initialized ProjectMind for ${core.projectName} (${report.indexedFilesCount} files across ${report.modulesCount} modules).`,
        compactContext: {
          projectId: core.projectId,
          projectName: core.projectName,
          purpose: core.projectPurpose,
          techStack: core.mainTechStack,
          modulesCount: report.modulesCount
        }
      };
    }

    const changes = this.indexer.detectProjectChanges();
    if (!changes.hasChanges) {
      return {
        action: 'warm_reuse_unchanged',
        projectId: existingCore.projectId,
        projectName: existingCore.projectName,
        projectRoot: this.projectRoot,
        fullScanPerformed: false,
        syncedFilesCount: 0,
        summary: `Reused verified ProjectMind memory for ${existingCore.projectName} (${changes.unchangedCount} files unchanged; 0 files rescanned).`,
        compactContext: {
          projectId: existingCore.projectId,
          projectName: existingCore.projectName,
          purpose: existingCore.projectPurpose,
          techStack: existingCore.mainTechStack,
          state: existingCore.currentState
        }
      };
    }

    const syncRes = this.indexer.syncChangedFiles();
    return {
      action: 'warm_incremental_sync',
      projectId: existingCore.projectId,
      projectName: existingCore.projectName,
      projectRoot: this.projectRoot,
      fullScanPerformed: false,
      syncedFilesCount: syncRes.syncedFiles.length,
      summary: `Incrementally synchronized ${syncRes.syncedFiles.length} changed/added, ${syncRes.deletedFiles.length} deleted, and ${syncRes.renamedFiles.length} renamed file(s) across module(s): ${syncRes.updatedModules.join(', ')}.`,
      compactContext: {
        projectId: existingCore.projectId,
        projectName: existingCore.projectName,
        purpose: existingCore.projectPurpose,
        updatedModules: syncRes.updatedModules
      }
    };
  }

  public onBeforeTask(
    taskDescription: string,
    options?: { targetFiles?: string[]; targetModules?: string[]; budgetTokens?: number }
  ): RelevantContextPackage {
    if (!this.store.getCoreMemory()) {
      this.onProjectOpen();
    } else {
      const changes = this.indexer.detectProjectChanges();
      if (changes.hasChanges) this.indexer.syncChangedFiles();
    }
    return this.contextEngine.getRelevantContext({
      taskDescription,
      targetFiles: options?.targetFiles,
      targetModules: options?.targetModules,
      budgetTokens: options?.budgetTokens
    });
  }

  public onAfterFileChange(explicitFiles?: string[]): {
    syncedFiles: string[];
    deletedFiles: string[];
    renamedFiles: Array<{ from: string; to: string }>;
    updatedModules: string[];
    transitionedFromPlanned: string[];
  } {
    if (!this.store.getCoreMemory()) this.onProjectOpen();
    return this.indexer.syncChangedFiles(explicitFiles);
  }

  public static handleHookStdin(
    agentId: SupportedAgentId | string,
    hookEvent: string,
    stdinPayload: string,
    fallbackProjectRoot?: string
  ): Record<string, unknown> {
    try {
      const parsed = stdinPayload.trim() ? JSON.parse(stdinPayload) : {};
      const rootDir =
        parsed.cwd ||
        (Array.isArray(parsed.workspace_roots) && parsed.workspace_roots[0]) ||
        process.env.GEMINI_PROJECT_DIR ||
        process.env.CLAUDE_PROJECT_DIR ||
        process.env.CURSOR_PROJECT_DIR ||
        process.env.HERMES_PROJECT_DIR ||
        process.env.OPENCODE_PROJECT_DIR ||
        process.env.DSH_PROJECT_DIR ||
        fallbackProjectRoot ||
        process.cwd();

      if (!fs.existsSync(rootDir)) return {};

      const engine = new SmartAutoModeEngine(rootDir);
      const eventLower = hookEvent.toLowerCase();

      if (eventLower === 'sessionstart' || eventLower === 'workspaceopen') {
        const openRes = engine.onProjectOpen();
        const contextLine = `[ProjectMind] ${openRes.summary}`;
        if (agentId === 'antigravity') return { injectSteps: [{ userMessage: contextLine }] };
        if (agentId === 'cursor') return { additional_context: contextLine };
        if (agentId === 'claude-code') return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: contextLine } };
        if (agentId === 'hermes-agent') return { context: contextLine, memory: contextLine, systemMessage: contextLine };
        if (agentId === 'opencode') return { context: contextLine, message: contextLine, systemMessage: contextLine };
        if (agentId === 'deepseek-harness') return { context: contextLine, systemMessage: contextLine };
        return { systemMessage: contextLine };
      }

      if (
        eventLower === 'preinvocation' ||
        eventLower === 'userpromptsubmit' ||
        eventLower === 'beforesubmitprompt' ||
        eventLower === 'beforeagent'
      ) {
        const promptText = String(parsed.prompt || parsed.user_message || parsed.message || '');
        if (!promptText) return agentId === 'cursor' ? { continue: true } : {};
        const ctxPkg = engine.onBeforeTask(promptText, { budgetTokens: 1500 });
        if (!ctxPkg.retrievalNeeded) return agentId === 'cursor' ? { continue: true } : {};
        const modList = ctxPkg.relevantModules.map((m) => `${m.moduleId} (${m.verificationStatus})`).join(', ');
        const fileList = ctxPkg.relevantFiles.map((f) => f.relativePath).join(', ');
        const summaryNote = `[ProjectMind Context | Scope: ${ctxPkg.scopeLevel}] Modules: ${modList || 'none'} | Key Files: ${fileList || 'none'}`;
        if (agentId === 'antigravity') return { injectSteps: [{ userMessage: summaryNote }] };
        if (agentId === 'claude-code') return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: summaryNote } };
        if (agentId === 'cursor') return { continue: true };
        if (agentId === 'hermes-agent') return { additionalContext: summaryNote, memory: summaryNote };
        if (agentId === 'opencode') return { additionalContext: summaryNote, context: summaryNote };
        if (agentId === 'deepseek-harness') return { additionalContext: summaryNote, systemMessage: summaryNote };
        return { systemMessage: summaryNote };
      }

      if (
        eventLower === 'posttooluse' ||
        eventLower === 'afterfileedit' ||
        eventLower === 'filechanged' ||
        eventLower === 'aftertool' ||
        eventLower === 'stop' ||
        eventLower === 'afteragent'
      ) {
        const syncRes = engine.onAfterFileChange();
        if (agentId === 'antigravity' && eventLower === 'stop') return {};
        if (agentId === 'cursor' && syncRes.syncedFiles.length > 0) {
          return { additional_context: `[ProjectMind] Incrementally synced ${syncRes.syncedFiles.length} file(s).` };
        }
        if ((agentId === 'hermes-agent' || agentId === 'opencode' || agentId === 'deepseek-harness') && syncRes.syncedFiles.length > 0) {
          return { syncReport: `[ProjectMind] Incrementally synced ${syncRes.syncedFiles.length} file(s).` };
        }
        return {};
      }
      return {};
    } catch (_) {
      return {};
    }
  }
}
