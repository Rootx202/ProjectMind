# ProjectMind Plugin Ecosystem & Marketplace Specification

This document details the distribution model, packaging standards, and marketplace compatibility for ProjectMind's 9 AI coding agent plugins.

---

## 1. Distribution Model Overview

ProjectMind uses a dual distribution architecture:
1. **GitHub Releases & Direct Distribution**: Standalone `.tar.gz` packages with cryptographic SHA-256 integrity verification, installable via `projectmind plugin install` or shell installers.
2. **Native Agent Marketplace & Extension Integration**: Seamless compatibility with the official plugin, skill, and MCP discovery mechanisms of all supported AI coding agents.

```text
                  +-----------------------------------+
                  |  GitHub Release / Plugin Registry |
                  |  (.release/index.json)       |
                  +-----------------+-----------------+
                                    |
          +-------------------------+-------------------------+
          |                                                   |
+---------v---------+                               +---------v---------+
| Native Plugins    |                               | MCP & Rule Configs|
| • Antigravity     |                               | • Codex           |
| • Claude Code     |                               | • GitHub Copilot  |
| • Hermes Agent    |                               | • Cursor          |
| • DeepSeek Harness|                               | • Gemini CLI      |
| • OpenCode        |                               |                   |
+-------------------+                               +-------------------+
```

---

## 2. Agent Marketplace Compatibility Matrix

| Agent Ecosystem | Marketplace / Discovery Mechanism | Configuration Manifest | Installation Path | Capability Support |
| :--- | :--- | :--- | :--- | :--- |
| **Google Antigravity** | Agent Marketplace & Skills Catalog | `.agents/plugins/projectmind/plugin.json` | Project & User Plugins | Hooks, MCP, Rules, Skills |
| **Anthropic Claude Code** | Claude Code Plugins | `.claude-plugin/plugin.json` | Project & Global MCP | Hooks, MCP, Rules, Skills |
| **Cursor** | Cursor Marketplace & MCP Registry | `.cursor/mcp.json` + `.cursor/rules/` | Project & Global Cursor | Hooks (v1), MCP, Rules, Skills |
| **OpenAI Codex** | OpenAI MCP Registry | `.codex/config.toml` | Project & Global Codex | MCP, Rules, Skills |
| **Google Gemini CLI** | Gemini CLI Extensions | `.gemini/settings.json` | Project & User Settings | Hooks, MCP, Rules, Skills |
| **GitHub Copilot** | VS Code Extension Marketplace | `.vscode/mcp.json` + Prompt Files | Project Workspace | MCP, Rules, Prompts |
| **OpenCode** | OpenCode Community Plugins & MCP | `opencode.json` | Project Root | Hooks, MCP, Rules, Skills |
| **Hermes Agent** | Nous Research Agent Registry | `.hermes/config.json` | Project & Hermes Home | Hooks, MCP, Rules, Skills |
| **DeepSeek Harness** | DeepSeek Agent Profiles | `.dsh/mcp.json` | Project & DSH Profile | Hooks, MCP, Rules, Skills |

---

## 3. Package Structure & Specification

Each distributed plugin package is bundled as `<agent-id>-<version>.tar.gz` and contains:

```text
<agent-id>/
├── manifest.json       # Canonical metadata conforming to manifest.schema.json
├── README.md           # Agent-specific usage, permissions, and documentation
├── skills/             # Agent skill bundle (SKILL.md)
│   └── projectmind/
├── rules/              # Agent instruction files (e.g. AGENTS.md, .mdc rules)
├── hooks/              # Non-blocking portable lifecycle hook runners
└── mcp/                # MCP server configuration templates
```

### Manifest Schema (`manifest.schema.json`)

All plugins strictly adhere to Draft-07 JSON Schema:

* `id`: Unique identifier (e.g. `antigravity`, `opencode`).
* `name`: Human-readable display name.
* `version`: Semantic version string (`1.0.0`).
* `description`: Purpose and scope description.
* `publisher`: Name, URL, and contact details.
* `supportedPlatforms`: `["linux", "windows", "darwin"]`.
* `supportedAgentVersions`: Minimum agent version requirement.
* `runtimeRequirements`: Node.js and ProjectMind version constraints.
* `capabilities`: MCP transport, hooks, skills, instructions, reload model.
* `permissions`: Filesystem scope, network restrictions (always `false`), command execution.
* `integrity`: Cryptographic SHA-256 hash.

---

## 4. Packaging and Release Artifacts

To generate release packages locally:

```bash
node scripts/package-release.js
```

Generated outputs in `.release/`:
* `plugins/antigravity-1.1.0.tar.gz`
* `plugins/claude-code-1.1.0.tar.gz`
* `plugins/codex-1.1.0.tar.gz`
* `plugins/cursor-1.1.0.tar.gz`
* `plugins/gemini-cli-1.1.0.tar.gz`
* `plugins/github-copilot-1.1.0.tar.gz`
* `plugins/deepseek-harness-1.1.0.tar.gz`
* `plugins/hermes-agent-1.1.0.tar.gz`
* `plugins/opencode-1.1.0.tar.gz`
* `SHA256SUMS` (Cryptographic verification checksums)
* `index.json` (Machine-readable marketplace catalog index)

---

## 5. Security & Marketplace Guidelines

1. **No Plugin Network Access**: ProjectMind agent plugins require zero network permissions at runtime. Any plugin requesting `permissions.network: true` is prohibited. (The optional engine updater contacts GitHub Releases only when explicitly invoked.)
2. **Non-Destructive Operations**: Plugins must never overwrite unrelated user settings in shared configuration files (e.g. `.mcp.json` or `opencode.json`). All modifications must be atomic and reversible via `projectmind plugin uninstall`.
3. **Preservation of Project Knowledge**: Removal of a plugin must never delete or corrupt the `.projectmind` repository intelligence database.

