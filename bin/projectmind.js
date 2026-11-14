#!/usr/bin/env node
// npx can skip package lifecycle hooks. Link bundled workspace packages at
// command startup so the published monorepo distribution works in either case.
require('../scripts/link-workspaces.js');
if ((process.argv[2] || '').toLowerCase() === 'mcp') {
  require('../packages/mcp-server/dist/cli.js');
} else {
const cli = require('../apps/cli/dist/index.js');
const start = async () => {
  await require('../packages/indexing/dist/ast.js').initializeTreeSitter();
  const { exitCode, output } = await cli.runCliAsync(process.argv);
  process.stdout.write(output + '\n');
  if ((process.argv[2] || '').toLowerCase() !== 'ui' || exitCode !== 0) process.exit(exitCode);
};
start().catch((error) => {
  process.stderr.write(`ProjectMind CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
}
