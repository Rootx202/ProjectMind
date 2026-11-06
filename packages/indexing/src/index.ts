import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  FileRecord,
  ExtractedSymbol,
  ModuleKnowledgeRecord,
  ApiEndpointRecord,
  DatabaseModelRecord,
  CoreMemoryRecord,
  KnowledgeItemRecord,
  ArchitecturalDecisionRecord,
  WorkspaceSnapshotRecord,
  CodeGraphEdge,
  CodeSymbolRecord,
  FileChunkRecord,
  isSensitiveOrSecretPath,
  sanitizeUntrustedContent,
  resolveSafeProjectPath,
  computeSha256,
  computeAggregateHash,
  hashFileStreaming,
  readFilePrefix,
  stableId,
  MEMORY_SCHEMA_VERSION,
  PARSER_VERSION,
  CHUNKER_VERSION,
  EMBEDDING_MODEL,
  RETRIEVAL_VERSION,
  MAX_ANALYSIS_BYTES
} from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIdentityManager } from '@projectmind/core';
import { parseJavaScriptModule, AstParseResult } from './ast';
import {
  buildResolutionContext,
  resolveImportPath,
  externalPackageName,
  ResolutionContext
} from './resolver';

export interface ProjectChangesReport {
  hasChanges: boolean;
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  unchangedCount: number;
  gitAvailable: boolean;
  gitBranch?: string;
  gitHeadCommit?: string;
  gitDirtyFiles?: string[];
  affectedModules: string[];
  snapshotId: string;
  aggregateHash: string;
  dirty: boolean;
}

export interface BootstrapReport {
  projectId: string;
  projectName: string;
  projectRoot: string;
  stagesCompleted: string[];
  indexedFilesCount: number;
  skippedSecretOrIgnoredCount: number;
  modulesCount: number;
  routesCount: number;
  modelsCount: number;
  decisionsCount: number;
  verifiedFactsCount: number;
  inferredItemsCount: number;
  uncertainItems: string[];
  snapshotId: string;
  parseFailures: string[];
  truncatedFiles: string[];
  durationMs: number;
}

interface WorkspaceFileEntry {
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  fullSha256: string;
}

interface FileAnalysis {
  fileRecord: FileRecord;
  routes: ApiEndpointRecord[];
  models: DatabaseModelRecord[];
  edges: CodeGraphEdge[];
  symbols: CodeSymbolRecord[];
  chunks: FileChunkRecord[];
}

const MAX_SELECTIVE_READ_BYTES = 256 * 1024; // legacy prefix size retained for compatibility

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.sql': 'sql', '.prisma': 'prisma', '.graphql': 'graphql', '.gql': 'graphql',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown'
};

export class ProjectIndexer {
  private readonly projectRoot: string;
  private readonly store: ProjectMemoryStore;

  constructor(projectRoot: string, store: ProjectMemoryStore) {
    this.projectRoot = path.resolve(projectRoot);
    this.store = store;
  }

  private resolutionContext: ResolutionContext | null = null;
  private lastInspection: { snapshot: WorkspaceSnapshotRecord; entries: WorkspaceFileEntry[] } | null = null;

  public computeWorkspaceSnapshot(): WorkspaceSnapshotRecord {
    return this.inspectWorkspace().snapshot;
  }

  private inspectWorkspace(discoveredFiles?: string[]): {
    snapshot: WorkspaceSnapshotRecord;
    entries: WorkspaceFileEntry[];
  } {
    const files = discoveredFiles || this.discoverProjectFiles(this.loadIgnoreRules(), 5000).discoveredFiles;
    const gitInfo = this.getGitRepositoryInfo();
    const core = this.store.getCoreMemory();
    const projectId = core?.projectId || ProjectIdentityManager.getOrCreateProjectId(this.projectRoot).projectId;
    const entries: WorkspaceFileEntry[] = [];

    for (const relPath of files) {
      let fullPath: string;
      try {
        fullPath = resolveSafeProjectPath(this.projectRoot, relPath);
      } catch (_) {
        continue;
      }
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      let hashed;
      try {
        hashed = hashFileStreaming(fullPath);
      } catch (_) {
        continue;
      }
      entries.push({
        relativePath: relPath,
        sizeBytes: hashed.sizeBytes,
        mtimeMs: stat.mtimeMs,
        fullSha256: hashed.sha256
      });
    }

    const aggregateHash = computeAggregateHash(entries.map((e) => ({ path: e.relativePath, sha256: e.fullSha256 })));
    const snapshot: WorkspaceSnapshotRecord = {
      snapshotId: stableId('snap', projectId, aggregateHash, gitInfo.headCommit || ''),
      projectId,
      gitHead: gitInfo.headCommit,
      gitBranch: gitInfo.branch,
      aggregateHash,
      fileCount: entries.length,
      dirty: Boolean(gitInfo.dirtyFiles && gitInfo.dirtyFiles.length > 0),
      createdAt: new Date().toISOString()
    };
    this.store.saveWorkspaceSnapshot(snapshot);
    this.lastInspection = { snapshot, entries };
    return { snapshot, entries };
  }

  private getResolutionContext(discoveredFiles: string[]): ResolutionContext {
    const known = new Set<string>(discoveredFiles);
    for (const f of this.store.getAllFiles()) known.add(f.relativePath);
    this.resolutionContext = buildResolutionContext(this.projectRoot, Array.from(known));
    return this.resolutionContext;
  }

