import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseModule } from '../../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;
const parser = () => ts ??= require('typescript');

const kids = n => Object.values(n).flatMap(v => Array.isArray(v) ? v : [v]).filter(v => v && typeof v.type === 'string');
const key = n => n?.name ?? n?.value;
// Partial evaluation preserves literal prefixes and suffixes around unknown data.
// It never executes repository modules or their subprocess launchers.
export function auditGuestStdin(source, file = 'fixture.mjs') {
  const ast = parseModule(source, { next: true, loc: true, ranges: true, jsx: true });
  const scopes = new WeakMap(), calls = [], root = { bindings: new Map() };
  function bind(scope, name, node, position) {
    const versions = scope.bindings.get(name) ?? [];
    versions.push({ node, scope, position }); scope.bindings.set(name, versions);
  }
  function visit(n, scope) {
    if (/Function(?:Declaration|Expression)|ArrowFunctionExpression/.test(n.type)) {
      if (n.id) bind(scope, n.id.name, n, -1);
      scope = { parent: scope, bindings: new Map() };
      for (const p of n.params) if (p.type === 'Identifier') bind(scope, p.name, null, -1);
    } else if (n.type === 'BlockStatement') scope = { parent: scope, bindings: new Map() };
    scopes.set(n, scope);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') bind(scope, n.id.name, n.init, n.range[0]);
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') {
      let owner = scope;
      while (owner.parent && !owner.bindings.has(n.left.name)) owner = owner.parent;
      bind(owner, n.left.name, n.right, n.range[0]);
    }
    if (n.type === 'CallExpression') calls.push(n);
    for (const child of kids(n)) visit(child, scope);
  }
  visit(ast, root);
  function binding(name, scope, at) {
    for (; scope; scope = scope.parent) if (scope.bindings.has(name)) {
      return scope.bindings.get(name).filter(b => b.position <= at).at(-1);
    }
  }
  function expression(n, scope, seen = new Set(), at = n?.range[0] ?? Infinity) {
    if (!n || seen.has(n)) return '?';
    seen = new Set(seen).add(n);
    const value = x => expression(x, scopes.get(x) ?? scope, seen, at);
    if (n.type === 'Identifier') {
      const b = binding(n.name, scope, at); return b ? expression(b.node, b.scope, seen, b.position) : '?';
    }
    if (n.type === 'Literal') return n.value;
    if (n.type === 'TemplateLiteral') return n.quasis.map((q, i) => q.value.cooked + (n.expressions[i] ? String(value(n.expressions[i])) : '')).join('');
    if (n.type === 'BinaryExpression' && n.operator === '+') return String(value(n.left)) + String(value(n.right));
    if (n.type === 'ArrayExpression') return n.elements.flatMap(e => e?.type === 'SpreadElement' ? value(e.argument) : [value(e)]);
    if (n.type === 'ObjectExpression') {
      const obj = {};
      for (const p of n.properties) {
        if (p.type === 'SpreadElement') Object.assign(obj, value(p.argument));
        else obj[key(p.key)] = value(p.value);
      }
      return obj;
    }
    if (n.type === 'CallExpression') {
      if (n.callee.type === 'MemberExpression') {
        const method = key(n.callee.property), receiver = value(n.callee.object);
        if (method === 'join' && Array.isArray(receiver)) {
          const separator = n.arguments.length ? value(n.arguments[0]) : ',';
          return typeof separator === 'string' ? receiver.join(separator) : '?';
        }
        // Only path helpers join their arguments. Array.join joins the receiver.
        const object = n.callee.object;
        if (['join', 'resolve'].includes(method) &&
            ['path', 'win32', 'posix'].includes(object.name ?? key(object.property))) return n.arguments.map(value).join('/');
      }
      if (n.callee.type === 'Identifier') {
        const b = binding(n.callee.name, scope, at), fn = b?.node;
        if (fn && /Function/.test(fn.type)) {
          const returns = [];
          const find = x => { if (x.type === 'ReturnStatement') returns.push(x.argument); else for (const k of kids(x)) find(k); };
          find(fn.body);
          if (returns.length === 1) return expression(returns[0], scopes.get(returns[0]) ?? scope, seen);
        }
      }
    }
    return '?';
  }
  const sites = [], violations = [];
  function inspect(n, command, args, input, explicitInput = false) {
    const argv = Array.isArray(args) ? args.join(' ') : String(args);
    const text = String(command) + ' ' + argv;
    const flag = '-(?:c|co|com|comm|comma|comman|command|f|fi|fil|file)';
    const stdinFlag = new RegExp(`(?:^|\\s)${flag}(?:\\s+|:)['"]?-['"]?(?:\\s|$)`, 'i').test(text);
    const unknownCommand = String(command).includes('?');
    const shellName = /^(?:ps|powershell|pwsh)$/i.test(n.arguments[0]?.name ?? '');
    const possibleStdin = /(?:^|\s)-(?:\s|$)/.test(argv) || new RegExp(`(?:^|\\s)${flag}(?:\\s|:|$)`, 'i').test(argv);
    if (!/(?:powershell|pwsh)(?:\.exe)?(?:[\s/\\'"`]|$)/i.test(text) && !(unknownCommand && (possibleStdin || shellName && explicitInput && args === '?'))) return;
    // Explicit inline scripts, file paths and encoded workers consume data, not
    // source, on stdin. With no such argument PowerShell reads source by default.
    const scriptArgument = /(?:^|\s)-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?:\s|:)/i.test(text) ||
      new RegExp(`(?:^|\\s)${flag}(?:\\s+|:)(?!['"]?-(?:['"]?(?:\\s|$)))\\S+`, 'i').test(text);
    if (!stdinFlag && scriptArgument) return;
    const site = `${file}:${n.loc.start.line}`; sites.push(site);
    if (typeof input !== 'string' || !/\r?\n\r?\n$/.test(input)) violations.push(`${site}: PowerShell stdin needs a final blank line`);
  }
  const streamed = new Set();
  for (const n of calls) {
    if (n.callee.type !== 'MemberExpression' || !['end', 'write'].includes(key(n.callee.property)) ||
        key(n.callee.object?.property) !== 'stdin') continue;
    const receiver = n.callee.object.object, scope = scopes.get(n);
    const b = receiver.type === 'Identifier' && binding(receiver.name, scope, n.range[0]);
    const launch = receiver.type === 'CallExpression' ? receiver : b?.node;
    if (launch?.type === 'CallExpression') streamed.add(launch);
  }
  for (const n of calls) {
    const scope = scopes.get(n), values = n.arguments.map(a => expression(a, scope));
    if (n.arguments.length >= 2) {
      const options = values.find((v, i) => i > 0 && v && typeof v === 'object' && !Array.isArray(v));
      // Spawned workers may provide the script later through stdin.end/write.
      if (options && Object.hasOwn(options, 'input')) inspect(n, values[0], values[1], options.input, true);
      else if (!streamed.has(n) && Array.isArray(values[1])) inspect(n, values[0], values[1], undefined);
    }
    if (n.callee.type === 'MemberExpression' && ['end', 'write'].includes(key(n.callee.property)) &&
        key(n.callee.object?.property) === 'stdin') {
      const receiver = n.callee.object.object;
      const b = receiver.type === 'Identifier' && binding(receiver.name, scope, n.range[0]), launch = b?.node;
      const spawned = receiver.type === 'CallExpression' ? receiver : launch;
      if (spawned?.type === 'CallExpression') inspect(n, expression(spawned.arguments[0], b?.scope ?? scope),
        expression(spawned.arguments[1], b?.scope ?? scope), values[0]);
    }
  }
  return { sites, violations };
}

export function scanGuestStdin(root) {
  const result = { sites: [], violations: [], files: 0 };
  function walk(path) {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = join(path, e.name), file = relative(root, full);
      if (e.isDirectory()) walk(full);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) {
        result.files++;
        const source = readFileSync(full, 'utf8');
        const js = /\.(?:[cm]?ts|tsx)$/.test(e.name) ? parser().transpileModule(source, { fileName: file,
          compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText : source;
        const audit = auditGuestStdin(js, file);
        result.sites.push(...audit.sites); result.violations.push(...audit.violations);
      }
    }
  }
  for (const dir of ['bench', 'plugins']) walk(join(root, dir));
  return result;
}
