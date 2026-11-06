# ProjectMind Plugin Development Guide

This guide explains how to develop, test, and maintain agent adapters and plugins for the ProjectMind platform using `@projectmind/plugin-sdk`.

---

## 1. Architecture of a ProjectMind Plugin

A ProjectMind plugin bridges an AI coding agent (IDE, CLI, or autonomous loop) with the ProjectMind core intelligence engine.

```text
+-----------------------------------------------------------+
|                      Coding Agent                         |
|  (Antigravity / Claude Code / Cursor / OpenCode / etc.)   |
+-------------+-------------------------------+-------------+
              |                               |
       MCP JSON-RPC 2.0                 Lifecycle Hook
       (STDIO Transport)               (STDIN / STDOUT)
              |                               |
+-------------v-------------------------------v-------------+
|               ProjectMind Plugin Integration             |
|  • manifest.json (Manifest specification & permissions)   |
|  • portable-hook.js (Non-blocking stdin / stderr logging) |
|  • rules/AGENTS.md (Selective context retrieval policy)   |
|  • skills/projectmind (Agent capability skill bundle)     |
+-----------------------------+-----------------------------+
                              |
+-----------------------------v-----------------------------+
|                 @projectmind/plugin-sdk                   |
|  • RuntimeResolver    • ConfigWriter     • Registry       |
|  • PortableHookRunner • ManifestValidator• OS Paths       |
+-----------------------------------------------------------+
```

---

## 2. The Plugin SDK (`@projectmind/plugin-sdk`)

ProjectMind provides a shared, cross-platform SDK for plugin authoring:

### Key Classes

* **`RuntimeResolver`**:
  Resolves the ProjectMind runtime without hardcoding machine-specific paths:
  ```ts
  import { RuntimeResolver } from '@projectmind/plugin-sdk';
  const runtime = RuntimeResolver.resolveRuntime();
  console.log(runtime.sdkEntryPath, runtime.mcpServerCliPath);
  ```

* **`ConfigWriter`**:
  Atomic, crash-safe file writer that preserves existing unrelated user settings:
  ```ts
  import { ConfigWriter } from '@projectmind/plugin-sdk';

  // Safely update JSON without destroying existing properties
  ConfigWriter.updateJsonPreservingUnrelated(configPath, (data) => {
    data.mcpServers = data.mcpServers || {};
    data.mcpServers.projectmind = { command: 'node', args: [mcpPath] };
    return data;
  });

  // Safely upsert markdown instructions
  ConfigWriter.upsertManagedSectionAtomic(rulesPath, '<!-- START -->', '<!-- END -->', block);
  ```

* **`PortableHookRunner`**:
  Safe stdin reading, JSON parsing, timeout handling, and diagnostic logging:
  ```ts
  import { PortableHookRunner } from '@projectmind/plugin-sdk';

  const script = PortableHookRunner.generatePortableHookScript('opencode');
  ```

* **`ManifestValidator`**:
  Validates plugin metadata against `plugins/manifest.schema.json`.

---

## 3. Implementing an Agent Adapter

Every agent adapter implements the `EnhancedAgentAdapter` interface:

```ts
import {
  AgentAdapter,
  SupportedAgentId,
  AdapterInstallOptions,
  AdapterInstallResult,
  AdapterVerifyResult,
  AdapterUninstallResult,
  AgentDetectionResult
} from '@projectmind/agent-sdk';

export class MyNewAgentAdapter implements AgentAdapter {
  public readonly agentId: SupportedAgentId = 'my-agent' as any;
  public readonly displayName = 'My Custom Agent';

  public detectEnvironment(projectRoot: string, homeDir?: string): AgentDetectionResult {
    // Detect whether this agent is used in the workspace
    const hasConfig = fs.existsSync(path.join(projectRoot, '.my-agent'));
    return { detected: hasConfig, reason: hasConfig ? 'Found .my-agent config' : 'Not detected' };
  }

  public install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult {
    // 1. Backup target files
    // 2. Configure MCP server
    // 3. Configure rules / skills
    // 4. Configure hooks
    return {
      agentId: this.agentId,
      installed: true,
      filesCreatedOrUpdated: ['.my-agent/mcp.json'],
      backupsCreated: [],
      verification: this.verify(projectRoot, options)
    };
  }

  public verify(projectRoot: string, options?: AdapterInstallOptions): AdapterVerifyResult {
    // Run verification checks
    return {
      agentId: this.agentId,
      verified: true,
      checks: [{ name: 'MCP Config', passed: true, details: 'Verified' }]
    };
  }

  public uninstall(projectRoot: string, options?: AdapterInstallOptions): AdapterUninstallResult {
    // Cleanly remove agent config while PRESERVING .projectmind project memory!
    return {
      agentId: this.agentId,
      uninstalled: true,
      filesRemoved: ['.my-agent/mcp.json']
    };
  }
}
```

---

## 4. Hook Development Best Practices

1. **Never Pollute `stdout`**:
   Agents like Claude Code and Gemini CLI parse `stdout` as JSON. Writing plain text logs to `stdout` breaks the agent's JSON-RPC parser. All diagnostic logs must be written to `stderr` (`process.stderr.write(...)`).
2. **Handle ESM vs CommonJS**:
   If a user's repository has `"type": "module"` in `package.json`, standard `.js` hook scripts using `require()` will crash. Use dual `.js` and `.cjs` files, and place `{ "type": "commonjs" }` in `.projectmind/hooks/package.json`.
3. **Fail Open**:
   If ProjectMind encounters an unexpected error or database lock during hook execution, it must fail safely without blocking or terminating the developer's agent session.
4. **Configurable Timeouts**:
   Never allow hook execution to hang indefinitely. Use a 5000ms timeout guard on stdin reads.

---

## 5. Adding Manifest and Validation

Create `plugins/<agent-id>/manifest.json`:

```json
{
  "$schema": "../manifest.schema.json",
  "id": "my-agent",
  "name": "ProjectMind for My Custom Agent",
  "version": "1.1.0",
  "description": "Project intelligence and MCP integration for My Custom Agent.",
  "publisher": {
    "name": "Rootx202 (ProjectMind)",
    "url": "https://github.com/Rootx202/ProjectMind"
  },
  "supportedPlatforms": ["linux", "windows", "darwin"],
  "supportedAgentVersions": ">= 1.1.0",
  "runtimeRequirements": {
    "node": ">= 18.0.0",
    "projectmind": ">= 1.1.0"
  },
  "capabilities": {
    "mcpTransport": "stdio",
    "nativePlugin": true,
    "mcpServer": true,
    "agentSkills": true,
    "lifecycleHooks": true,
    "instructionFile": true,
    "automaticInvocationMechanism": "hooks_and_skills",
    "reloadSupport": "hot_reload",
    "requiresRestartOnInstall": false,
    "restartInstructions": "Reload your agent workspace.",
    "officialDocsUrls": ["https://my-agent.example.com/docs"],
    "documentedLimitations": []
  },
  "permissions": {
    "filesystem": [".my-agent", ".projectmind"],
    "network": false,
    "executeCommands": true,
    "readEnv": true
  },
  "installationInstructions": "Run `projectmind plugin install my-agent`",
  "removalInstructions": "Run `projectmind plugin uninstall my-agent`"
}
```

Validate with the test suite:
```bash
node scripts/build.js && node scripts/test.js
```

