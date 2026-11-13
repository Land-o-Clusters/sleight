// The node_repl cell parser contract. Loading stays synchronous so a first js call
// cannot be overtaken by js_reset or turn_ended while an ESM import is pending.
// The plugin launcher uses ChatGPT's Node, which supports synchronous ESM require.
import { createRequire } from 'node:module';

export const ENGINE_PARSE_OPTIONS = Object.freeze({ next: true, module: true, ranges: true, loc: false, disableWebCompat: true });
export const UNKNOWN = Symbol('unknown literal');
const require = createRequire(import.meta.url);
let parser;

function loadParser() {
  parser ??= require('../vendor/meriyah/dist/meriyah.min.mjs');
  return parser;
}

export function parserDoctorLine() {
  try {
    const loaded = loadParser();
    if (typeof loaded.parseModule !== 'function') throw new TypeError();
    return `cell parser: loaded Meriyah ${loaded.version}; Node ${process.version}`;
  } catch {
    return `PROBLEM cell parser: unavailable; Node ${process.version}. Use Node 22.12+ with synchronous ESM loading.`;
  }
}

const safeReason = reason => reason.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 200);

// Bounded source cache shares immutable syntax trees between request consumers.
// Each distinct rewritten cell has its own entry; no source is evaluated.
const cells = new Map();
let cellBytes = 0, activeCells, scriptCells = false;
export function withCellCache(run, { script = scriptCells } = {}) {
  const previous = activeCells, previousScript = scriptCells;
  scriptCells = script;
  activeCells ??= new Map();
  try { return run(); } finally { activeCells = previous; scriptCells = previousScript; }
}
export function clearCellCache() { cells.clear(); cellBytes = 0; }
export function parseCell(code) {
  if (typeof code !== 'string') return parseUncachedCell(code);
  const key = (scriptCells ? 'script:' : 'module:') + code;
  if (activeCells?.has(key)) return activeCells.get(key);
  if (cells.has(key)) { const result = cells.get(key); activeCells?.set(key, result); return result; }
  const result = parseUncachedCell(code);
  activeCells?.set(key, result);
  if (typeof code === 'string' && code.length <= 262144) {
    while (cells.size >= 32 || cellBytes + key.length > 524288) {
      const first = cells.keys().next().value; cellBytes -= first.length; cells.delete(first);
    }
    cells.set(key, result); cellBytes += key.length;
  }
  return result;
}
function parseUncachedCell(code) {
  let loaded = false, cellErrorPosition, wrappedEnd = false;
  try {
    const cellParser = loadParser();
    loaded = true;
    if (typeof code !== 'string') throw new TypeError('cell source must be a string');
    const comments = [];
    const onComment = (_type, _text, start, end) => comments.push({ range: [start, end] });
    let ast;
    if (scriptCells) {
      // Node's REPL treats await (app).method() as an await expression, though
      // a plain script parser reads await as a function name. Prefer an async
      // body, then allow sloppy await identifiers if that body does not parse.
      const options = { next: true, ranges: true, lexical: true, webcompat: true, onComment };
      const prefix = 'async function __cell__(){\n';
      let wrapped = false;
      try {
        const source = prefix + code + '\n}', program = cellParser.parseScript(source, options);
        const wrapper = program.body[0];
        // A cell must not close this function and leave uninspected statements
        // beside it, or replace its closing brace with another function's body.
        if (program.body.length !== 1 || wrapper?.type !== 'FunctionDeclaration' ||
            wrapper.start !== 0 || wrapper.end !== source.length ||
            wrapper.body.start !== prefix.length - 2 || wrapper.body.end !== source.length)
          throw new SyntaxError('cell escaped the async wrapper');
        ast = wrapper.body; wrapped = true;
      } catch (wrappedError) {
        comments.length = 0;
        try { ast = cellParser.parseScript(code, options); }
        catch (plainError) {
          // Prefer the grammar that progressed furthest through the cell. Await
          // expressions reach their actual typo in the async body; sloppy await
          // identifiers reach it in the plain script. The appended closing
          // brace instead points at the original cell's end of input.
          const asyncAt = wrappedError.loc?.start, plainAt = plainError.loc?.start;
          const lines = code.split(/\r\n|[\r\n\u2028\u2029]/);
          const beyondCell = asyncAt && asyncAt.line - 1 > lines.length;
          const line = asyncAt && Math.max(1, Math.min(lines.length, asyncAt.line - 1));
          const column = beyondCell ? lines.at(-1).length : asyncAt?.column;
          if (asyncAt && plainAt && (line > plainAt.line || line === plainAt.line && column >= plainAt.column)) {
            cellErrorPosition = { line, column }; wrappedEnd = beyondCell; throw wrappedError;
          }
          throw plainError;
        }
      }
      if (wrapped) {
        for (const node of walk(ast)) if (node.range) {
          node.range = node.range.map(n => n - prefix.length);
          node.start -= prefix.length; node.end -= prefix.length;
        }
        for (const comment of comments) comment.range = comment.range.map(n => n - prefix.length);
        ast = { ...ast, type: 'Program', sourceType: 'script', start: 0, end: code.length, range: [0, code.length] };
      }
    } else ast = cellParser.parseModule(code, { ...ENGINE_PARSE_OPTIONS, onComment });
    return { ast, comments, error: null };
  } catch (error) {
    // No stack, source excerpt or caller string is added to the upstream reason.
    const syntax = error instanceof SyntaxError && typeof error.description === 'string';
    const line = cellErrorPosition?.line ?? (syntax && Number.isInteger(error.loc?.start?.line) ? error.loc.start.line : 0);
    const column = cellErrorPosition?.column ?? (syntax && Number.isInteger(error.loc?.start?.column) ? error.loc.start.column : 0);
    let reason = wrappedEnd ? 'Unexpected end of input' : syntax ? error.description : loaded ? 'cannot parse this cell'
      : `cannot parse this cell: parser unavailable on Node ${process.version}. Use Node 22.12+ with synchronous ESM loading.`;
    if (syntax && code.includes('\r') && /unterminated string/i.test(reason)) reason += '. Escape literal CR as \\r.';
    return { ast: null, error: { line, column, reason: safeReason(reason) } };
  }
}

