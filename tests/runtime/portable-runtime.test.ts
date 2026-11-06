import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RuntimeResolver,
  PortableHookRunner,
  ConfigWriter,
  getOsDirectoryLayout,
  detectPlatform
} from '@projectmind/plugin-sdk';

export function runPortableRuntimeTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;

  const check = (name: string, fn: () => void) => {
    try {
      fn();
      passed++;
      details.push(`PASS [Runtime] ${name}`);
    } catch (err) {
      failed++;
      details.push(`FAIL [Runtime] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-runtime-test-'));

  check('1. OS Directory Layout and Platform Detection', () => {
    const platform = detectPlatform();
    assert.ok(platform === 'linux' || platform === 'windows' || platform === 'darwin');
    const layout = getOsDirectoryLayout();
    assert.ok(layout.configDir.length > 0);
    assert.ok(layout.dataDir.length > 0);
    assert.ok(layout.cacheDir.length > 0);
  });

  check('2. RuntimeResolver finds runtime in repository checkout', () => {
    const runtime = RuntimeResolver.resolveRuntime();
    assert.ok(runtime.homeDir.length > 0);
    assert.ok(fs.existsSync(runtime.sdkEntryPath), `SDK path must exist: ${runtime.sdkEntryPath}`);
    assert.ok(fs.existsSync(runtime.mcpServerCliPath), `MCP CLI path must exist: ${runtime.mcpServerCliPath}`);
    assert.ok(runtime.source === 'repo_checkout' || runtime.source === 'node_module_resolution');
  });

  check('3. RuntimeResolver prioritizes explicit PROJECTMIND_HOME', () => {
    const fakeHome = path.join(tmpRoot, 'fake-pm-home');
    const fakeSdk = path.join(fakeHome, 'packages', 'agent-sdk', 'dist', 'index.js');
    const fakeMcp = path.join(fakeHome, 'packages', 'mcp-server', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(fakeSdk), { recursive: true });
    fs.mkdirSync(path.dirname(fakeMcp), { recursive: true });
    fs.writeFileSync(fakeSdk, '// fake sdk');
    fs.writeFileSync(fakeMcp, '// fake mcp');

    const originalEnv = process.env.PROJECTMIND_HOME;
    try {
      process.env.PROJECTMIND_HOME = fakeHome;
      const rt = RuntimeResolver.resolveRuntime();
      assert.strictEqual(rt.source, 'env_projectmind_home');
      assert.strictEqual(path.resolve(rt.homeDir), path.resolve(fakeHome));
      assert.strictEqual(path.resolve(rt.sdkEntryPath), path.resolve(fakeSdk));
    } finally {
      if (originalEnv) {
        process.env.PROJECTMIND_HOME = originalEnv;
      } else {
        delete process.env.PROJECTMIND_HOME;
      }
    }
  });

  check('4. Target project root resolution supports spaces and Unicode safely', () => {
    const projectWithSpaces = path.join(tmpRoot, 'My AI Project 2026');
    const projectWithUnicode = path.join(tmpRoot, 'مشروع_الذكاء_المشترك');
    fs.mkdirSync(projectWithSpaces, { recursive: true });
    fs.mkdirSync(projectWithUnicode, { recursive: true });

    const resSpaces = RuntimeResolver.resolveTargetProjectRoot({ explicitRoot: projectWithSpaces });
    assert.strictEqual(path.resolve(resSpaces), path.resolve(projectWithSpaces));

    const resUnicode = RuntimeResolver.resolveTargetProjectRoot({ explicitRoot: projectWithUnicode });
    assert.strictEqual(path.resolve(resUnicode), path.resolve(projectWithUnicode));
  });

  check('5. Target project root guards against accidental self-initialization', () => {
    const outsideDir = path.join(tmpRoot, 'external-app');
    fs.mkdirSync(outsideDir, { recursive: true });

    // When caller CWD is an external directory, target should not accidentally default to projectmind repo
    const resolved = RuntimeResolver.resolveTargetProjectRoot({ cwd: outsideDir });
    assert.strictEqual(path.resolve(resolved), path.resolve(outsideDir));
  });

  check('6. Portable hook runner script generation has zero hardcoded machine paths', () => {
    const script = PortableHookRunner.generatePortableHookScript('opencode');
    assert.ok(script.length > 0);
    assert.ok(script.includes("require('@projectmind/agent-sdk')") || script.includes('RuntimeResolver') || script.includes('resolveTargetProjectRoot'));

    const forbidden = ['/home/kali', '/Users/', 'C:\\Users\\', '/Desktop/My_tools', '/06_Websites/cybernex'];
    for (const f of forbidden) {
      assert.ok(!script.includes(f), `Portable hook script must not contain ${f}`);
    }
  });

  check('7. ConfigWriter updates JSON while strictly preserving unrelated properties', () => {
    const testJson = path.join(tmpRoot, 'config-test.json');
    fs.writeFileSync(
      testJson,
      JSON.stringify(
        {
          existingCustomSetting: { timeoutMs: 9999, theme: 'dark' },
          otherMcpServers: { myServer: { command: 'node', args: ['server.js'] } }
        },
        null,
        2
      )
    );

    ConfigWriter.updateJsonPreservingUnrelated(testJson, (curr: any) => {
      curr.projectMindConfig = { active: true, version: '1.0.0' };
      return curr;
    });

    const updated = JSON.parse(fs.readFileSync(testJson, 'utf8'));
    assert.strictEqual(updated.existingCustomSetting.timeoutMs, 9999);
    assert.strictEqual(updated.existingCustomSetting.theme, 'dark');
    assert.ok(updated.otherMcpServers.myServer);
    assert.strictEqual(updated.projectMindConfig.active, true);
  });

  check('8. ConfigWriter managed section upsert, backup, and removal', () => {
    const testDoc = path.join(tmpRoot, 'RULES.md');
    fs.writeFileSync(testDoc, '# User Guidelines\n\n- Existing rule 1\n- Existing rule 2\n');

    ConfigWriter.backupFile(tmpRoot, testDoc);

    const startMarker = '<!-- PROJECTMIND:START -->';
    const endMarker = '<!-- PROJECTMIND:END -->';
    const block = `${startMarker}\n## ProjectMind Instructions\nCall get_relevant_context before coding.\n${endMarker}`;

    ConfigWriter.upsertManagedSectionAtomic(testDoc, startMarker, endMarker, block);

    let content = fs.readFileSync(testDoc, 'utf8');
    assert.ok(content.includes('<!-- PROJECTMIND:START -->'));
    assert.ok(content.includes('## ProjectMind Instructions'));
    assert.ok(content.includes('<!-- PROJECTMIND:END -->'));
    assert.ok(content.includes('- Existing rule 1'));

    // Remove section
    ConfigWriter.removeManagedSectionAtomic(testDoc, startMarker, endMarker);
    content = fs.readFileSync(testDoc, 'utf8');
    assert.ok(!content.includes('<!-- PROJECTMIND:START -->'));
    assert.ok(content.includes('- Existing rule 1'));

    // Restore from backup
    const restored = ConfigWriter.restoreLatestBackup(tmpRoot, testDoc);
    assert.ok(restored);
  });

  return { passed, failed, details };
}
