import { parseCell, walk, memberCall, literalValue } from './code-ast.mjs';

export const WRITE_CODE_BYTES = 8192;
const INPUTS = new Set(['setValue', 'typeText', 'pressKey', 'paste', 'click', 'doubleClick', 'rightClick', 'drag',
  'scroll', 'selectText', 'performAction', 'performSecondaryAction', 'press']);
// Conservative presence check, including bracket access, aliases, call/apply and optional calls.
export const hasWrite = code => {
  const { ast, error } = parseCell(code ?? '');
  if (error) return true;
  for (const node of walk(ast)) {
    if (node.type === 'Identifier' && INPUTS.has(node.name) || ['Literal', 'TemplateLiteral'].includes(node.type) && INPUTS.has(literalValue(node))) return true;
  }
  return false;
};

// All source literals are masked, including values assigned to variables before a write. This also
// covers unknown focus and a write that lands in a sensitive field other than its requested target.
// Inspect syntax ranges only; never evaluate code to retrieve a typed value.
export function writeCodeTrace(code) {
  const { ast, comments, error } = parseCell(code);
  if (error) return { code: '[unparseable code redacted]', bytes: Buffer.byteLength(code), truncated: true };
  const ranges = comments.map(comment => ({ range: comment.range, text: '/* redacted comment */' }));
  for (const node of walk(ast)) {
    if (node.type === 'Literal' || node.type === 'TemplateLiteral') ranges.push({ range: node.range, text: '"<redacted>"' });
    const call = memberCall(node);
    if (call?.receiver.type === 'Identifier' &&
        (call.receiver.name === 'String' && call.method === 'fromCharCode' || call.receiver.name === 'Buffer' && call.method === 'from')) {
      // Encoders can consume identifiers too. Mask the entire argument span.
      if (call.args.length) ranges.push({ range: [call.args[0].range[0], call.args.at(-1).range[1]], text: '"<redacted>"' });
    }
  }
  // Outer ranges win, so template expressions and encoder arguments cannot leak.
  ranges.sort((a, b) => a.range[0] - b.range[0] || b.range[1] - a.range[1]);
  let clean = '', end = 0;
  for (const { range: [start, stop], text } of ranges) {
    if (start < end) continue;
    clean += code.slice(end, start) + text;
    end = stop;
  }
  clean += code.slice(end);
  const bytes = Buffer.byteLength(clean), truncated = bytes > WRITE_CODE_BYTES;
  // Retain both ends: generated guards can precede the caller's actual actions by many KB.
  if (truncated) {
    const buffer = Buffer.from(clean), marker = '\n/* code truncated */\n';
    const half = Math.floor((WRITE_CODE_BYTES - Buffer.byteLength(marker) - 8) / 2);
    clean = buffer.subarray(0, half).toString('utf8') + marker + buffer.subarray(-half).toString('utf8');
  }
  return { code: clean, bytes: Buffer.byteLength(code), redactedBytes: bytes, truncated };
}
