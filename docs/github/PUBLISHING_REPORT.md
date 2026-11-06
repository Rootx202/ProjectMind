# ProjectMind Publishing & Release Verification Report

**Publish Date:** 2026-11-06  
**Publisher / Maintainer:** Rootx202 (ProjectMind Authors)  
**Release Version:** `v1.0.0`  
**License:** MIT License  

---

## 1. Repository Access & Coordinates

| Coordinate | Value / URL |
|---|---|
| **Repository URL** | [https://github.com/Rootx202/ProjectMind](https://github.com/Rootx202/ProjectMind) |
| **Clone (HTTPS)** | `https://github.com/Rootx202/ProjectMind.git` |
| **ZIP Archive Download** | [https://github.com/Rootx202/ProjectMind/archive/refs/heads/main.zip](https://github.com/Rootx202/ProjectMind/archive/refs/heads/main.zip) |
| **Default Branch** | `main` |
| **Latest Release Tag** | [`v1.0.0`](https://github.com/Rootx202/ProjectMind/releases/tag/v1.0.0) |
| **CI Matrix Status** | Linux, Windows, macOS on Node.js 18, 20, 22 |
| **Topics Configured** | `agent-integration`, `ai-agents`, `automation`, `cli`, `coding-assistant`, `context-management`, `developer-tools`, `mcp`, `project-memory` |

---

## 2. Pre-Upload Audit & Cleanliness Guarantees

1. **Total Files Tracked:** 127 production files across `packages/`, `adapters/`, `apps/`, `plugins/`, `skills/`, `templates/`, `tests/`, `examples/`, `docs/`, and `scripts/`.
2. **Zero Sensitive Data:** Audited and verified zero `.env` files, API keys, private keys (`.pem`, `.key`, `id_rsa`), tokens, or local credentials.
3. **Zero Hardcoded Machine Paths:** Verified complete absence of local developer paths (`/home/kali`, `/Users/`, `C:\Users\`). Dynamic, portable resolution is enforced via `@projectmind/plugin-sdk` `RuntimeResolver`.
4. **Exclusions Enforced (.gitignore):**
   - `node_modules/`
   - `dist/` and `dist-tests/`
   - `.projectmind/` (including SQLite `projectmind.db`, WAL, and config backups)
   - IDE/editor metadata (`.agents/`, `.cursor/`, `.vscode/`, `.gemini/`, `.mcp.json`, `opencode.json`)
   - Operating system artifacts (`.DS_Store`, `Thumbs.db`)
   - Local coverage and logs

---

## 3. Package & Plugin Distribution Artifacts (Release v1.0.0)

All 9 official agent plugin bundles have been packaged with cryptographic SHA-256 integrity verification:

| Asset Name | Size | SHA-256 Checksum | Download URL |
|---|---|---|---|
| `antigravity-1.0.0.tar.gz` | 1,448 B | `ad6b42e4f969112e323c4b4a731a653ce89317c4066a89ce668523a28193c5bd` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/antigravity-1.0.0.tar.gz) |
| `claude-code-1.0.0.tar.gz` | 1,431 B | `86f9e8544daf9845cd8b398ca5edfec8887be4194ab87e8a35981d0c57358bfa` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/claude-code-1.0.0.tar.gz) |
| `codex-1.0.0.tar.gz` | 1,441 B | `8907f2220c79c3d0cff1692cf2fec59fd153ec3d1cf11ca647f25fa4022022f9` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/codex-1.0.0.tar.gz) |
| `cursor-1.0.0.tar.gz` | 1,373 B | `07f31e0ee70655b1cfdf8d71159e04c0567094d9792c950a4da7069d70ca68b6` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/cursor-1.0.0.tar.gz) |
| `deepseek-harness-1.0.0.tar.gz` | 1,425 B | `c16206b063e1d185d4e1c66dd5da1882f96ad969261a18d2161ef3e0df8718f6` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/deepseek-harness-1.0.0.tar.gz) |
| `gemini-cli-1.0.0.tar.gz` | 1,403 B | `a6ac9215e5e1b2cf623d44ddf5d32115ab51796bbfc5c28d633127cb9ee4bf52` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/gemini-cli-1.0.0.tar.gz) |
| `github-copilot-1.0.0.tar.gz` | 1,441 B | `b7bf86d970c3c8982a1617f6b8467f854c586eb1cf0d79f98d8079147981ba69` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/github-copilot-1.0.0.tar.gz) |
| `hermes-agent-1.0.0.tar.gz` | 1,452 B | `e797054bf94aa3e6f65dd13f835180f6110a7047ff71ecfa0d9863ffc3a0c0da` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/hermes-agent-1.0.0.tar.gz) |
| `opencode-1.0.0.tar.gz` | 1,414 B | `6a7212e7f5edaf499024faf6087d48da5a0d5133304eac0a1de488446a84c58d` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/opencode-1.0.0.tar.gz) |
| `index.json` | 37,535 B | `990f5ba07dfe1fb97f0efec7752c8d42c776b5a57dc046e92ce58a3b3bb47b8f` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/index.json) |
| `SHA256SUMS` | 813 B | `9e5c7c9da3505da1577280c048282f787ebd624ed92dc85e128bd0b19c9664d2` | [Download](https://github.com/Rootx202/ProjectMind/releases/download/v1.0.0/SHA256SUMS) |

---

## 4. Test Verification Summary

The test runner (`node scripts/test.js`) executes 50 comprehensive tests across all domains:
- **Core Storage & Engine:** SQLite WAL, schema migrations, core memory isolation, 7-stage bootstrap.
- **MCP Server Protocol:** 22 structured tools over stdio JSON-RPC 2.0, parameter validation, size caps.
- **Agent Adapters:** Idempotent installation, configuration backup, verification checks, clean uninstallation.
- **End-to-End Scenarios (1-8):** Cold start, warm reuse, secret exclusion, prompt-mode planned->verified transitions, prompt injection sanitization, moved project self-healing.
- **Plugins & Runtime:** Manifest schema validation, checksum verification, registry resolution, portable runner.
- **Test Result:** **50 / 50 PASSED (100% Success Rate)**.
