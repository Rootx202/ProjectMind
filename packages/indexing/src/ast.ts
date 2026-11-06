/**
 * Structural TypeScript/JavaScript analysis.
 *
 * Uses @babel/parser to build a real AST (not line regexes) and extracts
 * imports, re-exports, symbols, classes/methods, and Express-style routes.
 * Non-TS/JS languages fall back to the legacy regex path in the indexer.
 *
 * The parser is optional at runtime: if `@babel/parser` cannot be resolved the
 * caller receives `null` and falls back, instead of crashing indexing.
 */
import { redactSecrets } from '@projectmind/shared';

export interface AstImport {
  specifier: string;
  kind: 'import' | 'reexport' | 'dynamic-import' | 'require' | 'type-import';
  line: number;
  names: string[];
}

export interface AstSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'enum' | 'component';
  line: number;
  endLine: number;
  exported: boolean;
  signature?: string;
}

export interface AstRoute {
  method: string;
  path: string;
  handlerSymbol: string;
  line: number;
  moduleId?: string;
}

export interface AstModel {
  name: string;
  kind: 'sql_table' | 'prisma_model' | 'orm_entity' | 'mongoose_schema';
  line: number;
  fields?: Array<{ name: string; type: string; constraints?: string }>;
}

export interface AstParseResult {
  parser: 'babel-ast-v1' | 'regex-fallback';
  imports: AstImport[];
  symbols: AstSymbol[];
  routes: AstRoute[];
  models: AstModel[];
  exports: string[];
  lineCount: number;
  errors: string[];
}

function loadParser(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@babel/parser');
  } catch (_) {
    try {
      // Some distros ship Babel globally.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(require.resolve('@babel/parser', { paths: ['/usr/share/nodejs', '/usr/lib/nodejs'] }));
    } catch (__) {
      return null;
    }
  }
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'head', 'options']);

function isNode(value: any): boolean {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string');
}

function lineOf(node: any): number {
  return node?.loc?.start?.line || 1;
}

function endLineOf(node: any): number {
  return node?.loc?.end?.line || lineOf(node);
}

function sliceSignature(code: string, node: any, fallback: string): string {
  try {
    if (typeof node.start === 'number' && typeof node.end === 'number') {
      const bodyStart = node.body && typeof node.body.start === 'number' ? node.body.start : node.end;
      const text = code.slice(node.start, bodyStart).replace(/\s+/g, ' ').trim();
      return redactSecrets(text.slice(0, 180)) || fallback;
    }
  } catch (_) {}
  return fallback;
}

export function astParserAvailable(): boolean {
  return loadParser() !== null;
}

