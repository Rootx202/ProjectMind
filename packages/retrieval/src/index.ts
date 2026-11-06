import { ProjectMemoryStore } from '@projectmind/storage';
import {
  FileRecord,
  ModuleKnowledgeRecord,
  RetrievalHit,
  RetrievalEvidence,
  EMBEDDING_DIMS,
  EMBEDDING_KIND,
  EMBEDDING_MODEL,
  computeSha256,
  isNamespaceVisible
} from '@projectmind/shared';

export interface SemanticSearchProvider {
  readonly name: string;
  readonly kind: string;
  readonly dims: number;
  embedText(text: string): number[];
  cosineSimilarity(a: number[], b: number[]): number;
}

/**
 * Built-in local vector backend.
 *
 * This is explicit feature hashing over tokens/character shingles. It is fast,
 * deterministic, and fully offline, but it is NOT a learned semantic
 * embedding. The name and `kind` field reflect that honestly. A real embedding
 * model can be supplied through `KnowledgeRetriever.setSemanticProvider`.
 */
export class HashingEmbeddingProvider implements SemanticSearchProvider {
  public readonly name = EMBEDDING_MODEL;
  public readonly kind = EMBEDDING_KIND;
  public readonly dims = EMBEDDING_DIMS;

  public embedText(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9_\s]/g, ' ');
    const tokens = normalized.split(/\s+/).filter((t) => t.length >= 2).slice(0, 4000);

    const add = (token: string, weight: number) => {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const idx = Math.abs(hash) % this.dims;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vec[idx] += sign * weight;
    };

    for (const tok of tokens) {
      add(tok, 1);
      if (tok.length >= 4) {
        for (let i = 0; i <= tok.length - 4; i++) add(tok.slice(i, i + 4), 0.35);
      }
    }
    for (let i = 0; i < tokens.length - 1; i++) add(`${tokens[i]}_${tokens[i + 1]}`, 0.6);

    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vec.map((v) => Number((v / norm).toFixed(5)));
  }

  public cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) dot += a[i] * b[i];
    return dot;
  }
}

/** @deprecated Use HashingEmbeddingProvider; kept for API compatibility. */
export class LocalHashSemanticProvider extends HashingEmbeddingProvider {}

export interface SearchOptions {
  limit?: number;
  entityType?: 'file' | 'module' | 'decision' | 'knowledge';
  includeSemanticRerank?: boolean;
  includeSymbols?: boolean;
  includeGraph?: boolean;
  /** Historical retrieval: only validity ranges overlapping this instant. */
  asOf?: string;
  /** Caller namespace for private/shared memory gating. */
  viewerNamespace?: string;
}

interface Candidate {
  entityId: string;
  entityType: 'file' | 'module' | 'decision' | 'knowledge';
  title: string;
  summary: string;
  sourcePath: string;
  verificationStatus: string;
  namespace: string;
  superseded: boolean;
  scores: { fts: number; symbol: number; graph: number; vector: number };
  matchedTerms: string[];
  evidence: RetrievalEvidence[];
  whyParts: string[];
}

export class KnowledgeRetriever {
  private readonly store: ProjectMemoryStore;
  private semanticProvider: SemanticSearchProvider;
  private embeddingCache: Map<string, { textHash: string; vector: number[] }> | null = null;
  private pendingEmbeddings: Array<{
    entityId: string;
    entityType: string;
    vector: number[];
    model: string;
    modelVersion: string;
    dims: number;
    textHash: string;
  }> = [];

  constructor(store: ProjectMemoryStore, semanticProvider?: SemanticSearchProvider) {
    this.store = store;
    this.semanticProvider = semanticProvider || new HashingEmbeddingProvider();
  }

