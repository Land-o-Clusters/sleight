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

import { GUARD_MARK, documentKey, windowFromText } from './document-scope.mjs';

export { GUARD_MARK };
const MAX_LINES = 4000; // above this, the line diff costs more than it saves
const MAX_SHARE = 0.6; // a diff longer than this share of the tree is sent whole

// Lines removed and added between two trees, in order, by longest common
// subsequence after trimming the shared head and tail.
export function lineDiff(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return undefined;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) out.push('- ' + a[i++]);
    else out.push('+ ' + b[j++]);
  }
  return out;
}

export function createReadCompactor() {
  const seen = new Map(); // window key -> lines of the last full tree Claude got

  function compact(tree) {
    const window = windowFromText(tree);
    const lines = tree.split('\n');
    if (!window) return tree;
    const key = documentKey(window);
    const before = seen.get(key);
    seen.set(key, lines);
    if (!before) return tree;
    const changes = lineDiff(before, lines);
    if (!changes) return tree;
    const header = lines.slice(0, 2).join('\n');
    const body = changes.length
      ? `sleight: lines changed since the last full tree you saw for this window (- removed, + added; element numbers are current):\n${changes.join('\n')}`
      : 'sleight: no change since the last full tree you saw for this window.';
    const text = `${header}\n${body}`;
    return text.length > tree.length * MAX_SHARE ? tree : text;
  }

  return {
    // Rewrites a result's text items in place: guard reads become diffs,
    // other full trees update the copy.
    process(content) {
      if (!Array.isArray(content)) return content;
      return content.map(item => {
        if (item?.type !== 'text' || typeof item.text !== 'string') return item;
        if (item.text.startsWith(GUARD_MARK)) return { ...item, text: compact(item.text.slice(GUARD_MARK.length)) };
        if (item.text.startsWith('Window: ')) {
          const window = windowFromText(item.text);
          if (window) seen.set(documentKey(window), item.text.split('\n'));
        }
        return item;
      });
    },
    reset() { seen.clear(); },
  };
}
