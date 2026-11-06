import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PluginRegistry, ManifestValidator, PluginManifest } from '@projectmind/plugin-sdk';

const EXPECTED_AGENTS = [
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

export function runPluginsTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let failed = 0;

  const check = (name: string, fn: () => void) => {
    try {
      fn();
      passed++;
      details.push(`PASS [Plugins] ${name}`);
    } catch (err) {
      failed++;
      details.push(`FAIL [Plugins] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const pluginsDir = path.resolve(__dirname, '..', '..', 'plugins');
  const schemaPath = path.join(pluginsDir, 'manifest.schema.json');

  check('1. Schema file exists and is valid JSON Schema', () => {
    assert.ok(fs.existsSync(schemaPath), 'manifest.schema.json should exist');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.strictEqual(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.ok(schema.properties.id);
    assert.ok(schema.properties.capabilities);
  });

  check('2. Exactly 9 plugin directories exist with manifest.json and README.md', () => {
    for (const agentId of EXPECTED_AGENTS) {
      const agentDir = path.join(pluginsDir, agentId);
      assert.ok(fs.existsSync(agentDir), `Directory for ${agentId} should exist`);
      const manifestPath = path.join(agentDir, 'manifest.json');
      const readmePath = path.join(agentDir, 'README.md');
      assert.ok(fs.existsSync(manifestPath), `manifest.json should exist for ${agentId}`);
      assert.ok(fs.existsSync(readmePath), `README.md should exist for ${agentId}`);
    }
  });

  check('3. All 9 plugin manifests validate cleanly against ManifestValidator', () => {
    for (const agentId of EXPECTED_AGENTS) {
      const manifestPath = path.join(pluginsDir, agentId, 'manifest.json');
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as PluginManifest;

      const res = ManifestValidator.validate(manifest);
      assert.strictEqual(
        res.valid,
        true,
        `Manifest for ${agentId} should be valid: ${res.errors.join(', ')}`
      );
      assert.strictEqual(manifest.id, agentId);
      assert.ok(manifest.name.length > 0);
      assert.ok(manifest.version.length > 0);
      assert.ok(manifest.description.length > 0);
      assert.ok(manifest.publisher.name.includes('Rootx202') || manifest.publisher.name.includes('ProjectMind'));
      assert.ok(Array.isArray(manifest.supportedPlatforms));
      assert.ok(manifest.supportedPlatforms.includes('linux'));
      assert.ok(manifest.supportedPlatforms.includes('windows'));
      assert.ok(typeof manifest.capabilities.mcpServer === 'boolean');
      assert.ok(manifest.integrity && manifest.integrity.hash);
    }
  });

  check('4. Zero hardcoded machine/developer paths in any manifest or README', () => {
    const forbiddenPatterns = [
      '/home/kali',
      '/Users/',
      'C:\\Users\\',
      '/Desktop/My_tools',
      '/06_Websites/cybernex'
    ];

    for (const agentId of EXPECTED_AGENTS) {
      const agentDir = path.join(pluginsDir, agentId);
      for (const file of ['manifest.json', 'README.md']) {
        const filePath = path.join(agentDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        for (const forbidden of forbiddenPatterns) {
          assert.ok(
            !content.includes(forbidden),
            `File ${filePath} must not contain hardcoded path "${forbidden}"`
          );
        }
      }
    }
  });

  check('5. PluginRegistry discovers all manifests and supports search', () => {
    const all = PluginRegistry.getAllManifests();
    assert.strictEqual(all.length, 9, 'Should load all 9 manifests');

    const opencodeManifest = PluginRegistry.loadManifest('opencode');
    assert.ok(opencodeManifest);
    assert.strictEqual(opencodeManifest?.id, 'opencode');

    const searchResults = PluginRegistry.search('hermes');
    assert.ok(searchResults.length >= 1);
    assert.strictEqual(searchResults[0].id, 'hermes-agent');

    const searchMcp = PluginRegistry.search('mcp');
    assert.strictEqual(searchMcp.length, 9, 'All 9 plugins support MCP');
  });

  return { passed, failed, details };
}
