import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  CoreMemoryRecord,
  FileRecord,
  ModuleKnowledgeRecord,
  ArchitecturalDecisionRecord,
  KnowledgeItemRecord,
  TaskContextRecord,
  MEMORY_SCHEMA_VERSION,
  DEFAULT_DATA_DIR_NAME,
  SafeLogger
} from '@projectmind/shared';

export interface SqlOperation {
  kind: 'exec' | 'run' | 'get' | 'all';
  sql: string;
  params?: unknown[];
}

export class SqliteEngine {
  public readonly dbPath: string;
  private readonly bridgePath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.bridgePath = path.join(__dirname, 'sqlite_bridge.py');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  public batch(ops: SqlOperation[]): unknown[] {
    if (ops.length === 0) return [];
    const payload = JSON.stringify({ dbPath: this.dbPath, ops });
    const res = spawnSync('python3', [this.bridgePath], {
      input: payload,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000
    });
    if (res.error) {
      throw new Error(`SQLite bridge execution failed: ${res.error.message}`);
    }
    if (!res.stdout) {
      throw new Error(`SQLite bridge returned empty stdout (stderr: ${res.stderr})`);
    }
    let parsed: { ok: boolean; results?: unknown[]; error?: string };
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`Failed to parse SQLite bridge output: ${res.stdout}`);
    }
    if (!parsed.ok) {
      throw new Error(`SQLite error: ${parsed.error}`);
    }
    return parsed.results || [];
  }

  public exec(sql: string): void {
    this.batch([{ kind: 'exec', sql }]);
  }

  public run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
    const [res] = this.batch([{ kind: 'run', sql, params }]);
    return res as { changes: number; lastInsertRowid: number };
  }

  public get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
    const [res] = this.batch([{ kind: 'get', sql, params }]);
    return (res as T) ?? null;
  }

  public all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const [res] = this.batch([{ kind: 'all', sql, params }]);
    return (res as T[]) || [];
  }
}

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_memory (
  project_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  project_root TEXT NOT NULL,
  previous_roots_json TEXT NOT NULL DEFAULT '[]',
  main_tech_stack_json TEXT NOT NULL,
  project_purpose TEXT NOT NULL,
  key_constraints_json TEXT NOT NULL DEFAULT '[]',
  architectural_summary TEXT NOT NULL DEFAULT '',
  current_state TEXT NOT NULL,
  memory_schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_commit TEXT
);

