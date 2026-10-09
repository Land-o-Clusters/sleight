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

import { GUARD_END, GUARD_MARK, documentKey, windowFromText, hasIdentifier } from './document-scope.mjs';

export { GUARD_END, GUARD_MARK };
const MAX_LINES = 3000; // above this, the line diff costs more than it saves
const MAX_SHARE = 0.6; // a diff longer than this share of the tree is sent whole
const ELEMENT = /^(\t*)(\d+) (.*)$/;

// number -> text without the number, for every element line.
const numbered = lines => lines.map(parse).filter(l => l.num !== undefined).map(l => [l.num, l.key]);

// An element line's number and its text without the number.
function parse(line) {
  const m = ELEMENT.exec(line);
  return m ? { num: Number(m[2]), key: `${m[1]}${m[3]}` } : { num: undefined, key: line };
}

// Under load Calculator can return `button Two` instead of its description and ID.
// Fold only a button's unique ID, never a lost value, state, indentation or guessed label.
function degradedButton(full, bare) {
  const m = /^(\t*)button ([^,:]+)$/.exec(bare);
  return !!m && full.startsWith(m[1] + 'button ') && !/\(|\bValue:/.test(full) &&
    full !== bare && hasIdentifier(full, m[2]);
}
const bareButtonId = key => /^\t*button ([^,:]+)$/.exec(key)?.[1];
const buttonHasId = (key, id) => /^\t*button /.test(key) &&
  (bareButtonId(key) === id || hasIdentifier(key, id));

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
    const keys = now.map(line => line.key);
    const degraded = new Set();
    for (let j = 0; j < now.length; j++) {
      const id = bareButtonId(now[j].key);
      if (now[j].num === undefined || id === undefined) continue;
      const matches = old.filter(line => line.num !== undefined && degradedButton(line.key, now[j].key));
      if (matches.length === 1 && [old, now].every(lines =>
        lines.filter(line => line.num !== undefined && buttonHasId(line.key, id)).length === 1)) {
        keys[j] = matches[0].key; degraded.add(j);
      }
    }
    const pairs = alignLines(old.map(line => line.key), keys);
    if (!pairs) return tree;
    // What Claude takes each number to be: the full tree it saw, plus the lines shown since.
    const believed = new Map(before.believed ?? numbered(before.lines));
    const valid = new Set(), changes = [];
    let renumbered = 0, fewerAttributes = 0;
    for (const [i, j] of pairs) {
      if (j < 0) {
        changes.push('- ' + (old[i].num === undefined ? before.lines[i] : old[i].key));
        if (old[i].num !== undefined && believed.get(old[i].num) === old[i].key) believed.delete(old[i].num);
        continue;
      }
      const { num } = now[j];
      if (i < 0) { changes.push('+ ' + lines[j]); if (num !== undefined) { valid.add(num); believed.set(num, now[j].key); } continue; }
      if (num === undefined) continue;
      if (degraded.has(j)) fewerAttributes++;
      if (num !== old[i].num) renumbered++;
      else if (!before.valid || before.valid.has(num)) valid.add(num);
    }
    // Numbers Claude saw in this same result, on a line identical to the
    // current tree's, are current too (its own reads, the engine's diff).
    const current = new Map(now.filter(l => l.num !== undefined).map(l => [l.num, l.key]));
    for (const line of prefix.split('\n')) {
      const shown = parse(line.replace(/^[+~] ?/, ''));
      if (shown.num !== undefined && current.get(shown.num) === shown.key) { valid.add(shown.num); believed.set(shown.num, shown.key); }
    }
    const header = lines.slice(0, 2).join('\n');
    const body = changes.length
      ? `sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):\n${changes.join('\n')}`
      : 'sleight: no change since the last full tree you saw for this window' + (renumbered ? ', apart from numbering.' : '.');
    const note = renumbered
      ? `\nsleight: ${renumbered} other elements have new numbers. Use numbers from + lines above or from a full read. Read the window again with getAXState({ disableDiffing: true }) before acting on any other element; sleight refuses actions on numbers that changed.`
      : '';
    const degradedNote = fewerAttributes ? `\nsleight: ${fewerAttributes} button lines returned fewer attributes. Their unique IDs still match; missing descriptions and help are unavailable in this read.` : '';
    const text = `${header}\n${body}${note}${degradedNote}`;
    if (text.length > tree.length * MAX_SHARE) return tree;
    const allValid = [...current.keys()].every(num => valid.has(num));
    seen.set(key, { lines, valid: allValid ? undefined : valid, believed: allValid ? undefined : believed });
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
    // as one item, so marked trees (Claude's reads and the guard's) sit among
    // Claude's other output. Each is compacted against what Claude saw before it.
    process(content, { forceFull = false } = {}) {
      if (!Array.isArray(content)) return content;
      return content.map(item => {
        if (item?.type !== 'text' || typeof item.text !== 'string' || !item.text.includes(GUARD_MARK)) {
          if (item?.type === 'text' && typeof item.text === 'string') remember(item.text);
          return item;
        }
        let out = '', seenText = '', pos = 0;
        const add = text => { if (out && text && !out.endsWith('\n')) out += '\n'; out += text; };
        for (;;) {
          const at = item.text.indexOf(GUARD_MARK, pos);
          const plain = item.text.slice(pos, at < 0 ? undefined : at);
          remember(plain); seenText += plain; add(plain);
          if (at < 0) break;
          const start = at + GUARD_MARK.length, end = item.text.indexOf(GUARD_END, start);
          const tree = item.text.slice(start, end < 0 ? undefined : end);
          const sent = forceFull ? tree : compact(tree, seenText);
          if (forceFull) remember(tree);
          add(sent); seenText += '\n' + sent;
          if (end < 0) break;
          pos = end + GUARD_END.length;
        }
        return { ...item, text: out };
      });
    },
    // The first element number in `code` that Claude can't know is current
    // for this window: { number } for a literal, { computed } for an expression.
    staleIndex(window, code) {
      const valid = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }))?.valid;
      if (!valid || typeof code !== 'string') return undefined;
      for (const [, arg] of code.matchAll(/\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*([^,)\s]+)/g)) {
        // Coordinates aren't element numbers, and an { id } is resolved fresh inside the call.
        if (arg.startsWith('[') || arg.startsWith('{')) continue;
        if (!/^\d+$/.test(arg)) return { computed: arg };
        if (!valid.has(Number(arg))) return { number: Number(arg) };
      }
      return undefined;
    },
    // A literal number Claude took from an older tree names the element it saw there. When that
    // element's text is on exactly one line of the current tree, the action can name it by that
    // line ({ line }), which the guard looks up fresh, instead of costing Claude a read and a turn.
    // Undefined unless every stale number in the call can be named that way.
    remapStale(window, code) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry?.valid || !entry.believed || typeof code !== 'string') return undefined;
      const texts = entry.lines.map(parse).filter(l => l.num !== undefined).map(l => l.key.replace(/^\t*/, ''));
      const remapped = [];
      let missing = false;
      const out = code.replace(/(\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*)(\d+)(?=\s*[,)])/g, (whole, head, digits) => {
        const number = Number(digits);
        if (entry.valid.has(number)) return whole;
        const believed = entry.believed.get(number)?.replace(/^\t*/, '');
        const matches = believed === undefined ? [] : texts.filter(t => t === believed || degradedButton(believed, t));
        if (matches.length !== 1) { missing = true; return whole; }
        const text = matches[0];
        if (text !== believed) {
          const id = bareButtonId(text);
          if (id === undefined || [texts, [...entry.believed.values()]].some(lines =>
            lines.filter(line => buttonHasId(line, id)).length !== 1)) { missing = true; return whole; }
        }
        remapped.push({ number, line: text });
        return head + JSON.stringify({ line: text });
      });
      return !missing && remapped.length ? { code: out, remapped } : undefined;
    },
    reset() { seen.clear(); },
  };
}
