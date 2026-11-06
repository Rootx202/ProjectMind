import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export const PROJECTMIND_VERSION = '1.1.0';
export const MEMORY_SCHEMA_VERSION = 4;
export const DEFAULT_DATA_DIR_NAME = '.projectmind';

/** Version stamps embedded in every index artifact so stale data is never silently reused. */
export const PARSER_VERSION = 'babel-ast-v1';
export const CHUNKER_VERSION = 'byte-window-64k-v1';
export const RETRIEVAL_VERSION = 'hybrid-v1';
export const EMBEDDING_MODEL = 'hash-feature-v2';
export const EMBEDDING_DIMS = 192;
/**
 * Honest label for the built-in local vector backend. This is feature hashing
 * (lexical), not a learned semantic embedding. Real embedding backends can be
 * plugged in through `SemanticSearchProvider`, but are not enabled by default.
 */
export const EMBEDDING_KIND = 'feature-hash-rerank';
export const MAX_ANALYSIS_BYTES = 2 * 1024 * 1024;

export type VerificationStatus = 'verified' | 'inferred' | 'planned' | 'unverified' | 'outdated';
export type TaskScopeLevel = 'none' | 'file' | 'module' | 'cross-module' | 'deep-architecture';

export interface CoreMemoryRecord {
  projectId: string;
  projectName: string;
  projectRoot: string;
  previousRoots: string[];
  mainTechStack: {
    languages: string[];
    frameworks: string[];
    packageManager: string;
    runtime?: string;
    database?: string[];
  };
  projectPurpose: string;
  keyConstraints: string[];
  architecturalSummary: string;
  currentState: 'bootstrapped' | 'planned_from_prompt' | 'active' | 'stale' | 'corrupted';
  memorySchemaVersion: number;
  createdAt: string;
  updatedAt: string;
  lastVerifiedCommit?: string;
}

export interface FileRecord {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  language: string;
  moduleId: string;
  role: 'entrypoint' | 'config' | 'route' | 'controller' | 'service' | 'model' | 'component' | 'utility' | 'test' | 'doc' | 'other';
  symbols: ExtractedSymbol[];
  imports: string[];
  exports: string[];
  /** Resolved project-relative import targets, parallel to `imports` ('' = external). */
  resolvedImports?: string[];
  summary: string;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string;
  /** SHA-256 of the entire file (streamed). Present for schema v4+ indexes. */
  fullSha256?: string;
  /** SHA-256 of the analyzed prefix, kept for backwards compatibility and sample diffing. */
  analysisSha256?: string;
  parserVersion?: string;
  analysisStatus?: 'ok' | 'truncated' | 'failed';
  lineCount?: number;
}

export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'route' | 'model' | 'component' | 'method';
  line: number;
  exported: boolean;
  signature?: string;
}

export interface ModuleKnowledgeRecord {
  moduleId: string;
  name: string;
  rootPath: string;
  purpose: string;
  entryFiles: string[];
  fileCount: number;
  publicSymbols: string[];
  dependencies: string[];
  dependents: string[];
  routes: ApiEndpointRecord[];
  models: DatabaseModelRecord[];
  verificationStatus: VerificationStatus;
  confidence: number;
  lastVerifiedAt: string;
  fingerprint: string;
}

export interface ApiEndpointRecord {
  method: string;
  path: string;
  handlerSymbol: string;
  sourceFile: string;
  line: number;
  moduleId: string;
  verificationStatus: VerificationStatus;
}

export interface DatabaseModelRecord {
  name: string;
  kind: 'sql_table' | 'orm_entity' | 'prisma_model' | 'mongoose_schema' | 'planned_entity';
  fields: Array<{ name: string; type: string; constraints?: string }>;
  sourceFile: string;
  line: number;
  moduleId: string;
  verificationStatus: VerificationStatus;
}

export interface ArchitecturalDecisionRecord {
  decisionId: string;
  title: string;
  context: string;
  decision: string;
  consequences: string[];
  constraints: string[];
  relatedModules: string[];
  sourceReferences: string[];
  verificationStatus: VerificationStatus;
  recordedAt: string;
  supersededBy?: string;
}

