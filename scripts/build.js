#!/usr/bin/env node
/**
 * ProjectMind deterministic build.
 *
 * Compiles every workspace package's TypeScript sources under `src` into
 * matching JavaScript files under `dist` with
 * Babel (TypeScript preset + CommonJS transform), then compiles the test
 * sources into `dist-tests/`.
 *
 * Important: this script must never write through `node_modules/@projectmind`
 * workspace symlinks. Earlier versions created "proxy" package.json/index.js
 * files inside the linked workspace directories, which silently overwrote the
 * real package manifests. Workspace resolution is npm's job; the build only
 * produces `dist/` artifacts.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_GROUPS = ['packages', 'adapters', 'apps'];
const WORKSPACE_SCOPE = {
  packages: '@projectmind',
  apps: '@projectmind',
  adapters: '@projectmind/adapter'
};

function resolveBabel() {
  const modulePaths = [
    path.join(ROOT, 'node_modules'),
    '/usr/share/nodejs',
    '/usr/lib/nodejs'
  ];
  const resolve = (id) => require.resolve(id, { paths: modulePaths });
  return {
    babel: require(resolve('@babel/core')),
    presetTs: resolve('@babel/preset-typescript'),
    pluginCjs: resolve('@babel/plugin-transform-modules-commonjs')
  };
}

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

function compileFile(ctx, srcFile, srcRoot, distRoot) {
  const rel = path.relative(srcRoot, srcFile);
  const outFile = path.join(distRoot, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const code = fs.readFileSync(srcFile, 'utf8');
  const transformed = ctx.babel.transformSync(code, {
    filename: srcFile,
    presets: [[ctx.presetTs, { allowDeclareFields: true }]],
    plugins: [ctx.pluginCjs],
    sourceMaps: false,
    retainLines: true,
    babelrc: false,
    configFile: false
  });
  let outCode = transformed.code;
  if (code.startsWith('#!')) {
    const firstLine = code.split('\n')[0];
    if (!outCode.startsWith('#!')) outCode = firstLine + '\n' + outCode;
  }
  fs.writeFileSync(outFile, outCode, 'utf8');
  if (outCode.startsWith('#!')) fs.chmodSync(outFile, 0o755);
}

/**
 * Ensures a workspace package declares the built entry point. Never rewrites a
 * manifest that is already valid; only creates or repairs the minimal fields.
 */
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
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid workspace package.json at ${pkgJsonPath}: ${err.message}`);
  }
  let changed = false;
  if (!pkg.main || pkg.main === './index.js') { pkg.main = './dist/index.js'; changed = true; }
  if (!pkg.types) { pkg.types = './src/index.ts'; changed = true; }
  if (!pkg.license) { pkg.license = 'MIT'; changed = true; }
  if (changed) fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
}

function cleanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) cleanDir(path.join(dir, entry.name));
    else fs.unlinkSync(path.join(dir, entry.name));
  }
}

function buildAll() {
  const ctx = resolveBabel();
  const scopeDir = path.join(ROOT, 'node_modules', '@projectmind');
  const hasWorkspaceLinks = fs.existsSync(scopeDir) &&
    fs.readdirSync(scopeDir).some((name) => {
      try { return fs.lstatSync(path.join(scopeDir, name)).isSymbolicLink(); } catch (_) { return false; }
    });

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
        ? `${WORKSPACE_SCOPE.adapters}-${item.name}`
        : `${WORKSPACE_SCOPE[group]}/${item.name}`;

      ensurePackageJson(pkgDir, pkgName);

      if (fs.existsSync(distDir)) cleanDir(distDir);
      const tsFiles = findTsFiles(srcDir);
      for (const tsFile of tsFiles) {
        compileFile(ctx, tsFile, srcDir, distDir);
        totalCompiled++;
      }

      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.endsWith('.ts')) {
          fs.mkdirSync(distDir, { recursive: true });
          fs.copyFileSync(path.join(srcDir, entry.name), path.join(distDir, entry.name));
        }
      }
    }
  }

  const testsDir = path.join(ROOT, 'tests');
  const testsDistDir = path.join(ROOT, 'dist-tests');
  if (fs.existsSync(testsDir)) {
    if (fs.existsSync(testsDistDir)) cleanDir(testsDistDir);
    for (const tf of findTsFiles(testsDir)) {
      compileFile(ctx, tf, testsDir, testsDistDir);
      totalCompiled++;
    }
  }

  if (!hasWorkspaceLinks) {
    console.warn('[ProjectMind Build] Warning: npm workspace links are missing under node_modules/@projectmind. Run `npm install` so `@projectmind/*` imports resolve.');
  }
  console.log(`[ProjectMind Build] Successfully compiled ${totalCompiled} TypeScript files.`);
}

try {
  buildAll();
} catch (err) {
  console.error(`[ProjectMind Build] FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}
