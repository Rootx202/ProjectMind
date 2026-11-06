import * as fs from 'fs';
import * as path from 'path';

export type SupportedAgentId =
  | 'antigravity'
  | 'codex'
  | 'claude-code'
  | 'gemini-cli'
  | 'cursor'
  | 'github-copilot'
  | 'opencode'
  | 'hermes-agent'
  | 'deepseek-harness';

export interface AgentCapabilities {
  nativePlugin: boolean;
  mcpServer: boolean;
  agentSkills: boolean;
  lifecycleHooks: boolean;
  instructionFile: boolean;
  automaticInvocationMechanism: 'hooks_and_skills' | 'mcp_instructions_and_skills' | 'instructions_and_mcp';
  requiresRestartOnInstall: boolean;
  restartInstructions: string;
  officialDocsUrls: string[];
  documentedLimitations: string[];
}

export interface AdapterInstallOptions {
  mcpServerScriptPath?: string;
  backupDir?: string;
  /** Verified, atomically-installed plugin package directory (from the updater). */
  packageDir?: string;
  packageVersion?: string;
  scope?: 'project' | 'global';
  nonInteractive?: boolean;
}

interface ActivePluginAssets {
  instructions?: string;
  skill?: string;
}

let activePluginAssets: ActivePluginAssets = {};

/**
 * Activates content shipped inside a verified plugin archive. Adapters call
 * `getSkillContent()` / `getInstructionSnippet()` so a downloaded update can
 * genuinely change the integration files instead of silently re-generating
 * the built-in defaults.
 */
export function setActivePluginAssets(assets: ActivePluginAssets): void {
  activePluginAssets = { ...assets };
}

export function clearActivePluginAssets(): void {
  activePluginAssets = {};
}

export function getSkillContent(): string {
  return activePluginAssets.skill || CONCISE_SKILL_CONTENT;
}

export function getInstructionSnippet(): string {
  return activePluginAssets.instructions || CONCISE_INSTRUCTION_SNIPPET;
}

export function loadPluginAssets(packageDir: string): ActivePluginAssets {
  const assets: ActivePluginAssets = {};
  for (const [key, rel] of [
    ['instructions', path.join('assets', 'instructions.md')],
    ['skill', path.join('assets', 'SKILL.md')]
  ] as const) {
    const full = path.join(packageDir, rel);
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size <= 256 * 1024) {
        assets[key] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  return assets;
}

export interface AdapterInstallResult {
  agentId: SupportedAgentId;
  displayName: string;
  installed: boolean;
  filesCreatedOrUpdated: string[];
  backupsCreated: string[];
  requiresRestart: boolean;
  restartMessage: string;
  verification: AdapterVerifyResult;
}

export interface AdapterVerifyResult {
  agentId: SupportedAgentId;
  verified: boolean;
  checks: Array<{ name: string; passed: boolean; details: string }>;
}

export interface AdapterUninstallResult {
  agentId: SupportedAgentId;
  uninstalled: boolean;
  filesModifiedOrRemoved: string[];
}

export interface AdapterDisableResult {
  agentId: SupportedAgentId;
  disabled: boolean;
  filesModified: string[];
  message: string;
}

export interface AdapterEnableResult {
  agentId: SupportedAgentId;
  enabled: boolean;
  filesModified: string[];
  message: string;
}

export interface AdapterUpdateResult {
  agentId: SupportedAgentId;
  updated: boolean;
  filesUpdated: string[];
  backupsCreated: string[];
  verification: AdapterVerifyResult;
}

export interface AdapterRestoreResult {
  agentId: SupportedAgentId;
  restored: boolean;
  restoredFiles: string[];
  message: string;
}

export interface AgentAdapter {
  readonly agentId: SupportedAgentId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  detectEnvironment(projectRoot: string, homeDir?: string): { detected: boolean; reason: string };
  install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult;
  verify(projectRoot: string, options?: AdapterInstallOptions): AdapterVerifyResult;
  uninstall(projectRoot: string, options?: AdapterInstallOptions): AdapterUninstallResult;
  update?(projectRoot: string, options?: AdapterInstallOptions): AdapterUpdateResult;
  disable?(projectRoot: string): AdapterDisableResult;
  enable?(projectRoot: string): AdapterEnableResult;
  restoreBackup?(projectRoot: string, backupPath?: string): AdapterRestoreResult;
}

export const MARKDOWN_MARKER_START = '<!-- PROJECTMIND:START -->';
export const MARKDOWN_MARKER_END = '<!-- PROJECTMIND:END -->';
export const TOML_MARKER_START = '# BEGIN PROJECTMIND MCP';
export const TOML_MARKER_END = '# END PROJECTMIND MCP';

export const CONCISE_INSTRUCTION_SNIPPET = `${MARKDOWN_MARKER_START}
## ProjectMind — Automatic Project Intelligence
This repository uses **ProjectMind** for persistent project memory and selective context retrieval:
1. Before planning or coding a repository task, call \`get_relevant_context\` (or \`initialize_project\` if uninitialized) instead of scanning all files.
2. Before modifying shared modules or schemas, call \`get_module_context\` or \`analyze_change_impact\`.
3. After modifying, adding, renaming, or deleting files, call \`sync_changed_files\` (and \`record_architectural_decision\` when architectural choices are made).
4. Skip ProjectMind calls for general questions unrelated to this codebase.
${MARKDOWN_MARKER_END}`;

export const CONCISE_SKILL_CONTENT = `---
name: projectmind
description: >-
  Automatically retrieves persistent project architecture, module context, and dependency impact
  via ProjectMind MCP tools, and synchronizes project memory after code edits. Use whenever
  working on a software repository, planning a new project from a prompt, modifying modules,
  debugging, or making architectural decisions.
---
# ProjectMind — Automatic Project Intelligence Skill

1. **When to Use**: Use ProjectMind for any task involving this repository's architecture, modules, APIs, database models, or code edits. Skip for unrelated general questions.
2. **Initialization**: If \`get_project_status\` reports \`initialized: false\`, call \`initialize_project\` (\`mode: "existing"\` for existing codebases, or \`mode: "prompt"\` with \`promptText\` for new projects from specifications).
3. **Selective Retrieval**: Call \`get_relevant_context\` with \`taskDescription\` and optional \`targetFiles\`/\`targetModules\`. Never read every file in the repository manually.
4. **Impact & Sync**: Use \`analyze_change_impact\` for cross-module changes, and always call \`sync_changed_files\` after modifying files.
`;

export function backupFileBeforeModify(projectRoot: string, targetFilePath: string, customBackupDir?: string): string | null {
  if (!fs.existsSync(targetFilePath)) return null;
  const backupRoot = customBackupDir || path.join(projectRoot, '.projectmind', 'config-backups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const relName = path.relative(projectRoot, targetFilePath).replace(/[\\/]/g, '__');
  const backupPath = path.join(backupRoot, `${relName}.${Date.now()}.bak`);
  fs.copyFileSync(targetFilePath, backupPath);
  return backupPath;
}

export function upsertMarkdownBlockIdempotent(filePath: string, blockContent: string = getInstructionSnippet()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, blockContent + '\n', 'utf8');
    return;
  }
  const existing = fs.readFileSync(filePath, 'utf8');
  const startIdx = existing.indexOf(MARKDOWN_MARKER_START);
  const endIdx = existing.indexOf(MARKDOWN_MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const updated = existing.slice(0, startIdx) + blockContent + existing.slice(endIdx + MARKDOWN_MARKER_END.length);
    fs.writeFileSync(filePath, updated, 'utf8');
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(filePath, existing + sep + blockContent + '\n', 'utf8');
  }
}

