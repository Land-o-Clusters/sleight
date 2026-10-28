import { lineCommentEnd, isLineTerminator } from './code-line-terminators.mjs';
// Like the A3R5 check, ignore literal text. Keep offsets, regex character classes and
// template expressions so a quoted action cannot hide a later write or become one.
function tokens(code) {
  const out = []; let i = 0;
  const push = (v, at, string = false) => out.push({ v, at, end: i, string });
  function scan(interpolation = false) {
    let braces = 0;
    while (i < code.length) {
      const at = i, c = code[i];
      if (/\s/.test(c)) { i++; continue; }
      if (code.startsWith('//', i)) { i = lineCommentEnd(code, i); continue; }
      if (code.startsWith('/*', i)) { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
      if (c === '}' && interpolation && braces === 0) { i++; return; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      if (c === '`') {
        i++; push('(', at);
        while (i < code.length && code[i] !== '`') {
          if (code[i] === '\\') { i += 2; continue; }
          if (code.startsWith('${', i)) { i += 2; push('(', i); scan(true); push(')', i); }
          else i++;
        }
        i++; push(')', i - 1); continue;
      }
      if (c === '"' || c === "'") {
        i++; let value = '';
        while (i < code.length && code[i] !== c) {
          if (code[i] === '\\') {
            const escaped = code[++i]; i++;
            if (escaped === '\r' && code[i] === '\n') i++;
            if (!isLineTerminator(escaped)) value += escaped ?? '';
          }
          else value += code[i++];
        }
        i++; push(value, at, true); continue;
      }
      const propertyReturn = out.at(-1)?.v === 'return' && ['.', '?.'].includes(out.at(-2)?.v);
      if (c === '/' && !propertyReturn && (!out.length || (!out.at(-1).string && ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', '=>', '&&', '||', '??'].includes(out.at(-1).v)))) {
        i++; let bracket = false;
        while (i < code.length) {
          const ch = code[i++];
          if (isLineTerminator(ch)) break;
          if (ch === '\\') i++;
          else if (ch === '[') bracket = true;
          else if (ch === ']') bracket = false;
          else if (ch === '/' && !bracket) break;
        }
        while (i < code.length && /[a-z]/i.test(code[i])) i++;
        push('<regexp>', at); continue;
      }
      const word = /^[\w$]+/.exec(code.slice(i));
      if (word) { push(word[0], at); i += word[0].length; continue; }
      const operator = /^(?:=>|\?\.|===|!==|==|!=|\+\+|--|\+=|-=|\|\|=|&&=|\?\?=|&&|\|\||\?\?)/.exec(code.slice(i));
      if (operator) { push(operator[0], at); i += operator[0].length; }
      else { push(c, at); i++; }
    }
  }
  scan(); return out;
}


function closing(ts, start) {
  const close = { '(': ')', '[': ']', '{': '}' }[ts[start]?.v];
  if (!close) return -1;
  const stack = [close];
  for (let i = start + 1; i < ts.length; i++) {
    if (ts[i].string) continue;
    const v = ts[i].v;
    if (['(', '[', '{'].includes(v)) stack.push({ '(': ')', '[': ']', '{': '}' }[v]);
    else if ([')', ']', '}'].includes(v)) {
      if (stack.pop() !== v) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function argumentEnd(ts, start) {
  for (let i = start; i < ts.length; i++) {
    if (ts[i].string) continue;
    if ([',', ')', ';'].includes(ts[i].v)) return i;
    if (['(', '[', '{'].includes(ts[i].v)) {
      i = closing(ts, i);
      if (i < 0) return start;
    }
  }
  return ts.length;
}

function literalFunction(ts, start, end) {
  while (ts[start]?.v === '(' && closing(ts, start) === end - 1) { start++; end--; }
  if (ts[start]?.v === 'async') start++;
  if (ts[start]?.v === 'function') {
    let params = start + 1;
    if (ts[params]?.v !== '(') params++;
    const body = closing(ts, params) + 1;
    return ts[body]?.v === '{' && closing(ts, body) === end - 1;
  }
  const arrow = ts[start]?.v === '(' ? closing(ts, start) + 1 : start + 1;
  return arrow > start && ts[arrow]?.v === '=>' && arrow + 1 < end;
}

// Only callback values are removed. An immediately invoked function runs in the kernel,
// and a named function also used outside evaluate keeps the existing await check.
export function withoutPageCallbacks(code) {
  if (!code.includes('evaluate')) return code;
  const ts = tokens(code), ranges = [];
  for (let i = 0; i < ts.length; i++) {
    if (!['evaluate', 'evaluateAll'].includes(ts[i].v)) continue;
    const computed = ts[i].string && ts[i - 1]?.v === '[' && ts[i + 1]?.v === ']';
    let open = i + (computed ? 2 : 1);
    if (ts[open]?.v === '?.') open++;
    if ((!computed && !['.', '?.'].includes(ts[i - 1]?.v)) || ts[open]?.v !== '(') continue;
    const start = open + 1, end = argumentEnd(ts, start);
    if (literalFunction(ts, start, end)) ranges.push([ts[start].at, ts[end - 1].end]);
    else if (end === start + 1 && !ts[start].string) {
      const name = ts[start].v;
      if (ts.filter(t => !t.string && t.v === name).length !== 2) continue;
      const declaration = ts.findIndex((t, j) => !t.string && t.v === name && j !== start);
      if (ts[declaration - 1]?.v === 'function') {
        const body = closing(ts, declaration + 1) + 1, close = closing(ts, body);
        if (ts[body]?.v === '{' && close >= body) ranges.push([ts[body].at, ts[close].end]);
      } else if (ts[declaration + 1]?.v === '=') {
        const value = declaration + 2, last = argumentEnd(ts, value);
        if (literalFunction(ts, value, last)) ranges.push([ts[value].at, ts[last - 1].end]);
      }
    }
  }
  if (!ranges.length) return code;
  const masked = code.split('');
  for (const [start, end] of ranges) {
    if (end > code.length || end <= start) continue;
    for (let i = start; i < end; i++) if (!isLineTerminator(masked[i])) masked[i] = ' ';
  }
  return masked.join('');
}
