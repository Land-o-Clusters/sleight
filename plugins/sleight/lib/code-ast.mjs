// The node_repl cell parser contract. Loading stays synchronous so a first js call
// cannot be overtaken by js_reset or turn_ended while an ESM import is pending.
// The plugin launcher uses ChatGPT's Node, which supports synchronous ESM require.
import { createRequire } from 'node:module';

export const ENGINE_PARSE_OPTIONS = Object.freeze({ next: true, module: true, ranges: true, loc: false, disableWebCompat: true });
export const UNKNOWN = Symbol('unknown literal');
const require = createRequire(import.meta.url);
let parser;

export function parseCell(code) {
  if (typeof code !== 'string') throw new TypeError('cell source must be a string');
  parser ??= require('../vendor/meriyah/dist/meriyah.min.mjs');
  try { return { ast: parser.parseModule(code, ENGINE_PARSE_OPTIONS), error: null }; }
  catch (error) {
    // No stack, source excerpt or caller string is added to the upstream reason.
    if (!(error instanceof SyntaxError) || typeof error.description !== 'string') throw error;
    return { ast: null, error: { line: error.loc.start.line, column: error.loc.start.column, reason: error.description } };
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
      if (Array.isArray(value)) children.push(...value.filter(child => child && typeof child.type === 'string'));
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
  node = unchain(node);
  if (node?.type === 'MemberExpression') return Boolean(node.optional || optionalReceiver(node.object));
  if (node?.type === 'CallExpression') return Boolean(node.optional || optionalReceiver(node.callee));
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
// or control-flow proof is implied. Unknown top-level assignments clear hints.
export function handleBindings(ast, previous = new Map()) {
  const bindings = new Map(previous);
  const locatorFactories = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'locator', 'frameLocator', 'filter', 'first', 'last', 'nth', 'and', 'or']);
  function bind(name, source) {
    if (!name) return;
    const node = source?.type === 'AwaitExpression' ? source.argument : source;
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
    else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
      const assignment = statement.expression;
      if (assignment.left.type === 'Identifier') bind(assignment.left.name, assignment.operator === '=' ? assignment.right : undefined);
    }
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
