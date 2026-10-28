// The eight-step path and two-move dragover requirement were measured with
// bench/fowl/drag-probe.mjs, using an HTML5 list like FowlBrowser's MIT settings fixture.
export async function dragTo(tab, from, to) {
  if (!tab?.playwright || typeof tab.drag !== 'function') throw new Error('dragTo needs a browser tab.');
  const inspect = (el, scroll = false) => {
    if (Array.isArray(el)) {
      el = document.elementFromPoint(el[0], el[1]);
      el = el?.closest('[draggable="true"]') ?? el;
    } else if (el?.path) {
      scroll = el.scroll ?? scroll;
      el = el.path.reduce((node, index) => node?.children[index], document.documentElement);
    } else if (el?.tag) {
      const key = el;
      const matches = Array.from(document.getElementsByTagName(key.tag)).filter(node =>
        key.id ? node.id === key.id : String(node.textContent ?? '').slice(0, 200) === key.text);
      if (matches.length !== 1 || !matches[0].parentElement) return null;
      el = matches[0];
    }
    if (!el?.parentElement) throw new Error('dragTo needs exactly one attached element at each endpoint.');
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const path = [];
    for (let node = el; node.parentElement; node = node.parentElement) path.unshift(Array.from(node.parentElement.children).indexOf(node));
    const clip = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    for (let node = el.parentElement; node && node !== document.scrollingElement && node !== document.documentElement; node = node.parentElement) {
      if (!/^(auto|scroll)$/.test(window.getComputedStyle(node).overflowY)) continue;
      const bounds = node.getBoundingClientRect(), x = bounds.x + (node.clientLeft ?? 0), y = bounds.y + (node.clientTop ?? 0);
      clip.left = Math.max(clip.left, x); clip.top = Math.max(clip.top, y);
      clip.right = Math.min(clip.right, x + node.clientWidth); clip.bottom = Math.min(clip.bottom, y + node.clientHeight);
    }
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      index: Array.from(el.parentElement.children).indexOf(el), parent: el.parentElement.id || null, path, clip,
      id: el.id, tag: el.tagName, text: String(el.textContent ?? '').slice(0, 200) };
  };
  const read = async (endpoint, scroll = false) => {
    let rect;
    if (Array.isArray(endpoint)) {
      if (endpoint.length !== 2 || !endpoint.every(Number.isFinite)) throw new Error('dragTo coordinates must be two finite numbers.');
      rect = await tab.playwright.evaluate(inspect, endpoint);
    } else if (endpoint?.path) {
      rect = await tab.playwright.evaluate(inspect, { ...endpoint, scroll });
    } else {
      const loc = typeof endpoint === 'string' ? tab.playwright.locator(endpoint) : endpoint;
      if (!loc || await loc.count() !== 1) throw new Error('dragTo endpoints must match exactly one element.');
      rect = await loc.evaluate(inspect, scroll);
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('dragTo needs a nonempty finite rectangle at each endpoint.');
    }
    return rect;
  };
  let source = await read(from), target = await read(to);
  const key = state => ({ id: state.id, tag: state.tag, text: state.text });
  const sourceEndpoint = Array.isArray(from) ? { path: source.path } : from;
  const targetEndpoint = Array.isArray(to) ? { path: target.path } : to;
  let view = { left: Math.max(source.clip.left, target.clip.left), top: Math.max(source.clip.top, target.clip.top),
    right: Math.min(source.clip.right, target.clip.right), bottom: Math.min(source.clip.bottom, target.clip.bottom) };
  const visible = rect => rect.x >= view.left && rect.y >= view.top && rect.x + rect.width <= view.right && rect.y + rect.height <= view.bottom;
  if (!visible(source) || !visible(target)) {
    await read(targetEndpoint, true);
    await read(sourceEndpoint, true);
    source = await read(sourceEndpoint); target = await read(targetEndpoint);
    view = await tab.playwright.evaluate(({ source, target }) => {
      const find = key => key.path.reduce((node, index) => node?.children[index], document.documentElement);
      const a = find(source), b = find(target), root = document.scrollingElement ?? document.documentElement;
      const viewport = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
      let scroller = b.parentElement;
      while (scroller && scroller !== root && (!scroller.contains(a) ||
        !/^(auto|scroll)$/.test(window.getComputedStyle(scroller).overflowY) ||
        !(scroller.scrollHeight > scroller.clientHeight || scroller.scrollWidth > scroller.clientWidth))) scroller = scroller.parentElement;
      scroller ??= root;
      const bounds = () => {
        if (scroller === root) return viewport;
        const r = scroller.getBoundingClientRect(), x = r.x + (scroller.clientLeft ?? 0), y = r.y + (scroller.clientTop ?? 0);
        return { left: Math.max(0, x), top: Math.max(0, y), right: Math.min(viewport.right, x + scroller.clientWidth),
          bottom: Math.min(viewport.bottom, y + scroller.clientHeight) };
      };
      const visible = el => {
        const r = el.getBoundingClientRect(), v = bounds();
        return r.x >= v.left && r.y >= v.top && r.x + r.width <= v.right && r.y + r.height <= v.bottom;
      };
      if (!visible(a) || !visible(b)) {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect(), v = bounds();
        const scrollTarget = scroller === root ? window : scroller;
        scrollTarget.scrollBy({ left: (Math.min(ar.x, br.x) + Math.max(ar.x + ar.width, br.x + br.width) - v.left - v.right) / 2,
          top: (Math.min(ar.y, br.y) + Math.max(ar.y + ar.height, br.y + br.height) - v.top - v.bottom) / 2, behavior: 'instant' });
      }
      return bounds();
    }, { source, target });
    source = await read(sourceEndpoint); target = await read(targetEndpoint);
  }
  if (!source || !target) throw new Error('dragTo endpoint changed during scrolling. Nothing was pressed.');
  const start = [source.x + source.width / 2, source.y + source.height / 2];
  const end = [target.x, target.y].map((min, axis) => {
    const size = axis ? target.height : target.width, margin = Math.min(3, size / 4);
    const low = min + margin, high = min + size - margin;
    // Both the release p and the penultimate move (7p + start) / 8 must be inside.
    const lo = Math.max(low, (8 * low - start[axis]) / 7);
    const hi = Math.min(high, (8 * high - start[axis]) / 7);
    if (lo > hi) throw new Error('dragTo cannot put the last two moves inside this target. Use a shorter hop to an element in between, or scroll so both endpoints are closer. Nothing was pressed.');
    const preferred = start[axis] < low ? low : start[axis] > high ? high : (low + high) / 2;
    return Math.max(lo, Math.min(hi, preferred));
  });
  if (![view.left, view.top, view.right, view.bottom].every(Number.isFinite) ||
      [start, end].some(point => point[0] < view.left || point[0] >= view.right || point[1] < view.top || point[1] >= view.bottom)) {
    throw new Error('dragTo endpoints do not fit the viewport. Use a shorter hop to an element in between, or scroll so both endpoints are closer. Nothing was pressed.');
  }
  await tab.drag(start, end);
  let after = null, parentChanged = null, note;
  try {
    const state = await tab.playwright.evaluate(inspect, key(source));
    after = state?.index ?? null;
    if (state && state.parent !== null && source.parent !== null) parentChanged = state.parent !== source.parent;
    if (after === null) note = 'Source readback is missing or ambiguous; read the page before retrying.';
    else if (parentChanged === null) note = 'Parent identity is unverified; read the page before retrying.';
  } catch { note = 'Source readback failed; input was sent. Read the page before retrying.'; }
  return { from: start, to: end, before: source.index, after,
    indexChanged: after === null ? null : source.index !== after, parentChanged,
    moved: after === null ? null : source.index !== after || parentChanged, ...(note ? { note } : {}) };
}

export function dragToCode(code, force = false) {
  if (!force && !/\bsleight\s*\.\s*dragTo\s*\(/.test(code)) return code;
  return `globalThis.sleight ??= {}; globalThis.sleight.dragTo = (${dragTo.toString()});\n${code}`;
}
