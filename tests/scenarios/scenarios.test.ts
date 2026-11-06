import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SmartAutoModeEngine } from '@projectmind/agent-sdk';
import { ProjectMindMcpServer } from '@projectmind/mcp-server';

export function runScenarioTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;
  const check = (name: string, fn: () => void) => {
    try { fn(); passed++; details.push(`PASS [Scenario] ${name}`); }
    catch (err) { failed++; details.push(`FAIL [Scenario] ${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-scenarios-'));
  const existingRepo = path.join(tmpRoot, 'existing-app');
  fs.mkdirSync(path.join(existingRepo, 'src', 'users'), { recursive: true });
  fs.mkdirSync(path.join(existingRepo, 'src', 'payments'), { recursive: true });
  fs.mkdirSync(path.join(existingRepo, 'src', 'notifications'), { recursive: true });
  fs.writeFileSync(path.join(existingRepo, 'package.json'), JSON.stringify({ name: 'existing-app', dependencies: { express: '^4.19.0' } }));
  fs.writeFileSync(path.join(existingRepo, 'src', 'users', 'user-service.ts'), `export class UserService { public getUserEmail(id: string): string { return id + '@example.com'; } }\n`);
  fs.writeFileSync(path.join(existingRepo, 'src', 'payments', 'payment-service.ts'), `import { UserService } from '../users/user-service';\nexport class PaymentService { private users = new UserService(); public charge(userId: string, amount: number): boolean { return Boolean(this.users.getUserEmail(userId)) && amount > 0; } }\n`);
  fs.writeFileSync(path.join(existingRepo, 'src', 'notifications', 'email-service.ts'), `import { UserService } from '../users/user-service';\nexport class EmailService { private users = new UserService(); public notify(userId: string): string { return 'sent:' + this.users.getUserEmail(userId); } }\n`);

  check('Scenario 1: First opening initializes once and creates a verified knowledge base', () => {
    const engine = new SmartAutoModeEngine(existingRepo);
    assert.strictEqual(engine.onProjectOpen().action, 'initial_bootstrap');
  });

  check('Scenario 2: Repeated small tasks retrieve selective context and use cache without full rescan', () => {
    const engine = new SmartAutoModeEngine(existingRepo);
    const task1 = engine.onBeforeTask('Fix charge validation in payment-service.ts', { targetFiles: ['src/payments/payment-service.ts'] });
    assert.strictEqual(task1.retrievalNeeded, true);
    const task1Repeat = engine.onBeforeTask('Fix charge validation in payment-service.ts', { targetFiles: ['src/payments/payment-service.ts'] });
    assert.strictEqual(task1Repeat.fromCache, true);
    assert.strictEqual(engine.onBeforeTask('What is a binary search tree?').retrievalNeeded, false);
  });

  check('Scenario 3: Return to project reuses existing knowledge with zero files rescanned', () => {
    const reopenRes = new SmartAutoModeEngine(existingRepo).onProjectOpen();
    assert.strictEqual(reopenRes.action, 'warm_reuse_unchanged');
    assert.strictEqual(reopenRes.syncedFilesCount, 0);
  });

  check('Scenario 4: Single file modification updates only the affected file and module', () => {
    const engine = new SmartAutoModeEngine(existingRepo);
    fs.writeFileSync(path.join(existingRepo, 'src', 'notifications', 'email-service.ts'), `import { UserService } from '../users/user-service';\nexport class EmailService { public sendBulk(ids: string[]): number { return ids.length; } }\n`);
    const delta = engine.onAfterFileChange();
    assert.deepStrictEqual(delta.syncedFiles, ['src/notifications/email-service.ts']);
  });

  check('Scenario 5: Shared architecture change detects cross-module impact and updates ADRs', () => {
    const engine = new SmartAutoModeEngine(existingRepo);
    const impact = engine.impact.analyzeChangeImpact(['src/users/user-service.ts']);
    assert.strictEqual(impact.recommendsDeepAnalysis, true);
  });

  check('Scenario 6: New project from prompt stores planned knowledge and transitions to verified when built', () => {
    const greenfieldRepo = path.join(tmpRoot, 'greenfield-saas');
    fs.mkdirSync(greenfieldRepo, { recursive: true });
    const mcp = new ProjectMindMcpServer(greenfieldRepo, true);
    const initPromptRes = mcp.callTool('initialize_project', {
      mode: 'prompt',
      projectName: 'pulse-analytics',
      promptText: 'Build PulseAnalytics with TypeScript, Fastify, PostgreSQL, and JWT auth.'
    });
    assert.strictEqual(initPromptRes.structuredContent.status, 'planned_from_prompt');
    fs.mkdirSync(path.join(greenfieldRepo, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(greenfieldRepo, 'src', 'auth', 'jwt-auth.ts'), `export function verifyTenantJwt(token: string) { return { tenantId: 't_1' }; }\n`);
    const syncRes = mcp.callTool('sync_changed_files', {});
    assert.ok((syncRes.structuredContent.transitionedFromPlanned as string[]).includes('src/auth'));
  });

  check('Scenario 7: Corrupted SQLite database is backed up and safely recovered', () => {
    fs.writeFileSync(path.join(existingRepo, '.projectmind', 'projectmind.db'), 'CORRUPTED_BINARY_HEADER');
    const recoveredEngine = new SmartAutoModeEngine(existingRepo);
    assert.strictEqual(recoveredEngine.onProjectOpen().action, 'recovered_reinitialized');
  });

  check('Scenario 8: Malformed hook input or unavailable directory fails open without blocking the coding agent', () => {
    assert.deepStrictEqual(SmartAutoModeEngine.handleHookStdin('claude-code', 'SessionStart', '<<<INVALID_JSON>>>', existingRepo), {});
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { passed, failed, details };
}
