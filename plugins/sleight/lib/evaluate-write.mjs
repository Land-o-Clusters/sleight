import { lineCommentEnd, isLineTerminator } from './code-line-terminators.mjs';
import { EVALUATE_ACTION } from './tab-errors.mjs';

const setters = { value: 'fill', checked: 'check', innerHTML: 'read', textContent: 'read', className: 'read',
  selected: 'select', selectedIndex: 'select', scrollTop: 'scroll', scrollLeft: 'scroll', fetch: 'read',
  draggable: 'read', cssText: 'read' };
const methods = { click: 'click', dispatchEvent: 'read', createEvent: 'read', addEventListener: 'read',
  append: 'read', prepend: 'read', replaceWith: 'read', remove: 'read', insertAdjacentHTML: 'read',
  setAttribute: 'read', appendChild: 'drag', insertBefore: 'drag', removeChild: 'drag', replaceChild: 'drag' };
const ambiguousMethods = new Set(['append', 'prepend', 'replaceWith', 'remove', 'insertAdjacentHTML']);

// Like the A3R5 check, ignore literal text. Keep offsets, regex character classes and
// template expressions so a quoted action cannot hide a later write or become one.
function tokens(code) {
  const out = []; let i = 0;
  const push = (v, at, string = false) => out.push({ v, at, string });
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
      if (c === '/' && (!out.length || (!out.at(-1).string && ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', '=>', '&&', '||', '??'].includes(out.at(-1).v)))) {
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

function argumentEnd(ts, start) {
  let depth = 0;
  for (let i = start; i < ts.length; i++) {
    if (ts[i].string) continue;
    const v = ts[i].v;
    if (!depth && [',', ')', ';'].includes(v)) return i;
    if (['(', '[', '{'].includes(v)) depth++;
    if ([')', ']', '}'].includes(v)) depth--;
    if (depth < 0) return i;
  }
  return ts.length;
}

function callbacks(ts) {
  const ranges = [];
  const range = (start, end) => Object.assign(ts.slice(start, end), { endAt: ts[end]?.at });
  for (let i = 0; i < ts.length; i++) {
    const computed = ts[i - 1]?.v === '[' && ts[i].string && ts[i + 1]?.v === ']';
    let open = computed ? i + 2 : i + 1;
    if (ts[open]?.v === '?.') open++;
    if (ts[i].v !== 'evaluate' || (!computed && !['.', '?.'].includes(ts[i - 1]?.v)) || ts[open]?.v !== '(') continue;
    const start = open + 1, end = argumentEnd(ts, start), arg = range(start, end);
    if (arg.some(t => !t.string && ['=>', 'function'].includes(t.v))) ranges.push(arg);
    else if (arg.length === 1 && !arg[0].string) {
      const name = arg[0].v;
      for (let j = 0; j < ts.length; j++) {
        if (ts[j].v !== name || ts[j].string) continue;
        if (ts[j - 1]?.v === 'function') {
          const parameters = ts.findIndex((t, k) => k > j && !t.string && t.v === '(');
          const body = closingToken(ts, parameters) + 1;
          if (ts[body]?.v === '{') ranges.push(range(j - 1, closingToken(ts, body) + 1));
        } else if (ts[j + 1]?.v === '=') {
          const value = range(j + 2, argumentEnd(ts, j + 2));
          if (value.some(t => t.v === '=>' || t.v === 'function')) ranges.push(value);
        }
      }
    }
  }
  return ranges;
}

function closingToken(ts, start) {
  const open = ts[start]?.v, close = { '(': ')', '[': ']', '{': '}' }[open];
  if (!close) return start;
  let depth = 1;
  for (let i = start + 1; i < ts.length; i++) {
    if (ts[i].string) continue;
    if (ts[i].v === open) depth++;
    if (ts[i].v === close && --depth === 0) return i;
  }
  return ts.length - 1;
}

function receiverRoot(ts, index) {
  let i = index;
  while (i >= 0) {
    if ([')', ']'].includes(ts[i].v) && !ts[i].string) {
      const close = ts[i].v, open = close === ')' ? '(' : '['; let depth = 1;
      while (--i >= 0 && depth) {
        if (ts[i].string) continue;
        if (ts[i].v === close) depth++;
        if (ts[i].v === open) depth--;
      }
      continue;
    }
    if (['.', '?.'].includes(ts[i - 1]?.v)) { i -= 2; continue; }
    return ts[i].v;
  }
}

function splitTop(ts, separator) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].string) continue;
    const v = ts[i].v;
    if (!depth && v === separator) { parts.push(ts.slice(start, i)); start = i + 1; }
    if (['(', '[', '{'].includes(v)) depth++;
    if ([')', ']', '}'].includes(v)) depth--;
  }
  return [...parts, ts.slice(start)];
}

