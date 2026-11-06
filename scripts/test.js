#!/usr/bin/env node
const { runCoreTests } = require('../dist-tests/core/core.test.js');
const { runMcpTests } = require('../dist-tests/mcp/mcp.test.js');
const { runAdapterTests } = require('../dist-tests/adapters/adapters.test.js');
const { runScenarioTests } = require('../dist-tests/scenarios/scenarios.test.js');
const { runPluginsTests } = require('../dist-tests/plugins/plugins.test.js');
const { runPortableRuntimeTests } = require('../dist-tests/runtime/portable-runtime.test.js');
const { runInstallerTests } = require('../dist-tests/installer/installer.test.js');
const { runUpdaterTests } = require('../dist-tests/updater/updater.test.js');

let totalPassed = 0;
let totalFailed = 0;
const suites = [
  runCoreTests,
  runMcpTests,
  runAdapterTests,
  runScenarioTests,
  runPluginsTests,
  runPortableRuntimeTests,
  runInstallerTests,
  runUpdaterTests
];

async function main() {
  for (const suite of suites) {
    const res = await suite();
    for (const d of res.details) console.log('  ' + d);
    totalPassed += res.passed;
    totalFailed += res.failed;
  }
  console.log(`\n======================================================`);
  console.log(`FINAL RESULT: ${totalPassed} PASSED, ${totalFailed} FAILED`);
  console.log(`======================================================\n`);
  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
