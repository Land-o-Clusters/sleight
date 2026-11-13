import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { parseModule, parseScript } from '../../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs';

export const childRoots = ['tests', 'bench/native-path/test', 'bench/direct-native/test', 'plugins/sleight'];
const methods = new Set(['spawnSync', 'execFileSync', 'execSync']);
const key = node => node?.type === 'Identifier' ? node.name : node?.value;
const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value : [value])
  .filter(value => value && typeof value.type === 'string');
const childModule = node => ['child_process', 'node:child_process'].includes(node?.value);
const unknown = Symbol('unresolved expression');

// Follow lexical bindings, including injected defaults and CommonJS/ESM aliases.
// Strings containing example code are data, never parsed as executable source.
export function childCalls(source, file = 'fixture.mjs') {
  const comments = [];
  const options = { next: true, ranges: true, loc: true, jsx: true,
    onComment: (_kind, value, start, end) => comments.push({ value, start, end }) };
  let ast;
  try { ast = parseModule(source, options); }
  catch (moduleError) {
    comments.length = 0;
    try { ast = parseScript(source, options); }
    catch { throw new Error(`${file}:${moduleError.loc?.start?.line ?? 1}: ${moduleError.description ?? moduleError.message}`); }
  }
  const scopes = new WeakMap(), calls = [];
  const scope = parent => ({ parent, bindings: new Map() });
  const root = scope(null);
  function bind(pattern, value, current) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') current.bindings.set(pattern.name, { value, scope: current });
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, pattern.right, current);
    else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
      if (property.type === 'RestElement') bind(property.argument, null, current);
      else if (property.value.type === 'AssignmentPattern') bind(property.value, null, current);
      else bind(property.value, value && { type: 'MemberExpression', object: value,
        property: { type: 'Literal', value: key(property.key) }, computed: true }, current);
    }
    else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements) bind(item, null, current);
    else if (pattern.type === 'RestElement') bind(pattern.argument, null, current);
  }
  function visit(node, current) {
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      if (node.type === 'FunctionDeclaration') bind(node.id, null, current);
      current = scope(current);
      for (const parameter of node.params) bind(parameter, null, current);
    } else if (node.type === 'BlockStatement' || node.type === 'CatchClause') {
      current = scope(current);
      if (node.param) bind(node.param, null, current);
    }
    scopes.set(node, current);
    if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) {
      let value = null;
      if (childModule(node.source)) value = specifier.type === 'ImportSpecifier'
        ? { type: 'Literal', value: 'child:' + key(specifier.imported) }
        : { type: 'Literal', value: 'child:namespace' };
      bind(specifier.local, value, current);
    }
    if (node.type === 'VariableDeclarator') bind(node.id, node.init, current);
    if (node.type === 'AssignmentExpression' && node.operator === '=') bind(node.left, node.right, current);
    if (node.type === 'CallExpression') calls.push(node);
    for (const child of children(node)) visit(child, current);
  }
  visit(ast, root);
  function binding(name, current) {
    for (; current; current = current.parent) if (current.bindings.has(name)) return current.bindings.get(name);
  }
  function resolve(node, current, seen = new Set()) {
    if (!node || seen.has(node)) return unknown;
    seen = new Set(seen).add(node);
    if (node.type === 'Identifier') {
      const bound = binding(node.name, current);
      if (bound) return resolve(bound.value, bound.scope, seen);
      if (methods.has(node.name)) return 'child:' + node.name;
      if (node.name === 'undefined') return undefined;
      if (node.name === 'Infinity') return Infinity;
      if (node.name === 'NaN') return NaN;
      return unknown;
    }
    if (node.type === 'Literal') return node.value;
    if (node.type === 'CallExpression' && node.callee.name === 'require' && childModule(node.arguments[0])) return 'child:namespace';
    if (node.type === 'AwaitExpression' && node.argument.type === 'ImportExpression' && childModule(node.argument.source)) return 'child:namespace';
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.property.name === 'bind') return resolve(node.callee.object, current, seen);
    if (node.type === 'MemberExpression' && resolve(node.object, current, seen) === 'child:namespace') {
      return 'child:' + key(node.property);
    }
    if (node.type === 'UnaryExpression' && node.operator === 'void') return undefined;
    return unknown;
  }
  function properties(node, current, seen = new Set()) {
    if (!node || seen.has(node)) return new Map();
    seen = new Set(seen).add(node);
    if (node.type === 'Identifier') {
      const bound = binding(node.name, current);
      return bound ? properties(bound.value, bound.scope, seen) : new Map();
    }
    // Frozen option records still have ordinary object properties.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'Object' && node.callee.property.name === 'freeze') return properties(node.arguments[0], current, seen);
    const result = new Map();
    if (node.type === 'ObjectExpression') for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        for (const [name, value] of properties(property.argument, current, seen)) result.set(name, value);
      } else result.set(key(property.key), { node: property.value, scope: current });
    }
    return result;
  }
  return calls.flatMap(node => {
    const current = scopes.get(node), method = resolve(node.callee, current)?.replace?.(/^child:/, '');
    if (!methods.has(method)) return [];
    const optionIndex = method === 'execSync' ? 1 : node.arguments[1]?.type === 'ObjectExpression' ? 1 : 2;
    const option = node.arguments[optionIndex], props = properties(option, current);
    const timeout = props.get('timeout'), kill = props.get('killSignal');
    const timeoutValue = timeout && resolve(timeout.node, timeout.scope);
    const hasTimeout = !!timeout && (timeoutValue === unknown ? true :
      typeof timeoutValue === 'number' && Number.isFinite(timeoutValue) && timeoutValue > 0);
    const hasKill = !!kill && resolve(kill.node, kill.scope) === 'SIGKILL';
    const optOut = comments.find(comment => comment.end <= node.start &&
      source.slice(comment.end, node.start).trim() === '' && /^\s*child-bounds: cannot-hang:\s*\S/.test(comment.value));
    return [{ file, line: node.loc.start.line, method, node, option, props, hasTimeout, hasKill,
      optOut: optOut?.value.trim() }];
  });
}

export function scanChildren(root, roots = childRoots) {
  const calls = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), file = relative(root, path);
      if (file === 'plugins/sleight/vendor' || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (/\.(?:mjs|cjs|js)$/.test(entry.name) || !entry.name.includes('.'))) {
        const source = readFileSync(path, 'utf8');
        if (/\.(?:mjs|cjs|js)$/.test(entry.name) || /^#![^\n]*\bnode\b/.test(source)) calls.push(...childCalls(source, file));
      }
    }
  }
  for (const directory of roots) walk(join(root, directory));
  return calls;
}

export const boundViolations = calls => calls.filter(call => !call.optOut && (!call.hasTimeout || !call.hasKill))
  .map(call => `${call.file}:${call.line}: ${call.method} needs ${[!call.hasTimeout && 'positive timeout', !call.hasKill && "killSignal: 'SIGKILL'"].filter(Boolean).join(' and ')}`);

export function assertBoundedChildren(root, roots = childRoots) {
  const violations = boundViolations(scanChildren(root, roots));
  assert.deepEqual(violations, [], violations.join('\n'));
}