function bindsFetch(ts, depth = 0) {
  if (depth > 32) return false;
  const part = splitTop(ts, '=')[0];
  while (part[0]?.v === '.') part.shift(); // Rest binding.
  if (part.length === 1) return !part[0].string && part[0].v === 'fetch';
  if (part[0]?.v === '[') return splitTop(part.slice(1, -1), ',').some(value => bindsFetch(value, depth + 1));
  if (part[0]?.v === '{') return splitTop(part.slice(1, -1), ',').some(value => {
    const property = splitTop(value, ':');
    return bindsFetch(property.length > 1 ? property[1] : property[0], depth + 1);
  });
  return false;
}

function parameterScopes(ts, source) {
  const ranges = [];
  const bodyEnd = start => {
    if (ts[start]?.v === '{') return closingToken(ts, start);
    const end = argumentEnd(ts, start), candidates = [end]; let depth = 0;
    for (let i = start; i < end; i++) {
      if (!ts[i].string) {
        if (['(', '[', '{'].includes(ts[i].v)) depth++;
        if ([')', ']', '}'].includes(ts[i].v)) depth--;
      }
      if (!depth && i + 1 < end && /[\r\n\u2028\u2029]/.test(source.slice(ts[i].at, ts[i + 1].at))) candidates.push(i + 1);
    }
    // The JS parser distinguishes ASI from a multiline call, property, operator
    // or tagged template. Keep class/private/super context by parenthesizing
    // the candidate in the original program. Compile only, never invoke it.
    // Choose the longest complete expression before a possible statement break.
    for (const candidate of candidates.sort((a, b) => b - a)) {
      const at = ts[start].at, endAt = ts[candidate]?.at ?? ts.endAt ?? source.length;
      const program = source.slice(0, at) + '(' + source.slice(at, endAt) + '\n)\n' + source.slice(endAt);
      try { new Function('return async () => {\n' + program + '\n}'); return candidate; } catch {}
    }
    return end;
  };
  for (let i = 0; i < ts.length; i++) {
    if (!ts[i].string && ts[i].v === 'fetch' && ts[i + 1]?.v === '=>') ranges.push([i, bodyEnd(i + 2)]);
    if (ts[i].string || ts[i].v !== '(') continue;
    const end = closingToken(ts, i), arrow = ts[end + 1]?.v === '=>';
    const fn = ts[i - 1]?.v === 'function' || ts[i - 2]?.v === 'function' || ts[i - 3]?.v === 'function' && ts[i - 2]?.v === '*';
    if (!arrow && (!fn || ts[end + 1]?.v !== '{')) continue;
    if (splitTop(ts.slice(i + 1, end), ',').some(part => bindsFetch(part))) ranges.push([i, bodyEnd(end + (arrow ? 2 : 1))]);
  }
  return ranges;
}

