import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SetupManager } from '@projectmind/setup';
import { runCli } from '@projectmind/cli';
import { ProjectMemoryStore } from '@projectmind/storage';

const ALL_AGENTS = [
  'antigravity',
  'claude-code',
  'codex',
  'cursor',
  'gemini-cli',
  'github-copilot',
  'deepseek-harness',
  'hermes-agent',
  'opencode'
];

export function runInstallerTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;

  const check = (name: string, fn: () => void) => {
    try {
      fn();
      passed++;
      details.push(`PASS [Installer] ${name}`);
    } catch (err) {
      failed++;
      details.push(`FAIL [Installer] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-installer-test-'));

  check('1. SetupManager lists all 9 supported plugins', () => {
    const setup = new SetupManager();
    const plugins = setup.listPlugins(tmpRoot);
    assert.strictEqual(plugins.length, 9);
    const ids = plugins.map((p) => p.id).sort();
    assert.deepStrictEqual(ids, [...ALL_AGENTS].sort());
  });

  check('2. Individual adapter lifecycle: Antigravity install, verify, disable, enable, uninstall', () => {
    const projDir = path.join(tmpRoot, 'antigravity-project');
    fs.mkdirSync(projDir, { recursive: true });

    // Seed project memory to test non-destructive uninstall guarantee
    const pmDir = path.join(projDir, '.projectmind');
    fs.mkdirSync(pmDir, { recursive: true });
    const dummyDbPath = path.join(pmDir, 'projectmind.db');
    fs.writeFileSync(dummyDbPath, 'SQLITE DUMMY DATA FOR TEST');

    const setup = new SetupManager();

    // 1. Install Antigravity only
    const installRes = setup.installAdapter(projDir, 'antigravity');
    assert.strictEqual(installRes.installed, true);
    assert.ok(fs.existsSync(path.join(projDir, '.agents', 'mcp_config.json')));
    assert.ok(fs.existsSync(path.join(projDir, '.agents', 'skills', 'projectmind', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(projDir, '.agents', 'plugins', 'projectmind', 'hooks.json')));

    // 2. Verify
    const verifyRes = setup.verifyAdapter(projDir, 'antigravity');
    assert.strictEqual(verifyRes.verified, true);

    // 3. Disable
    const disableRes = setup.disableAdapter(projDir, 'antigravity');
    assert.strictEqual(disableRes.disabled, true);
    const mcpRawDisabled = JSON.parse(fs.readFileSync(path.join(projDir, '.agents', 'mcp_config.json'), 'utf8'));
    assert.strictEqual(mcpRawDisabled.mcpServers.projectmind.disabled, true);

    // 4. Enable
    const enableRes = setup.enableAdapter(projDir, 'antigravity');
    assert.strictEqual(enableRes.enabled, true);
    const mcpRawEnabled = JSON.parse(fs.readFileSync(path.join(projDir, '.agents', 'mcp_config.json'), 'utf8'));
    assert.strictEqual(mcpRawEnabled.mcpServers.projectmind.disabled, undefined);

    // 5. Uninstall
    const uninstallRes = setup.uninstallAdapter(projDir, 'antigravity');
    assert.strictEqual(uninstallRes.uninstalled, true);

    // NON-DESTRUCTIVE GUARANTEE: .projectmind and dummy projectmind.db must remain intact!
    assert.ok(fs.existsSync(dummyDbPath), 'Uninstall MUST NOT delete .projectmind/projectmind.db');
    assert.strictEqual(fs.readFileSync(dummyDbPath, 'utf8'), 'SQLITE DUMMY DATA FOR TEST');
  });

  check('3. All 9 adapters can be independently installed and verified in isolation', () => {
    const setup = new SetupManager();

    for (const agentId of ALL_AGENTS) {
      const projDir = path.join(tmpRoot, `test-${agentId}`);
      fs.mkdirSync(projDir, { recursive: true });

      const installRes = setup.installAdapter(projDir, agentId);
      assert.strictEqual(installRes.installed, true, `Install failed for ${agentId}`);

      const verifyRes = setup.verifyAdapter(projDir, agentId);
      assert.strictEqual(verifyRes.verified, true, `Verification failed for ${agentId}`);

      const uninstallRes = setup.uninstallAdapter(projDir, agentId);
      assert.strictEqual(uninstallRes.uninstalled, true, `Uninstall failed for ${agentId}`);
    }
  });

  check('4. CLI runCli commands (version, help, list, search, doctor)', () => {
    const ver = runCli(['node', 'projectmind', 'version']);
    assert.strictEqual(ver.exitCode, 0);
    assert.ok(ver.output.includes('ProjectMind v'));

    const help = runCli(['node', 'projectmind', 'help']);
    assert.strictEqual(help.exitCode, 0);
    assert.ok(help.output.includes('Core Commands:'));
    assert.ok(help.output.includes('Plugin Commands:'));

    const listJson = runCli(['node', 'projectmind', 'plugin', 'list', '--json', '--project-root', tmpRoot]);
    assert.strictEqual(listJson.exitCode, 0);
    const parsedList = JSON.parse(listJson.output);
    assert.strictEqual(parsedList.length, 9);

    const search = runCli(['node', 'projectmind', 'plugin', 'search', 'opencode', '--json']);
    assert.strictEqual(search.exitCode, 0);
    const searchParsed = JSON.parse(search.output);
    assert.ok(searchParsed.length >= 1);
    assert.strictEqual(searchParsed[0].id, 'opencode');

    const doctor = runCli(['node', 'projectmind', 'plugin', 'doctor', '--json', '--project-root', tmpRoot]);
    assert.strictEqual(doctor.exitCode, 0);
    const docParsed = JSON.parse(doctor.output);
    assert.strictEqual(docParsed.healthy, true);
  });

  check('5. CLI runCli plugin lifecycle (install, verify, disable, enable, uninstall)', () => {
    const testDir = path.join(tmpRoot, 'cli-lifecycle-test');
    fs.mkdirSync(testDir, { recursive: true });

    // Install opencode
    const inst = runCli(['node', 'projectmind', 'plugin', 'install', 'opencode', '--project-root', testDir, '--json']);
    assert.strictEqual(inst.exitCode, 0);
    assert.ok(fs.existsSync(path.join(testDir, 'opencode.json')));

    // Verify opencode
    const ver = runCli(['node', 'projectmind', 'plugin', 'verify', 'opencode', '--project-root', testDir, '--json']);
    assert.strictEqual(ver.exitCode, 0);

    // Disable opencode
    const dis = runCli(['node', 'projectmind', 'plugin', 'disable', 'opencode', '--project-root', testDir, '--json']);
    assert.strictEqual(dis.exitCode, 0);

    // Enable opencode
    const ena = runCli(['node', 'projectmind', 'plugin', 'enable', 'opencode', '--project-root', testDir, '--json']);
    assert.strictEqual(ena.exitCode, 0);

    // Uninstall opencode
    const uninst = runCli(['node', 'projectmind', 'plugin', 'uninstall', 'opencode', '--project-root', testDir, '--json']);
    assert.strictEqual(uninst.exitCode, 0);
  });

  return { passed, failed, details };
}

