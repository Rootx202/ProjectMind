import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export const PROJECTMIND_VERSION = '1.0.0';
export const MEMORY_SCHEMA_VERSION = 3;
export const DEFAULT_DATA_DIR_NAME = '.projectmind';

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
  summary: string;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string;
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
    'target/**'
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