// All AST descendants, including calls in template expressions and function bodies.
// This is a syntactic inventory, not a claim that a branch will execute.
export function* walk(ast) {
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node.type !== 'string') continue;
    yield node;
    const children = [];
    for (const value of Object.values(node)) {
      // A loop, not push(...array): spreading a very large body throws RangeError.
      if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') children.push(child); }
      else if (value && typeof value.type === 'string') children.push(value);
    }
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
}

// Preserve the node beside its source range so consumers need not re-parse slices.
export function statements(ast) {
  return ast.body.map(node => ({ node, range: [...node.range], start: node.range[0], end: node.range[1] }));
}

const unchain = node => node?.type === 'ChainExpression' ? node.expression : node;
const optionalReceiver = node => {
  for (;;) {
    node = unchain(node);
    if (!['MemberExpression', 'CallExpression'].includes(node?.type)) break;
    if (node.optional) return true;
    node = node.type === 'MemberExpression' ? node.object : node.callee;
  }
  return false;
};

export function memberCall(node) {
  node = unchain(node);
  if (node?.type === 'AwaitExpression') node = unchain(node.argument);
  if (node?.type !== 'CallExpression') return null;
  const callee = unchain(node.callee);
  if (callee?.type !== 'MemberExpression') return null;
  const name = callee.computed ? literalValue(callee.property) : callee.property.type === 'Identifier' ? callee.property.name : UNKNOWN;
  const optional = Boolean(node.optional || optionalReceiver(callee));
  return { receiver: callee.object, method: typeof name === 'string' ? name : UNKNOWN,
    computed: Boolean(callee.computed), optional, args: node.arguments };
}

// Every possible invocation, including nested functions and unevaluated branches.
// Computed, indirect, constructor and tag calls need a consumer's unknown policy.
export function callInventory(ast) {
  const calls = [];
  for (const node of walk(ast)) {
    if (node.type === 'ImportExpression') { calls.push({ node, kind: 'unknown' }); continue; }
    if (!['CallExpression', 'NewExpression', 'TaggedTemplateExpression'].includes(node.type)) continue;
    const call = node.callee?.type === 'Super' || node.callee?.object?.type === 'Super' ? null : memberCall(node);
    calls.push(call && !call.computed ? { node, kind: 'member', ...call } : { node, kind: 'unknown' });
  }
  return calls;
}

