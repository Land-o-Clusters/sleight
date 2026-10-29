import { tokens, invalidTokens } from './flow-rules.mjs';

export const WRITE_CODE_BYTES = 8192;
export const hasWrite = code => /\.\s*(?:setValue|typeText|pressKey)\s*\(/.test(code ?? '');

// All source literals are masked, including values assigned to variables before a write. This also
// covers unknown focus and a write that lands in a sensitive field other than its requested target.
// Never parse/evaluate code to retrieve a typed value for tracing.
export function writeCodeTrace(code) {
  const ts = tokens(code, { positions: true });
  if (invalidTokens(ts)) return { code: '[unparseable code redacted]', bytes: Buffer.byteLength(code), truncated: true };
  let clean = '', end = 0;
  for (const t of ts) {
    const gap = code.slice(end, t.start);
    clean += /\S/.test(gap) ? '/* redacted comment */' : gap;
    clean += t.string || ['<template>', '<regexp>'].includes(t.v) ? '"<redacted>"' : code.slice(t.start, t.end);
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
