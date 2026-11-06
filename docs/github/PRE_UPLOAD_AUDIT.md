# ProjectMind Pre-Upload File & Security Audit

**Audit Date:** 2026-11-06  
**Auditor:** DevOps & Release Engineering  
**Target Repository:** `https://github.com/Rootx202/ProjectMind`  
**Working Directory:** `/home/kali/Desktop/My_tools/12_ai/projectmind`  

---

## 1. Executive Summary

A comprehensive recursive discovery and security audit of the `ProjectMind` codebase was performed prior to repository creation and publication. The codebase contains the core memory engine, MCP server, agent SDK, 9 agent adapters, canonical plugins, CLI and diagnostic tools, automated build scripts, and test suites.

All files and directories were inspected and classified into four categories:
1. **Essential**: Core application code, adapters, CLI tools, plugins, documentation, build tooling, and package configurations required for installation and operation.
2. **Development Only**: Test suites, development examples, generator scripts, and internal references.
3. **Unnecessary / Exclude**: Generated build artifacts (`dist/`, `dist-tests/`), runtime database files (`projectmind.db`), local backups, dependencies (`node_modules`), and machine-specific IDE/agent local configs.
4. **Sensitive**: Secrets, credentials, private keys, personal paths, or environment variables containing tokens.

---

## 2. Complete Inventory and Classification Table

| Directory / File Path | Purpose | Classification | Decision | Reason & Dependencies / Risks |
| :--- | :--- | :--- | :---: | :--- |
| `packages/core/src/*` | Core identity, project root detection, moved-project healing | Essential | **INCLUDE** | Critical runtime foundation. |
| `packages/storage/src/*` | SQLite3 + FTS5 schema, migrations, memory stores | Essential | **INCLUDE** | Essential 3-layer persistent memory store. |
| `packages/indexing/src/*` | 7-stage bootstrap indexing, symbol/route/model extraction | Essential | **INCLUDE** | Core codebase analysis and incremental sync. |
| `packages/impact-analysis/src/*`| Dependency graph, reverse dependents, impact scoring | Essential | **INCLUDE** | Core context filtering and blast-radius engine. |
| `packages/retrieval/src/*` | BM25 lexical search + local vector reranker | Essential | **INCLUDE** | Context retrieval engine. |
| `packages/context-engine/src/*` | Token budget management, task scope classification | Essential | **INCLUDE** | Prevents context window overflows for agents. |
| `packages/mcp-server/src/*` | JSON-RPC 2.0 MCP server exposing 22 tools | Essential | **INCLUDE** | Universal agent protocol endpoint. |
| `packages/agent-sdk/src/*` | Smart Auto Mode engine, lifecycle hook handler | Essential | **INCLUDE** | Autonomous agent integration SDK. |
| `packages/plugin-sdk/src/*` | Portable runtime resolver, config writer, registry | Essential | **INCLUDE** | Cross-platform plugin runtime without hardcoded paths. |
| `packages/shared/src/*` | Shared types, security filters, secret exclusion | Essential | **INCLUDE** | Universal types and security filters. |
| `packages/*/package.json` | Workspace package declarations | Essential | **INCLUDE** | Required for monorepo module resolution. |
| `adapters/*/src/*` (9 adapters) | Source code for Antigravity, Claude, Codex, Cursor, etc. | Essential | **INCLUDE** | Source implementations of all 9 agent adapters. |
| `adapters/*/package.json` | Adapter package declarations | Essential | **INCLUDE** | Required for monorepo packaging. |
| `apps/cli/src/*` | Main CLI (`projectmind`) implementation | Essential | **INCLUDE** | User-facing CLI application. |
| `apps/setup/src/*` | Plugin installer, uninstaller, updater, doctor | Essential | **INCLUDE** | Automated agent setup and verification engine. |
| `apps/diagnostics/src/*` | System diagnostics and health checker | Essential | **INCLUDE** | Validates SQLite, MCP, and runtime health. |
| `apps/*/package.json` | Application package declarations | Essential | **INCLUDE** | Required for monorepo package configuration. |
| `plugins/` (9 agent folders) | Canonical plugin packages, manifests, and documentation | Essential | **INCLUDE** | Official distributed agent plugin bundles. |
| `plugins/manifest.schema.json`| JSON Schema Draft-07 for plugin manifests | Essential | **INCLUDE** | Contract and validator for all plugin metadata. |
| `skills/projectmind/SKILL.md`| Canonical ProjectMind agent skill | Essential | **INCLUDE** | Universal agent skill definition. |
| `templates/default-config.json`| Default configuration template | Essential | **INCLUDE** | Initial workspace configuration template. |
| `install.sh` | Universal POSIX installer (Linux/macOS) | Essential | **INCLUDE** | Zero-dependency bash installer. |
| `install.ps1` | Universal Windows PowerShell installer | Essential | **INCLUDE** | Native Windows installer for PowerShell 5.1 & 7+. |
| `package.json` | Root monorepo workspace configuration | Essential | **INCLUDE** | Root package definitions, scripts, and dependencies. |
| `tsconfig.json` | TypeScript compiler configuration | Essential | **INCLUDE** | Root TypeScript configuration. |
| `README.md` | Comprehensive user guide and CLI reference | Essential | **INCLUDE** | Public repository entrypoint. |
| `INSTALL.md` | Cross-platform installation instructions | Essential | **INCLUDE** | User setup documentation. |
| `WINDOWS.md` | Windows-specific guide (PowerShell, paths) | Essential | **INCLUDE** | Windows user documentation. |
| `LINUX.md` | Linux-specific guide (systemd, XDG, ulimit) | Essential | **INCLUDE** | Linux user documentation. |
| `MARKETPLACE.md` | Agent marketplace and distribution guide | Essential | **INCLUDE** | Ecosystem integration documentation. |
| `PLUGIN_DEVELOPMENT.md` | Plugin SDK authoring and hook best practices | Essential | **INCLUDE** | Developer documentation. |
| `SECURITY.md` | Security architecture and secret exclusion | Essential | **INCLUDE** | Security policy and disclosure guide. |
| `TROUBLESHOOTING.md` | Diagnostics and recovery reference | Essential | **INCLUDE** | Troubleshooting documentation. |
| `RELEASE.md` | Release engineering and packaging checklists | Essential | **INCLUDE** | Release engineering guide. |
| `AGENTS.md`, `CLAUDE.md`, etc. | Top-level agent instructions for repo development | Essential | **INCLUDE** | Instructions for AI agents working in this repo. |
| `scripts/build.js` | TypeScript compilation & Babel bundler | Development | **INCLUDE** | Compiles all packages without heavy build chains. |
| `scripts/test.js` | Test runner executing all 50 unit tests | Development | **INCLUDE** | Executes complete test suite. |
| `scripts/package-plugins.js` | Generates `.tar.gz`, SHA256SUMS, and index.json | Development | **INCLUDE** | Packages release bundles for GitHub Releases. |
| `scripts/generate-plugin-manifests.js` | Manifest generator script | Development | **INCLUDE** | Tooling for updating manifests and hashes. |
| `tests/` (7 test suites) | Core, MCP, Adapters, Scenarios, Plugins, Runtime, Installer | Development | **INCLUDE** | 50 automated tests ensuring code quality. |
| `examples/sample-ts-app/src/*`| Sample TypeScript application for live testing | Development | **INCLUDE** | Useful contributor reference and fixture. |
| `node_modules/` | External runtime and build dependencies | Unnecessary | **EXCLUDE** | Downloadable via `npm install`; must not be tracked. |
| `dist/` & `*/dist/` | Compiled JavaScript build artifacts | Unnecessary | **EXCLUDE** | 100% reproducible via `node scripts/build.js`. |
| `dist-tests/` | Compiled test artifacts | Unnecessary | **EXCLUDE** | 100% reproducible via `node scripts/build.js`. |
| `.projectmind/` | Local SQLite database (`projectmind.db`) & backups | Local Runtime | **EXCLUDE** | Contains local binary databases and machine cache. |
| `examples/**/.projectmind/` | Local SQLite database for sample app | Local Runtime | **EXCLUDE** | Generated binary file; must be excluded. |
| `.agents/`, `.cursor/`, `.vscode/` | Workspace configurations with local `/home/kali/` paths | Local Config | **EXCLUDE** | Machine-specific paths created during local testing. |
| `.claude/`, `.gemini/`, `.codex/` | Workspace configurations with local `/home/kali/` paths | Local Config | **EXCLUDE** | Machine-specific paths created during local testing. |
| `.dsh/`, `.hermes/`, `.deepseek/` | Workspace configurations with local `/home/kali/` paths | Local Config | **EXCLUDE** | Machine-specific paths created during local testing. |
| `.mcp.json`, `opencode.json` | Workspace MCP configs with local `/home/kali/` paths | Local Config | **EXCLUDE** | Machine-specific paths created during local testing. |
| `*.tmp`, `*.bak`, `*.log` | Temporary files and backups | Temporary | **EXCLUDE** | Transient development artifacts. |

