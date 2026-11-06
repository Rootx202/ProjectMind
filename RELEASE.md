# ProjectMind Release Engineering & Distribution Guide

This document details the release engineering, automated packaging, checksum verification, and publishing workflows for ProjectMind and its 9 agent plugins.

---

## 1. Release Architecture & Versioning

ProjectMind follows [Semantic Versioning (SemVer 2.0.0)](https://semver.org/):
* **MAJOR (`1.x.x`)**: Breaking changes to MCP schemas, database schema migrations without backward compatibility, or breaking CLI changes.
* **MINOR (`x.1.x`)**: New agent integrations, new MCP tools, new capabilities, or backward-compatible performance enhancements.
* **PATCH (`x.x.1`)**: Bug fixes, documentation updates, security patches, or adapter hook adjustments.

---

## 2. Pre-Release Quality Checklist

Before tagging or cutting any release, execute the following verification steps:

- [ ] **TypeScript Monorepo Compilation**:
  ```bash
  node scripts/build.js
  ```
  *Verify that all packages, adapters, apps, and tests compile with zero errors.*

- [ ] **Full Automated Test Suite Execution**:
  ```bash
  node scripts/test.js
  ```
  *Ensure all 89 checks pass across Core, MCP, Adapters, Scenarios, Plugins, Runtime, Installer, Updater, Memory, Indexing, and Retrieval suites.*

- [ ] **Zero Hardcoded Developer Paths Check**:
  *Automated by `tests/plugins/plugins.test.ts` (ensures zero occurrences of `/home/kali`, `/Users/`, `C:\Users\`, etc.).*

- [ ] **Manifest Schema Validation**:
  *Automated by `tests/plugins/plugins.test.ts` against `plugins/manifest.schema.json`.*

- [ ] **Retrieval & Freshness Benchmark**:
  ```bash
  node scripts/benchmark.js
  ```
  *Fails if a stale cache entry is served, the event chain is broken, or Recall@5 drops below 0.85.*

- [ ] **Clean-room reproducibility**:
  ```bash
  npm run release:package
  # extract the produced archive in a temp dir, then: npm ci && npm run build && npm test && npm run benchmark
  ```

- [ ] **POSIX & Windows Installer Dry-Runs**:
  ```bash
  ./install.sh --dry-run
  ```

---

## 3. Automated Packaging

Run the packaging script to generate production release bundles:

```bash
npm run release:package
```

This script:
1. Builds `.release/projectmind-full.tar.gz` from tracked source, excluding
   `node_modules`, `dist`, `.git`, `.projectmind`, backups, caches, and secrets.
2. Iterates over all 9 plugins in `plugins/<agent-id>` and creates
   `.release/plugins/<agent-id>-<version>.tar.gz` containing a `manifest.json`
   that lists every file with its SHA-256, plus instruction/skill assets.
3. Computes SHA-256 digests for every artifact and writes `.release/SHA256SUMS`
   with repo-relative paths.
4. Generates `.release/index.json` containing plugin download URLs (tag-pinned),
   checksums, and `minEngineVersion`.
5. Writes `.release/release-manifest.json` and **re-extracts every archive** to
   verify structure, ids/versions, declared file hashes, and forbidden paths.
   Packaging fails if any verification fails.

---

## 4. GitHub Release Publishing Workflow

1. **Tag the Release**:
   ```bash
   git tag -a v1.1.0 -m "Release v1.1.0: Snapshot-bound context, verified updates, AST code graph, append-only memory"
   git push origin v1.1.0
   ```

2. **Publish Release Assets**:
   Create a new GitHub Release for tag `v1.1.0` and attach everything in
   `.release/`:
   * `projectmind-full.tar.gz`
   * `plugins/*.tar.gz` (all 9 plugin packages)
   * `SHA256SUMS`
   * `index.json`
   * `release-manifest.json`

   Release assets are uploaded with their repo-relative names preserved where
   possible; the updater also accepts basename lookups in `SHA256SUMS`.

3. **Verify Published Release**:
   Test remote curl installation against the published release:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Rootx202/ProjectMind/v1.1.0/install.sh | bash -s -- --dry-run
   ```

---

## 5. Checksum Verification Procedure

To verify package integrity against tampering:

```bash
# On Linux / macOS
cd .release
sha256sum -c SHA256SUMS

# On Windows PowerShell
cd .release
Get-Content SHA256SUMS | ForEach-Object {
    $expectedHash, $filename = $_ -split '\s+'
    $actualHash = (Get-FileHash $filename -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -eq $expectedHash.ToLower()) {
        Write-Host "✓ $filename matches" -ForegroundColor Green
    } else {
        Write-Error "✗ Hash mismatch for $filename!"
    }
}
```