  private loadEmbeddingCache(): Map<string, { textHash: string; vector: number[] }> {
    if (this.embeddingCache) return this.embeddingCache;
    this.embeddingCache = new Map();
    try {
      for (const record of this.store.getAllEmbeddings()) {
        this.embeddingCache.set(record.entityId, { textHash: record.textHash, vector: record.vector });
      }
    } catch (_) {}
    return this.embeddingCache;
  }

  private flushEmbeddings(): void {
    if (this.pendingEmbeddings.length === 0) return;
    try {
      this.store.saveEmbeddings(this.pendingEmbeddings);
    } catch (_) {}
    this.pendingEmbeddings = [];
  }

  public setSemanticProvider(provider: SemanticSearchProvider): void {
    this.semanticProvider = provider;
  }

  public getEmbeddingInfo(): { model: string; kind: string; dims: number } {
    return { model: this.semanticProvider.name, kind: this.semanticProvider.kind, dims: this.semanticProvider.dims };
  }

  private tokenize(query: string): string[] {
    return Array.from(new Set(
      String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9_\s-]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    )).slice(0, 12);
  }

  private ensureEmbedding(entityId: string, entityType: string, text: string): number[] {
    const textHash = computeSha256(text);
    const cache = this.loadEmbeddingCache();
    const existing = cache.get(entityId);
    if (existing && existing.textHash === textHash) return existing.vector;
    const vector = this.semanticProvider.embedText(text);
    cache.set(entityId, { textHash, vector });
    this.pendingEmbeddings.push({
      entityId,
      entityType,
      vector,
      model: this.semanticProvider.name,
      modelVersion: '1',
      dims: vector.length,
      textHash
    });
    return vector;
  }

  public searchKnowledge(query: string, options?: SearchOptions): RetrievalHit[] {
    const limit = Math.max(1, options?.limit || 12);
    const tokens = this.tokenize(query);
    if (tokens.length === 0) return [];

    const candidates = new Map<string, Candidate>();
    const keyOf = (type: string, id: string) => `${type}:${id}`;

    const validKnowledge = new Map(
      this.store.getKnowledgeItems(undefined, undefined, {
        asOf: options?.asOf,
        includeSuperseded: false
      }).map((item) => [item.knowledgeId, item])
    );
    const validDecisions = new Map(
      this.store.getDecisions(undefined, { asOf: options?.asOf }).map((d) => [d.decisionId, d])
    );

    const fileCache = new Map<string, FileRecord | null>();
    const getFile = (id: string): FileRecord | null => {
      if (fileCache.has(id)) return fileCache.get(id) || null;
      const file = this.store.getFile(id);
      fileCache.set(id, file);
      return file;
    };
    const preloadFiles = (paths: string[]) => {
      const missing = Array.from(new Set(paths.filter((p) => p && !fileCache.has(p))));
      if (missing.length === 0) return;
      for (const file of this.store.getFilesByPaths(missing)) fileCache.set(file.relativePath, file);
      for (const path of missing) if (!fileCache.has(path)) fileCache.set(path, null);
    };

    const ensureCandidate = (
      entityType: Candidate['entityType'],
      entityId: string,
      title: string,
      summary: string,
      sourcePath: string,
      verificationStatus: string,
      namespace: string,
      superseded: boolean
    ): Candidate => {
      const key = keyOf(entityType, entityId);
      let candidate = candidates.get(key);
      if (!candidate) {
        candidate = {
          entityId, entityType, title, summary, sourcePath, verificationStatus,
          namespace, superseded,
          scores: { fts: 0, symbol: 0, graph: 0, vector: 0 },
          matchedTerms: [],
          evidence: [],
          whyParts: []
        };
        candidates.set(key, candidate);
      }
      return candidate;
    };

    // Stage 1: lexical BM25 via SQLite FTS5.
    const ftsResults = this.store.searchFts(query, limit * 3, options?.entityType);
    preloadFiles(ftsResults.filter((r) => r.entityType === 'file').map((r) => r.entityId));
    for (const r of ftsResults) {
      const type = r.entityType as Candidate['entityType'];
      if (!['file', 'module', 'decision', 'knowledge'].includes(type)) continue;
      let namespace = 'project/shared';
      let superseded = false;
      let verificationStatus = 'verified';

      if (type === 'knowledge') {
        const item = validKnowledge.get(r.entityId);
        if (!item) continue; // superseded, expired, or outside asOf
        namespace = item.namespace || 'project/shared';
        verificationStatus = item.verificationStatus;
      } else if (type === 'decision') {
        const decision = validDecisions.get(r.entityId);
        if (!decision) continue;
        namespace = decision.namespace || 'project/shared';
        verificationStatus = decision.verificationStatus;
      } else if (type === 'file') {
        const file = getFile(r.entityId);
        if (!file) continue;
        namespace = 'project/shared';
        verificationStatus = file.verificationStatus;
      } else if (type === 'module') {
        const mod = this.store.getModule(r.entityId);
        if (!mod) continue;
        verificationStatus = mod.verificationStatus;
      }

      if (!isNamespaceVisible(namespace, options?.viewerNamespace || 'project/shared')) continue;

      const candidate = ensureCandidate(
        type, r.entityId, r.title, r.summary, r.sourcePath, verificationStatus, namespace, superseded
      );
      candidate.scores.fts += Math.max(0.1, Number(r.score || 0));
      candidate.evidence.push({
        kind: 'fts',
        path: r.sourcePath,
        detail: `FTS5 BM25 match (rank score ${Number(r.score || 0).toFixed(3)})`
      });
      candidate.whyParts.push('lexical FTS5 match');
    }

    // Stage 2: structural symbol matches from the AST symbol table.
    if (options?.includeSymbols !== false && (!options?.entityType || options.entityType === 'file')) {
      const symbolHits = this.store.searchSymbols(tokens, limit * 3);
      preloadFiles(symbolHits.map((sym) => sym.relativePath));
      for (const sym of symbolHits) {
        const file = getFile(sym.relativePath);
        if (!file) continue;
        const candidate = ensureCandidate(
          'file', sym.relativePath, file.relativePath, file.summary,
          sym.relativePath, file.verificationStatus, 'project/shared', false
        );
        candidate.scores.symbol += sym.exported ? 2.6 : 1.7;
        candidate.evidence.push({
          kind: 'symbol',
          path: sym.relativePath,
          lineStart: sym.line,
          lineEnd: sym.endLine,
          detail: `${sym.exported ? 'exported ' : ''}${sym.kind} "${sym.name}"`
        });
        candidate.whyParts.push(`symbol ${sym.name}`);
      }
    }

    // Stage 3: code-graph neighbours of the strongest lexical/structural hits.
    if (options?.includeGraph !== false && (!options?.entityType || options.entityType === 'file')) {
      const seedPaths = Array.from(candidates.values())
        .filter((c) => c.entityType === 'file')
        .sort((a, b) => (b.scores.fts + b.scores.symbol) - (a.scores.fts + a.scores.symbol))
        .slice(0, 5)
        .map((c) => c.entityId);

      const edges = this.store.getCodeGraphEdgesForPaths(seedPaths, 200);
      const neighbourPaths: string[] = [];
      for (const edge of edges) {
        if (!edge.resolved) continue;
        neighbourPaths.push(edge.fromPath, edge.toPath);
      }
      preloadFiles(neighbourPaths);
      const seedSet = new Set(seedPaths);
      for (const edge of edges) {
        if (!edge.resolved) continue;
        const seed = seedSet.has(edge.fromPath) ? edge.fromPath : edge.toPath;
        const neighbour = edge.fromPath === seed ? edge.toPath : edge.fromPath;
        const file = getFile(neighbour);
        if (!file) continue;
        const candidate = ensureCandidate(
          'file', file.relativePath, file.relativePath, file.summary,
          file.relativePath, file.verificationStatus, 'project/shared', false
        );
        candidate.scores.graph += 1.15;
        candidate.evidence.push({
          kind: 'graph',
          path: file.relativePath,
          lineStart: edge.line,
          detail: edge.fromPath === seed
            ? `${edge.kind} edge from seed "${seed}" (${edge.specifier})`
            : `${edge.kind} edge from "${edge.fromPath}" into seed`
        });
        candidate.whyParts.push('import-graph neighbour');
      }
    }

    // Stage 4: local vector rerank over candidate text (explicitly lexical feature hashing).
    const queryVector = this.semanticProvider.embedText(query);
    for (const candidate of candidates.values()) {
      const text = `${candidate.title} ${candidate.summary} ${candidate.sourcePath}`;
      const vector = options?.includeSemanticRerank === false
        ? null
        : this.ensureEmbedding(`${candidate.entityType}:${candidate.entityId}`, candidate.entityType, text);
      if (vector) {
        const sim = Math.max(0, this.semanticProvider.cosineSimilarity(queryVector, vector));
        candidate.scores.vector = Number((sim * 2.2).toFixed(4));
        if (sim > 0.15) candidate.whyParts.push(`feature-hash similarity ${sim.toFixed(3)}`);
      }
      const haystack = `${candidate.title} ${candidate.summary} ${candidate.sourcePath} ${candidate.entityId}`.toLowerCase();
      candidate.matchedTerms = tokens.filter((t) => haystack.includes(t));
    }

    const results: RetrievalHit[] = [];
    for (const candidate of candidates.values()) {
      if (candidate.superseded) continue;
      const score = Number((
        candidate.scores.fts +
        candidate.scores.symbol +
        candidate.scores.graph +
        candidate.scores.vector
      ).toFixed(4));
      if (score <= 0) continue;
      results.push({
        entityId: candidate.entityId,
        entityType: candidate.entityType,
        title: candidate.title,
        summary: candidate.summary,
        sourcePath: candidate.sourcePath,
        score,
        verificationStatus: candidate.verificationStatus,
        namespace: candidate.namespace,
        superseded: false,
        scores: candidate.scores,
        matchedTerms: candidate.matchedTerms,
        why: Array.from(new Set(candidate.whyParts)).join(' + ') || 'relevance match',
        evidence: dedupeEvidence(candidate.evidence).slice(0, 8)
      });
    }

    if (results.length === 0) {
      const qLower = query.toLowerCase();
      for (const mod of this.store.getAllModules()) {
        if (mod.moduleId.toLowerCase().includes(qLower) || mod.purpose.toLowerCase().includes(qLower)) {
          results.push({
            entityId: mod.moduleId,
            entityType: 'module',
            title: mod.name,
            summary: mod.purpose,
            sourcePath: mod.rootPath,
            score: 1.0,
            verificationStatus: mod.verificationStatus,
            namespace: 'project/shared',
            superseded: false,
            scores: { fts: 0, symbol: 0, graph: 0, vector: 1 },
            matchedTerms: [qLower],
            why: 'module identifier/purpose substring match',
            evidence: [{ kind: 'module', path: mod.rootPath, detail: `module ${mod.moduleId}` }]
          });
        }
      }
    }

    this.flushEmbeddings();
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public findRelatedFiles(queryOrFilePath: string, limit = 10): Array<{
    relativePath: string;
    moduleId: string;
    role: string;
    summary: string;
    relationship: string;
    verificationStatus: string;
    score: number;
    evidence: RetrievalEvidence[];
  }> {
    const results: Array<{
      relativePath: string;
      moduleId: string;
      role: string;
      summary: string;
      relationship: string;
      verificationStatus: string;
      score: number;
      evidence: RetrievalEvidence[];
    }> = [];
    const seen = new Set<string>();

    const exactFile = this.store.getFile(queryOrFilePath);
    if (exactFile) {
      seen.add(exactFile.relativePath);
      const siblingFiles = this.store.getFilesByModule(exactFile.moduleId);
      for (const sib of siblingFiles) {
        if (!seen.has(sib.relativePath)) {
          seen.add(sib.relativePath);
          results.push({
            relativePath: sib.relativePath, moduleId: sib.moduleId, role: sib.role,
            summary: sib.summary, relationship: `same module (${exactFile.moduleId})`,
            verificationStatus: sib.verificationStatus, score: 1.0,
            evidence: [{ kind: 'module', path: sib.relativePath, detail: `module ${sib.moduleId}` }]
          });
        }
      }
      const outgoing = this.store.getCodeGraphEdges({ fromPath: exactFile.relativePath, limit: 40 });
      for (const edge of outgoing) {
        if (!edge.resolved || seen.has(edge.toPath)) continue;
        const f = this.store.getFile(edge.toPath);
        if (!f) continue;
        seen.add(f.relativePath);
        results.push({
          relativePath: f.relativePath, moduleId: f.moduleId, role: f.role,
          summary: f.summary, relationship: `imports target (${edge.specifier})`,
          verificationStatus: f.verificationStatus, score: 2.0,
          evidence: [{ kind: 'graph', path: f.relativePath, lineStart: edge.line, detail: `${edge.kind} ${edge.specifier}` }]
        });
      }
      const incoming = this.store.getCodeGraphEdges({ toPath: exactFile.relativePath, limit: 40 });
      for (const edge of incoming) {
        if (!edge.resolved || seen.has(edge.fromPath)) continue;
        const f = this.store.getFile(edge.fromPath);
        if (!f) continue;
        seen.add(f.relativePath);
        results.push({
          relativePath: f.relativePath, moduleId: f.moduleId, role: f.role,
          summary: f.summary, relationship: `imports this file (${edge.specifier})`,
          verificationStatus: f.verificationStatus, score: 2.2,
          evidence: [{ kind: 'graph', path: f.relativePath, lineStart: edge.line, detail: `${edge.kind} ${edge.specifier}` }]
        });
      }
    }

    const searchHits = this.searchKnowledge(queryOrFilePath, { limit, entityType: 'file' });
    for (const hit of searchHits) {
      if (!seen.has(hit.entityId)) {
        const f = this.store.getFile(hit.entityId);
        if (f) {
          seen.add(f.relativePath);
          results.push({
            relativePath: f.relativePath, moduleId: f.moduleId, role: f.role,
            summary: f.summary, relationship: `relevant match (${hit.why})`,
            verificationStatus: f.verificationStatus, score: hit.score, evidence: hit.evidence
          });
        }
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public getModuleContext(moduleId: string, options?: { asOf?: string }): {
    module: ModuleKnowledgeRecord | null;
    files: FileRecord[];
    decisions: Array<{ decisionId: string; title: string; decision: string; verificationStatus: string; why: string }>;
    symbols: ReturnType<ProjectMemoryStore['getSymbolsForFile']>;
  } {
    const mod = this.store.getModule(moduleId);
    if (!mod) return { module: null, files: [], decisions: [], symbols: [] };
    const files = this.store.getFilesByModule(mod.moduleId);
    const decisions = this.store.getDecisions(mod.moduleId, { asOf: options?.asOf }).map((d) => ({
      decisionId: d.decisionId,
      title: d.title,
      decision: d.decision,
      verificationStatus: d.verificationStatus,
      why: `ADR linked to module ${mod.moduleId}`
    }));
    const symbols = files.flatMap((f) => this.store.getSymbolsForFile(f.relativePath));
    return { module: mod, files, decisions, symbols };
  }
}

function dedupeEvidence(evidence: RetrievalEvidence[]): RetrievalEvidence[] {
  const seen = new Set<string>();
  const out: RetrievalEvidence[] = [];
  for (const e of evidence) {
    const key = `${e.kind}:${e.path || ''}:${e.lineStart || 0}:${e.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
