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
  MemoryEventRecord,
  MemoryConflictRecord,
  WorkspaceSnapshotRecord,
  CodeGraphEdge,
  CodeSymbolRecord,
  FileChunkRecord,
  IndexManifestRecord,
  MEMORY_SCHEMA_VERSION,
  DEFAULT_DATA_DIR_NAME,
  PARSER_VERSION,
  CHUNKER_VERSION,
  RETRIEVAL_VERSION,
  EMBEDDING_MODEL,
  canonicalJson,
  computeSha256,
  generateId,
  SafeLogger
} from '@projectmind/shared';

export interface SqlOperation {
  kind: 'exec' | 'run' | 'get' | 'all';
  sql: string;
  params?: unknown[];
}

interface PythonInvocation {
  command: string;
  prefixArgs: string[];
}

let cachedPython: PythonInvocation | null = null;

/**
 * Resolves a Python interpreter that can import sqlite3. Linux/macOS normally
 * expose `python3`; Windows exposes `python` or the `py -3` launcher.
 */
function resolvePythonInvocation(): PythonInvocation {
  if (cachedPython) return cachedPython;
  const candidates: PythonInvocation[] = [];
  if (process.env.PROJECTMIND_PYTHON) {
    candidates.push({ command: process.env.PROJECTMIND_PYTHON, prefixArgs: [] });
  }
  candidates.push(
    { command: 'python3', prefixArgs: [] },
    { command: 'python', prefixArgs: [] },
    { command: 'py', prefixArgs: ['-3'] }
  );
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.command, [...candidate.prefixArgs, '-c', 'import sqlite3, sys; sys.exit(0)'], {
        encoding: 'utf8',
        timeout: 5000
      });
      if (probe.status === 0) {
        cachedPython = candidate;
        return candidate;
      }
    } catch (_) {}
  }
  cachedPython = { command: 'python3', prefixArgs: [] };
  return cachedPython;
}