---

## 3. Sensitive Data & Security Audit Findings

* **API Keys & Credentials**: Scan revealed **ZERO** live API keys, secrets, or passwords. The only instances of strings like `sk-...` occur within `tests/core/core.test.ts` as simulated dummy fixtures strictly used to test the secret redaction filter.
* **Environment Files**: **ZERO** active `.env` files found in the repository.
* **Private Keys**: **ZERO** `.pem`, `.key`, or RSA/SSH key files found.
* **Machine-Specific Paths**:
  * Distributed source files, manifests (`plugins/*/manifest.json`), and hook generators are completely free of hardcoded paths.
  * Local workspace configurations created during development testing (`.agents/mcp_config.json`, `.cursor/mcp.json`, etc.) contain local absolute paths (`/home/kali/Desktop/My_tools/...`).
  * **Remediation**: Exclude all local dotfolder configs (`.agents/`, `.cursor/`, `.vscode/`, `.mcp.json`, etc.) via `.gitignore` to ensure users who clone the repository start with a clean state.

---

## 4. Proposed `.gitignore` Strategy

A comprehensive root `.gitignore` will be deployed to enforce clean source control without deleting local files from the developer's workstation:

```gitignore
# Dependencies
node_modules/

# Build and compilation outputs
dist/
dist-tests/
*.tsbuildinfo

# ProjectMind local runtime databases and session caches
.projectmind/
**/.projectmind/
projectmind.db
projectmind.db-wal
projectmind.db-shm
*.bak

# Local developer environment / editor configurations
.agents/
.claude/
.claude-plugin/
.codex/
.cursor/
.deepseek/
.dsh/
.gemini/
.hermes/
.opencode/
.vscode/
.mcp.json
opencode.json

# Environment variables & secrets
.env
.env.*
!.env.example
*.pem
*.key
id_rsa
id_ed25519

# Operating System files
.DS_Store
Thumbs.db

# Logs & Temporary files
logs/
*.log
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*
*.tmp
.cache/
```

