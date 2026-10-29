// Compare only trees the relay already has. No reads, input, focus changes or repair.
import { parseCell, walk, memberCall, literalValue } from './code-ast.mjs';
import { createHash } from 'node:crypto';
import { documentKey, windowFromText, hasIdentifier, hasLabel } from './document-scope.mjs';

const META = 'Value|Description|ID|Help|Placeholder|Secondary Actions|URL|Selected text';
const roleOf = body => /^(?:secure text field|search text field|search field|text field|text entry area|text area|combo box|email field|telephone number field)\b/.exec(body)?.[0];
const field = (body, name) => {
  const role = roleOf(body), rest = role ? body.slice(role.length).replace(/^\s*(?:\([^)]*\)\s*)?/, '') : body;
  return new RegExp('(?:^|, )' + name + ': ?([\\s\\S]*?)(?=, (?:' + META + '):|$)').exec(rest)?.[1];
};
const identity = body => body.replace(new RegExp(',? (?:Value|Selected text): [\\s\\S]*?(?=, (?:' + META + '):|$)', 'g'), '')
  .replace(/\([^)]*\)/g, '').trim();
const safeLabel = text => text.trim().split(new RegExp('(?:^|, )(?:(?:' + META + '):)'))[0].trim() || 'unlabeled';
export function writeFields(text) {
  const stack = [], fields = [];
  const rows = [];
  for (const line of String(text ?? '').replace(/\n$/, '').split('\n')) {
    const m = /^(\t*)(\d+) (.*)$/.exec(line);
    if (m) rows.push(m);
    else if (/^The focused UI element is |^sleight:/.test(line)) {
      if (rows.length) rows.at(-1)[3] = rows.at(-1)[3].replace(/\n$/, '');
      break;
    }
    else if (rows.length && /\bValue:/.test(rows.at(-1)[3])) rows.at(-1)[3] += '\n' + line;
  }
  for (const m of rows) {
    const depth = m[1].length, body = m[3];
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const path = JSON.stringify([...(stack.at(-1)?.path ?? []), identity(body)]);
    stack.push({ depth, path: JSON.parse(path) });
    const role = roleOf(body);
    if (role) fields.push({ number: Number(m[2]), body, path, role, value: field(body, 'Value') ?? '', exposed: field(body, 'Value') !== undefined,
      label: safeLabel(field(body, 'Description') ?? body.slice(role.length).replace(/^\s*\([^)]*\)\s*/, '')) });
  }
  return fields;
}

