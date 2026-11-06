import * as fs from 'fs';
import * as path from 'path';
import {
  PROJECTMIND_VERSION,
  SafeLogger,
  resolveSafeProjectPath,
  isSensitiveOrSecretPath,
  estimateTokens,
  computeSha256,
  KnowledgeItemRecord
} from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIdentityManager } from '@projectmind/core';
import { ProjectIndexer } from '@projectmind/indexing';
import { KnowledgeEngine } from '@projectmind/knowledge';
import { ImpactAnalyzer } from '@projectmind/impact-analysis';
import { KnowledgeRetriever } from '@projectmind/retrieval';
import { ContextEngine } from '@projectmind/context-engine';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export const MCP_SERVER_INSTRUCTIONS =
  'ProjectMind provides persistent local project memory. Workflow: (1) On project tasks, call get_relevant_context (or initialize_project if uninitialized) instead of scanning all files. (2) For module/dependency edits, call get_module_context or analyze_change_impact. (3) After editing files, call sync_changed_files and record_architectural_decision if architecture changed. Skip ProjectMind for generic questions unrelated to the repository.';

export class ProjectMindMcpServer {
  private readonly defaultProjectRoot: string;
  private readonly logger: SafeLogger;
  private readonly storesByRoot = new Map<string, ProjectMemoryStore>();

  constructor(defaultProjectRoot?: string, silentLogger = true) {
    this.defaultProjectRoot = defaultProjectRoot
      ? ProjectIdentityManager.detectProjectRoot(defaultProjectRoot)
      : ProjectIdentityManager.detectProjectRoot(process.cwd());
    this.logger = new SafeLogger('MCPServer', silentLogger);
  }

