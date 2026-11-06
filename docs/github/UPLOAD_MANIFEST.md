# ProjectMind Upload Manifest

**Upload Date:** 2026-11-06  
**Repository:** `https://github.com/Rootx202/ProjectMind`  
**Target Branch:** `main`  
**Total Tracked Files:** 122  

---

## 1. Included Directories & Structure

```text
ProjectMind/
├── .github/
│   ├── workflows/ci.yml             # GitHub Actions CI matrix (Linux/Windows/macOS, Node 18/20/22)
│   ├── copilot-instructions.md      # Copilot instructions
│   └── prompts/                     # Prompt templates
├── adapters/                        # Source implementations for all 9 agent adapters
│   ├── antigravity/
│   ├── claude-code/
│   ├── codex/
│   ├── cursor/
│   ├── deepseek-harness/
│   ├── gemini-cli/
│   ├── github-copilot/
│   ├── hermes-agent/
│   └── opencode/
├── apps/
│   ├── cli/                         # `projectmind` CLI binary
│   ├── setup/                       # SetupManager & lifecycle adapter engine
│   └── diagnostics/                 # System health and doctor engine
├── packages/
│   ├── agent-sdk/                   # Smart Auto Mode engine & hook handlers
│   ├── context-engine/              # Token budgeting & scope retrieval
│   ├── core/                        # Project root detection & identity
│   ├── impact-analysis/             # Dependency graph & impact scoring
│   ├── indexing/                    # 7-stage bootstrap & incremental indexing
│   ├── knowledge/                   # Knowledge models, verification status & ADRs
│   ├── mcp-server/                  # JSON-RPC 2.0 MCP server (22 tools)
│   ├── plugin-sdk/                  # Portable runtime resolver & atomic config writer
│   ├── retrieval/                   # BM25 + local vector semantic reranker
│   ├── shared/                      # Security filters & secret exclusions
│   └── storage/                     # SQLite3 + FTS5 persistent memory
├── plugins/                         # Canonical plugin bundles and manifests
│   ├── manifest.schema.json         # Draft-07 JSON Schema validator
│   ├── antigravity/
│   ├── claude-code/
│   ├── codex/
│   ├── cursor/
│   ├── deepseek-harness/
│   ├── gemini-cli/
│   ├── github-copilot/
│   ├── hermes-agent/
│   └── opencode/
├── skills/
│   └── projectmind/SKILL.md         # Canonical ProjectMind skill
├── templates/
│   └── default-config.json          # Default configuration template
├── tests/                           # 7 automated test suites (50 unit & scenario tests)
│   ├── adapters/
│   ├── core/
│   ├── installer/
│   ├── mcp/
│   ├── plugins/
│   ├── runtime/
│   └── scenarios/
├── scripts/
│   ├── build.js                     # Babel TypeScript compiler
│   ├── test.js                      # Test runner
│   ├── package-plugins.js           # Automated .tar.gz packager and checksum generator
│   └── generate-plugin-manifests.js # Manifest generator
├── examples/
│   └── sample-ts-app/               # Sample multi-module TypeScript application
└── docs/
    ├── ARCHITECTURE.md
    └── github/
        ├── PRE_UPLOAD_AUDIT.md
        └── UPLOAD_MANIFEST.md
```

---

## 2. Key Included Root Files

* `README.md`: Public architectural guide and CLI quickstart.
* `INSTALL.md`: Cross-platform installation guide (Linux/macOS/Windows/air-gapped).
* `WINDOWS.md`: Windows-specific guide (PowerShell, execution policies, drive letters, spaces, Unicode).
* `LINUX.md`: Linux-specific guide (systemd, XDG, ulimit, permissions).
* `MARKETPLACE.md`: Ecosystem and plugin packaging specification.
* `PLUGIN_DEVELOPMENT.md`: Guide for creating and extending agent adapters.
* `SECURITY.md`: Security architecture, local-first guarantees, secret exclusions.
* `TROUBLESHOOTING.md`: Diagnostic workflows and common issue resolutions.
* `RELEASE.md`: Release engineering checklists and checksum verification.
* `LICENSE`: MIT License (Rootx202, 2026).
* `CONTRIBUTING.md`: Contributor workflow and standards.
* `CHANGELOG.md`: Release notes for v1.0.0.
* `.gitignore`: Enforces exclusion of dependencies, build outputs, and local runtime databases.
* `.env.example`: Optional environment configuration reference.
* `install.sh`: Universal POSIX installer.
* `install.ps1`: Universal PowerShell installer for Windows.
* `package.json`: Root workspace declaration and scripts.
* `tsconfig.json`: TypeScript configuration.
* `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `DEEPSEEK.md`, `HERMES.md`: AI coding agent instructions.

---

## 3. Excluded Directories and Files

| Excluded Item | Reason for Exclusion |
| :--- | :--- |
| `node_modules/` | External dependencies; restored via `npm install`. |
| `dist/` & `*/dist/` | Compiled JavaScript; 100% reproducible via `node scripts/build.js`. |
| `dist-tests/` | Compiled test artifacts; reproducible via `node scripts/build.js`. |
| `.projectmind/` | Local SQLite database (`projectmind.db`), WAL files, and session cache. |
| `examples/**/.projectmind/` | Local SQLite database for test application. |
| `.agents/`, `.cursor/`, `.vscode/` | Local editor configurations containing developer machine paths. |
| `.claude/`, `.gemini/`, `.codex/` | Local editor configurations containing developer machine paths. |
| `.dsh/`, `.hermes/`, `.deepseek/` | Local editor configurations containing developer machine paths. |
| `.mcp.json`, `opencode.json` | Local MCP configurations containing developer machine paths. |
| `*.tmp`, `*.bak`, `*.log` | Temporary files and configuration backups. |
