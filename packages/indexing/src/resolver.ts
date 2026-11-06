import * as fs from 'fs';
import * as path from 'path';

export interface TsPathMapping {
  pattern: string;
  targets: string[];
  baseUrl: string;
}

export interface ResolutionContext {
  projectRoot: string;
  fileSet: Set<string>;
  packageEntries: Map<string, string>;
  tsPaths: TsPathMapping[];
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];

function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next; i++; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

function readJsonc(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return null;
  }
}

export function buildResolutionContext(projectRoot: string, files: string[]): ResolutionContext {
  const fileSet = new Set(files);
  const packageEntries = new Map<string, string>();
  const tsPaths: TsPathMapping[] = [];

  const packageJsonPaths = files.filter((f) => path.posix.basename(f) === 'package.json');
  if (!packageJsonPaths.includes('package.json') && fs.existsSync(path.join(projectRoot, 'package.json'))) {
    packageJsonPaths.push('package.json');
  }

  for (const rel of packageJsonPaths) {
    const parsed = readJsonc(path.join(projectRoot, rel));
    if (!parsed || typeof parsed.name !== 'string') continue;
    const dir = path.posix.dirname(rel);
    const dirPrefix = dir === '.' ? '' : `${dir}/`;
    const candidates: string[] = [];
    for (const field of ['types', 'typings', 'module', 'main']) {
      const value = parsed[field];
      if (typeof value === 'string') {
        const normalized = path.posix.normalize(path.posix.join(dirPrefix, value));
        candidates.push(normalized);
        candidates.push(normalized.replace(/\.js$/, '.ts'));
        candidates.push(normalized.replace(/\.js$/, '.tsx'));
      }
    }
    candidates.push(`${dirPrefix}src/index.ts`, `${dirPrefix}index.ts`);
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) {
        packageEntries.set(parsed.name, candidate);
        break;
      }
    }
  }

  for (const tsconfigName of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
    const tsconfigPath = path.join(projectRoot, tsconfigName);
    if (!fs.existsSync(tsconfigPath)) continue;
    const parsed = readJsonc(tsconfigPath);
    const options = parsed?.compilerOptions || {};
    const baseUrl = path.posix.join('.', String(options.baseUrl || '.')).replace(/^\.\//, '');
    const paths = options.paths;
    if (paths && typeof paths === 'object') {
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets)) continue;
        tsPaths.push({
          pattern,
          targets: targets.map(String),
          baseUrl: baseUrl === '.' ? '' : baseUrl
        });
      }
    }
  }

  return { projectRoot, fileSet, packageEntries, tsPaths };
}

function tryResolveFile(relPath: string, fileSet: Set<string>): string | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (fileSet.has(normalized)) return normalized;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (fileSet.has(normalized + ext)) return normalized + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = `${normalized}/index${ext}`;
    if (fileSet.has(indexPath)) return indexPath;
  }
  // `./foo.js` written in TS ESM style may resolve to `./foo.ts`.
  const noExt = normalized.replace(/\.(js|jsx|mjs|cjs)$/, '');
  for (const ext of RESOLVE_EXTENSIONS) {
    if (fileSet.has(noExt + ext)) return noExt + ext;
  }
  return null;
}

function matchTsPath(specifier: string, mapping: TsPathMapping): string | null {
  const pattern = mapping.pattern;
  const star = pattern.indexOf('*');
  if (star === -1) {
    if (specifier !== pattern) return null;
    for (const target of mapping.targets) {
      const joined = path.posix.join(mapping.baseUrl, target);
      const resolved = tryResolveFile(joined, mappingFileSet(mapping));
      if (resolved) return resolved;
    }
    return null;
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
  for (const target of mapping.targets) {
    const joined = path.posix.join(mapping.baseUrl, target.replace('*', captured));
    const resolved = tryResolveFile(joined, mappingFileSet(mapping));
    if (resolved) return resolved;
  }
  return null;
}

// TsPathMapping does not carry the file set; attach it dynamically to avoid
// duplicating hundreds of path entries.
const pathFileSets = new WeakMap<TsPathMapping, Set<string>>();
function mappingFileSet(mapping: TsPathMapping): Set<string> {
  return pathFileSets.get(mapping) || new Set<string>();
}

export function resolveImportPath(
  specifier: string,
  fromRelPath: string,
  context: ResolutionContext
): string | null {
  if (!specifier || specifier.startsWith('node:') || specifier.startsWith('data:')) return null;

  if (specifier.startsWith('.')) {
    const dir = path.posix.dirname(fromRelPath);
    return tryResolveFile(path.posix.join(dir, specifier), context.fileSet);
  }

  if (specifier.startsWith('/')) {
    return tryResolveFile(specifier.replace(/^\//, ''), context.fileSet);
  }

  // Workspace packages such as @projectmind/shared or @projectmind/adapter-codex.
  if (context.packageEntries.has(specifier)) return context.packageEntries.get(specifier) || null;
  const scopedMatch = specifier.match(/^(@[^/]+\/[^/]+)\/(.+)$/);
  if (scopedMatch && context.packageEntries.has(scopedMatch[1])) {
    const pkgRoot = path.posix.dirname(context.packageEntries.get(scopedMatch[1]) as string);
    return tryResolveFile(path.posix.join(pkgRoot, scopedMatch[2]), context.fileSet);
  }
  const unscopedMatch = specifier.match(/^([^/@][^/]*)\/(.+)$/);
  if (unscopedMatch && context.packageEntries.has(unscopedMatch[1])) {
    const pkgRoot = path.posix.dirname(context.packageEntries.get(unscopedMatch[1]) as string);
    return tryResolveFile(path.posix.join(pkgRoot, unscopedMatch[2]), context.fileSet);
  }

  // tsconfig/jsconfig path aliases.
  for (const mapping of context.tsPaths) {
    pathFileSets.set(mapping, context.fileSet);
    const resolved = matchTsPath(specifier, mapping);
    if (resolved) return resolved;
  }

  // Common `src/`-relative aliases.
  for (const prefix of ['src/', '@/']) {
    if (specifier.startsWith(prefix)) {
      const candidate = specifier.slice(prefix.length);
      const resolved = tryResolveFile(path.posix.join('src', candidate), context.fileSet);
      if (resolved) return resolved;
    }
  }

  return null;
}

export function externalPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}