// Literal calls only. Unknown expressions, loops and indirect calls cannot establish a write's effect.
export function fieldWrites(code, before) {
  const { ast, error } = parseCell(code ?? '');
  if (error) return [];
  const nodes = [...walk(ast)];
  const refuses = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'IfStatement', 'SwitchStatement',
    'ClassDeclaration', 'ClassExpression']);
  if (nodes.some(node => refuses.has(node.type) || node.type === 'TemplateLiteral' && node.expressions.length)) return [];
  // Preserve the direct, literal-call scope of effect attribution. Nested arguments
  // of a member call cannot establish an independent observed action here.
  const calls = [];
  let end = -1;
  for (const node of nodes) {
    if (node.type !== 'CallExpression' || node.range[0] < end) continue;
    const call = memberCall(node);
    if (!call || call.computed || call.optional) continue;
    calls.push(call); end = node.range[1];
  }
  if (!calls.some(call => ['setValue', 'typeText'].includes(call.method))) return [];
  const fields = writeFields(before), writes = [], aims = new Map();
  let actionIndex = 0;
  const inputs = new Set(['click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'paste', 'pressKey', 'scroll', 'drag',
    'selectText', 'performSecondaryAction', 'performAction', 'press']);
  const handleOf = call => call.receiver.type === 'Identifier' ? call.receiver.name : undefined;
  const handles = new Set(calls.filter(call => ['setValue', 'typeText', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(call.method))
    .map(handleOf).filter(Boolean));
  // Static templates remain string literals for compatibility with SB3.
  const literal = arg => { const value = literalValue(arg); return typeof value === 'string' ? value : undefined; };
  const resolve = arg => {
    if (arg?.type === 'Literal' && typeof arg.value === 'number' && /^\d+$/.test(code.slice(...arg.range)))
      return fields.filter(f => f.number === arg.value);
    const text = literal(arg);
    if (typeof text === 'string') return fields.filter(f => hasLabel(f.body, text) || hasIdentifier(f.body, text));
    if (arg?.type !== 'ObjectExpression') return [];
    const pairs = [];
    for (const prop of arg.properties) {
      const key = prop.key?.type === 'Identifier' ? prop.key.name : literal(prop.key), value = literal(prop.value);
      if (prop.type !== 'Property' || prop.computed || prop.method || prop.kind !== 'init' ||
          !['id', 'label'].includes(key) || typeof value !== 'string') return [];
      pairs.push([key, value]);
    }
    return pairs.length ? fields.filter(f => pairs.every(([k, v]) => k === 'id' ? hasIdentifier(f.body, v) : hasLabel(f.body, v))) : [];
  };
  for (const call of calls) {
    const handle = handleOf(call), { method, args } = call;
    const index = inputs.has(method) && handles.has(handle) ? actionIndex++ : undefined;
    if (method === 'click') { const matches = resolve(args[0]); aims.set(handle, matches.length === 1 ? matches[0] : undefined); }
    else if (method === 'setValue' || method === 'typeText') {
      const matches = method === 'setValue' ? resolve(args[0]) : [aims.get(handle)].filter(Boolean);
      const value = literal(args[method === 'setValue' ? 1 : 0]);
      if (matches.length === 1 && typeof value === 'string' && value.length) writes.push({ method, index, target: matches[0], value });
    } else if (!(method === 'pressKey' && /^(?:super|cmd|command|ctrl|control)\+a$/i.test(literal(args[0]) ?? '')) &&
        !['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method)) aims.delete(handle);
  }
  return writes;
}

const context = f => f.role + ' ' + f.label + ' ' + (field(f.body, 'ID') ?? '') + ' ' + f.path;
const sensitive = f => /secure text field|password|passcode|passphrase|\bpin\b|credential|secret|token|api.?key|verification|one.time|\botp\b|passwort|kennwort|mot de passe|contrase[ñn]a|senha|wachtwoord|l[öo]senord|salasana|пароль|密码|パスワード|비밀번호/i.test(context(f)) || /\((?:[^)]*, )?(?:secure|protected)(?:,|\))/.test(f.body);
const payment = f => !sensitive(f) && /payment|billing|card|carte|tarjeta|karte|cart[aã]o|カード|\bcvc\b|\bcvv\b|expiry|expir|\bmm\/yy\b|security code|iban|routing|bank account/i.test(context(f));
const describe = f => `${f.number} (${[f.label, f.role].filter(Boolean).join(' ').slice(0, 100)})`;

export function wrongFieldEffects(code, before, after, { flagged = new Set(), failed = false } = {}) {
  // Do not parse either tree for cells without a resolvable field write.
  if (!/\.\s*(?:setValue|typeText)\s*\(/.test(code ?? '')) return [];
  const writes = fieldWrites(code, before);
  if (!writes.length) return [];
  if (!before || !after || documentKey(windowFromText(before)) !== documentKey(windowFromText(after)) ||
      !windowFromText(before) || /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(before + after)) return [];
  const old = writeFields(before), now = writeFields(after), effects = [];
  const unique = (list, path) => { const matches = list.filter(f => f.path === path); return matches.length === 1 ? matches[0] : undefined; };
  for (const [index, write] of writes.entries()) {
    const target = unique(now, write.target.path), was = unique(old, write.target.path);
    if (!target || !was || target.exposed !== was.exposed || target.value !== was.value || target.value === write.value ||
        writes.slice(index + 1).some(w => w.target.path === target.path)) continue;
    const landed = now.filter(f => f.path !== target.path && f.value === write.value &&
      unique(old, f.path) && unique(now, f.path) && !writes.some(w => w.target.path === f.path && w.value === write.value));
    if (landed.length !== 1) continue;
    const actual = landed[0], changed = unique(old, actual.path).value !== actual.value;
    // Keep only a bounded digest of an earlier flag, never another copy of the input text.
    const key = createHash('sha256').update(JSON.stringify([documentKey(windowFromText(before)), was.path, was.value,
      was.exposed, actual.path, write.value])).digest('hex');
    if (!changed && !flagged.has(key)) continue;
    if (changed) {
      flagged.add(key);
      if (flagged.size > 64) flagged.delete(flagged.values().next().value);
    }
    const isError = was.exposed && changed;
    const risk = payment(actual) ? /* notice */ 'Payment field received the text. ' : sensitive(actual) ? /* notice */ 'Credential field received the text. ' : '';
    const status = isError
      ? /* notice */ `clear it before continuing. Requested write not done: ${describe(target)} kept its value.`
      : /* notice */ `check ${actual.number} and ${target.number} before continuing.`;
    const ran = failed ? '' : /* notice */ 'Other actions in this call ran; ';
    effects.push({ method: write.method, index: write.index, requested: write.target.number, received: actual.number, isError,
      notice: /* notice */ `sleight: ${risk}The text is now in ${describe(actual)}; ${status} ${ran}sleight made no repair.` });
  }
  return effects.sort((a, b) => Number(/^(?:sleight: )(?:Payment|Credential)/.test(b.notice)) - Number(/^(?:sleight: )(?:Payment|Credential)/.test(a.notice)));
}