// Only data literals. In particular, do not evaluate constant-looking expressions,
// spread, getters, identifiers, regexes, tagged templates or interpolations.
export function literalValue(node) {
  if (!node) return UNKNOWN;
  if (node.type === 'Literal') {
    if (node.regex || node.bigint !== undefined) return UNKNOWN;
    return node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value) ? node.value : UNKNOWN;
  }
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length) return UNKNOWN;
    const quasi = node.quasis[0].value;
    // Meriyah 7 retains physical CR in cooked templates. Normalize the raw text
    // and let the same parser cook it again, preserving escaped \r as data.
    if (quasi.raw.includes('\r')) {
      const parsed = parseCell('`' + quasi.raw.replace(/\r\n?/g, '\n') + '`');
      return parsed.error ? UNKNOWN : parsed.ast.body[0].expression.quasis[0].value.cooked ?? UNKNOWN;
    }
    return quasi.cooked ?? UNKNOWN;
  }
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) {
    const value = literalValue(node.argument);
    return typeof value === 'number' ? (node.operator === '-' ? -value : value) : UNKNOWN;
  }
  if (node.type === 'ArrayExpression') {
    const values = node.elements.map(literalValue);
    return values.includes(UNKNOWN) ? UNKNOWN : values;
  }
  if (node.type === 'ObjectExpression') {
    const entries = [];
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.shorthand || property.computed) return UNKNOWN;
      const key = property.key.type === 'Identifier' ? property.key.name : literalValue(property.key);
      const value = literalValue(property.value);
      if (!['string', 'number'].includes(typeof key) || value === UNKNOWN) return UNKNOWN;
      entries.push([String(key), value]);
    }
    // This is a data snapshot, not object evaluation: __proto__ stays an own key
    // and never changes the result's prototype. Consumers must not treat it as code.
    return Object.fromEntries(entries);
  }
  return UNKNOWN;
}

function rootName(node) {
  node = unchain(node);
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression') return rootName(node.object);
  if (node?.type === 'CallExpression') return rootName(node.callee);
  return undefined;
}

// Top-level binding hints for later consumers. No function aliases, scope analysis
// or control-flow proof is implied. Any assignment anywhere clears that name,
// including inside functions that might run later. Shadowed names are conservative.
export function invalidHandleNames(ast) {
  const assigned = new Set();
  function targets(pattern) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') assigned.add(pattern.name);
    else if (pattern.type === 'RestElement') targets(pattern.argument);
    else if (pattern.type === 'AssignmentPattern') targets(pattern.left);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(targets);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(property =>
      targets(property.type === 'RestElement' ? property.argument : property.value));
    else if (pattern.type === 'VariableDeclaration') pattern.declarations.forEach(declaration => targets(declaration.id));
  }
  for (const node of walk(ast)) {
    if (node.type === 'AssignmentExpression') targets(node.left);
    else if (node.type === 'UpdateExpression') targets(node.argument);
    else if (['ForInStatement', 'ForOfStatement'].includes(node.type)) targets(node.left);
    else if (node.type === 'VariableDeclarator' && node.id.type !== 'Identifier') targets(node.id);
    else if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) node.params.forEach(targets);
    else if (node.type === 'CatchClause') targets(node.param);
    if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type)) targets(node.id);
  }
  const top = new Set(ast.body.flatMap(statement => statement.type === 'VariableDeclaration' ? statement.declarations : []));
  for (const node of walk(ast)) {
    if (node.type === 'VariableDeclarator' && !top.has(node)) targets(node.id);
  }
  return assigned;
}

