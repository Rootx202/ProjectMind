#!/usr/bin/env node
// Restore internal monorepo package resolution when the root package is installed
// from npm outside a workspace checkout. All links stay inside this installation.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const scopeDir = path.join(root, 'node_modules', '@projectmind');
fs.mkdirSync(scopeDir, { recursive: true });
for (const group of ['packages', 'apps', 'adapters']) {
  const dir = path.join(root, group);
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(dir, entry.name);
    const manifestPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const name = group === 'adapters' ? `adapter-${entry.name}` : entry.name;
    const link = path.join(scopeDir, name);
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) continue;
    const relativeTarget = path.relative(scopeDir, packageDir);
    try { fs.symlinkSync(relativeTarget, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
