import { ProjectMemoryStore } from '@projectmind/storage';
import { FileRecord, ModuleKnowledgeRecord } from '@projectmind/shared';

export interface SemanticSearchProvider {
  readonly name: string;
  embedText(text: string): number[];
  cosineSimilarity(a: number[], b: number[]): number;
}

export class LocalHashSemanticProvider implements SemanticSearchProvider {
  public readonly name = 'local-hash-vectors-v1';
  private readonly dims = 64;

  public embedText(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    const tokens = text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
    for (const tok of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        hash ^= tok.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const idx = Math.abs(hash) % this.dims;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vec.map((v) => Number((v / norm).toFixed(4)));
  }

  public cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) dot += a[i] * b[i];
    return dot;
  }
}

export class KnowledgeRetriever {
  private readonly store: ProjectMemoryStore;
  private semanticProvider: SemanticSearchProvider;

  constructor(store: ProjectMemoryStore, semanticProvider?: SemanticSearchProvider) {
    this.store = store;
    this.semanticProvider = semanticProvider || new LocalHashSemanticProvider();
  }

  public setSemanticProvider(provider: SemanticSearchProvider): void {
    this.semanticProvider = provider;
  }

  public searchKnowledge(
    query: string,
    options?: {
      limit?: number;
      entityType?: 'file' | 'module' | 'decision' | 'knowledge';
      includeSemanticRerank?: boolean;
    }
  ): Array<{
    entityId: string;
    entityType: string;
    title: string;
    summary: string;
    sourcePath: string;
    score: number;
    verificationStatus: string;
  }> {
    const limit = options?.limit || 12;
    const ftsResults = this.store.searchFts(query, limit * 2, options?.entityType);
    const queryVec = this.semanticProvider.embedText(query);

    const enriched = ftsResults.map((r) => {
      let verificationStatus = 'verified';
      if (r.entityType === 'module') verificationStatus = this.store.getModule(r.entityId)?.verificationStatus || 'verified';
      else if (r.entityType === 'file') verificationStatus = this.store.getFile(r.entityId)?.verificationStatus || 'verified';
      else if (r.entityType === 'knowledge') {
        const items = this.store.getKnowledgeItems();
        verificationStatus = items.find((i) => i.knowledgeId === r.entityId)?.verificationStatus || 'verified';
      }
      const semSim = options?.includeSemanticRerank !== false
        ? this.semanticProvider.cosineSimilarity(queryVec, this.semanticProvider.embedText(`${r.title} ${r.summary}`))
        : 0;
      const combinedScore = Number((r.score + semSim * 2.0).toFixed(4));
      return { ...r, score: combinedScore, verificationStatus };
    });

    if (enriched.length === 0 && query.trim().length > 0) {
      const qLower = query.toLowerCase();
      for (const mod of this.store.getAllModules()) {
        if (mod.moduleId.toLowerCase().includes(qLower) || mod.purpose.toLowerCase().includes(qLower)) {
          enriched.push({
            entityId: mod.moduleId, entityType: 'module', title: mod.name,
            summary: mod.purpose, sourcePath: mod.rootPath, score: 1.0, verificationStatus: mod.verificationStatus
          });
        }
      }
    }

    return enriched.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public findRelatedFiles(queryOrFilePath: string, limit = 10): Array<{
    relativePath: string;
    moduleId: string;
    role: string;
    summary: string;
    relationship: string;
    verificationStatus: string;
  }> {
    const results: Array<{
      relativePath: string;
      moduleId: string;
      role: string;
      summary: string;
      relationship: string;
      verificationStatus: string;
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
            summary: sib.summary, relationship: `Same module (${exactFile.moduleId})`, verificationStatus: sib.verificationStatus
          });
        }
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
            summary: f.summary, relationship: 'Relevant lexical/symbol match', verificationStatus: f.verificationStatus
          });
        }
      }
    }
    return results.slice(0, limit);
  }

  public getModuleContext(moduleId: string): {
    module: ModuleKnowledgeRecord | null;
    files: FileRecord[];
    decisions: Array<{ decisionId: string; title: string; decision: string; verificationStatus: string }>;
  } {
    const mod = this.store.getModule(moduleId);
    if (!mod) return { module: null, files: [], decisions: [] };
    const files = this.store.getFilesByModule(mod.moduleId);
    const decisions = this.store.getDecisions(mod.moduleId).map((d) => ({
      decisionId: d.decisionId, title: d.title, decision: d.decision, verificationStatus: d.verificationStatus
    }));
    return { module: mod, files, decisions };
  }
}
