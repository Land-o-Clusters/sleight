// Claude Code saves a tool result over about 50 KB to a file and shows Claude a 2 KB preview (the smallest
// spilled result was 52.2 KB, 2026-10-12). A first call that picks a browser and opens a tab gets the
// engine's general docs, its browser docs, sleight's skill and the page, about 56 KB, and in 32 of 39
// benchmark runs Claude started without any of it. This keeps results under RESULT_LIMIT: on macOS it drops
// the engine's Linux- and Windows-only paragraphs, and if the result is still too big it moves the browser
// API reference to the start of the next result. Safety and confirmation sections never move.
import { trimBrowserResults } from './browser-read-cap.mjs';
import { createDocumentationTrust } from './canonical-documentation.mjs';

export const RESULT_LIMIT = 45000;
export const GROK_RESULT_LIMIT = 20000;

// The final serialized result includes content wrappers, metadata and base64 images. Keep safety
// prose whole. An output that can't fit after tree trimming becomes an explicit delivery failure.
export function grokResult(result, onUndelivered, onTreeTrim) {
  const fits = value => Buffer.byteLength(JSON.stringify(value)) <= GROK_RESULT_LIMIT;
  if (fits(result)) return result;
  let out = { ...result };
  if (Array.isArray(out.content)) {
    for (let limit = 16000; limit >= 0; limit -= 2000) {
      out.content = trimResultTrees(out.content, limit, true, onTreeTrim);
      if (fits(out)) return out;
    }
  }
  const guidance = onUndelivered?.() ?? [];
  const failure = { isError: true, content: [{ type: 'text', text:
    'sleight: the result exceeds Grok\'s 20000-byte limit and could not be delivered whole. Execution may have completed. Do not replay input automatically. Read current state with a smaller filtered read; image delivery needs a smaller capture.' }] };
  const withGuidance = { ...failure, content: [...failure.content, ...guidance] };
  return fits(withGuidance) ? withGuidance : failure;
}

