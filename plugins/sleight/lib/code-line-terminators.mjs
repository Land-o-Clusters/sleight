export const isLineTerminator = char => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
export function lineCommentEnd(code, start) {
  let end = start;
  while (end < code.length && !isLineTerminator(code[end])) end++;
  return end;
}

// Plan admission uses LF source lines. Other terminators are data only, including
// template text and escaped string continuations. Never normalize executable code.
export function unsupportedCodeLines(code) {
  if (!/[\r\u2028\u2029]/.test(code)) return false;
  let i = 0, nesting = 0;
  const uncommon = text => /[\r\u2028\u2029]/.test(text);
  function quoted(quote) {
    if (++nesting > 64) return true;
    i++;
    while (i < code.length) {
      const c = code[i++];
      if (c === quote) { nesting--; return false; }
      if (c === '\\') { if (code[i++] === '\r' && code[i] === '\n') i++; continue; }
      if (quote !== '`' && (c === '\n' || c === '\r')) return true;
      if (quote === '`' && c === '$' && code[i] === '{') {
        i++;
        if (scan(true)) return true;
      }
    }
    return true;
  }
  function scan(interpolation = false) {
    let braces = 0;
    while (i < code.length) {
      const c = code[i];
      if (uncommon(c)) return true;
      if (c === '"' || c === "'" || c === '`') { if (quoted(c)) return true; continue; }
      if (code.startsWith('//', i)) {
        i = lineCommentEnd(code, i);
        continue;
      }
      if (code.startsWith('/*', i)) {
        const end = code.indexOf('*/', i + 2);
        if (end < 0 || uncommon(code.slice(i, end))) return true;
        i = end + 2; continue;
      }
      // Slash grammar depends on parser context. Refuse the uncommon-line case
      // rather than mistake a regex quote for a string delimiter. LF-only code
      // never enters this scanner. Legacy HTML comments are ambiguous too.
      if (c === '/' || code.startsWith('<!--', i) || code.startsWith('-->', i)) return true;
      if (c === '{') braces++;
      if (c === '}') { if (!braces && interpolation) { i++; return false; } braces--; }
      i++;
    }
    return interpolation;
  }
  return scan();
}