function writeIn(ts, source) {
  const locals = new Set(), data = new Set(), parameters = parameterScopes(ts, source);
  const pageRoots = new Set(['document', 'window', 'globalThis']), pageAliases = new Set();
  for (let i = 0; i < ts.length; i++) {
    if (['const', 'let', 'var', 'function', 'class'].includes(ts[i - 1]?.v) && !ts[i].string) {
      locals.add(ts[i].v);
      if (ts[i + 1]?.v === '=' && ['{', '['].includes(ts[i + 2]?.v)) data.add(ts[i].v);
      if (ts[i + 1]?.v === '=' && ts[i + 2]?.v === 'JSON' && ts[i + 3]?.v === '.' && ts[i + 4]?.v === 'parse') data.add(ts[i].v);
    }
  }
  for (let pass = 0; pass < locals.size; pass++) {
    let added = false;
    for (let i = 0; i < ts.length; i++) {
      if (locals.has(ts[i].v) && ts[i + 1]?.v === '=' && data.has(ts[i + 2]?.v) && !data.has(ts[i].v)) {
        data.add(ts[i].v); added = true;
      }
    }
    if (!added) break;
  }
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i], v = token.v;
    const property = ['.', '?.'].includes(ts[i - 1]?.v);
    const computed = token.string && ts[i - 1]?.v === '[' && ts[i + 1]?.v === ']';
    let nextIndex = i + (computed ? 2 : 1);
    if (ts[nextIndex]?.v === '?.') nextIndex++;
    const next = ts[nextIndex]?.v;
    const receiver = receiverRoot(ts, i - 2);
    if (!token.string && !property && locals.has(v) && next === '=' && !pageRoots.has(v)) {
      const source = ts[nextIndex + 1]?.v;
      if (pageAliases.has(source) || pageRoots.has(source) && !data.has(source)) pageAliases.add(v);
      else pageAliases.delete(v);
    }
    let constructor = i;
    while (['.', '?.'].includes(ts[constructor - 1]?.v)) constructor -= 2;
    if (!token.string && ts[constructor - 1]?.v === 'new' && next === '(' && !locals.has(v) && !data.has(receiver)) {
      const action = v === 'DataTransfer' || v === 'DragEvent' ? 'drag' : /Event$/.test(v) ? 'read' : undefined;
      if (action) return { token, action };
    }
    const localFetch = !property && !computed && (locals.has(v) || parameters.some(([start, end]) => i >= start && i < end));
    if (!token.string && v === 'fetch' && next === '(' && !localFetch && !data.has(receiver)) return { token, action: 'read' };
    if (!token.string && !property && v === 'fetch' && next === '=' && !localFetch) return { token, action: 'read' };
    if ((property || computed) && next === '(' && ambiguousMethods.has(v)) {
      // Unknown receivers can be local classes or collection values. The
      // engine remains the read-only boundary when this preflight cannot tell.
      if (pageAliases.has(receiver) || pageRoots.has(receiver) && !data.has(receiver)) return { token, action: methods[v] };
      continue;
    }
    if ((!property && !computed) || data.has(receiver)) continue;
    if (next === '(' && Object.hasOwn(methods, v)) {
      const attribute = ts[nextIndex + 1];
      const action = v === 'setAttribute' && attribute?.string && ['value', 'checked', 'selected'].includes(attribute.v) ? setters[attribute.v] : methods[v];
      return { token, action };
    }
    if (['=', '+=', '-=', '++', '--', '||=', '&&=', '??='].includes(next)) {
      const action = Object.hasOwn(setters, v) ? setters[v] : /^on\w+$/.test(v) ? 'read' : undefined;
      if (action) return { token, action };
    }
  }
}

export function evaluateWrite(code) {
  if (typeof code !== 'string' || !code.includes('evaluate')) return;
  const writes = callbacks(tokens(code)).map(range => writeIn(range, code)).filter(Boolean).sort((a, b) => a.token.at - b.token.at);
  const write = writes[0];
  if (!write) return;
  const line = code.slice(0, write.token.at).split('\n').length;
  const action = EVALUATE_ACTION[write.action];
  const advice = action ? ` ${write.action === 'read' ? 'Read the controls with' : 'Use'} ${action}.` : '';
  return `Line ${line}: evaluate is read-only; ${write.token.v} cannot run there.${advice} Rejected before the engine call.`;
}
