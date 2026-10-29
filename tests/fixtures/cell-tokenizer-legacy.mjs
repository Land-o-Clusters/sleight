// Frozen from c9fb85bb for legacy comparisons. Product code must not import this fixture.
const isLineTerminator = char => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
function lineCommentEnd(code, start) {
  let end = start;
  while (end < code.length && !isLineTerminator(code[end])) end++;
  return end;
}

// A small tokenizer, deliberately narrower than a JavaScript interpreter.
export const invalidTokens = ts => ts.some(t => !t.string && t.v === '<invalid>');
function regexpEnd(code, start) {
  let i = start + 1, bracket = false;
  while (i < code.length) {
    const ch = code[i++];
    if (isLineTerminator(ch)) return -1;
    if (ch === '\\') { if (isLineTerminator(code[i])) return -1; i++; }
    else if (ch === '[') bracket = true;
    else if (ch === ']') bracket = false;
    else if (ch === '/' && !bracket) {
      while (i < code.length && /[a-z]/i.test(code[i])) i++;
      return i;
    }
  }
  return -1;
}
export function tokens(code) {
  const out = [], parens = [];
  const invalid = () => [...out, { v: '<invalid>' }];
  let i = 0, afterControl = false;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (code.startsWith('//', i)) { i = lineCommentEnd(code, i); continue; }
    if (code.startsWith('/*', i)) { const end = code.indexOf('*/', i + 2); if (end < 0) return invalid(); i = end + 2; continue; }
    const previous = out.at(-1), control = afterControl;
    afterControl = false;
    if (c === '/') {
      // A closing brace may end a block or an expression. If a complete regex
      // is possible, the two lexical readings differ; neither is safe to guess.
      const ambiguous = previous?.v === '}' && !previous.string;
      const regex = control || !previous || !previous.string && !['.', '#'].includes(out.at(-2)?.v) &&
        ['=', '(', ',', ':', 'return', '[', '!', ';', '{', '&', '|', '?', '>', 'throw', 'case', 'yield', 'await', 'else', 'do',
          'typeof', 'void', 'in', 'new', 'delete', 'instanceof', 'extends', 'default'].includes(previous.v);
      if (ambiguous || regex) {
        const end = regexpEnd(code, i);
        if (ambiguous ? end >= 0 : end < 0) return invalid();
        if (regex) { i = end; out.push({ v: '<regexp>' }); continue; }
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; let value = ''; let dynamic = false; i++;
      while (i < code.length && code[i] !== quote) {
        const ch = code[i++];
        if (quote === '`' && ch === '$' && code[i] === '{') dynamic = true;
        if (ch !== '\\') {
          if (quote !== '`' && (ch === '\n' || ch === '\r')) return invalid();
          if (quote === '`' && ch === '\r') { if (code[i] === '\n') i++; value += '\n'; }
          else value += ch;
          continue;
        }
        const esc = code[i++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (isLineTerminator(esc) && esc !== '\r') continue;
        if (esc === '\r') { if (code[i] === '\n') i++; continue; }
        if (esc === 'x' || esc === 'u') {
          const brace = esc === 'u' && code[i] === '{'; if (brace) i++;
          const raw = brace ? code.slice(i, code.indexOf('}', i)) : code.slice(i, i + (esc === 'x' ? 2 : 4));
          if (/^[\da-f]+$/i.test(raw) && Number.parseInt(raw, 16) <= 0x10ffff) value += String.fromCodePoint(Number.parseInt(raw, 16));
          i += raw.length + (brace ? 1 : 0);
        } else value += simple[esc] ?? esc ?? '';
      }
      if (code[i] !== quote) return invalid();
      i++; out.push(dynamic ? { v: '<template>' } : { v: value, string: true }); continue;
    }
    // Escaped identifiers need a full parser; never reinterpret their suffix as a keyword.
    if (c === '\\') return invalid();
    const word = /^[\p{ID_Continue}$\u200c\u200d]+/u.exec(code.slice(i));
    if (word) { out.push({ v: word[0] }); i += word[0].length; }
    else {
      if (c === '(') parens.push(!previous?.string && !['.', '#'].includes(out.at(-2)?.v) && ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(previous?.v));
      if (c === ')') afterControl = parens.pop() === true;
      out.push({ v: c }); i++;
    }
  }
  return out;
}
