#!/usr/bin/env node
/**
 * ProjectMind retrieval benchmark.
 *
 * Builds a deterministic synthetic repository with known ground truth, then
 * measures file/symbol retrieval quality and freshness behavior. This is a
 * regression benchmark, not a claim of performance on arbitrary repositories.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { ProjectMemoryStore } = require(path.join(ROOT, 'packages/storage/dist'));
const { ProjectIndexer } = require(path.join(ROOT, 'packages/indexing/dist'));
const { KnowledgeRetriever } = require(path.join(ROOT, 'packages/retrieval/dist'));
const { ImpactAnalyzer } = require(path.join(ROOT, 'packages/impact-analysis/dist'));
const { ContextEngine } = require(path.join(ROOT, 'packages/context-engine/dist'));

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildFixture(root) {
  write(root, 'package.json', JSON.stringify({ name: 'benchmark-app', dependencies: { express: '^4', prisma: '^5' } }, null, 2));
  write(root, 'README.md', '# Benchmark App\nA billing and authentication service with orders.\n');
  write(root, 'src/auth/auth-service.ts', `export interface UserToken { userId: string; role: string; }\nexport class AuthService {\n  public verifyToken(token: string): UserToken {\n    return { userId: 'u1', role: token.startsWith('admin-') ? 'admin' : 'user' };\n  }\n  public hashPassword(plain: string): string { return 'hashed:' + plain; }\n}\n`);
  write(root, 'src/auth/token-utils.ts', `export function parseBearer(header: string): string {\n  return header.replace(/^Bearer\\s+/i, '');\n}\n`);
  write(root, 'src/orders/order-service.ts', `import { AuthService } from '../auth/auth-service';\nexport interface Order { id: string; total: number; }\nexport class OrderService {\n  constructor(private auth: AuthService) {}\n  public createOrder(token: string, total: number): Order {\n    this.auth.verifyToken(token);\n    return { id: 'o1', total };\n  }\n}\n`);
  write(root, 'src/orders/order-routes.ts', `import { OrderService } from './order-service';\nconst app: any = {};\napp.post('/api/orders', (req: any, res: any) => res.json(new OrderService({} as any).createOrder('t', 10)));\napp.get('/api/orders/:id', (req: any, res: any) => res.json({ id: req.params.id }));\n`);
  write(root, 'src/billing/invoice.ts', `export function calculateInvoiceTotal(items: Array<{ price: number; qty: number }>): number {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\nexport function applyTax(total: number, rate: number): number {\n  return total * (1 + rate);\n}\n`);
  write(root, 'src/billing/invoice.test.ts', `import { calculateInvoiceTotal } from './invoice';\nexport function testTotals() { return calculateInvoiceTotal([{ price: 2, qty: 3 }]) === 6; }\n`);
  write(root, 'src/db/schema.prisma', `model User {\n  id String @id\n  email String\n}\nmodel Order {\n  id String @id\n  total Int\n}\n`);
  write(root, 'docs/architecture.md', `# Architecture\n- Orders depend on auth for token verification.\n- Billing must never import order persistence directly.\n- All monetary values are stored as integer cents.\n`);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'projectmind-benchmark-'));
  buildFixture(tempRoot);
  const store = new ProjectMemoryStore(tempRoot);
  const indexer = new ProjectIndexer(tempRoot, store);
  const bootstrapStart = Date.now();
  const report = indexer.bootstrapProject();
  const bootstrapMs = Date.now() - bootstrapStart;
  const retriever = new KnowledgeRetriever(store);
  const impact = new ImpactAnalyzer(store);
  const contextEngine = new ContextEngine(store, retriever, impact, indexer);

  const cases = [
    { query: 'verifyToken auth token validation', expected: ['src/auth/auth-service.ts'] },
    { query: 'createOrder order total', expected: ['src/orders/order-service.ts'] },
    { query: 'POST /api/orders route', expected: ['src/orders/order-routes.ts'] },
    { query: 'calculateInvoiceTotal invoice tax', expected: ['src/billing/invoice.ts'] },
    { query: 'parseBearer authorization header', expected: ['src/auth/token-utils.ts'] },
    { query: 'prisma order schema integer total', expected: ['src/db/schema.prisma'] },
    { query: 'billing monetary integer cents', expected: ['docs/architecture.md', 'src/billing/invoice.ts'] }
  ];

  const latencies = [];
  let hitsAt1 = 0;
  let hitsAt3 = 0;
  let hitsAt5 = 0;
  let reciprocalRankSum = 0;
  let citationHits = 0;

  const results = [];
  for (const testCase of cases) {
    const start = Date.now();
    const hits = retriever.searchKnowledge(testCase.query, { limit: 5 });
    latencies.push(Date.now() - start);
    const rank = hits.findIndex((h) => testCase.expected.includes(h.entityId)) + 1;
    if (rank === 1) hitsAt1++;
    if (rank > 0 && rank <= 3) hitsAt3++;
    if (rank > 0 && rank <= 5) hitsAt5++;
    if (rank > 0) reciprocalRankSum += 1 / rank;
    const top = hits[0];
    if (top && top.evidence.length > 0 && top.why.length > 0) citationHits++;
    results.push({
      query: testCase.query,
      rank: rank || null,
      top: top ? { entityId: top.entityId, score: top.score, why: top.why, evidence: top.evidence.length } : null
    });
  }

  const count = cases.length;
  const metrics = {
    queries: count,
    recallAt1: Number((hitsAt1 / count).toFixed(3)),
    recallAt3: Number((hitsAt3 / count).toFixed(3)),
    recallAt5: Number((hitsAt5 / count).toFixed(3)),
    mrr: Number((reciprocalRankSum / count).toFixed(3)),
    explainabilityCoverage: Number((citationHits / count).toFixed(3)),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95)
    }
  };

  // Freshness: warm the retrieval cache, change a file, and confirm the cache
  // is never served for the new tree state.
  const first = contextEngine.getRelevantContext({ taskDescription: 'verifyToken auth token validation' });
  const cached = contextEngine.getRelevantContext({ taskDescription: 'verifyToken auth token validation' });
  write(tempRoot, 'src/auth/auth-service.ts', `export interface UserToken { userId: string; role: string; }\nexport class AuthService {\n  public verifyToken(token: string): UserToken {\n    if (!token) throw new Error('missing token');\n    return { userId: 'u1', role: 'user' };\n  }\n}\n`);
  const staleAttempt = contextEngine.getRelevantContext({ taskDescription: 'verifyToken auth token validation' });
  const afterSync = indexer.syncChangedFiles();
  const fresh = contextEngine.getRelevantContext({ taskDescription: 'verifyToken auth token validation' });

  const freshness = {
    warmCacheHit: cached.fromCache === true,
    staleServedFromCache: staleAttempt.fromCache === true,
    staleFlagRaised: staleAttempt.snapshot.stale === true,
    staleWarningPresent: staleAttempt.warnings.some((w) => w.includes('STALE')),
    syncReanalyzed: afterSync.reanalyzedFiles,
    postSyncCacheable: fresh.fromCache === false && fresh.snapshot.stale === false
  };

  const impactReport = impact.analyzeChangeImpact(['src/auth/auth-service.ts']);
  const quality = {
    dependencyGraph: impactReport.directlyAffectedModules,
    riskLevel: impactReport.riskLevel
  };

  const stats = store.getDatabaseStats();
  const health = store.getHealthReport();
  const output = {
    engineVersion: require(path.join(ROOT, 'package.json')).version,
    fixture: { files: report.indexedFilesCount, modules: report.modulesCount, routes: report.routesCount, models: report.modelsCount },
    bootstrapMs,
    metrics,
    freshness,
    quality,
    storage: stats,
    eventChainValid: health.eventChain.valid,
    retrievalBackend: retriever.getEmbeddingInfo(),
    results
  };

  console.log(JSON.stringify(output, null, 2));

  const failures = [];
  if (freshness.staleServedFromCache) failures.push('stale cache was served after a file change');
  if (!freshness.staleFlagRaised) failures.push('stale flag was not raised');
  if (!health.eventChain.valid) failures.push('memory event chain is invalid');
  if (metrics.recallAt5 < 0.85) failures.push(`recall@5 too low: ${metrics.recallAt5}`);

  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}

  if (failures.length > 0) {
    console.error(`\nBENCHMARK FAILED:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('\nBENCHMARK PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
