import { locateList } from './list-locate.mjs';

async function pickFromList(tab, list, text, opts = {}) {
  if (!tab?.playwright || typeof tab.cua?.scroll !== 'function') throw new Error('pickFromList needs a browser tab.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('pickFromList needs nonempty option text.');
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  const wanted = normalize(text);
  const { loc } = await locateList(tab, list, 'pickFromList');
  const options = { timeoutMs: 1000 }, seen = new Set(), started = opts.started ?? Date.now();
  const read = async () => {
    if (await loc.count() !== 1) throw new Error('List is missing or ambiguous.');
    return loc.evaluate(el => {
      const r = el.getBoundingClientRect(), root = document.documentElement;
      const left = Math.max(0, r.x), right = Math.min(root.clientWidth, r.x + r.width);
      const top = Math.max(0, r.y), bottom = Math.min(root.clientHeight, r.y + r.height);
      const rows = Array.from(el.querySelectorAll('[role="option"], option')).map(option => {
        const rect = option.getBoundingClientRect();
        return { text: String(option.getAttribute('aria-label') ?? option.innerText ?? option.textContent ?? '').replace(/\s+/g, ' ').trim(),
          disabled: option.disabled === true || option.getAttribute('aria-disabled') === 'true',
          selected: option.selected === true || option.getAttribute('aria-selected') === 'true',
          visible: rect.width > 0 && rect.height > 0 && rect.y < bottom && rect.y + rect.height > top && rect.x < right && rect.x + rect.width > left };
      });
      return { position: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight), height: el.clientHeight,
        viewport: root.clientHeight, point: [(left + right) / 2, (top + bottom) / 2], inView: right > left && bottom > top,
        rows: rows.filter(row => row.visible).slice(0, 200), selected: rows.filter(row => row.selected).map(row => row.text) };
    }, undefined, options);
  };
  let state = await read(), scrolls = 0, prefix = null;
  if (!state.inView) {
    await loc.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }), undefined, options);
    state = await read();
  }
  const remember = () => { for (const row of state.rows) if (seen.size < 50) seen.add(row.text.slice(0, 200)); };
  const fail = note => ({ found: false, verified: false, matched: null, selected: state.selected, position: state.position,
    scrolls, seen: [...seen], note: 'No option clicked. ' + note });
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const order = rows => {
    if (rows.length < 2) return 0;
    const signs = rows.slice(1).map((row, i) => Math.sign(compare(row.text, rows[i].text)));
    return signs.every(n => n >= 0) && signs.some(n => n > 0) ? 1 :
      signs.every(n => n <= 0) && signs.some(n => n < 0) ? -1 : 0;
  };
  let sort = order(state.rows), low = 0, high = state.max, scanning = opts.scan || !sort, fromStart = false;
  const choose = async name => {
    if (state.rows.find(row => row.text === name)?.disabled) return fail('The matching option is disabled.');
    const option = loc.getByRole('option', { name, exact: true });
    const count = await option.count();
    if (count !== 1) return fail(count === 0 ? 'The matching option was not found.' : 'The matching option is ambiguous.');
    try {
      await loc.evaluate((el, name) => {
        const row = Array.from(el.querySelectorAll('[role="option"], option')).find(option => {
          const text = String(option.getAttribute('aria-label') ?? option.innerText ?? option.textContent ?? '').replace(/\s+/g, ' ').trim();
          return text === name;
        });
        row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      }, name, options);
    } catch {}
    try { await option.click(options); }
    catch (error) {
      return { found: true, verified: null, matched: name, selected: null, position: state.position, scrolls,
        seen: [...seen],
        note: 'Option click failed. Input may have been sent. Read the page before retrying. ' + String(error.message) };
    }
    try {
      state = await read();
      const verified = state.selected.includes(name);
      return { found: true, verified, matched: name, selected: state.selected,
        position: state.position, scrolls, ...(verified ? {} : { seen: [...seen], note: 'The option was clicked, but selection was not verified. Read the page before retrying.' }) };
    } catch {
      return { found: true, verified: null, matched: name, selected: null, position: state.position, scrolls,
        seen: [...seen], note: 'Selection readback failed after the click. Read the page before retrying.' };
    }
  };
  const rel = text => (text === wanted || text.startsWith(wanted + ' ') ? 0 : compare(wanted, text));
  const ended = note => (prefix && prefix !== wanted) ? choose(prefix) : fail(note);
  for (;;) {
    remember();
    if (Date.now() - started >= 20_000) return fail('The search reached its 20s cap.');
    if (![state.position, state.max, state.height, state.viewport, ...state.point].every(Number.isFinite) ||
        state.height <= 0 || state.viewport <= 0 || !state.inView) return fail('The list needs a finite rectangle inside the viewport.');
    const exact = state.rows.filter(row => row.text === wanted);
    const prefixes = state.rows.filter(row => row.text.startsWith(wanted + ' '));
    if (exact.length > 1) return fail('The matching option is ambiguous.');
    if (exact.length === 1) return choose(exact[0].text);
    const currentOrder = order(state.rows);
    if (sort && state.rows.length >= 3 && currentOrder !== sort) {
      sort = 0; scanning = true; fromStart = false;
    }
    if (prefixes.length) {
      const names = [...new Set(prefixes.map(row => row.text))];
      if (names.length > 1 || (prefix && names.some(name => name !== prefix))) return fail('The matching option is ambiguous.');
      prefix ??= names[0];
      if (sort && state.rows.length >= 3 && currentOrder === sort) {
        const predecessor = state.rows[0].text !== names[0];
        const atHead = state.position <= 1 && state.rows[0].text === names[0];
        const lastPrefix = state.rows.findLastIndex(row => row.text === names[0]);
        const successor = state.rows[lastPrefix + 1];
        const bounded = state.position >= state.max - 1 || (successor && sort * rel(successor.text) < 0);
        if ((predecessor || atHead) && bounded) return choose(names[0]);
      }
    }
    // The cap stops before the whole list was seen, so a prefix there could hide the exact option.
    if (scrolls >= (opts.scan ? 48 : 24)) return fail('The search reached its scroll cap before seeing the whole list.');
    let next;
    if (!scanning) {
      if (order(state.rows) !== sort) scanning = true;
      else if (sort * rel(state.rows[0].text) < 0) high = Math.min(high, Math.max(0, state.position - 1));
      else if (sort * rel(state.rows.at(-1).text) > 0) low = Math.max(low, Math.min(state.max, state.position + 1));
      else scanning = true;
      if (!scanning) {
        next = (low + Math.min(high, state.max)) / 2;
        if (Math.abs(next - state.position) < 1) {
          next = sort * rel(state.rows[0].text) < 0 ? Math.floor(next) : Math.ceil(next);
        }
        if (low > high || Math.abs(next - state.position) < 0.5) scanning = true;
      }
    }
    if (scanning) {
      if (prefix && sort && state.rows[0].text === prefix && state.position > 1) {
        next = Math.max(0, state.position - state.height * 0.5);
      } else if (!fromStart && state.position > 1 && (!prefix || !sort)) next = 0;
      else {
        fromStart = true;
        if (state.position >= state.max - 1) return ended('The list ended without the requested option.');
        next = Math.min(state.max, state.position + state.height * 0.75);
      }
    }
    const previous = state.position, delta = next - previous;
    const previousRows = JSON.stringify(state.rows.map(row => row.text));
    try {
      const pages = Math.min(8, Math.abs(delta) / Math.max(100, state.viewport));
      await tab.cua.scroll({ x: state.point[0], y: state.point[1], scrollX: 0, scrollY: (delta < 0 ? -1 : 1) * pages * state.viewport });
      scrolls++;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 50));
        state = await read();
        if (Math.abs(state.position - previous) >= 0.5 && state.rows.length &&
            JSON.stringify(state.rows.map(row => row.text)) !== previousRows) break;
      }
      if (Math.abs(state.position - previous) < 0.5) { remember(); return fail('Scrolling did not advance the list.'); }
      if (!state.rows.length) return fail('Rendered options did not settle after scrolling.');
    } catch (error) { return fail('Scroll or read failed. Input may have been sent. Read the page before retrying. ' + String(error.message)); }
  }
}

