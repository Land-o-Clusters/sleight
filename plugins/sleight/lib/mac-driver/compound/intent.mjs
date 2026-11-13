// Internal prototype only. Nothing in this directory registers a model tool or
// native method. Authority and mechanism contracts are never intent fields.
import { TextDecoder } from 'node:util';
import { compoundLabelBoundary } from './boundary.mjs';

export const COMPOUND_LIMITS = Object.freeze({ labels: 512, segments: 16, steps: 32, milliseconds: 30000,
  intentBytes: 32768, receiptBytes: 65536, nodes: 10000 });
export const compoundFault = code => Object.assign(Error(code), { code });
export function requireCompound(ok, code) { if (!ok) throw compoundFault(code); }
export function freezeCompound(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeCompound(item); Object.freeze(value); }
  return value;
}

// Scan before JSON.parse, including escaped spellings of keys. This parser is
// bounded independently of the driver's much larger tree envelope.
export function compoundJSON(input) {
  let source;
  try { source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { throw compoundFault('INVALID_INTENT'); }
  requireCompound(source.length <= COMPOUND_LIMITS.intentBytes && Buffer.byteLength(source) <= COMPOUND_LIMITS.intentBytes,
    'INVALID_INTENT');
  let i = 0;
  const space = () => { while (/[\t\r\n ]/.test(source[i] ?? '\0')) i++; };
  const string = () => {
    const start = i++;
    while (i < source.length) {
      if (source[i++] === '"') return JSON.parse(source.slice(start, i));
      if (source[i - 1] === '\\') i++;
    }
    throw compoundFault('INVALID_INTENT');
  };
  const value = depth => {
    requireCompound(depth <= 8, 'INVALID_INTENT'); space();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{') {
      i++; space(); const keys = new Set(); if (source[i] === '}') { i++; return; }
      while (i < source.length) {
        space(); requireCompound(source[i] === '"', 'INVALID_INTENT'); const key = string();
        requireCompound(!keys.has(key), 'DUPLICATE_INTENT_KEY'); keys.add(key); space();
        requireCompound(source[i++] === ':', 'INVALID_INTENT'); value(depth + 1); space();
        const end = source[i++]; if (end === '}') return;
        requireCompound(end === ',', 'INVALID_INTENT');
      }
    } else if (source[i] === '[') {
      i++; space(); if (source[i] === ']') { i++; return; }
      while (i < source.length) {
        value(depth + 1); space(); const end = source[i++]; if (end === ']') return;
        requireCompound(end === ',', 'INVALID_INTENT');
      }
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
      if (token) { i += token[0].length; return; }
    }
    throw compoundFault('INVALID_INTENT');
  };
  try { value(0); space(); requireCompound(i === source.length, 'INVALID_INTENT'); return JSON.parse(source); }
  catch (error) { throw error.code ? error : compoundFault('INVALID_INTENT'); }
}

function record(value, required, optional = []) {
  requireCompound(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_INTENT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCompound(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' &&
    [...required, ...optional].includes(key) && Object.hasOwn(descriptors[key], 'value')) &&
    required.every(key => Object.hasOwn(descriptors, key)), 'INVALID_INTENT');
}
export function rawCompoundText(value, max = COMPOUND_LIMITS.labels) {
  requireCompound(typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed() &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), 'INVALID_INTENT');
  return value;
}

// Array labels are literal. Shorthand uses > as delimiter, \\> and \\\\ as
// escapes, and exactly one optional ASCII space on each delimiter side.
export function compoundSegments(path) {
  if (Array.isArray(path)) return path;
  rawCompoundText(path, COMPOUND_LIMITS.labels * COMPOUND_LIMITS.segments);
  const result = []; let part = '';
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '\\') {
      requireCompound(['>', '\\'].includes(path[i + 1]), 'INVALID_INTENT'); part += path[++i];
    } else if (path[i] === '>') {
      result.push(part.endsWith(' ') ? part.slice(0, -1) : part); part = '';
      if (path[i + 1] === ' ') i++;
    } else part += path[i];
  }
  result.push(part); return result;
}
function selector(value, role) {
  if (typeof value === 'string') return { role, source: 'title', label: rawCompoundText(value) };
  record(value, ['role', 'source', 'label']);
  requireCompound(value.role === role && ['title', 'description'].includes(value.source), 'INVALID_INTENT');
  return { role, source: value.source, label: rawCompoundText(value.label) };
}
export function parseCompoundIntent(input) {
  const value = typeof input === 'string' || input instanceof Uint8Array ? compoundJSON(input) : input;
  // Validate descriptors before reading operation, so accessors cannot execute.
  record(value, ['operation'], ['segments', 'control', 'option', 'destination']);
  let result;
  if (value.operation === 'menu') {
    record(value, ['operation', 'segments']);
    const segments = compoundSegments(value.segments);
    requireCompound(segments.length > 0 && segments.length <= COMPOUND_LIMITS.segments, 'INVALID_INTENT');
    result = { operation: 'menu', segments: segments.map((s, i) => selector(s, i ? 'AXMenuItem' : 'AXMenuBarItem')) };
  } else if (value.operation === 'choose') {
    record(value, ['operation', 'control', 'option']); record(value.control, ['readId', 'element']);
    requireCompound(Number.isSafeInteger(value.control.readId) && value.control.readId > 0 &&
      Number.isSafeInteger(value.control.element) && value.control.element >= 0, 'INVALID_INTENT');
    result = { operation: 'choose', control: { ...value.control }, option: selector(value.option, 'AXMenuItem') };
  } else if (value.operation === 'prepareSaveAs') {
    record(value, ['operation', 'destination']); const path = rawCompoundText(value.destination, 4096);
    const components = path.split('/');
    requireCompound(path.startsWith('/') && !path.startsWith('//') && components.slice(1).every(p => p && p !== '.' && p !== '..') &&
      !/[~$:*?\[\]{}\\]/u.test(path), 'INVALID_DESTINATION');
    const basename = components.pop(), directory = components.join('/') || '/';
    result = { operation: 'prepareSaveAs', destination: path, directory, basename };
  } else throw compoundFault('INVALID_INTENT');
  return freezeCompound(result);
}

// Preflight can refuse known boundaries; only a reviewed contract admits input.
export function knownCompoundBoundary(label) { return compoundLabelBoundary(label) !== 'clear'; }