export interface KnowledgeItemRecord {
  knowledgeId: string;
  namespace?: string;
  validFrom?: string;
  validTo?: string;
  observedAt?: string;
  ingestedAt?: string;
  supersededBy?: string;
  actorId?: string;
  sourceEventId?: string;
  category:
    | 'architecture'
    | 'module'
    | 'component'
    | 'database_schema'
    | 'api'
    | 'route'
    | 'service'
    | 'dependency'
    | 'configuration'
    | 'important_file'
    | 'business_logic'
    | 'requirement'
    | 'convention'
    | 'decision'
    | 'unresolved_question';
  title: string;
  summary: string;
  details: Record<string, unknown>;
  sourceFiles: string[];
  relatedModules: string[];
  fileFingerprint?: string;
  verificationStatus: VerificationStatus;
  confidence: number;
  version: number;
  lastVerifiedAt: string;
}

export interface TaskContextRecord {
  taskId: string;
  taskDescription: string;
  scopeLevel: TaskScopeLevel;
  relevantFiles: string[];
  relevantModules: string[];
  retrievedDecisions: string[];
  relatedDependencies: string[];
  currentChanges: string[];
  potentialImpact: string[];
  contextBudgetTokens: number;
  estimatedTokensUsed: number;
  warnings: string[];
  createdAt: string;
  snapshotId?: string;
}

/**
 * Namespaces keep memories scoped and prevent one agent from silently
 * overwriting another agent's or the user's knowledge.
 *
 *   project/shared          durable team/project facts
 *   project/agent/<id>      private memory for a single agent
 *   project/user/<id>       user preferences
 *   project/branch/<name>   branch-scoped drafts
 *   project/task/<id>       ephemeral task context
 */
export type MemoryNamespaceKind = 'shared' | 'agent' | 'user' | 'branch' | 'task';

export type MemoryActorType = 'user' | 'agent' | 'system' | 'hook' | 'cli';

export type MemoryOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'supersede'
  | 'sync'
  | 'decision'
  | 'task_context'
  | 'conflict'
  | 'merge';

export interface MemoryEventRecord {
  eventId: string;
  projectId: string;
  repositoryId: string;
  branch: string;
  baseCommit?: string;
  snapshotId: string;
  actorType: MemoryActorType;
  actorId: string;
  namespace: string;
  operation: MemoryOperation;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  sourceRefs: string[];
  observedAt: string;
  ingestedAt: string;
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  causedBy?: string;
  visibility: 'shared' | 'agent-private' | 'user-private' | 'branch' | 'task';
  parserVersion?: string;
  modelVersion?: string;
  prevHash?: string;
  eventHash: string;
}

export interface WorkspaceSnapshotRecord {
  snapshotId: string;
  projectId: string;
  gitHead?: string;
  gitBranch?: string;
  aggregateHash: string;
  fileCount: number;
  dirty: boolean;
  createdAt: string;
}