  private buildChunks(
    relativePath: string,
    hash: ReturnType<typeof hashFileStreaming>,
    content: string,
    contentTruncated: boolean
  ): FileChunkRecord[] {
    const newlineOffsets: number[] = [];
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) newlineOffsets.push(i);
    }
    const lineAtByte = (byteOffset: number): number | undefined => {
      if (contentTruncated && byteOffset > Buffer.byteLength(content, 'utf8')) return undefined;
      let lo = 0;
      let hi = newlineOffsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (newlineOffsets[mid] < byteOffset) lo = mid + 1;
        else hi = mid;
      }
      return lo + 1;
    };
    return hash.chunks.map((chunk) => ({
      relativePath,
      chunkIndex: chunk.chunkIndex,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      startLine: lineAtByte(chunk.startByte),
      endLine: lineAtByte(Math.max(chunk.startByte, chunk.endByte - 1)),
      sha256: chunk.sha256
    }));
  }

  public bootstrapProject(options?: { maxFiles?: number; cancellationToken?: { cancelled: boolean } }): BootstrapReport {
    const startTime = Date.now();
    const stagesCompleted: string[] = [];
    const uncertainItems: string[] = [];
    const parseFailures: string[] = [];
    const truncatedFiles: string[] = [];

    const { projectId, movedFrom } = ProjectIdentityManager.getOrCreateProjectId(this.projectRoot);
    const techMeta = this.detectTechStackAndMetadata();
    stagesCompleted.push('1. Project metadata');

    const ignoreRules = this.loadIgnoreRules();
    const { discoveredFiles, skippedCount } = this.discoverProjectFiles(ignoreRules, options?.maxFiles || 2500);
    stagesCompleted.push('2. File and directory inventory');

    if (options?.cancellationToken?.cancelled) throw new Error('Bootstrap cancelled by caller');

    const discoveredSet = new Set(discoveredFiles);
    const staleFiles = this.store.getAllFiles()
      .filter((f) => !discoveredSet.has(f.relativePath))
      .map((f) => f.relativePath);
    if (staleFiles.length > 0) this.store.deleteFilesBatch(staleFiles);
    const currentModuleIds = new Set(discoveredFiles.map((f) => this.inferModuleId(f)));
    const staleModules = this.store.getAllModules()
      .filter((m) => !currentModuleIds.has(m.moduleId))
      .map((m) => m.moduleId);
    if (staleModules.length > 0) this.store.deleteModulesBatch(staleModules);

    const entryPoints = discoveredFiles.filter((f) => this.classifyFileRole(f) === 'entrypoint');
    const configFiles = discoveredFiles.filter((f) => this.classifyFileRole(f) === 'config');
    if (entryPoints.length === 0) {
      uncertainItems.push('No canonical entrypoint file was verified; entrypoints may be dynamically configured.');
    }
    stagesCompleted.push('3. Configuration and entry points');

    const docData = this.extractDocumentationAndDecisions(discoveredFiles);
    stagesCompleted.push('4. Important architectural files');

    const moduleMap = new Map<string, string[]>();
    for (const relPath of discoveredFiles) {
      const modId = this.inferModuleId(relPath);
      const list = moduleMap.get(modId) || [];
      list.push(relPath);
      moduleMap.set(modId, list);
    }
    stagesCompleted.push('5. Dependency and module discovery');

    const inspection = this.inspectWorkspace(discoveredFiles);
    const resolution = this.getResolutionContext(discoveredFiles);
    const fullHashes = new Map(inspection.entries.map((e) => [e.relativePath, e.fullSha256]));

    const analyses: FileAnalysis[] = [];
    const allRoutes: ApiEndpointRecord[] = [];
    const allModels: DatabaseModelRecord[] = [];

    for (const relPath of discoveredFiles) {
      if (options?.cancellationToken?.cancelled) throw new Error('Bootstrap cancelled by caller');
      const analysis = this.analyzeSingleFile(relPath, resolution, fullHashes.get(relPath));
      if (!analysis) continue;
      analyses.push(analysis);
      allRoutes.push(...analysis.routes);
      allModels.push(...analysis.models);
      if (analysis.fileRecord.analysisStatus === 'truncated') truncatedFiles.push(relPath);
      if (analysis.fileRecord.analysisStatus === 'failed') parseFailures.push(relPath);
    }
    const fileRecords = analyses.map((a) => a.fileRecord);
    stagesCompleted.push('6. Selective source analysis');

    const modules = this.buildModuleKnowledgeRecords(moduleMap, fileRecords, allRoutes, allModels, techMeta.dependencies);
    const gitInfo = this.getGitRepositoryInfo();

    const coreMemory: CoreMemoryRecord = {
      projectId,
      projectName: techMeta.projectName,
      projectRoot: this.projectRoot,
      previousRoots: movedFrom ? [movedFrom] : [],
      mainTechStack: {
        languages: techMeta.languages,
        frameworks: techMeta.frameworks,
        packageManager: techMeta.packageManager,
        runtime: techMeta.runtime,
        database: techMeta.databases
      },
      projectPurpose: docData.purpose || techMeta.description || `Software project ${techMeta.projectName}`,
      keyConstraints: docData.constraints,
      architecturalSummary: this.synthesizeArchitecturalSummary(techMeta, modules, allRoutes, allModels),
      currentState: 'bootstrapped',
      memorySchemaVersion: MEMORY_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastVerifiedCommit: gitInfo.headCommit
    };

    this.store.saveCoreMemory(coreMemory);
    this.store.upsertFilesBatch(fileRecords);
    this.store.upsertModulesBatch(modules);
    for (const dec of docData.decisions) {
      this.store.upsertDecision(dec);
    }

    const graphPaths = analyses.map((a) => a.fileRecord.relativePath);
    const edges = analyses.flatMap((a) => a.edges);
    const symbols = analyses.flatMap((a) => a.symbols);
    const chunks = analyses.flatMap((a) => a.chunks);
    this.store.replaceCodeGraphForFiles(graphPaths, edges, symbols);
    this.store.replaceFileChunksForFiles(graphPaths, chunks);

    const knowledgeItems = this.buildKnowledgeItems(coreMemory, modules, allRoutes, allModels, configFiles, docData.conventions, uncertainItems);
    this.store.upsertKnowledgeItemsBatch(knowledgeItems, {
      actorType: 'system',
      actorId: 'system/indexer',
      snapshotId: inspection.snapshot.snapshotId
    });

    this.store.setIndexManifest({
      projectId,
      snapshotId: inspection.snapshot.snapshotId,
      aggregateHash: inspection.snapshot.aggregateHash,
      fileCount: fileRecords.length,
      parserVersion: PARSER_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      embedderVersion: EMBEDDING_MODEL,
      retrievalVersion: RETRIEVAL_VERSION,
      createdAt: new Date().toISOString()
    });

    const memoryEvent = this.store.recordMemoryEvent({
      projectId,
      repositoryId: this.projectRoot,
      branch: gitInfo.branch || '',
      baseCommit: gitInfo.headCommit,
      snapshotId: inspection.snapshot.snapshotId,
      actorType: 'system',
      actorId: 'system/indexer',
      namespace: 'project/shared',
      operation: 'sync',
      entityType: 'project',
      entityId: projectId,
      payload: {
        event: 'bootstrap',
        files: fileRecords.length,
        modules: modules.length,
        routes: allRoutes.length,
        models: allModels.length,
        edges: edges.length,
        symbols: symbols.length
      },
      sourceRefs: [],
      observedAt: new Date().toISOString(),
      ingestedAt: new Date().toISOString(),
      visibility: 'shared',
      parserVersion: PARSER_VERSION
    });

    this.store.recordSyncEvent({
      eventType: 'bootstrap',
      changedFiles: fileRecords.map((f) => f.relativePath),
      deletedFiles: [],
      renamedFiles: [],
      affectedModules: modules.map((m) => m.moduleId),
      summary: `Initial 7-stage bootstrap indexed ${fileRecords.length} files across ${modules.length} modules (parser: ${PARSER_VERSION}).`,
      snapshotId: inspection.snapshot.snapshotId,
      memoryEventId: memoryEvent.eventId
    });
    stagesCompleted.push('7. Knowledge generation and verification');

    const verifiedFactsCount =
      fileRecords.filter((f) => f.verificationStatus === 'verified').length +
      modules.filter((m) => m.verificationStatus === 'verified').length;
    const inferredItemsCount =
      knowledgeItems.filter((k) => k.verificationStatus === 'inferred').length +
      modules.filter((m) => m.verificationStatus === 'inferred').length;

    return {
      projectId,
      projectName: coreMemory.projectName,
      projectRoot: this.projectRoot,
      stagesCompleted,
      indexedFilesCount: fileRecords.length,
      skippedSecretOrIgnoredCount: skippedCount,
      modulesCount: modules.length,
      routesCount: allRoutes.length,
      modelsCount: allModels.length,
      decisionsCount: docData.decisions.length,
      verifiedFactsCount,
      inferredItemsCount,
      uncertainItems,
      snapshotId: inspection.snapshot.snapshotId,
      parseFailures,
      truncatedFiles,
      durationMs: Date.now() - startTime
    };
  }

  public detectProjectChanges(): ProjectChangesReport {
    const inspection = this.inspectWorkspace();
    const existingFiles = this.store.getAllFiles();
    const existingByPath = new Map<string, FileRecord>();
    for (const f of existingFiles) existingByPath.set(f.relativePath, f);

    const discoveredSet = new Set<string>();
    const rawAdded: Array<{ path: string; sha256: string }> = [];
    const modified: string[] = [];
    let unchangedCount = 0;

    for (const entry of inspection.entries) {
      discoveredSet.add(entry.relativePath);
      const prev = existingByPath.get(entry.relativePath);
      if (!prev) {
        rawAdded.push({ path: entry.relativePath, sha256: entry.fullSha256 });
      } else {
        const previousHash = prev.fullSha256 || prev.sha256;
        if (previousHash === entry.fullSha256) unchangedCount++;
        else modified.push(entry.relativePath);
      }
    }

    const rawDeleted: FileRecord[] = [];
    for (const prev of existingFiles) {
      if (!discoveredSet.has(prev.relativePath)) rawDeleted.push(prev);
    }

    const renamed: Array<{ from: string; to: string }> = [];
    const matchedDeletedPaths = new Set<string>();
    const matchedAddedPaths = new Set<string>();

    for (const del of rawDeleted) {
      const delHash = del.fullSha256 || del.sha256;
      const exactMatch = rawAdded.find((add) => !matchedAddedPaths.has(add.path) && add.sha256 === delHash);
      if (exactMatch) {
        renamed.push({ from: del.relativePath, to: exactMatch.path });
        matchedDeletedPaths.add(del.relativePath);
        matchedAddedPaths.add(exactMatch.path);
      }
    }

    const added = rawAdded.filter((a) => !matchedAddedPaths.has(a.path)).map((a) => a.path);
    const deleted = rawDeleted.filter((d) => !matchedDeletedPaths.has(d.relativePath)).map((d) => d.relativePath);

    const affectedModuleSet = new Set<string>();
    for (const p of [...added, ...modified, ...deleted]) affectedModuleSet.add(this.inferModuleId(p));
    for (const r of renamed) {
      affectedModuleSet.add(this.inferModuleId(r.from));
      affectedModuleSet.add(this.inferModuleId(r.to));
    }

    const gitInfo = this.getGitRepositoryInfo();
    const hasChanges = added.length > 0 || modified.length > 0 || deleted.length > 0 || renamed.length > 0;

    return {
      hasChanges, added, modified, deleted, renamed, unchangedCount,
      gitAvailable: gitInfo.available, gitBranch: gitInfo.branch,
      gitHeadCommit: gitInfo.headCommit, gitDirtyFiles: gitInfo.dirtyFiles,
      affectedModules: Array.from(affectedModuleSet),
      snapshotId: inspection.snapshot.snapshotId,
      aggregateHash: inspection.snapshot.aggregateHash,
      dirty: inspection.snapshot.dirty
    };
  }

  public syncChangedFiles(explicitFiles?: string[]): {
    syncedFiles: string[];
    deletedFiles: string[];
    renamedFiles: Array<{ from: string; to: string }>;
    updatedModules: string[];
    transitionedFromPlanned: string[];
    snapshotId: string;
    reanalyzedFiles: number;
    skippedUnchanged: number;
    durationMs: number;
  } {
    const startTime = Date.now();
    const changes = this.detectProjectChanges();

    const filesToReindex = explicitFiles
      ? explicitFiles.filter((f) => !isSensitiveOrSecretPath(f))
      : [...changes.added, ...changes.modified, ...changes.renamed.map((r) => r.to)];

    const filesToDelete = [...changes.deleted, ...changes.renamed.map((r) => r.from)];
    if (filesToDelete.length > 0) this.store.deleteFilesBatch(filesToDelete);

    const inspection = this.lastInspection || this.inspectWorkspace();
    const fullHashes = new Map(inspection.entries.map((e) => [e.relativePath, e.fullSha256]));
    const allKnownFiles = new Set<string>(inspection.entries.map((e) => e.relativePath));
    for (const f of this.store.getAllFiles()) allKnownFiles.add(f.relativePath);
    const resolution = buildResolutionContext(this.projectRoot, Array.from(allKnownFiles));

    const analyses: FileAnalysis[] = [];
    for (const relPath of filesToReindex) {
      const fullPath = resolveSafeProjectPath(this.projectRoot, relPath);
      if (!fs.existsSync(fullPath)) continue;
      const analysis = this.analyzeSingleFile(relPath, resolution, fullHashes.get(relPath));
      if (analysis) analyses.push(analysis);
    }
    const updatedFileRecords = analyses.map((a) => a.fileRecord);
    if (updatedFileRecords.length > 0) this.store.upsertFilesBatch(updatedFileRecords);
    if (analyses.length > 0) {
      const paths = analyses.map((a) => a.fileRecord.relativePath);
      this.store.replaceCodeGraphForFiles(paths, analyses.flatMap((a) => a.edges), analyses.flatMap((a) => a.symbols));
      this.store.replaceFileChunksForFiles(paths, analyses.flatMap((a) => a.chunks));
    }

    const affectedModules = new Set<string>(changes.affectedModules);
    for (const f of updatedFileRecords) affectedModules.add(f.moduleId);

    const allFiles = this.store.getAllFiles();
    const existingModules = this.store.getAllModules();
    const existingModuleById = new Map(existingModules.map((m) => [m.moduleId, m]));
    const modulesToUpsert: ModuleKnowledgeRecord[] = [];
    const transitionedFromPlanned: string[] = [];

    for (const modId of affectedModules) {
      const modFiles = allFiles.filter((f) => f.moduleId === modId);
      const prevMod = existingModuleById.get(modId);
      if (modFiles.length === 0) continue;
      if (prevMod && prevMod.verificationStatus === 'planned') transitionedFromPlanned.push(modId);
      const rebuilt = this.buildSingleModuleRecord(
        modId,
        modFiles,
        allFiles,
        prevMod,
        analyses.flatMap((a) => a.routes).filter((r) => r.moduleId === modId),
        analyses.flatMap((a) => a.models).filter((m) => m.moduleId === modId),
        new Set(analyses.map((a) => a.fileRecord.relativePath))
      );
      modulesToUpsert.push(rebuilt);
    }
    if (modulesToUpsert.length > 0) this.store.upsertModulesBatch(modulesToUpsert);

    // Planned knowledge only becomes verified when there is concrete evidence
    // (routes, models, tests, or an explicit source reference) — not merely
    // because a file exists in the same module.
    const plannedItems = this.store.getKnowledgeItems(undefined, 'planned');
    const transitionedItems: KnowledgeItemRecord[] = [];
    for (const item of plannedItems) {
      const evidence = this.findImplementationEvidence(item, allFiles, modulesToUpsert);
      if (!evidence.verified) continue;
      transitionedItems.push({
        ...item,
        sourceFiles: Array.from(new Set([...item.sourceFiles, ...evidence.sources])),
        fileFingerprint: evidence.fingerprints[0],
        verificationStatus: 'verified',
        confidence: evidence.confidence,
        version: item.version + 1,
        lastVerifiedAt: new Date().toISOString(),
        details: {
          ...item.details,
          verificationReason: evidence.reason,
          verificationEvidence: evidence.sources.map((p) => ({ path: p, kind: 'source-file' })),
          evidenceSources: evidence.sources
        }
      });
      transitionedFromPlanned.push(item.knowledgeId);
    }
    if (transitionedItems.length > 0) {
      this.store.upsertKnowledgeItemsBatch(transitionedItems, {
        actorType: 'system',
        actorId: 'system/indexer',
        snapshotId: changes.snapshotId
      });
    }

    const core = this.store.getCoreMemory();
    if (core) {
      const gitInfo = this.getGitRepositoryInfo();
      this.store.saveCoreMemory({
        ...core,
        currentState: 'active',
        updatedAt: new Date().toISOString(),
        lastVerifiedCommit: gitInfo.headCommit || core.lastVerifiedCommit
      });
    }

    const updatedModIds = Array.from(affectedModules);
    if (filesToReindex.length > 0 || filesToDelete.length > 0) {
      this.store.invalidateCacheForModules(updatedModIds);
    }

    this.store.setIndexManifest({
      projectId: core?.projectId || 'uninitialized',
      snapshotId: changes.snapshotId,
      aggregateHash: changes.aggregateHash,
      fileCount: allFiles.length,
      parserVersion: PARSER_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      embedderVersion: EMBEDDING_MODEL,
      retrievalVersion: RETRIEVAL_VERSION,
      createdAt: new Date().toISOString()
    });

    let memoryEventId: string | undefined;
    if (filesToReindex.length > 0 || filesToDelete.length > 0) {
      const event = this.store.recordMemoryEvent({
        projectId: core?.projectId || 'uninitialized',
        repositoryId: this.projectRoot,
        branch: changes.gitBranch || '',
        baseCommit: changes.gitHeadCommit,
        snapshotId: changes.snapshotId,
        actorType: 'system',
        actorId: 'system/indexer',
        namespace: 'project/shared',
        operation: 'sync',
        entityType: 'project',
        entityId: core?.projectId || 'uninitialized',
        payload: {
          event: 'incremental_sync',
          changedFiles: filesToReindex,
          deletedFiles: changes.deleted,
          renamedFiles: changes.renamed,
          affectedModules: updatedModIds
        },
        sourceRefs: filesToReindex,
        observedAt: new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        visibility: 'shared',
        parserVersion: PARSER_VERSION
      });
      memoryEventId = event.eventId;
      this.store.recordSyncEvent({
        eventType: 'incremental_sync',
        changedFiles: filesToReindex,
        deletedFiles: changes.deleted,
        renamedFiles: changes.renamed,
        affectedModules: updatedModIds,
        summary: `Incremental sync updated ${updatedFileRecords.length} files, deleted ${changes.deleted.length}, renamed ${changes.renamed.length} across ${updatedModIds.length} module(s).`,
        snapshotId: changes.snapshotId,
        memoryEventId
      });
    }

    return {
      syncedFiles: updatedFileRecords.map((f) => f.relativePath),
      deletedFiles: changes.deleted,
      renamedFiles: changes.renamed,
      updatedModules: updatedModIds,
      transitionedFromPlanned,
      snapshotId: changes.snapshotId,
      reanalyzedFiles: updatedFileRecords.length,
      skippedUnchanged: Math.max(0, allFiles.length - updatedFileRecords.length),
      durationMs: Date.now() - startTime
    };
  }

  private findImplementationEvidence(
    item: KnowledgeItemRecord,
    allFiles: FileRecord[],
    updatedModules: ModuleKnowledgeRecord[]
  ): { verified: boolean; reason: string; sources: string[]; fingerprints: string[]; confidence: number } {
    const related = new Set(item.relatedModules || []);
    const moduleFiles = allFiles.filter((f) => related.size === 0 || related.has(f.moduleId));
    const modules = updatedModules.filter((m) => related.size === 0 || related.has(m.moduleId));
    const sources: string[] = [];
    const fingerprints: string[] = [];

    if (item.category === 'api') {
      for (const m of modules.length > 0 ? modules : []) {
        for (const r of m.routes) {
          sources.push(r.sourceFile);
        }
      }
      if (sources.length === 0) {
        for (const f of moduleFiles) {
          const match = f.symbols.find((s) => s.kind === 'route');
          if (match) sources.push(f.relativePath);
        }
      }
      if (sources.length > 0) {
        return {
          verified: true,
          reason: `Verified ${sources.length} route/API evidence file(s) for planned API knowledge.`,
          sources: Array.from(new Set(sources)),
          fingerprints: this.fingerprintsFor(sources, allFiles),
          confidence: 0.95
        };
      }
    }

    if (item.category === 'database_schema') {
      for (const m of modules) {
        for (const model of m.models) sources.push(model.sourceFile);
      }
      if (sources.length > 0) {
        return {
          verified: true,
          reason: `Verified ${sources.length} schema/model evidence file(s) for planned database knowledge.`,
          sources: Array.from(new Set(sources)),
          fingerprints: this.fingerprintsFor(sources, allFiles),
          confidence: 0.95
        };
      }
    }

    if (item.sourceFiles && item.sourceFiles.length > 0) {
      const existing = item.sourceFiles.filter((p) => allFiles.some((f) => f.relativePath === p));
      if (existing.length > 0) {
        return {
          verified: true,
          reason: 'Explicit source reference from the original specification now exists in the repository.',
          sources: existing,
          fingerprints: this.fingerprintsFor(existing, allFiles),
          confidence: 0.9
        };
      }
    }

    const keywords = this.extractKeywords(item.title);
    if (keywords.length > 0) {
      for (const f of moduleFiles) {
        if (f.role !== 'test') continue;
        const haystack = `${f.relativePath} ${f.summary} ${f.exports.join(' ')}`.toLowerCase();
        if (keywords.every((k) => haystack.includes(k))) {
          return {
            verified: true,
            reason: `A test file (${f.relativePath}) provides execution evidence for the planned requirement.`,
            sources: [f.relativePath],
            fingerprints: [f.fullSha256 || f.sha256],
            confidence: 0.9
          };
        }
      }
      for (const f of moduleFiles) {
        if (f.role === 'test') continue;
        const haystack = `${f.exports.join(' ')} ${f.symbols.map((s) => s.name).join(' ')}`.toLowerCase();
        if (keywords.length > 0 && keywords.every((k) => haystack.includes(k))) {
          const testFiles = allFiles.filter((t) => t.role === 'test' && t.moduleId === f.moduleId);
          if (testFiles.length > 0) {
            return {
              verified: true,
              reason: `Implementation symbol(s) and a test file both exist in module ${f.moduleId}.`,
              sources: [f.relativePath, testFiles[0].relativePath],
              fingerprints: [f.fullSha256 || f.sha256, testFiles[0].fullSha256 || testFiles[0].sha256],
              confidence: 0.85
            };
          }
        }
      }
    }

    return { verified: false, reason: 'No concrete implementation evidence found yet.', sources: [], fingerprints: [], confidence: 0.5 };
  }

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !['with', 'from', 'that', 'this', 'project', 'planned', 'requirements', 'features'].includes(w))
      .slice(0, 3);
  }

  private fingerprintsFor(paths: string[], allFiles: FileRecord[]): string[] {
    const byPath = new Map(allFiles.map((f) => [f.relativePath, f]));
    return paths.map((p) => byPath.get(p)?.fullSha256 || byPath.get(p)?.sha256 || '').filter(Boolean);
  }

  private detectTechStackAndMetadata(): {
    projectName: string;
    description: string;
    languages: string[];
    frameworks: string[];
    packageManager: string;
    runtime?: string;
    databases: string[];
    dependencies: string[];
  } {
    let projectName = path.basename(this.projectRoot);
    let description = '';
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const databases = new Set<string>();
    const dependencies = new Set<string>();
    let packageManager = 'none';
    let runtime: string | undefined;

    const pkgJsonPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (pkg.name) projectName = String(pkg.name);
        if (pkg.description) description = String(pkg.description);
        runtime = 'node';
        if (fs.existsSync(path.join(this.projectRoot, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
        else if (fs.existsSync(path.join(this.projectRoot, 'yarn.lock'))) packageManager = 'yarn';
        else if (fs.existsSync(path.join(this.projectRoot, 'bun.lockb'))) packageManager = 'bun';
        else packageManager = 'npm';

        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const dep of Object.keys(allDeps)) {
          dependencies.add(dep);
          if (dep === 'typescript' || fs.existsSync(path.join(this.projectRoot, 'tsconfig.json'))) languages.add('TypeScript');
          if (dep === 'next') frameworks.add('Next.js');
          if (dep === 'react') frameworks.add('React');
          if (dep === 'express') frameworks.add('Express');
          if (dep === 'fastify') frameworks.add('Fastify');
          if (dep.startsWith('@nestjs/')) frameworks.add('NestJS');
          if (dep === 'prisma' || dep === '@prisma/client') databases.add('Prisma');
          if (dep === 'pg' || dep === 'postgres') databases.add('PostgreSQL');
          if (dep === 'mysql2') databases.add('MySQL');
          if (dep === 'mongoose' || dep === 'mongodb') databases.add('MongoDB');
          if (dep.includes('sqlite')) databases.add('SQLite');
          if (dep === 'redis' || dep === 'ioredis') databases.add('Redis');
        }
      } catch (_) {}
    }

    if (fs.existsSync(path.join(this.projectRoot, 'tsconfig.json'))) languages.add('TypeScript');
    if (fs.existsSync(path.join(this.projectRoot, 'pyproject.toml')) || fs.existsSync(path.join(this.projectRoot, 'requirements.txt'))) {
      languages.add('Python');
      if (packageManager === 'none') packageManager = 'pip/poetry';
    }
    if (fs.existsSync(path.join(this.projectRoot, 'go.mod'))) {
      languages.add('Go');
      if (packageManager === 'none') packageManager = 'go';
    }
    if (fs.existsSync(path.join(this.projectRoot, 'Cargo.toml'))) {
      languages.add('Rust');
      if (packageManager === 'none') packageManager = 'cargo';
    }

    return {
      projectName, description,
      languages: Array.from(languages), frameworks: Array.from(frameworks),
      packageManager, runtime, databases: Array.from(databases), dependencies: Array.from(dependencies)
    };
  }

  private loadIgnoreRules(): string[] {
    const config = ProjectIdentityManager.loadConfig(this.projectRoot);
    const rules = new Set<string>(config.excludePatterns);
    for (const ignoreFile of ['.gitignore', '.projectmindignore']) {
      const full = path.join(this.projectRoot, ignoreFile);
      if (fs.existsSync(full)) {
        try {
          const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('!')) rules.add(trimmed);
          }
        } catch (_) {}
      }
    }
    return Array.from(rules);
  }

  private globToRegExp(glob: string): RegExp {
    let out = '^';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') { out += '.*'; i++; }
        else out += '[^/]*';
      } else if (ch === '?') {
        out += '[^/]';
      } else {
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(out + '$');
  }

  private matchesIgnoreRule(normalized: string, rule: string): boolean {
    let clean = rule.trim().replace(/\\/g, '/');
    if (!clean || clean.startsWith('#') || clean.startsWith('!')) return false;
    clean = clean.replace(/^\//, '').replace(/\/$/, '');
    if (!clean) return false;
    const base = path.posix.basename(normalized);
    if (!clean.includes('*') && !clean.includes('?')) {
      if (normalized === clean || normalized.startsWith(clean + '/') || normalized.split('/').includes(clean)) return true;
      if (base === clean) return true;
      return false;
    }
    const rx = this.globToRegExp(clean);
    return rx.test(normalized) || rx.test(base);
  }

  private shouldIgnorePath(relPath: string, ignoreRules: string[]): boolean {
    if (isSensitiveOrSecretPath(relPath)) return true;
    const normalized = relPath.replace(/\\/g, '/');
    for (const rule of ignoreRules) {
      if (this.matchesIgnoreRule(normalized, rule)) return true;
    }
    return false;
  }

  private discoverProjectFiles(ignoreRules: string[], maxFiles: number): {
    discoveredFiles: string[];
    skippedCount: number;
  } {
    const discoveredFiles: string[] = [];
    let skippedCount = 0;

    const walk = (currentDir: string) => {
      if (discoveredFiles.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (discoveredFiles.length >= maxFiles) break;
        const absPath = path.join(currentDir, entry.name);
        const relPath = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
        if (this.shouldIgnorePath(relPath, ignoreRules)) { skippedCount++; continue; }
        if (entry.isSymbolicLink()) {
          try { resolveSafeProjectPath(this.projectRoot, relPath); } catch (_) { skippedCount++; continue; }
        }
        if (entry.isDirectory()) walk(absPath);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (LANGUAGE_BY_EXT[ext] || entry.name === 'Dockerfile' || entry.name === 'Makefile') discoveredFiles.push(relPath);
          else skippedCount++;
        }
      }
    };

    walk(this.projectRoot);
    return { discoveredFiles: discoveredFiles.sort(), skippedCount };
  }

  private classifyFileRole(relPath: string): FileRecord['role'] {
    const lower = relPath.toLowerCase();
    const base = path.posix.basename(lower);
    if (lower.includes('.test.') || lower.includes('.spec.') || lower.startsWith('tests/') || lower.startsWith('test/')) return 'test';
    if (lower.endsWith('.md') || lower.startsWith('docs/')) return 'doc';
    if (base === 'package.json' || base === 'tsconfig.json' || base === 'pyproject.toml' || base === 'cargo.toml' || base === 'go.mod' || base.includes('config')) return 'config';
    if (base === 'index.ts' || base === 'index.js' || base === 'main.ts' || base === 'main.py' || base === 'server.ts' || base === 'app.ts' || base === 'cli.ts') return 'entrypoint';
    if (lower.includes('route') || lower.includes('router')) return 'route';
    if (lower.includes('controller')) return 'controller';
    if (lower.includes('service') || lower.includes('provider') || lower.includes('engine')) return 'service';
    if (lower.includes('model') || lower.includes('schema') || lower.includes('entity') || lower.endsWith('.prisma') || lower.endsWith('.sql')) return 'model';
    if (lower.includes('component') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'component';
    if (lower.includes('util') || lower.includes('helper') || lower.includes('shared')) return 'utility';
    return 'other';
  }

  public inferModuleId(relPath: string): string {
    const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 1) return 'root';
    if ((parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'adapters' || parts[0] === 'services') && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    if (parts[0] === 'src' && parts.length >= 3) return `src/${parts[1]}`;
    return parts[0];
  }

  private readSafeSlice(fullPath: string, sizeBytes: number): Buffer {
    const toRead = Math.min(sizeBytes, MAX_SELECTIVE_READ_BYTES);
    const fd = fs.openSync(fullPath, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, 0);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  private analyzeSingleFile(
    relPath: string,
    resolution?: ResolutionContext,
    knownFullSha?: string
  ): FileAnalysis | null {
    if (isSensitiveOrSecretPath(relPath)) return null;
    const fullPath = resolveSafeProjectPath(this.projectRoot, relPath);
    let stat: fs.Stats;
    try { stat = fs.statSync(fullPath); } catch (_) { return null; }

    const hash = hashFileStreaming(fullPath);
    const sha256 = knownFullSha || hash.sha256;
    const prefix = readFilePrefix(fullPath, MAX_ANALYSIS_BYTES);
    const rawContent = prefix.buffer.toString('utf8');
    const { sanitized } = sanitizeUntrustedContent(rawContent);

    const ext = path.extname(relPath).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext] || 'text';
    const moduleId = this.inferModuleId(relPath);
    const role = this.classifyFileRole(relPath);
    const isJsTs = language === 'typescript' || language === 'javascript';

    let ast: AstParseResult | null = null;
    if (isJsTs) {
      try {
        ast = parseJavaScriptModule(rawContent, relPath);
      } catch (_) {
        ast = null;
      }
    }

    const symbols: ExtractedSymbol[] = ast
      ? ast.symbols.map((sym) => ({
          name: sym.name,
          kind: sym.kind === 'enum' ? 'const' : (sym.kind as ExtractedSymbol['kind']),
          line: sym.line,
          exported: sym.exported,
          signature: sym.signature
        }))
      : this.extractSymbols(sanitized, language);

    const rawImports = ast
      ? Array.from(new Set(ast.imports.map((i) => i.specifier)))
      : this.extractImports(sanitized, language);
    const imports = rawImports.slice(0, 300);

    const resolvedImports: string[] = [];
    const edges: CodeGraphEdge[] = [];
    const resolutionCtx = resolution || this.resolutionContext || this.getResolutionContext([relPath]);
    const astImports = ast ? ast.imports : imports.map((spec) => ({ specifier: spec, kind: 'import' as const, line: 0, names: [] as string[] }));
    for (const imp of astImports) {
      const resolved = resolveImportPath(imp.specifier, relPath, resolutionCtx);
      const external = externalPackageName(imp.specifier);
      edges.push({
        fromPath: relPath,
        toPath: resolved || `external:${external}`,
        kind: imp.kind === 'require' ? 'require'
          : imp.kind === 'dynamic-import' ? 'dynamic-import'
          : imp.kind === 'type-import' ? 'type-import'
          : imp.kind === 'reexport' ? 'reexport'
          : 'import',
        specifier: imp.specifier,
        line: imp.line,
        resolved: Boolean(resolved),
        targetModule: resolved ? this.inferModuleId(resolved) : undefined
      });
    }
    for (const spec of imports) {
      resolvedImports.push(resolveImportPath(spec, relPath, resolutionCtx) || '');
    }

    const routes: ApiEndpointRecord[] = (ast ? ast.routes : this.extractRoutes(sanitized, relPath, moduleId)).map((r) => ({
      method: r.method,
      path: r.path,
      handlerSymbol: r.handlerSymbol,
      sourceFile: relPath,
      line: r.line,
      moduleId,
      verificationStatus: 'verified'
    }));

    const models: DatabaseModelRecord[] = (ast ? ast.models : this.extractDatabaseModels(sanitized, relPath, moduleId, language)).map((m) => ({
      name: m.name,
      kind: m.kind,
      fields: m.fields || [],
      sourceFile: relPath,
      line: m.line,
      moduleId,
      verificationStatus: 'verified'
    }));

    for (const r of routes) symbols.push({ name: `${r.method} ${r.path}`, kind: 'route', line: r.line, exported: true });
    for (const m of models) symbols.push({ name: m.name, kind: 'model', line: m.line, exported: true });

    const summary = this.buildFileSummary(relPath, role, language, symbols, imports, routes, models, sanitized);
    const lineCount = ast?.lineCount || rawContent.split(/\r?\n/).length;
    const analysisStatus: FileRecord['analysisStatus'] = prefix.truncated
      ? 'truncated'
      : (isJsTs && !ast ? 'failed' : 'ok');

    const codeSymbols: CodeSymbolRecord[] = symbols
      .filter((sym) => sym.kind !== 'route' && sym.kind !== 'model')
      .map((sym) => ({
        symbolId: stableId('sym', relPath, sym.name, sym.kind, String(sym.line)),
        relativePath: relPath,
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        endLine: sym.line,
        exported: sym.exported,
        signature: sym.signature,
        moduleId
      }));

    return {
      fileRecord: {
        relativePath: relPath,
        sha256,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        language,
        moduleId,
        role,
        symbols,
        imports,
        resolvedImports,
        exports: ast ? ast.exports : Array.from(new Set(symbols.filter((s) => s.exported).map((s) => s.name))),
        summary,
        verificationStatus: 'verified',
        lastVerifiedAt: new Date().toISOString(),
        fullSha256: sha256,
        analysisSha256: hash.analysisSha256,
        parserVersion: ast ? PARSER_VERSION : 'regex-fallback-v1',
        analysisStatus,
        lineCount
      },
      routes,
      models,
      edges,
      symbols: codeSymbols,
      chunks: this.buildChunks(relPath, hash, rawContent, prefix.truncated)
    };
  }

  private extractSymbols(content: string, language: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      if (language === 'typescript' || language === 'javascript') {
        const classMatch = line.match(/^\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/);
        if (classMatch) { symbols.push({ name: classMatch[2], kind: 'class', line: lineNum, exported: Boolean(classMatch[1]) }); continue; }
        const ifaceMatch = line.match(/^\s*(export\s+)?interface\s+([A-Za-z0-9_]+)/);
        if (ifaceMatch) { symbols.push({ name: ifaceMatch[2], kind: 'interface', line: lineNum, exported: Boolean(ifaceMatch[1]) }); continue; }
        const typeMatch = line.match(/^\s*(export\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
        if (typeMatch) { symbols.push({ name: typeMatch[2], kind: 'type', line: lineNum, exported: Boolean(typeMatch[1]) }); continue; }
        const fnMatch = line.match(/^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
        if (fnMatch) { symbols.push({ name: fnMatch[2], kind: 'function', line: lineNum, exported: Boolean(fnMatch[1]) }); continue; }
        const constMatch = line.match(/^\s*(export\s+)?const\s+([A-Za-z0-9_]+)\s*=/);
        if (constMatch) { symbols.push({ name: constMatch[2], kind: 'const', line: lineNum, exported: Boolean(constMatch[1]) }); continue; }
      } else if (language === 'python') {
        const pyClass = line.match(/^class\s+([A-Za-z0-9_]+)/);
        if (pyClass) { symbols.push({ name: pyClass[1], kind: 'class', line: lineNum, exported: !pyClass[1].startsWith('_') }); continue; }
        const pyDef = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
        if (pyDef) { symbols.push({ name: pyDef[1], kind: 'function', line: lineNum, exported: !pyDef[1].startsWith('_') }); continue; }
      } else if (language === 'go') {
        const goFn = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/);
        if (goFn) { symbols.push({ name: goFn[1], kind: 'function', line: lineNum, exported: /^[A-Z]/.test(goFn[1]) }); continue; }
        const goType = line.match(/^type\s+([A-Za-z0-9_]+)/);
        if (goType) { symbols.push({ name: goType[1], kind: 'type', line: lineNum, exported: /^[A-Z]/.test(goType[1]) }); continue; }
      } else if (language === 'rust') {
        const rsFn = line.match(/^\s*(pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
        if (rsFn) { symbols.push({ name: rsFn[2], kind: 'function', line: lineNum, exported: Boolean(rsFn[1]) }); continue; }
        const rsStruct = line.match(/^\s*(pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
        if (rsStruct) { symbols.push({ name: rsStruct[2], kind: 'class', line: lineNum, exported: Boolean(rsStruct[1]) }); continue; }
      } else if (language === 'java') {
        const javaClass = line.match(/^\s*(?:public\s+)?(?:final\s+)?class\s+([A-Za-z0-9_]+)/);
        if (javaClass) { symbols.push({ name: javaClass[1], kind: 'class', line: lineNum, exported: true }); continue; }
        const javaMethod = line.match(/^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?[A-Za-z0-9_<>\[\], ?]+\s+([A-Za-z0-9_]+)\s*\(/);
        if (javaMethod) { symbols.push({ name: javaMethod[1], kind: 'method', line: lineNum, exported: true }); continue; }
      }
    }
    return symbols.slice(0, 60);
  }

  private extractImports(content: string, language: string): string[] {
    const imports = new Set<string>();
    if (language === 'typescript' || language === 'javascript') {
      const importRx = /(?:import\s+[^'"]*from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRx.exec(content)) !== null) imports.add(m[1]);
    } else if (language === 'python') {
      const pyFromRx = /^\s*from\s+([A-Za-z0-9_.]+)\s+import/gm;
      const pyImpRx = /^\s*import\s+([A-Za-z0-9_.]+)/gm;
      let m: RegExpExecArray | null;
      while ((m = pyFromRx.exec(content)) !== null) imports.add(m[1]);
      while ((m = pyImpRx.exec(content)) !== null) imports.add(m[1]);
    } else if (language === 'go') {
      const goImportBlock = content.match(/import\s*\(([\s\S]*?)\)/);
      if (goImportBlock) {
        for (const line of goImportBlock[1].split(/\r?\n/)) {
          const m = line.match(/"([^"]+)"/);
          if (m) imports.add(m[1]);
        }
      }
      const goSingle = content.match(/^\s*import\s+"([^"]+)"/gm) || [];
      for (const line of goSingle) {
        const m = line.match(/"([^"]+)"/);
        if (m) imports.add(m[1]);
      }
    } else if (language === 'rust') {
      const useRx = /^\s*use\s+([A-Za-z0-9_:]+)/gm;
      let m: RegExpExecArray | null;
      while ((m = useRx.exec(content)) !== null) imports.add(m[1]);
    } else if (language === 'java') {
      const javaRx = /^\s*import\s+([A-Za-z0-9_.]+)\s*;/gm;
      let m: RegExpExecArray | null;
      while ((m = javaRx.exec(content)) !== null) imports.add(m[1]);
    }
    return Array.from(imports);
  }

  private extractRoutes(content: string, relPath: string, moduleId: string): ApiEndpointRecord[] {
    const routes: ApiEndpointRecord[] = [];
    const lines = content.split(/\r?\n/);
    const expressRx = /\b(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*([A-Za-z0-9_.]+))?/i;

    for (let i = 0; i < lines.length; i++) {
      const em = lines[i].match(expressRx);
      if (em) {
        routes.push({
          method: em[1].toUpperCase(), path: em[2], handlerSymbol: em[3] || 'inlineHandler',
          sourceFile: relPath, line: i + 1, moduleId, verificationStatus: 'verified'
        });
      }
    }
    return routes;
  }

  private extractDatabaseModels(content: string, relPath: string, moduleId: string, language: string): DatabaseModelRecord[] {
    const models: DatabaseModelRecord[] = [];
    const sqlTableRx = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s*\(/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sqlTableRx.exec(content)) !== null) {
      const lineNum = content.slice(0, sm.index).split(/\r?\n/).length;
      models.push({
        name: sm[1], kind: 'sql_table', fields: [], sourceFile: relPath, line: lineNum, moduleId, verificationStatus: 'verified'
      });
    }
    if (language === 'prisma') {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const pm = lines[i].match(/^\s*model\s+([A-Za-z0-9_]+)\s*\{/);
        if (pm) models.push({ name: pm[1], kind: 'prisma_model', fields: [], sourceFile: relPath, line: i + 1, moduleId, verificationStatus: 'verified' });
      }
    }
    return models;
  }

  private buildFileSummary(
    relPath: string, role: FileRecord['role'], language: string,
    symbols: ExtractedSymbol[], imports: string[], routes: ApiEndpointRecord[],
    models: DatabaseModelRecord[], sanitizedContent: string
  ): string {
    const docComment = sanitizedContent.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (docComment) {
      const cleaned = docComment[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter((l) => l && !l.startsWith('@')).join(' ').slice(0, 220);
      if (cleaned.length > 15) return cleaned;
    }
    const parts: string[] = [`${language} ${role} (${relPath})`];
    const exportedNames = symbols.filter((s) => s.exported).map((s) => s.name).slice(0, 6);
    if (exportedNames.length > 0) parts.push(`exports: ${exportedNames.join(', ')}`);
    if (routes.length > 0) parts.push(`routes: ${routes.map((r) => `${r.method} ${r.path}`).slice(0, 4).join(', ')}`);
    if (models.length > 0) parts.push(`models: ${models.map((m) => m.name).slice(0, 4).join(', ')}`);
    if (imports.length > 0 && exportedNames.length === 0) parts.push(`imports: ${imports.slice(0, 4).join(', ')}`);
    return parts.join(' — ');
  }

  private extractDocumentationAndDecisions(discoveredFiles: string[]): {
    purpose: string;
    constraints: string[];
    conventions: string[];
    decisions: ArchitecturalDecisionRecord[];
  } {
    let purpose = '';
    const constraints: string[] = [];
    const conventions: string[] = [];
    const decisions: ArchitecturalDecisionRecord[] = [];
    const docFiles = discoveredFiles.filter((f) => f.toLowerCase().endsWith('.md') || f.toLowerCase().includes('architecture'));

    for (const relPath of docFiles.slice(0, 15)) {
      const fullPath = path.join(this.projectRoot, relPath);
      try {
        const stat = fs.statSync(fullPath);
        const raw = this.readSafeSlice(fullPath, stat.size).toString('utf8');
        const { sanitized } = sanitizeUntrustedContent(raw);
        const lines = sanitized.split(/\r?\n/);

        if (!purpose && path.basename(relPath).toLowerCase() === 'readme.md') {
          const para = lines.find((l) => {
            const t = l.trim();
            if (t.length <= 25) return false;
            if (/^[#!<\[|>`]/.test(t)) return false;
            if (/^[-=*_]{3,}$/.test(t)) return false;
            if (/^https?:\/\//i.test(t)) return false;
            if (/<[a-z][^>]*>/i.test(t)) return false;
            return /[A-Za-z]{3,}/.test(t) && t.split(/\s+/).length >= 4;
          });
          if (para) purpose = para.trim().slice(0, 280);
        }
        for (const line of lines) {
          const trimmed = line.trim();
          if (/^[-*]\s+.*\b(must not|never|constraint|require|strictly|offline|local-first)\b/i.test(trimmed)) {
            constraints.push(trimmed.replace(/^[-*]\s+/, '').slice(0, 200));
          }
          if (/^[-*]\s+.*\b(convention|naming|style|lint|test|pattern)\b/i.test(trimmed)) {
            conventions.push(trimmed.replace(/^[-*]\s+/, '').slice(0, 200));
          }
        }
      } catch (_) {}
    }

    return {
      purpose,
      constraints: Array.from(new Set(constraints)).slice(0, 12),
      conventions: Array.from(new Set(conventions)).slice(0, 10),
      decisions
    };
  }

  private resolveImportToModuleId(importSpec: string, fromFileRel: string, allModuleIds: Set<string>): string | null {
    if (importSpec.startsWith('@projectmind/')) {
      const sub = importSpec.replace('@projectmind/', '');
      if (sub.startsWith('adapter-')) {
        const cand = `adapters/${sub.replace('adapter-', '')}`;
        if (allModuleIds.has(cand)) return cand;
      }
      for (const prefix of ['packages', 'apps']) {
        const cand = `${prefix}/${sub}`;
        if (allModuleIds.has(cand)) return cand;
      }
    }
    if (importSpec.startsWith('.')) {
      const resolvedRel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFileRel), importSpec));
      const targetMod = this.inferModuleId(resolvedRel);
      if (allModuleIds.has(targetMod)) return targetMod;
    }
    return null;
  }

  private buildModuleKnowledgeRecords(
    moduleMap: Map<string, string[]>,
    fileRecords: FileRecord[],
    allRoutes: ApiEndpointRecord[],
    allModels: DatabaseModelRecord[],
    _externalDeps: string[]
  ): ModuleKnowledgeRecord[] {
    const allModuleIds = new Set<string>(moduleMap.keys());
    const filesByModule = new Map<string, FileRecord[]>();
    for (const f of fileRecords) {
      const arr = filesByModule.get(f.moduleId) || [];
      arr.push(f);
      filesByModule.set(f.moduleId, arr);
    }

    const forwardDeps = new Map<string, Set<string>>();
    const reverseDeps = new Map<string, Set<string>>();
    for (const modId of allModuleIds) {
      forwardDeps.set(modId, new Set());
      reverseDeps.set(modId, new Set());
    }

    for (const f of fileRecords) {
      const resolved = f.resolvedImports || [];
      for (let i = 0; i < f.imports.length; i++) {
        const imp = f.imports[i];
        const resolvedTarget = resolved[i] || '';
        const targetMod = resolvedTarget ? this.inferModuleId(resolvedTarget) : this.resolveImportToModuleId(imp, f.relativePath, allModuleIds);
        if (targetMod && targetMod !== f.moduleId && allModuleIds.has(targetMod)) {
          forwardDeps.get(f.moduleId)?.add(targetMod);
          reverseDeps.get(targetMod)?.add(f.moduleId);
        } else if (!resolvedTarget && !imp.startsWith('.') && !imp.startsWith('/')) {
          forwardDeps.get(f.moduleId)?.add(externalPackageName(imp));
        }
      }
    }

    const records: ModuleKnowledgeRecord[] = [];
    for (const [modId, relPaths] of moduleMap.entries()) {
      const modFiles = filesByModule.get(modId) || [];
      const entryFiles = modFiles.filter((f) => f.role === 'entrypoint').map((f) => f.relativePath);
      const publicSymbols = Array.from(new Set(modFiles.flatMap((f) => f.exports))).slice(0, 35);
      const modRoutes = allRoutes.filter((r) => r.moduleId === modId);
      const modModels = allModels.filter((m) => m.moduleId === modId);
      const combinedHash = computeSha256(modFiles.map((f) => `${f.relativePath}:${f.sha256}`).join('|'));

      const purposeSummary =
        modFiles.find((f) => f.role === 'entrypoint')?.summary ||
        `Module ${modId} containing ${modFiles.length} file(s), exporting ${publicSymbols.slice(0, 5).join(', ') || 'internal components'}.`;

      records.push({
        moduleId: modId,
        name: modId.split('/').pop() || modId,
        rootPath: modId === 'root' ? '.' : modId,
        purpose: purposeSummary,
        entryFiles: entryFiles.length > 0 ? entryFiles : relPaths.slice(0, 2),
        fileCount: modFiles.length,
        publicSymbols,
        dependencies: Array.from(forwardDeps.get(modId) || []),
        dependents: Array.from(reverseDeps.get(modId) || []),
        routes: modRoutes,
        models: modModels,
        verificationStatus: 'verified',
        confidence: 1.0,
        lastVerifiedAt: new Date().toISOString(),
        fingerprint: combinedHash
      });
    }
    return records;
  }

  private buildSingleModuleRecord(
    modId: string,
    modFiles: FileRecord[],
    allFiles: FileRecord[],
    prevMod?: ModuleKnowledgeRecord,
    updatedRoutes?: ApiEndpointRecord[],
    updatedModels?: DatabaseModelRecord[],
    replacedPaths?: Set<string>
  ): ModuleKnowledgeRecord {
    const allModuleIds = new Set<string>(allFiles.map((f) => f.moduleId));
    const deps = new Set<string>();
    const dependents = new Set<string>();

    const resolveDeps = (f: FileRecord) => {
      const resolved = f.resolvedImports || [];
      for (let i = 0; i < f.imports.length; i++) {
        const imp = f.imports[i];
        const resolvedTarget = resolved[i] || '';
        const targetMod = resolvedTarget ? this.inferModuleId(resolvedTarget) : this.resolveImportToModuleId(imp, f.relativePath, allModuleIds);
        if (targetMod && allModuleIds.has(targetMod) && targetMod !== modId) deps.add(targetMod);
        else if (!resolvedTarget && !imp.startsWith('.') && !imp.startsWith('/')) deps.add(externalPackageName(imp));
      }
    };

    for (const f of modFiles) resolveDeps(f);

    for (const other of allFiles) {
      if (other.moduleId === modId) continue;
      const resolved = other.resolvedImports || [];
      for (let i = 0; i < other.imports.length; i++) {
        const imp = other.imports[i];
        const resolvedTarget = resolved[i] || '';
        const targetMod = resolvedTarget ? this.inferModuleId(resolvedTarget) : this.resolveImportToModuleId(imp, other.relativePath, allModuleIds);
        if (targetMod === modId) dependents.add(other.moduleId);
      }
    }

    const reindexed = replacedPaths || new Set<string>();
    const keptRoutes = (prevMod?.routes || []).filter((r) => !reindexed.has(r.sourceFile));
    const keptModels = (prevMod?.models || []).filter((m) => !reindexed.has(m.sourceFile));
    const routes = [...keptRoutes, ...(updatedRoutes || [])];
    const models = [...keptModels, ...(updatedModels || [])];

    const entryFiles = modFiles.filter((f) => f.role === 'entrypoint').map((f) => f.relativePath);
    const publicSymbols = Array.from(new Set(modFiles.flatMap((f) => f.exports))).slice(0, 35);
    const combinedHash = computeSha256(modFiles.map((f) => `${f.relativePath}:${f.sha256}`).join('|'));

    return {
      moduleId: modId,
      name: modId.split('/').pop() || modId,
      rootPath: modId === 'root' ? '.' : modId,
      purpose: modFiles.find((f) => f.role === 'entrypoint')?.summary || prevMod?.purpose || `Module ${modId} (${modFiles.length} files)`,
      entryFiles: entryFiles.length > 0 ? entryFiles : modFiles.slice(0, 2).map((f) => f.relativePath),
      fileCount: modFiles.length,
      publicSymbols,
      dependencies: Array.from(deps),
      dependents: Array.from(dependents),
      routes,
      models,
      verificationStatus: 'verified',
      confidence: 1.0,
      lastVerifiedAt: new Date().toISOString(),
      fingerprint: combinedHash
    };
  }

  private synthesizeArchitecturalSummary(
    techMeta: { projectName: string; languages: string[]; frameworks: string[]; packageManager: string },
    modules: ModuleKnowledgeRecord[],
    routes: ApiEndpointRecord[],
    models: DatabaseModelRecord[]
  ): string {
    const langStr = techMeta.languages.join(', ') || 'Polyglot';
    const fwStr = techMeta.frameworks.length > 0 ? ` (${techMeta.frameworks.join(', ')})` : '';
    const modNames = modules.map((m) => m.moduleId).slice(0, 12).join(', ');
    return `${techMeta.projectName} is a ${langStr}${fwStr} project managed via ${techMeta.packageManager} with ${modules.length} discovered module(s) [${modNames}], ${routes.length} API route(s), and ${models.length} data model(s).`;
  }

  private buildKnowledgeItems(
    core: CoreMemoryRecord,
    modules: ModuleKnowledgeRecord[],
    routes: ApiEndpointRecord[],
    models: DatabaseModelRecord[],
    configFiles: string[],
    conventions: string[],
    uncertainItems: string[]
  ): KnowledgeItemRecord[] {
    const now = new Date().toISOString();
    const items: KnowledgeItemRecord[] = [];

    items.push({
      knowledgeId: 'arch_overview',
      category: 'architecture',
      title: `${core.projectName} Architecture Overview`,
      summary: core.architecturalSummary,
      details: {
        techStack: core.mainTechStack,
        moduleCount: modules.length,
        modules: modules.map((m) => ({ id: m.moduleId, dependencies: m.dependencies, dependents: m.dependents }))
      },
      sourceFiles: configFiles.slice(0, 5),
      relatedModules: modules.map((m) => m.moduleId),
      verificationStatus: 'verified',
      confidence: 1.0,
      version: 1,
      lastVerifiedAt: now
    });

    if (routes.length > 0) {
      items.push({
        knowledgeId: 'api_routes_catalog',
        category: 'api',
        title: 'Verified HTTP/API Endpoints',
        summary: `Discovered ${routes.length} API endpoint(s): ${routes.map((r) => `${r.method} ${r.path}`).slice(0, 8).join(', ')}`,
        details: { routes },
        sourceFiles: Array.from(new Set(routes.map((r) => r.sourceFile))),
        relatedModules: Array.from(new Set(routes.map((r) => r.moduleId))),
        verificationStatus: 'verified',
        confidence: 1.0,
        version: 1,
        lastVerifiedAt: now
      });
    }

    if (models.length > 0) {
      items.push({
        knowledgeId: 'database_schema_catalog',
        category: 'database_schema',
        title: 'Verified Database Models and Tables',
        summary: `Discovered ${models.length} database model(s)/table(s): ${models.map((m) => m.name).join(', ')}`,
        details: { models },
        sourceFiles: Array.from(new Set(models.map((m) => m.sourceFile))),
        relatedModules: Array.from(new Set(models.map((m) => m.moduleId))),
        verificationStatus: 'verified',
        confidence: 1.0,
        version: 1,
        lastVerifiedAt: now
      });
    }

    if (conventions.length > 0) {
      items.push({
        knowledgeId: 'dev_conventions',
        category: 'convention',
        title: 'Project Development Conventions',
        summary: conventions.slice(0, 4).join('; '),
        details: { conventions },
        sourceFiles: ['README.md'],
        relatedModules: ['root'],
        verificationStatus: 'inferred',
        confidence: 0.85,
        version: 1,
        lastVerifiedAt: now
      });
    }

    for (let i = 0; i < uncertainItems.length; i++) {
      items.push({
        knowledgeId: `uncertain_${i + 1}`,
        category: 'unresolved_question',
        title: `Unverified Architectural Aspect #${i + 1}`,
        summary: uncertainItems[i],
        details: { note: uncertainItems[i] },
        sourceFiles: [],
        relatedModules: ['root'],
        verificationStatus: 'unverified',
        confidence: 0.4,
        version: 1,
        lastVerifiedAt: now
      });
    }
    return items;
  }

  public getGitRepositoryInfo(): {
    available: boolean;
    branch?: string;
    headCommit?: string;
    dirtyFiles?: string[];
  } {
    if (!fs.existsSync(path.join(this.projectRoot, '.git'))) return { available: false };
    try {
      const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.projectRoot, encoding: 'utf8', timeout: 3000 });
      const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: this.projectRoot, encoding: 'utf8', timeout: 3000 });
      const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: this.projectRoot, encoding: 'utf8', timeout: 3000 });
      if (branchRes.status !== 0) return { available: false };
      const dirtyFiles = (statusRes.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.slice(3).trim());
      return {
        available: true,
        branch: (branchRes.stdout || '').trim(),
        headCommit: (headRes.stdout || '').trim(),
        dirtyFiles
      };
    } catch (_) {
      return { available: false };
    }
  }
}
