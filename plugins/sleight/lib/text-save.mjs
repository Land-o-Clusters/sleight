import { unsupportedCodeLines } from './code-line-terminators.mjs';
import { tokens, invalidTokens } from './flow-rules.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';

// Like FowlBrowser's batched action tools, keep one caller result across the native settle.
// A bounded splitter for standalone awaited statements, not a JavaScript interpreter.
export function statementSpans(code) {
  if (unsupportedCodeLines(code)) return;
  const mask = code.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g,
    value => value.replace(/[^\n]/g, ' '));
  const spans = [];
  let start = 0, depth = 0;
  for (let i = 0; i < mask.length; i++) {
    if ('([{'.includes(mask[i])) depth++;
    else if (')]}'.includes(mask[i])) depth--;
    if (depth < 0) return;
    if (!depth && (mask[i] === ';' || (mask[i] === '\n' && /^\s*(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?await\b/.test(mask.slice(i + 1))))) {
      spans.push([start, i + 1]); start = i + 1;
    }
  }
  if (depth) return;
  spans.push([start, code.length]);
  return { spans, mask };
}

export function splitTextSave(code) {
  if (invalidTokens(tokens(code))) return;
  const split = statementSpans(code);
  if (!split) return;
  const { spans, mask } = split;
  const written = new Set();
  for (const [start, end] of spans) {
    const ts = tokens(code.slice(start, end));
    if (invalidTokens(ts)) return;
    if (ts.at(-1)?.v === ';') ts.pop();
    if (!ts.length) continue;
    if (['const', 'let', 'var'].includes(ts[0]?.v) && ts[2]?.v === '=' && ts[3]?.v === 'await') ts.splice(0, 3);
    if (ts[0]?.v !== 'await' || !/^[A-Za-z_$][\w$]*$/.test(ts[1]?.v ?? '') || ts[2]?.v !== '.' ||
        ts[4]?.v !== '(' || ts.at(-1)?.v !== ')') { written.clear(); continue; }
    let nesting = 0, closed;
    for (let i = 4; i < ts.length; i++) {
      if (!ts[i].string && ts[i].v === '(') nesting++;
      if (!ts[i].string && ts[i].v === ')' && --nesting === 0) { closed = i; break; }
    }
    if (closed !== ts.length - 1 || ts.some(t => ['<regexp>', '<template>'].includes(t.v))) { written.clear(); continue; }
    const handle = ts[1].v, method = ts[3].v;
    if (method === 'setValue') written.add(handle);
    else if (method === 'pressKey' && ts.length === 7 && ts[5].string && /^(?:cmd|command|super|meta)\+s$/i.test(ts[5].v)) {
      if (written.has(handle)) {
        // Keeping control flow whole is conservative; this splitter does not interpret function scopes.
        if (/\b(?:return|throw)\b/.test(mask.slice(0, start))) return;
        return { handle, head: code.slice(0, start).trim(), tail: code.slice(start).trim() };
      }
    }
  }
}

export async function prepareTextWrite(target, current, { identity, run }) {
  if (typeof identity !== 'function' || typeof run !== 'function') throw new Error('Text-write settle helper is unavailable.');
  const observed = await identity(target);
  let checked;
  try { checked = verifyWindowIdentity(target, observed); }
  catch (error) {
    error.textSaveStop = observed?.status === 'mismatch' ||
      !/^Input lease: (?:native window identity is unavailable|window identity is ambiguous)/.test(error.message);
    throw error;
  }
  if (!current()) throw new Error('Text save was stopped before settling.');
  return checked;
}

export async function settleTextWrite(target, current, grant, { identity, run }) {
  const checked = await prepareTextWrite(target, current, { identity, run });
  let result;
  try {
    result = await run('settle-text-write.js', { appId: target.appId, pid: checked.pid,
      processStart: checked.processStart, lease: grant });
  } catch (error) { error.textSaveStop = error.code !== 'ENOENT'; throw error; }
  if (!result?.ok) {
    const error = new Error(result?.error ?? 'Text-write settle failed.');
    error.textSaveStop = !['Text-write settle needs one running app', 'Cannot create Shift event'].includes(result?.error);
    throw error;
  }
}
