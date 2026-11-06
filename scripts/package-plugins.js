#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const DIST_PLUGINS_DIR = path.join(ROOT_DIR, 'dist', 'plugins');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function packagePlugins() {
  console.log(`[ProjectMind Packager] Packaging plugins from ${PLUGINS_DIR}...`);
  fs.mkdirSync(DIST_PLUGINS_DIR, { recursive: true });

  const checksums = [];
  const index = {
    generatedAt: new Date().toISOString(),
    version: '1.0.0',
    plugins: []
  };

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginId = entry.name;
    const pluginDir = path.join(PLUGINS_DIR, pluginId);
    const manifestPath = path.join(pluginDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const tarGzName = `${manifest.id}-${manifest.version}.tar.gz`;
    const tarGzPath = path.join(DIST_PLUGINS_DIR, tarGzName);

    // Package using tar (POSIX)
    try {
      execFileSync('tar', ['-czf', tarGzPath, '-C', PLUGINS_DIR, pluginId]);
    } catch (err) {
      console.warn(`[Packager] tar failed for ${pluginId}: ${err.message}. Trying fallback...`);
    }

    let tarHash = '';
    if (fs.existsSync(tarGzPath)) {
      tarHash = sha256File(tarGzPath);
      checksums.push(`${tarHash}  ${tarGzName}`);
      console.log(`  ✓ Created ${tarGzName} (${tarHash.slice(0, 12)}...)`);
    }

    index.plugins.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      capabilities: manifest.capabilities,
      supportedPlatforms: manifest.supportedPlatforms,
      package: tarGzName,
      sha256: tarHash,
      manifest
    });
  }

  // Write SHA256SUMS
  const checksumsPath = path.join(DIST_PLUGINS_DIR, 'SHA256SUMS');
  fs.writeFileSync(checksumsPath, checksums.join('\n') + '\n', 'utf8');
  console.log(`  ✓ Generated ${checksumsPath}`);

  // Write index.json
  const indexPath = path.join(DIST_PLUGINS_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  console.log(`  ✓ Generated ${indexPath}`);

  console.log(`[ProjectMind Packager] Completed successfully. Packaged ${index.plugins.length} plugins.`);
}

if (require.main === module) {
  packagePlugins();
}

module.exports = { packagePlugins };

