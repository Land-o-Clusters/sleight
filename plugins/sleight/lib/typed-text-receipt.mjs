import { GUARD_MARK, GUARD_END } from './document-scope.mjs';

// Advisory eligibility only. Counts come from the guard's completed runtime calls, never
// from counting source literals (a loop or a variable need not match the source text).
export function typingReceiptCall(code = '') {
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    value => ' '.repeat(value.length));
  const inputs = [...masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(typeText|paste|click|pressKey|setValue|selectText|performSecondaryAction|scroll|drag)\s*\(/g)];
  return inputs.length > 0 && inputs.every(call => ['typeText', 'paste'].includes(call[2])) &&
    new Set(inputs.map(call => call[1])).size === 1;
}

const signature = lines => lines.join('\n').trim();

export function typedTextReceipt({ action, content, mark, failed = false }) {
  const before = action?.before;
  if (failed || !mark || !before || before.incomplete || before.degraded || action.overlap) return;
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const start = text.lastIndexOf(GUARD_MARK), end = text.indexOf(GUARD_END, start + GUARD_MARK.length);
  if (start < 0 || end < 0) return;
  const lines = text.slice(start + GUARD_MARK.length, end).trim().split('\n');
  if (!/^Window: /.test(lines[0]) || !/^\d+ (?:standard window|window)\b/.test(lines[1]) ||
      /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(lines.join('\n')) ||
      signature(lines) !== signature(before.lines)) return;
  const target = typingReceiptTarget(action);
  if (!target) return;
  const receipts = text.split('\n').filter(line => line.startsWith(mark));
  if (receipts.length !== 1) return;
  let count;
  try { count = JSON.parse(receipts[0].slice(mark.length)).typedCharacters; } catch { return; }
  if (!Number.isSafeInteger(count) || count < 0) return;
  if (!count) return;
  return `sleight: sent ${count} characters to ${target}; tree unchanged; insertion unconfirmed.`;
}

// The existing guard holds the strings for its window checks. Export only their count.
export function typingReceiptCode(mark) {
  return `\n{const t=globalThis.__sleightDocumentGuard?.typed;if(t?.length)nodeRepl.write(${JSON.stringify(mark)}+JSON.stringify({typedCharacters:t.reduce((n,s)=>n+[...s].length,0)})+'\\n')}`;
}

export function withoutTypingReceipt(content, mark) {
  if (!mark) return content;
  return content.map(item => {
    if (item.type !== 'text') return item;
    const text = item.text.replace(/[^\n]*(?:\n|$)/g, line => {
      if (!line.startsWith(mark)) return line;
      try { if (Object.hasOwn(JSON.parse(line.slice(mark.length)), 'typedCharacters')) return ''; } catch { /* Keep unrelated output. */ }
      return line;
    });
    return text === item.text ? item : { ...item, text };
  }).filter(item => item.type !== 'text' || item.text.trim());
}

export function typingReceiptTarget(action) {
  const before = action?.before;
  if (!before || before.incomplete || before.degraded || action.overlap) return;
  const lines = before.lines;
  const focus = /^The focused UI element is (\d+) /.exec(lines.find(line => line.startsWith('The focused UI element is ')) ?? '');
  if (!focus) return;
  const rows = lines.filter(line => new RegExp(`^\\t*${focus[1]} `).test(line));
  if (rows.length !== 1 || /\bsecure\b|\bpassword\b/i.test(rows[0])) return;
  const field = /^\t*\d+ ((?:text entry area|text field|text area|text view|search field|combo box)\b[^\n]*)/.exec(rows[0]);
  if (!field || !/\bValue:/.test(rows[0])) return;
  return field[1].split(/, (?:Value|ID|Help|Description|URL|Secondary Actions):/)[0]
    .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100);
}
