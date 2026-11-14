import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { ProjectMindMcpServer } from '@projectmind/mcp-server';
import { startDashboard } from '@projectmind/mcp-server/dist/dashboard';

export async function runDashboardTests(): Promise<{ passed: number; failed: number; details: string[] }> {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-dashboard-'));
  const mcp = new ProjectMindMcpServer(root, true);
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  try {
    dashboard = startDashboard(root, 0, (name, args) => mcp.callTool(name, { ...args, projectRoot: root }));
    await new Promise<void>((resolve, reject) => {
      dashboard!.server.once('listening', resolve);
      dashboard!.server.once('error', reject);
    });
    const address = dashboard.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.strictEqual((address as any).address, '127.0.0.1');
    assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:/);
    const localUrl = `http://127.0.0.1:${(address as any).port}/`;
    const page = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(localUrl, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => body += chunk);
        response.on('end', () => resolve({ status: response.statusCode || 0, body }));
      }).on('error', reject);
    });
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('ProjectMind Dashboard'));
    assert.ok(!page.body.includes('https://'));
    const status = await new Promise<any>((resolve, reject) => {
      const req = http.request(localUrl + 'api/status', { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => body += chunk);
        response.on('end', () => { try { resolve({ code: response.statusCode, data: JSON.parse(body) }); } catch (err) { reject(err); } });
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.strictEqual(status.code, 200);
    assert.strictEqual(status.data.initialized, false);
    passed++;
    details.push('PASS [Dashboard] Local HTTP UI serves offline and API is bound to loopback');
  } catch (err) {
    failed++;
    details.push(`FAIL [Dashboard] Loopback UI/API integration: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (dashboard) await new Promise<void>((resolve) => dashboard!.server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { passed, failed, details };
}
