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
  isSensitiveOrSecretPath,
  sanitizeUntrustedContent,
  resolveSafeProjectPath,
  computeSha256,
  MEMORY_SCHEMA_VERSION
} from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIdentityManager } from '@projectmind/core';

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
  durationMs: number;
}

const MAX_SELECTIVE_READ_BYTES = 256 * 1024;

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

  public bootstrapProject(options?: { maxFiles?: number; cancellationToken?: { cancelled: boolean } }): BootstrapReport {
    const startTime = Date.now();
    const stagesCompleted: string[] = [];
    const uncertainItems: string[] = [];

    const { projectId, movedFrom } = ProjectIdentityManager.getOrCreateProjectId(this.projectRoot);
    const techMeta = this.detectTechStackAndMetadata();
    stagesCompleted.push('1. Project metadata');

    const ignoreRules = this.loadIgnoreRules();
    const { discoveredFiles, skippedCount } = this.discoverProjectFiles(ignoreRules, options?.maxFiles || 2500);
    stagesCompleted.push('2. File and directory inventory');

    if (options?.cancellationToken?.cancelled) throw new Error('Bootstrap cancelled by caller');

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

    const fileRecords: FileRecord[] = [];
    const allRoutes: ApiEndpointRecord[] = [];
    const allModels: DatabaseModelRecord[] = [];

    for (const relPath of discoveredFiles) {
      if (options?.cancellationToken?.cancelled) throw new Error('Bootstrap cancelled by caller');
      const analysis = this.analyzeSingleFile(relPath);
      if (analysis) {
        fileRecords.push(analysis.fileRecord);
        allRoutes.push(...analysis.routes);
        allModels.push(...analysis.models);
      }
    }
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
    const knowledgeItems = this.buildKnowledgeItems(coreMemory, modules, allRoutes, allModels, configFiles, docData.conventions, uncertainItems);
    this.store.upsertKnowledgeItemsBatch(knowledgeItems);

    this.store.recordSyncEvent({
      eventType: 'bootstrap',
      changedFiles: fileRecords.map((f) => f.relativePath),
      deletedFiles: [],
      renamedFiles: [],
      affectedModules: modules.map((m) => m.moduleId),
      summary: `Initial 7-stage bootstrap indexed ${fileRecords.length} files across ${modules.length} modules.`
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
      durationMs: Date.now() - startTime
    };
  }

  public detectProjectChanges(): ProjectChangesReport {
    const ignoreRules = this.loadIgnoreRules();
    const { discoveredFiles } = this.discoverProjectFiles(ignoreRules, 5000);
    const existingFiles = this.store.getAllFiles();
    const existingByPath = new Map<string, FileRecord>();
    for (const f of existingFiles) existingByPath.set(f.relativePath, f);

    const discoveredSet = new Set(discoveredFiles);
    const rawAdded: Array<{ path: string; sha256: string }> = [];
    const modified: string[] = [];
    let unchangedCount = 0;

    for (const relPath of discoveredFiles) {
      const fullPath = path.join(this.projectRoot, relPath);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      const prev = existingByPath.get(relPath);
      if (!prev) {
        const content = this.readSafeSlice(fullPath, stat.size);
        rawAdded.push({ path: relPath, sha256: computeSha256(content) });
      } else {
        if (prev.sizeBytes === stat.size && Math.abs(prev.mtimeMs - stat.mtimeMs) < 1) {
          unchangedCount++;
        } else {
          const content = this.readSafeSlice(fullPath, stat.size);
          const currentSha = computeSha256(content);
          if (currentSha !== prev.sha256) modified.push(relPath);
          else unchangedCount++;
        }
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
      const exactMatch = rawAdded.find((add) => !matchedAddedPaths.has(add.path) && add.sha256 === del.sha256);
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
      affectedModules: Array.from(affectedModuleSet)
    };
  }

  public syncChangedFiles(explicitFiles?: string[]): {
    syncedFiles: string[];
    deletedFiles: string[];
    renamedFiles: Array<{ from: string; to: string }>;
    updatedModules: string[];
    transitionedFromPlanned: string[];
    durationMs: number;
  } {
    const startTime = Date.now();
    const changes = this.detectProjectChanges();

    const filesToReindex = explicitFiles
      ? explicitFiles.filter((f) => !isSensitiveOrSecretPath(f))
      : [...changes.added, ...changes.modified, ...changes.renamed.map((r) => r.to)];

    const filesToDelete = [...changes.deleted, ...changes.renamed.map((r) => r.from)];
    if (filesToDelete.length > 0) this.store.deleteFilesBatch(filesToDelete);

    const updatedFileRecords: FileRecord[] = [];
    for (const relPath of filesToReindex) {
      const fullPath = resolveSafeProjectPath(this.projectRoot, relPath);
      if (!fs.existsSync(fullPath)) continue;
      const analysis = this.analyzeSingleFile(relPath);
      if (analysis) updatedFileRecords.push(analysis.fileRecord);
    }

    if (updatedFileRecords.length > 0) this.store.upsertFilesBatch(updatedFileRecords);

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
      const rebuilt = this.buildSingleModuleRecord(modId, modFiles, allFiles, prevMod);
      modulesToUpsert.push(rebuilt);
    }

    if (modulesToUpsert.length > 0) this.store.upsertModulesBatch(modulesToUpsert);

    const plannedItems = this.store.getKnowledgeItems(undefined, 'planned');
    const transitionedItems: KnowledgeItemRecord[] = [];
    for (const item of plannedItems) {
      const matchedFile = updatedFileRecords.find((f) =>
        f.relativePath.toLowerCase().includes(item.title.toLowerCase().replace(/\s+/g, '-')) ||
        item.relatedModules.includes(f.moduleId)
      );
      if (matchedFile) {
        transitionedItems.push({
          ...item,
          sourceFiles: Array.from(new Set([...item.sourceFiles, matchedFile.relativePath])),
          fileFingerprint: matchedFile.sha256,
          verificationStatus: 'verified',
          confidence: 0.95,
          version: item.version + 1,
          lastVerifiedAt: new Date().toISOString()
        });
        transitionedFromPlanned.push(item.knowledgeId);
      }
    }
    if (transitionedItems.length > 0) this.store.upsertKnowledgeItemsBatch(transitionedItems);

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
    if (updatedModIds.length > 0) this.store.invalidateCacheForModules(updatedModIds);

    if (filesToReindex.length > 0 || filesToDelete.length > 0) {
      this.store.recordSyncEvent({
        eventType: 'incremental_sync',
        changedFiles: filesToReindex,
        deletedFiles: changes.deleted,
        renamedFiles: changes.renamed,
        affectedModules: updatedModIds,
        summary: `Incremental sync updated ${updatedFileRecords.length} files, deleted ${changes.deleted.length}, renamed ${changes.renamed.length} across ${updatedModIds.length} module(s).`
      });
    }

    return {
      syncedFiles: updatedFileRecords.map((f) => f.relativePath),
      deletedFiles: changes.deleted,
      renamedFiles: changes.renamed,
      updatedModules: updatedModIds,
      transitionedFromPlanned,
      durationMs: Date.now() - startTime
    };
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

  private shouldIgnorePath(relPath: string, ignoreRules: string[]): boolean {
    if (isSensitiveOrSecretPath(relPath)) return true;
    const normalized = relPath.replace(/\\/g, '/');
    for (const rule of ignoreRules) {
      const cleanRule = rule.replace(/\/\*\*$/, '').replace(/^\//, '').replace(/\/$/, '');
      if (!cleanRule) continue;
      if (normalized === cleanRule || normalized.startsWith(cleanRule + '/') || normalized.split('/').includes(cleanRule)) return true;
      if (cleanRule.startsWith('*.') && normalized.endsWith(cleanRule.slice(1))) return true;
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

  private analyzeSingleFile(relPath: string): {
    fileRecord: FileRecord;
    routes: ApiEndpointRecord[];
    models: DatabaseModelRecord[];
  } | null {
    if (isSensitiveOrSecretPath(relPath)) return null;
    const fullPath = resolveSafeProjectPath(this.projectRoot, relPath);
    let stat: fs.Stats;
    try { stat = fs.statSync(fullPath); } catch (_) { return null; }

    const buf = this.readSafeSlice(fullPath, stat.size);
    const sha256 = computeSha256(buf);
    const rawContent = buf.toString('utf8');
    const { sanitized } = sanitizeUntrustedContent(rawContent);

    const ext = path.extname(relPath).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext] || 'text';
    const moduleId = this.inferModuleId(relPath);
    const role = this.classifyFileRole(relPath);

    const symbols = this.extractSymbols(sanitized, language);
    const imports = this.extractImports(sanitized, language);
    const exportsList = symbols.filter((s) => s.exported).map((s) => s.name);
    const routes = this.extractRoutes(sanitized, relPath, moduleId);
    const models = this.extractDatabaseModels(sanitized, relPath, moduleId, language);

    for (const r of routes) symbols.push({ name: `${r.method} ${r.path}`, kind: 'route', line: r.line, exported: true });
    for (const m of models) symbols.push({ name: m.name, kind: 'model', line: m.line, exported: true });

    const summary = this.buildFileSummary(relPath, role, language, symbols, imports, routes, models, sanitized);

    return {
      fileRecord: {
        relativePath: relPath, sha256, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
        language, moduleId, role, symbols, imports, exports: exportsList,
        summary, verificationStatus: 'verified', lastVerifiedAt: new Date().toISOString()
      },
      routes,
      models
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
        const constMatch = line.match(/^\s*(export\s+)const\s+([A-Za-z0-9_]+)\s*=/);
        if (constMatch) { symbols.push({ name: constMatch[2], kind: 'const', line: lineNum, exported: true }); continue; }
      } else if (language === 'python') {
        const pyClass = line.match(/^class\s+([A-Za-z0-9_]+)/);
        if (pyClass) { symbols.push({ name: pyClass[1], kind: 'class', line: lineNum, exported: !pyClass[1].startsWith('_') }); continue; }
        const pyDef = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
        if (pyDef) { symbols.push({ name: pyDef[1], kind: 'function', line: lineNum, exported: !pyDef[1].startsWith('_') }); continue; }
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
          const para = lines.find((l) => l.trim().length > 25 && !l.trim().startsWith('#') && !l.trim().startsWith('!'));
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
      for (const imp of f.imports) {
        const targetMod = this.resolveImportToModuleId(imp, f.relativePath, allModuleIds);
        if (targetMod && targetMod !== f.moduleId) {
          forwardDeps.get(f.moduleId)?.add(targetMod);
          reverseDeps.get(targetMod)?.add(f.moduleId);
        } else if (!imp.startsWith('.') && !imp.startsWith('/')) {
          forwardDeps.get(f.moduleId)?.add(imp);
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
    prevMod?: ModuleKnowledgeRecord
  ): ModuleKnowledgeRecord {
    const allModuleIds = new Set<string>(allFiles.map((f) => f.moduleId));
    const deps = new Set<string>();
    const dependents = new Set<string>();

    for (const f of modFiles) {
      for (const imp of f.imports) {
        const targetMod = this.resolveImportToModuleId(imp, f.relativePath, allModuleIds);
        if (targetMod && targetMod !== modId) deps.add(targetMod);
        else if (!imp.startsWith('.') && !imp.startsWith('/')) deps.add(imp);
      }
    }

    for (const other of allFiles) {
      if (other.moduleId === modId) continue;
      for (const imp of other.imports) {
        const targetMod = this.resolveImportToModuleId(imp, other.relativePath, allModuleIds);
        if (targetMod === modId) dependents.add(other.moduleId);
      }
    }

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
      routes: prevMod?.routes || [],
      models: prevMod?.models || [],
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