export interface MemoryConflictRecord {
  conflictId: string;
  entityType: string;
  entityId: string;
  namespace: string;
  baseVersion: number;
  currentVersion: number;
  currentPayload: Record<string, unknown>;
  proposedPayload: Record<string, unknown>;
  actorId: string;
  status: 'open' | 'merged' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface CodeGraphEdge {
  fromPath: string;
  toPath: string;
  kind: 'import' | 'reexport' | 'dynamic-import' | 'require' | 'type-import';
  specifier: string;
  line: number;
  resolved: boolean;
  targetModule?: string;
}

export interface CodeSymbolRecord {
  symbolId: string;
  relativePath: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  exported: boolean;
  signature?: string;
  moduleId: string;
}

export interface FileChunkRecord {
  relativePath: string;
  chunkIndex: number;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  sha256: string;
}

export interface IndexManifestRecord {
  projectId: string;
  snapshotId: string;
  aggregateHash: string;
  fileCount: number;
  parserVersion: string;
  chunkerVersion: string;
  embedderVersion: string;
  retrievalVersion: string;
  createdAt: string;
}

export interface RetrievalEvidence {
  kind: 'file' | 'module' | 'symbol' | 'decision' | 'knowledge' | 'graph' | 'fts' | 'vector';
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  commit?: string;
  detail: string;
}

export interface RetrievalHit {
  entityId: string;
  entityType: string;
  title: string;
  summary: string;
  sourcePath: string;
  score: number;
  verificationStatus: string;
  namespace?: string;
  superseded?: boolean;
  scores: {
    fts: number;
    symbol: number;
    graph: number;
    vector: number;
  };
  matchedTerms: string[];
  why: string;
  evidence: RetrievalEvidence[];
}

export interface ProjectMindConfig {
  dataDirName: string;
  defaultContextBudgetTokens: number;
  maxToolOutputChars: number;
  smartAutoMode: boolean;
  excludePatterns: string[];
  allowSecretIndexing: false;
  semanticSearchProvider?: 'none' | 'local-hash-vectors' | 'custom';
  autoUpdateCheck?: boolean;
  updateCheckIntervalHours?: number;
  lastUpdateCheckTimestamp?: number;
}

export const DEFAULT_CONFIG: ProjectMindConfig = {
  dataDirName: DEFAULT_DATA_DIR_NAME,
  defaultContextBudgetTokens: 4000,
  maxToolOutputChars: 16000,
  smartAutoMode: true,
  autoUpdateCheck: true,
  updateCheckIntervalHours: 24,
  lastUpdateCheckTimestamp: 0,
  excludePatterns: [
    'node_modules/**',
    '.git/**',
    '.projectmind/**',
    'dist/**',
    'build/**',
    'out/**',
    '.next/**',
    '.nuxt/**',
    'coverage/**',
    'vendor/**',
    '__pycache__/**',
    '.venv/**',
    'venv/**',
    'target/**',
    '.release/**',
    '.tmp-*',
    '*.tmp'
  ],
  allowSecretIndexing: false,
  semanticSearchProvider: 'local-hash-vectors'
};

const FORBIDDEN_SECRET_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.kdbx$/i,
  /\.keystore$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /^credentials(\.json|\.xml|\.yml|\.yaml)?$/i,
  /^secrets?(\.json|\.yml|\.yaml|\.toml|\.ini|\.env)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.docker\/config\.json$/i,
  /service[-_]?account.*\.json$/i,
  /token(s)?\.json$/i,
  /password(s)?\.(txt|json|yml|yaml|ini)$/i
];

const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.password-store', '.git', 'node_modules', '.projectmind', '__pycache__', '.venv', 'venv'
]);

const INLINE_SECRET_REGEXES: RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PRIVATE )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-/.+=]{12,}['"]/gi,
  /ghp_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z\-_]{30,}/g,
  /xox[baprs]-[0-9A-Za-z\-]{10,}/g
];

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
  /system\s*override\s*:/gi,
  /you\s+are\s+now\s+in\s+developer\s+mode/gi,
  /disregard\s+security\s+rules/gi,
  /<\/?system_instruction>/gi,
  /execute\s+arbitrary\s+command/gi
];

