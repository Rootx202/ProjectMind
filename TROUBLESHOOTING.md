# ProjectMind Troubleshooting & Diagnostic Guide

This guide provides step-by-step diagnostic workflows and solutions for common issues when using ProjectMind with AI coding agents.

---

## 1. Quick Diagnostics Workflow

Whenever you encounter unexpected behavior, run the built-in diagnostic doctor:

```bash
# Full environment and adapter health check
projectmind plugin doctor

# In JSON format for automated analysis
projectmind plugin doctor --json
```

Verify the specific agent adapter:
```bash
projectmind plugin verify antigravity
projectmind plugin verify opencode
projectmind plugin verify --all
```

---

## 2. Common Issues & Solutions

### Issue 1: Agent Does Not See ProjectMind MCP Tools
**Symptoms**: The agent operates normally but claims ProjectMind MCP tools (`get_relevant_context`, `initialize_project`, etc.) are unavailable.

**Causes & Solutions**:
1. **Agent Session Not Reloaded**:
   * **Antigravity**: Run `/mcp` or start a new chat.
   * **Claude Code**: Run `/mcp` or restart session.
   * **Cursor**: Open Command Palette -> `Cursor: Restart MCP Servers`.
   * **Codex**: Restart Codex CLI or IDE session.
   * **OpenCode**: OpenCode auto-reloads `opencode.json`.
2. **Project Workspace Trust**:
   * In VS Code or Cursor, ensure the workspace is in **Trusted** mode. Untrusted workspaces disable MCP servers for security.
3. **Invalid or Missing Node Path**:
   * Ensure `node` is available in your system `$PATH` when launched from GUI environments.

---

### Issue 2: `ReferenceError: require is not defined in ES module scope`
**Symptoms**: When a hook executes, Node.js throws a module syntax error.

**Cause**:
The user's project contains `"type": "module"` in `package.json`, causing Node.js to interpret `.projectmind/hooks/*.js` as ES Modules rather than CommonJS.

**Solution**:
Run the adapter update command:
```bash
projectmind plugin update <agent-id>
```
ProjectMind automatically writes:
* `.projectmind/hooks/package.json` with `{ "type": "commonjs" }`.
* Generates dual `.js` and `.cjs` hook runner scripts that execute cleanly regardless of parent package type.

---

### Issue 3: Antigravity `Stop hook blocked termination`
**Symptoms**: Google Antigravity displays an error or continues prompting after task completion.

**Cause**:
Antigravity's hook specification interprets `{ "decision": "continue" }` from a `Stop` hook as an instruction to prevent process termination.

**Solution**:
ProjectMind returns `{}` on `Stop` hooks after synchronizing changed files, allowing Antigravity to terminate cleanly. Update your hook runner:
```bash
projectmind plugin update antigravity
```

---

### Issue 4: Database Busy or Locked (`SQLITE_BUSY` / `EBUSY`)
**Symptoms**: `Error: SQLITE_BUSY: database is locked` during concurrent indexing or hook execution.

**Solutions**:
1. ProjectMind uses SQLite Write-Ahead Logging (WAL) with automatic busy timeouts (5000ms).
2. Check if another terminal session is running an intensive bootstrap index.
3. On Windows: Add an antivirus exclusion for `<project-root>\.projectmind\projectmind.db` to prevent Defender from holding lock handles.

---

### Issue 5: Restoring Configuration from Automatic Backups
**Symptoms**: An accidental edit modified an agent's configuration file.

**Solution**:
Before ProjectMind modifies any configuration file, it creates a timestamped backup in `.projectmind/config-backups/`:

```bash
# Check available backups
ls -la .projectmind/config-backups/

# Restore the most recent backup
# Files are named: <relative-path-sanitized>.<timestamp>.bak
```

Or copy the backup directly back over the target file:
```bash
cp .projectmind/config-backups/.mcp.json.*.bak .mcp.json
```

---

### Issue 6: Re-Indexing After Large Git Branch Merge or Rebase
**Symptoms**: Git branch switched across hundreds of commits, and context feels stale.

**Solution**:
Run incremental synchronization:
```bash
projectmind sync
```
Or force a full re-scan:
```bash
projectmind init
```

---

## 3. Recovery Commands Summary

| Goal | Command |
| :--- | :--- |
| **Check System Diagnostics** | `projectmind doctor` |
| **Verify Agent Integration** | `projectmind plugin verify <agent>` |
| **Regenerate Configs & Hooks**| `projectmind plugin update <agent>` |
| **Sync Incremental Changes** | `projectmind sync` |
| **Clean Uninstall Adapter**  | `projectmind plugin uninstall <agent>` |
| **Full Health Check**        | `projectmind plugin doctor` |

