#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTMIND_VERSION } from '@projectmind/shared';
import { ProjectIdentityManager } from '@projectmind/core';
import { SmartAutoModeEngine, SupportedAgentId } from '@projectmind/agent-sdk';
import { ProjectMindMcpServer } from '@projectmind/mcp-server';
import { SetupManager } from '@projectmind/setup';
import { RuntimeResolver } from '@projectmind/plugin-sdk';

const ALL_AGENT_IDS: SupportedAgentId[] = [
  'antigravity',
  'claude-code',
  'codex',
  'cursor',
  'gemini-cli',
  'github-copilot',
  'deepseek-harness',
  'hermes-agent',
  'opencode'
];

function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ? r[i].length : 0)))
  );
  const pad = (str: string, len: number) => str + ' '.repeat(Math.max(0, len - str.length));

  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join('  ');
  const separatorLine = colWidths.map((w) => '-'.repeat(w)).join('  ');
  const dataLines = rows.map((r) => r.map((c, i) => pad(c || '', colWidths[i])).join('  '));

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

export function runCli(argv: string[]): { exitCode: number; output: string } {
  const args = argv.slice(2);
  const command = (args[0] || 'help').toLowerCase();

  const getFlagValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-') ? args[idx + 1] : undefined;
  };

  const hasFlag = (...flags: string[]): boolean => {
    return flags.some((f) => args.includes(f));
  };

  const isJson = hasFlag('--json');

  // Resolve target project root with safety guards
  const explicitRoot = getFlagValue('--project-root');
  let projectRoot: string;
  try {
    projectRoot = RuntimeResolver.resolveTargetProjectRoot({
      explicitRoot,
      cwd: process.cwd()
    });
  } catch (_) {
    projectRoot = ProjectIdentityManager.detectProjectRoot(explicitRoot || process.cwd());
  }

  const setup = new SetupManager();

  try {
    switch (command) {
      case 'version':
      case '--version':
      case '-v': {
        if (isJson) {
          return { exitCode: 0, output: JSON.stringify({ version: PROJECTMIND_VERSION, name: 'projectmind' }, null, 2) };
        }
        return { exitCode: 0, output: `ProjectMind v${PROJECTMIND_VERSION}` };
      }

      case 'help':
      case '--help':
      case '-h': {
        const helpText = `ProjectMind v${PROJECTMIND_VERSION} — Universal Local-First AI Project Intelligence

Usage:
  projectmind <command> [options]

Core Commands:
  init                       Initialize ProjectMind memory in the current or target project
  status                     Show ProjectMind index and memory status
  sync                       Synchronize incremental file changes to project memory
  context <task>             Retrieve smart project context for a task
  search <query>             Search project architecture knowledge base
  doctor                     Run system and environment diagnostic health checks
  health                     Show storage health, event-chain integrity, and index manifest
  manifest                   Show the index manifest and entity counts
  memory events              Show the append-only memory event log
  memory conflicts           Show open optimistic-concurrency conflicts

Update & Upgrade Commands:
  update check               Check for ProjectMind Core engine updates on GitHub
  update                     Update ProjectMind Core engine to latest version
  upgrade check              Alias for 'update check'
  upgrade                    Alias for 'update'

Plugin Commands:
  plugin list                List all available agent plugins and installation status
  plugin status              Display detailed status for all plugins
  plugin outdated            Check for available plugin updates on GitHub
  plugin search <query>      Search available plugins by keyword
  plugin install <agent>     Install an agent plugin (e.g. antigravity, opencode, cursor)
                             Options: --all, --scope <project|global>, --yes
  plugin verify <agent>      Verify adapter installation and configuration integrity
  plugin update <agent>      Update plugin from GitHub Releases (--all supported)
  plugin disable <agent>     Temporarily disable an adapter in configuration
  plugin enable <agent>      Re-enable a previously disabled adapter
  plugin uninstall <agent>   Uninstall an adapter (preserves .projectmind database)
  plugin doctor              Run comprehensive plugin and runtime environment diagnostics

Options:
  --project-root <path>      Specify the target project directory (default: detected root or cwd)
  --json                     Output results in machine-readable JSON format
  --all                      Apply action to all supported agent plugins
  --yes                      Run non-interactively without confirmation prompts
  --scope <project|global>   Target installation scope (default: project)

Supported Agents:
  antigravity, claude-code, codex, cursor, gemini-cli, github-copilot,
  deepseek-harness, hermes-agent, opencode
`;
        return { exitCode: 0, output: helpText };
      }

      case 'plugin': {
        const subCommand = (args[1] || 'list').toLowerCase();
        const subArg = args[2] && !args[2].startsWith('-') ? args[2] : undefined;
        const allFlag = hasFlag('--all');
        const scope = (getFlagValue('--scope') as 'project' | 'global') || 'project';

        switch (subCommand) {
          case 'list': {
            const plugins = setup.listPlugins(projectRoot);
            if (isJson) {
              return { exitCode: 0, output: JSON.stringify(plugins, null, 2) };
            }
            const headers = ['ID', 'Agent Name', 'Version', 'Installed', 'Detected', 'Capabilities'];
            const rows = plugins.map((p) => [
              p.id,
              p.displayName,
              p.version,
              p.installed ? '✓ Yes' : '✗ No',
              p.detected ? '✓ Yes' : '  No',
              [
                (p.capabilities.lifecycleHooks || (p.capabilities as any).hooks) ? 'hooks' : '',
                (p.capabilities.mcpServer || (p.capabilities as any).mcp) ? 'mcp' : '',
                (p.capabilities.instructionFile || (p.capabilities as any).rules) ? 'rules' : '',
                (p.capabilities.agentSkills || (p.capabilities as any).skills) ? 'skills' : ''
              ]
                .filter(Boolean)
                .join(', ')
            ]);
            return {
              exitCode: 0,
              output: `ProjectMind Plugins (Project: ${projectRoot})\n\n` + formatTable(headers, rows)
            };
          }

          case 'status': {
            const plugins = setup.listPlugins(projectRoot);
            if (isJson) {
              return { exitCode: 0, output: JSON.stringify({ projectRoot, plugins }, null, 2) };
            }
            const headers = ['Agent ID', 'Status', 'Detected', 'Version'];
            const rows = plugins.map((p) => [
              p.id,
              p.installed ? 'Installed & Active' : 'Not Installed',
              p.detected ? 'Detected' : 'Not Found',
              p.version
            ]);
            return {
              exitCode: 0,
              output: `Plugin Status for ${projectRoot}:\n\n` + formatTable(headers, rows)
            };
          }

          case 'search': {
            const query = subArg || getFlagValue('--query') || args.slice(2).filter((a) => !a.startsWith('-')).join(' ');
            if (!query) {
              return { exitCode: 1, output: isJson ? JSON.stringify({ error: 'Search query required.' }) : 'Error: Please specify a search query, e.g. projectmind plugin search cursor' };
            }
            const results = setup.searchPlugins(query);
            if (isJson) {
              return { exitCode: 0, output: JSON.stringify(results, null, 2) };
            }
            if (results.length === 0) {
              return { exitCode: 0, output: `No plugins matched query: "${query}"` };
            }
            const headers = ['ID', 'Name', 'Version', 'Description'];
            const rows = results.map((r) => [r.id, r.displayName, r.version, r.description]);
            return {
              exitCode: 0,
              output: `Search results for "${query}":\n\n` + formatTable(headers, rows)
            };
          }

          case 'install': {
            let targetAgents: SupportedAgentId[] = [];
            if (allFlag) {
              targetAgents = [...ALL_AGENT_IDS];
            } else if (subArg) {
              targetAgents = subArg.split(',').map((s) => setup.normalizeAgentId(s.trim())) as SupportedAgentId[];
            } else {
              return {
                exitCode: 1,
                output: isJson
                  ? JSON.stringify({ error: 'Specify an agent ID to install (or use --all).' })
                  : 'Error: Specify an agent ID to install (e.g. projectmind plugin install antigravity) or use --all to install all.'
              };
            }

            const results = setup.installMultiple(projectRoot, targetAgents, {
              scope,
              nonInteractive: hasFlag('--yes')
            });

            // Initialize auto mode session if any installed
            try {
              const engine = new SmartAutoModeEngine(projectRoot);
              engine.onProjectOpen();
            } catch (_) {}

            if (isJson) {
              return { exitCode: 0, output: JSON.stringify({ status: 'success', projectRoot, results }, null, 2) };
            }

            const lines = [`Installed ProjectMind plugins in ${projectRoot}:`];
            for (const r of results) {
              lines.push(`  • ${r.agentId}: ${r.installed ? '✓ Installed' : '✗ Failed'}`);
              if (r.filesCreatedOrUpdated.length > 0) {
                lines.push(`    Files: ${r.filesCreatedOrUpdated.join(', ')}`);
              }
            }
            return { exitCode: 0, output: lines.join('\n') };
          }

          case 'verify': {
            const targetAgents = allFlag
              ? ALL_AGENT_IDS
              : subArg
              ? [setup.normalizeAgentId(subArg)]
              : ALL_AGENT_IDS;

            const results = targetAgents.map((id) => setup.verifyAdapter(projectRoot, id));
            const allPassed = results.every((r) => r.verified);

            if (isJson) {
              return { exitCode: allPassed ? 0 : 1, output: JSON.stringify({ verified: allPassed, results }, null, 2) };
            }

            const lines = [`Plugin verification for ${projectRoot}:`];
            for (const r of results) {
              lines.push(`  ${r.verified ? '✓' : '✗'} ${r.agentId} (${r.checks.filter((c) => c.passed).length}/${r.checks.length} checks passed)`);
              for (const c of r.checks) {
                lines.push(`      - [${c.passed ? 'PASS' : 'FAIL'}] ${c.name}: ${c.details}`);
              }
            }
            return { exitCode: allPassed ? 0 : 1, output: lines.join('\n') };
          }

          case 'outdated': {
            const reportPromise = setup.checkOutdatedPlugins(projectRoot);
            return reportPromise.then((report) => {
              if (isJson) {
                return { exitCode: 0, output: JSON.stringify(report, null, 2) };
              }
              const headers = ['Agent ID', 'Installed', 'Latest', 'Status', 'Min Engine'];
              const rows = report.plugins.map((p) => [
                p.agentId,
                p.installedVersion || '(not installed)',
                p.latestVersion,
                p.isOutdated ? '⚠️ Update Available' : p.isInstalled ? '✓ Up to date' : '  Available',
                p.minEngineVersion ? `>= ${p.minEngineVersion}` : '-'
              ]);
              const summary = report.outdatedCount > 0
                ? `\n\n${report.outdatedCount} plugin(s) have updates available. Run 'projectmind plugin update <agent>' or 'projectmind plugin update --all'.`
                : '\n\nAll installed plugins are up to date.';
              return {
                exitCode: 0,
                output: `Plugin Version Check (Project: ${projectRoot})\n\n` + formatTable(headers, rows) + summary
              };
            }).catch((err: any) => {
              return { exitCode: 1, output: isJson ? JSON.stringify({ error: String(err) }) : `Error checking outdated plugins: ${err}` };
            });
          }

          case 'update': {
            const targetAgents = allFlag
              ? ALL_AGENT_IDS
              : subArg
              ? [setup.normalizeAgentId(subArg)]
              : ALL_AGENT_IDS;

            const updatePromise = (async () => {
              try {
                const results = [];
                for (const agentId of targetAgents) {
                  const res = await setup.updatePluginFromRemote(projectRoot, agentId);
                  results.push(res);
                }
                if (isJson) {
                  return { exitCode: 0, output: JSON.stringify({ status: 'updated', results }, null, 2) };
                }
                const lines = [`ProjectMind plugin update results for ${projectRoot}:`];
                for (const r of results) {
                  lines.push(`  • ${r.agentId}: ${r.success ? `✓ Updated (v${r.newVersion})` : `✗ Failed: ${r.error || 'Unknown'}`}`);
                  if (r.backupPath) {
                    lines.push(`    Backup: ${r.backupPath}`);
                  }
                }
                return { exitCode: results.every((r) => r.success) ? 0 : 1, output: lines.join('\n') };
              } catch (_) {
                // Fallback to local adapter update
                const results = targetAgents.map((id) => setup.updateAdapter(projectRoot, id, { scope }));
                if (isJson) {
                  return { exitCode: 0, output: JSON.stringify({ status: 'updated', results }, null, 2) };
                }
                const lines = [`Updated ProjectMind plugins in ${projectRoot}:`];
                for (const r of results) {
                  lines.push(`  • ${r.agentId}: ${r.updated ? '✓ Updated' : '✗ Failed'}`);
                }
                return { exitCode: 0, output: lines.join('\n') };
              }
            })();

            return updatePromise;
          }

          case 'disable': {
            if (!subArg) {
              return {
                exitCode: 1,
                output: isJson ? JSON.stringify({ error: 'Specify an agent ID to disable.' }) : 'Error: Specify an agent ID to disable (e.g. projectmind plugin disable antigravity).'
              };
            }
            const agentId = setup.normalizeAgentId(subArg);
            const res = setup.disableAdapter(projectRoot, agentId);
            if (isJson) {
              return { exitCode: res.disabled ? 0 : 1, output: JSON.stringify(res, null, 2) };
            }
            return { exitCode: res.disabled ? 0 : 1, output: res.message };
          }

          case 'enable': {
            if (!subArg) {
              return {
                exitCode: 1,
                output: isJson ? JSON.stringify({ error: 'Specify an agent ID to enable.' }) : 'Error: Specify an agent ID to enable (e.g. projectmind plugin enable antigravity).'
              };
            }
            const agentId = setup.normalizeAgentId(subArg);
            const res = setup.enableAdapter(projectRoot, agentId);
            if (isJson) {
              return { exitCode: res.enabled ? 0 : 1, output: JSON.stringify(res, null, 2) };
            }
            return { exitCode: res.enabled ? 0 : 1, output: res.message };
          }

          case 'uninstall': {
            const targetAgents = allFlag
              ? ALL_AGENT_IDS
              : subArg
              ? [setup.normalizeAgentId(subArg)]
              : [];

            if (targetAgents.length === 0) {
              return {
                exitCode: 1,
                output: isJson
                  ? JSON.stringify({ error: 'Specify an agent ID to uninstall (or use --all).' })
                  : 'Error: Specify an agent ID to uninstall (e.g. projectmind plugin uninstall opencode) or use --all.'
              };
            }

            const results = targetAgents.map((id) => setup.uninstallAdapter(projectRoot, id, { scope }));
            if (isJson) {
              return { exitCode: 0, output: JSON.stringify({ status: 'uninstalled', results }, null, 2) };
            }
            const lines = [`Uninstalled ProjectMind plugins from ${projectRoot}:`];
            for (const r of results) {
              lines.push(`  • ${r.agentId}: ${r.uninstalled ? '✓ Removed' : '✗ Unchanged'} (${r.filesRemoved.length} files removed)`);
            }
            lines.push('\nNote: Project memory in .projectmind was preserved.');
            return { exitCode: 0, output: lines.join('\n') };
          }

          case 'doctor': {
            const report = setup.doctor(projectRoot);
            if (isJson) {
              return { exitCode: report.healthy ? 0 : 1, output: JSON.stringify(report, null, 2) };
            }
            const lines = [
              `ProjectMind Plugin Diagnostics`,
              `===============================`,
              `Project Root: ${report.projectRoot}`,
              `Platform:     ${report.platform}`,
              `Node.js:      ${report.checks.nodeVersion.details}`,
              `Runtime:      ${report.checks.runtimeResolved.details}`,
              `Filesystem:   ${report.checks.filesystemPermissions.details}`,
              `System Status: ${report.healthy ? '✓ HEALTHY' : '✗ ISSUES DETECTED'}`,
              '',
              `Adapters:`
            ];
            for (const a of report.adapterStatuses) {
              lines.push(`  ${a.verified ? '✓' : ' '} ${a.displayName} (${a.agentId}): ${a.verified ? 'Installed' : a.detected ? 'Detected' : 'Inactive'} [${a.passedChecks}/${a.totalChecks} checks]`);
            }
            return { exitCode: report.healthy ? 0 : 1, output: lines.join('\n') };
          }

          default:
            return {
              exitCode: 1,
              output: `Unknown plugin subcommand: ${subCommand}. See 'projectmind plugin --help' or 'projectmind help'.`
            };
        }
      }

      case 'install':
      case 'setup': {
        const agentFlag = getFlagValue('--agent');
        const allFlag = hasFlag('--all');
        const scope = (getFlagValue('--scope') as 'project' | 'global') || 'project';
        let targetAgents: SupportedAgentId[];

        if (allFlag) {
          targetAgents = [...ALL_AGENT_IDS];
        } else if (agentFlag) {
          targetAgents = agentFlag.split(',').map((s) => setup.normalizeAgentId(s.trim())) as SupportedAgentId[];
        } else {
          // Detect installed environments or default to detected agents
          const detected = setup.detectAgents(projectRoot).filter((a) => a.detected);
          if (detected.length > 0) {
            targetAgents = detected.map((a) => a.agentId as SupportedAgentId);
          } else {
            targetAgents = ['antigravity'];
          }
        }

        const results = setup.installMultiple(projectRoot, targetAgents, {
          scope,
          nonInteractive: hasFlag('--yes')
        });

        try {
          const engine = new SmartAutoModeEngine(projectRoot);
          engine.onProjectOpen();
        } catch (_) {}

        if (isJson) {
          return {
            exitCode: 0,
            output: JSON.stringify({ status: 'installed_and_verified', projectRoot, adaptersInstalled: results }, null, 2)
          };
        }
        return {
          exitCode: 0,
          output: `Installed ${results.filter((r) => r.installed).length} adapter(s) in ${projectRoot}:\n` +
            results.map((r) => `  • ${r.agentId}: ${r.installed ? '✓ Success' : '✗ Failed'}`).join('\n')
        };
      }

      case 'uninstall': {
        const agentFlag = getFlagValue('--agent');
        const allFlag = hasFlag('--all');
        const targets: SupportedAgentId[] = allFlag
          ? ALL_AGENT_IDS
          : agentFlag
          ? (agentFlag.split(',').map((s) => setup.normalizeAgentId(s.trim())) as SupportedAgentId[])
          : ALL_AGENT_IDS;

        const results = targets.map((id) => setup.uninstallAdapter(projectRoot, id));
        if (isJson) {
          return { exitCode: 0, output: JSON.stringify({ status: 'uninstalled', results }, null, 2) };
        }
        return {
          exitCode: 0,
          output: `Uninstalled adapters from ${projectRoot} (Project memory in .projectmind preserved):\n` +
            results.map((r) => `  • ${r.agentId}: ${r.uninstalled ? '✓ Removed' : '✗ Unchanged'}`).join('\n')
        };
      }

      case 'diagnostics':
      case 'doctor': {
        const report = setup.doctor(projectRoot);
        if (isJson) {
          return { exitCode: report.healthy ? 0 : 1, output: JSON.stringify(report, null, 2) };
        }
        const lines = [
          `ProjectMind Diagnostics`,
          `======================`,
          `Root:        ${report.projectRoot}`,
          `Platform:    ${report.platform}`,
          `Node:        ${report.checks.nodeVersion.details}`,
          `Runtime:     ${report.checks.runtimeResolved.details}`,
          `Status:      ${report.healthy ? '✓ ALL CHECKS PASSED' : '✗ ATTENTION NEEDED'}`
        ];
        return { exitCode: report.healthy ? 0 : 1, output: lines.join('\n') };
      }

      case 'status': {
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('get_project_status', { projectRoot });
        return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
      }

      case 'init':
      case 'scan': {
        const promptText = getFlagValue('--prompt');
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('initialize_project', {
          projectRoot,
          mode: promptText ? 'prompt' : 'existing',
          promptText
        });
        return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
      }

      case 'sync': {
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('sync_changed_files', { projectRoot });
        return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
      }

      case 'context': {
        const task = getFlagValue('--task') || args.slice(1).filter((a) => !a.startsWith('-')).join(' ') || 'Provide project overview';
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('get_relevant_context', { projectRoot, taskDescription: task });
        return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
      }

      case 'search': {
        const query = getFlagValue('--query') || args.slice(1).filter((a) => !a.startsWith('-')).join(' ');
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('search_project_knowledge', { projectRoot, query });
        return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
      }

      case 'upgrade':
      case 'update': {
        const subCommand = (args[1] || 'apply').toLowerCase();
        if (subCommand === 'check') {
          const checkPromise = setup.checkCoreUpdate();
          return checkPromise.then((res) => {
            if (isJson) {
              return { exitCode: 0, output: JSON.stringify(res, null, 2) };
            }
            if (res.isOutdated) {
              return {
                exitCode: 0,
                output: [
                  `Update available: ProjectMind v${res.latestVersion} (current: v${res.currentVersion})`,
                  `Release: ${res.releaseName}`,
                  `Published: ${res.publishedAt}`,
                  res.compatible ? 'Compatibility: compatible' : `Compatibility: incompatible (${res.incompatibilityReason})`,
                  `Signed checksum: ${res.sha256 ? 'published' : 'MISSING (updates will be refused)'}`,
                  '',
                  'Changelog:',
                  res.releaseNotes || '(No release notes provided)',
                  '',
                  "Run 'projectmind update' to stage and apply (non-git installs), or 'git pull' for a checkout."
                ].join('\n')
              };
            }
            return { exitCode: 0, output: `ProjectMind is up to date (v${res.currentVersion}).` };
          }).catch((err: any) => {
            return { exitCode: 1, output: isJson ? JSON.stringify({ error: String(err) }) : `Error checking update: ${err}` };
          });
        }

        const applyPromise = (async () => {
          const installationRoot = process.env.PROJECTMIND_HOME
            ? path.resolve(process.env.PROJECTMIND_HOME)
            : path.resolve(__dirname, '..', '..', '..');

          const staged = await setup.stageCoreUpdate(installationRoot);
          if (!staged.success) {
            const payload = { status: 'failed', ...staged };
            return { exitCode: 1, output: isJson ? JSON.stringify(payload, null, 2) : `Error: ${staged.error}` };
          }
          if (hasFlag('--stage')) {
            const payload = { status: 'staged', ...staged };
            return {
              exitCode: 0,
              output: isJson ? JSON.stringify(payload, null, 2) : [
                `Verified ProjectMind v${staged.newVersion} artifact and staged it at:`,
                `  ${staged.stagedDir}`,
                `SHA-256: ${staged.artifactSha256}`
              ].join('\n')
            };
          }

          const applied = setup.applyCoreUpdate(installationRoot, staged.stagedDir || '', { force: hasFlag('--force') });
          if (!applied.success) {
            const payload = { status: 'blocked', ...applied, stagedDir: staged.stagedDir };
            return {
              exitCode: 1,
              output: isJson ? JSON.stringify(payload, null, 2) : [
                `Verified v${staged.newVersion} was staged at ${staged.stagedDir}, but it was NOT applied:`,
                applied.error || 'unknown error'
              ].join('\n')
            };
          }
          const payload = { status: 'applied', ...applied, artifactSha256: staged.artifactSha256 };
          return {
            exitCode: 0,
            output: isJson ? JSON.stringify(payload, null, 2) : [
              `Applied ProjectMind v${staged.newVersion} from a verified artifact.`,
              `Previous version: v${applied.previousVersion}`,
              applied.backupPath ? `Backup: ${applied.backupPath}` : ''
            ].filter(Boolean).join('\n')
          };
        })();

        return applyPromise.catch((err: any) => {
          return { exitCode: 1, output: isJson ? JSON.stringify({ error: String(err) }) : `Error applying update: ${err}` };
        });
      }

      case 'health': {
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('get_health', { projectRoot });
        if (isJson) return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
        const health = res.structuredContent as any;
        const lines = [
          `ProjectMind Health`,
          `==================`,
          `Database:       ${health.integrity === 'ok' ? 'OK' : health.integrity}`,
          `Memory events:  ${health.stats.events} (chain ${health.eventChain.valid ? 'valid' : 'BROKEN'})`,
          `Open conflicts: ${health.stats.conflictsOpen}`,
          `Index snapshot: ${health.latestSnapshot ? health.latestSnapshot.snapshotId : 'none'}`,
          `Index manifest: ${health.manifest ? `${health.manifest.parserVersion} / ${health.manifest.retrievalVersion}` : 'none'}`,
          `Cache entries:  ${health.cache.entries}`,
          `Files/modules:  ${health.stats.files}/${health.stats.modules}`,
          `Symbols/edges:  ${health.stats.symbols}/${health.stats.graphEdges}`,
          `Embeddings:     ${health.stats.embeddings}`,
          `Event chain:    ${health.eventChain.valid ? 'VALID' : `BROKEN at ${health.eventChain.brokenAt}`}`
        ];
        return { exitCode: health.eventChain.valid && health.integrity === 'ok' ? 0 : 1, output: lines.join('\n') };
      }

      case 'memory': {
        const subCommand = (args[1] || 'events').toLowerCase();
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        if (subCommand === 'events') {
          const res = mcp.callTool('get_memory_events', {
            limit: Number(getFlagValue('--limit') || 25),
            entityId: getFlagValue('--entity-id'),
            namespace: getFlagValue('--namespace')
          });
          return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
        }
        if (subCommand === 'conflicts') {
          const res = mcp.callTool('get_memory_conflicts', { status: getFlagValue('--status') || 'open' });
          return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
        }
        return {
          exitCode: 1,
          output: "Unknown memory subcommand. Use 'projectmind memory events' or 'projectmind memory conflicts'."
        };
      }

      case 'manifest': {
        const mcp = new ProjectMindMcpServer(projectRoot, true);
        const res = mcp.callTool('get_context_manifest', { projectRoot });
        return { exitCode: res.isError ? 1 : 0, output: res.content[0].text };
      }

      case 'hook': {
        const agentId = setup.normalizeAgentId(args[1] || 'claude-code');
        const eventName = args[2] || 'SessionStart';
        let stdinData = '';
        try {
          if (!process.stdin.isTTY) stdinData = fs.readFileSync(0, 'utf8');
        } catch (_) {}
        const out = SmartAutoModeEngine.handleHookStdin(agentId, eventName, stdinData, projectRoot);
        return { exitCode: 0, output: JSON.stringify(out) };
      }

      default:
        return {
          exitCode: 1,
          output: `Unknown command "${command}". Run 'projectmind help' to view available commands.`
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isJson) {
      return { exitCode: 1, output: JSON.stringify({ error: message }) };
    }
    return { exitCode: 1, output: `Error: ${message}` };
  }
}

export async function runCliAsync(argv: string[]): Promise<{ exitCode: number; output: string }> {
  const res = runCli(argv);
  if (res && typeof (res as any).then === 'function') {
    return await res;
  }
  return res as { exitCode: number; output: string };
}

if (require.main === module) {
  const result = runCli(process.argv);
  if (result && typeof (result as any).then === 'function') {
    (result as any).then(({ exitCode, output }: any) => {
      process.stdout.write(output + '\n');
      process.exit(exitCode);
    }).catch((err: any) => {
      process.stderr.write(`Error: ${err}\n`);
      process.exit(1);
    });
  } else {
    process.stdout.write((result as any).output + '\n');
    process.exit((result as any).exitCode);
  }
}
