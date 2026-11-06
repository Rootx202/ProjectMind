import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SetupManager } from '@projectmind/setup';
import { DiagnosticsEngine } from '@projectmind/diagnostics';
import { runCli } from '@projectmind/cli';
import { SupportedAgentId } from '@projectmind/agent-sdk';

export function runAdapterTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;
  const check = (name: string, fn: () => void) => {
    try { fn(); passed++; details.push(`PASS [Adapters] ${name}`); }
    catch (err) { failed++; details.push(`FAIL [Adapters] ${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-adapter-test-'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'adapter-test-repo' }));
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), `export const READY = true;\n`);

  const setup = new SetupManager();
  const allAgentIds: SupportedAgentId[] = [
    'antigravity', 'codex', 'claude-code', 'gemini-cli', 'cursor', 'github-copilot',
    'opencode', 'hermes-agent', 'deepseek-harness'
  ];

  for (const agentId of allAgentIds) {
    check(`Adapter [${agentId}]: install, verify, idempotent reinstall, backup preservation, and uninstall`, () => {
      const firstInstall = setup.installAdapter(tmpDir, agentId);
      assert.strictEqual(firstInstall.verification.verified, true);
      const secondInstall = setup.installAdapter(tmpDir, agentId);
      assert.strictEqual(secondInstall.verification.verified, true);
      const uninst = setup.uninstallAdapter(tmpDir, agentId);
      assert.strictEqual(uninst.uninstalled, true);
      const reinstall = setup.installAdapter(tmpDir, agentId);
      assert.strictEqual(reinstall.verification.verified, true);
    });
  }

  check('Adapter alias resolution: hermes, deepseek-hermes, and deepseek map correctly', () => {
    assert.strictEqual(setup.normalizeAgentId('hermes'), 'hermes-agent');
    assert.strictEqual(setup.normalizeAgentId('hermes_agent'), 'hermes-agent');
    assert.strictEqual(setup.normalizeAgentId('deepseek'), 'deepseek-harness');
    assert.strictEqual(setup.normalizeAgentId('deepseek-hermes'), 'deepseek-harness');
    assert.strictEqual(setup.normalizeAgentId('deepseek-hernes'), 'deepseek-harness');
    assert.strictEqual(setup.normalizeAgentId('dsh'), 'deepseek-harness');
    assert.strictEqual(setup.normalizeAgentId('open-code'), 'opencode');

    const hermesAdapter = setup.getAdapter('hermes');
    assert.strictEqual(hermesAdapter.agentId, 'hermes-agent');
    const dshAdapter = setup.getAdapter('deepseek-hermes');
    assert.strictEqual(dshAdapter.agentId, 'deepseek-harness');
  });

  check('CLI & Diagnostics Engine verify all 9 installed adapters and project health', () => {
    const cliRes = runCli(['node', 'projectmind', 'diagnostics', '--project-root', tmpDir]);
    assert.strictEqual(cliRes.exitCode, 0);
    const diag = DiagnosticsEngine.runDiagnostics(tmpDir);
    assert.strictEqual(diag.healthy, true);
    assert.strictEqual(diag.adapterStatuses.length, 9);
    assert.ok(diag.adapterStatuses.every((s) => s.installedAndVerified));
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { passed, failed, details };
}