CREATE TABLE IF NOT EXISTS project_files (
  relative_path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  language TEXT NOT NULL,
  module_id TEXT NOT NULL,
  role TEXT NOT NULL,
  symbols_json TEXT NOT NULL DEFAULT '[]',
  imports_json TEXT NOT NULL DEFAULT '[]',
  exports_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  last_verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_files_module ON project_files(module_id);
CREATE INDEX IF NOT EXISTS idx_project_files_sha256 ON project_files(sha256);

CREATE TABLE IF NOT EXISTS project_modules (
  module_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  purpose TEXT NOT NULL,
  entry_files_json TEXT NOT NULL DEFAULT '[]',
  file_count INTEGER NOT NULL DEFAULT 0,
  public_symbols_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  dependents_json TEXT NOT NULL DEFAULT '[]',
  routes_json TEXT NOT NULL DEFAULT '[]',
  models_json TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  last_verified_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS architectural_decisions (
  decision_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  related_modules_json TEXT NOT NULL DEFAULT '[]',
  source_references_json TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  superseded_by TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  knowledge_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  source_files_json TEXT NOT NULL DEFAULT '[]',
  related_modules_json TEXT NOT NULL DEFAULT '[]',
  file_fingerprint TEXT,
  verification_status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  version INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_items(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_items(verification_status);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  entity_id UNINDEXED,
  entity_type UNINDEXED,
  title,
  summary,
  keywords,
  source_path
);

CREATE TABLE IF NOT EXISTS task_contexts (
  task_id TEXT PRIMARY KEY,
  task_description TEXT NOT NULL,
  scope_level TEXT NOT NULL,
  relevant_files_json TEXT NOT NULL DEFAULT '[]',
  relevant_modules_json TEXT NOT NULL DEFAULT '[]',
  retrieved_decisions_json TEXT NOT NULL DEFAULT '[]',
  related_dependencies_json TEXT NOT NULL DEFAULT '[]',
  current_changes_json TEXT NOT NULL DEFAULT '[]',
  potential_impact_json TEXT NOT NULL DEFAULT '[]',
  context_budget_tokens INTEGER NOT NULL,
  estimated_tokens_used INTEGER NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  deleted_files_json TEXT NOT NULL DEFAULT '[]',
  renamed_files_json TEXT NOT NULL DEFAULT '[]',
  affected_modules_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS retrieval_cache (
  cache_key TEXT PRIMARY KEY,
  query_text TEXT NOT NULL,
  scope_level TEXT NOT NULL,
  related_modules_json TEXT NOT NULL DEFAULT '[]',
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS vector_embeddings (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export class ProjectMemoryStore {
  public readonly projectRoot: string;
  public readonly dataDir: string;
  public readonly dbPath: string;
  public readonly sqlite: SqliteEngine;
  private readonly logger: SafeLogger;
  public recoveredFromCorruption = false;

  constructor(projectRoot: string, dataDirName: string = DEFAULT_DATA_DIR_NAME) {
    this.projectRoot = path.resolve(projectRoot);
    this.dataDir = path.join(this.projectRoot, dataDirName);
    this.dbPath = path.join(this.dataDir, 'projectmind.db');
    this.logger = new SafeLogger('Storage', true);
    this.ensureDataDirAndGitignore();
    this.sqlite = new SqliteEngine(this.dbPath);
    this.initializeAndMigrateSafely();
  }

  private ensureDataDirAndGitignore(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'backups'), { recursive: true });
    const gitignorePath = path.join(this.dataDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(
        gitignorePath,
        [
          '# ProjectMind local intelligence database and temporary state',
          'projectmind.db',
          'projectmind.db-wal',
          'projectmind.db-shm',
          'backups/',
          'task-cache.json',
          '*.tmp',
          ''
        ].join('\n'),
        'utf8'
      );
    }
  }

  private initializeAndMigrateSafely(): void {
    if (fs.existsSync(this.dbPath)) {
      try {
        const integrity = this.sqlite.get<{ integrity_check: string }>('PRAGMA integrity_check;');
        if (!integrity || integrity.integrity_check !== 'ok') {
          throw new Error('SQLite integrity check failed');
        }
      } catch (err) {
        this.recoverCorruptedDatabase();
      }
    }
    this.applyMigrations();
  }

  public recoverCorruptedDatabase(): void {
    this.recoveredFromCorruption = true;
    const corruptedBackup = path.join(this.dataDir, 'backups', `corrupted-${Date.now()}.db.bak`);
    try {
      if (fs.existsSync(this.dbPath)) {
        fs.copyFileSync(this.dbPath, corruptedBackup);
        fs.rmSync(this.dbPath, { force: true });
      }
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(this.dbPath + suffix)) {
          fs.rmSync(this.dbPath + suffix, { force: true });
        }
      }
    } catch (_) {}
    this.applyMigrations();
  }

  public createBackup(label = 'manual'): string {
    if (!fs.existsSync(this.dbPath)) return '';
    const backupFile = path.join(this.dataDir, 'backups', `projectmind-${label}-${Date.now()}.db`);
    fs.copyFileSync(this.dbPath, backupFile);
    return backupFile;
  }

  public applyMigrations(): void {
    this.sqlite.exec(SCHEMA_V1_SQL);
    const appliedRows = this.sqlite.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version ASC');
    const applied = new Set(appliedRows.map((r) => r.version));

    const now = new Date().toISOString();
    if (!applied.has(1)) {
      this.sqlite.run(
        'INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)',
        [1, now, 'Initial 3-layer memory schema and FTS5 index']
      );
    }
    if (!applied.has(2)) {
      if (applied.size > 0) this.createBackup('pre-v2');
      this.sqlite.exec(SCHEMA_V2_SQL);
      this.sqlite.run(
        'INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)',
        [2, now, 'Add retrieval_cache table for context efficiency']
      );
    }
    if (!applied.has(3)) {
      if (applied.size > 0) this.createBackup('pre-v3');
      this.sqlite.exec(SCHEMA_V3_SQL);
      this.sqlite.run(
        'INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)',
        [3, now, 'Add vector_embeddings table for semantic search interface']
      );
    }
  }

  public getAppliedMigrations(): Array<{ version: number; applied_at: string; description: string }> {
    return this.sqlite.all('SELECT version, applied_at, description FROM schema_migrations ORDER BY version ASC');
  }

  public saveCoreMemory(core: CoreMemoryRecord): void {
    this.sqlite.run(
      `INSERT INTO core_memory (
        project_id, project_name, project_root, previous_roots_json,
        main_tech_stack_json, project_purpose, key_constraints_json,
        architectural_summary, current_state, memory_schema_version,
        created_at, updated_at, last_verified_commit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_name = excluded.project_name,
        project_root = excluded.project_root,
        previous_roots_json = excluded.previous_roots_json,
        main_tech_stack_json = excluded.main_tech_stack_json,
        project_purpose = excluded.project_purpose,
        key_constraints_json = excluded.key_constraints_json,
        architectural_summary = excluded.architectural_summary,
        current_state = excluded.current_state,
        memory_schema_version = excluded.memory_schema_version,
        updated_at = excluded.updated_at,
        last_verified_commit = excluded.last_verified_commit`,
      [
        core.projectId,
        core.projectName,
        core.projectRoot,
        JSON.stringify(core.previousRoots || []),
        JSON.stringify(core.mainTechStack),
        core.projectPurpose,
        JSON.stringify(core.keyConstraints || []),
        core.architecturalSummary,
        core.currentState,
        core.memorySchemaVersion || MEMORY_SCHEMA_VERSION,
        core.createdAt,
        core.updatedAt,
        core.lastVerifiedCommit || null
      ]
    );
    const manifestPath = path.join(this.dataDir, 'core-memory.json');
    fs.writeFileSync(manifestPath, JSON.stringify(core, null, 2) + '\n', 'utf8');
  }

  public getCoreMemory(): CoreMemoryRecord | null {
    const row = this.sqlite.get<Record<string, unknown>>('SELECT * FROM core_memory LIMIT 1');
    if (!row) return null;
    return {
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      projectRoot: String(row.project_root),
      previousRoots: JSON.parse(String(row.previous_roots_json || '[]')),
      mainTechStack: JSON.parse(String(row.main_tech_stack_json || '{}')),
      projectPurpose: String(row.project_purpose),
      keyConstraints: JSON.parse(String(row.key_constraints_json || '[]')),
      architecturalSummary: String(row.architectural_summary || ''),
      currentState: row.current_state as CoreMemoryRecord['currentState'],
      memorySchemaVersion: Number(row.memory_schema_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastVerifiedCommit: row.last_verified_commit ? String(row.last_verified_commit) : undefined
    };
  }

  public upsertFilesBatch(files: FileRecord[]): void {
    if (files.length === 0) return;
    const ops: SqlOperation[] = [];
    for (const f of files) {
      ops.push({
        kind: 'run',
        sql: `INSERT INTO project_files (
          relative_path, sha256, size_bytes, mtime_ms, language, module_id, role,
          symbols_json, imports_json, exports_json, summary, verification_status, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(relative_path) DO UPDATE SET
          sha256 = excluded.sha256,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          language = excluded.language,
          module_id = excluded.module_id,
          role = excluded.role,
          symbols_json = excluded.symbols_json,
          imports_json = excluded.imports_json,
          exports_json = excluded.exports_json,
          summary = excluded.summary,
          verification_status = excluded.verification_status,
          last_verified_at = excluded.last_verified_at`,
        params: [
          f.relativePath, f.sha256, f.sizeBytes, f.mtimeMs, f.language, f.moduleId, f.role,
          JSON.stringify(f.symbols), JSON.stringify(f.imports), JSON.stringify(f.exports),
          f.summary, f.verificationStatus, f.lastVerifiedAt
        ]
      });
      ops.push({
        kind: 'run',
        sql: `DELETE FROM knowledge_fts WHERE entity_id = ? AND entity_type = 'file'`,
        params: [f.relativePath]
      });
      const symbolNames = f.symbols.map((s) => s.name).join(' ');
      ops.push({
        kind: 'run',
        sql: `INSERT INTO knowledge_fts(entity_id, entity_type, title, summary, keywords, source_path)
              VALUES (?, 'file', ?, ?, ?, ?)`,
        params: [
          f.relativePath,
          path.posix.basename(f.relativePath),
          f.summary,
          `${f.language} ${f.role} ${f.moduleId} ${symbolNames} ${f.exports.join(' ')}`,
          f.relativePath
        ]
      });
    }
    this.sqlite.batch(ops);
  }

  public deleteFilesBatch(relativePaths: string[]): void {
    if (relativePaths.length === 0) return;
    const ops: SqlOperation[] = [];
    for (const rel of relativePaths) {
      ops.push({ kind: 'run', sql: 'DELETE FROM project_files WHERE relative_path = ?', params: [rel] });
      ops.push({ kind: 'run', sql: `DELETE FROM knowledge_fts WHERE entity_id = ? AND entity_type = 'file'`, params: [rel] });
    }
    this.sqlite.batch(ops);
  }

  public getFile(relativePath: string): FileRecord | null {
    const normalized = relativePath.replace(/\\/g, '/');
    const row = this.sqlite.get<Record<string, unknown>>('SELECT * FROM project_files WHERE relative_path = ?', [normalized]);
    return row ? this.mapFileRow(row) : null;
  }

  public getAllFiles(): FileRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM project_files ORDER BY relative_path ASC');
    return rows.map((r) => this.mapFileRow(r));
  }

  public getFilesByModule(moduleId: string): FileRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>(
      'SELECT * FROM project_files WHERE module_id = ? ORDER BY relative_path ASC',
      [moduleId]
    );
    return rows.map((r) => this.mapFileRow(r));
  }

  private mapFileRow(row: Record<string, unknown>): FileRecord {
    return {
      relativePath: String(row.relative_path),
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      language: String(row.language),
      moduleId: String(row.module_id),
      role: row.role as FileRecord['role'],
      symbols: JSON.parse(String(row.symbols_json || '[]')),
      imports: JSON.parse(String(row.imports_json || '[]')),
      exports: JSON.parse(String(row.exports_json || '[]')),
      summary: String(row.summary),
      verificationStatus: row.verification_status as FileRecord['verificationStatus'],
      lastVerifiedAt: String(row.last_verified_at)
    };
  }

  public upsertModulesBatch(modules: ModuleKnowledgeRecord[]): void {
    if (modules.length === 0) return;
    const ops: SqlOperation[] = [];
    for (const m of modules) {
      ops.push({
        kind: 'run',
        sql: `INSERT INTO project_modules (
          module_id, name, root_path, purpose, entry_files_json, file_count,
          public_symbols_json, dependencies_json, dependents_json, routes_json,
          models_json, verification_status, confidence, last_verified_at, fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module_id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          purpose = excluded.purpose,
          entry_files_json = excluded.entry_files_json,
          file_count = excluded.file_count,
          public_symbols_json = excluded.public_symbols_json,
          dependencies_json = excluded.dependencies_json,
          dependents_json = excluded.dependents_json,
          routes_json = excluded.routes_json,
          models_json = excluded.models_json,
          verification_status = excluded.verification_status,
          confidence = excluded.confidence,
          last_verified_at = excluded.last_verified_at,
          fingerprint = excluded.fingerprint`,
        params: [
          m.moduleId, m.name, m.rootPath, m.purpose, JSON.stringify(m.entryFiles), m.fileCount,
          JSON.stringify(m.publicSymbols), JSON.stringify(m.dependencies), JSON.stringify(m.dependents),
          JSON.stringify(m.routes), JSON.stringify(m.models), m.verificationStatus, m.confidence,
          m.lastVerifiedAt, m.fingerprint
        ]
      });
      ops.push({
        kind: 'run',
        sql: `DELETE FROM knowledge_fts WHERE entity_id = ? AND entity_type = 'module'`,
        params: [m.moduleId]
      });
      ops.push({
        kind: 'run',
        sql: `INSERT INTO knowledge_fts(entity_id, entity_type, title, summary, keywords, source_path)
              VALUES (?, 'module', ?, ?, ?, ?)`,
        params: [
          m.moduleId, m.name, m.purpose,
          `${m.publicSymbols.join(' ')} ${m.dependencies.join(' ')} ${m.routes.map((r) => r.path).join(' ')} ${m.models.map((md) => md.name).join(' ')}`,
          m.rootPath
        ]
      });
    }
    this.sqlite.batch(ops);
  }

  public getModule(moduleId: string): ModuleKnowledgeRecord | null {
    const row = this.sqlite.get<Record<string, unknown>>(
      'SELECT * FROM project_modules WHERE module_id = ? OR name = ?',
      [moduleId, moduleId]
    );
    return row ? this.mapModuleRow(row) : null;
  }

  public getAllModules(): ModuleKnowledgeRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM project_modules ORDER BY module_id ASC');
    return rows.map((r) => this.mapModuleRow(r));
  }

  private mapModuleRow(row: Record<string, unknown>): ModuleKnowledgeRecord {
    return {
      moduleId: String(row.module_id),
      name: String(row.name),
      rootPath: String(row.root_path),
      purpose: String(row.purpose),
      entryFiles: JSON.parse(String(row.entry_files_json || '[]')),
      fileCount: Number(row.file_count),
      publicSymbols: JSON.parse(String(row.public_symbols_json || '[]')),
      dependencies: JSON.parse(String(row.dependencies_json || '[]')),
      dependents: JSON.parse(String(row.dependents_json || '[]')),
      routes: JSON.parse(String(row.routes_json || '[]')),
      models: JSON.parse(String(row.models_json || '[]')),
      verificationStatus: row.verification_status as ModuleKnowledgeRecord['verificationStatus'],
      confidence: Number(row.confidence),
      lastVerifiedAt: String(row.last_verified_at),
      fingerprint: String(row.fingerprint)
    };
  }

  public upsertDecision(decision: ArchitecturalDecisionRecord): void {
    this.sqlite.batch([
      {
        kind: 'run',
        sql: `INSERT INTO architectural_decisions (
          decision_id, title, context, decision, consequences_json, constraints_json,
          related_modules_json, source_references_json, verification_status, recorded_at, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(decision_id) DO UPDATE SET
          title = excluded.title,
          context = excluded.context,
          decision = excluded.decision,
          consequences_json = excluded.consequences_json,
          constraints_json = excluded.constraints_json,
          related_modules_json = excluded.related_modules_json,
          source_references_json = excluded.source_references_json,
          verification_status = excluded.verification_status,
          recorded_at = excluded.recorded_at,
          superseded_by = excluded.superseded_by`,
        params: [
          decision.decisionId, decision.title, decision.context, decision.decision,
          JSON.stringify(decision.consequences), JSON.stringify(decision.constraints),
          JSON.stringify(decision.relatedModules), JSON.stringify(decision.sourceReferences),
          decision.verificationStatus, decision.recordedAt, decision.supersededBy || null
        ]
      },
      {
        kind: 'run',
        sql: `DELETE FROM knowledge_fts WHERE entity_id = ? AND entity_type = 'decision'`,
        params: [decision.decisionId]
      },
      {
        kind: 'run',
        sql: `INSERT INTO knowledge_fts(entity_id, entity_type, title, summary, keywords, source_path)
              VALUES (?, 'decision', ?, ?, ?, ?)`,
        params: [
          decision.decisionId, decision.title, `${decision.decision} (${decision.context})`,
          `${decision.constraints.join(' ')} ${decision.relatedModules.join(' ')}`,
          decision.sourceReferences[0] || ''
        ]
      }
    ]);
  }

  public getDecisions(moduleFilter?: string): ArchitecturalDecisionRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM architectural_decisions ORDER BY recorded_at DESC');
    const all = rows.map((row) => ({
      decisionId: String(row.decision_id),
      title: String(row.title),
      context: String(row.context),
      decision: String(row.decision),
      consequences: JSON.parse(String(row.consequences_json || '[]')),
      constraints: JSON.parse(String(row.constraints_json || '[]')),
      relatedModules: JSON.parse(String(row.related_modules_json || '[]')),
      sourceReferences: JSON.parse(String(row.source_references_json || '[]')),
      verificationStatus: row.verification_status as ArchitecturalDecisionRecord['verificationStatus'],
      recordedAt: String(row.recorded_at),
      supersededBy: row.superseded_by ? String(row.superseded_by) : undefined
    }));
    if (!moduleFilter) return all;
    return all.filter((d) => d.relatedModules.includes(moduleFilter) || d.relatedModules.includes('*'));
  }

  public upsertKnowledgeItemsBatch(items: KnowledgeItemRecord[]): void {
    if (items.length === 0) return;
    const ops: SqlOperation[] = [];
    for (const item of items) {
      ops.push({
        kind: 'run',
        sql: `INSERT INTO knowledge_items (
          knowledge_id, category, title, summary, details_json, source_files_json,
          related_modules_json, file_fingerprint, verification_status, confidence, version, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(knowledge_id) DO UPDATE SET
          category = excluded.category,
          title = excluded.title,
          summary = excluded.summary,
          details_json = excluded.details_json,
          source_files_json = excluded.source_files_json,
          related_modules_json = excluded.related_modules_json,
          file_fingerprint = excluded.file_fingerprint,
          verification_status = excluded.verification_status,
          confidence = excluded.confidence,
          version = excluded.version,
          last_verified_at = excluded.last_verified_at`,
        params: [
          item.knowledgeId, item.category, item.title, item.summary,
          JSON.stringify(item.details || {}), JSON.stringify(item.sourceFiles || []),
          JSON.stringify(item.relatedModules || []), item.fileFingerprint || null,
          item.verificationStatus, item.confidence, item.version, item.lastVerifiedAt
        ]
      });
      ops.push({
        kind: 'run',
        sql: `DELETE FROM knowledge_fts WHERE entity_id = ? AND entity_type = 'knowledge'`,
        params: [item.knowledgeId]
      });
      ops.push({
        kind: 'run',
        sql: `INSERT INTO knowledge_fts(entity_id, entity_type, title, summary, keywords, source_path)
              VALUES (?, 'knowledge', ?, ?, ?, ?)`,
        params: [
          item.knowledgeId, item.title, item.summary,
          `${item.category} ${item.relatedModules.join(' ')} ${item.verificationStatus}`,
          item.sourceFiles[0] || ''
        ]
      });
    }
    this.sqlite.batch(ops);
  }

  public getKnowledgeItems(category?: KnowledgeItemRecord['category'], status?: string): KnowledgeItemRecord[] {
    let sql = 'SELECT * FROM knowledge_items';
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (status) { clauses.push('verification_status = ?'); params.push(status); }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY title ASC';
    const rows = this.sqlite.all<Record<string, unknown>>(sql, params);
    return rows.map((row) => ({
      knowledgeId: String(row.knowledge_id),
      category: row.category as KnowledgeItemRecord['category'],
      title: String(row.title),
      summary: String(row.summary),
      details: JSON.parse(String(row.details_json || '{}')),
      sourceFiles: JSON.parse(String(row.source_files_json || '[]')),
      relatedModules: JSON.parse(String(row.related_modules_json || '[]')),
      fileFingerprint: row.file_fingerprint ? String(row.file_fingerprint) : undefined,
      verificationStatus: row.verification_status as KnowledgeItemRecord['verificationStatus'],
      confidence: Number(row.confidence),
      version: Number(row.version),
      lastVerifiedAt: String(row.last_verified_at)
    }));
  }

  public searchFts(
    rawQuery: string,
    limit = 15,
    entityTypeFilter?: 'file' | 'module' | 'decision' | 'knowledge'
  ): Array<{
    entityId: string;
    entityType: string;
    title: string;
    summary: string;
    sourcePath: string;
    score: number;
  }> {
    const terms = rawQuery
      .replace(/[^A-Za-z0-9_\-./ ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    let sql = `
      SELECT entity_id, entity_type, title, summary, source_path, bm25(knowledge_fts) AS rank_score
      FROM knowledge_fts
      WHERE knowledge_fts MATCH ?
    `;
    const params: unknown[] = [ftsQuery];
    if (entityTypeFilter) {
      sql += ' AND entity_type = ?';
      params.push(entityTypeFilter);
    }
    sql += ' ORDER BY rank_score ASC LIMIT ?';
    params.push(limit);

    try {
      const rows = this.sqlite.all<Record<string, unknown>>(sql, params);
      return rows.map((r) => ({
        entityId: String(r.entity_id),
        entityType: String(r.entity_type),
        title: String(r.title),
        summary: String(r.summary),
        sourcePath: String(r.source_path),
        score: Math.abs(Number(r.rank_score || 0))
      }));
    } catch (_) {
      return [];
    }
  }

  public saveTaskContext(task: TaskContextRecord): void {
    this.sqlite.run(
      `INSERT INTO task_contexts (
        task_id, task_description, scope_level, relevant_files_json,
        relevant_modules_json, retrieved_decisions_json, related_dependencies_json,
        current_changes_json, potential_impact_json, context_budget_tokens,
        estimated_tokens_used, warnings_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        task_description = excluded.task_description,
        scope_level = excluded.scope_level,
        relevant_files_json = excluded.relevant_files_json,
        relevant_modules_json = excluded.relevant_modules_json,
        retrieved_decisions_json = excluded.retrieved_decisions_json,
        related_dependencies_json = excluded.related_dependencies_json,
        current_changes_json = excluded.current_changes_json,
        potential_impact_json = excluded.potential_impact_json,
        context_budget_tokens = excluded.context_budget_tokens,
        estimated_tokens_used = excluded.estimated_tokens_used,
        warnings_json = excluded.warnings_json`,
      [
        task.taskId, task.taskDescription, task.scopeLevel,
        JSON.stringify(task.relevantFiles), JSON.stringify(task.relevantModules),
        JSON.stringify(task.retrievedDecisions), JSON.stringify(task.relatedDependencies),
        JSON.stringify(task.currentChanges), JSON.stringify(task.potentialImpact),
        task.contextBudgetTokens, task.estimatedTokensUsed, JSON.stringify(task.warnings), task.createdAt
      ]
    );
  }

  public getRecentTaskContexts(limit = 5): TaskContextRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM task_contexts ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => ({
      taskId: String(row.task_id),
      taskDescription: String(row.task_description),
      scopeLevel: row.scope_level as TaskContextRecord['scopeLevel'],
      relevantFiles: JSON.parse(String(row.relevant_files_json || '[]')),
      relevantModules: JSON.parse(String(row.relevant_modules_json || '[]')),
      retrievedDecisions: JSON.parse(String(row.retrieved_decisions_json || '[]')),
      relatedDependencies: JSON.parse(String(row.related_dependencies_json || '[]')),
      currentChanges: JSON.parse(String(row.current_changes_json || '[]')),
      potentialImpact: JSON.parse(String(row.potential_impact_json || '[]')),
      contextBudgetTokens: Number(row.context_budget_tokens),
      estimatedTokensUsed: Number(row.estimated_tokens_used),
      warnings: JSON.parse(String(row.warnings_json || '[]')),
      createdAt: String(row.created_at)
    }));
  }

  public getCachedRetrieval(cacheKey: string): Record<string, unknown> | null {
    const row = this.sqlite.get<Record<string, unknown>>('SELECT response_json FROM retrieval_cache WHERE cache_key = ?', [cacheKey]);
    if (!row) return null;
    try { return JSON.parse(String(row.response_json)); } catch (_) { return null; }
  }

  public setCachedRetrieval(
    cacheKey: string,
    queryText: string,
    scopeLevel: string,
    relatedModules: string[],
    response: Record<string, unknown>
  ): void {
    this.sqlite.run(
      `INSERT INTO retrieval_cache(cache_key, query_text, scope_level, related_modules_json, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         response_json = excluded.response_json,
         created_at = excluded.created_at`,
      [cacheKey, queryText, scopeLevel, JSON.stringify(relatedModules), JSON.stringify(response), new Date().toISOString()]
    );
  }

  public invalidateCacheForModules(affectedModules: string[]): void {
    if (affectedModules.length === 0) {
      this.sqlite.run('DELETE FROM retrieval_cache');
      return;
    }
    const rows = this.sqlite.all<{ cache_key: string; related_modules_json: string }>('SELECT cache_key, related_modules_json FROM retrieval_cache');
    const affectedSet = new Set(affectedModules);
    const toDelete: string[] = [];
    for (const r of rows) {
      const mods: string[] = JSON.parse(r.related_modules_json || '[]');
      if (mods.length === 0 || mods.some((m) => affectedSet.has(m))) {
        toDelete.push(r.cache_key);
      }
    }
    if (toDelete.length > 0) {
      this.sqlite.batch(toDelete.map((k) => ({ kind: 'run', sql: 'DELETE FROM retrieval_cache WHERE cache_key = ?', params: [k] })));
    }
  }

  public recordSyncEvent(event: {
    eventType: 'bootstrap' | 'incremental_sync' | 'prompt_init' | 'deep_analysis';
    changedFiles: string[];
    deletedFiles: string[];
    renamedFiles: Array<{ from: string; to: string }>;
    affectedModules: string[];
    summary: string;
  }): void {
    this.sqlite.run(
      `INSERT INTO sync_events (
        event_type, changed_files_json, deleted_files_json, renamed_files_json,
        affected_modules_json, summary, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventType, JSON.stringify(event.changedFiles), JSON.stringify(event.deletedFiles),
        JSON.stringify(event.renamedFiles), JSON.stringify(event.affectedModules), event.summary, new Date().toISOString()
      ]
    );
  }

  public getRecentSyncEvents(limit = 10): Array<{
    eventId: number;
    eventType: string;
    changedFiles: string[];
    deletedFiles: string[];
    renamedFiles: Array<{ from: string; to: string }>;
    affectedModules: string[];
    summary: string;
    recordedAt: string;
  }> {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM sync_events ORDER BY event_id DESC LIMIT ?', [limit]);
    return rows.map((r) => ({
      eventId: Number(r.event_id),
      eventType: String(r.event_type),
      changedFiles: JSON.parse(String(r.changed_files_json || '[]')),
      deletedFiles: JSON.parse(String(r.deleted_files_json || '[]')),
      renamedFiles: JSON.parse(String(r.renamed_files_json || '[]')),
      affectedModules: JSON.parse(String(r.affected_modules_json || '[]')),
      summary: String(r.summary),
      recordedAt: String(r.recorded_at)
    }));
  }
}
