#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const modulePaths = [
  path.join(__dirname, '..', 'node_modules'),
  '/usr/share/nodejs',
  '/usr/lib/nodejs'
];
const babel = require(require.resolve('@babel/core', { paths: modulePaths }));
const presetTs = require.resolve('@babel/preset-typescript', { paths: modulePaths });
const pluginCjs = require.resolve('@babel/plugin-transform-modules-commonjs', { paths: modulePaths });

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_GROUPS = ['packages', 'adapters', 'apps'];

function findTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function compileFile(srcFile, srcRoot, distRoot) {
  const rel = path.relative(srcRoot, srcFile);
  const outFile = path.join(distRoot, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const code = fs.readFileSync(srcFile, 'utf8');
  const transformed = babel.transformSync(code, {
    filename: srcFile,
    presets: [[presetTs, { allowDeclareFields: true }]],
    plugins: [pluginCjs],
    sourceMaps: false,
    retainLines: true
  });
  let outCode = transformed.code;
  if (code.startsWith('#!')) {
    const firstLine = code.split('\n')[0];
    if (!outCode.startsWith('#!')) {
      outCode = firstLine + '\n' + outCode;
    }
  }
  fs.writeFileSync(outFile, outCode, 'utf8');
  if (outCode.startsWith('#!')) {
    fs.chmodSync(outFile, 0o755);
  }
}

function ensurePackageJson(pkgDir, pkgName) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: pkgName,
      version: '1.0.0',
      main: './dist/index.js',
      types: './src/index.ts',
      license: 'MIT'
    }, null, 2) + '\n');
  }
}

function buildAll() {
  const scopeDir = path.join(ROOT, 'node_modules', '@projectmind');
  fs.mkdirSync(scopeDir, { recursive: true });

  let totalCompiled = 0;
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = path.join(ROOT, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const item of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const pkgDir = path.join(groupDir, item.name);
      const srcDir = path.join(pkgDir, 'src');
      const distDir = path.join(pkgDir, 'dist');
      if (!fs.existsSync(srcDir)) continue;

      const pkgName = group === 'adapters'
        ? `@projectmind/adapter-${item.name}`
        : `@projectmind/${item.name}`;

      ensurePackageJson(pkgDir, pkgName);

      const tsFiles = findTsFiles(srcDir);
      for (const tsFile of tsFiles) {
        compileFile(tsFile, srcDir, distDir);
        totalCompiled++;
      }

      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.endsWith('.ts')) {
          fs.mkdirSync(distDir, { recursive: true });
          fs.copyFileSync(path.join(srcDir, entry.name), path.join(distDir, entry.name));
        }
      }

      const linkName = group === 'adapters' ? `adapter-${item.name}` : item.name;
      const proxyDir = path.join(scopeDir, linkName);
      fs.mkdirSync(proxyDir, { recursive: true });
      const relTarget = path.relative(proxyDir, path.join(distDir, 'index.js')).replace(/\\/g, '/');
      fs.writeFileSync(path.join(proxyDir, 'package.json'), JSON.stringify({
        name: pkgName,
        version: '1.0.0',
        main: './index.js'
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(proxyDir, 'index.js'), `module.exports = require('${relTarget}');\n`);
    }
  }

  const testsDir = path.join(ROOT, 'tests');
  const testsDistDir = path.join(ROOT, 'dist-tests');
  if (fs.existsSync(testsDir)) {
    const testFiles = findTsFiles(testsDir);
    for (const tf of testFiles) {
      compileFile(tf, testsDir, testsDistDir);
      totalCompiled++;
    }
  }

  console.log(`[ProjectMind Build] Successfully compiled ${totalCompiled} TypeScript files.`);
}

buildAll();
