// The window guard reads the whole tree with diffing off after every js action,
// so the lease can check the window header (document-scope.mjs guardedCode).
// That read is also the engine's new diff baseline. Sending it whole costs
// tokens on every click: a browser page resends its sidebar each time.
//
// The relay keeps, per window, the last full tree it forwarded to Claude, and
// replaces a guard read with the lines that changed since then. Claude's view
// stays the latest full tree (what it saw plus every change since), which is
// the engine's baseline, so the engine's next diff starts from what Claude
// knows. Any full tree Claude reads itself also becomes the copy.
//
// Pages that load content renumber every element after the new ones. Lines
// are matched by their text without the element number, and elements whose
// only change is their number are left out and counted. Their old numbers are
// stale, so the relay tracks which numbers Claude has seen since its last full
// read and refuses actions on any other (staleIndex).

import { GUARD_MARK, documentKey, windowFromText } from './document-scope.mjs';

export { GUARD_MARK };
const MAX_LINES = 3000; // above this, the line diff costs more than it saves
const MAX_SHARE = 0.6; // a diff longer than this share of the tree is sent whole
const ELEMENT = /^(\t*)(\d+) (.*)$/;

// An element line's number and its text without the number.
function parse(line) {
  const m = ELEMENT.exec(line);
  return m ? { num: Number(m[2]), key: `${m[1]}${m[3]}` } : { num: undefined, key: line };
}

// The alignment of two trees by longest common subsequence of their keys,
// after trimming the shared head and tail: [beforeIndex, afterIndex] pairs,
// with -1 where a line has no partner.
export function alignLines(before, after, key = line => line) {
  const a = before.map(key), b = after.map(key);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n > MAX_LINES || m > MAX_LINES) return undefined;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[head + i] === b[head + j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { pairs.push([head + i, head + j]); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) pairs.push([head + i++, -1]);
    else pairs.push([-1, head + j++]);
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

export function lineDiff(before, after) {
  return alignLines(before, after)?.filter(([i, j]) => i < 0 || j < 0)
    .map(([i, j]) => (j < 0 ? '- ' + before[i] : '+ ' + after[j]));
}

export function createReadCompactor() {
  // window key -> { lines, valid }: the last full tree Claude got, and the
  // element numbers in it Claude knows are current (undefined: all of them).
  const seen = new Map();

  function compact(tree, prefix) {
    const window = windowFromText(tree);
    const lines = tree.replace(/\n+$/, '').split('\n');
    if (!window) return tree;
    const key = documentKey(window);
    const before = seen.get(key);
    seen.set(key, { lines });
    if (!before) return tree;
    const old = before.lines.map(parse), now = lines.map(parse);
    const pairs = alignLines(before.lines, lines, line => parse(line).key);
    if (!pairs) return tree;
    const valid = new Set(), changes = [];
    let renumbered = 0;
    for (const [i, j] of pairs) {
      if (j < 0) { changes.push('- ' + (old[i].num === undefined ? before.lines[i] : old[i].key)); continue; }
      const { num } = now[j];
      if (i < 0) { changes.push('+ ' + lines[j]); if (num !== undefined) valid.add(num); continue; }
      if (num === undefined) continue;
      if (num !== old[i].num) renumbered++;
      else if (!before.valid || before.valid.has(num)) valid.add(num);
    }
    // Numbers Claude saw in this same result, on a line identical to the
    // current tree's, are current too (its own reads, the engine's diff).
    const current = new Map(now.filter(l => l.num !== undefined).map(l => [l.num, l.key]));
    for (const line of prefix.split('\n')) {
      const shown = parse(line.replace(/^[+~] ?/, ''));
      if (shown.num !== undefined && current.get(shown.num) === shown.key) valid.add(shown.num);
    }
    const header = lines.slice(0, 2).join('\n');
    const body = changes.length
      ? `sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):\n${changes.join('\n')}`
      : 'sleight: no change since the last full tree you saw for this window' + (renumbered ? ', apart from numbering.' : '.');
    const note = renumbered
      ? `\nsleight: ${renumbered} other elements kept their text but have new numbers. Use numbers from + lines above or from a full read. Read the window again with getAXState({ disableDiffing: true }) before acting on any other element; sleight refuses actions on numbers that changed.`
      : '';
    const text = `${header}\n${body}${note}`;
    if (text.length > tree.length * MAX_SHARE) return tree;
    const allValid = [...current.keys()].every(num => valid.has(num));
    seen.set(key, { lines, valid: allValid ? undefined : valid });
    return text;
  }

  // Remembers the last full tree in a stretch of output Claude sees: from the
  // last line that starts with a Window header to the end.
  function remember(text) {
    const starts = [...text.matchAll(/^Window: /gm)];
    if (!starts.length) return;
    const tree = text.slice(starts.at(-1).index).replace(/\n+$/, '');
    const window = windowFromText(tree);
    if (window) seen.set(documentKey(window), { lines: tree.split('\n') });
  }

  return {
    // Rewrites a result's text items. Everything one js call writes arrives
    // as one item, so the guard's read (always written last) can follow
    // Claude's own output in the same item.
    process(content) {
      if (!Array.isArray(content)) return content;
      return content.map(item => {
        if (item?.type !== 'text' || typeof item.text !== 'string') return item;
        const at = item.text.lastIndexOf(GUARD_MARK);
        if (at < 0) { remember(item.text); return item; }
        const before = item.text.slice(0, at).replaceAll(GUARD_MARK, '');
        remember(before);
        const gap = before && !before.endsWith('\n') ? '\n' : '';
        return { ...item, text: before + gap + compact(item.text.slice(at + GUARD_MARK.length), before) };
      });
    },
    // The first element number in `code` that Claude can't know is current
    // for this window: { number } for a literal, { computed } for an expression.
    staleIndex(window, code) {
      const valid = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }))?.valid;
      if (!valid || typeof code !== 'string') return undefined;
      for (const [, arg] of code.matchAll(/\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*([^,)\s]+)/g)) {
        if (arg.startsWith('[')) continue;
        if (!/^\d+$/.test(arg)) return { computed: arg };
        if (!valid.has(Number(arg))) return { number: Number(arg) };
      }
      return undefined;
    },
    reset() { seen.clear(); },
  };
}
