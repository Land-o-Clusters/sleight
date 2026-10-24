import { createRequire } from 'node:module';
import { trustedRead } from './trusted-dom.mjs';
import { assertEndpointRead } from './endpoint-guard.mjs';

const require = createRequire(import.meta.url);
const CALL_MS = 1000, CLEANUP_MS = 300, SETTLE_MS = 1200, SAMPLE_MS = 80;
const PRIVATE = /checkout|payment|billing|two[\s_-]*factor|2fa|\bmfa\b|security|one[\s_-]*time|\botp\b|verification|authenticat|secret|passcode/i;
const CONTAINER = /^(BODY|MAIN|DIV|SECTION|ARTICLE|ASIDE|FORM|FIELDSET|DIALOG|TABLE|TD|UL|OL|LI|DL|DETAILS|NAV|HEADER|FOOTER)$/;
const MASK = /^(INPUT|TEXTAREA|SELECT|BUTTON|IFRAME|FRAME|OBJECT|EMBED|CANVAS|VIDEO)$/;

async function bounded(action, ms = CALL_MS) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('RECORDING_TIMEOUT')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Native snapshot bounds are document coordinates, including transforms and nested scrolling.
// Mask whole forms and sensitive containers, including their text, media and pseudo-elements.
// Snapshot strings and unmasked PNG bytes never reach disk or a tool result.
function maskRects({ strings, documents }, viewport) {
  let count = 0;
  for (const { nodes } of documents) {
    count += nodes.nodeName.length;
    if (count > 20000) throw Error('RECORDING_TREE_LIMIT');
    if (nodes.shadowRootType?.value.some(value => strings[value] !== 'user-agent')) throw Error('RECORDING_OPAQUE_TREE');
  }
  const { nodes, layout } = documents[0];
  const tags = nodes.nodeName.map(index => strings[index]), scope = new Set(), direct = new Set();
  const visible = new Set(layout.nodeIndex), visited = new Set();
  for (let i = 0; i < tags.length; i++) {
    const attrs = nodes.attributes[i] ?? [], attributes = Object.create(null);
    for (let a = 0; a < attrs.length; a += 2) attributes[strings[attrs[a]]] = strings[attrs[a + 1]];
    if (tags[i] === 'FORM') scope.add(i);
    if (MASK.test(tags[i]) || Object.hasOwn(attributes, 'contenteditable') || Object.hasOwn(attributes, 'data-sleight-private') ||
        /^(textbox|searchbox|combobox|spinbutton)$/.test(attributes.role)) direct.add(i);
    // Text and native attributes identify scope, never user authority. Include body for page-level wording.
    const wording = Object.entries(attributes).filter(([name]) => /^(id|class|role|name|title|aria-label|data-[\w-]+)$/.test(name)).map(([, value]) => value).join(' ');
    if (PRIVATE.test(wording) || nodes.nodeType[i] === 3 && visible.has(i) && PRIVATE.test(strings[nodes.nodeValue[i]])) {
      let at = i, found = false;
      while (at >= 0) {
        if (CONTAINER.test(tags[at]) && (tags[at] !== 'BODY' || !found)) { scope.add(at); found = true; }
        if (visited.has(at)) break;
        visited.add(at);
        at = nodes.parentIndex[at];
      }
    }
  }
  // A scope with display:contents has no box; its descendants still carry masks.
  const masked = new Set();
  for (let i = 0; i < tags.length; i++) if (scope.has(i) || direct.has(i) || masked.has(nodes.parentIndex[i])) masked.add(i);
  const rects = [];
  for (let i = 0; i < layout.nodeIndex.length; i++) if (masked.has(layout.nodeIndex[i])) {
    const [x, y, width, height] = layout.bounds[i];
    if (![x, y, width, height].every(Number.isFinite)) throw Error('RECORDING_GEOMETRY_UNAVAILABLE');
    if (width > 0 && height > 0) rects.push([x - viewport.pageX, y - viewport.pageY, width, height]);
  }
  return rects;
}

function viewportOf(metrics) {
  const v = metrics.cssLayoutViewport, visual = metrics.cssVisualViewport;
  if (!v || ![v.clientWidth, v.clientHeight, v.pageX, v.pageY].every(Number.isFinite) ||
      v.clientWidth <= 0 || v.clientHeight <= 0 || v.clientWidth * v.clientHeight > 16000000 ||
      v.clientWidth > 10000 || v.clientHeight > 10000 || visual && (visual.scale !== 1 || visual.pageX !== v.pageX || visual.pageY !== v.pageY))
    throw Error('RECORDING_VIEWPORT_LIMIT');
  return v;
}

