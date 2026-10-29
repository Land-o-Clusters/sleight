import { dragTo } from './drag-to.mjs';
import { locateList } from './list-locate.mjs';

// The drop-and-render list in FowlBrowser's MIT settings fixture showed why a
// successful input call is insufficient: verify the whole order after each drop.
export async function reorder(tab, list, order, drag = dragTo) {
  if (!tab?.playwright || !Array.isArray(order) || order.length < 1 || order.length > 50 ||
      order.some(name => typeof name !== 'string' || !name.trim())) throw new Error('reorder needs a tab, list and 1 to 50 row names.');
  const { loc } = await locateList(tab, list, 'reorder');
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  order = order.map(normalize);
  const read = () => loc.evaluate(el => {
    const text = node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.getAttribute?.('aria-hidden') === 'true') return '';
      return node.getAttribute?.('aria-label') ?? Array.from(node.childNodes ?? []).map(text).join(' ');
    };
    return Array.from(el.children).map(row => text(row).replace(/\s+/g, ' ').trim());
  }, undefined, { timeoutMs: 1000 });
  const same = (a, b) => a.length === b.length && a.every((name, i) => name === b[i]);
  const before = await read();
  if (new Set(before).size !== before.length || before.some(name => !name) || new Set(order).size !== order.length) {
    throw new Error(`reorder needs unique nonempty row names. Read ${JSON.stringify(before)}; wanted ${JSON.stringify(order)}. Nothing was pressed.`);
  }
  if (before.length !== order.length || order.some(name => !before.includes(name))) {
    throw new Error(`reorder needs an exact permutation of all row names. Read ${JSON.stringify(before)}; wanted ${JSON.stringify(order)}. Nothing was pressed.`);
  }
  let after = before, moves = 0;
  const started = Date.now();
  for (let i = 0; i < order.length; i++) {
    if (after[i] === order[i]) continue;
    try {
      if (Date.now() - started >= 20000) throw new Error('20 second reorder limit reached');
      const current = await read();
      if (!same(current, after)) throw new Error('list changed before the next drop');
      const from = loc.locator(':scope > *').nth(after.indexOf(order[i])), to = loc.locator(':scope > *').nth(i);
      const expected = [...after];
      expected.splice(i, 0, expected.splice(after.indexOf(order[i]), 1)[0]);
      moves++;
      after = null;
      await drag(tab, from, to);
      for (let n = 0; n < 5; n++) {
        after = await read();
        if (same(after, expected)) break;
        if (n < 4) await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!same(after, expected)) return { before, after, moves, verified: false,
        note: 'Drop did not produce the requested order. Read the list before retrying.' };
    } catch (error) {
      return { before, after, moves, verified: false,
        note: `${error.message}. Input may have been sent; read the list before retrying.` };
    }
  }
  return { before, after, moves, verified: same(after, order) };
}

export function reorderCode(code, force = false) {
  if (!force && !/\bsleight\s*\.\s*reorder\s*\(/.test(code)) return code;
  return `globalThis.sleight ??= {}; globalThis.sleight.dragTo = (${dragTo.toString()});\n` +
    `globalThis.sleight.reorder = ((dragTo, locateList) => (${reorder.toString()}))(globalThis.sleight.dragTo, ${locateList.toString()});\n${code}`;
}

const DRAG_FAIL = /dragTo is not a function|DragEvent\b/;
const KEY_REORDER = /\b(?:pressKey|press)\s*\([\s\S]*\bArrow(?:Up|Down)\b/;
const HINT = 'Use nodeRepl.write(await sleight.reorder(tab, list, order)) or nodeRepl.write(await sleight.dragTo(tab, from, to)).';

export function rewriteDragAttempt(text, code = '') {
  if (typeof text !== 'string' || /sleight\.reorder|sleight\.dragTo/.test(text)) return text;
  if (!DRAG_FAIL.test(text) && !KEY_REORDER.test(code)) return text;
  return text.replace(/\s*$/, '') + '\n' + HINT;
}
