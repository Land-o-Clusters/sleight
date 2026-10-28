import { tokens, invalidTokens, codeInspectionRefusal } from './flow-rules.mjs';

// Also injected into the app proxy. Keep this function self-contained.
export function nativeArgumentError(name, args, unknown = Symbol()) {
  const known = value => value !== unknown;
  const string = value => !known(value) || typeof value === 'string';
  const number = value => !known(value) || typeof value === 'number' && Number.isFinite(value);
  const object = value => !known(value) || value !== null && typeof value === 'object' && !Array.isArray(value);
  const point = value => !known(value) || Array.isArray(value) && value.length === 2 && number(value[0]) && number(value[1]);
  // Sleight resolves these selectors to engine element numbers after validation.
  const element = value => !known(value) || Number.isInteger(value) && value >= 0 || typeof value === 'string' ||
    object(value) && value && ['id', 'label', 'line'].some(key => key in value && string(value[key]));
  const target = value => element(value) || point(value);
  const options = (value, fields) => value == null || object(value) && (!known(value) ||
    Object.entries(fields).every(([key, valid]) => value[key] === undefined || valid(value[key])));
  const [a, b, c] = args;
  let valid = true, signature;
  switch (name) {
    case 'pressKey':
      signature = 'pressKey(key: string, options?: PressKeyOptions)';
      valid = args.length >= 1 && string(a) && (!known(a) || a.length > 0) &&
        options(b, { durationMs: number });
      break;
    case 'typeText':
      signature = 'typeText(text: string)';
      valid = args.length >= 1 && string(a);
      break;
    case 'click':
      if (known(b) && b != null && typeof b === 'object' && 'button' in b) {
        const button = ['left', 'right', 'middle', 'l', 'r', 'm'].find(value => value === b.button);
        return /* notice */ 'sleight: use ' + (button ? '{mouseButton:"' + button + '"}' : 'mouseButton') + ', not button; nothing sent';
      }
      signature = 'click(target: number | Vec2, options?: ClickOptions)';
      valid = args.length >= 1 && target(a) && options(b, {
        key: string, durationMs: number, clickCount: number, mouseButton: string,
      });
      break;
    case 'selectText':
      signature = 'selectText(elementIndex: number, text: string, options?: SelectTextOptions)';
      valid = args.length >= 2 && element(a) && string(b) && options(c, {
        prefix: string, suffix: string, selectionType: string,
      });
      break;
    case 'scroll':
      signature = 'scroll(target: number | Vec2, direction: Direction, distance?: number | { pixels: number })';
      valid = args.length >= 2 && target(a) && string(b) && (c == null || number(c) || object(c));
      break;
    case 'drag':
      signature = 'drag(from: Vec2, to: Vec2)';
      valid = args.length >= 2 && point(a) && point(b);
      break;
  }
  return valid ? undefined : 'sleight: invalid native arguments. Engine App.' + signature + '; nothing was sent';
}

const unknown = Symbol('expression');
const opening = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
function parts(ts) {
  const result = [], stack = [];
  let start = 0;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].string) continue;
    const v = ts[i].v;
    if (opening.has(v)) stack.push(opening.get(v));
    else if ([')', ']', '}'].includes(v)) { if (stack.pop() !== v) return; }
    else if (v === ',' && !stack.length) { result.push(ts.slice(start, i)); start = i + 1; }
  }
  if (stack.length) return;
  if (start < ts.length) result.push(ts.slice(start));
  return result;
}

// Read only literals, including partially known arrays/options. Expressions stay unknown.
function literal(ts) {
  if (!ts.length) return undefined;
  if (ts.length === 1) {
    if (ts[0].string) return ts[0].v;
    if (ts[0].v === 'null') return null;
    if (ts[0].v === 'undefined') return undefined;
    if (ts[0].v === 'true' || ts[0].v === 'false') return ts[0].v === 'true';
  }
  const numeric = ts.map(t => t.v).join('');
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)) return Number(numeric);
  const first = ts[0]?.v;
  if (ts[0]?.string || !['[', '{'].includes(first) || ts.at(-1)?.v !== opening.get(first)) return unknown;
  const entries = parts(ts.slice(1, -1));
  if (!entries || entries.some(entry => entry.slice(0, 3).map(t => t.v).join('') === '...')) return unknown;
  if (first === '[') return entries.map(literal);
  const value = Object.create(null);
  for (const entry of entries) {
    if (entry[1]?.v !== ':' || !entry[0]?.v) return unknown;
    value[entry[0].v] = literal(entry.slice(2));
  }
  return value;
}

// This is a literal mistake check, not an interpreter. The runtime proxy checks computed values.
export function nativeArgumentsProblem(code, nativeHandles = new Set(), browserHandles = new Set()) {
  const ts = tokens(code), native = new Set(['app', ...nativeHandles]);
  if (invalidTokens(ts)) return codeInspectionRefusal;
  for (const handle of browserHandles) native.delete(handle);
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].string) continue;
    if (ts[i + 1]?.v === '=' && ts[i + 2]?.v !== '=' && /^[A-Za-z_$][\w$]*$/.test(ts[i].v)) {
      const at = i + (ts[i + 2]?.v === 'await' ? 3 : 2);
      const app = ts[at]?.v === 'cua' && ts[at + 1]?.v === '.' && ts[at + 2]?.v === 'getApp';
      if (app || native.has(ts[at]?.v)) native.add(ts[i].v);
      else native.delete(ts[i].v);
    }
    if (!native.has(ts[i].v) || ts[i - 1]?.v === '.' || ts[i + 1]?.v !== '.' || ts[i + 3]?.v !== '(') continue;
    const name = ts[i + 2].v;
    if (!['pressKey', 'click', 'selectText', 'typeText', 'scroll', 'drag'].includes(name)) continue;
    let end = i + 4, depth = 1;
    for (; end < ts.length; end++) {
      if (ts[end].string) continue;
      if (ts[end].v === '(') depth++;
      if (ts[end].v === ')' && --depth === 0) break;
    }
    if (depth) continue;
    const entries = parts(ts.slice(i + 4, end));
    if (!entries || entries.some(entry => entry.slice(0, 3).map(t => t.v).join('') === '...')) continue;
    const problem = nativeArgumentError(name, entries.map(literal), unknown);
    if (problem) return problem + '.';
  }
}
