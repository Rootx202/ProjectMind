# ProjectMind Installation Guide

This document provides complete instructions for installing, configuring, verifying, and removing ProjectMind and its 9 AI coding agent plugins across Linux, macOS, and Windows.

---

## 1. System Requirements

* **Node.js**: `v18.0.0` or higher (Active LTS or Current recommended).
* **Operating Systems**:
  * **Linux**: Ubuntu 20.04+, Debian 11+, Fedora 38+, Arch, Kali Linux, Alpine 3.18+.
  * **macOS**: macOS 12 (Monterey) or higher (Apple Silicon & Intel).
  * **Windows**: Windows 10, Windows 11, Windows Server 2019+ (x64 / ARM64).
* **Package Managers**: npm `v9+`, pnpm `v8+`, or yarn `v1.22+` (optional for monorepo development).
* **Disk Space**: ~50 MB for core runtime and dependencies.

---

## 2. Quick Install (POSIX / Linux / macOS)

Using the automated POSIX installation script:

```bash
# Install ProjectMind CLI and runtime locally
./install.sh

# Or install remotely via curl
curl -fsSL https://raw.githubusercontent.com/Rootx202/ProjectMind/main/install.sh | bash
```

### Script Options

```bash
# Install a specific agent plugin (e.g. Antigravity or OpenCode)
./install.sh --agent antigravity

# Install all 9 agent plugins
./install.sh --all

# Custom installation directory and binary path
./install.sh --prefix /opt/projectmind --bin-dir /usr/local/bin

# Dry-run preview without touching filesystem
./install.sh --dry-run
```

---

## 3. Quick Install (Windows PowerShell)

Run in PowerShell 5.1 or PowerShell 7+:

```powershell
# Run the Windows installation script
.\install.ps1

# Or run non-interactively
PowerShell -ExecutionPolicy Bypass -File .\install.ps1 -Agent antigravity
```

### Windows Script Parameters

```powershell
# Install a specific agent
.\install.ps1 -Agent cursor

# Install all 9 supported agents
.\install.ps1 -All

# Custom target directory
.\install.ps1 -InstallDir "C:\Tools\ProjectMind" -BinDir "C:\Tools\ProjectMind\bin"

# Dry-run mode
.\install.ps1 -DryRun
```

---

## 4. Manual Installation via Monorepo

If developing or building directly from source:

```bash
# 1. Clone the repository
git clone https://github.com/Rootx202/ProjectMind.git
cd ProjectMind

# 2. Build the packages and compile TypeScript
node scripts/build.js

# 3. Verify the installation with test suite (89 tests)
node scripts/test.js

# 4. Link binary globally (optional)
npm link
# or add ./apps/cli/dist/index.js to your PATH
```

---

## 5. Agent Plugin Management CLI

ProjectMind provides a unified `plugin` CLI for managing agent integrations independently:

### List Available Plugins
```bash
projectmind plugin list
# Machine-readable JSON output:
projectmind plugin list --json
```

### Search Plugins
```bash
projectmind plugin search opencode
projectmind plugin search mcp
```

### Install Plugins
```bash
# Install a single agent plugin
projectmind plugin install antigravity

# Install multiple agents
projectmind plugin install claude-code,cursor,codex

# Install all 9 supported agents
projectmind plugin install --all

# Non-interactive mode (for scripts & CI/CD)
projectmind plugin install antigravity --yes
```

### Verify Plugin Health
```bash
# Verify a specific plugin
projectmind plugin verify antigravity

# Verify all installed plugins
projectmind plugin verify --all
```

### Update Plugin Configurations
```bash
# Regenerate MCP configs, rules, and hook runners
projectmind plugin update antigravity
projectmind plugin update --all
```

### Temporarily Disable an Adapter
```bash
# Disables ProjectMind in the agent's config without deleting files
projectmind plugin disable antigravity
```

### Re-Enable a Disabled Adapter
```bash
projectmind plugin enable antigravity
```

### Clean Uninstall
```bash
# Uninstalls agent-specific configs, rules, and hook runners
projectmind plugin uninstall antigravity

# Uninstall all agent plugins
projectmind plugin uninstall --all
```

> [!IMPORTANT]
> **Non-Destructive Memory Guarantee**: Uninstalling agent plugins removes configuration files (`.mcp.json`, `opencode.json`, hooks) but **never** deletes or corrupts your project's SQLite knowledge base in `.projectmind/`. Your project intelligence remains safe and persistent.

---

## 6. System Health Check (`doctor`)

To check environment compatibility, runtime resolution, filesystem permissions, and adapter statuses at any time:

```bash
projectmind plugin doctor
# or
projectmind doctor
```

Example output:
```text
ProjectMind Plugin Diagnostics
===============================
Project Root: /home/user/my-project
Platform:     linux
Node.js:      Node.js v20.10.0 (requires >= 18.0.0)
Runtime:      node_module_resolution (/usr/local/lib/node_modules/projectmind)
Filesystem:   Read/Write verified
System Status: ✓ HEALTHY

Adapters:
  ✓ Google Antigravity (antigravity): Installed [3/3 checks]
  ✓ OpenAI Codex (codex): Installed [3/3 checks]
  ✓ Anthropic Claude Code (claude-code): Installed [4/4 checks]
  ✓ Google Gemini CLI (gemini-cli): Installed [3/3 checks]
  ✓ Cursor IDE & Agent CLI (cursor): Installed [3/3 checks]
  ✓ GitHub Copilot (github-copilot): Installed [3/3 checks]
  ✓ OpenCode (opencode): Installed [3/3 checks]
  ✓ Hermes Agent (hermes-agent): Installed [3/3 checks]
  ✓ DeepSeek Harness (deepseek-harness): Installed [3/3 checks]
```

---

## 7. Air-Gapped & Offline Installation

ProjectMind is 100% local-first and operates without internet connectivity:

1. Download release archives from GitHub Releases:
   * `projectmind-v1.1.0.tar.gz` (core runtime)
   * `.release/*.tar.gz` (core + plugin bundles)
   * `.release/SHA256SUMS`
2. Verify integrity:
   ```bash
   sha256sum -c SHA256SUMS
   ```
3. Unpack into target machine:
   ```bash
   tar -xzf projectmind-v1.1.0.tar.gz -C ~/.projectmind
   ```
4. Set `PROJECTMIND_HOME`:
   ```bash
   export PROJECTMIND_HOME="$HOME/.projectmind"
   export PATH="$PROJECTMIND_HOME/bin:$PATH"
   ```
5. Install plugins locally without internet access:
   ```bash
   projectmind plugin install antigravity --project-root /path/to/project
   ```

