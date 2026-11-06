#!/usr/bin/env node
/**
 * Builds verifiable ProjectMind release artifacts:
 *   .release/projectmind-full.tar.gz
 *   .release/plugins/<agent>-<version>.tar.gz
 *   .release/index.json
 *   .release/SHA256SUMS
 *   .release/release-manifest.json
 *
 * Every plugin bundle contains a manifest listing every file with its SHA-256.
 * The script then re-extracts the produced archives and re-verifies them, so a
 * broken package fails the build instead of being published.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, '.release');
const { createTarGz, extractTarGz } = require(path.join(ROOT, 'packages/plugin-sdk/dist/tar'));
const { CONCISE_INSTRUCTION_SNIPPET, CONCISE_SKILL_CONTENT } = require(path.join(ROOT, 'packages/agent-sdk/dist'));

const REPO = 'Rootx202/ProjectMind';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const SOURCE_DATE_EPOCH = Number(process.env.SOURCE_DATE_EPOCH || 0);
const PUBLISHED_AT = Number.isFinite(SOURCE_DATE_EPOCH) && SOURCE_DATE_EPOCH > 0
  ? new Date(SOURCE_DATE_EPOCH * 1000).toISOString()
  : new Date().toISOString();

const EXCLUDED_SEGMENTS = new Set([
  'node_modules', '.git', '.projectmind', '.backups', '.npm-cache', '.release',
  'dist', 'dist-tests', '.agents', '.claude', '.codex', '.cursor', '.gemini',
  '.deepseek', '.dsh', '.hermes', '.opencode', '.vscode', 'coverage'
]);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const EXCLUDED_SUFFIXES = ['.log', '.db', '.db-wal', '.db-shm', '.bak', '.tsbuildinfo'];

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function shouldExclude(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => EXCLUDED_SEGMENTS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (EXCLUDED_FILES.has(base)) return true;
  if (EXCLUDED_SUFFIXES.some((s) => base.endsWith(s))) return true;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  return false;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (shouldExclude(rel)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function writeAsset(name, buffer) {
  const target = path.join(RELEASE_DIR, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { name, size: buffer.length, sha256: sha256(buffer) };
}

function buildCoreArchive() {
  const files = walk(ROOT).sort();
  const entries = files.map((rel) => ({
    path: rel,
    content: fs.readFileSync(path.join(ROOT, rel)),
    mode: rel.endsWith('.sh') ? 0o755 : 0o644
  }));
  return { buffer: createTarGz(entries), files };
}

function buildPluginBundles() {
  const pluginsDir = path.join(ROOT, 'plugins');
  const bundles = [];
  for (const dir of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const id = dir.name;
    const pluginManifestPath = path.join(pluginsDir, id, 'manifest.json');
    if (!fs.existsSync(pluginManifestPath)) continue;
    const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
    const readmePath = path.join(pluginsDir, id, 'README.md');
    const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : `# ProjectMind ${id}\n`;

    const instructions = `${CONCISE_INSTRUCTION_SNIPPET}\n<!-- ProjectMind plugin ${id} v${VERSION} -->\n`;
    const skill = `${CONCISE_SKILL_CONTENT}\n<!-- ProjectMind plugin ${id} v${VERSION} -->\n`;

    const entries = [
      { path: 'README.md', content: readme },
      { path: 'assets/instructions.md', content: instructions },
      { path: 'assets/SKILL.md', content: skill },
      { path: 'assets/plugin-manifest.json', content: JSON.stringify(pluginManifest, null, 2) + '\n' }
    ];
    const manifest = {
      id,
      name: pluginManifest.name || id,
      version: VERSION,
      engineVersion: VERSION,
      minEngineVersion: '1.1.0',
      description: pluginManifest.description || '',
      publishedAt: PUBLISHED_AT,
      assets: { instructions: 'assets/instructions.md', skill: 'assets/SKILL.md' },
      files: entries.map((e) => ({ path: e.path, sha256: sha256(Buffer.from(e.content)) }))
    };
    const allEntries = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' }, ...entries];
    const buffer = createTarGz(allEntries);
    const asset = writeAsset(`${id}-${VERSION}.tar.gz`, buffer);
    bundles.push({ id, buffer, asset, manifest, pluginManifest });
  }
  return bundles;
}

function verifyCore(archive, expectedVersion) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-release-core-'));
  try {
    const result = extractTarGz(archive, tmp);
    const stagePkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    if (stagePkg.name !== 'projectmind') throw new Error('core archive package name mismatch');
    if (String(stagePkg.version) !== expectedVersion) throw new Error(`core archive version mismatch: ${stagePkg.version}`);
    for (const required of ['LICENSE', 'README.md', 'scripts/build.js', 'packages/shared/src/index.ts', 'apps/cli/src/index.ts', 'package-lock.json']) {
      if (!fs.existsSync(path.join(tmp, required))) throw new Error(`core archive missing ${required}`);
    }
    for (const forbidden of ['.projectmind', 'node_modules', '.git']) {
      if (fs.existsSync(path.join(tmp, forbidden))) throw new Error(`core archive contains forbidden path ${forbidden}`);
    }
    return { files: result.files.length, bytes: result.totalBytes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function verifyPluginBundle(bundle) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-release-plugin-'));
  try {
    const result = extractTarGz(bundle.buffer, tmp);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    if (manifest.id !== bundle.id) throw new Error(`bundle id mismatch for ${bundle.id}`);
    if (String(manifest.version) !== VERSION) throw new Error(`bundle version mismatch for ${bundle.id}`);
    const declared = new Set((manifest.files || []).map((f) => f.path));
    for (const file of manifest.files) {
      const actual = sha256(fs.readFileSync(path.join(tmp, file.path)));
      if (actual !== file.sha256) throw new Error(`bundle file hash mismatch: ${bundle.id}/${file.path}`);
    }
    for (const file of result.files) {
      if (file === 'manifest.json') continue;
      if (!declared.has(file)) throw new Error(`undeclared plugin file: ${bundle.id}/${file}`);
    }
    return { files: result.files.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  const core = buildCoreArchive();
  const coreAsset = writeAsset('projectmind-full.tar.gz', core.buffer);
  const bundles = buildPluginBundles();

  const plugins = {};
  const checksums = {};
  checksums[coreAsset.name] = coreAsset.sha256;
  for (const bundle of bundles) {
    const downloadUrl = `https://github.com/${REPO}/releases/download/${TAG}/${bundle.asset.name.split('/').pop()}`;
    checksums[bundle.asset.name.split('/').pop()] = bundle.asset.sha256;
    plugins[bundle.id] = {
      id: bundle.id,
      name: bundle.pluginManifest.name || bundle.id,
      version: VERSION,
      description: bundle.pluginManifest.description || '',
      downloadUrl,
      sha256: bundle.asset.sha256,
      minEngineVersion: '1.1.0',
      supportedPlatforms: bundle.pluginManifest.supportedPlatforms || ['linux', 'windows', 'darwin']
    };
  }

  const indexJson = {
    engineVersion: VERSION,
    publishedAt: PUBLISHED_AT,
    changelog: 'ProjectMind v1.1.0: snapshot-bound context, secure verified updates, AST code graph, append-only memory events, temporal memory, and shared-agent namespaces.',
    plugins,
    checksums
  };
  const indexAsset = writeAsset('index.json', Buffer.from(JSON.stringify(indexJson, null, 2) + '\n'));

  const assets = [coreAsset, ...bundles.map((b) => b.asset), indexAsset];
  const sums = assets.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n';
  const sumsAsset = writeAsset('SHA256SUMS', Buffer.from(sums));

  const releaseManifest = {
    name: 'projectmind',
    version: VERSION,
    tag: TAG,
    repository: `https://github.com/${REPO}`,
    generatedAt: PUBLISHED_AT,
    assets: assets.map((a) => ({ name: a.name.split('/').pop(), path: a.name, size: a.size, sha256: a.sha256 }))
  };
  writeAsset('release-manifest.json', Buffer.from(JSON.stringify(releaseManifest, null, 2) + '\n'));

  // Re-verify what we just built.
  const coreVerification = verifyCore(core.buffer, VERSION);
  const pluginVerification = bundles.map((b) => ({ id: b.id, ...verifyPluginBundle(b) }));
  const sumsText = fs.readFileSync(path.join(RELEASE_DIR, 'SHA256SUMS'), 'utf8');
  for (const asset of assets) {
    if (!sumsText.includes(`${asset.sha256}  ${asset.name}`)) throw new Error(`SHA256SUMS is missing ${asset.name}`);
  }
  if (!fs.existsSync(path.join(RELEASE_DIR, sumsAsset.name))) throw new Error('SHA256SUMS missing');

  console.log(JSON.stringify({
    version: VERSION,
    tag: TAG,
    core: { ...coreAsset, extractedFiles: coreVerification.files, extractedBytes: coreVerification.bytes },
    plugins: pluginVerification,
    assets: assets.map((a) => a.name),
    releaseDir: RELEASE_DIR
  }, null, 2));
  console.log(`\nRELEASE PACKAGE OK — ${assets.length} assets, ${bundles.length} plugin bundles.`);
}

try {
  main();
} catch (err) {
  console.error(`RELEASE PACKAGING FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}
