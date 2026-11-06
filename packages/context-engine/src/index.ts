import {
  TaskScopeLevel,
  TaskContextRecord,
  estimateTokens,
  computeSha256
} from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';
import { KnowledgeRetriever } from '@projectmind/retrieval';
import { ImpactAnalyzer } from '@projectmind/impact-analysis';
import { ProjectIndexer } from '@projectmind/indexing';

export interface RelevantContextRequest {
  taskDescription: string;
  targetFiles?: string[];
  targetModules?: string[];
  budgetTokens?: number;
  forceDeepAnalysis?: boolean;
}

export interface RelevantContextPackage {
  taskId: string;
  taskDescription: string;
  scopeLevel: TaskScopeLevel;
  retrievalNeeded: boolean;
  fromCache: boolean;
  projectOverview?: {
    projectId: string;
    projectName: string;
    purpose: string;
    techStack: Record<string, unknown>;
    currentState: string;
  };
  relevantModules: Array<{
    moduleId: string;
    purpose: string;
    publicSymbols: string[];
    dependencies: string[];
    dependents: string[];
    verificationStatus: string;
  }>;
  relevantFiles: Array<{
    relativePath: string;
    role: string;
    summary: string;
    exports: string[];
    verificationStatus: string;
  }>;
  architecturalDecisions: Array<{
    decisionId: string;
    title: string;
    decision: string;
    verificationStatus: string;
  }>;
  constraints: string[];
  deepAnalysisTriggered: boolean;
  deepAnalysisExplanation?: string;
  warnings: string[];
  tokenBudget: {
    budgetTokens: number;
    estimatedTokensUsed: number;
    isApproximation: true;
  };
}

const GENERIC_NON_PROJECT_PATTERNS: RegExp[] = [
  /^\s*(what is|explain)\s+(a\s+)?(promise|closure|monad|binary search|quicksort|http status|git rebase|big o)\b/i,
  /^\s*(hello|hi|hey|thanks|thank you)\s*[!.?]?$/i,
  /^\s*write a (haiku|poem|joke)\b/i
];

export class ContextEngine {
  private readonly store: ProjectMemoryStore;
  private readonly retriever: KnowledgeRetriever;
  private readonly impactAnalyzer: ImpactAnalyzer;
  private readonly indexer: ProjectIndexer;

  constructor(
    store: ProjectMemoryStore,
    retriever: KnowledgeRetriever,
    impactAnalyzer: ImpactAnalyzer,
    indexer: ProjectIndexer
  ) {
    this.store = store;
    this.retriever = retriever;
    this.impactAnalyzer = impactAnalyzer;
    this.indexer = indexer;
  }

  public classifyTaskScope(req: RelevantContextRequest): {
    scopeLevel: TaskScopeLevel;
    deepAnalysisTriggered: boolean;
    deepAnalysisExplanation?: string;
  } {
    const text = req.taskDescription.trim();
    if (!req.forceDeepAnalysis && (!req.targetFiles || req.targetFiles.length === 0)) {
      for (const pat of GENERIC_NON_PROJECT_PATTERNS) {
        if (pat.test(text)) return { scopeLevel: 'none', deepAnalysisTriggered: false };
      }
    }

    if (
      req.forceDeepAnalysis ||
      /\b(full audit|security review|architecture refactor|system-wide|cross-module|deep analysis|migrate architecture)\b/i.test(text)
    ) {
      return {
        scopeLevel: 'deep-architecture',
        deepAnalysisTriggered: true,
        deepAnalysisExplanation: 'Task involves architecture-wide refactoring, security audit, or explicit deep analysis trigger.'
      };
    }

    if (
      (req.targetModules && req.targetModules.length > 1) ||
      (req.targetFiles && req.targetFiles.length > 2) ||
      /\b(across modules|multiple modules|refactor|integration|impact|dependency|bug across)\b/i.test(text)
    ) {
      return { scopeLevel: 'cross-module', deepAnalysisTriggered: false };
    }

    if (req.targetFiles && req.targetFiles.length === 1 && !/\b(module|service|api)\b/i.test(text)) {
      return { scopeLevel: 'file', deepAnalysisTriggered: false };
    }

    return { scopeLevel: 'module', deepAnalysisTriggered: false };
  }

