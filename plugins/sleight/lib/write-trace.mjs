import { tokens, invalidTokens } from './flow-rules.mjs';

export const WRITE_CODE_BYTES = 8192;
const INPUTS = new Set(['setValue', 'typeText', 'pressKey', 'paste', 'click', 'doubleClick', 'rightClick', 'drag',
  'scroll', 'selectText', 'performAction', 'performSecondaryAction', 'press']);
// Conservative presence check, including bracket access, aliases, call/apply and optional calls.
export const hasWrite = code => {
  if (/\b(?:setValue|typeText|pressKey|paste|click|doubleClick|rightClick|drag|scroll|selectText|performAction|performSecondaryAction|press)\b/.test(code ?? '')) return true;
  if (!/\\/.test(code ?? '')) return false;
  const ts = tokens(code ?? '');
  return invalidTokens(ts) || ts.some(t => INPUTS.has(t.v));
};

// All source literals are masked, including values assigned to variables before a write. This also
// covers unknown focus and a write that lands in a sensitive field other than its requested target.
// Never parse/evaluate code to retrieve a typed value for tracing.
export function writeCodeTrace(code) {
  const ts = tokens(code, { positions: true });
  if (invalidTokens(ts)) return { code: '[unparseable code redacted]', bytes: Buffer.byteLength(code), truncated: true };
  let clean = '', end = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const gap = code.slice(end, t.start);
    clean += /\S/.test(gap) ? '/* redacted comment */' : gap;
    // Encoders can take variables or expressions; mask the whole argument list without evaluation.
    if (['String', 'Buffer'].includes(t.v) && ts[i + 1]?.v === '.' &&
        ts[i + 2]?.v === (t.v === 'String' ? 'fromCharCode' : 'from') && ts[i + 3]?.v === '(') {
      let depth = 1, j = i + 4;
      for (; j < ts.length && depth; j++) if (!ts[j].string) {
        if (ts[j].v === '(') depth++;
        else if (ts[j].v === ')') depth--;
      }
      if (depth) return { code: '[unparseable code redacted]', bytes: Buffer.byteLength(code), truncated: true };
      clean += code.slice(t.start, ts[i + 3].end) + '"<redacted>")';
      end = ts[j - 1].end; i = j - 1; continue;
    }
    clean += t.string || ['<template>', '<regexp>', 'true', 'false', 'null'].includes(t.v) || /^\d/.test(t.v)
      ? '"<redacted>"' : code.slice(t.start, t.end);
    end = t.end;
  }
  const gap = code.slice(end);
  clean += /\S/.test(gap) ? '/* redacted comment */' : gap;
  const bytes = Buffer.byteLength(clean), truncated = bytes > WRITE_CODE_BYTES;
  // Retain both ends: generated guards can precede the caller's actual actions by many KB.
  if (truncated) {
    const buffer = Buffer.from(clean), marker = '\n/* code truncated */\n';
    const half = Math.floor((WRITE_CODE_BYTES - Buffer.byteLength(marker) - 8) / 2);
    clean = buffer.subarray(0, half).toString('utf8') + marker + buffer.subarray(-half).toString('utf8');
  }
  return { code: clean, bytes: Buffer.byteLength(code), redactedBytes: bytes, truncated };
}