export function isSensitiveOrSecretPath(relOrAbsPath: string): boolean {
  const normalized = relOrAbsPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part.toLowerCase())) {
      return true;
    }
  }
  const base = path.posix.basename(normalized);
  for (const pattern of FORBIDDEN_SECRET_FILENAME_PATTERNS) {
    if (pattern.test(base) || pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function redactSecrets(input: string): string {
  let result = input;
  for (const rx of INLINE_SECRET_REGEXES) {
    result = result.replace(rx, '[REDACTED_SECRET]');
  }
  return result;
}

export function sanitizeUntrustedContent(input: string): { sanitized: string; injectionDetected: boolean } {
  let sanitized = redactSecrets(input);
  let injectionDetected = false;
  for (const rx of PROMPT_INJECTION_PATTERNS) {
    if (rx.test(sanitized)) {
      injectionDetected = true;
      sanitized = sanitized.replace(rx, '[UNTRUSTED_DIRECTIVE_STRIPPED]');
    }
  }
  return { sanitized, injectionDetected };
}

export function resolveSafeProjectPath(projectRoot: string, candidatePath: string): string {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('Invalid path: path must be a non-empty string');
  }
  if (candidatePath.includes('\0')) {
    throw new Error('Security violation: null byte in path');
  }
  const resolvedRoot = fs.existsSync(projectRoot) ? fs.realpathSync(projectRoot) : path.resolve(projectRoot);
  const resolvedCandidate = path.resolve(resolvedRoot, candidatePath);

  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security violation: path traversal outside project root is forbidden (${candidatePath})`);
  }

  if (fs.existsSync(resolvedCandidate)) {
    const realCandidate = fs.realpathSync(resolvedCandidate);
    const realRel = path.relative(resolvedRoot, realCandidate);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Security violation: symbolic link escapes project root (${candidatePath})`);
    }
  }

  return resolvedCandidate;
}

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function estimateTokens(text: string): { estimatedTokens: number; method: 'char_and_token_heuristic_v1'; isApproximation: true } {
  if (!text) {
    return { estimatedTokens: 0, method: 'char_and_token_heuristic_v1', isApproximation: true };
  }
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const punctuation = (text.match(/[{}()[\].,:;<>+\-*/=&|!]/g) || []).length;
  const charBased = Math.ceil(text.length / 3.8);
  const wordBased = Math.ceil(words * 1.3 + punctuation * 0.5);
  return {
    estimatedTokens: Math.max(1, Math.round((charBased + wordBased) / 2)),
    method: 'char_and_token_heuristic_v1',
    isApproximation: true
  };
}

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input as object)) return '[circular]';
    seen.add(input as object);
    if (Array.isArray(input)) return input.map(normalize);
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = normalize(obj[key]);
    return out;
  };
  return JSON.stringify(normalize(value));
}

export function stableId(prefix: string, ...parts: Array<string | number | boolean>): string {
  return `${prefix}_${computeSha256(parts.join('\u0000')).slice(0, 16)}`;
}

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

export function parseMemoryNamespace(namespace: string): { kind: MemoryNamespaceKind; owner?: string; raw: string } {
  const raw = String(namespace || '').trim();
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] !== 'project') return { kind: 'shared', raw: 'project/shared' };
  const group = parts[1] || 'shared';
  if (['shared', 'agent', 'user', 'branch', 'task'].includes(group)) {
    const kind = group as MemoryNamespaceKind;
    const owner = parts.length > 2 ? parts.slice(2).join('/') : undefined;
    return { kind, owner, raw: owner ? `project/${kind}/${owner}` : `project/${kind === 'shared' ? 'shared' : kind}` };
  }
  return { kind: 'shared', raw: 'project/shared' };
}

export function normalizeNamespace(
  namespace: string | undefined,
  actor: { actorType: MemoryActorType; actorId: string }
): string {
  if (namespace && namespace.trim()) {
    const parsed = parseMemoryNamespace(namespace);
    if (parsed.kind !== 'shared' && !parsed.owner) {
      return `project/${parsed.kind}/${actor.actorId}`;
    }
    return parsed.raw;
  }
  return actor.actorType === 'user' || actor.actorType === 'agent'
    ? `project/agent/${actor.actorId}`
    : 'project/shared';
}

export function isNamespaceVisible(namespace: string, viewerNamespace = 'project/shared'): boolean {
  const ns = parseMemoryNamespace(namespace);
  const viewer = parseMemoryNamespace(viewerNamespace);
  if (ns.kind === 'shared') return true;
  return ns.kind === viewer.kind && ns.owner === viewer.owner;
}

export interface FileHashResult {
  sha256: string;
  sizeBytes: number;
  analysisSha256: string;
  chunks: Array<{ chunkIndex: number; startByte: number; endByte: number; sha256: string }>;
}

/**
 * Streams the entire file through SHA-256 while producing bounded byte-window
 * chunk hashes. This replaces the old "hash the first 256 KiB only" behavior,
 * which could miss edits at the tail of large files.
 */
