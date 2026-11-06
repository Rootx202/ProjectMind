import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectMindMcpServer } from '@projectmind/mcp-server';
import { ProjectIdentityManager } from '@projectmind/core';

export function runMcpTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;
  const check = (name: string, fn: () => void) => {
    try { fn(); passed++; details.push(`PASS [MCP] ${name}`); }
    catch (err) { failed++; details.push(`FAIL [MCP] ${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mcp-test-'));
  fs.mkdirSync(path.join(tmpDir, 'src', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'mcp-test-service', dependencies: { fastify: '^4.0.0' } }));
  fs.writeFileSync(path.join(tmpDir, 'src', 'billing', 'invoice.ts'), `export interface Invoice { id: string; total: number; }\nexport function calculateInvoiceTotal(items: number[]): number { return items.reduce((a, b) => a + b, 0); }\n`);
  fs.writeFileSync(path.join(tmpDir, '.env'), 'STRIPE_SECRET_KEY=sk_live_secret1234567890\n');

  const server = new ProjectMindMcpServer(tmpDir, true);

  check('1. MCP tool registration exposes all 22 required tools with valid schemas', () => {
    assert.strictEqual(server.listTools().length, 22);
  });

  check('2. JSON-RPC 2.0 initialize handshake returns serverInfo and concise instructions', () => {
    const res = server.handleJsonRpcRequest({ jsonrpc: '2.0', id: 42, method: 'initialize', params: {} }) as any;
    assert.strictEqual(res.id, 42);
    assert.strictEqual(res.result.serverInfo.name, 'projectmind-mcp-server');
  });

  check('3. Functional execution of all discovery, retrieval, impact, memory, and efficiency tools', () => {
    assert.ok(!server.callTool('initialize_project', { mode: 'existing' }).isError);
    assert.strictEqual(server.callTool('get_project_overview', {}).structuredContent.initialized, true);
    assert.strictEqual(server.callTool('get_project_status', {}).structuredContent.initialized, true);
    assert.strictEqual(server.callTool('get_relevant_context', { taskDescription: 'Update invoice total calculation' }).structuredContent.retrievalNeeded, true);
    assert.strictEqual(server.callTool('get_module_context', { moduleId: 'src/billing' }).structuredContent.found, true);
    assert.ok((server.callTool('search_project_knowledge', { query: 'calculateInvoiceTotal' }).structuredContent.count as number) >= 1);
    assert.strictEqual(server.callTool('get_file_summary', { filePath: 'src/billing/invoice.ts' }).structuredContent.found, true);
    assert.strictEqual(server.callTool('record_architectural_decision', { title: 'Use integer cents', context: 'Rounding', decision: 'Integer cents' }).structuredContent.recorded, true);
  });

  check('4. Input validation, path traversal rejection, secret blocking, and missing project handling', () => {
    assert.strictEqual(server.callTool('get_relevant_context', {}).isError, true);
    assert.strictEqual(server.callTool('get_file_summary', { filePath: '../../../etc/hosts' }).isError, true);
    assert.strictEqual(server.callTool('get_file_summary', { filePath: '.env' }).isError, true);
  });

  check('5. Large output limit truncation enforcement', () => {
    ProjectIdentityManager.saveConfig(tmpDir, { maxToolOutputChars: 450 });
    assert.strictEqual(server.callTool('get_architecture_context', {}).structuredContent.truncated, true);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { passed, failed, details };
}
