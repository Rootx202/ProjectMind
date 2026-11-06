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
  *Ensure all 50 tests pass across Core, MCP, Adapters, Scenarios, Plugins, Runtime, and Installer suites.*

- [ ] **Zero Hardcoded Developer Paths Check**:
  *Automated by `tests/plugins/plugins.test.ts` (ensures zero occurrences of `/home/kali`, `/Users/`, `C:\Users\`, etc.).*

- [ ] **Manifest Schema Validation**:
  *Automated by `tests/plugins/plugins.test.ts` against `plugins/manifest.schema.json`.*

- [ ] **POSIX & Windows Installer Dry-Runs**:
  ```bash
  ./install.sh --dry-run
  ```

---

## 3. Automated Packaging

Run the packaging script to generate production release bundles:

```bash
node scripts/package-plugins.js
```

This script:
1. Iterates over all 9 plugins in `plugins/<agent-id>`.
2. Packages each plugin into `dist/plugins/<agent-id>-<version>.tar.gz`.
3. Computes cryptographic SHA-256 digests for all packages.
4. Generates `dist/plugins/SHA256SUMS`.
5. Generates `dist/plugins/index.json` containing complete manifest metadata and checksums.

---

## 4. GitHub Release Publishing Workflow

1. **Tag the Release**:
   ```bash
   git tag -a v1.0.0 -m "Release v1.0.0: Production-Ready Cross-Platform Plugin & Installation System"
   git push origin v1.0.0
   ```

2. **Publish Release Assets**:
   Create a new GitHub Release for tag `v1.0.0` and attach:
   * `dist/plugins/*.tar.gz` (all 9 plugin packages)
   * `dist/plugins/SHA256SUMS`
   * `dist/plugins/index.json`
   * `install.sh`
   * `install.ps1`

3. **Verify Published Release**:
   Test remote curl installation against the published release:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/projectmind/projectmind/v1.0.0/install.sh | bash -s -- --dry-run
   ```

---

## 5. Checksum Verification Procedure

To verify package integrity against tampering:

```bash
# On Linux / macOS
cd dist/plugins
sha256sum -c SHA256SUMS

# On Windows PowerShell
cd dist\plugins
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