export function hashFileStreaming(fullPath: string, options?: { windowBytes?: number; maxChunks?: number }): FileHashResult {
  const sizeBytes = fs.statSync(fullPath).size;
  const maxChunks = Math.max(1, options?.maxChunks || 2048);
  const minWindow = Math.max(4096, options?.windowBytes || 64 * 1024);
  const windowBytes = Math.max(minWindow, Math.ceil(sizeBytes / maxChunks));

  const whole = crypto.createHash('sha256');
  const prefix = crypto.createHash('sha256');
  const chunks: FileHashResult['chunks'] = [];
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(windowBytes, 4096)));
  const chunkBuffer: Buffer[] = [];
  let chunkIndex = 0;
  let chunkStart = 0;
  let position = 0;
  let prefixBytes = 0;

  const fd = fs.openSync(fullPath, 'r');
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      const slice = buffer.subarray(0, read);
      whole.update(slice);
      if (prefixBytes < 256 * 1024) {
        const need = 256 * 1024 - prefixBytes;
        prefix.update(slice.subarray(0, Math.min(need, slice.length)));
        prefixBytes += Math.min(need, slice.length);
      }
      let offset = 0;
      while (offset < read) {
        const room = windowBytes - (position + offset - chunkStart);
        const take = Math.min(room, read - offset);
        chunkBuffer.push(Buffer.from(slice.subarray(offset, offset + take)));
        offset += take;
        if (position + offset - chunkStart >= windowBytes) {
          chunks.push({
            chunkIndex,
            startByte: chunkStart,
            endByte: position + offset,
            sha256: computeSha256(Buffer.concat(chunkBuffer))
          });
          chunkIndex++;
          chunkStart = position + offset;
          chunkBuffer.length = 0;
        }
      }
      position += read;
    }
    if (position > chunkStart) {
      chunks.push({
        chunkIndex,
        startByte: chunkStart,
        endByte: position,
        sha256: computeSha256(Buffer.concat(chunkBuffer))
      });
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    sha256: whole.digest('hex'),
    sizeBytes,
    analysisSha256: prefix.digest('hex'),
    chunks
  };
}

export function computeAggregateHash(entries: Array<{ path: string; sha256: string }>): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  return computeSha256(sorted.map((e) => `${e.path}:${e.sha256}`).join('\n'));
}

/** Atomic write: write to a temp file in the same directory, fsync, then rename. */
export function atomicWriteFileSync(targetPath: string, content: string | Buffer): void {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, resolved);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
}

/** Reads at most `maxBytes` from the head of a file without loading the rest. */
export function readFilePrefix(fullPath: string, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  const stat = fs.statSync(fullPath);
  const toRead = Math.min(stat.size, Math.max(0, maxBytes));
  const buffer = Buffer.alloc(toRead);
  const fd = fs.openSync(fullPath, 'r');
  try {
    let readTotal = 0;
    while (readTotal < toRead) {
      const read = fs.readSync(fd, buffer, readTotal, toRead - readTotal, readTotal);
      if (read <= 0) break;
      readTotal += read;
    }
    return { buffer: buffer.subarray(0, readTotal), truncated: stat.size > toRead };
  } finally {
    fs.closeSync(fd);
  }
}

export class SafeLogger {
  private prefix: string;
  private silent: boolean;

  constructor(prefix = 'ProjectMind', silent = false) {
    this.prefix = prefix;
    this.silent = silent || process.env.PROJECTMIND_SILENT === '1';
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.write('INFO', message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.write('WARN', message, meta);
  }

  public error(message: string, meta?: Record<string, unknown>): void {
    this.write('ERROR', message, meta);
  }

  private write(level: string, message: string, meta?: Record<string, unknown>): void {
    if (this.silent) return;
    const raw = meta ? `${message} ${JSON.stringify(meta)}` : message;
    const safe = redactSecrets(raw);
    process.stderr.write(`[${new Date().toISOString()}] [${this.prefix}] [${level}] ${safe}\n`);
  }
}