export function handleBindings(ast, previous = new Map()) {
  const bindings = new Map(previous), assigned = invalidHandleNames(ast);
  for (const name of assigned) bindings.delete(name);
  const nonHandle = node => {
    if (literalValue(node) !== UNKNOWN) return true;
    // Even undefined can name a handle from an earlier REPL cell. No identifier
    // proves a non-handle value; void of literal data needs no scope inference.
    return node?.type === 'UnaryExpression' && node.operator === 'void' && literalValue(node.argument) !== UNKNOWN;
  };
  function nonHandleCatch(handler) {
    if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(handler?.type) || handler.async || handler.generator ||
        handler.params.some(param => param.type !== 'Identifier')) return false;
    if (handler.body.type !== 'BlockStatement') return nonHandle(handler.body);
    // Only a single return/rethrow (or implicit undefined). No calls, mutations,
    // sequences, default parameters or control-flow inference in this proof.
    if (!handler.body.body.length) return true;
    if (handler.body.body.length !== 1) return false;
    const statement = handler.body.body[0];
    if (statement.type === 'ReturnStatement') return !statement.argument || nonHandle(statement.argument);
    return statement.type === 'ThrowStatement' && statement.argument.type === 'Identifier' &&
      handler.params[0]?.name === statement.argument.name;
  }
  const locatorFactories = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'locator', 'frameLocator', 'filter', 'first', 'last', 'nth', 'and', 'or']);
  function bind(name, source) {
    if (!name || assigned.has(name)) return;
    let node = source?.type === 'AwaitExpression' ? source.argument : source;
    const caught = memberCall(node);
    if (caught?.method === 'catch') {
      const acquisition = memberCall(caught.receiver);
      if (!caught.computed && !caught.optional && caught.args.length === 1 && nonHandleCatch(caught.args[0]) &&
          acquisition && !acquisition.computed && !acquisition.optional &&
          (acquisition.receiver.type === 'Identifier' && acquisition.receiver.name === 'cua' &&
            ['getApp', 'getBrowser', 'getTab', 'createBrowserTab'].includes(acquisition.method) ||
           acquisition.receiver.type === 'MemberExpression' && !acquisition.receiver.computed &&
            acquisition.receiver.property.name === 'tabs' && ['get', 'new'].includes(acquisition.method))) node = caught.receiver;
      else { bindings.delete(name); return; }
    }
    let hint;
    if (node?.type === 'Identifier' && /^__sleightOpenedApp\d+$/.test(node.name)) hint = { kind: 'app', source: node.name };
    const call = memberCall(node);
    if (call && !call.computed && !call.optional) {
      const root = rootName(call.receiver), value = literalValue(call.args[0]);
      if (call.receiver.type === 'Identifier' && root === 'cua') {
        if (call.method === 'getApp' && typeof value === 'string') hint = { kind: 'app', app: value };
        else if (['getBrowser', 'getTab', 'createBrowserTab'].includes(call.method)) hint = { kind: 'browser' };
      } else if (['browser', 'locator'].includes(bindings.get(root)?.kind)) {
        const methods = [...walk(node)].filter(part => part.type === 'CallExpression').map(memberCall).filter(Boolean);
        if (methods.some(part => locatorFactories.has(part.method))) hint = { kind: 'locator', root };
        else if (['get', 'new'].includes(call.method) && call.receiver.type === 'MemberExpression' &&
            !call.receiver.computed && call.receiver.property.name === 'tabs') hint = { kind: 'browser', root };
      }
    }
    if (hint) bindings.set(name, { ...hint, range: [...source.range] });
    else bindings.delete(name);
  }
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') for (const declaration of statement.declarations)
      bind(declaration.id.type === 'Identifier' ? declaration.id.name : undefined, declaration.init);
  }
  return bindings;
}

export function arrowRegexTest(node) {
  if (node?.type !== 'ArrowFunctionExpression' || node.async || node.params.length !== 1 || node.params[0].type !== 'Identifier') return null;
  const call = memberCall(node.body);
  if (!call || call.optional || call.computed || call.method !== 'test' || call.args.length !== 1 ||
      call.args[0].type !== 'Identifier' || call.args[0].name !== node.params[0].name || !call.receiver.regex) return null;
  return { parameter: node.params[0].name, pattern: call.receiver.regex.pattern, flags: call.receiver.regex.flags };
}
