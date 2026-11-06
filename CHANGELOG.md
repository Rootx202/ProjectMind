# Changelog

All notable changes to the **ProjectMind** platform are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-11-06

### Initial Production Release

#### Core Intelligence & Persistent Memory
* **3-Layer Memory Architecture**:
  * Layer 1 (Core Memory): Permanent project identity, tech stack, constraints, and schema version.
  * Layer 2 (Project Knowledge): Searchable SQLite + FTS5 (BM25) and local vector reranking for modules, symbols, routes, models, and ADRs.
  * Layer 3 (Task Context): Ephemeral, token-budgeted retrieval state isolated from permanent knowledge.
* **7-Stage Controlled Bootstrap**: Analyzes project metadata, entrypoints, module topology, symbols, HTTP routes, database models, and SHA-256 fingerprints without modifying source files.
* **Provenance & Verification Status**: Tracks `verified`, `inferred`, `planned`, `unverified`, and `outdated` records with confidence scores.
* **Smart Auto Mode Engine**: Autonomous zero-command workflow initializing project memory on first encounter and synchronizing delta edits after tool usage.

#### Universal MCP Server
* Implemented JSON-RPC 2.0 MCP server with `stdio` transport.
* Exposed 22 intelligence tools across discovery, context retrieval, impact analysis, architectural decision recording, and token efficiency.

#### Agent Integrations (9 Platforms)
* **Google Antigravity**: Native plugin (`.agents/plugins/projectmind`), MCP config, autonomous skill, and lifecycle hooks (`SessionStart`, `PreInvocation`, `PostToolUse`, `Stop`).
* **Anthropic Claude Code**: Native plugin, MCP config, skill, and lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`).
* **OpenAI Codex**: MCP `initialize` server instructions, skill bundle, and `AGENTS.md` integration.
* **Cursor**: Native v1 lifecycle hooks (`workspaceOpen`, `sessionStart`, `beforeSubmitPrompt`, `afterFileEdit`, `stop`), `.cursor/rules/projectmind.mdc`, and MCP config.
* **Google Gemini CLI**: Strict JSON stdout lifecycle hooks, skill, `GEMINI.md`, and MCP config.
* **GitHub Copilot**: Custom instructions (`.github/copilot-instructions.md`), prompt files, and VS Code MCP integration.
* **OpenCode**: Dynamic MCP client, `AGENTS.md` instructions, skill bundle, and portable hooks.
* **Hermes Agent**: Native MCP client, `HERMES.md` guidelines, and memory loop integration.
* **DeepSeek Harness (`dsh`)**: Profile plugin, `DEEPSEEK.md`, skill bundle, and hook runner.

#### Plugin SDK & Distribution System
* Created `@projectmind/plugin-sdk` with `RuntimeResolver`, `PortableHookRunner`, `ConfigWriter`, `ManifestValidator`, and `PluginRegistry`.
* Developed unified CLI (`projectmind plugin list`, `search`, `install`, `verify`, `update`, `disable`, `enable`, `uninstall`, `doctor`).
* Non-destructive uninstall guarantee: agent configurations can be removed without touching or deleting `.projectmind` SQLite databases.
* Automated packaging tool (`scripts/package-plugins.js`) producing `.tar.gz` bundles with `SHA256SUMS` and `index.json`.
* Cross-platform installers: POSIX `install.sh` for Linux/macOS and PowerShell `install.ps1` for Windows.

#### Security & Privacy
* 100% Local-first: zero external network requests and zero telemetry.
* Secret exclusion engine: automatically ignores `.env`, private keys, certificates, and redacts credentials before indexing.
* Path traversal defense: validates canonical paths inside workspace boundary.
* Prompt injection protection: sanitizes untrusted comments and files before context inclusion.