// Runs only in the completeness arm. Its read is metadata for reporting, never input authority.
function withPickerCompleteness(pick, locateList) {
  return async (tab, list, text, opts = {}) => {
    const result = await pick(tab, list, text, opts);
    let scope = 'row total unknown';
    try {
      const { loc } = await locateList(tab, list, 'pickFromList');
      const { total, rendered } = await loc.evaluate(el => ({
        total: el.getAttribute('aria-setsize') ?? el.getAttribute('aria-rowcount') ??
          el.querySelector('[aria-setsize]')?.getAttribute('aria-setsize'),
        rendered: el.querySelectorAll('[role="option"], option').length,
      }), undefined, { timeoutMs: 1000 });
      const count = /^\d+$/.test(total ?? '') ? Number(total) : null;
      if (Number.isSafeInteger(count) && count >= rendered)
        scope = (count - rendered) + ' rows not rendered (page-declared total)';
    } catch { /* unknown collection size */ }
    return { ...result, completeness: result.verified ? 'complete (selection readback); ' + scope
      : scope + (result.found ? '; selection unverified' : '; search incomplete') };
  };
}

// Keep the pre-G9 function body above unchanged so default injected calls keep their original bytes.
export { selectedPickFromList as pickFromList };
function selectedPickFromList(tab, list, text, opts = {}) {
  return (process.env.SLEIGHT_COMPLETENESS === '1' ? withPickerCompleteness(pickFromList, locateList) : pickFromList)(tab, list, text, opts);
}

export function pickFromListCode(code, completeness = process.env.SLEIGHT_COMPLETENESS === '1') {
  if (!/\bsleight\s*\.\s*pickFromList\s*\(/.test(code)) return code;
  const picker = completeness ? `(${withPickerCompleteness.toString()})((${pickFromList.toString()}), locateList)` : `(${pickFromList.toString()})`;
  return `globalThis.sleight ??= {}; globalThis.sleight.pickFromList = ((locateList) => ${picker})(${locateList.toString()});\n${code}`;
}
