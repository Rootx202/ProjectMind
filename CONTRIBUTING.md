# Contributing to ProjectMind

Thank you for your interest in contributing to **ProjectMind**! We welcome contributions, bug reports, feature suggestions, and new agent integrations from the developer community.

---

## 1. Development Prerequisites

* **Node.js**: `v18.0.0` or higher.
* **OS**: Linux, macOS, or Windows (10/11).
* **Package Manager**: npm `v9+` or pnpm `v8+`.

---

## 2. Getting Started

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/Rootx202/ProjectMind.git
   cd ProjectMind
   ```

2. **Compile the Monorepo**:
   ProjectMind includes a zero-dependency Babel TypeScript compiler in `scripts/build.js`:
   ```bash
   node scripts/build.js
   ```

3. **Run the Automated Test Suite**:
   Verify that all 50 tests pass:
   ```bash
   node scripts/test.js
   ```

---

## 3. Monorepo Architecture

* `packages/`:
  * `core/`: Project identity and root discovery.
  * `storage/`: SQLite3 + FTS5 3-layer persistent memory schemas.
  * `indexing/`: 7-stage bootstrap indexing and SHA-256 delta sync.
  * `impact-analysis/`: Dependency graph and reverse dependents.
  * `retrieval/`: BM25 lexical search and local vector reranker.
  * `context-engine/`: Task scope classification and token budgets.
  * `mcp-server/`: JSON-RPC 2.0 MCP server exposing 22 tools.
  * `agent-sdk/`: Smart Auto Mode engine and lifecycle dispatcher.
  * `plugin-sdk/`: Portable runtime resolver, config writer, and registry.
  * `shared/`: Shared types, secret exclusion, and token estimation.
* `adapters/`:
  * Source adapters for Google Antigravity, Claude Code, OpenAI Codex, Cursor, Gemini CLI, GitHub Copilot, DeepSeek Harness, Hermes Agent, and OpenCode.
* `apps/`:
  * `cli/`: User-facing CLI (`projectmind`).
  * `setup/`: Adapter installation and configuration engine.
  * `diagnostics/`: System health verifier (`projectmind doctor`).
* `plugins/`:
  * Canonical distributed plugin manifests and packages.
* `skills/`:
  * Canonical agent skill bundles (`skills/projectmind/SKILL.md`).
* `tests/`:
  * Automated unit, integration, and scenario tests.

---

## 4. Coding & Contribution Standards

1. **Zero Hardcoded Machine Paths**:
   Never commit paths containing `/home/...`, `/Users/...`, `C:\Users\...`, or developer-specific paths in manifests, templates, or source code. Always use `RuntimeResolver` or relative path calculations.
2. **Standard Output Discipline**:
   Many coding agents (such as Claude Code and Gemini CLI) communicate over `stdio` using JSON-RPC or strict JSON. **Never** print plain text logs to `stdout`. All diagnostic logs must be written to `stderr` (`process.stderr.write`).
3. **Fail-Open Hook Policy**:
   If a lifecycle hook encounters an unexpected error, it must fail safely, log to `stderr`, and return an empty object to `stdout` without crashing or freezing the user's agent session.
4. **Non-Destructive Operations**:
   Plugin installation, configuration updates, and removals must use atomic writes, preserve existing unrelated user settings, and never delete `.projectmind` project databases.
5. **Secret Exclusion**:
   Never commit `.env` files, credentials, or private keys. The test suite strictly validates that no secrets or live tokens exist.

---

## 5. Pull Request Process

1. Create a feature branch:
   ```bash
   git checkout -b feature/my-new-agent-integration
   ```
2. Make your changes and add corresponding tests in `tests/`.
3. Verify compilation and test suite:
   ```bash
   node scripts/build.js && node scripts/test.js
   ```
4. Verify plugin packaging:
   ```bash
   node scripts/package-plugins.js
   ```
5. Commit with a clear commit message.
6. Submit a Pull Request against the `main` branch on GitHub.