function paintMasks(image, rects, viewport) {
  if (image.width !== viewport.clientWidth || image.height !== viewport.clientHeight) throw Error('RECORDING_GEOMETRY_UNAVAILABLE');
  // A row sweep paints overlapping scopes once: work is bounded by pixels plus rectangle events.
  const events = new Map(), coverage = new Int32Array(image.width + 1);
  const event = (y, left, right, delta) => {
    if (!events.has(y)) events.set(y, []);
    events.get(y).push([left, right, delta]);
  };
  for (const [x, y, width, height] of rects) {
    const left = Math.max(0, Math.floor(x) - 1), right = Math.min(image.width, Math.ceil(x + width) + 1);
    const top = Math.max(0, Math.floor(y) - 1), bottom = Math.min(image.height, Math.ceil(y + height) + 1);
    if (left < right && top < bottom) { event(top, left, right, 1); event(bottom, left, right, -1); }
  }
  for (let row = 0; row < image.height; row++) {
    for (const [left, right, delta] of events.get(row) ?? []) { coverage[left] += delta; coverage[right] -= delta; }
    let covered = 0;
    for (let col = 0; col < image.width; col++) {
      covered += coverage[col];
      if (covered > 0) {
        const at = (row * image.width + col) * 4;
        image.data[at] = image.data[at + 1] = image.data[at + 2] = 0; image.data[at + 3] = 255;
      }
    }
  }
  return image;
}

export async function captureRecordingFrame(entry, { pages, current, endpoint, sites } = {}) {
  const page = entry.page;
  const check = async () => {
    if (!current() || pages.tab(entry.tab) !== entry || page.isClosed() || entry.state.dialog || entry.state.actionPending ||
        sites?.(page.url())) throw Error('RECORDING_TARGET_UNAVAILABLE');
    if (!/^https?:\/\//.test(page.url())) throw Error('RECORDING_TARGET_UNAVAILABLE');
    await bounded(() => assertEndpointRead(page, endpoint));
    if (!current()) throw Error('RECORDING_TURN_ENDED');
  };
  await check();
  let abandoned = false, cdp, freezeAttempted = false;
  const attaching = Promise.resolve().then(() => page.context().newCDPSession(page));
  attaching.then(session => { if (abandoned) bounded(() => session.detach(), CLEANUP_MS).catch(() => {}); }, () => {});
  try { cdp = await bounded(() => attaching); } catch (error) { abandoned = true; throw error; }
  const send = (method, params) => bounded(() => cdp.send(method, params));
  const geometry = async () => {
    const viewport = viewportOf(await send('Page.getLayoutMetrics'));
    const capture = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    return { viewport, rects: maskRects(capture, viewport) };
  };
  try {
    await check();
    // A timed-out acknowledgment can still mean scripts were disabled. Always attempt the resume.
    freezeAttempted = true;
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    // Compositor scrolling continues with scripts disabled. Compare scroll and boxes before and after pixels.
    const deadline = performance.now() + SETTLE_MS;
    let before = await geometry();
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, SAMPLE_MS));
      await check();
      const after = await geometry();
      if (JSON.stringify(before) === JSON.stringify(after)) { before = after; break; }
      if (performance.now() >= deadline) throw Error('RECORDING_SCROLL_UNSETTLED');
      before = after;
    }
    let document;
    try {
      document = await bounded(() => page.locator(':root').elementHandle({ timeout: CALL_MS }));
      if (!document || await bounded(() => trustedRead(document, (el, unused, read) =>
        Document.prototype.getAnimations.call(read(el, 'ownerDocument')).some(a => a.playState === 'running')))) throw Error('RECORDING_MOTION_UNAVAILABLE');
    } finally { if (document) await bounded(() => document.dispose(), CLEANUP_MS); }
    await check();
    // Raw pixels stay in memory. Masks painted here cannot drift as page overlays can.
    const png = await bounded(() => page.screenshot({ type: 'png', fullPage: false, scale: 'css', caret: 'hide', timeout: 1500 }), 1700);
    await check();
    if (JSON.stringify(before) !== JSON.stringify(await geometry())) throw Error('RECORDING_SCROLL_UNSETTLED');
    if (png.length > 8 * 1024 * 1024) throw Error('RECORDING_IMAGE_LIMIT');
    const { PNG } = require('../../vendor/playwright-core/lib/utilsBundle.js');
    const start = performance.now();
    const image = paintMasks(PNG.sync.read(png, { checkCRC: true }), before.rects, before.viewport);
    image.decodeMaskMs = performance.now() - start;
    return image;
  } finally {
    // Cleanup has its own short deadlines, including after timeout or Stop.
    let resumeFailed = false;
    try { if (freezeAttempted) await bounded(() => cdp.send('Emulation.setScriptExecutionDisabled', { value: false }), CLEANUP_MS); }
    catch { resumeFailed = !page.isClosed(); }
    try { await bounded(() => cdp.detach(), CLEANUP_MS); }
    finally { if (resumeFailed) throw Error('RECORDING_RESUME_UNCONFIRMED'); }
  }
}