export function parseJavaScriptModule(code: string, filename: string): AstParseResult | null {
  const parser = loadParser();
  if (!parser || typeof parser.parse !== 'function') return null;

  let ast: any;
  const errors: string[] = [];
  try {
    ast = parser.parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: true,
      tokens: false,
      plugins: [
        'typescript',
        'jsx',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'importAttributes',
        'topLevelAwait',
        'exportDefaultFrom',
        'explicitResourceManagement'
      ]
    });
    if (Array.isArray(ast.errors)) {
      for (const err of ast.errors.slice(0, 5)) errors.push(String(err.message || err));
    }
  } catch (err) {
    return null;
  }

  const imports: AstImport[] = [];
  const symbols: AstSymbol[] = [];
  const routes: AstRoute[] = [];
  const models: AstModel[] = [];
  const exportsList = new Set<string>();

  const addSymbol = (name: string, kind: AstSymbol['kind'], node: any, exported: boolean, fallbackSig: string) => {
    if (!name) return;
    symbols.push({
      name,
      kind,
      line: lineOf(node),
      endLine: endLineOf(node),
      exported,
      signature: sliceSignature(code, node, fallbackSig)
    });
  };

  const handleClass = (node: any, exported: boolean) => {
    addSymbol(node.id?.name || 'default', 'class', node, exported, 'class');
    for (const member of node.body?.body || []) {
      if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
        const name = member.key?.name || member.key?.value || 'method';
        addSymbol(String(name), 'method', member, exported && !member.key?.name?.startsWith('_'), `method ${name}`);
      }
    }
  };

  const handleDeclaration = (node: any, exported: boolean) => {
    if (!node) return;
    if (exported && node.id?.name) exportsList.add(node.id.name);
    switch (node.type) {
      case 'FunctionDeclaration':
        addSymbol(node.id?.name || 'default', 'function', node, exported, 'function');
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        handleClass(node, exported);
        break;
      case 'TSInterfaceDeclaration':
        addSymbol(node.id?.name, 'interface', node, exported, 'interface');
        break;
      case 'TSTypeAliasDeclaration':
        addSymbol(node.id?.name, 'type', node, exported, 'type');
        break;
      case 'TSEnumDeclaration':
        addSymbol(node.id?.name, 'enum', node, exported, 'enum');
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations || []) {
          const name = decl.id?.name;
          if (!name) continue;
          const init = decl.init;
          const kind: AstSymbol['kind'] =
            init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') ? 'function' : 'const';
          addSymbol(name, kind, decl, exported, `${kind} ${name}`);
          if (exported) exportsList.add(name);
        }
        break;
      default:
        break;
    }
  };

  const visitTopLevel = (statements: any[]) => {
    for (const stmt of statements) {
      if (!isNode(stmt)) continue;
      if (stmt.type === 'ImportDeclaration') {
        const specifier = String(stmt.source?.value || '');
        const names = (stmt.specifiers || []).map((s: any) => s.local?.name || s.imported?.name || '').filter(Boolean);
        imports.push({
          specifier,
          kind: stmt.importKind === 'type' ? 'type-import' : 'import',
          line: lineOf(stmt),
          names
        });
        continue;
      }
      if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.source) {
          imports.push({
            specifier: String(stmt.source.value || ''),
            kind: 'reexport',
            line: lineOf(stmt),
            names: (stmt.specifiers || []).map((s: any) => s.exported?.name || s.local?.name || '').filter(Boolean)
          });
        }
        for (const spec of stmt.specifiers || []) {
          const name = spec.exported?.name || spec.local?.name;
          if (name) {
            exportsList.add(name);
            if (spec.local?.name && !stmt.declaration) {
              symbols.push({
                name: String(name),
                kind: 'const',
                line: lineOf(spec),
                endLine: endLineOf(spec),
                exported: true,
                signature: `export { ${spec.local.name} }`
              });
            }
          }
        }
        if (stmt.declaration) handleDeclaration(stmt.declaration, true);
        continue;
      }
      if (stmt.type === 'ExportDefaultDeclaration') {
        const decl = stmt.declaration;
        exportsList.add('default');
        if (decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration') {
          handleDeclaration({ ...decl, id: decl.id || { name: 'default' } }, true);
        } else if (decl?.type === 'Identifier') {
          exportsList.add(decl.name);
        } else {
          addSymbol('default', 'const', stmt, true, 'export default');
        }
        continue;
      }
      if (stmt.type === 'ExportAllDeclaration') {
        imports.push({
          specifier: String(stmt.source?.value || ''),
          kind: 'reexport',
          line: lineOf(stmt),
          names: ['*']
        });
        continue;
      }
      handleDeclaration(stmt, false);
    }
  };

  visitTopLevel(ast.program?.body || []);

  // Walk call expressions for routes, require(), and dynamic import().
  const seen = new Set<any>();
  const walk = (node: any) => {
    if (!isNode(node) || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee?.type === 'Import') {
        const arg = node.arguments?.[0];
        if (arg?.type === 'StringLiteral') {
          imports.push({ specifier: arg.value, kind: 'dynamic-import', line: lineOf(node), names: [] });
        }
      } else if (callee?.type === 'Identifier' && callee.name === 'require') {
        const arg = node.arguments?.[0];
        if (arg?.type === 'StringLiteral') {
          imports.push({ specifier: arg.value, kind: 'require', line: lineOf(node), names: [] });
        }
      } else if (callee?.type === 'MemberExpression' && callee.property) {
        const method = String(callee.property.name || callee.property.value || '').toLowerCase();
        if (ROUTE_METHODS.has(method)) {
          const first = node.arguments?.[0];
          let routePath: string | null = null;
          if (first?.type === 'StringLiteral') routePath = first.value;
          else if (first?.type === 'TemplateLiteral' && (first.expressions || []).length === 0) {
            routePath = (first.quasis || []).map((q: any) => q.value?.cooked || '').join('');
          }
          if (routePath && routePath.startsWith('/')) {
            const handler = node.arguments?.[1];
            let handlerName = 'inlineHandler';
            if (handler?.type === 'Identifier') handlerName = handler.name;
            else if (handler?.type === 'MemberExpression') handlerName = handler.property?.name || 'memberHandler';
            else if (handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression') handlerName = 'inlineHandler';
            routes.push({ method: method.toUpperCase(), path: routePath, handlerSymbol: handlerName, line: lineOf(node) });
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) walk(item);
      } else if (isNode(child)) {
        walk(child);
      }
    }
  };
  walk(ast.program);

  // SQL tables embedded in source strings.
  const tableRx = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z0-9_]+)["'`\]]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRx.exec(code)) !== null) {
    const line = code.slice(0, m.index).split(/\r?\n/).length;
    models.push({ name: m[1], kind: 'sql_table', line });
  }

  // Prisma-style models when a .ts file embeds a schema block.
  const prismaRx = /^\s*model\s+([A-Za-z0-9_]+)\s*\{/gm;
  while ((m = prismaRx.exec(code)) !== null) {
    const line = code.slice(0, m.index).split(/\r?\n/).length;
    models.push({ name: m[1], kind: 'prisma_model', line });
  }

  const dedupedSymbols = dedupeSymbols(symbols);
  const dedupedImports = dedupeImports(imports);
  const dedupedRoutes = dedupeRoutes(routes);
  const dedupedModels = dedupeByName(models);

  return {
    parser: 'babel-ast-v1',
    imports: dedupedImports,
    symbols: dedupedSymbols.slice(0, 200),
    routes: dedupedRoutes,
    models: dedupedModels,
    exports: Array.from(exportsList),
    lineCount: code.split(/\r?\n/).length,
    errors
  };
}

function dedupeSymbols(symbols: AstSymbol[]): AstSymbol[] {
  const seen = new Set<string>();
  const out: AstSymbol[] = [];
  for (const s of symbols) {
    const key = `${s.kind}:${s.name}:${s.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function dedupeImports(imports: AstImport[]): AstImport[] {
  const seen = new Set<string>();
  const out: AstImport[] = [];
  for (const i of imports) {
    const key = `${i.kind}:${i.specifier}:${i.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

function dedupeRoutes(routes: AstRoute[]): AstRoute[] {
  const seen = new Set<string>();
  const out: AstRoute[] = [];
  for (const r of routes) {
    const key = `${r.method}:${r.path}:${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
}
