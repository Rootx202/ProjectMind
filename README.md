# ProjectMind — Universal AI Project Intelligence Engine

ProjectMind is a local-first, privacy-preserving project intelligence and persistent context engine that enables AI coding agents to understand, remember, and work with software repositories without repeatedly scanning the entire codebase.

ProjectMind is **not** a separate AI coding agent or chatbot. It is an autonomous intelligence and persistent memory layer used directly by your existing coding agents ([Google Antigravity](https://antigravity.google/docs/mcp/), [OpenAI Codex](https://learn.chatgpt.com/docs/extend/mcp), [Anthropic Claude Code](https://code.claude.com/docs/en/hooks), [Google Gemini CLI](https://geminicli.com/docs/tools/mcp-server/), [Cursor](https://cursor.com/docs/hooks), [GitHub Copilot in VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [OpenCode](https://opencode.ai/docs/mcp), [Hermes Agent](https://hermes-agent.nousresearch.com/docs/mcp), and [DeepSeek Harness / Hermes](https://github.com/deepseek-ai/deepseek-harness)).

## Key Capabilities

* **Zero-Command Daily Workflow (Smart Auto Mode)**: Once installed into a supported coding agent, the agent automatically initializes project memory on first encounter, retrieves selective task-scoped context before coding, and incrementally synchronizes modified files after edits.

* **7-Stage Controlled Bootstrap**: Analyzes project metadata, file inventory, entry points, architectural docs, module topology, symbols/routes/models, and SHA-256 fingerprints without blindly reading large or binary files or modifying source code.

* **3-Layer Persistent Memory Architecture**:

  * **Layer 1 — Core Memory**: Compact permanent project identity, tech stack, purpose, key constraints, and schema version.

  * **Layer 2 — Project Knowledge**: Searchable SQLite + FTS5 (BM25) + local semantic vector index of modules, files, symbols, HTTP routes, database models, and Architectural Decision Records (ADRs).

  * **Layer 3 — Task Context**: Temporary, token-budgeted retrieval state strictly isolated from permanent project knowledge.

* **Knowledge Reliability & Provenance**: Every knowledge record tracks `verificationStatus` (`verified`, `inferred`, `planned`, `unverified`, `outdated`), confidence score, source file references, and SHA-256 fingerprints. Inferences and planned prompt specifications are never silently presented as verified implementation facts.

* **Existing & Greenfield Project Support**: Supports both indexing existing codebases and initializing brand-new projects from an initial prompt or specification (`mode: "prompt"`), automatically transitioning records from `planned` to `verified` as code is implemented.

* **Strict Local-First Security & Privacy**: Works 100% offline with zero mandatory cloud accounts or paid embedding APIs. Enforces secret exclusion (`.env`, `.pem`, `.key`, `.ssh`, tokens), path traversal and symlink escape protection, and prompt-injection sanitization on untrusted repository files.

## Agent Compatibility Matrix

All adapter implementations are grounded in the current official documentation for each coding environment:

| Coding Agent | Native Plugin | MCP Server | Agent Skills | Lifecycle Hooks | Automatic Invocation Mechanism | Restart Required | Official Documentation | 
| ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | 
| **Google Antigravity** | Yes (`.agents/plugins/projectmind/plugin.json`) | Yes (`.agents/mcp_config.json`) | Yes (`.agents/skills/projectmind/SKILL.md`) | Yes (`SessionStart`, `PreInvocation`, `PostToolUse`, `Stop` in `hooks.json`) | Native Lifecycle Hooks + Autonomous Skill + MCP | No (`/mcp` or `/skills reload`) | [Antigravity MCP](https://antigravity.google/docs/mcp/), [Skills](https://antigravity.google/docs/skills/), [Plugins](https://antigravity.google/docs/build-plugins/) | 
| **Anthropic Claude Code** | Yes (`.claude-plugin/plugin.json`) | Yes (`.mcp.json`) | Yes (`.claude/skills/projectmind/SKILL.md`) | Yes (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop` in `.claude/settings.json`) | Native Lifecycle Hooks + Skill + `CLAUDE.md` + MCP | Yes (or `/mcp` & `/hooks`) | [Claude Code Settings](https://code.claude.com/docs/en/settings), [Hooks](https://code.claude.com/docs/en/hooks), [Skills](https://code.claude.com/docs/en/skills) | 
| **Cursor** | No (uses `.cursor/` config) | Yes (`.cursor/mcp.json`) | Yes (`.agents/skills/projectmind/SKILL.md`) | Yes (`version: 1` in `.cursor/hooks.json`: `workspaceOpen`, `sessionStart`, `beforeSubmitPrompt`, `afterFileEdit`, `stop`) | Native Lifecycle Hooks + `.cursor/rules/projectmind.mdc` (`alwaysApply: true`) + MCP | No (auto-watched in trusted workspaces) | [Cursor MCP](https://cursor.com/docs/cli/mcp), [Hooks](https://cursor.com/docs/hooks), [Rules](https://cursor.com/docs/rules) | 
| **Google Gemini CLI** | No (uses `.gemini/` config) | Yes (`.gemini/settings.json`) | Yes (`.agents/skills/projectmind/SKILL.md`) | Yes (`SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent` in `.gemini/settings.json`) | Native Lifecycle Hooks (Strict JSON stdout) + Skill + `GEMINI.md` + MCP | Yes (or `/hooks` & `/settings`) | [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), [Hooks](https://geminicli.com/docs/hooks/), [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/) | 
| **OpenAI Codex** | No (uses `.codex/config.toml`) | Yes (`[mcp_servers.projectmind]` in `.codex/config.toml`) | Yes (`.agents/skills/projectmind/SKILL.md`) | Limited (Cloud/Managed hooks restricted via `allow_managed_hooks_only`) | MCP `initialize` Server Instructions (<512 chars) + Skill + `AGENTS.md` | Yes (restart CLI or MCP server in IDE) | [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Config Reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex Repo](https://github.com/openai/codex/blob/main/docs/config.md) | 
| **GitHub Copilot (VS Code)** | No (uses `.vscode/` & `.github/`) | Yes (`.vscode/mcp.json` `servers` + `.mcp.json` `mcpServers`) | Yes (`.github/prompts/projectmind.prompt.md`) | No (No pre/post file edit shell hooks in standard local chat) | `.github/copilot-instructions.md` + MCP Tool Discovery (`chat.mcp.autostart`) | No (`MCP: List Servers` in Command Palette) | [VS Code MCP Config](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Custom Instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions) | 
| **OpenCode** | No (uses `opencode.json` & `.opencode/`) | Yes (`opencode.json` `mcp.projectmind` with `type: "local"`) | Yes (`.opencode/skills/projectmind/SKILL.md` + `.agents/`) | Yes (`.projectmind/hooks/opencode-hook.js`) | MCP Server + Skill + `AGENTS.md` Dynamic Reload | No (auto-reloads on file change) | [OpenCode MCP](https://opencode.ai/docs/mcp), [AGENTS.md](https://opencode.ai/docs/agents-md), [OpenCode Repo](https://github.com/anomalyco/opencode) | 
| **Hermes Agent** | Yes (Native MCP Client + Skill Dir) | Yes (`.hermes/config.json` `mcp_servers` + `.hermes/mcp.json`) | Yes (`.hermes/skills/projectmind/SKILL.md` + `.agents/`) | Yes (`.projectmind/hooks/hermes-agent-hook.js`) | Native MCP + `HERMES.md` / `AGENTS.md` + Skill Loop | No (`hermes mcp list` or reload) | [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/mcp), [Hermes Repo](https://github.com/NousResearch/hermes-agent) | 
| **DeepSeek Harness** | Yes (`@projectmind/dsh-plugin` Profile Plugin) | Yes (`.dsh/mcp.json` + `.deepseek/mcp.json`) | Yes (`.dsh/skills/projectmind/SKILL.md` + `.agents/`) | Yes (`.projectmind/hooks/deepseek-harness-hook.js`) | MCP Server + Profile Plugin + `DEEPSEEK.md` + Skill | Yes (restart `dsh` or reload profile) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Superagent Prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 

## Quickstart & Installation

ProjectMind provides cross-platform installers for Linux, macOS, and Windows:

### Linux & macOS (POSIX)
```bash
# Automated installer (local clone or remote)
./install.sh

# Or install for a specific agent directly
./install.sh --agent antigravity
```

### Windows (PowerShell 5.1 & PowerShell 7+)
```powershell
# Run the Windows installer
.\install.ps1 -Agent antigravity
```

### Monorepo Build & Test
```bash
# 1. Compile all packages, adapters, and apps
node scripts/build.js

# 2. Run the complete automated test suite (50/50 tests passing)
node scripts/test.js

# 3. Package all 9 plugins with SHA-256 checksums
node scripts/package-plugins.js
```

### Plugin Management CLI

```bash
# List all 9 supported plugins and their status
projectmind plugin list

# Run system & adapter diagnostic health check
projectmind plugin doctor

# Install integration for a specific agent (e.g. Antigravity or OpenCode)
projectmind plugin install antigravity
projectmind plugin install opencode

# Install multiple or all agents
projectmind plugin install claude-code,cursor,codex
projectmind plugin install --all

# Verify adapter installation and configuration integrity
projectmind plugin verify antigravity

# Update adapter configuration and regenerate hook runners
projectmind plugin update antigravity

# Temporarily disable an adapter in configuration
projectmind plugin disable antigravity

# Re-enable an adapter
projectmind plugin enable antigravity

# Cleanly uninstall adapter configuration (preserves .projectmind database)
projectmind plugin uninstall antigravity
```

After installation, open your project in your coding agent and work normally. You never need to run `projectmind scan`, `projectmind context`, or `projectmind sync` manually during ordinary development.

## Documentation Guides

* [**Installation Guide (INSTALL.md)**](INSTALL.md) — Comprehensive cross-platform installation instructions, options, and offline setups.
* [**Windows Guide (WINDOWS.md)**](WINDOWS.md) — PowerShell setup, execution policies, path handling (drive letters, spaces, Unicode, UNC), and Windows Terminal.
* [**Linux Guide (LINUX.md)**](LINUX.md) — Linux distributions, XDG directory compliance, file descriptor tuning, and headless/systemd configurations.
* [**Marketplace Specification (MARKETPLACE.md)**](MARKETPLACE.md) — Distribution model, native agent marketplace integration, packaging, and catalog metadata.
* [**Plugin Development Guide (PLUGIN_DEVELOPMENT.md)**](PLUGIN_DEVELOPMENT.md) — Authoring new plugins, Plugin SDK APIs, lifecycle events, and testing.
* [**Security Architecture (SECURITY.md)**](SECURITY.md) — Local-first guarantees, secret exclusion engine, path traversal defense, and prompt injection mitigation.
* [**Troubleshooting Guide (TROUBLESHOOTING.md)**](TROUBLESHOOTING.md) — Diagnostic workflows, recovery commands, backup restoration, and solutions for common issues.
* [**Release Engineering (RELEASE.md)**](RELEASE.md) — Release checklists, automated packaging, checksum verification, and publishing workflows.

## Repository Structure

```
projectmind/
├── apps/
│   ├── cli/                 # Installation, diagnostics, hook runner, and admin CLI
│   ├── setup/               # Agent detection, idempotent installer, backup, and uninstaller
│   └── diagnostics/         # Runtime, SQLite/FTS5, MCP, security, and adapter health verifier
├── packages/
│   ├── shared/              # Universal types, security validators, secret redaction, token estimator
│   ├── storage/             # SQLite3 + FTS5 engine, 3-layer memory schema, migrations, backups
│   ├── core/                # Project root detection, stable Project ID, moved-project healing
│   ├── indexing/            # 7-stage bootstrap, symbol/route/model extraction, Git & SHA-256 delta sync
│   ├── knowledge/           # Existing & prompt-based initialization, planned->verified transitions, ADRs
│   ├── impact-analysis/     # Dependency graph traversal, reverse dependents, blast-radius scoring
│   ├── retrieval/           # FTS5 BM25 lexical search + pluggable local vector semantic reranking
│   ├── context-engine/      # Task scope classifier, token budget enforcement, retrieval cache
│   ├── mcp-server/          # JSON-RPC 2.0 MCP server exposing all 22 intelligence tools
│   └── agent-sdk/           # Smart Auto Mode engine, lifecycle hook dispatcher, AgentAdapter interface
├── adapters/
│   ├── antigravity/         # Google Antigravity native plugin, MCP, skill, and lifecycle hooks adapter
│   ├── codex/               # OpenAI Codex config.toml, skill, and AGENTS.md adapter
│   ├── claude-code/         # Claude Code .mcp.json, .claude/settings.json hooks, skill, and plugin adapter
│   ├── gemini-cli/          # Gemini CLI .gemini/settings.json MCP + Strict JSON hooks + GEMINI.md adapter
│   ├── cursor/              # Cursor .cursor/mcp.json, .cursor/hooks.json (v1), and .mdc rule adapter
│   ├── github-copilot/      # VS Code .vscode/mcp.json + portable .mcp.json + copilot-instructions adapter
│   ├── opencode/            # OpenCode opencode.json mcp + AGENTS.md + skill adapter
│   ├── hermes-agent/        # Hermes Agent .hermes/config.json + HERMES.md + memory loop adapter
│   └── deepseek-harness/    # DeepSeek Harness dsh/deepseek mcp.json + DEEPSEEK.md adapter
├── skills/
│   └── projectmind/         # Canonical SKILL.md agent skill bundle
├── templates/
│   └── default-config.json  # Default .projectmind/config.json template
├── examples/
│   └── sample-ts-app/       # Multi-module sample TypeScript API for live testing
├── tests/
│   ├── core/                # Core storage, indexing, security, migration, and isolation tests
│   ├── mcp/                 # MCP protocol, 22-tool functional, validation, and truncation tests
│   ├── adapters/            # Idempotent install, backup preservation, verify, and uninstall tests
│   └── scenarios/           # All 8 Critical Acceptance Scenario end-to-end tests
├── docs/                    # Detailed architectural, security, adapter, and troubleshooting guides
├── scripts/
│   ├── build.js             # Zero-dependency TypeScript monorepo compiler & workspace linker
│   └── test.js              # Automated test runner
├── package.json
└── tsconfig.json

```

# ProjectMind Architecture & Memory Specification

## 1. Architectural Principles

ProjectMind separates **universal project intelligence** (`packages/*`) from **agent-specific integration mechanics** (`adapters/*`):

1. **Universal Core**: Indexes files, extracts symbols/routes/models, manages the 3-layer SQLite + FTS5 database, computes dependency blast radius, and assembles token-budgeted context packages.

2. **MCP Intelligence Server (`@projectmind/mcp-server`)**: Exposes 22 structured tools over standard JSON-RPC 2.0 stdio transport with strict input validation, path traversal protection, and output size caps.

3. **Smart Auto Mode Engine (`@projectmind/agent-sdk`)**: Orchestrates lifecycle transitions (`onProjectOpen`, `onBeforeTask`, `onAfterFileChange`) so the coding agent automatically initializes, retrieves selective context, and synchronizes changes without manual user commands.

4. **Independent Agent Adapters (`@projectmind/adapter-*`)**: Configure each coding environment's native plugins, MCP server registrations, lifecycle hooks, skills, and concise instruction blocks idempotently.

## 2. Three-Layer Memory Architecture

All project data lives locally in `<project-root>/.projectmind/projectmind.db` (SQLite 3 with WAL journaling and FTS5 virtual tables) alongside `.projectmind/.gitignore` (which prevents local SQLite files and backups from being committed to Git).

| Memory Layer | SQLite Tables | Contents & Lifecycle | 
| ----- | ----- | ----- | 
| **Layer 1: Core Memory** | `core_memory`, `schema_migrations` | Permanent, ultra-compact project metadata: `projectId`, `projectName`, `projectRoot`, `previousRoots`, `mainTechStack`, `projectPurpose`, `keyConstraints`, `architecturalSummary`, `currentState`, `memorySchemaVersion`, and `lastVerifiedCommit`. | 
| **Layer 2: Project Knowledge** | `project_files`, `project_modules`, `architectural_decisions`, `knowledge_items`, `knowledge_fts`, `vector_embeddings` | Searchable structural records of files, SHA-256 fingerprints, modules, public symbols, dependencies/dependents, HTTP routes, DB models, and ADRs. Indexed in `knowledge_fts` (SQLite FTS5 with BM25 ranking). | 
| **Layer 3: Task Context** | `task_contexts`, `retrieval_cache`, `sync_events` | Ephemeral task-specific retrieval packages, token budget tracking, and cache entries. Strictly isolated from Layer 2 so temporary task assumptions never pollute permanent project knowledge. | 

## 3. Knowledge Reliability & Verification States

Every Layer 2 record carries explicit provenance (`sourceFiles`, `fileFingerprint`, `lastVerifiedAt`, `confidence`, and `verificationStatus`):

* `verified`: Directly extracted and verified from existing source files on disk with matching SHA-256 fingerprint.

* `inferred`: Synthesized from conventions or structural patterns (e.g., naming conventions in documentation); labeled with confidence `< 1.0`.

* `planned`: Extracted from an initial project prompt or specification (`initialize_project` with `mode: "prompt"`) before implementation exists. Automatically transitions to `verified` when matching module files are created and synchronized via `sync_changed_files`.

* `unverified`: Open architectural questions or components that could not be statically confirmed during bootstrap.

* `outdated`: Records whose underlying source file fingerprints have changed prior to synchronization.

## 4. The 22 MCP Intelligence Tools

| Category | Tool Name | Purpose | 
| ----- | ----- | ----- | 
| **Project Discovery** | `initialize_project` | Runs 7-stage controlled bootstrap on an existing codebase or extracts `planned` knowledge from a new project prompt. | 
| **Project Discovery** | `get_project_overview` | Returns Layer 1 Core Memory and high-level module summaries. | 
| **Project Discovery** | `get_project_status` | Reports initialization state, schema version, entity counts, and pending file changes. | 
| **Project Discovery** | `detect_project_changes` | Compares SHA-256 file fingerprints and Git status to detect added, modified, deleted, and renamed files. | 
| **Context Retrieval** | `get_relevant_context` | Classifies task scope (`none`, `file`, `module`, `cross-module`, `deep-architecture`) and returns a token-budgeted context package. | 
| **Context Retrieval** | `get_module_context` | Returns detailed module purpose, entry files, exported symbols, routes, models, dependencies, and ADRs. | 
| **Context Retrieval** | `search_project_knowledge` | Executes SQLite FTS5 BM25 search combined with local feature-hash semantic vector reranking. | 
| **Context Retrieval** | `find_related_files` | Discovers files related by module membership, imports, or symbol references. | 
| **Context Retrieval** | `get_file_summary` | Returns compact file metadata, role, SHA-256 hash, exported symbols, and imports without dumping raw source code. | 
| **Context Retrieval** | `get_architecture_context` | Returns system-wide module dependency topology, API catalog, database models, and key constraints. | 
| **Impact Analysis** | `analyze_change_impact` | Computes direct and transitive dependents, affected routes/models, risk level, and deep-analysis recommendations. | 
| **Impact Analysis** | `find_dependencies` | Lists direct internal module dependencies, transitive dependencies, and external packages. | 
| **Impact Analysis** | `find_dependents` | Lists all modules that directly or transitively depend on a target module or file. | 
| **Impact Analysis** | `detect_affected_modules` | Maps changed file paths to directly and transitively affected modules. | 
| **Memory Management** | `get_recent_changes` | Lists recent synchronization events and recent Layer 3 task context summaries. | 
| **Memory Management** | `update_project_knowledge` | Upserts a Layer 2 knowledge item with explicit `verificationStatus` and source references. | 
| **Memory Management** | `sync_changed_files` | Incrementally indexes modified/added/renamed/deleted files, updates affected modules, and transitions `planned` records to `verified`. | 
| **Memory Management** | `record_architectural_decision` | Records a structured Architectural Decision Record (ADR) and invalidates affected module caches. | 
| **Memory Management** | `get_project_decisions` | Retrieves ADRs and project constraints, optionally filtered by module. | 
| **Context Efficiency** | `estimate_context_tokens` | Approximates token usage and calculates token savings of ProjectMind summaries vs. raw source files. | 
| **Context Efficiency** | `get_compact_context` | Returns an ultra-compact (<800 token) project digest. | 
| **Context Efficiency** | `get_context_manifest` | Returns lightweight module fingerprints and entity counts so agents can inspect available memory cheaply. | 

# Installation & Agent Configuration Guide

## 1. Standard Installation Workflow

ProjectMind provides an idempotent setup system (`apps/cli` and `apps/setup`) that detects installed coding environments, backs up existing configuration files into `.projectmind/config-backups/` before making any edits, installs the required MCP server, skills, and lifecycle hooks, and verifies every integration check before reporting success.

```
# Install for all 6 supported coding agents in the current repository
node /path/to/projectmind/apps/cli/dist/index.js install --all --project-root .

# Or install for a single agent (e.g., claude-code)
node /path/to/projectmind/apps/cli/dist/index.js install --agent claude-code --project-root .

# Verify installation health and security
node /path/to/projectmind/apps/cli/dist/index.js diagnostics --project-root .

# Safely uninstall ProjectMind from agent configurations while preserving all user settings
node /path/to/projectmind/apps/cli/dist/index.js uninstall --all --project-root .

```

## 2. Agent-Specific Integration Details

### Google Antigravity

* **Files Configured**:

  * `.agents/mcp_config.json` (registers `mcpServers.projectmind` stdio server per [Antigravity MCP Docs](https://antigravity.google/docs/mcp/))

  * `.agents/skills/projectmind/SKILL.md` (installs autonomous skill per [Antigravity Skills Docs](https://antigravity.google/docs/skills/))

  * `.agents/plugins/projectmind/` (bundles `plugin.json`, `mcp_config.json`, `hooks.json`, `skills/`, `rules/AGENTS.md`, and `assets/logo.svg` per [Antigravity Build Plugins Docs](https://antigravity.google/docs/build-plugins/))

* **Automatic Activation**: `SessionStart`, `PreInvocation`, `PostToolUse`, and `Stop` hooks in `hooks.json` automatically initialize memory, inject compact task context, and synchronize modified files.

### Anthropic Claude Code

* **Files Configured**:

  * `.mcp.json` (registers `mcpServers.projectmind`)

  * `.claude/settings.json` (registers `SessionStart`, `UserPromptSubmit`, `PostToolUse` on `Edit|Write|MultiEdit`, and `Stop` command hooks per [Claude Code Hooks Docs](https://code.claude.com/docs/en/hooks))

  * `.claude/skills/projectmind/SKILL.md` (per [Claude Code Skills Docs](https://code.claude.com/docs/en/skills))

  * `.claude-plugin/plugin.json` and concise reference block in `CLAUDE.md`

* **Restart Note**: Restart Claude Code or run `/mcp` and `/hooks` after first installation.

### Cursor

* **Files Configured**:

  * `.cursor/mcp.json` (registers `mcpServers.projectmind` per [Cursor MCP Docs](https://cursor.com/docs/cli/mcp))

  * `.cursor/hooks.json` (`version: 1` lifecycle hooks for `workspaceOpen`, `sessionStart`, `beforeSubmitPrompt`, `afterFileEdit`, and `stop` per [Cursor Hooks Docs](https://cursor.com/docs/hooks))

  * `.cursor/rules/projectmind.mdc` (`alwaysApply: true` rule per [Cursor Rules Docs](https://cursor.com/docs/rules))

  * `.agents/skills/projectmind/SKILL.md`

* **Trust Note**: Ensure the workspace is marked Trusted in Cursor so `.cursor/hooks.json` executes automatically.

### Google Gemini CLI

* **Files Configured**:

  * `.gemini/settings.json` (registers `mcpServers.projectmind` and `SessionStart`, `BeforeAgent`, `AfterTool`, and `AfterAgent` hooks per [Gemini CLI MCP Docs](https://geminicli.com/docs/tools/mcp-server/) and [Gemini CLI Hooks Docs](https://geminicli.com/docs/hooks/))

  * `.agents/skills/projectmind/SKILL.md` and concise reference block in `GEMINI.md` ([Gemini CLI GEMINI.md Docs](https://geminicli.com/docs/cli/gemini-md/))

* **Strict JSON Rule**: The Gemini CLI hook runner (`.projectmind/hooks/gemini-cli-hook.js`) strictly writes only JSON to `stdout` and sends all diagnostics to `stderr` per [Gemini CLI Hooks Best Practices](https://geminicli.com/docs/hooks/best-practices/).

### OpenAI Codex

* **Files Configured**:

  * `.codex/config.toml` (idempotent `[mcp_servers.projectmind]` block per [OpenAI Codex MCP Docs](https://learn.chatgpt.com/docs/extend/mcp))

  * `.agents/skills/projectmind/SKILL.md` and concise reference block in `AGENTS.md`

* **Automatic Activation & Known Limitation**: During the MCP `initialize` handshake, ProjectMind returns self-contained server `instructions` (<512 chars) that Codex automatically injects into its system guidance. Because Codex Cloud and managed environments can enforce `allow_managed_hooks_only = true` in `requirements.toml` ([Codex Config Docs](https://github.com/openai/codex/blob/main/docs/config.md)), ProjectMind does not rely on shell hooks for Codex and instead pairs MCP Server Instructions with `AGENTS.md` and `.agents/skills/projectmind/SKILL.md`.

### GitHub Copilot (VS Code & Copilot Harness)

* **Files Configured**:

  * `.vscode/mcp.json` (top-level `servers.projectmind` with `type: "stdio"` for VS Code per [VS Code MCP Reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration))

  * `.mcp.json` (top-level `mcpServers.projectmind` for portable Copilot CLI/Harness sessions)

  * `.github/copilot-instructions.md` and `.github/prompts/projectmind.prompt.md` ([VS Code Custom Instructions Docs](https://code.visualstudio.com/docs/agent-customization/custom-instructions))

* **Known Limitation**: Standard VS Code GitHub Copilot Chat does not execute shell pre/post edit hooks; automatic invocation relies on `.github/copilot-instructions.md` and MCP tool discovery.

### OpenCode (anomalyco / opencode.ai)

* **Files Configured**:
  * `opencode.json` (registers `mcp.projectmind` with `type: "local"` and `command: ["node", ...]` per [OpenCode MCP Documentation](https://opencode.ai/docs/mcp))
  * `AGENTS.md` (upserts concise ProjectMind intelligence protocol block; OpenCode automatically discovers and injects `AGENTS.md` per [OpenCode Agents Guide](https://opencode.ai/docs/agents-md))
  * `.opencode/skills/projectmind/SKILL.md` and `.agents/skills/projectmind/SKILL.md`
  * `.projectmind/hooks/opencode-hook.js` for CLI/TUI lifecycle events
* **Automatic Activation**: OpenCode hot-reloads `opencode.json` and `AGENTS.md` dynamically on session start and before prompt execution without requiring a restart.

### Hermes Agent (Nous Research)

* **Files Configured**:
  * `.hermes/config.json` (registers `mcp_servers.projectmind` and external skill directories per [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/mcp))
  * `.hermes/mcp.json` (portable MCP configuration for Hermes Agent CLI runner)
  * `HERMES.md` and `AGENTS.md` (idempotent ProjectMind reference blocks; Hermes Agent evaluates `HERMES.md` with top priority)
  * `.hermes/skills/projectmind/SKILL.md` and `.agents/skills/projectmind/SKILL.md`
  * `.projectmind/hooks/hermes-agent-hook.js` for memory loop integration
* **DeepSeek Integration**: Hermes Agent pairs seamlessly with DeepSeek reasoning models (e.g., DeepSeek-V4 Pro/Flash) via `hermes setup` or direct provider keys, using ProjectMind as its persistent memory engine.

### DeepSeek Harness (dsh / DeepSeek AI)

* **Files Configured**:
  * `.dsh/mcp.json` and `.deepseek/mcp.json` (registers `mcpServers.projectmind` for `dsh` execution modes)
  * `.dsh/config.json` (registers `@projectmind/dsh-plugin` plugin layer)
  * `DEEPSEEK.md` and `AGENTS.md` (concise ProjectMind instructions)
  * `.dsh/skills/projectmind/SKILL.md` and `.agents/skills/projectmind/SKILL.md`
  * `.projectmind/hooks/deepseek-harness-hook.js`
* **Aliases Supported**: In the ProjectMind CLI and SetupManager, `--agent deepseek-harness`, `--agent deepseek-hermes`, `--agent deepseek`, and `--agent dsh` are all automatically recognized and resolved.

# Smart Auto Mode & Context Efficiency

Smart Auto Mode (`@projectmind/agent-sdk` and `@projectmind/context-engine`) ensures coding agents receive high-signal project intelligence while minimizing token consumption and avoiding redundant full-project scans.

## 1. Lifecycle State Machine

1. **First Encounter (`initial_bootstrap`)**:

   * Triggered when `.projectmind/projectmind.db` has no Core Memory.

   * Executes the 7-stage controlled bootstrap once (metadata -> file inventory -> entrypoints/configs -> architecture docs -> module topology -> selective symbol/route/model extraction -> fingerprint persistence).

2. **Returning Session (`warm_reuse_unchanged` / `warm_incremental_sync`)**:

   * Loads Layer 1 Core Memory and compares file `sizeBytes` + `mtimeMs` (fast path) and `sha256` content hashes (when modified).

   * If zero files changed, reuses verified memory immediately (`0` files rescanned).

   * If files were added, modified, deleted, or renamed, reanalyzes **only** the affected files and recomputes **only** the affected modules.

3. **Every New Task (`onBeforeTask` / `get_relevant_context`)**:

   * **Scope `none`**: Generic questions unrelated to the repository (e.g., `"What is a binary search tree?"`) skip retrieval completely (`retrievalNeeded: false`, `0` tokens used).

   * **Scope `file`**: Single-file tweaks retrieve only the target file summary and its immediate module.

   * **Scope `module`**: Standard feature/bug tasks retrieve the target module, its public symbols, and direct dependencies.

   * **Scope `cross-module`**: Tasks spanning multiple modules include direct and reverse dependents plus relevant ADRs.

   * **Scope `deep-architecture`**: Triggered automatically when a change affects >= 4 interconnected modules, touches database schemas, encounters unverified/contradictory knowledge, or when an audit is requested. Always includes `deepAnalysisExplanation`.

4. **Post-Task Synchronization (`onAfterFileChange` / `sync_changed_files`)**:

   * Updates changed file fingerprints and module summaries.

   * Automatically transitions matching `planned` modules and requirements (from `mode: "prompt"`) to `verified` status.

   * Invalidates retrieval cache entries **only** for affected modules.

# Security, Privacy, and Resilience Specification

## 1. Local-First & Offline Architecture

* ProjectMind stores all indexes, fingerprints, and knowledge records locally in `<project-root>/.projectmind/projectmind.db`.

* No cloud account, external telemetry, or paid embedding API is required.

* No source code is ever uploaded outside the local workstation.

## 2. Hard Secret & Credential Exclusion

`isSensitiveOrSecretPath()` in `@projectmind/shared` enforces a non-overridable blocklist (`allowSecretIndexing: false` is a hard type and runtime invariant). ProjectMind never indexes:

* `.env` and `.env.*` files

* Private keys and certificates (`.pem`, `.key`, `.p12`, `.pfx`, `.kdbx`, `.keystore`, `id_rsa`, `id_ed25519`)

* SSH, AWS, GPG, and password-store directories (`.ssh/`, `.aws/`, `.gnupg/`, `.password-store/`)

* Package manager and registry tokens (`.npmrc`, `.pypirc`, `.netrc`, `credentials.json`, `secrets.*`, `tokens.json`)

* Inline API keys and private key blocks (`redactSecrets()` scrubs `sk-...`, `ghp_...`, `AIza...`, `xox...`, and PEM private key blocks before any summary or log output is written).

## 3. Path Traversal & Symbolic Link Boundaries

* `resolveSafeProjectPath(projectRoot, candidatePath)` resolves real canonical paths via `fs.realpathSync` and rejects any relative path (`../`), null byte, or symbolic link whose target resolves outside `projectRoot`.

* During file discovery, symbolic links pointing outside the repository root are automatically skipped.

## 4. Untrusted Repository Content & Prompt-Injection Protection

* Repository source comments and markdown files are treated as **untrusted data**.

* `sanitizeUntrustedContent()` strips prompt-injection directives (such as `"ignore all previous instructions"`, `"system override:"`, `"disregard security rules"`, or `<system_instruction>` tags) before storing file summaries or returning context packages to the coding agent.

* ProjectMind never executes arbitrary project scripts (`npm Pre/Post scripts`, Makefiles, or repo binaries) during indexing.

## 5. Fail-Open Lifecycle Resilience

* All lifecycle hook scripts (`.projectmind/hooks/*-hook.js`) wrap execution in a fail-open boundary (`exit 0` with `{}` fallback on unexpected errors) so a corrupted environment or missing directory never blocks the developer's coding agent.

* If `.projectmind/projectmind.db` is corrupted, `ProjectMemoryStore` automatically backs up the corrupted file to `.projectmind/backups/corrupted-<timestamp>.db.bak` and reinitializes a clean database.

# Developer Guide, Testing, and Adding a New Agent Adapter

## 1. Building and Testing the Monorepo

```
# Compile all packages, adapters, apps, and test suites
node scripts/build.js

# Run the complete 32-test verification suite (Core, MCP, Adapters, and Scenarios 1-8)
node scripts/test.js

```

## 2. How to Add a New Coding Agent Adapter

All agent-specific code is isolated in `adapters/<agent-name>/` and implements the `AgentAdapter` interface exported by `@projectmind/agent-sdk` without modifying the core engine.

### Step 1: Create `adapters/<agent-name>/src/index.ts`

Implement the four required methods of `AgentAdapter`:

* `detectEnvironment(projectRoot, homeDir)`: Check whether the agent's workspace folder or global config exists.

* `install(projectRoot, options)`:

  1. Call `backupFileBeforeModify()` before modifying any existing configuration file.

  2. Register the ProjectMind MCP stdio server (`packages/mcp-server/dist/cli.js --project-root <root>`).

  3. Install `CONCISE_SKILL_CONTENT` or use `upsertMarkdownBlockIdempotent()` for instruction files.

  4. If the agent supports lifecycle hooks, call `writeHookRunnerScript()` and register the hook commands idempotently.

  5. Call `this.verify(projectRoot)` and return the verification result.

* `verify(projectRoot)`: Inspect the generated configuration files and return `verified: true` only if all required artifacts are valid.

* `uninstall(projectRoot)`: Remove ProjectMind's entries cleanly while preserving all user settings.

### Step 2: Register the Adapter in `apps/setup/src/index.ts`

Add your new adapter instance to the `SetupManager` constructor list and add an integration test case in `tests/adapters/adapters.test.ts`.

# Troubleshooting & Administrative Guide

## 1. Running Health Diagnostics

Run the built-in diagnostics tool to inspect Node.js compatibility, SQLite3 + FTS5 status, database schema version, `.gitignore` protection, secret-leak checks, MCP tool registration, and adapter verification:

```
node apps/cli/dist/index.js diagnostics --project-root /path/to/project

```

## 2. Common Issues & Solutions

* **Agent does not show ProjectMind MCP tools after installation**:

  * Check whether your coding agent requires a session restart (`Claude Code`, `Gemini CLI`, and `OpenAI Codex` require restarting the session or running `/mcp` to reload newly added stdio servers).

* **Lifecycle hooks do not fire in Cursor or Gemini CLI**:

  * Both Cursor (`.cursor/hooks.json`) and Gemini CLI (`.gemini/settings.json`) require the project workspace to be marked **Trusted** before executing project-level shell hooks.

* **Corrupted `.projectmind/projectmind.db` file**:

  * ProjectMind automatically detects SQLite corruption via `PRAGMA integrity_check`, moves the corrupted file to `.projectmind/backups/corrupted-<timestamp>.db.bak`, and reinitializes cleanly on the next session start or `projectmind init`.

* **Moved Project Directory**:

  * If you move or rename a project folder on disk, ProjectMind preserves your stable `projectId`, records the previous path in `previousRoots`, and updates `projectRoot` automatically.  