export function removeMarkdownBlockIdempotent(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, 'utf8');
  const startIdx = existing.indexOf(MARKDOWN_MARKER_START);
  const endIdx = existing.indexOf(MARKDOWN_MARKER_END);
  if (startIdx === -1 || endIdx === -1) return false;
  const cleaned = (existing.slice(0, startIdx) + existing.slice(endIdx + MARKDOWN_MARKER_END.length)).replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) fs.rmSync(filePath, { force: true });
  else fs.writeFileSync(filePath, cleaned + '\n', 'utf8');
  return true;
}

export function readJsonSafe(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return {}; }
}

export function writeJsonPretty(filePath: string, data: Record<string, any>): void {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tmpPath, resolvedPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
}

export function updateJsonPreservingUnrelated(
  filePath: string,
  updater: (existing: Record<string, any>) => Record<string, any>
): Record<string, any> {
  const resolvedPath = path.resolve(filePath);
  let existing: Record<string, any> = {};

  if (fs.existsSync(resolvedPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch (_) {
      existing = {};
    }
  }

  const updated = updater(existing);
  writeJsonPretty(resolvedPath, updated);
  return updated;
}

export function writeHookRunnerScript(
  projectRoot: string,
  agentId: SupportedAgentId | string,
  sdkDistPath?: string
): string {
  const hookDir = path.join(projectRoot, '.projectmind', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n', 'utf8');

  const scriptPath = path.join(hookDir, `${agentId}-hook.js`);
  const cjsScriptPath = path.join(hookDir, `${agentId}-hook.cjs`);

  // Completely portable Node.js hook wrapper:
  // - Resolves ProjectMind runtime dynamically via PROJECTMIND_HOME, standard module resolution, or parent directories
  // - Resolves target project root dynamically via PROJECTMIND_PROJECT_ROOT, agent payload, or cwd
  // - Never embeds hardcoded machine or developer paths
  const content = `#!/usr/bin/env node
/**
 * ProjectMind Portable Lifecycle Hook Wrapper
 * Agent: ${agentId}
 * No machine-specific or developer-specific absolute paths are embedded.
 */
const fs = require('node:fs');
const path = require('node:path');

const eventName = process.argv[2] || 'SessionStart';
const agentId = '${agentId}';

let input = '';
try {
  if (!process.stdin.isTTY) {
    input = fs.readFileSync(0, 'utf8');
  }
} catch (e) {}

function resolveProjectMindRuntime() {
  if (process.env.PROJECTMIND_HOME && fs.existsSync(process.env.PROJECTMIND_HOME)) {
    const cand = path.join(process.env.PROJECTMIND_HOME, 'packages', 'agent-sdk', 'dist', 'index.js');
    if (fs.existsSync(cand)) return cand;
    const candRoot = path.join(process.env.PROJECTMIND_HOME, 'dist', 'index.js');
    if (fs.existsSync(candRoot)) return candRoot;
  }
  try {
    return require.resolve('@projectmind/agent-sdk');
  } catch (_) {}

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

  const resolvedRoot = resolveTargetProjectRoot(parsed);
  const { SmartAutoModeEngine } = require(sdkPath);
  const out = SmartAutoModeEngine.handleHookStdin(agentId, eventName, input, resolvedRoot);
  process.stdout.write(JSON.stringify(out || {}) + '\\n');
} catch (err) {
  process.stderr.write('[ProjectMind Hook Error] ' + (err && err.message ? err.message : String(err)) + '\\n');
  process.stdout.write('{}\\n');
}
process.exit(0);
`;

  fs.writeFileSync(scriptPath, content, 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  fs.writeFileSync(cjsScriptPath, content, 'utf8');
  fs.chmodSync(cjsScriptPath, 0o755);

  return scriptPath;
}
