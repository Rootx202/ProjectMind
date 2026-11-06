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

Plugin Commands:
  plugin list                List all available agent plugins and installation status
  plugin status              Display detailed status for all plugins
  plugin search <query>      Search available plugins by keyword
  plugin install <agent>     Install an agent plugin (e.g. antigravity, opencode, cursor)
                             Options: --all, --scope <project|global>, --yes
  plugin verify <agent>      Verify adapter installation and configuration integrity
  plugin update <agent>      Update plugin configuration and generated assets (--all supported)
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

          case 'update': {
            const targetAgents = allFlag
              ? ALL_AGENT_IDS
              : subArg
              ? [setup.normalizeAgentId(subArg)]
              : ALL_AGENT_IDS;

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

if (require.main === module) {
  const { exitCode, output } = runCli(process.argv);
  process.stdout.write(output + '\n');
  process.exit(exitCode);
}
