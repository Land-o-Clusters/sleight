// Compare only trees the relay already has. No reads, input, focus changes or repair.
import { tokens, invalidTokens } from './flow-rules.mjs';
import { documentKey, windowFromText, hasIdentifier, hasLabel } from './document-scope.mjs';

const META = 'Value|Description|ID|Help|Placeholder|Secondary Actions|URL|Selected text';
const roleOf = body => /^(?:secure text field|search text field|search field|text field|text entry area|text area|combo box|email field|telephone number field)\b/.exec(body)?.[0];
const field = (body, name) => {
  const role = roleOf(body), rest = role ? body.slice(role.length).replace(/^\s*(?:\([^)]*\)\s*)?/, '') : body;
  return new RegExp('(?:^|, )' + name + ': ?([\\s\\S]*?)(?=, (?:' + META + '):|$)').exec(rest)?.[1];
};
const identity = body => body.replace(new RegExp(',? (?:Value|Selected text): [\\s\\S]*?(?=, (?:' + META + '):|$)', 'g'), '')
  .replace(/\([^)]*\)/g, '').trim();
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
    if (role) fields.push({ number: Number(m[2]), body, path, role, value: field(body, 'Value') ?? '',
      label: field(body, 'Description') ?? body.slice(role.length).replace(/^\s*\([^)]*\)\s*/, '').split(new RegExp(', (?=(?:' + META + '):)'))[0].trim() });
  }
  return fields;
}

// Literal calls only. Unknown expressions, loops and indirect calls cannot establish a write's effect.
export function fieldWrites(code, before) {
  const ts = tokens(code ?? '');
  if (invalidTokens(ts) || ts.some((t, i) => !t.string && (['for', 'while', 'do', 'function', 'if', 'switch', 'class', '<template>'].includes(t.v) ||
      t.v === '=' && ts[i + 1]?.v === '>'))) return [];
  const fields = writeFields(before), writes = [], aims = new Map();
  let actionIndex = 0;
  const inputs = new Set(['click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'paste', 'pressKey', 'scroll', 'drag',
    'selectText', 'performSecondaryAction', 'performAction']);
  const literal = arg => arg?.length === 1 && arg[0].string ? arg[0].v : undefined;
  const resolve = arg => {
    if (arg?.length === 1 && !arg[0].string && /^\d+$/.test(arg[0].v)) return fields.filter(f => f.number === Number(arg[0].v));
    if (arg?.length === 1 && arg[0].string) return fields.filter(f => hasLabel(f.body, arg[0].v) || hasIdentifier(f.body, arg[0].v));
    if (arg?.[0]?.v !== '{' || arg.at(-1)?.v !== '}') return [];
    const pairs = [];
    for (let j = 1; j < arg.length - 1; j += 4) {
      if (!['id', 'label'].includes(arg[j]?.v) || arg[j + 1]?.v !== ':' || !arg[j + 2]?.string ||
          ![',', '}'].includes(arg[j + 3]?.v)) return [];
      pairs.push([arg[j].v, arg[j + 2].v]);
    }
    return pairs.length ? fields.filter(f => pairs.every(([k, v]) => k === 'id' ? hasIdentifier(f.body, v) : hasLabel(f.body, v))) : [];
  };
  for (let i = 0; i < ts.length - 3; i++) {
    if (ts[i].v !== '.' || ts[i + 2]?.v !== '(' || ts[i + 1].string) continue;
    const handle = ts[i - 1]?.v, method = ts[i + 1].v, args = [[]];
    let depth = 0, j = i + 3;
    for (; j < ts.length; j++) {
      const t = ts[j];
      if (!t.string && t.v === ')' && depth === 0) break;
      if (!t.string && t.v === ',' && depth === 0) { args.push([]); continue; }
      if (!t.string && ['(', '[', '{'].includes(t.v)) depth++;
      if (!t.string && [')', ']', '}'].includes(t.v)) depth--;
      args.at(-1).push(t);
    }
    if (j === ts.length) return [];
    const index = inputs.has(method) ? actionIndex++ : undefined;
    if (method === 'click') { const matches = resolve(args[0]); aims.set(handle, matches.length === 1 ? matches[0] : undefined); }
    else if (method === 'setValue' || method === 'typeText') {
      const matches = method === 'setValue' ? resolve(args[0]) : [aims.get(handle)].filter(Boolean);
      const value = literal(args[method === 'setValue' ? 1 : 0]);
      if (matches.length === 1 && typeof value === 'string' && value.length) writes.push({ method, index, target: matches[0], value });
    } else if (!(method === 'pressKey' && /^(?:super|cmd|command|ctrl|control)\+a$/i.test(literal(args[0]) ?? '')) &&
        !['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method)) aims.delete(handle);
    i = j;
  }
  return writes;
}

const context = f => f.role + ' ' + f.label + ' ' + (field(f.body, 'ID') ?? '') + ' ' + f.path;
const sensitive = f => /secure text field|password|passcode|passphrase|\bpin\b|credential|secret|token|api.?key|verification|one.time|\botp\b|passwort|kennwort|mot de passe|contrase[ñn]a|senha|wachtwoord|l[öo]senord|salasana|пароль|密码|パスワード|비밀번호/i.test(context(f)) || /\((?:[^)]*, )?(?:secure|protected)(?:,|\))/.test(f.body);
const payment = f => !sensitive(f) && /payment|billing|card|carte|tarjeta|karte|cart[aã]o|カード|\bcvc\b|\bcvv\b|expiry|expir|\bmm\/yy\b|security code|iban|routing|bank account/i.test(context(f));
const describe = f => `${f.number} (${[f.label, f.role].filter(Boolean).join(' ').slice(0, 100)})`;

export function wrongFieldEffects(code, before, after) {
  if (!before || !after || documentKey(windowFromText(before)) !== documentKey(windowFromText(after)) ||
      !windowFromText(before) || /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(before + after)) return [];
  const old = writeFields(before), now = writeFields(after), writes = fieldWrites(code, before), effects = [];
  const unique = (list, path) => { const matches = list.filter(f => f.path === path); return matches.length === 1 ? matches[0] : undefined; };
  for (const [index, write] of writes.entries()) {
    const target = unique(now, write.target.path), was = unique(old, write.target.path);
    if (!target || !was || target.value !== was.value || target.value === write.value ||
        writes.slice(index + 1).some(w => w.target.path === target.path)) continue;
    const landed = now.filter(f => f.path !== target.path && f.value === write.value && unique(old, f.path)?.value !== write.value &&
      unique(old, f.path) && unique(now, f.path) && !writes.some(w => w.target.path === f.path && w.value === write.value));
    if (landed.length !== 1) continue;
    const actual = landed[0];
    const risk = payment(actual) ? /* notice */ 'Payment field received the text. ' : sensitive(actual) ? /* notice */ 'Credential field received the text. ' : '';
    effects.push({ method: write.method, index: write.index, requested: write.target.number, received: actual.number,
      notice: /* notice */ `sleight: ${risk}The text went into ${describe(actual)}, not ${describe(target)}. Action not done; sleight made no repair.` });
  }
  return effects.sort((a, b) => Number(/^(?:sleight: )(?:Payment|Credential)/.test(b.notice)) - Number(/^(?:sleight: )(?:Payment|Credential)/.test(a.notice)));
}