const GENERAL_DOCS = /^## Computer Use\n/;
const BROWSER_DOCS = /^# Other Browser APIs\n/;
const POLICY = '\n# Computer Use Confirmations Policy';
const REFERENCE = '\n# API Reference\n';
const OTHER_PLATFORM = /\b(?:Linux|Windows)\b/;
const NATIVE_REFERENCE = /\bsleight\.nativeDocumentation\s*\(/;
const POLICY_REFERENCE = /\bcua(?:\.rewriteDocumentation|\[\s*(['"])rewriteDocumentation\1\s*\])\s*\(/;
export const requestsFullDocumentation = (code = '') => POLICY_REFERENCE.test(code);
const NATIVE_NOTICE = 'sleight: Read the native reference with `nodeRepl.write("Full native reference:\\n" + await sleight.nativeDocumentation())` when needed. It documents `cua.getTab`, `cua.listTabs`, `cua.getState`, `cua.getApp` and the rest.';

function dropOtherPlatforms(text) {
  const cut = text.indexOf(POLICY);
  const head = cut < 0 ? text : text.slice(0, cut);
  const kept = head.split('\n\n').filter((p) => !OTHER_PLATFORM.test(p) || /\bmacOS\b/.test(p)).join('\n\n');
  return cut < 0 ? kept : kept + text.slice(cut);
}

// Engine docs are 81% of what sleight's results send Claude (571,870 of 705,611 characters over 13 runs, 2026-10-12),
// and every later call reads them again. Across 3,483 calls Claude wrote that day it never used these reference types,
// so they're left out; their members stay, so a fetch through the engine's own docs still finds them.
const UNUSED_TYPES = /^(?:BrowserHistory\w*|TabDev\w*|TabClipboardAPI|TabClipboardItem|ContentAPI|BrowserUser\w*|PlaywrightFileChooser)$/;
// Standard Playwright methods keep their signatures and lose the comment, which repeats Playwright's own docs. Every
// other comment stays, since some carry the engine's own limits (read-only evaluate, timeouts).
const STANDARD = new Set(['all', 'allTextContents', 'and', 'blur', 'boundingBox', 'check', 'clear', 'click', 'count', 'dblclick',
  'fill', 'filter', 'first', 'focus', 'getAttribute', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId',
  'getByText', 'getByTitle', 'hover', 'innerHTML', 'innerText', 'inputValue', 'isChecked', 'isDisabled', 'isEditable', 'isEnabled',
  'isHidden', 'isVisible', 'last', 'locator', 'nth', 'or', 'press', 'pressSequentially', 'scrollIntoViewIfNeeded', 'selectOption',
  'setChecked', 'textContent', 'type', 'uncheck', 'waitFor']);

function trimReference(text) {
  return text.replace(/\n(?:interface|type) (\w+)[^\n]*\{[\s\S]*?\n\};?\n?/g, (block, name) => {
    if (UNUSED_TYPES.test(name)) return '\n';
    if (!name.startsWith('Playwright')) return block;
    return block.replace(/^( {2}(\w+)(?:<[^>]*>)?\([^\n]*?;) \/\/ [^\n]*$/gm, (line, kept, method) => (STANDARD.has(method) ? kept : line));
  });
}

const ENGINE_LIMIT = /read[- ]only|timeout|maximum time|must\b|\bonly\b|\bnever\b|\bcannot\b|\bunsupported\b|\bnot supported\b|\bbefore\b|\brequir(?:e|es|ed)\b/i;

function leanReference(text, minimal = false) {
  const at = text.indexOf(REFERENCE) + REFERENCE.length;
  const rest = text.slice(at);
  const block = /^```(?:ts|typescript)\n([\s\S]*?)^```[ \t]*$/m.exec(rest);
  if (!block || /\n# /.test(rest.slice(0, block.index))) return text;
  // Keep quoted strings intact, and retain complete comments that carry engine restrictions.
  const limits = [];
  const index = block[1].replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (part, quoted, comment) => {
      if (quoted) return quoted;
      if (!ENGINE_LIMIT.test(comment)) return '';
      limits.push(comment.replace(/^\/\/\s*|^\/\*\*?\s*|\s*\*\/$/g, '').replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim());
      return comment;
    })
    .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  const topicCall = /# Additional Documentation\n[\s\S]*?`(await agent\.documentation\.get\("<name>"\))`/.exec(text)?.[1];
  const fullCall = /\bdocumentation\(\): Promise<string>/.test(block[1])
    ? 'On your `cua.getBrowser(...)` handle (here `b`), read the full reference with `nodeRepl.write("Full browser reference:\\n" + await b.documentation())`.'
    : 'Use SLEIGHT_ENGINE_DOCS=full for the full reference.';
  const notice = `${fullCall}${topicCall ? ` Topic documentation: \`${topicCall}\`.` : ''}`;
  if (minimal) return text.slice(0, at) + `\n${notice}\n\n` + limits.map(line => `- ${line}`).join('\n') + '\n' +
    rest.slice(block.index + block[0].length);
  return text.slice(0, at) + `\n${notice}\n\n` + rest.slice(0, block.index) +
    block[0].replace(block[1], index) + rest.slice(block.index + block[0].length);
}

const size = (content) => content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0) + Math.max(0, content.length - 1);
// Claude Code measures the serialized result, where each tab and newline is two characters (`\t`, `\n`). A tab-heavy
// tree of 44,967 characters serialized to 52.5 KB (2026-10-17), over the 52.2 KB spill, so trees are trimmed on both.
const wire = (text) => Buffer.byteLength(JSON.stringify(text)) - 2;
const wireSize = (content) => content.reduce((n, c) => n + (c.type === 'text' ? wire(c.text) : 0), 0);
const WIRE_MARGIN = 2500;

const TREE_ROW = /^(?:[+~-] )?\t*(\d+) /;
const OMISSION = /^sleight: (\d+) (?:browser )?tree lines omitted\b/;
const TREE_BOUNDARY = /^(?:The focused UI element|Computer Use\b)/;

// A row owns the continuation island up to the next row. Never cut that island on
// a physical line boundary. Unknown trailing prose stays outside the span, with
// its preceding row, since it could be either a label or a caller's output.
// Numbers increase in engine trees. Numeric label continuations can repeat a
// number, so only increasing numbers start removable row groups.
function resultTrees(text) {
  const lines = text.split('\n'), offsets = [0], trees = [];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^(?:Window: |Browser tab: )[^\n]+$/.test(lines[i]) || !/^(?:[+~-] )?\d+ /.test(lines[i + 1])) continue;
    const start = i, root = i + 1, rows = [];
    let j = root, end = root + 1, lastRow = root, previous = 0, lastNumber = -1, tailOmission;
    for (; j < lines.length; j++) {
      const line = lines[j], omission = OMISSION.exec(line), row = TREE_ROW.exec(line);
      if (j > root && TREE_BOUNDARY.test(line)) break;
      // A new header needs its own unindented root. A Window line in a
      // multiline label does not transfer ownership of the following rows.
      if (j > root && /^(?:Window: |Browser tab: )/.test(line) && /^(?:[+~-] )?0 /.test(lines[j + 1] ?? '')) break;
      if (row && Number(row[1]) > lastNumber) {
        const number = Number(row[1]);
        if (j > root) rows.push({ start: j, number });
        lastNumber = number; lastRow = j; tailOmission = undefined; end = j + 1;
      } else if (omission) {
        tailOmission ??= j;
      } else if (line === 'Close tab' && tailOmission === undefined) end = j + 1;
    }
    // An omission counts only at the tail. Unknown suffixes and their owning
    // row stay whole even when a focus or refusal boundary follows them.
    if (tailOmission !== undefined && lines.slice(end, tailOmission).some(line => line !== '')) {
      end = lastRow; tailOmission = undefined;
    } else if (tailOmission !== undefined) {
      end = tailOmission + 1;
      previous = Number(OMISSION.exec(lines[tailOmission])[1]);
    } else if (lines.slice(end, j).some(line => line !== '')) {
      end = lastRow;
    }
    const bodyRows = rows.filter(row => row.start < end);
    const headEnd = bodyRows[0]?.start ?? end;
    const clean = (from, to) => {
      const kept = [];
      for (let k = from; k < to; k++) {
        if (k !== tailOmission) kept.push(lines[k]);
      }
      return kept.join('\n');
    };
    if (end > root) trees.push({ start: offsets[start], end: offsets[end] - 1,
      head: clean(start, headEnd), previous,
      rows: bodyRows.map((row, k) => ({ number: row.number,
        text: clean(row.start, bodyRows[k + 1]?.start ?? end) })) });
    i = Math.max(root, j - 1);
  }
  return trees;
}

// A one-line item is a tree row that arrived as its own content item (a continued call's head, 381 items), which no
// regex over one item can see as a tree. Runs of them behind a one-line header are joined so they trim like any tree.
const ROW_ITEM = /^$|^(?:[+~-] )?\t*\d+ |^\t|^Close tab$|^The focused UI element/;
const lineItem = c => c?.type === 'text' && typeof c.text === 'string' && !c.text.includes('\n') && ROW_ITEM.test(c.text);
function joinTreeItems(content) {
  const out = [];
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c?.type !== 'text' || !/^(?:Window: |Browser tab: )[^\n]+$/.test(c.text ?? '') || !lineItem(content[i + 1])) { out.push(c); continue; }
    const lines = [c.text];
    while (lineItem(content[i + 1])) { lines.push(content[++i].text); if (content[i].text.startsWith('The focused UI element')) break; }
    out.push({ ...c, text: lines.join('\n') });
  }
  return out;
}

// Trees are trimmed oldest first, from their last row, so the final page (the one Claude asked for, with its answer near
// the top) is cut last and keeps its head. `force` returns the shortest result the trees allow when the limit is out of
// reach, since a result Claude Code rejects (126,517 characters, 2026-10-18) costs a whole re-read.
function trimResultTrees(content, limit, force = false, onTreeTrim) {
  let excess = size(content) - limit, wireExcess = wireSize(content) - (limit + WIRE_MARGIN);
  if (excess <= 0 && wireExcess <= 0) return content;
  const joined = joinTreeItems(content);
  const trimmed = [];
  const out = joined.map(c => {
    if ((excess <= 0 && wireExcess <= 0) || c.type !== 'text' || /^(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference)\n/.test(c.text)) return c;
    let text = '', pos = 0;
    for (const span of resultTrees(c.text)) {
      text += c.text.slice(pos, span.start); pos = span.end;
      const tree = c.text.slice(span.start, span.end);
      if (excess <= 0 && wireExcess <= 0) { text += tree; continue; }
      const rows = [...span.rows], hidden = [];
      let omitted = span.previous;
      let compactNote = false;
      const note = () => `\nsleight: ${omitted} tree lines omitted` + (compactNote ? '.' :
        ' to keep the result and engine docs within the size limit. Use a filtered read for missing information.');
      const base = [span.head, ...rows.map(row => row.text)].join('\n');
      let gone = tree.length - base.length, goneWire = wire(tree) - wire(base);
      const short = () => { const n = note(); return gone - n.length < excess || goneWire - wire(n) < wireExcess; };
      while (rows.length && short()) {
        const row = rows.pop();
        // Revoke numeric imitations inside a removed label too. They must not
        // survive as usable numbers in a baseline that parsed physical lines.
        for (const match of row.text.matchAll(/^(?:[+~-] )?\t*(\d+) /gm)) hidden.push(Number(match[1]));
        omitted += row.text.split('\n').length;
        gone += row.text.length + 1; goneWire += wire(row.text) + 2;
      }
      // Policy can leave less room than the omission advice itself needs. Keep the header and root,
      // and shorten only that advice after every removable row has gone.
      if (short()) compactNote = true;
      const out = [span.head, ...rows.map(row => row.text)].join('\n') + note();
      // Tiny trees can cost more in omission advice than they save.
      if (out.length >= tree.length || wire(out) >= wire(tree)) { text += tree; continue; }
      excess -= tree.length - out.length;
      wireExcess -= wire(tree) - wire(out);
      trimmed.push({ tree, hidden });
      text += out;
    }
    text += c.text.slice(pos);
    return text === c.text ? c : { ...c, text };
  });
  if ((excess > 0 || wireExcess > 0) && !force) return content;
  for (const { tree, hidden } of trimmed) onTreeTrim?.(tree, hidden, out);
  return out;
}

export function createResultBudget({ platform = process.platform, limit = RESULT_LIMIT, fullDocs = process.env.SLEIGHT_ENGINE_DOCS === 'full',
  leanDocs = process.env.SLEIGHT_ENGINE_DOCS === 'lean', minDocs = process.env.SLEIGHT_ENGINE_DOCS === 'min',
  documentationTrust = createDocumentationTrust(), validateDocumentation = true, trustedDocumentation = documentationTrust.trusted, onTreeTrim } = {}) {
  let pending = null;
  let browserFirst, nativeDocs, nativeDelivered = false;
  const requests = new Map();
  return {
    request(id, { browser, code = '' }) {
      browserFirst ??= browser;
      requests.set(id, { browser, reference: NATIVE_REFERENCE.test(code) || requestsFullDocumentation(code) });
    },
    finish(id) { requests.delete(id); },
    retry(content) {
      if (content.some(c => trustedDocumentation(c) && c.type === 'text' && GENERAL_DOCS.test(c.text))) nativeDelivered = false;
    },
    code(code) {
      if (nativeDocs && !trustedDocumentation(nativeDocs)) { nativeDocs = undefined; nativeDelivered = false; }
      if (!nativeDocs || !NATIVE_REFERENCE.test(code)) return code;
      return `globalThis.sleight ??= {}; globalThis.sleight.nativeDocumentation = async () => ${JSON.stringify(nativeDocs.text)};\n` + code;
    },
    apply(content, { id, native = false } = {}) {
      if (nativeDocs && !trustedDocumentation(nativeDocs)) { nativeDocs = undefined; nativeDelivered = false; }
      if (pending && !trustedDocumentation(pending)) pending = null;
      let out = (validateDocumentation ? content.map(documentationTrust.mark) : content).map((c) => (platform === 'darwin' && c.type === 'text' && GENERAL_DOCS.test(c.text)
        ? { ...c, text: dropOtherPlatforms(c.text) } : c));
      if (browserFirst && !fullDocs) {
        const request = requests.get(id);
        const nativeCall = request && (native || !request.browser) && !request.reference;
        if (nativeCall && !nativeDelivered && nativeDocs && !out.some(c => trustedDocumentation(c) && c.type === 'text' && GENERAL_DOCS.test(c.text))) {
          out = [nativeDocs, ...out];
        }
        const deliver = (nativeCall && !nativeDelivered) || request?.reference;
        out = out.map(c => {
          if (!trustedDocumentation(c) || c.type !== 'text' || !GENERAL_DOCS.test(c.text)) return c;
          const policy = c.text.indexOf(POLICY);
          if (policy < 0) return c;
          nativeDocs = c;
          if (deliver) { nativeDelivered = true; return c; }
          return { ...c, text: (nativeDelivered ? '' : NATIVE_NOTICE + '\n') + c.text.slice(policy + 1) };
        });
        if (request?.reference && nativeDocs && out.some(c => c.type === 'text' && c.text.includes(nativeDocs.text))) nativeDelivered = true;
      }
      if (!fullDocs) out = out.map((c) => (c.type === 'text' && BROWSER_DOCS.test(c.text) && c.text.includes(REFERENCE)
        ? { ...c, text: minDocs || leanDocs ? leanReference(c.text, minDocs) : trimReference(c.text) } : c));
      if (pending) { out = [pending, ...out]; pending = null; }
      // Spend the tree's rows before delaying reference text; policy and caller prose stay whole.
      // With no reference to delay, the trees are all there is to give.
      const deferrable = out.some(c => trustedDocumentation(c) && c.type === 'text' && BROWSER_DOCS.test(c.text) && c.text.includes(REFERENCE));
      out = trimResultTrees(trimBrowserResults(out, '', { limit, countDocs: true }), limit, !deferrable, onTreeTrim);
      if (size(out) <= limit) return out;
      out = out.map((c) => {
        if (pending || !trustedDocumentation(c) || c.type !== 'text' || !BROWSER_DOCS.test(c.text)) return c;
        const at = c.text.indexOf(REFERENCE);
        if (at < 0) return c;
        pending = { ...c, text: c.text.slice(at + 1) };
        return { ...c, text: `${c.text.slice(0, at)}\n\nsleight: the browser API reference (${pending.text.length} characters) follows at the start of your next result, to keep this one under Claude Code's size limit. Until then, use only the methods named above.` };
      });
      return trimResultTrees(trimBrowserResults(out, '', { limit, countDocs: true }), limit, true, onTreeTrim);
    },
  };
}
