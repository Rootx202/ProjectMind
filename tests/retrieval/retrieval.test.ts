import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIndexer } from '@projectmind/indexing';
import { KnowledgeRetriever } from '@projectmind/retrieval';

export function runRetrievalTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;
  const check = (name: string, fn: () => void) => {
    try { fn(); passed++; details.push(`PASS [Retrieval] ${name}`); }
    catch (err) { failed++; details.push(`FAIL [Retrieval] ${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-retrieval-test-'));
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'orders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'retrieval-test' }));
  fs.writeFileSync(path.join(root, 'src', 'auth', 'auth.ts'), 'export function verifyToken(token: string): string { return token; }\n');
  fs.writeFileSync(path.join(root, 'src', 'orders', 'orders.ts'), `import { verifyToken } from '../auth/auth';\nexport function createOrder(token: string): string { return verifyToken(token); }\n`);
  fs.writeFileSync(path.join(root, 'src', 'orders', 'routes.ts'), `const app: any = {};\napp.post('/api/orders', (req: any, res: any) => res.json({ ok: true }));\n`);

  const store = new ProjectMemoryStore(root);
  const indexer = new ProjectIndexer(root, store);
  indexer.bootstrapProject();
  const retriever = new KnowledgeRetriever(store);

  check('1. Every hit carries scores, matched terms, a why-string, and evidence', () => {
    const hits = retriever.searchKnowledge('createOrder verify token', { limit: 5 });
    assert.ok(hits.length > 0);
    for (const hit of hits) {
      assert.strictEqual(typeof hit.why, 'string');
      assert.ok(hit.why.length > 0);
      assert.ok(Array.isArray(hit.matchedTerms));
      assert.ok(Array.isArray(hit.evidence));
      assert.jsonEqualShape(hit.scores, ['fts', 'symbol', 'graph', 'vector']);
    }
    assert.ok(hits.some((h) => h.evidence.some((e) => e.kind === 'symbol')));
  });

  check('2. Code-graph neighbours expand candidate recall', () => {
    const hits = retriever.searchKnowledge('orders route api', { limit: 10 });
    const ordersHit = hits.find((h) => h.entityId === 'src/orders/orders.ts' || h.entityId === 'src/orders/routes.ts');
    assert.ok(ordersHit, 'expected an orders hit');
    assert.ok(hits.some((h) => h.evidence.some((e) => e.kind === 'graph')), 'expected at least one graph-derived evidence item');
  });

  check('3. Vector embeddings are persisted with model metadata', () => {
    retriever.searchKnowledge('verifyToken authentication', { limit: 5 });
    const stats = store.getDatabaseStats();
    assert.ok(stats.embeddings > 0, 'expected persisted embeddings');
    const all = store.getAllEmbeddings();
    assert.ok(all.length > 0);
    assert.ok(all.every((e) => e.model === 'hash-feature-v2'));
    assert.ok(all.every((e) => Array.isArray(e.vector) && e.vector.length === 192));
  });

  check('4. Superseded knowledge never appears in default retrieval', () => {
    store.upsertKnowledgeItemsBatch([{
      knowledgeId: 'old_rule', category: 'convention', title: 'Use verifyToken for every request',
      summary: 'Old ordering rule', details: {}, sourceFiles: [], relatedModules: ['src/orders'],
      verificationStatus: 'verified', confidence: 0.9, version: 1, lastVerifiedAt: new Date().toISOString()
    }], { actorType: 'agent', actorId: 'agent/a' });
    assert.ok(retriever.searchKnowledge('verifyToken ordering rule', { limit: 10 }).some((h) => h.entityId === 'old_rule'));
    store.supersedeKnowledgeItem('old_rule', 'new_rule', { actorId: 'user/a' });
    assert.ok(!retriever.searchKnowledge('verifyToken ordering rule', { limit: 10 }).some((h) => h.entityId === 'old_rule'));
  });

  check('5. Unknown queries degrade safely without throwing', () => {
    const hits = retriever.searchKnowledge('zzzz-nonexistent-symbol-xyz', { limit: 5 });
    assert.ok(Array.isArray(hits));
  });

  fs.rmSync(root, { recursive: true, force: true });
  return { passed, failed, details };
}

// Small structural assertion helper (Node's assert has no shape helper).
declare module 'assert' {
  function jsonEqualShape(value: unknown, keys: string[]): void;
}
(assert as any).jsonEqualShape = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== 'object') throw new Error('expected object');
  for (const key of keys) {
    if (!(key in (value as Record<string, unknown>))) throw new Error(`missing score dimension ${key}`);
  }
};
