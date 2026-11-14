#!/usr/bin/env node
import * as readline from 'readline';
import { ProjectMindMcpServer } from './index';
import { initializeTreeSitter } from '@projectmind/indexing/dist/ast';

async function main(): Promise<void> {
  // Initialize the offline WASM runtime before an agent can send bootstrap requests.
  await initializeTreeSitter();
  const rootArgIdx = process.argv.indexOf('--project-root');
  const defaultRoot = rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
    ? process.argv[rootArgIdx + 1]
    : process.env.PROJECTMIND_PROJECT_ROOT || process.cwd();
  const server = new ProjectMindMcpServer(defaultRoot, true);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed);
      const res = server.handleJsonRpcRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    } catch (_) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    }
  });
}
main().catch((err) => {
  process.stderr.write(`ProjectMind MCP startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
