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
  parser: 'babel-ast-v1' | 'tree-sitter-wasm-v1' | 'regex-fallback';
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


// Tree-sitter is initialized once by CLI/MCP/test entry points. Parsing itself
// is synchronous after startup so existing indexer and MCP APIs remain stable.
const treeSitterGrammars: Record<string, string> = {
  '.js':'javascript', '.jsx':'javascript', '.mjs':'javascript', '.cjs':'javascript',
  '.ts':'typescript', '.tsx':'tsx', '.py':'python', '.go':'go', '.rs':'rust',
  '.java':'java', '.c':'c', '.h':'c', '.cc':'cpp', '.cpp':'cpp', '.cxx':'cpp',
  '.hpp':'cpp', '.hh':'cpp', '.cs':'c_sharp', '.php':'php', '.rb':'ruby'
};
let treeSitterInitPromise: Promise<void> | null = null;
let TreeSitterParser: any = null;
let TreeSitterLanguage: any = null;
const wasmParsers = new Map<string, any>();
export function initializeTreeSitter(): Promise<void> {
  if (!treeSitterInitPromise) treeSitterInitPromise = (async () => {
    try {
      const Parser = require('web-tree-sitter');
      await Parser.init();
      TreeSitterParser = Parser;
      TreeSitterLanguage = Parser.Language;
      const grammars = Array.from(new Set(Object.values(treeSitterGrammars).filter((g) => g !== 'javascript' && g !== 'typescript')));
      for (const grammar of grammars) {
        try {
          const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
          const language = await TreeSitterLanguage.load(wasmPath);
          const parser = new TreeSitterParser();
          parser.setLanguage(language);
          wasmParsers.set(grammar, parser);
        } catch (_) { /* One unavailable grammar must never block other languages. */ }
      }
    } catch (_) {
      // Optional runtime failure; indexer continues through regex extraction.
      TreeSitterParser = null;
    }
  })();
  return treeSitterInitPromise;
}
function getWasmParser(grammar: string): any | null {
  if (!TreeSitterParser || !TreeSitterLanguage) return null;
  return wasmParsers.get(grammar) || null;
}
export function parseTreeSitterModule(code: string, filename: string): AstParseResult | null {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const grammar = treeSitterGrammars[ext];
  if (!grammar || grammar === 'javascript' || grammar === 'typescript') return null;
  const parser = getWasmParser(grammar);
  if (!parser && grammar !== 'ruby') return null;
  try {
    if (grammar === 'ruby' && !parser) throw new Error('Ruby grammar unavailable');
    const tree = parser.parse(code);
    if (!tree || !tree.rootNode) return null;
    const symbols: AstSymbol[] = [];
    const imports: AstImport[] = [];
    const exportedNames: string[] = [];
    const symbolTypes: Record<string, AstSymbol['kind']> = {
      function_definition:'function', function_declaration:'function', function_item:'function', function_definition_item:'function',
      method_definition:'method', method_declaration:'method', method:'method', class_definition:'class', class_declaration:'class',
      class_specifier:'class', struct_specifier:'class', interface_declaration:'interface', trait_item:'interface',
      enum_declaration:'enum', enum_item:'enum', type_declaration:'type', type_alias_declaration:'type',
      function_definition_statement:'function'
    };
    const textOf = (node: any) => code.slice(node.startIndex, node.endIndex);
    const field = (node: any, name: string) => { try { return node.childForFieldName(name); } catch (_) { return null; } };
    const walk = (node: any) => {
      const type = String(node.type || '');
      const raw = textOf(node);
      if (/^(import_statement|import_declaration|use_declaration|include_directive|namespace_use_declaration|using_directive)$/.test(type)) {
        const match = raw.match(/(?:from\s+|import\s+|use\s+|#include\s*[<"]|require(?:_once)?\s*\(?\s*['"]?)([A-Za-z0-9_@./:\\-]+)/);
        if (match) imports.push({ specifier:match[1].replace(/[>"')]+$/,''), kind:'import', line:node.startPosition.row+1, names:[] });
      }
      const kind = symbolTypes[type];
      if (kind) {
        const nameNode = field(node,'name') || field(node,'declarator') || field(node,'type');
        let name = nameNode ? textOf(nameNode).replace(/^\*+/, '').trim() : '';
        if (!name && node.namedChildCount) {
          for (let i=0;i<node.namedChildCount;i++) { const child=node.namedChild(i); if (child && /identifier|name|type_identifier/.test(child.type)) { name=textOf(child); break; } }
        }
        name = name.split(/[\s(<:{[]/)[0].replace(/^[*&]+/,'');
        if (name && /^[A-Za-z_$][\w$!?=:.]*$/.test(name)) {
          const exported = /\b(export|pub|public)\b/.test(raw.slice(0, Math.min(raw.indexOf('{') < 0 ? 80 : raw.indexOf('{'),120))) || ['python','ruby'].includes(grammar);
          symbols.push({ name, kind, line:node.startPosition.row+1, endLine:node.endPosition.row+1, exported, signature:raw.slice(0,Math.min(raw.indexOf('{')<0?raw.length:raw.indexOf('{'),160)).replace(/\s+/g,' ').trim() });
          if(exported)exportedNames.push(name);
        }
      }
      for(let i=0;i<(node.namedChildCount||0);i++){const child=node.namedChild(i);if(child)walk(child);}
    };
    walk(tree.rootNode);
    const uniqueSymbols = dedupeSymbols(symbols);
    const uniqueImports = dedupeImports(imports);
    return { parser:'tree-sitter-wasm-v1', imports:uniqueImports, symbols:uniqueSymbols.slice(0,200), routes:[], models:[], exports:Array.from(new Set(exportedNames)), lineCount:code.split(/\r?\n/).length, errors:tree.rootNode.hasError?['Tree-sitter recovered from syntax errors']:[] };
  } catch (_) {
    if (grammar !== 'ruby') return null;
    const symbols: AstSymbol[] = [];
    const lines = code.split(/\r?\n/);
    lines.forEach((line, i) => {
      const klass = line.match(/^\s*class\s+([A-Z][A-Za-z0-9_:]*)/);
      const fn = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      if (klass) symbols.push({ name: klass[1], kind: 'class', line: i + 1, endLine: i + 1, exported: true, signature: line.trim() });
      else if (fn) symbols.push({ name: fn[1], kind: 'function', line: i + 1, endLine: i + 1, exported: !fn[1].startsWith('_'), signature: line.trim() });
    });
    const imports: AstImport[] = [];
    lines.forEach((line, i) => { const m = line.match(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/); if (m) imports.push({ specifier:m[1], kind:'import', line:i+1, names:[] }); });
    return { parser:'regex-fallback', imports, symbols, routes:[], models:[], exports:symbols.filter(s=>s.exported).map(s=>s.name), lineCount:lines.length, errors:['Ruby Tree-sitter grammar failed; used regex fallback'] };
  }
}
