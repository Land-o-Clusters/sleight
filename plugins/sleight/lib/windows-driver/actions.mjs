// Wire validation also lives independently in DriverActionPlan.cs. Worker IPC is untrusted.
export const ACTION_METHODS = Object.freeze(['click', 'doubleClick', 'rightClick', 'setValue', 'typeText',
  'pressKey', 'paste', 'scroll', 'selectText', 'performSecondaryAction', 'drag']);
const invalid = () => { throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => {
  if (!object(value) || required.some(k => !Object.hasOwn(value, k)) ||
      Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) invalid();
};
const integer = (n, min, max) => { if (!Number.isSafeInteger(n) || n < min || n > max) invalid(); return n; };
const text = (s, max, empty = false) => {
  if (typeof s !== 'string' || (!empty && !s.trim()) || s.length > max || s.includes('\0') || !s.isWellFormed()) invalid();
  return s;
};
const target = t => {
  if (typeof t === 'number') return integer(t, 0, 2999);
  if (Array.isArray(t)) {
    if (t.length !== 2 || t.some(v => !Number.isFinite(v) || v < 0 || v > 1e6)) invalid();
    return t;
  }
  if (!object(t) || Object.keys(t).length !== 1 || !['id', 'label', 'line'].includes(Object.keys(t)[0])) invalid();
  text(Object.values(t)[0], 16384); return t;
};
export const NAMED_KEYS = Object.freeze({ return: 13, enter: 13, escape: 27, esc: 27, tab: 9, space: 32,
  backspace: 8, delete: 46, insert: 45, printscreen: 44, home: 36, end: 35, pageup: 33, pagedown: 34,
  left: 37, up: 38, right: 39, down: 40 });
export function parseChord(value) {
  const aliases = { ctrl: 17, control: 17, shift: 16, alt: 18, option: 18, win: 91, super: 91, meta: 91 };
  const modifiers = []; let key;
  for (const part of text(value, 128).toLowerCase().split('+').map(p => p.trim())) {
    if (Object.hasOwn(aliases, part)) {
      if (key !== undefined || modifiers.includes(aliases[part])) invalid();
      modifiers.push(aliases[part]);
    } else {
      if (key !== undefined || !part) invalid();
      key = part;
    }
  }
  if (key === undefined && modifiers.length !== 1) invalid();
  let virtualKey = key !== undefined && Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key] : undefined;
  if (key !== undefined && virtualKey === undefined) {
    if (/^f(?:[1-9]|1\d|2[0-4])$/.test(key)) virtualKey = 111 + Number(key.slice(1));
    else if (key.length === 1 && !/[\p{Cc}\p{Cs}]/u.test(key)) virtualKey = 0; // Target-layout lookup, not a US-keyboard guess.
    else invalid();
  }
  modifiers.sort((a, b) => a - b);
  return { key, virtualKey, modifiers, canonical: [...modifiers, ...key === undefined ? [] :
    [key === 'enter' ? 'return' : key === 'esc' ? 'escape' : key]].join('+') };
}
// UIA accelerator labels name physical Latin keys, not typed characters.
export function parseAccelerator(value) {
  return parseChord(value.trimEnd().replace(/(^|\+)\s*\+$/, '$1=').split('+').map(part => {
    const key = part.trim().toLowerCase();
    return ({ ins: 'insert', del: 'delete', prtsc: 'printscreen', prtscn: 'printscreen',
      'prt scr': 'printscreen', 'print screen': 'printscreen' })[key] ?? key;
  }).join('+'));
}
export function validateActionParams(method, p) {
  if (!ACTION_METHODS.includes(method)) invalid();
  keys(p, ['windowId', 'processStart', 'readId', 'args'], ['clipboardBlocked']);
  if (Object.hasOwn(p, 'clipboardBlocked') && (!Array.isArray(p.clipboardBlocked) || p.clipboardBlocked.length > 3000 ||
      p.clipboardBlocked.some(n => !Number.isInteger(n) || n < 0 || n >= 3000))) invalid();
  for (const [name, max] of [['windowId', 18446744073709551615n], ['processStart', 9223372036854775807n]]) {
    if (typeof p[name] !== 'string' || !/^[1-9]\d{0,19}$/.test(p[name]) || BigInt(p[name]) > max) invalid();
  }
  integer(p.readId, 1, Number.MAX_SAFE_INTEGER);
  const a = p.args;
  const count = ['setValue', 'performSecondaryAction', 'selectText', 'scroll', 'drag'].includes(method) ? 2 : 1;
  if (!Array.isArray(a) || a.length < count || a.length > count + Number(['paste', 'drag'].includes(method))) invalid();
  if (['typeText', 'paste', 'pressKey'].includes(method)) text(a[0], method === 'pressKey' ? 128 : 4000, method !== 'pressKey');
  else target(a[0]);
  if (method === 'typeText' && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(a[0])) invalid();
  if (method === 'pressKey') parseChord(a[0]);
  if (['setValue', 'selectText'].includes(method)) text(a[1], 65536, method === 'setValue');
  if (method === 'performSecondaryAction' && !['Invoke', 'Toggle', 'Select', 'Expand', 'Collapse', 'ScrollIntoView', 'DoDefaultAction'].includes(a[1])) invalid();
  if (method === 'scroll') {
    keys(a[1], ['direction'], ['amount']);
    if (!['up', 'down', 'left', 'right'].includes(a[1].direction)) invalid();
    if (Object.hasOwn(a[1], 'amount')) integer(a[1].amount, 1, 100);
  }
  if (method === 'drag') {
    target(a[1]);
    if (a.length === 3) {
      keys(a[2], [], ['durationMs', 'steps']);
      if (Object.hasOwn(a[2], 'durationMs')) integer(a[2].durationMs, 500, 2000);
      if (Object.hasOwn(a[2], 'steps')) integer(a[2].steps, 2, 64);
    }
  }
  if (method === 'paste' && a.length === 2) {
    keys(a[1], [], ['format']);
    if (Object.hasOwn(a[1], 'format') && a[1].format !== 'text') invalid();
  }
  return p;
}