  public getRelevantContext(req: RelevantContextRequest): RelevantContextPackage {
    const budgetTokens = req.budgetTokens || 4000;
    const classification = this.classifyTaskScope(req);
    const taskId = `task_${computeSha256(`${req.taskDescription}:${Date.now()}`).slice(0, 10)}`;

    if (classification.scopeLevel === 'none') {
      return {
        taskId, taskDescription: req.taskDescription, scopeLevel: 'none', retrievalNeeded: false, fromCache: false,
        relevantModules: [], relevantFiles: [], architecturalDecisions: [], constraints: [],
        deepAnalysisTriggered: false, warnings: [],
        tokenBudget: { budgetTokens, estimatedTokensUsed: 0, isApproximation: true }
      };
    }

    const cacheKey = computeSha256(
      JSON.stringify({
        q: req.taskDescription.trim().toLowerCase(),
        files: req.targetFiles || [],
        mods: req.targetModules || [],
        scope: classification.scopeLevel,
        budget: budgetTokens
      })
    );
    const cached = this.store.getCachedRetrieval(cacheKey) as RelevantContextPackage | null;
    if (cached && !req.forceDeepAnalysis) {
      return { ...cached, fromCache: true };
    }

    const core = this.store.getCoreMemory();
    const warnings: string[] = [];

    if (!core) {
      warnings.push('ProjectMind memory is not initialized yet. Run initialize_project first.');
      return {
        taskId, taskDescription: req.taskDescription, scopeLevel: classification.scopeLevel,
        retrievalNeeded: true, fromCache: false, relevantModules: [], relevantFiles: [],
        architecturalDecisions: [], constraints: [], deepAnalysisTriggered: false, warnings,
        tokenBudget: { budgetTokens, estimatedTokensUsed: 25, isApproximation: true }
      };
    }

    const changeCheck = this.indexer.detectProjectChanges();
    if (changeCheck.hasChanges) {
      warnings.push(
        `Detected ${changeCheck.added.length + changeCheck.modified.length + changeCheck.deleted.length + changeCheck.renamed.length} unsynchronized workspace file change(s) affecting module(s): ${changeCheck.affectedModules.join(', ')}. Consider running sync_changed_files.`
      );
    }

    if (core.currentState === 'planned_from_prompt') {
      warnings.push(
        'Project knowledge contains PLANNED specifications from the initial project prompt. Planned modules and requirements are not yet verified implementation facts.'
      );
    }

    const hits = this.retriever.searchKnowledge(req.taskDescription, {
      limit: classification.scopeLevel === 'deep-architecture' ? 20 : 10
    });

    const selectedModuleIds = new Set<string>(req.targetModules || []);
    const selectedFilePaths = new Set<string>(req.targetFiles || []);

    for (const fPath of req.targetFiles || []) {
      const f = this.store.getFile(fPath);
      if (f) selectedModuleIds.add(f.moduleId);
    }

    for (const hit of hits) {
      if (hit.entityType === 'module') selectedModuleIds.add(hit.entityId);
      if (hit.entityType === 'file') {
        selectedFilePaths.add(hit.entityId);
        const f = this.store.getFile(hit.entityId);
        if (f) selectedModuleIds.add(f.moduleId);
      }
    }

    if (selectedModuleIds.size === 0) {
      for (const m of this.store.getAllModules().slice(0, 3)) selectedModuleIds.add(m.moduleId);
    }

    if (classification.scopeLevel !== 'file') {
      for (const modId of Array.from(selectedModuleIds)) {
        const deps = this.impactAnalyzer.findDependencies(modId);
        const dependents = this.impactAnalyzer.findDependents(modId);
        for (const d of deps.directDependencies.slice(0, 3)) selectedModuleIds.add(d);
        if (classification.scopeLevel === 'cross-module' || classification.scopeLevel === 'deep-architecture') {
          for (const d of dependents.directDependents.slice(0, 3)) selectedModuleIds.add(d);
        }
      }
    }

    let deepAnalysisTriggered = classification.deepAnalysisTriggered;
    let deepAnalysisExplanation = classification.deepAnalysisExplanation;

    if (!deepAnalysisTriggered && selectedModuleIds.size >= 4) {
      deepAnalysisTriggered = true;
      deepAnalysisExplanation = `Task spans ${selectedModuleIds.size} interconnected modules (${Array.from(selectedModuleIds).slice(0, 5).join(', ')}). Expanded dependency context automatically.`;
    }

    const overviewObj = {
      projectId: core.projectId,
      projectName: core.projectName,
      purpose: core.projectPurpose,
      techStack: core.mainTechStack as unknown as Record<string, unknown>,
      currentState: core.currentState
    };

    let runningTokens = estimateTokens(JSON.stringify(overviewObj)).estimatedTokens;
    const relevantModules: RelevantContextPackage['relevantModules'] = [];
    const relevantFiles: RelevantContextPackage['relevantFiles'] = [];
    const architecturalDecisions: RelevantContextPackage['architecturalDecisions'] = [];

    for (const modId of selectedModuleIds) {
      const mod = this.store.getModule(modId);
      if (!mod) continue;
      if (mod.verificationStatus !== 'verified') {
        warnings.push(`Module "${mod.moduleId}" has status "${mod.verificationStatus}" (confidence: ${mod.confidence}).`);
      }
      const modEntry = {
        moduleId: mod.moduleId,
        purpose: mod.purpose,
        publicSymbols: mod.publicSymbols.slice(0, 12),
        dependencies: mod.dependencies.slice(0, 10),
        dependents: mod.dependents.slice(0, 10),
        verificationStatus: mod.verificationStatus
      };
      const cost = estimateTokens(JSON.stringify(modEntry)).estimatedTokens;
      if (runningTokens + cost <= budgetTokens * 0.55 || relevantModules.length === 0) {
        relevantModules.push(modEntry);
        runningTokens += cost;
      }
    }

    for (const mod of relevantModules) {
      const modFiles = this.store.getFilesByModule(mod.moduleId);
      for (const mf of modFiles.slice(0, 4)) selectedFilePaths.add(mf.relativePath);
    }

    for (const fPath of selectedFilePaths) {
      const f = this.store.getFile(fPath);
      if (!f) continue;
      const fileEntry = {
        relativePath: f.relativePath,
        role: f.role,
        summary: f.summary,
        exports: f.exports.slice(0, 8),
        verificationStatus: f.verificationStatus
      };
      const cost = estimateTokens(JSON.stringify(fileEntry)).estimatedTokens;
      if (runningTokens + cost <= budgetTokens * 0.85 || relevantFiles.length === 0) {
        relevantFiles.push(fileEntry);
        runningTokens += cost;
      }
    }

    const decisions = this.store.getDecisions();
    for (const dec of decisions) {
      const decEntry = {
        decisionId: dec.decisionId,
        title: dec.title,
        decision: dec.decision,
        verificationStatus: dec.verificationStatus
      };
      const cost = estimateTokens(JSON.stringify(decEntry)).estimatedTokens;
      if (runningTokens + cost <= budgetTokens * 0.95) {
        architecturalDecisions.push(decEntry);
        runningTokens += cost;
      }
    }

    const pkg: RelevantContextPackage = {
      taskId,
      taskDescription: req.taskDescription,
      scopeLevel: classification.scopeLevel,
      retrievalNeeded: true,
      fromCache: false,
      projectOverview: overviewObj,
      relevantModules,
      relevantFiles,
      architecturalDecisions,
      constraints: core.keyConstraints,
      deepAnalysisTriggered,
      deepAnalysisExplanation,
      warnings: Array.from(new Set(warnings)),
      tokenBudget: {
        budgetTokens,
        estimatedTokensUsed: runningTokens,
        isApproximation: true
      }
    };

    const taskRecord: TaskContextRecord = {
      taskId,
      taskDescription: req.taskDescription,
      scopeLevel: classification.scopeLevel,
      relevantFiles: relevantFiles.map((f) => f.relativePath),
      relevantModules: relevantModules.map((m) => m.moduleId),
      retrievedDecisions: architecturalDecisions.map((d) => d.decisionId),
      relatedDependencies: Array.from(new Set(relevantModules.flatMap((m) => m.dependencies))),
      currentChanges: changeCheck.modified,
      potentialImpact: changeCheck.affectedModules,
      contextBudgetTokens: budgetTokens,
      estimatedTokensUsed: runningTokens,
      warnings: pkg.warnings,
      createdAt: new Date().toISOString()
    };
    this.store.saveTaskContext(taskRecord);

    this.store.setCachedRetrieval(
      cacheKey,
      req.taskDescription,
      classification.scopeLevel,
      relevantModules.map((m) => m.moduleId),
      pkg as unknown as Record<string, unknown>
    );

    return pkg;
  }

  public getContextManifest(): Record<string, unknown> {
    const core = this.store.getCoreMemory();
    const modules = this.store.getAllModules();
    const files = this.store.getAllFiles();
    const decisions = this.store.getDecisions();
    const knowledgeItems = this.store.getKnowledgeItems();

    return {
      initialized: Boolean(core),
      projectId: core?.projectId || null,
      projectName: core?.projectName || null,
      currentState: core?.currentState || 'uninitialized',
      counts: {
        modules: modules.length,
        files: files.length,
        decisions: decisions.length,
        knowledgeItems: knowledgeItems.length
      },
      modulesManifest: modules.map((m) => ({
        moduleId: m.moduleId,
        fileCount: m.fileCount,
        verificationStatus: m.verificationStatus,
        fingerprint: m.fingerprint.slice(0, 12)
      }))
    };
  }
}
