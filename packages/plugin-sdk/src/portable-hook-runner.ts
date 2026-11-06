import * as fs from 'node:fs';
import * as path from 'node:path';
import { SupportedAgentId } from '@projectmind/agent-sdk';
import { RuntimeResolver } from './runtime-resolver';

export interface HookExecutionOptions {
  agentId: SupportedAgentId | string;
  eventName: string;
  stdinData?: string;
  fallbackProjectRoot?: string;
  timeoutMs?: number;
}

export class PortableHookRunner {
  public static async readStdinSafe(timeoutMs = 5000): Promise<string> {
    if (process.stdin.isTTY) return '';

    return new Promise((resolve) => {
      let data = '';
      let finished = false;

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          process.stderr.write(`[ProjectMind Hook] Stdin read timed out after ${timeoutMs}ms; continuing with partial buffer.\n`);
          resolve(data);
        }
      }, timeoutMs);

      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve(data);
        }
      });
      process.stdin.on('error', (err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          process.stderr.write(`[ProjectMind Hook] Error reading stdin: ${err.message}\n`);
          resolve(data);
        }
      });
    });
  }

  public static executeHookSync(options: HookExecutionOptions): Record<string, unknown> {
    const { agentId, eventName, stdinData = '', fallbackProjectRoot } = options;

    let parsedPayload: Record<string, unknown> = {};
    if (stdinData.trim()) {
      try {
        parsedPayload = JSON.parse(stdinData.trim());
      } catch (err) {
        process.stderr.write(`[ProjectMind Hook Warning] Malformed JSON payload received for event "${eventName}": ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    try {
      const payloadRoot =
        (typeof parsedPayload.cwd === 'string' && parsedPayload.cwd) ||
        (Array.isArray(parsedPayload.workspace_roots) && typeof parsedPayload.workspace_roots[0] === 'string' && parsedPayload.workspace_roots[0]) ||
        (typeof parsedPayload.project_root === 'string' && parsedPayload.project_root) ||
        undefined;

      const projectRoot = RuntimeResolver.resolveTargetProjectRoot({
        explicitRoot: fallbackProjectRoot,
        payloadRoot,
        agentEnvRoot:
          process.env.OPENCODE_PROJECT_DIR ||
          process.env.CLAUDE_PROJECT_DIR ||
          process.env.CURSOR_PROJECT_DIR ||
          process.env.GEMINI_PROJECT_DIR ||
          process.env.HERMES_PROJECT_DIR ||
          process.env.DSH_PROJECT_DIR
      });

      const runtime = RuntimeResolver.resolveRuntime();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdkModule = require(runtime.sdkEntryPath);
      const SmartAutoModeEngine = sdkModule.SmartAutoModeEngine;

      if (!SmartAutoModeEngine || typeof SmartAutoModeEngine.handleHookStdin !== 'function') {
        throw new Error(`SmartAutoModeEngine.handleHookStdin is missing in runtime at ${runtime.sdkEntryPath}`);
      }

      const out = SmartAutoModeEngine.handleHookStdin(
        agentId,
        eventName,
        stdinData,
        projectRoot
      );

      return out || {};
    } catch (err) {
      process.stderr.write(`[ProjectMind Hook Error] Failed to dispatch hook event "${eventName}" for agent "${agentId}": ${err instanceof Error ? err.message : String(err)}\n`);
      return {};
    }
  }

  /**
   * Generates a completely portable, standalone Node.js hook runner script
   * with ZERO hardcoded machine paths.
   */
  public static generatePortableHookScript(agentId: SupportedAgentId): string {
    return `#!/usr/bin/env node
/**
 * ProjectMind Portable Lifecycle Hook Wrapper
 * Agent: ${agentId}
 * Generated automatically by ProjectMind.
 * No machine-specific or developer-specific absolute paths are embedded.
 */
const fs = require('node:fs');
const path = require('node:path');

const eventName = process.argv[2] || 'SessionStart';
const agentId = '${agentId}';

// Read stdin safely (non-blocking if TTY or empty)
let input = '';
try {
  if (!process.stdin.isTTY) {
    input = fs.readFileSync(0, 'utf8');
  }
} catch (e) {
  // Stdin unavailable or empty; continue with empty payload
}

function resolveProjectMindRuntime() {
  // 1. Explicit PROJECTMIND_HOME
  if (process.env.PROJECTMIND_HOME && fs.existsSync(process.env.PROJECTMIND_HOME)) {
    const cand = path.join(process.env.PROJECTMIND_HOME, 'packages', 'agent-sdk', 'dist', 'index.js');
    if (fs.existsSync(cand)) return cand;
    const candRoot = path.join(process.env.PROJECTMIND_HOME, 'dist', 'index.js');
    if (fs.existsSync(candRoot)) return candRoot;
  }

  // 2. Standard node module resolution
  try {
    return require.resolve('@projectmind/agent-sdk');
  } catch (_) {}

  // 3. Search up from current script directory for ProjectMind installation or repo
  let curr = path.resolve(__dirname);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(curr, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'projectmind' || pkg.name === '@projectmind/agent-sdk') {
          const cand = path.join(curr, 'packages', 'agent-sdk', 'dist', 'index.js');
          if (fs.existsSync(cand)) return cand;
          const distCand = path.join(curr, 'dist', 'index.js');
          if (fs.existsSync(distCand)) return distCand;
        }
      } catch (_) {}
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  // 4. Check known OS global directories
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const globalCandidates = [
    path.join(home, '.local', 'share', 'projectmind', 'packages', 'agent-sdk', 'dist', 'index.js'),
    path.join(home, '.local', 'share', 'projectmind', 'dist', 'index.js'),
    path.join(process.env.LOCALAPPDATA || '', 'ProjectMind', 'data', 'packages', 'agent-sdk', 'dist', 'index.js')
  ];
  for (const g of globalCandidates) {
    if (fs.existsSync(g)) return g;
  }

  return null;
}

function resolveTargetProjectRoot(parsedPayload) {
  if (process.env.PROJECTMIND_PROJECT_ROOT) {
    return path.resolve(process.env.PROJECTMIND_PROJECT_ROOT);
  }
  if (parsedPayload && typeof parsedPayload.cwd === 'string' && parsedPayload.cwd) {
    return path.resolve(parsedPayload.cwd);
  }
  if (parsedPayload && Array.isArray(parsedPayload.workspace_roots) && parsedPayload.workspace_roots[0]) {
    return path.resolve(parsedPayload.workspace_roots[0]);
  }
  const agentEnv = process.env.OPENCODE_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CURSOR_PROJECT_DIR ||
    process.env.GEMINI_PROJECT_DIR ||
    process.env.HERMES_PROJECT_DIR ||
    process.env.DSH_PROJECT_DIR;
  if (agentEnv) return path.resolve(agentEnv);

  // Walk up from script dir looking for project root (.projectmind or markers)
  let curr = path.resolve(__dirname, '..', '..');
  return curr;
}

try {
  let parsed = {};
  if (input.trim()) {
    try { parsed = JSON.parse(input.trim()); } catch (err) {
      process.stderr.write('[ProjectMind Hook Warning] Invalid JSON on stdin: ' + err.message + '\\n');
    }
  }

  const sdkPath = resolveProjectMindRuntime();
  if (!sdkPath) {
    process.stderr.write('[ProjectMind Hook Warning] ProjectMind runtime not found. Set PROJECTMIND_HOME if installed in a custom location.\\n');
    process.stdout.write('{}\\n');
    process.exit(0);
  }

  const projectRoot = resolveTargetProjectRoot(parsed);
  const { SmartAutoModeEngine } = require(sdkPath);
  const out = SmartAutoModeEngine.handleHookStdin(agentId, eventName, input, projectRoot);
  process.stdout.write(JSON.stringify(out || {}) + '\\n');
} catch (err) {
  process.stderr.write('[ProjectMind Hook Error] ' + (err && err.message ? err.message : String(err)) + '\\n');
  process.stdout.write('{}\\n');
}
process.exit(0);
`;
  }
}

