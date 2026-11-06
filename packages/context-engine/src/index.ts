import {
  TaskScopeLevel,
  TaskContextRecord,
  RetrievalHit,
  estimateTokens,
  computeSha256,
  PARSER_VERSION,
  RETRIEVAL_VERSION,
  EMBEDDING_MODEL
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
  /** ISO timestamp or git commit-ish label for historical ("as of") retrieval. */
  asOf?: string;
  /** Namespace of the caller; gate access to agent/user/branch private memory. */
  viewerNamespace?: string;
}

export interface ContextSnapshotInfo {
  snapshotId: string;
  aggregateHash: string;
  gitHead?: string;
  gitBranch?: string;
  generatedAt: string;
  stale: boolean;
  pendingChanges: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
  };
}

export interface ContextContract {
  contractVersion: string;
  parserVersion: string;
  retrievalVersion: string;
  embedderVersion: string;
  snapshotId: string;
  /** True when the workspace changed after the index; callers must sync before writing. */
  mustSyncBeforeEdit: boolean;
  asOf?: string;
  notes: string[];
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
  snapshot: ContextSnapshotInfo;
  contextContract: ContextContract;
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
    sha256?: string;
    lineCount?: number;
    parserVersion?: string;
  }>;
  architecturalDecisions: Array<{
    decisionId: string;
    title: string;
    decision: string;
    verificationStatus: string;
    why?: string;
  }>;
  constraints: string[];
  retrieval: Array<{
    entityId: string;
    entityType: string;
    title: string;
    score: number;
    why: string;
    evidence: Array<{ kind: string; path?: string; lineStart?: number; lineEnd?: number; detail: string }>;
  }>;
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

    // 1. Detect workspace changes BEFORE considering any cache entry. This is
    // the core freshness guarantee: a stale context package must never be
    // returned silently after the repository changed.
    const changeCheck = this.indexer.detectProjectChanges();
    const stale = changeCheck.hasChanges;
    const snapshot: ContextSnapshotInfo = {
      snapshotId: changeCheck.snapshotId,
      aggregateHash: changeCheck.aggregateHash,
      gitHead: changeCheck.gitHeadCommit,
      gitBranch: changeCheck.gitBranch,
      generatedAt: new Date().toISOString(),
      stale,
      pendingChanges: {
        added: changeCheck.added.length,
        modified: changeCheck.modified.length,
        deleted: changeCheck.deleted.length,
        renamed: changeCheck.renamed.length
      }
    };
    const taskId = `task_${computeSha256(
      JSON.stringify({
        q: req.taskDescription.trim(),
        files: req.targetFiles || [],
        mods: req.targetModules || [],
        scope: classification.scopeLevel,
        snapshot: changeCheck.snapshotId,
        asOf: req.asOf || ''
      })
    ).slice(0, 12)}`;

    const emptyContract: ContextContract = {
      contractVersion: 'projectmind-context-v2',
      parserVersion: PARSER_VERSION,
      retrievalVersion: RETRIEVAL_VERSION,
      embedderVersion: EMBEDDING_MODEL,
      snapshotId: changeCheck.snapshotId,
      mustSyncBeforeEdit: stale,
      asOf: req.asOf,
      notes: []
    };

    if (classification.scopeLevel === 'none') {
      return {
        taskId, taskDescription: req.taskDescription, scopeLevel: 'none', retrievalNeeded: false, fromCache: false,
        snapshot, contextContract: emptyContract,
        relevantModules: [], relevantFiles: [], architecturalDecisions: [], constraints: [], retrieval: [],
        deepAnalysisTriggered: false, warnings: [],
        tokenBudget: { budgetTokens, estimatedTokensUsed: 0, isApproximation: true }
      };
    }

    const cacheable = !req.forceDeepAnalysis && !req.asOf && !stale;
    const cacheKey = computeSha256(
      JSON.stringify({
        v: RETRIEVAL_VERSION,
        parser: PARSER_VERSION,
        embedder: EMBEDDING_MODEL,
        snapshot: changeCheck.snapshotId,
        q: req.taskDescription.trim().toLowerCase(),
        files: req.targetFiles || [],
        mods: req.targetModules || [],
        scope: classification.scopeLevel,
        budget: budgetTokens,
        viewer: req.viewerNamespace || 'project/shared'
      })
    );

    if (cacheable) {
      const entry = this.store.getRetrievalCacheEntry(cacheKey);
      if (entry && entry.snapshotId === changeCheck.snapshotId &&
          entry.parserVersion === PARSER_VERSION &&
          entry.retrievalVersion === RETRIEVAL_VERSION &&
          entry.embedderVersion === EMBEDDING_MODEL) {
        return { ...(entry.response as unknown as RelevantContextPackage), fromCache: true };
      }
      if (entry) this.store.invalidateAllCache();
    } else if (stale) {
      // Old entries were produced for a different tree state; drop them so no
      // other query can resurrect them before the next successful sync.
      this.store.invalidateCacheForModules(changeCheck.affectedModules);
    }

    const core = this.store.getCoreMemory();
    const warnings: string[] = [];

    if (!core) {
      warnings.push('ProjectMind memory is not initialized yet. Run initialize_project first.');
      return {
        taskId, taskDescription: req.taskDescription, scopeLevel: classification.scopeLevel,
        retrievalNeeded: true, fromCache: false, snapshot, contextContract: emptyContract,
        relevantModules: [], relevantFiles: [],
        architecturalDecisions: [], constraints: [], retrieval: [], deepAnalysisTriggered: false, warnings,
        tokenBudget: { budgetTokens, estimatedTokensUsed: 25, isApproximation: true }
      };
    }

    if (stale) {
      warnings.push(
        `Detected ${changeCheck.added.length + changeCheck.modified.length + changeCheck.deleted.length + changeCheck.renamed.length} unsynchronized workspace change(s) affecting module(s): ${changeCheck.affectedModules.join(', ')}. Context is marked STALE; run sync_changed_files before editing.`
      );
    }

    if (core.currentState === 'planned_from_prompt') {
      warnings.push(
        'Project knowledge contains PLANNED specifications from the initial project prompt. Planned modules and requirements are not yet verified implementation facts.'
      );
    }

    if (req.asOf) {
      warnings.push(`Historical retrieval requested as of "${req.asOf}". Only memories with validity overlapping that point are returned.`);
    }

    const hits: RetrievalHit[] = this.retriever.searchKnowledge(req.taskDescription, {
      limit: classification.scopeLevel === 'deep-architecture' ? 20 : 10,
      asOf: req.asOf,
      viewerNamespace: req.viewerNamespace
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
        verificationStatus: f.verificationStatus,
        sha256: f.fullSha256 || f.sha256,
        lineCount: f.lineCount,
        parserVersion: f.parserVersion
      };
      const cost = estimateTokens(JSON.stringify(fileEntry)).estimatedTokens;
      if (runningTokens + cost <= budgetTokens * 0.85 || relevantFiles.length === 0) {
        relevantFiles.push(fileEntry);
        runningTokens += cost;
      }
    }

    // Decisions: superseded/outdated records are excluded by the store unless
    // an explicit historical query is requested.
    const decisions = this.store.getDecisions(undefined, { asOf: req.asOf });
    const hitById = new Map(hits.map((h) => [`${h.entityType}:${h.entityId}`, h]));
    for (const dec of decisions.slice(0, 8)) {
      const decEntry = {
        decisionId: dec.decisionId,
        title: dec.title,
        decision: dec.decision,
        verificationStatus: dec.verificationStatus,
        why: hitById.get(`decision:${dec.decisionId}`)?.why || 'Project-wide architectural decision'
      };
      const cost = estimateTokens(JSON.stringify(decEntry)).estimatedTokens;
      if (runningTokens + cost <= budgetTokens * 0.95) {
        architecturalDecisions.push(decEntry);
        runningTokens += cost;
      }
    }

    const retrieval = hits.map((h) => ({
      entityId: h.entityId,
      entityType: h.entityType,
      title: h.title,
      score: h.score,
      why: h.why,
      evidence: h.evidence.map((e) => ({ kind: e.kind, path: e.path, lineStart: e.lineStart, lineEnd: e.lineEnd, detail: e.detail }))
    }));

    const contract: ContextContract = {
      ...emptyContract,
      notes: [
        'Context is bound to the snapshotId above; reject or refresh it if the workspace changes.',
        'Every retrieval hit carries matched terms and evidence pointers.'
      ]
    };

    const pkg: RelevantContextPackage = {
      taskId,
      taskDescription: req.taskDescription,
      scopeLevel: classification.scopeLevel,
      retrievalNeeded: true,
      fromCache: false,
      projectOverview: overviewObj,
      snapshot,
      contextContract: contract,
      relevantModules,
      relevantFiles,
      architecturalDecisions,
      constraints: core.keyConstraints,
      retrieval,
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
      createdAt: new Date().toISOString(),
      snapshotId: changeCheck.snapshotId
    };
    this.store.saveTaskContext(taskRecord);

    if (cacheable) {
      this.store.setCachedRetrieval(
        cacheKey,
        req.taskDescription,
        classification.scopeLevel,
        relevantModules.map((m) => m.moduleId),
        pkg as unknown as Record<string, unknown>,
        {
          snapshotId: changeCheck.snapshotId,
          parserVersion: PARSER_VERSION,
          retrievalVersion: RETRIEVAL_VERSION,
          embedderVersion: EMBEDDING_MODEL
        }
      );
    }

    return pkg;
  }

  public getContextManifest(): Record<string, unknown> {
    const core = this.store.getCoreMemory();
    const modules = this.store.getAllModules();
    const files = this.store.getAllFiles();
    const decisions = this.store.getDecisions();
    const knowledgeItems = this.store.getKnowledgeItems();
    const manifest = this.store.getIndexManifest();
    const health = this.store.getHealthReport();

    return {
      initialized: Boolean(core),
      projectId: core?.projectId || null,
      projectName: core?.projectName || null,
      currentState: core?.currentState || 'uninitialized',
      counts: {
        modules: modules.length,
        files: files.length,
        decisions: decisions.length,
        knowledgeItems: knowledgeItems.length,
        memoryEvents: health.stats.events,
        openConflicts: health.stats.conflictsOpen,
        codeSymbols: health.stats.symbols,
        graphEdges: health.stats.graphEdges
      },
      indexManifest: manifest,
      latestSnapshot: health.latestSnapshot,
      eventChainValid: health.eventChain.valid,
      modulesManifest: modules.map((m) => ({
        moduleId: m.moduleId,
        fileCount: m.fileCount,
        verificationStatus: m.verificationStatus,
        fingerprint: m.fingerprint.slice(0, 12)
      }))
    };
  }
}
