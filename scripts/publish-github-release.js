#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

const REPO = 'Rootx202/ProjectMind';
const TAG = 'v1.1.0';
const RELEASE_DIR = path.resolve(__dirname, '..', '.release');

function request(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'ProjectMind-Release-Publisher',
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        ...(options.headers || {})
      }
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            resolve(text);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        }
      });
    });

    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function uploadAsset(uploadUrlTemplate, filePath) {
  const fileName = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);
  const cleanUploadUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
  
  console.log(`Uploading ${fileName} (${fileData.length} bytes)...`);
  
  return new Promise((resolve, reject) => {
    const u = new URL(cleanUploadUrl);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'ProjectMind-Release-Publisher',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': fileName.endsWith('.tar.gz') ? 'application/gzip' : 'application/octet-stream',
        'Content-Length': fileData.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`  ✓ Uploaded ${fileName}`);
          resolve(JSON.parse(text));
        } else {
          reject(new Error(`Failed to upload ${fileName}: HTTP ${res.statusCode} ${text}`));
        }
      });
    });

    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}

async function main() {
  console.log(`Checking existing releases for ${REPO}...`);
  let release;
  try {
    release = await request(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
    console.log(`Found existing release for ${TAG} (id: ${release.id})`);
  } catch (err) {
    console.log(`Creating new release for ${TAG}...`);
    const releaseBody = `## ProjectMind v1.1.0 — Architecture Hardening & High-Confidence Memory

ProjectMind v1.1.0 delivers critical enterprise and production guarantees across context freshness, update integrity, code indexing, and multi-agent memory persistence.

### Key Highlights
- **100% Passing Automated Tests**: 93 automated tests passing (0 failures), covering clean-room build, multi-agent memory events, installer pipe/local execution, and updater security.
- **Snapshot-Bound Fresh Context (P0.1)**: Freshness is evaluated *before* cache lookup; outdated context is never returned silently.
- **Verified Package Updates & Cryptographic Checksum Enforcement (P0.2 & P0.3)**: SHA-256 is strictly enforced for all remote updates. Downloaded bundles are verified and staged before atomic activation with full rollback protection.
- **TypeScript/JavaScript AST & Path Resolver (P1.1 & P1.2)**: Streaming full-file hashing guarantees changes at file tails are never missed. AST structural parser extracts interfaces, types, multi-line exports, and tsconfig path aliases.
- **Append-Only Memory Events & Concurrency (P2)**: Schema v4 introduces immutable \`memory_events\` with cryptographic hash-chaining, actor tracking, and optimistic concurrency.
- **Explainable Hybrid Retrieval & Stored Embeddings (P3)**: Pre-indexed vector embeddings stored in SQLite with bi-temporal validity filtering and transparent retrieval reasons.

### Distribution Artifacts & Checksums
All official release artifacts are listed in \`SHA256SUMS\` and \`release-manifest.json\`.
`;

    release = await request(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: 'ProjectMind v1.1.0',
      body: releaseBody,
      draft: false,
      prerelease: false
    }));
    console.log(`Created release id: ${release.id}`);
  }

  const existingAssets = release.assets || [];
  const assetMap = new Map(existingAssets.map((a) => [a.name, a.id]));

  const filesToUpload = fs.readdirSync(RELEASE_DIR);
  for (const file of filesToUpload) {
    const fullPath = path.join(RELEASE_DIR, file);
    if (!fs.statSync(fullPath).isFile()) continue;

    if (assetMap.has(file)) {
      const assetId = assetMap.get(file);
      console.log(`Replacing existing asset ${file} (id: ${assetId})...`);
      try {
        await request(`https://api.github.com/repos/${REPO}/releases/assets/${assetId}`, {
          method: 'DELETE'
        });
        console.log(`  ✓ Deleted previous ${file}`);
      } catch (err) {
        console.warn(`  Warning: failed to delete previous ${file}: ${err.message}`);
      }
    }
    await uploadAsset(release.upload_url, fullPath);
  }

  console.log(`\nAll release assets uploaded successfully to ${release.html_url}`);
}

main().catch((err) => {
  console.error('Release publication failed:', err);
  process.exit(1);
});

