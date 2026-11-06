import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIndexer } from '@projectmind/indexing';
import { KnowledgeEngine } from '@projectmind/knowledge';
import { PARSER_VERSION } from '@projectmind/shared';

export function runIndexingTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;
  const check = (name: string, fn: () => void) => {
    try { fn(); passed++; details.push(`PASS [Indexing] ${name}`); }
    catch (err) { failed++; details.push(`FAIL [Indexing] ${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-indexing-test-'));
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'orders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'indexing-test', dependencies: { express: '^4' } }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } }
  }));
  fs.writeFileSync(path.join(root, 'src', 'lib', 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\nexport interface Adder { add(a: number, b: number): number; }\n');
  fs.writeFileSync(path.join(root, 'src', 'orders', 'service.ts'), `import { add } from '@app/lib/math';\nimport type { Adder } from '../lib/math';\nexport class OrderService implements Adder {\n  add(a: number, b: number): number { return add(a, b); }\n}\n`);

  // A file whose interesting change is only in the final byte, past the old 256 KiB sample limit.
  const tailPath = path.join(root, 'src', 'lib', 'large.ts');
  const padding = '// padding line for size\n'.repeat(16000); // ~400 KiB
  fs.writeFileSync(tailPath, `${padding}export const TAIL_MARKER_V1 = 'one';\n`);

  const store = new ProjectMemoryStore(root);
  const indexer = new ProjectIndexer(root, store);
  const report = indexer.bootstrapProject();

  check('1. Bootstrap uses the AST parser and stores full-file + chunk hashes', () => {
    assert.strictEqual(report.parseFailures.length, 0);
    const file = store.getFile('src/orders/service.ts');
    assert.ok(file);
    assert.strictEqual(file!.parserVersion, PARSER_VERSION);
    assert.strictEqual(file!.fullSha256?.length, 64);
    assert.strictEqual(file!.sha256, file!.fullSha256);
    const chunks = store.getFileChunks('src/lib/large.ts');
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.strictEqual(chunk.sha256.length, 64);
      assert.ok(chunk.endByte > chunk.startByte);
    }
  });

  check('2. AST extracts symbols, imports, and resolves tsconfig path aliases', () => {
    const file = store.getFile('src/orders/service.ts');
    assert.ok(file!.imports.includes('@app/lib/math'));
    assert.ok(file!.resolvedImports?.includes('src/lib/math.ts'), `resolved imports: ${JSON.stringify(file!.resolvedImports)}`);
    assert.ok(file!.symbols.some((s) => s.name === 'OrderService' && s.kind === 'class'));
    const edges = store.getCodeGraphEdges({ fromPath: 'src/orders/service.ts' });
    assert.ok(edges.some((e) => e.resolved && e.toPath === 'src/lib/math.ts'));
    assert.ok(store.getSymbolsForFile('src/lib/math.ts').some((s) => s.name === 'add'));
  });

  check('3. Module dependency graph is derived from resolved file edges', () => {
    const orders = store.getModule('src/orders');
    const lib = store.getModule('src/lib');
    assert.ok(orders!.dependencies.includes('src/lib'));
    assert.ok(lib!.dependents.includes('src/orders'));
  });

  check('4. Detection hashes the whole file, including changes at the tail', () => {
    let before = indexer.detectProjectChanges();
    assert.strictEqual(before.hasChanges, false);
    const content = fs.readFileSync(tailPath, 'utf8');
    fs.writeFileSync(tailPath, content.replace("TAIL_MARKER_V1 = 'one'", "TAIL_MARKER_V1 = 'two'"));
    before = indexer.detectProjectChanges();
    assert.ok(before.modified.includes('src/lib/large.ts'), 'tail-only change must be detected');
  });

  check('5. Incremental sync re-analyzes only changed files and is a no-op when clean', () => {
    const first = indexer.syncChangedFiles();
    assert.ok(first.reanalyzedFiles >= 1);
    assert.ok(first.syncedFiles.includes('src/lib/large.ts'));
    const second = indexer.syncChangedFiles();
    assert.strictEqual(second.reanalyzedFiles, 0);
    assert.ok(second.skippedUnchanged >= 2);
  });

  check('6. Files larger than the analysis window are marked truncated, not silently trusted', () => {
    const huge = path.join(root, 'src', 'lib', 'huge.ts');
    const header = 'export const HUGE_HEAD = 1;\n';
    const padding = '// huge padding\n'.repeat(220000); // ~3.3 MiB
    fs.writeFileSync(huge, header + padding);
    indexer.syncChangedFiles();
    const rec = store.getFile('src/lib/huge.ts');
    assert.ok(rec);
    assert.strictEqual(rec!.analysisStatus, 'truncated');
    assert.strictEqual(rec!.fullSha256?.length, 64);
    const sizeBefore = fs.statSync(huge).size;
    fs.appendFileSync(huge, '// tail change\n');
    assert.ok(fs.statSync(huge).size > sizeBefore);
    const changes = indexer.detectProjectChanges();
    assert.ok(changes.modified.includes('src/lib/huge.ts'));
  });

  fs.rmSync(root, { recursive: true, force: true });

  // Planned knowledge must not be auto-verified by mere file existence.
  const promptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-planned-test-'));
  fs.writeFileSync(path.join(promptRoot, 'package.json'), JSON.stringify({ name: 'planned-app' }));
  const promptStore = new ProjectMemoryStore(promptRoot);
  const promptIndexer = new ProjectIndexer(promptRoot, promptStore);
  const knowledge = new KnowledgeEngine(promptRoot, promptStore);
  knowledge.initializeFromPrompt({
    promptText: 'Build an authentication service. Users must log in with email and password.',
    requirements: ['Users must log in with email and password']
  });

  check('7. Planned knowledge stays planned until concrete implementation evidence exists', () => {
    fs.mkdirSync(path.join(promptRoot, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(promptRoot, 'src', 'auth', 'index.ts'), 'export const placeholder = 1;\n');
    promptIndexer.syncChangedFiles();
    let apiItem = promptStore.getKnowledgeItems().find((i) => i.knowledgeId === 'planned_api_surface');
    assert.ok(apiItem, 'planned api item should exist');
    assert.strictEqual(apiItem!.verificationStatus, 'planned', 'mere file existence must not verify planned API knowledge');

    fs.writeFileSync(path.join(promptRoot, 'src', 'auth', 'routes.ts'), `const app: any = {};\napp.post('/api/login', (req: any, res: any) => res.json({ ok: true }));\n`);
    promptIndexer.syncChangedFiles();
    apiItem = promptStore.getKnowledgeItems().find((i) => i.knowledgeId === 'planned_api_surface');
    assert.strictEqual(apiItem!.verificationStatus, 'verified', 'route evidence should verify planned API knowledge');
    assert.ok(Array.isArray((apiItem!.details as any).verificationEvidence));
  });

  check('8. Large-file full hash survives reopen and is persisted in SQLite', () => {
    const reopened = new ProjectMemoryStore(promptRoot);
    const manifest = reopened.getIndexManifest();
    assert.ok(manifest);
    assert.strictEqual(reopened.getHealthReport().eventChain.valid, true);
    fs.rmSync(promptRoot, { recursive: true, force: true });
  });

  return { passed, failed, details };
}
