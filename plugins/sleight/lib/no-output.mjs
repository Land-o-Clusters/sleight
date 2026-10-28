import { Script } from 'node:vm';

const TRIVIA = '(?:\\s|//[^\\n\\r\\u2028\\u2029]*(?:\\r\\n|[\\n\\r\\u2028\\u2029]|$)|/\\*[\\s\\S]*?\\*/)*';
const FINAL_SEMI = new RegExp(';' + TRIVIA + '$');
const EMPTY = /^(?:JavaScript code completed with no output\.?|\([\w]+ completed with no output\))$/;
const NOTE = 'sleight: this call completed and the kernel is running. A bare value at the end prints nothing. Wrap the value in nodeRepl.write(...).';

function valid(body) {
  try { new Script(`async function __sleightSyntax() {\n${body}\n}`); return true; }
  catch { return false; }
}

// Compile candidates without running them. Taking the longest valid suffix keeps ASI
// continuations together, and a valid prefix excludes nested blocks and literals.
export function finalExpression(code) {
  if (typeof code !== 'string' || code.length > 32768 || !valid(code)) return;
  const end = FINAL_SEMI.exec(code)?.index ?? code.length;
  const starts = [0, ...[...code.slice(0, end).matchAll(/[;\n}]/g)].map(m => m.index + 1)];
  if (starts.length > 128) return;
  for (const start of starts) {
    const expression = code.slice(start, end).replace(new RegExp('^' + TRIVIA), '').trim();
    if (!expression || /^(?:\{|(?:async\s+)?function\b|class\b)/.test(expression)) continue;
    if (!valid(`return (\n${expression}\n);`) || !valid(code.slice(0, start))) continue;
    return { expression, start, end };
  }
}

export function bareValue(expression) {
  return !/^(?:['"]use strict['"]|(?:await\s+)?(?:nodeRepl\.(?:write|emitImage|emitAudio)|console\.\w+)\s*\()/.test(expression)
    && !/\.(?:click|dblclick|drag|dragTo|scroll|selectText|setValue|paste|press|pressKey|typeText|fill|check|uncheck|setChecked|selectOption|goto|close|waitForTimeout)\s*\(/.test(expression);
}

export function noOutputNotice(code, content) {
  if (!Array.isArray(content) || !content.length ||
      !content.every(c => c.type === 'text' && EMPTY.test((c.text ?? '').trim()))) return;
  const final = finalExpression(code);
  if (final && bareValue(final.expression)) return NOTE;
}

function pure(expression) {
  // Templates, regexes, calls and writes keep their original behavior in this A/B.
  if (expression.includes('`')) return false;
  const source = expression.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g, '0');
  if (!/^[\w$\s.[\]()?:,+*%<>&|!~^-]+$/.test(source) ||
      /\b(?:await|new|delete|yield|function|class|import|super|this)\b|\+\+|--/.test(source)) return false;
  return !/[\w$)\]]\s*(?:\?\.)?\s*\(/.test(source);
}

export function autoPrintCode(code, enabled = false) {
  if (!enabled) return code;
  const final = finalExpression(code);
  if (!final || !bareValue(final.expression) || !pure(final.expression)) return code;
  return code.slice(0, final.start) + '\n' + printValueCode(final.expression) + code.slice(final.end);
}

export function printValueCode(expression) {
  return `await (async (__sleightValue) => {
  const { inspect } = await import('node:util');
  const text = typeof __sleightValue === 'string' ? __sleightValue : inspect(__sleightValue,
    { depth: 3, maxArrayLength: 20, maxStringLength: 2000, customInspect: false, getters: false });
  nodeRepl.write(text.length > 4000 ? text.slice(0, 3978) + '\\n[output truncated]' : text);
})(\n${expression}\n)`;
}