export class SqliteEngine {
  public readonly dbPath: string;
  private readonly bridgePath: string;
  private readonly python: PythonInvocation;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.bridgePath = path.join(__dirname, 'sqlite_bridge.py');
    this.python = resolvePythonInvocation();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  public batch(ops: SqlOperation[]): unknown[] {
    if (ops.length === 0) return [];
    const payload = JSON.stringify({ dbPath: this.dbPath, ops });
    const res = spawnSync(this.python.command, [...this.python.prefixArgs, this.bridgePath], {
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

/**
 * Schema v4 — trustworthy shared memory.
 *
 * Adds:
 *  - append-only `memory_events` with a SHA-256 hash chain and no UPDATE/DELETE
 *  - workspace snapshots used to bind caches to a concrete tree state
 *  - bi-temporal validity columns on knowledge and decisions
 *  - optimistic-concurrency conflict proposals
 *  - a real file/symbol code graph and chunk hashes
 *  - an index manifest carrying parser/chunker/embedder versions
 */
const SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  git_head TEXT,
  git_branch TEXT,
  aggregate_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON workspace_snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  base_commit TEXT,
  snapshot_id TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  supersedes TEXT,
  caused_by TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared',
  parser_version TEXT,
  model_version TEXT,
  prev_hash TEXT,
  event_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON memory_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_namespace ON memory_events(namespace);
CREATE INDEX IF NOT EXISTS idx_events_ingested ON memory_events(ingested_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_hash ON memory_events(event_hash);

CREATE TRIGGER IF NOT EXISTS memory_events_no_update
BEFORE UPDATE ON memory_events
BEGIN
  SELECT RAISE(ABORT, 'memory_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_events_no_delete
BEFORE DELETE ON memory_events
BEGIN
  SELECT RAISE(ABORT, 'memory_events is append-only');
END;

CREATE TABLE IF NOT EXISTS memory_conflicts (
  conflict_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  current_version INTEGER NOT NULL,
  current_payload_json TEXT NOT NULL DEFAULT '{}',
  proposed_payload_json TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON memory_conflicts(status);

CREATE TABLE IF NOT EXISTS code_graph_edges (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  specifier TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  target_module TEXT,
  PRIMARY KEY (from_path, to_path, kind, specifier, line)
);
CREATE INDEX IF NOT EXISTS idx_graph_to ON code_graph_edges(to_path);
CREATE INDEX IF NOT EXISTS idx_graph_from ON code_graph_edges(from_path);

CREATE TABLE IF NOT EXISTS code_symbols (
  symbol_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL DEFAULT 0,
  exported INTEGER NOT NULL DEFAULT 0,
  signature TEXT,
  module_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_path ON code_symbols(relative_path);

CREATE TABLE IF NOT EXISTS file_chunks (
  relative_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (relative_path, chunk_index)
);

CREATE TABLE IF NOT EXISTS index_manifest (
  project_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  aggregate_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  parser_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  embedder_version TEXT NOT NULL,
  retrieval_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const SCHEMA_V4_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: 'project_files', column: 'full_sha256', definition: 'TEXT' },
  { table: 'project_files', column: 'analysis_sha256', definition: 'TEXT' },
  { table: 'project_files', column: 'parser_version', definition: 'TEXT' },
  { table: 'project_files', column: 'analysis_status', definition: "TEXT NOT NULL DEFAULT 'ok'" },
  { table: 'project_files', column: 'line_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'project_files', column: 'resolved_imports_json', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'knowledge_items', column: 'namespace', definition: "TEXT NOT NULL DEFAULT 'project/shared'" },
  { table: 'knowledge_items', column: 'valid_from', definition: 'TEXT' },
  { table: 'knowledge_items', column: 'valid_to', definition: 'TEXT' },
  { table: 'knowledge_items', column: 'observed_at', definition: 'TEXT' },
  { table: 'knowledge_items', column: 'ingested_at', definition: 'TEXT' },
  { table: 'knowledge_items', column: 'superseded_by', definition: 'TEXT' },
  { table: 'knowledge_items', column: 'actor_id', definition: 'TEXT' },
  { table: 'knowledge_items', column: 'source_event_id', definition: 'TEXT' },
  { table: 'architectural_decisions', column: 'namespace', definition: "TEXT NOT NULL DEFAULT 'project/shared'" },
  { table: 'architectural_decisions', column: 'valid_from', definition: 'TEXT' },
  { table: 'architectural_decisions', column: 'valid_to', definition: 'TEXT' },
  { table: 'architectural_decisions', column: 'observed_at', definition: 'TEXT' },
  { table: 'architectural_decisions', column: 'ingested_at', definition: 'TEXT' },
  { table: 'architectural_decisions', column: 'actor_id', definition: 'TEXT' },
  { table: 'architectural_decisions', column: 'source_event_id', definition: 'TEXT' },
  { table: 'task_contexts', column: 'snapshot_id', definition: 'TEXT' },
  { table: 'retrieval_cache', column: 'snapshot_id', definition: 'TEXT' },
  { table: 'retrieval_cache', column: 'parser_version', definition: 'TEXT' },
  { table: 'retrieval_cache', column: 'retrieval_version', definition: 'TEXT' },
  { table: 'retrieval_cache', column: 'embedder_version', definition: 'TEXT' },
  { table: 'vector_embeddings', column: 'model', definition: 'TEXT' },
  { table: 'vector_embeddings', column: 'model_version', definition: 'TEXT' },
  { table: 'vector_embeddings', column: 'dims', definition: 'INTEGER' },
  { table: 'vector_embeddings', column: 'text_hash', definition: 'TEXT' },
  { table: 'vector_embeddings', column: 'chunk_hash', definition: 'TEXT' },
  { table: 'sync_events', column: 'memory_event_id', definition: 'TEXT' },
  { table: 'sync_events', column: 'actor_id', definition: 'TEXT' },
  { table: 'sync_events', column: 'snapshot_id', definition: 'TEXT' }
];

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
    // v4 additions are idempotent and also run on databases that already
    // recorded v4, so an interrupted migration repairs itself on next open.
    if (!applied.has(4) && applied.size > 0) this.createBackup('pre-v4');
    this.sqlite.exec(SCHEMA_V4_SQL);
    for (const col of SCHEMA_V4_COLUMNS) this.ensureColumn(col.table, col.column, col.definition);
    if (!applied.has(4)) {
      this.sqlite.run(
        'INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)',
        [4, now, 'Add append-only memory events, snapshots, temporal validity, conflicts, and code graph']
      );
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    try {
      const rows = this.sqlite.all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (rows.some((r) => r.name === column)) return;
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
      // Concurrent or repeated migration: only fail if the column truly is absent.
      try {
        const rows = this.sqlite.all<{ name: string }>(`PRAGMA table_info(${table})`);
        if (!rows.some((r) => r.name === column)) throw err;
      } catch (inner) {
        throw inner;
      }
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
      const fullSha = f.fullSha256 || f.sha256;
      const analysisSha = f.analysisSha256 || f.sha256;
      ops.push({
        kind: 'run',
        sql: `INSERT INTO project_files (
          relative_path, sha256, size_bytes, mtime_ms, language, module_id, role,
          symbols_json, imports_json, exports_json, summary, verification_status, last_verified_at,
          full_sha256, analysis_sha256, parser_version, analysis_status, line_count, resolved_imports_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          last_verified_at = excluded.last_verified_at,
          full_sha256 = excluded.full_sha256,
          analysis_sha256 = excluded.analysis_sha256,
          parser_version = excluded.parser_version,
          analysis_status = excluded.analysis_status,
          line_count = excluded.line_count,
          resolved_imports_json = excluded.resolved_imports_json`,
        params: [
          f.relativePath, fullSha, f.sizeBytes, f.mtimeMs, f.language, f.moduleId, f.role,
          JSON.stringify(f.symbols), JSON.stringify(f.imports), JSON.stringify(f.exports),
          f.summary, f.verificationStatus, f.lastVerifiedAt,
          fullSha, analysisSha, f.parserVersion || PARSER_VERSION, f.analysisStatus || 'ok', f.lineCount || 0,
          JSON.stringify(f.resolvedImports || [])
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
      ops.push({ kind: 'run', sql: 'DELETE FROM code_symbols WHERE relative_path = ?', params: [rel] });
      ops.push({ kind: 'run', sql: 'DELETE FROM file_chunks WHERE relative_path = ?', params: [rel] });
      ops.push({ kind: 'run', sql: 'DELETE FROM code_graph_edges WHERE from_path = ?', params: [rel] });
    }
    this.sqlite.batch(ops);
  }

  public deleteModulesBatch(moduleIds: string[]): void {
    if (moduleIds.length === 0) return;
    const ops: SqlOperation[] = [];
    for (const id of moduleIds) {
      ops.push({ kind: 'run', sql: 'DELETE FROM project_modules WHERE module_id = ?', params: [id] });
      ops.push({ kind: 'run', sql: `DELETE FROM knowledge_fts WHERE entity_id = ? AND entity_type = 'module'`, params: [id] });
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

  public getFilesByPaths(relativePaths: string[]): FileRecord[] {
    const unique = Array.from(new Set(relativePaths.filter(Boolean))).slice(0, 400);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.sqlite.all<Record<string, unknown>>(
      `SELECT * FROM project_files WHERE relative_path IN (${placeholders})`,
      unique
    );
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
    const storedSha = String(row.sha256);
    return {
      relativePath: String(row.relative_path),
      sha256: storedSha,
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      language: String(row.language),
      moduleId: String(row.module_id),
      role: row.role as FileRecord['role'],
      symbols: JSON.parse(String(row.symbols_json || '[]')),
      imports: JSON.parse(String(row.imports_json || '[]')),
      resolvedImports: JSON.parse(String(row.resolved_imports_json || '[]')),
      exports: JSON.parse(String(row.exports_json || '[]')),
      summary: String(row.summary),
      verificationStatus: row.verification_status as FileRecord['verificationStatus'],
      lastVerifiedAt: String(row.last_verified_at),
      fullSha256: row.full_sha256 ? String(row.full_sha256) : storedSha,
      analysisSha256: row.analysis_sha256 ? String(row.analysis_sha256) : storedSha,
      parserVersion: row.parser_version ? String(row.parser_version) : undefined,
      analysisStatus: (row.analysis_status as FileRecord['analysisStatus']) || 'ok',
      lineCount: Number(row.line_count || 0)
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

  public upsertDecision(
    decision: ArchitecturalDecisionRecord,
    options?: {
      actorType?: MemoryEventRecord['actorType'];
      actorId?: string;
      namespace?: string;
      snapshotId?: string;
      recordEvents?: boolean;
    }
  ): void {
    const now = new Date().toISOString();
    const namespace = (decision as ArchitecturalDecisionRecord & { namespace?: string }).namespace || options?.namespace || 'project/shared';
    const actorId = options?.actorId || 'system/indexer';
    const validFrom = (decision as ArchitecturalDecisionRecord & { validFrom?: string }).validFrom || decision.recordedAt || now;
    this.sqlite.batch([
      {
        kind: 'run',
        sql: `INSERT INTO architectural_decisions (
          decision_id, title, context, decision, consequences_json, constraints_json,
          related_modules_json, source_references_json, verification_status, recorded_at, superseded_by,
          namespace, valid_from, valid_to, observed_at, ingested_at, actor_id, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          superseded_by = excluded.superseded_by,
          namespace = excluded.namespace,
          valid_from = excluded.valid_from,
          valid_to = excluded.valid_to,
          observed_at = excluded.observed_at,
          ingested_at = excluded.ingested_at,
          actor_id = excluded.actor_id,
          source_event_id = excluded.source_event_id`,
        params: [
          decision.decisionId, decision.title, decision.context, decision.decision,
          JSON.stringify(decision.consequences), JSON.stringify(decision.constraints),
          JSON.stringify(decision.relatedModules), JSON.stringify(decision.sourceReferences),
          decision.verificationStatus, decision.recordedAt, decision.supersededBy || null,
          namespace, validFrom, null, now, now, actorId, null
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
          `${decision.constraints.join(' ')} ${decision.relatedModules.join(' ')} ${namespace}`,
          decision.sourceReferences[0] || ''
        ]
      }
    ]);

    if (options?.recordEvents !== false) {
      this.recordMemoryEvent({
        projectId: this.resolveProjectId(),
        repositoryId: this.projectRoot,
        branch: this.resolveBranch(),
        snapshotId: options?.snapshotId || '',
        actorType: options?.actorType || 'system',
        actorId,
        namespace,
        operation: 'decision',
        entityType: 'decision',
        entityId: decision.decisionId,
        payload: decision as unknown as Record<string, unknown>,
        sourceRefs: decision.sourceReferences,
        observedAt: now,
        ingestedAt: now,
        validFrom,
        supersedes: decision.supersededBy,
        visibility: this.visibilityForNamespace(namespace)
      });
    }
  }

  public getDecisions(
    moduleFilter?: string,
    options?: { includeSuperseded?: boolean; asOf?: string; namespace?: string }
  ): ArchitecturalDecisionRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM architectural_decisions ORDER BY recorded_at DESC');
    const all = rows
      .map((row) => ({
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
        supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
        namespace: String(row.namespace || 'project/shared'),
        validFrom: row.valid_from ? String(row.valid_from) : undefined,
        validTo: row.valid_to ? String(row.valid_to) : undefined,
        observedAt: row.observed_at ? String(row.observed_at) : undefined,
        ingestedAt: row.ingested_at ? String(row.ingested_at) : undefined,
        actorId: row.actor_id ? String(row.actor_id) : undefined
      }))
      .filter((d) => {
        if (!options?.includeSuperseded && !options?.asOf) {
          if (d.supersededBy) return false;
          if (d.validTo && d.validTo !== '') return false;
        }
        if (options?.asOf) {
          if (d.validFrom && d.validFrom > options.asOf) return false;
          if (d.validTo && d.validTo !== '' && d.validTo <= options.asOf) return false;
        }
        if (options?.namespace && d.namespace !== options.namespace) return false;
        return true;
      });
    if (!moduleFilter) return all;
    return all.filter((d) => d.relatedModules.includes(moduleFilter) || d.relatedModules.includes('*'));
  }

  public upsertKnowledgeItemsBatch(
    items: KnowledgeItemRecord[],
    options?: {
      actorType?: MemoryEventRecord['actorType'];
      actorId?: string;
      namespace?: string;
      expectedVersions?: Record<string, number>;
      recordEvents?: boolean;
      snapshotId?: string;
      branch?: string;
      baseCommit?: string;
    }
  ): { conflicts: MemoryConflictRecord[] } {
    if (items.length === 0) return { conflicts: [] };
    const conflicts: MemoryConflictRecord[] = [];
    const actorType = options?.actorType || 'system';
    const actorId = options?.actorId || 'system/indexer';
    const recordEvents = options?.recordEvents !== false;
    const now = new Date().toISOString();
    const ops: SqlOperation[] = [];

    for (const item of items) {
      const namespace = item.namespace || options?.namespace || 'project/shared';
      const expected = options?.expectedVersions?.[item.knowledgeId];
      let currentVersion = 0;
      let currentPayload: Record<string, unknown> = {};
      if (typeof expected === 'number') {
        const current = this.sqlite.get<Record<string, unknown>>(
          'SELECT * FROM knowledge_items WHERE knowledge_id = ?',
          [item.knowledgeId]
        );
        if (current) {
          currentVersion = Number(current.version || 1);
          currentPayload = this.mapKnowledgeRow(current) as unknown as Record<string, unknown>;
        }
        if (current && currentVersion !== expected) {
          const conflict = this.createConflict({
            entityType: 'knowledge',
            entityId: item.knowledgeId,
            namespace,
            baseVersion: expected,
            currentVersion,
            currentPayload,
            proposedPayload: item as unknown as Record<string, unknown>,
            actorId
          });
          conflicts.push(conflict);
          continue;
        }
      }

      const validFrom = item.validFrom || item.lastVerifiedAt || now;
      const observedAt = item.observedAt || now;
      const ingestedAt = item.ingestedAt || now;

      ops.push({
        kind: 'run',
        sql: `INSERT INTO knowledge_items (
          knowledge_id, category, title, summary, details_json, source_files_json,
          related_modules_json, file_fingerprint, verification_status, confidence, version, last_verified_at,
          namespace, valid_from, valid_to, observed_at, ingested_at, superseded_by, actor_id, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          last_verified_at = excluded.last_verified_at,
          namespace = excluded.namespace,
          valid_from = excluded.valid_from,
          valid_to = excluded.valid_to,
          observed_at = excluded.observed_at,
          ingested_at = excluded.ingested_at,
          superseded_by = excluded.superseded_by,
          actor_id = excluded.actor_id,
          source_event_id = excluded.source_event_id`,
        params: [
          item.knowledgeId, item.category, item.title, item.summary,
          JSON.stringify(item.details || {}), JSON.stringify(item.sourceFiles || []),
          JSON.stringify(item.relatedModules || []), item.fileFingerprint || null,
          item.verificationStatus, item.confidence, item.version, item.lastVerifiedAt,
          namespace, validFrom, item.validTo || null, observedAt, ingestedAt,
          item.supersededBy || null, item.actorId || actorId, item.sourceEventId || null
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
          `${item.category} ${(item.relatedModules || []).join(' ')} ${item.verificationStatus} ${namespace}`,
          (item.sourceFiles || [])[0] || ''
        ]
      });
    }
    this.sqlite.batch(ops);

    if (recordEvents) {
      for (const item of items) {
        if (conflicts.some((c) => c.entityId === item.knowledgeId)) continue;
        this.recordMemoryEvent({
          projectId: this.resolveProjectId(),
          repositoryId: this.projectRoot,
          branch: options?.branch || this.resolveBranch(),
          baseCommit: options?.baseCommit,
          snapshotId: options?.snapshotId || '',
          actorType: item.actorId ? 'agent' : actorType,
          actorId: item.actorId || actorId,
          namespace: item.namespace || options?.namespace || 'project/shared',
          operation: item.version > 1 ? 'update' : 'create',
          entityType: 'knowledge',
          entityId: item.knowledgeId,
          payload: item as unknown as Record<string, unknown>,
          sourceRefs: item.sourceFiles || [],
          observedAt: item.observedAt || now,
          ingestedAt: item.ingestedAt || now,
          validFrom: item.validFrom || item.lastVerifiedAt || now,
          supersedes: item.supersededBy ? undefined : undefined,
          visibility: this.visibilityForNamespace(item.namespace || options?.namespace || 'project/shared')
        });
      }
    }
    return { conflicts };
  }

  public getKnowledgeItems(
    category?: KnowledgeItemRecord['category'],
    status?: string,
    options?: { includeSuperseded?: boolean; asOf?: string; namespace?: string }
  ): KnowledgeItemRecord[] {
    let sql = 'SELECT * FROM knowledge_items';
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (status) { clauses.push('verification_status = ?'); params.push(status); }
    if (!options?.includeSuperseded && !options?.asOf) {
      clauses.push("(superseded_by IS NULL OR superseded_by = '')");
      clauses.push('(valid_to IS NULL OR valid_to > ?)');
      params.push(new Date().toISOString());
    }
    if (options?.asOf) {
      clauses.push('(valid_from IS NULL OR valid_from <= ?)');
      params.push(options.asOf);
      clauses.push('(valid_to IS NULL OR valid_to > ?)');
      params.push(options.asOf);
    }
    if (options?.namespace) {
      clauses.push('namespace = ?');
      params.push(options.namespace);
    }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY title ASC';
    const rows = this.sqlite.all<Record<string, unknown>>(sql, params);
    return rows.map((row) => this.mapKnowledgeRow(row));
  }

  private mapKnowledgeRow(row: Record<string, unknown>): KnowledgeItemRecord {
    return {
      knowledgeId: String(row.knowledge_id),
      namespace: String(row.namespace || 'project/shared'),
      validFrom: row.valid_from ? String(row.valid_from) : undefined,
      validTo: row.valid_to ? String(row.valid_to) : undefined,
      observedAt: row.observed_at ? String(row.observed_at) : undefined,
      ingestedAt: row.ingested_at ? String(row.ingested_at) : undefined,
      supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
      actorId: row.actor_id ? String(row.actor_id) : undefined,
      sourceEventId: row.source_event_id ? String(row.source_event_id) : undefined,
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
    };
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

  public getRetrievalCacheEntry(cacheKey: string): {
    response: Record<string, unknown>;
    snapshotId: string;
    parserVersion: string;
    retrievalVersion: string;
    embedderVersion: string;
    createdAt: string;
  } | null {
    const row = this.sqlite.get<Record<string, unknown>>(
      'SELECT response_json, snapshot_id, parser_version, retrieval_version, embedder_version, created_at FROM retrieval_cache WHERE cache_key = ?',
      [cacheKey]
    );
    if (!row) return null;
    try {
      return {
        response: JSON.parse(String(row.response_json)),
        snapshotId: String(row.snapshot_id || ''),
        parserVersion: String(row.parser_version || ''),
        retrievalVersion: String(row.retrieval_version || ''),
        embedderVersion: String(row.embedder_version || ''),
        createdAt: String(row.created_at || '')
      };
    } catch (_) {
      return null;
    }
  }

  public getCachedRetrieval(cacheKey: string): Record<string, unknown> | null {
    return this.getRetrievalCacheEntry(cacheKey)?.response || null;
  }

  public setCachedRetrieval(
    cacheKey: string,
    queryText: string,
    scopeLevel: string,
    relatedModules: string[],
    response: Record<string, unknown>,
    metadata?: {
      snapshotId?: string;
      parserVersion?: string;
      retrievalVersion?: string;
      embedderVersion?: string;
    }
  ): void {
    this.sqlite.run(
      `INSERT INTO retrieval_cache (
        cache_key, query_text, scope_level, related_modules_json, response_json, created_at,
        snapshot_id, parser_version, retrieval_version, embedder_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        query_text = excluded.query_text,
        scope_level = excluded.scope_level,
        related_modules_json = excluded.related_modules_json,
        response_json = excluded.response_json,
        created_at = excluded.created_at,
        snapshot_id = excluded.snapshot_id,
        parser_version = excluded.parser_version,
        retrieval_version = excluded.retrieval_version,
        embedder_version = excluded.embedder_version`,
      [
        cacheKey, queryText, scopeLevel, JSON.stringify(relatedModules), JSON.stringify(response),
        new Date().toISOString(), metadata?.snapshotId || '', metadata?.parserVersion || PARSER_VERSION,
        metadata?.retrievalVersion || RETRIEVAL_VERSION, metadata?.embedderVersion || EMBEDDING_MODEL
      ]
    );
  }

  public invalidateAllCache(): number {
    const res = this.sqlite.run('DELETE FROM retrieval_cache');
    return res.changes;
  }

  public getCacheStats(): { entries: number; oldest: string | null; newest: string | null } {
    const row = this.sqlite.get<{ count: number; oldest: string | null; newest: string | null }>(
      'SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM retrieval_cache'
    );
    return {
      entries: Number(row?.count || 0),
      oldest: row?.oldest ? String(row.oldest) : null,
      newest: row?.newest ? String(row.newest) : null
    };
  }

  public invalidateCacheForModules(affectedModules: string[]): void {
    if (affectedModules.length === 0) {
      this.invalidateAllCache();
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

  // ---------------------------------------------------------------------
  // Append-only memory event log
  // ---------------------------------------------------------------------
  private eventLockDepth = 0;

  private withEventLock<T>(fn: () => T): T {
    if (this.eventLockDepth > 0) {
      this.eventLockDepth++;
      try { return fn(); } finally { this.eventLockDepth--; }
    }
    const lockPath = path.join(this.dataDir, '.event.lock');
    const deadline = Date.now() + 5000;
    let acquired = false;
    while (!acquired) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        fs.closeSync(fd);
        acquired = true;
      } catch (err) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(lockPath);
        } catch (_) {}
        if (Date.now() > deadline) break;
        const waitUntil = Date.now() + 15;
        while (Date.now() < waitUntil) { /* tiny local spin */ }
      }
    }
    this.eventLockDepth = 1;
    try {
      return fn();
    } finally {
      this.eventLockDepth = 0;
      if (acquired) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
      }
    }
  }

  public getLastMemoryEvent(): MemoryEventRecord | null {
    const row = this.sqlite.get<Record<string, unknown>>(
      'SELECT * FROM memory_events ORDER BY rowid DESC LIMIT 1'
    );
    return row ? this.mapEventRow(row) : null;
  }

  private mapEventRow(row: Record<string, unknown>): MemoryEventRecord {
    return {
      eventId: String(row.event_id),
      projectId: String(row.project_id),
      repositoryId: String(row.repository_id || ''),
      branch: String(row.branch || ''),
      baseCommit: row.base_commit ? String(row.base_commit) : undefined,
      snapshotId: String(row.snapshot_id || ''),
      actorType: row.actor_type as MemoryEventRecord['actorType'],
      actorId: String(row.actor_id),
      namespace: String(row.namespace),
      operation: row.operation as MemoryEventRecord['operation'],
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      payload: JSON.parse(String(row.payload_json || '{}')),
      payloadHash: String(row.payload_hash),
      sourceRefs: JSON.parse(String(row.source_refs_json || '[]')),
      observedAt: String(row.observed_at),
      ingestedAt: String(row.ingested_at),
      validFrom: row.valid_from ? String(row.valid_from) : undefined,
      validTo: row.valid_to ? String(row.valid_to) : undefined,
      supersedes: row.supersedes ? String(row.supersedes) : undefined,
      causedBy: row.caused_by ? String(row.caused_by) : undefined,
      visibility: row.visibility as MemoryEventRecord['visibility'],
      parserVersion: row.parser_version ? String(row.parser_version) : undefined,
      modelVersion: row.model_version ? String(row.model_version) : undefined,
      prevHash: row.prev_hash ? String(row.prev_hash) : undefined,
      eventHash: String(row.event_hash)
    };
  }

  public recordMemoryEvent(
    input: Omit<MemoryEventRecord, 'eventId' | 'eventHash' | 'payloadHash' | 'prevHash' | 'ingestedAt'> & {
      eventId?: string;
      ingestedAt?: string;
    }
  ): MemoryEventRecord {
    return this.withEventLock(() => {
      const eventId = input.eventId || generateId('evt');
      const ingestedAt = input.ingestedAt || new Date().toISOString();
      const payloadHash = computeSha256(canonicalJson(input.payload || {}));
      const prevHash = this.getLastMemoryEvent()?.eventHash || '';
      const base = {
        eventId,
        projectId: input.projectId,
        repositoryId: input.repositoryId || '',
        branch: input.branch || '',
        baseCommit: input.baseCommit || '',
        snapshotId: input.snapshotId || '',
        actorType: input.actorType,
        actorId: input.actorId,
        namespace: input.namespace,
        operation: input.operation,
        entityType: input.entityType,
        entityId: input.entityId,
        payloadHash,
        sourceRefs: input.sourceRefs || [],
        observedAt: input.observedAt,
        ingestedAt,
        validFrom: input.validFrom || '',
        validTo: input.validTo || '',
        supersedes: input.supersedes || '',
        causedBy: input.causedBy || '',
        visibility: input.visibility,
        parserVersion: input.parserVersion || '',
        modelVersion: input.modelVersion || '',
        prevHash
      };
      const eventHash = computeSha256(canonicalJson(base));
      this.sqlite.run(
        `INSERT INTO memory_events (
          event_id, project_id, repository_id, branch, base_commit, snapshot_id,
          actor_type, actor_id, namespace, operation, entity_type, entity_id,
          payload_json, payload_hash, source_refs_json, observed_at, ingested_at,
          valid_from, valid_to, supersedes, caused_by, visibility, parser_version,
          model_version, prev_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId, base.projectId, base.repositoryId, base.branch, base.baseCommit || null,
          base.snapshotId, base.actorType, base.actorId, base.namespace, base.operation,
          base.entityType, base.entityId, JSON.stringify(input.payload || {}), payloadHash,
          JSON.stringify(base.sourceRefs), base.observedAt, base.ingestedAt,
          base.validFrom || null, base.validTo || null, base.supersedes || null,
          base.causedBy || null, base.visibility, base.parserVersion || null,
          base.modelVersion || null, prevHash || null, eventHash
        ]
      );
      return {
        ...input,
        eventId,
        ingestedAt,
        payloadHash,
        prevHash: prevHash || undefined,
        eventHash,
        sourceRefs: input.sourceRefs || []
      } as MemoryEventRecord;
    });
  }

  public getMemoryEvents(options?: {
    entityId?: string;
    entityType?: string;
    namespace?: string;
    limit?: number;
    since?: string;
  }): MemoryEventRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.entityId) { clauses.push('entity_id = ?'); params.push(options.entityId); }
    if (options?.entityType) { clauses.push('entity_type = ?'); params.push(options.entityType); }
    if (options?.namespace) { clauses.push('namespace = ?'); params.push(options.namespace); }
    if (options?.since) { clauses.push('ingested_at >= ?'); params.push(options.since); }
    const limit = Math.max(1, Math.min(1000, options?.limit || 50));
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.sqlite.all<Record<string, unknown>>(
      `SELECT * FROM memory_events${where} ORDER BY rowid DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map((row) => this.mapEventRow(row));
  }

  public verifyMemoryEventChain(): {
    valid: boolean;
    checked: number;
    brokenAt?: string;
    reason?: string;
  } {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM memory_events ORDER BY rowid ASC');
    let prev = '';
    for (const row of rows) {
      const event = this.mapEventRow(row);
      if ((event.prevHash || '') !== prev) {
        return { valid: false, checked: rows.length, brokenAt: event.eventId, reason: 'prev_hash does not match the previous event' };
      }
      const base = {
        eventId: event.eventId,
        projectId: event.projectId,
        repositoryId: event.repositoryId || '',
        branch: event.branch || '',
        baseCommit: event.baseCommit || '',
        snapshotId: event.snapshotId || '',
        actorType: event.actorType,
        actorId: event.actorId,
        namespace: event.namespace,
        operation: event.operation,
        entityType: event.entityType,
        entityId: event.entityId,
        payloadHash: event.payloadHash,
        sourceRefs: event.sourceRefs || [],
        observedAt: event.observedAt,
        ingestedAt: event.ingestedAt,
        validFrom: event.validFrom || '',
        validTo: event.validTo || '',
        supersedes: event.supersedes || '',
        causedBy: event.causedBy || '',
        visibility: event.visibility,
        parserVersion: event.parserVersion || '',
        modelVersion: event.modelVersion || '',
        prevHash: event.prevHash || ''
      };
      if (computeSha256(canonicalJson(base)) !== event.eventHash) {
        return { valid: false, checked: rows.length, brokenAt: event.eventId, reason: 'event_hash does not match event payload' };
      }
      prev = event.eventHash;
    }
    return { valid: true, checked: rows.length };
  }

  private resolveProjectId(): string {
    try {
      const row = this.sqlite.get<{ project_id: string }>('SELECT project_id FROM core_memory LIMIT 1');
      if (row?.project_id) return row.project_id;
    } catch (_) {}
    return 'uninitialized';
  }

  private resolveBranch(): string {
    try {
      const idPath = path.join(this.dataDir, 'project-id.json');
      if (fs.existsSync(idPath)) {
        const parsed = JSON.parse(fs.readFileSync(idPath, 'utf8'));
        if (parsed.branch) return String(parsed.branch);
      }
    } catch (_) {}
    return '';
  }

  private visibilityForNamespace(namespace: string): MemoryEventRecord['visibility'] {
    if (namespace.startsWith('project/agent/')) return 'agent-private';
    if (namespace.startsWith('project/user/')) return 'user-private';
    if (namespace.startsWith('project/branch/')) return 'branch';
    if (namespace.startsWith('project/task/')) return 'task';
    return 'shared';
  }

  // ---------------------------------------------------------------------
  // Snapshots, index manifest, conflict proposals, and code graph
  // ---------------------------------------------------------------------
  public saveWorkspaceSnapshot(snapshot: WorkspaceSnapshotRecord): void {
    this.sqlite.run(
      `INSERT INTO workspace_snapshots (
        snapshot_id, project_id, git_head, git_branch, aggregate_hash, file_count, dirty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        aggregate_hash = excluded.aggregate_hash,
        file_count = excluded.file_count,
        dirty = excluded.dirty,
        created_at = excluded.created_at`,
      [
        snapshot.snapshotId, snapshot.projectId, snapshot.gitHead || null, snapshot.gitBranch || null,
        snapshot.aggregateHash, snapshot.fileCount, snapshot.dirty ? 1 : 0, snapshot.createdAt
      ]
    );
  }

  public getLatestSnapshot(): WorkspaceSnapshotRecord | null {
    const row = this.sqlite.get<Record<string, unknown>>(
      'SELECT * FROM workspace_snapshots ORDER BY created_at DESC LIMIT 1'
    );
    if (!row) return null;
    return {
      snapshotId: String(row.snapshot_id),
      projectId: String(row.project_id),
      gitHead: row.git_head ? String(row.git_head) : undefined,
      gitBranch: row.git_branch ? String(row.git_branch) : undefined,
      aggregateHash: String(row.aggregate_hash),
      fileCount: Number(row.file_count),
      dirty: Boolean(row.dirty),
      createdAt: String(row.created_at)
    };
  }

  public setIndexManifest(manifest: IndexManifestRecord): void {
    this.sqlite.run(
      `INSERT INTO index_manifest (
        project_id, snapshot_id, aggregate_hash, file_count,
        parser_version, chunker_version, embedder_version, retrieval_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        snapshot_id = excluded.snapshot_id,
        aggregate_hash = excluded.aggregate_hash,
        file_count = excluded.file_count,
        parser_version = excluded.parser_version,
        chunker_version = excluded.chunker_version,
        embedder_version = excluded.embedder_version,
        retrieval_version = excluded.retrieval_version,
        created_at = excluded.created_at`,
      [
        manifest.projectId, manifest.snapshotId, manifest.aggregateHash, manifest.fileCount,
        manifest.parserVersion, manifest.chunkerVersion, manifest.embedderVersion,
        manifest.retrievalVersion, manifest.createdAt
      ]
    );
  }

  public getIndexManifest(): IndexManifestRecord | null {
    const row = this.sqlite.get<Record<string, unknown>>('SELECT * FROM index_manifest LIMIT 1');
    if (!row) return null;
    return {
      projectId: String(row.project_id),
      snapshotId: String(row.snapshot_id),
      aggregateHash: String(row.aggregate_hash),
      fileCount: Number(row.file_count),
      parserVersion: String(row.parser_version),
      chunkerVersion: String(row.chunker_version),
      embedderVersion: String(row.embedder_version),
      retrievalVersion: String(row.retrieval_version),
      createdAt: String(row.created_at)
    };
  }

  public replaceFileChunks(relativePath: string, chunks: FileChunkRecord[]): void {
    const ops: SqlOperation[] = [
      { kind: 'run', sql: 'DELETE FROM file_chunks WHERE relative_path = ?', params: [relativePath] }
    ];
    for (const chunk of chunks) {
      ops.push({
        kind: 'run',
        sql: `INSERT INTO file_chunks (relative_path, chunk_index, start_byte, end_byte, start_line, end_line, sha256)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          chunk.relativePath, chunk.chunkIndex, chunk.startByte, chunk.endByte,
          chunk.startLine || null, chunk.endLine || null, chunk.sha256
        ]
      });
    }
    this.sqlite.batch(ops);
  }

  public replaceFileChunksForFiles(paths: string[], chunks: FileChunkRecord[]): void {
    const ops: SqlOperation[] = [];
    for (const p of paths) {
      ops.push({ kind: 'run', sql: 'DELETE FROM file_chunks WHERE relative_path = ?', params: [p] });
    }
    for (const chunk of chunks) {
      ops.push({
        kind: 'run',
        sql: `INSERT OR REPLACE INTO file_chunks (relative_path, chunk_index, start_byte, end_byte, start_line, end_line, sha256)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          chunk.relativePath, chunk.chunkIndex, chunk.startByte, chunk.endByte,
          chunk.startLine || null, chunk.endLine || null, chunk.sha256
        ]
      });
    }
    if (ops.length > 0) this.sqlite.batch(ops);
  }

  public getFileChunks(relativePath: string): FileChunkRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>(
      'SELECT * FROM file_chunks WHERE relative_path = ? ORDER BY chunk_index ASC',
      [relativePath]
    );
    return rows.map((row) => ({
      relativePath: String(row.relative_path),
      chunkIndex: Number(row.chunk_index),
      startByte: Number(row.start_byte),
      endByte: Number(row.end_byte),
      startLine: row.start_line === null ? undefined : Number(row.start_line),
      endLine: row.end_line === null ? undefined : Number(row.end_line),
      sha256: String(row.sha256)
    }));
  }

  public replaceCodeGraphForFiles(
    fromPaths: string[],
    edges: CodeGraphEdge[],
    symbols: CodeSymbolRecord[]
  ): void {
    const ops: SqlOperation[] = [];
    for (const fromPath of fromPaths) {
      ops.push({ kind: 'run', sql: 'DELETE FROM code_graph_edges WHERE from_path = ?', params: [fromPath] });
      ops.push({ kind: 'run', sql: 'DELETE FROM code_symbols WHERE relative_path = ?', params: [fromPath] });
    }
    for (const edge of edges) {
      ops.push({
        kind: 'run',
        sql: `INSERT OR REPLACE INTO code_graph_edges (from_path, to_path, kind, specifier, line, resolved, target_module)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [edge.fromPath, edge.toPath, edge.kind, edge.specifier, edge.line, edge.resolved ? 1 : 0, edge.targetModule || null]
      });
    }
    for (const sym of symbols) {
      ops.push({
        kind: 'run',
        sql: `INSERT OR REPLACE INTO code_symbols (symbol_id, relative_path, name, kind, line, end_line, exported, signature, module_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [sym.symbolId, sym.relativePath, sym.name, sym.kind, sym.line, sym.endLine, sym.exported ? 1 : 0, sym.signature || null, sym.moduleId]
      });
    }
    if (ops.length > 0) this.sqlite.batch(ops);
  }

  public getCodeGraphEdges(options?: { fromPath?: string; toPath?: string; limit?: number }): CodeGraphEdge[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.fromPath) { clauses.push('from_path = ?'); params.push(options.fromPath); }
    if (options?.toPath) { clauses.push('to_path = ?'); params.push(options.toPath); }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    params.push(Math.max(1, Math.min(5000, options?.limit || 1000)));
    const rows = this.sqlite.all<Record<string, unknown>>(
      `SELECT * FROM code_graph_edges${where} ORDER BY from_path ASC, line ASC LIMIT ?`,
      params
    );
    return rows.map((row) => ({
      fromPath: String(row.from_path),
      toPath: String(row.to_path),
      kind: String(row.kind) as CodeGraphEdge['kind'],
      specifier: String(row.specifier || ''),
      line: Number(row.line),
      resolved: Boolean(row.resolved),
      targetModule: row.target_module ? String(row.target_module) : undefined
    }));
  }

  public getCodeGraphEdgesForPaths(paths: string[], limit = 2000): CodeGraphEdge[] {
    const unique = Array.from(new Set(paths.filter(Boolean))).slice(0, 200);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.sqlite.all<Record<string, unknown>>(
      `SELECT * FROM code_graph_edges
       WHERE from_path IN (${placeholders}) OR to_path IN (${placeholders})
       ORDER BY from_path ASC, line ASC LIMIT ?`,
      [...unique, ...unique, Math.max(1, Math.min(5000, limit))]
    );
    return rows.map((row) => ({
      fromPath: String(row.from_path),
      toPath: String(row.to_path),
      kind: String(row.kind) as CodeGraphEdge['kind'],
      specifier: String(row.specifier || ''),
      line: Number(row.line),
      resolved: Boolean(row.resolved),
      targetModule: row.target_module ? String(row.target_module) : undefined
    }));
  }

  public getSymbolsForFile(relativePath: string): CodeSymbolRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>(
      'SELECT * FROM code_symbols WHERE relative_path = ? ORDER BY line ASC',
      [relativePath]
    );
    return rows.map((row) => ({
      symbolId: String(row.symbol_id),
      relativePath: String(row.relative_path),
      name: String(row.name),
      kind: String(row.kind),
      line: Number(row.line),
      endLine: Number(row.end_line || row.line),
      exported: Boolean(row.exported),
      signature: row.signature ? String(row.signature) : undefined,
      moduleId: String(row.module_id)
    }));
  }

  public searchSymbols(terms: string[], limit = 20): CodeSymbolRecord[] {
    const clean = terms.map((t) => t.replace(/[^A-Za-z0-9_]/g, '')).filter((t) => t.length >= 2).slice(0, 6);
    if (clean.length === 0) return [];
    const where = clean.map(() => 'name LIKE ?').join(' OR ');
    const params: unknown[] = clean.map((t) => `%${t}%`);
    params.push(Math.max(1, Math.min(200, limit)));
    const rows = this.sqlite.all<Record<string, unknown>>(
      `SELECT * FROM code_symbols WHERE ${where} ORDER BY exported DESC, name ASC LIMIT ?`,
      params
    );
    return rows.map((row) => ({
      symbolId: String(row.symbol_id),
      relativePath: String(row.relative_path),
      name: String(row.name),
      kind: String(row.kind),
      line: Number(row.line),
      endLine: Number(row.end_line || row.line),
      exported: Boolean(row.exported),
      signature: row.signature ? String(row.signature) : undefined,
      moduleId: String(row.module_id)
    }));
  }

  private createConflict(input: {
    entityType: string;
    entityId: string;
    namespace: string;
    baseVersion: number;
    currentVersion: number;
    currentPayload: Record<string, unknown>;
    proposedPayload: Record<string, unknown>;
    actorId: string;
  }): MemoryConflictRecord {
    const conflict: MemoryConflictRecord = {
      conflictId: generateId('conflict'),
      entityType: input.entityType,
      entityId: input.entityId,
      namespace: input.namespace,
      baseVersion: input.baseVersion,
      currentVersion: input.currentVersion,
      currentPayload: input.currentPayload,
      proposedPayload: input.proposedPayload,
      actorId: input.actorId,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    this.sqlite.run(
      `INSERT INTO memory_conflicts (
        conflict_id, entity_type, entity_id, namespace, base_version, current_version,
        current_payload_json, proposed_payload_json, actor_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conflict.conflictId, conflict.entityType, conflict.entityId, conflict.namespace,
        conflict.baseVersion, conflict.currentVersion, JSON.stringify(conflict.currentPayload),
        JSON.stringify(conflict.proposedPayload), conflict.actorId, conflict.status, conflict.createdAt
      ]
    );
    return conflict;
  }

  public getConflicts(status: MemoryConflictRecord['status'] = 'open'): MemoryConflictRecord[] {
    const rows = this.sqlite.all<Record<string, unknown>>(
      'SELECT * FROM memory_conflicts WHERE status = ? ORDER BY created_at DESC',
      [status]
    );
    return rows.map((row) => ({
      conflictId: String(row.conflict_id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      namespace: String(row.namespace),
      baseVersion: Number(row.base_version),
      currentVersion: Number(row.current_version),
      currentPayload: JSON.parse(String(row.current_payload_json || '{}')),
      proposedPayload: JSON.parse(String(row.proposed_payload_json || '{}')),
      actorId: String(row.actor_id),
      status: row.status as MemoryConflictRecord['status'],
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
      resolutionNote: row.resolution_note ? String(row.resolution_note) : undefined
    }));
  }

  public resolveConflict(
    conflictId: string,
    resolution: 'merged' | 'rejected',
    options?: { note?: string; actorId?: string; applyProposal?: boolean }
  ): MemoryConflictRecord | null {
    const openConflict = this.getConflicts('open').find((c) => c.conflictId === conflictId);
    let conflict = openConflict;
    if (!conflict) {
      const rows = this.sqlite.all<Record<string, unknown>>(
        'SELECT * FROM memory_conflicts WHERE conflict_id = ?',
        [conflictId]
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      conflict = {
        conflictId: String(row.conflict_id),
        entityType: String(row.entity_type),
        entityId: String(row.entity_id),
        namespace: String(row.namespace),
        baseVersion: Number(row.base_version),
        currentVersion: Number(row.current_version),
        currentPayload: JSON.parse(String(row.current_payload_json || '{}')),
        proposedPayload: JSON.parse(String(row.proposed_payload_json || '{}')),
        actorId: String(row.actor_id),
        status: row.status as MemoryConflictRecord['status'],
        createdAt: String(row.created_at),
        resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
        resolutionNote: row.resolution_note ? String(row.resolution_note) : undefined
      };
    }
    if (resolution === 'merged' && options?.applyProposal && openConflict) {
      const proposal = conflict.proposedPayload as unknown as KnowledgeItemRecord;
      this.upsertKnowledgeItemsBatch(
        [{
          ...proposal,
          knowledgeId: conflict.entityId,
          version: conflict.currentVersion + 1,
          lastVerifiedAt: new Date().toISOString()
        }],
        { actorType: 'user', actorId: options?.actorId || 'user/merge', recordEvents: true }
      );
    }
    const now = new Date().toISOString();
    this.sqlite.run(
      'UPDATE memory_conflicts SET status = ?, resolved_at = ?, resolution_note = ? WHERE conflict_id = ?',
      [resolution, now, options?.note || null, conflictId]
    );
    return this.getConflicts(resolution).find((c) => c.conflictId === conflictId) || conflict;
  }

  public supersedeKnowledgeItem(
    knowledgeId: string,
    supersededBy: string,
    options?: { actorId?: string; reason?: string }
  ): boolean {
    const existing = this.sqlite.get<Record<string, unknown>>(
      'SELECT * FROM knowledge_items WHERE knowledge_id = ?',
      [knowledgeId]
    );
    if (!existing) return false;
    const now = new Date().toISOString();
    this.sqlite.run(
      'UPDATE knowledge_items SET superseded_by = ?, valid_to = ? WHERE knowledge_id = ?',
      [supersededBy, now, knowledgeId]
    );
    this.recordMemoryEvent({
      projectId: this.resolveProjectId(),
      repositoryId: this.projectRoot,
      branch: this.resolveBranch(),
      snapshotId: '',
      actorType: 'user',
      actorId: options?.actorId || 'user/supersede',
      namespace: String(existing.namespace || 'project/shared'),
      operation: 'supersede',
      entityType: 'knowledge',
      entityId: knowledgeId,
      payload: { supersededBy, reason: options?.reason || '' },
      sourceRefs: [],
      observedAt: now,
      ingestedAt: now,
      validFrom: now,
      supersedes: knowledgeId,
      visibility: this.visibilityForNamespace(String(existing.namespace || 'project/shared'))
    });
    return true;
  }

  public recordSyncEvent(event: {
    eventType: 'bootstrap' | 'incremental_sync' | 'prompt_init' | 'deep_analysis';
    changedFiles: string[];
    deletedFiles: string[];
    renamedFiles: Array<{ from: string; to: string }>;
    affectedModules: string[];
    summary: string;
    actorId?: string;
    snapshotId?: string;
    memoryEventId?: string;
  }): void {
    this.sqlite.run(
      `INSERT INTO sync_events (
        event_type, changed_files_json, deleted_files_json, renamed_files_json,
        affected_modules_json, summary, recorded_at, memory_event_id, actor_id, snapshot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventType, JSON.stringify(event.changedFiles), JSON.stringify(event.deletedFiles),
        JSON.stringify(event.renamedFiles), JSON.stringify(event.affectedModules), event.summary,
        new Date().toISOString(), event.memoryEventId || null, event.actorId || 'system/indexer',
        event.snapshotId || null
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

  public saveEmbeddings(records: Array<{
    entityId: string;
    entityType: string;
    vector: number[];
    model: string;
    modelVersion: string;
    dims: number;
    textHash: string;
    chunkHash?: string;
  }>): void {
    if (records.length === 0) return;
    const now = new Date().toISOString();
    const ops: SqlOperation[] = [];
    for (const r of records) {
      ops.push({
      kind: 'run',
      sql: `INSERT INTO vector_embeddings (
        entity_id, entity_type, vector_json, updated_at, model, model_version, dims, text_hash, chunk_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        entity_type = excluded.entity_type,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at,
        model = excluded.model,
        model_version = excluded.model_version,
        dims = excluded.dims,
        text_hash = excluded.text_hash,
        chunk_hash = excluded.chunk_hash`,
      params: [
        r.entityId, r.entityType, JSON.stringify(r.vector), now, r.model, r.modelVersion,
        r.dims, r.textHash, r.chunkHash || null
      ]
      });
    }
    this.sqlite.batch(ops);
  }

  public getAllEmbeddings(): Array<{ entityId: string; entityType: string; vector: number[]; model: string; textHash: string }> {
    const rows = this.sqlite.all<Record<string, unknown>>('SELECT * FROM vector_embeddings');
    const out: Array<{ entityId: string; entityType: string; vector: number[]; model: string; textHash: string }> = [];
    for (const row of rows) {
      try {
        out.push({
          entityId: String(row.entity_id),
          entityType: String(row.entity_type),
          vector: JSON.parse(String(row.vector_json)),
          model: String(row.model || ''),
          textHash: String(row.text_hash || '')
        });
      } catch (_) {}
    }
    return out;
  }

  public getEmbedding(entityId: string): { vector: number[]; model: string; modelVersion: string; dims: number; textHash: string } | null {
    const row = this.sqlite.get<Record<string, unknown>>(
      'SELECT * FROM vector_embeddings WHERE entity_id = ?',
      [entityId]
    );
    if (!row) return null;
    try {
      return {
        vector: JSON.parse(String(row.vector_json)),
        model: String(row.model || ''),
        modelVersion: String(row.model_version || ''),
        dims: Number(row.dims || 0),
        textHash: String(row.text_hash || '')
      };
    } catch (_) {
      return null;
    }
  }

  private count(table: string): number {
    try {
      const row = this.sqlite.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      return Number(row?.c || 0);
    } catch (_) {
      return 0;
    }
  }

  public getDatabaseStats(): {
    files: number;
    modules: number;
    knowledge: number;
    decisions: number;
    events: number;
    conflictsOpen: number;
    chunks: number;
    graphEdges: number;
    symbols: number;
    embeddings: number;
    cacheEntries: number;
    snapshots: number;
  } {
    return {
      files: this.count('project_files'),
      modules: this.count('project_modules'),
      knowledge: this.count('knowledge_items'),
      decisions: this.count('architectural_decisions'),
      events: this.count('memory_events'),
      conflictsOpen: this.count("memory_conflicts WHERE status = 'open'") ,
      chunks: this.count('file_chunks'),
      graphEdges: this.count('code_graph_edges'),
      symbols: this.count('code_symbols'),
      embeddings: this.count('vector_embeddings'),
      cacheEntries: this.count('retrieval_cache'),
      snapshots: this.count('workspace_snapshots')
    };
  }

  public getHealthReport(): {
    databasePath: string;
    integrity: string;
    stats: ReturnType<ProjectMemoryStore['getDatabaseStats']>;
    eventChain: ReturnType<ProjectMemoryStore['verifyMemoryEventChain']>;
    latestSnapshot: WorkspaceSnapshotRecord | null;
    manifest: IndexManifestRecord | null;
    cache: ReturnType<ProjectMemoryStore['getCacheStats']>;
    recoveredFromCorruption: boolean;
  } {
    let integrity = 'unknown';
    try {
      const row = this.sqlite.get<{ integrity_check: string }>('PRAGMA integrity_check;');
      integrity = row?.integrity_check || 'unknown';
    } catch (err) {
      integrity = err instanceof Error ? err.message : String(err);
    }
    return {
      databasePath: this.dbPath,
      integrity,
      stats: this.getDatabaseStats(),
      eventChain: this.verifyMemoryEventChain(),
      latestSnapshot: this.getLatestSnapshot(),
      manifest: this.getIndexManifest(),
      cache: this.getCacheStats(),
      recoveredFromCorruption: this.recoveredFromCorruption
    };
  }
}