  private getComponents(projectRootArg?: string): {
    projectRoot: string;
    store: ProjectMemoryStore;
    indexer: ProjectIndexer;
    knowledge: KnowledgeEngine;
    impact: ImpactAnalyzer;
    retriever: KnowledgeRetriever;
    contextEngine: ContextEngine;
    maxOutputChars: number;
  } {
    const resolvedRoot = projectRootArg ? path.resolve(projectRootArg) : this.defaultProjectRoot;
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`Project root does not exist: ${resolvedRoot}`);
    }
    let store = this.storesByRoot.get(resolvedRoot);
    if (!store) {
      store = new ProjectMemoryStore(resolvedRoot);
      ProjectIdentityManager.reconcileMovedProject(store, resolvedRoot);
      this.storesByRoot.set(resolvedRoot, store);
    }
    const config = ProjectIdentityManager.loadConfig(resolvedRoot);
    const indexer = new ProjectIndexer(resolvedRoot, store);
    const knowledge = new KnowledgeEngine(resolvedRoot, store);
    const impact = new ImpactAnalyzer(store);
    const retriever = new KnowledgeRetriever(store);
    const contextEngine = new ContextEngine(store, retriever, impact, indexer);
    return {
      projectRoot: resolvedRoot, store, indexer, knowledge, impact, retriever, contextEngine,
      maxOutputChars: config.maxToolOutputChars
    };
  }

  public listTools(): McpToolDefinition[] {
    return [
      {
        name: 'initialize_project',
        description: 'Initializes ProjectMind persistent memory for an existing codebase (7-stage controlled analysis) or a brand-new project from a prompt/specification.',
        inputSchema: { type: 'object', properties: { projectRoot: { type: 'string' }, mode: { type: 'string', enum: ['auto', 'existing', 'prompt'] }, promptText: { type: 'string' }, projectName: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } } } }
      },
      {
        name: 'get_project_overview',
        description: 'Returns Layer 1 Core Memory: compact project identity, tech stack, purpose, key constraints, module summary, and verification status.',
        inputSchema: { type: 'object', properties: { projectRoot: { type: 'string' }, autoInitialize: { type: 'boolean' } } }
      },
      {
        name: 'get_project_status',
        description: 'Returns current synchronization state, memory database health, schema migration version, file/module counts, and whether unsynchronized file changes exist.',
        inputSchema: { type: 'object', properties: { projectRoot: { type: 'string' } } }
      },
      {
        name: 'detect_project_changes',
        description: 'Compares workspace file SHA-256 fingerprints and Git status against stored memory to detect added, modified, deleted, and renamed files without a full rescan.',
        inputSchema: { type: 'object', properties: { projectRoot: { type: 'string' } } }
      },
      {
        name: 'get_relevant_context',
        description: 'Primary Smart Auto Mode tool: classifies task scope and returns a selective, token-budgeted context package with relevant modules, files, decisions, constraints, and staleness warnings.',
        inputSchema: { type: 'object', properties: { taskDescription: { type: 'string' }, targetFiles: { type: 'array', items: { type: 'string' } }, targetModules: { type: 'array', items: { type: 'string' } }, budgetTokens: { type: 'number' }, forceDeepAnalysis: { type: 'boolean' }, projectRoot: { type: 'string' } }, required: ['taskDescription'] }
      },
      {
        name: 'get_module_context',
        description: 'Retrieves structured Layer 2 knowledge for a specific module, including purpose, entry files, exported symbols, routes, database models, dependencies, dependents, and ADRs.',
        inputSchema: { type: 'object', properties: { moduleId: { type: 'string' }, projectRoot: { type: 'string' } }, required: ['moduleId'] }
      },
      {
        name: 'search_project_knowledge',
        description: 'Searches ProjectMind knowledge base using SQLite FTS5 BM25 ranking and local semantic vector reranking across files, modules, architectural decisions, and knowledge items.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, entityType: { type: 'string', enum: ['file', 'module', 'decision', 'knowledge'] }, limit: { type: 'number' }, projectRoot: { type: 'string' } }, required: ['query'] }
      },
      {
        name: 'find_related_files',
        description: 'Finds files related to a given file path, symbol, or topic through module membership, import relationships, and FTS5 symbol matching.',
        inputSchema: { type: 'object', properties: { queryOrFilePath: { type: 'string' }, limit: { type: 'number' }, projectRoot: { type: 'string' } }, required: ['queryOrFilePath'] }
      },
      {
        name: 'get_file_summary',
        description: 'Returns compact structured metadata for a project file (role, language, SHA-256 fingerprint, exported symbols, imports, verification status) without dumping the entire raw file.',
        inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, projectRoot: { type: 'string' } }, required: ['filePath'] }
      },
      {
        name: 'get_architecture_context',
        description: 'Returns the system-wide architectural overview, module dependency topology, verified API endpoints, database models, constraints, and unverified/planned notices.',
        inputSchema: { type: 'object', properties: { projectRoot: { type: 'string' } } }
      },
      {
        name: 'analyze_change_impact',
        description: 'Analyzes the blast radius of modifying specific files or modules: returns direct and transitive dependents, affected routes/models, risk level, and whether deep analysis is recommended.',
        inputSchema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, projectRoot: { type: 'string' } }, required: ['targets'] }
      },
      {
        name: 'find_dependencies',
        description: 'Returns direct internal module dependencies, transitive module dependencies, and external packages imported by a module or file.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' }, projectRoot: { type: 'string' } }, required: ['target'] }
      },
      {
        name: 'find_dependents',
        description: 'Returns all modules that directly or transitively depend on the specified module or file.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' }, projectRoot: { type: 'string' } }, required: ['target'] }
      },
      {
        name: 'detect_affected_modules',
        description: 'Maps a list of changed file paths to their directly and transitively affected project modules.',
        inputSchema: { type: 'object', properties: { changedPaths: { type: 'array', items: { type: 'string' } }, projectRoot: { type: 'string' } }, required: ['changedPaths'] }
      },
      {
        name: 'get_recent_changes',
        description: 'Returns recent synchronization events, tracked file changes, renamed/deleted files, and recent task context summaries.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' }, projectRoot: { type: 'string' } } }
      },
      {
        name: 'update_project_knowledge',
        description: 'Creates or updates a structured Layer 2 knowledge record with explicit verification status and source references.',
        inputSchema: { type: 'object', properties: { knowledgeId: { type: 'string' }, category: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, sourceFiles: { type: 'array', items: { type: 'string' } }, relatedModules: { type: 'array', items: { type: 'string' } }, verificationStatus: { type: 'string' }, confidence: { type: 'number' }, projectRoot: { type: 'string' } }, required: ['title', 'summary', 'category'] }
      },
      {
        name: 'sync_changed_files',
        description: 'Incrementally synchronizes modified, added, deleted, and renamed files, updates affected modules, transitions planned knowledge to verified when implemented, and invalidates stale cache entries.',
        inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, projectRoot: { type: 'string' } } }
      },
      {
        name: 'record_architectural_decision',
        description: 'Records an explicit Architectural Decision Record (ADR) with context, decision, consequences, constraints, and verification status.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, context: { type: 'string' }, decision: { type: 'string' }, consequences: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } }, relatedModules: { type: 'array', items: { type: 'string' } }, sourceReferences: { type: 'array', items: { type: 'string' } }, verificationStatus: { type: 'string' }, projectRoot: { type: 'string' } }, required: ['title', 'context', 'decision'] }
      },
      {
        name: 'get_project_decisions',
        description: 'Retrieves recorded Architectural Decision Records (ADRs) and project constraints, optionally filtered by module.',
        inputSchema: { type: 'object', properties: { moduleId: { type: 'string' }, projectRoot: { type: 'string' } } }
      },
      {
        name: 'estimate_context_tokens',
        description: 'Estimates approximate token consumption for a text payload or set of project files/modules so the agent can respect context budgets.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, projectRoot: { type: 'string' } } }
      },
      {
        name: 'get_compact_context',
        description: 'Returns an ultra-compact context digest (<800 tokens) summarizing project identity, module map, constraints, and active warnings.',
        inputSchema: { type: 'object', properties: { maxTokens: { type: 'number' }, projectRoot: { type: 'string' } } }
      },
      {
        name: 'get_context_manifest',
        description: 'Returns the lightweight index manifest (module fingerprints, verification statuses, entity counts, and current memory state).',
        inputSchema: { type: 'object', properties: { projectRoot: { type: 'string' } } }
      }
    ];
  }

  public callTool(name: string, args: Record<string, unknown> = {}): McpToolResponse {
    try {
      const projectRootArg = typeof args.projectRoot === 'string' ? args.projectRoot : undefined;
      const ctx = this.getComponents(projectRootArg);
      let result: Record<string, unknown>;

      switch (name) {
        case 'initialize_project': {
          const mode = String(args.mode || 'auto');
          const promptText = typeof args.promptText === 'string' ? args.promptText.trim() : '';
          if (mode === 'prompt' || (mode === 'auto' && promptText.length > 0)) {
            if (!promptText) throw new Error('initialize_project in prompt mode requires non-empty promptText');
            const initRes = ctx.knowledge.initializeFromPrompt({
              projectName: typeof args.projectName === 'string' ? args.projectName : undefined,
              promptText,
              requirements: Array.isArray(args.requirements) ? args.requirements.map(String) : undefined,
              constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : undefined
            });
            result = { mode: 'prompt', ...initRes };
          } else {
            const report = ctx.indexer.bootstrapProject();
            result = { mode: 'existing', ...report };
          }
          break;
        }
        case 'get_project_overview': {
          let core = ctx.store.getCoreMemory();
          if (!core && args.autoInitialize !== false) {
            ctx.indexer.bootstrapProject();
            core = ctx.store.getCoreMemory();
          }
          if (!core) {
            result = { initialized: false, message: 'ProjectMind is not initialized for this repository. Call initialize_project first.' };
          } else {
            const modules = ctx.store.getAllModules();
            result = {
              initialized: true,
              coreMemory: core,
              modulesSummary: modules.map((m) => ({
                moduleId: m.moduleId, purpose: m.purpose, fileCount: m.fileCount, verificationStatus: m.verificationStatus
              }))
            };
          }
          break;
        }
        case 'get_project_status': {
          const core = ctx.store.getCoreMemory();
          const migrations = ctx.store.getAppliedMigrations();
          const changes = core ? ctx.indexer.detectProjectChanges() : null;
          result = {
            initialized: Boolean(core),
            projectRoot: ctx.projectRoot,
            projectId: core?.projectId || null,
            currentState: core?.currentState || 'uninitialized',
            recoveredFromCorruption: ctx.store.recoveredFromCorruption,
            schemaVersion: migrations.length > 0 ? migrations[migrations.length - 1].version : 0,
            counts: {
              files: ctx.store.getAllFiles().length,
              modules: ctx.store.getAllModules().length,
              decisions: ctx.store.getDecisions().length,
              knowledgeItems: ctx.store.getKnowledgeItems().length
            },
            pendingChanges: changes
              ? {
                  hasChanges: changes.hasChanges,
                  addedCount: changes.added.length,
                  modifiedCount: changes.modified.length,
                  deletedCount: changes.deleted.length,
                  renamedCount: changes.renamed.length,
                  affectedModules: changes.affectedModules
                }
              : null
          };
          break;
        }
        case 'detect_project_changes': {
          result = ctx.indexer.detectProjectChanges() as unknown as Record<string, unknown>;
          break;
        }
        case 'get_relevant_context': {
          if (typeof args.taskDescription !== 'string' || !args.taskDescription.trim()) {
            throw new Error('Validation error: taskDescription is required and must be a non-empty string.');
          }
          if (!ctx.store.getCoreMemory()) ctx.indexer.bootstrapProject();
          const targetFiles = Array.isArray(args.targetFiles) ? args.targetFiles.map(String) : undefined;
          if (targetFiles) {
            for (const tf of targetFiles) resolveSafeProjectPath(ctx.projectRoot, tf);
          }
          const pkg = ctx.contextEngine.getRelevantContext({
            taskDescription: args.taskDescription,
            targetFiles,
            targetModules: Array.isArray(args.targetModules) ? args.targetModules.map(String) : undefined,
            budgetTokens: typeof args.budgetTokens === 'number' ? args.budgetTokens : undefined,
            forceDeepAnalysis: Boolean(args.forceDeepAnalysis)
          });
          result = pkg as unknown as Record<string, unknown>;
          break;
        }
        case 'get_module_context': {
          if (typeof args.moduleId !== 'string' || !args.moduleId.trim()) throw new Error('Validation error: moduleId is required.');
          const modCtx = ctx.retriever.getModuleContext(args.moduleId.trim());
          if (!modCtx.module) {
            result = { found: false, moduleId: args.moduleId, availableModules: ctx.store.getAllModules().map((m) => m.moduleId) };
          } else {
            result = {
              found: true,
              module: modCtx.module,
              files: modCtx.files.map((f) => ({
                relativePath: f.relativePath, role: f.role, summary: f.summary, exports: f.exports, verificationStatus: f.verificationStatus
              })),
              decisions: modCtx.decisions
            };
          }
          break;
        }
        case 'search_project_knowledge': {
          if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('Validation error: query is required.');
          const limit = Math.min(50, Math.max(1, Number(args.limit || 12)));
          const entityType = typeof args.entityType === 'string' ? (args.entityType as 'file' | 'module' | 'decision' | 'knowledge') : undefined;
          const hits = ctx.retriever.searchKnowledge(args.query, { limit, entityType });
          result = { query: args.query, count: hits.length, results: hits };
          break;
        }
        case 'find_related_files': {
          if (typeof args.queryOrFilePath !== 'string' || !args.queryOrFilePath.trim()) throw new Error('Validation error: queryOrFilePath is required.');
          const limit = Math.min(30, Math.max(1, Number(args.limit || 10)));
          const related = ctx.retriever.findRelatedFiles(args.queryOrFilePath.trim(), limit);
          result = { queryOrFilePath: args.queryOrFilePath, count: related.length, relatedFiles: related };
          break;
        }
        case 'get_file_summary': {
          if (typeof args.filePath !== 'string' || !args.filePath.trim()) throw new Error('Validation error: filePath is required.');
          resolveSafeProjectPath(ctx.projectRoot, args.filePath);
          if (isSensitiveOrSecretPath(args.filePath)) throw new Error(`Security policy: access to sensitive or secret file "${args.filePath}" is forbidden.`);
          const norm = args.filePath.replace(/\\/g, '/').replace(/^\.\//, '');
          const fileRec = ctx.store.getFile(norm);
          result = fileRec ? { found: true, file: fileRec } : { found: false, filePath: norm, message: 'File is not in ProjectMind index.' };
          break;
        }
        case 'get_architecture_context': {
          const core = ctx.store.getCoreMemory();
          const modules = ctx.store.getAllModules();
          const decisions = ctx.store.getDecisions();
          const items = ctx.store.getKnowledgeItems();
          result = {
            initialized: Boolean(core),
            architecturalSummary: core?.architecturalSummary || '',
            techStack: core?.mainTechStack || {},
            keyConstraints: core?.keyConstraints || [],
            currentState: core?.currentState || 'uninitialized',
            moduleTopology: modules.map((m) => ({
              moduleId: m.moduleId, purpose: m.purpose, dependencies: m.dependencies, dependents: m.dependents,
              routesCount: m.routes.length, modelsCount: m.models.length, verificationStatus: m.verificationStatus
            })),
            decisions: decisions.slice(0, 10),
            knowledgeHighlights: items.map((i) => ({
              knowledgeId: i.knowledgeId, category: i.category, title: i.title, summary: i.summary,
              verificationStatus: i.verificationStatus, confidence: i.confidence
            }))
          };
          break;
        }
        case 'analyze_change_impact': {
          if (!Array.isArray(args.targets) || args.targets.length === 0) throw new Error('Validation error: targets must be a non-empty array.');
          const targets = args.targets.map(String);
          for (const t of targets) {
            if (t.includes('..') || path.isAbsolute(t)) resolveSafeProjectPath(ctx.projectRoot, t);
          }
          result = ctx.impact.analyzeChangeImpact(targets) as unknown as Record<string, unknown>;
          break;
        }
        case 'find_dependencies': {
          if (typeof args.target !== 'string' || !args.target.trim()) throw new Error('Validation error: target is required.');
          result = ctx.impact.findDependencies(args.target.trim()) as unknown as Record<string, unknown>;
          break;
        }
        case 'find_dependents': {
          if (typeof args.target !== 'string' || !args.target.trim()) throw new Error('Validation error: target is required.');
          result = ctx.impact.findDependents(args.target.trim()) as unknown as Record<string, unknown>;
          break;
        }
        case 'detect_affected_modules': {
          if (!Array.isArray(args.changedPaths)) throw new Error('Validation error: changedPaths must be an array.');
          result = ctx.impact.detectAffectedModules(args.changedPaths.map(String)) as unknown as Record<string, unknown>;
          break;
        }
        case 'get_recent_changes': {
          const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
          result = { recentSyncEvents: ctx.store.getRecentSyncEvents(limit), recentTasks: ctx.store.getRecentTaskContexts(5) };
          break;
        }
        case 'update_project_knowledge': {
          if (typeof args.title !== 'string' || typeof args.summary !== 'string' || typeof args.category !== 'string') {
            throw new Error('Validation error: title, summary, and category are required.');
          }
          const knowledgeId = typeof args.knowledgeId === 'string' && args.knowledgeId.trim() ? args.knowledgeId.trim() : `ki_${computeSha256(args.title).slice(0, 10)}`;
          const verificationStatus = (args.verificationStatus as KnowledgeItemRecord['verificationStatus']) || 'inferred';
          const item: KnowledgeItemRecord = {
            knowledgeId,
            category: args.category as KnowledgeItemRecord['category'],
            title: args.title,
            summary: args.summary,
            details: (args.details as Record<string, unknown>) || {},
            sourceFiles: Array.isArray(args.sourceFiles) ? args.sourceFiles.map(String) : [],
            relatedModules: Array.isArray(args.relatedModules) ? args.relatedModules.map(String) : ['root'],
            verificationStatus,
            confidence: typeof args.confidence === 'number' ? args.confidence : verificationStatus === 'verified' ? 1.0 : 0.8,
            version: 1,
            lastVerifiedAt: new Date().toISOString()
          };
          ctx.store.upsertKnowledgeItemsBatch([item]);
          ctx.store.invalidateCacheForModules(item.relatedModules);
          result = { updated: true, item };
          break;
        }
        case 'sync_changed_files': {
          const explicitFiles = Array.isArray(args.files) ? args.files.map(String) : undefined;
          if (explicitFiles) {
            for (const f of explicitFiles) resolveSafeProjectPath(ctx.projectRoot, f);
          }
          result = ctx.indexer.syncChangedFiles(explicitFiles) as unknown as Record<string, unknown>;
          break;
        }
        case 'record_architectural_decision': {
          if (typeof args.title !== 'string' || typeof args.context !== 'string' || typeof args.decision !== 'string') {
            throw new Error('Validation error: title, context, and decision are required strings.');
          }
          const adr = ctx.knowledge.recordArchitecturalDecision({
            title: args.title, context: args.context, decision: args.decision,
            consequences: Array.isArray(args.consequences) ? args.consequences.map(String) : [],
            constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
            relatedModules: Array.isArray(args.relatedModules) ? args.relatedModules.map(String) : ['root'],
            sourceReferences: Array.isArray(args.sourceReferences) ? args.sourceReferences.map(String) : [],
            verificationStatus: (args.verificationStatus as 'verified' | 'planned' | 'inferred') || 'verified'
          });
          result = { recorded: true, decision: adr };
          break;
        }
        case 'get_project_decisions': {
          const moduleId = typeof args.moduleId === 'string' ? args.moduleId : undefined;
          const decisions = ctx.store.getDecisions(moduleId);
          const core = ctx.store.getCoreMemory();
          result = { count: decisions.length, keyConstraints: core?.keyConstraints || [], decisions };
          break;
        }
        case 'estimate_context_tokens': {
          const text = typeof args.text === 'string' ? args.text : '';
          const filePaths = Array.isArray(args.filePaths) ? args.filePaths.map(String) : [];
          const fileComparisons = [];
          for (const fp of filePaths) {
            const safeAbs = resolveSafeProjectPath(ctx.projectRoot, fp);
            const norm = fp.replace(/\\/g, '/').replace(/^\.\//, '');
            const rec = ctx.store.getFile(norm);
            let rawTokens = 0;
            if (fs.existsSync(safeAbs) && fs.statSync(safeAbs).isFile()) {
              rawTokens = estimateTokens(fs.readFileSync(safeAbs, 'utf8')).estimatedTokens;
            }
            const summaryTokens = rec ? estimateTokens(JSON.stringify({ summary: rec.summary, symbols: rec.symbols, exports: rec.exports })).estimatedTokens : 0;
            const savings = rawTokens > 0 ? Math.max(0, Math.round(((rawTokens - summaryTokens) / rawTokens) * 100)) : 0;
            fileComparisons.push({ filePath: norm, rawFileTokens: rawTokens, projectMindSummaryTokens: summaryTokens, tokenSavingsPercent: savings });
          }
          result = { textEstimate: estimateTokens(text), fileComparisons };
          break;
        }
        case 'get_compact_context': {
          const core = ctx.store.getCoreMemory();
          const modules = ctx.store.getAllModules();
          const decisions = ctx.store.getDecisions();
          const compact = {
            projectId: core?.projectId || null,
            projectName: core?.projectName || path.basename(ctx.projectRoot),
            state: core?.currentState || 'uninitialized',
            purpose: core?.projectPurpose || '',
            techStack: core?.mainTechStack || {},
            constraints: (core?.keyConstraints || []).slice(0, 6),
            modules: modules.slice(0, 15).map((m) => ({ id: m.moduleId, purpose: m.purpose.slice(0, 110), deps: m.dependencies.slice(0, 5), status: m.verificationStatus })),
            recentDecisions: decisions.slice(0, 4).map((d) => ({ title: d.title, decision: d.decision.slice(0, 120) }))
          };
          result = { ...compact, tokenEstimate: estimateTokens(JSON.stringify(compact)) };
          break;
        }
        case 'get_context_manifest': {
          result = ctx.contextEngine.getContextManifest();
          break;
        }
        default:
          throw new Error(`Unknown MCP tool: ${name}`);
      }

      let serialized = JSON.stringify(result, null, 2);
      if (serialized.length > ctx.maxOutputChars) {
        const truncatedObj = {
          truncated: true,
          maxOutputChars: ctx.maxOutputChars,
          originalChars: serialized.length,
          summaryPreview: serialized.slice(0, ctx.maxOutputChars - 350) + '\n...[TRUNCATED BY PROJECTMIND OUTPUT LIMIT]'
        };
        serialized = JSON.stringify(truncatedObj, null, 2);
        return { content: [{ type: 'text', text: serialized }], structuredContent: truncatedObj };
      }

      return { content: [{ type: 'text', text: serialized }], structuredContent: result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool execution error in ${name}: ${errorMsg}`);
      const errObj = { error: true, tool: name, message: errorMsg };
      return { content: [{ type: 'text', text: JSON.stringify(errObj, null, 2) }], structuredContent: errObj, isError: true };
    }
  }

  public handleJsonRpcRequest(request: {
    jsonrpc?: string;
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
  }): Record<string, unknown> | null {
    const { id, method, params } = request;
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;

    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'projectmind-mcp-server', version: PROJECTMIND_VERSION },
            instructions: MCP_SERVER_INSTRUCTIONS
          }
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id: id ?? null, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id: id ?? null, result: { tools: this.listTools() } };
      if (method === 'tools/call') {
        const toolName = String(params?.name || '');
        const toolArgs = (params?.arguments as Record<string, unknown>) || {};
        return { jsonrpc: '2.0', id: id ?? null, result: this.callTool(toolName, toolArgs) };
      }
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (err) {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
    }
  }
}
