import { createRequire } from 'node:module';
import { trustedRead, trustedReadNode, trustedHandleNode, trustedDocumentHandle } from './trusted-dom.mjs';
import { hostsRootEvidence } from './closed-handle.mjs';
import { assertEndpointRead } from './endpoint-guard.mjs';

const require = createRequire(import.meta.url);
const CALL_MS = 1000, CLEANUP_MS = 300, RESUME_MS = 2000, SAMPLE_MS = 80;
export const RECORDING_BLOCK = 16;

async function bounded(action, ms = CALL_MS) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('RECORDING_TIMEOUT')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function acquireHandle(action) {
  let abandoned = false;
  const pending = Promise.resolve().then(action);
  pending.then(handle => { if (abandoned && handle) bounded(() => handle.dispose(), CLEANUP_MS).catch(() => {}); }, () => {});
  try { return await bounded(() => pending); } catch (error) { abandoned = true; throw error; }
}

// This object stays in Playwright's isolated utility world. Only numeric boxes leave it.
// One query per frame, at most 2,000 elements, and a 50 ms read budget. Retain scroll
// offsets to detect compositor motion without querying or collecting field boxes again.
function frameState(el, target, read) {
  const start = performance.now(), doc = read(el, 'ownerDocument');
  const pixelRatio = read(read(doc, 'defaultView'), 'devicePixelRatio');
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 8) throw Error('RECORDING_VIEWPORT_LIMIT');
  if (read(doc, 'designMode') === 'on') return { doc, pixelRatio, allField: true, fields: [], opaque: [], nodes: [], offsets: [] };
  const nodes = Document.prototype.querySelectorAll.call(doc, '*');
  if (nodes.length > 2000 || performance.now() - start > 50) throw Error('RECORDING_TREE_LIMIT');
  return { doc, pixelRatio, target, allField: false, nodes, offsets: [] };
}
function stableState(el, state, read) {
  const start = performance.now(), doc = read(el, 'ownerDocument');
  if (doc !== state.doc || (read(doc, 'designMode') === 'on') !== state.allField) throw Error('RECORDING_SCROLL_UNSETTLED');
  if (Document.prototype.getAnimations.call(doc).some(a => a.playState === 'running')) throw Error('RECORDING_MOTION_UNAVAILABLE');
  let stable = state.offsets.length === state.nodes.length;
  const offsets = [];
  for (let i = 0; i < state.nodes.length; i++) {
    if (performance.now() - start > 50) throw Error('RECORDING_TREE_LIMIT');
    const n = state.nodes[i], x = read(n, 'scrollLeft'), y = read(n, 'scrollTop');
    if (!read(n, 'isConnected')) throw Error('RECORDING_SCROLL_UNSETTLED');
    if (state.offsets[i]?.[0] !== x || state.offsets[i]?.[1] !== y) stable = false;
    offsets.push([x, y]);
  }
  if (performance.now() - start > 50) throw Error('RECORDING_TREE_LIMIT');
  state.offsets = offsets;
  return stable;
}
// Collect boxes exactly once, after scrolling settles, using the retained list.
function fieldGeometry(el, state, read) {
  const start = performance.now(), fields = [], opaque = [];
  let opaqueControl = false;
  for (const node of state.nodes) {
    if (performance.now() - start > 50) throw Error('RECORDING_TREE_LIMIT');
    const tag = read(node, 'localName'), role = Element.prototype.getAttribute.call(node, 'role');
    const field = /^(input|textarea|select)$/.test(tag) || (read(node, 'namespaceURI') === 'http://www.w3.org/1999/xhtml' && read(node, 'isContentEditable')) ||
      /^(textbox|searchbox|combobox|spinbutton)$/.test(role) || Element.prototype.hasAttribute.call(node, 'contenteditable') ||
      Element.prototype.hasAttribute.call(node, 'data-sleight-private');
    const media = /^(iframe|frame|object|embed|canvas|img|svg|video)$/.test(tag);
    // A standard element can hide a closed shadow tree too. If such a child
    // could lie inside the clear control, black the control rather than reveal
    // fields we cannot enumerate. This requires no additional DOM protocol read.
    if (state.target && node !== state.target && Node.prototype.contains.call(state.target, node) &&
        /^(article|aside|blockquote|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(tag)) opaqueControl = true;
    // Open shadow hosts and custom elements are opaque, including their fields.
    const shadow = read(node, 'shadowRoot') || tag.includes('-');
    if (field || media || shadow) {
      const r = Element.prototype.getBoundingClientRect.call(node);
      const rect = [r.x, r.y, r.width, r.height];
      if (!rect.every(Number.isFinite)) throw Error('RECORDING_GEOMETRY_UNAVAILABLE');
      if (r.width > 0 && r.height > 0) (field || shadow ? fields : opaque).push(rect);
    }
  }
  if (performance.now() - start > 50) throw Error('RECORDING_TREE_LIMIT');
  return { pixelRatio: state.pixelRatio, allField: state.allField, fields, opaque, opaqueControl };
}
function targetState(el, unused, read) {
  if (!read(el, 'isConnected')) throw Error('RECORDING_TARGET_UNAVAILABLE');
  const doc = read(el, 'ownerDocument'), tag = read(el, 'localName');
  let black = read(doc, 'designMode') === 'on' || /^(input|textarea|select|iframe|frame|object|embed|canvas|img|svg|video)$/.test(tag) ||
    Node.prototype.getRootNode.call(el) !== doc;
  for (let node = el; node; node = read(node, 'parentElement')) {
    black ||= /^(iframe|frame|object|embed|canvas|img|svg|video)$/.test(read(node, 'localName')) || !!(read(node, 'namespaceURI') === 'http://www.w3.org/1999/xhtml' && read(node, 'isContentEditable')) || Element.prototype.hasAttribute.call(node, 'contenteditable') ||
      /^(textbox|searchbox|combobox|spinbutton)$/.test(Element.prototype.getAttribute.call(node, 'role'));
  }
  return { black };
}
function viewportOf(metrics) {
  const v = metrics.cssLayoutViewport, visual = metrics.cssVisualViewport;
  if (!v || ![v.clientWidth, v.clientHeight, v.pageX, v.pageY].every(Number.isFinite) ||
      v.clientWidth <= 0 || v.clientHeight <= 0 || v.clientWidth * v.clientHeight > 16000000 ||
      v.clientWidth > 10000 || v.clientHeight > 10000 || visual && (visual.scale !== 1 || visual.pageX !== v.pageX || visual.pageY !== v.pageY))
    throw Error('RECORDING_VIEWPORT_LIMIT');
  return v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bounds = (rect, width, height, pad = 0) => {
  const [x, y, w, h] = rect;
  return [Math.max(0, Math.floor(x) - pad), Math.max(0, Math.floor(y) - pad), Math.min(width, Math.ceil(x + w) + pad), Math.min(height, Math.ceil(y + h) + pad)];
};

// Raw pixels never reach disk. Pixelate first, restore only the pinned control,
// then black fields and opaque content that intersects that clear rectangle.
export function maskRecordingPixels(image, geometry, target, pointer) {
  const { width, height, data } = image, raw = Buffer.from(data);
  for (let y = 0; y < height; y += RECORDING_BLOCK) for (let x = 0; x < width; x += RECORDING_BLOCK) {
    const bottom = Math.min(height, y + RECORDING_BLOCK), right = Math.min(width, x + RECORDING_BLOCK);
    let r = 0, g = 0, b = 0;
    for (let row = y; row < bottom; row++) for (let col = x; col < right; col++) {
      const at = (row * width + col) * 4, alpha = raw[at + 3] / 255;
      r += raw[at] * alpha; g += raw[at + 1] * alpha; b += raw[at + 2] * alpha;
    }
    const count = (bottom - y) * (right - x);
    r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
    for (let row = y; row < bottom; row++) for (let col = x; col < right; col++) {
      const at = (row * width + col) * 4;
      data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
    }
  }
  const blackRects = [];
  const black = (rect, clip) => {
    let [left, top, right, bottom] = bounds(rect, width, height, 1);
    if (clip) { left = Math.max(left, clip[0]); top = Math.max(top, clip[1]); right = Math.min(right, clip[2]); bottom = Math.min(bottom, clip[3]); }
    if (left < right && top < bottom) blackRects.push([left, top, right, bottom]);
  };
  if (geometry.allField) black([0, 0, width, height]);
  else {
    if (target) {
      if (target.black || geometry.opaqueControl) black(target.rect);
      else {
        // Round inward: a fractional target box must not reveal neighbouring pixels.
        const [x, y, w, h] = target.rect;
        const left = Math.max(0, Math.ceil(x)), top = Math.max(0, Math.ceil(y));
        const right = Math.min(width, Math.floor(x + w)), bottom = Math.min(height, Math.floor(y + h));
        for (let row = top; left < right && row < bottom; row++) raw.copy(data, (row * width + left) * 4, (row * width + left) * 4, (row * width + right) * 4);
        for (const rect of geometry.opaque) black(rect, [left, top, right, bottom]);
      }
    }
    for (const rect of geometry.fields) black(rect);
  }
  // Union overlapping black rectangles in a row sweep. Two thousand overlapping
  // fields must cost pixels plus rectangle events, not two thousand pixel passes.
  if (blackRects.length) {
    const events = new Map(), coverage = new Int32Array(width + 1);
    const event = (y, left, right, delta) => {
      if (!events.has(y)) events.set(y, []);
      events.get(y).push([left, right, delta]);
    };
    for (const [left, top, right, bottom] of blackRects) { event(top, left, right, 1); event(bottom, left, right, -1); }
    for (let row = 0; row < height; row++) {
      for (const [left, right, delta] of events.get(row) ?? []) { coverage[left] += delta; coverage[right] -= delta; }
      let covered = 0;
      for (let col = 0; col < width; col++) {
        covered += coverage[col];
        if (covered > 0) { const at = (row * width + col) * 4; data[at] = data[at + 1] = data[at + 2] = 0; data[at + 3] = 255; }
      }
    }
  }
  const dot = (x, y, rgb) => { if (x >= 0 && x < width && y >= 0 && y < height) data.set([...rgb, 255], (y * width + x) * 4); };
  if (target) {
    const [left, top, right, bottom] = bounds(target.rect, width, height, 2);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++)
      if (x < left + 2 || x >= right - 2 || y < top + 2 || y >= bottom - 2) dot(x, y, [0, 255, 255]);
  }
  if (pointer && [pointer.x, pointer.y].every(Number.isFinite)) {
    const px = Math.round(pointer.x), py = Math.round(pointer.y);
    for (let y = 0; y < 14; y++) for (let x = 0; x <= Math.floor(y / 2); x++)
      dot(px + x, py + y, x === 0 || x === Math.floor(y / 2) || y === 13 ? [0, 0, 0] : [255, 255, 255]);
  }
  return image;
}

// A slow acknowledgment is not proof of a frozen renderer. Retry and prove that
// renderer JavaScript actually runs. The entire confirmation has a 2 s budget.
async function resumeScripts(cdp, page) {
  const deadline = performance.now() + RESUME_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = () => Math.max(1, deadline - performance.now());
    let acknowledged = false;
    try { await bounded(() => cdp.send('Emulation.setScriptExecutionDisabled', { value: false }), Math.min(500, remaining())); acknowledged = true; } catch {}
    try {
      const result = await bounded(() => cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true, timeout: Math.min(500, Math.floor(remaining())) }), Math.min(500, remaining()));
      if (acknowledged && result?.result?.value === 1 && !result.exceptionDetails) return;
    } catch {}
    if (page.isClosed()) return;
    if (performance.now() >= deadline) break;
  }
  if (!page.isClosed()) throw Error('RECORDING_RESUME_UNCONFIRMED');
}

export async function captureRecordingFrame(entry, { pages, current, endpoint, sites, target } = {}) {
  const page = entry.page;
  const check = async () => {
    if (!current() || pages.tab(entry.tab) !== entry || page.isClosed() || entry.state.dialog || entry.state.actionPending ||
        sites?.(page.url()) || !/^https?:\/\//.test(page.url())) throw Error('RECORDING_TARGET_UNAVAILABLE');
    await bounded(() => assertEndpointRead(page, endpoint));
    if (!current()) throw Error('RECORDING_TURN_ENDED');
  };
  await check();
  let abandoned = false, cdp, freezeAttempted = false, document, retained;
  const attaching = Promise.resolve().then(() => page.context().newCDPSession(page));
  attaching.then(session => { if (abandoned) bounded(() => session.detach(), CLEANUP_MS).catch(() => {}); }, () => {});
  try { cdp = await bounded(() => attaching); } catch (error) { abandoned = true; throw error; }
  const send = (method, params) => bounded(() => cdp.send(method, params));
  let classification;
  const targetGeometry = async () => {
    if (!target?.handle) return undefined;
    const handle = target.handle;
    if (classification === undefined) {
      const info = await bounded(() => trustedRead(handle, targetState));
      const frame = await bounded(() => handle.ownerFrame());
      classification = info.black || frame !== page.mainFrame() || await bounded(() => hostsRootEvidence(handle)) !== false;
    }
    const box = await bounded(() => handle.boundingBox());
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw Error('RECORDING_TARGET_UNAVAILABLE');
    return { rect: [box.x, box.y, box.width, box.height], black: classification };
  };
  try {
    await check();
    freezeAttempted = true;
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    let viewport = viewportOf(await send('Page.getLayoutMetrics'));
    document = await acquireHandle(() => trustedDocumentHandle(page));
    if (!document) throw Error('RECORDING_TARGET_UNAVAILABLE');
    const targetNode = target?.handle ? page._connection?.toImpl?.(target.handle) : undefined;
    retained = await acquireHandle(() => trustedHandleNode(document, frameState, targetNode));
    await bounded(() => trustedReadNode(document, stableState, retained));
    const deadline = performance.now() + 1200;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, SAMPLE_MS));
      await check();
      const next = viewportOf(await send('Page.getLayoutMetrics'));
      const scrollStable = await bounded(() => trustedReadNode(document, stableState, retained));
      if (same(viewport, next) && scrollStable) break;
      if (performance.now() >= deadline) throw Error('RECORDING_SCROLL_UNSETTLED');
      viewport = next;
    }
    const geometry = await bounded(() => trustedReadNode(document, fieldGeometry, retained));
    const acted = await targetGeometry();
    const stable = async () => {
      if (!same(viewport, viewportOf(await send('Page.getLayoutMetrics'))) || !same(acted, await targetGeometry())) throw Error('RECORDING_SCROLL_UNSETTLED');
      if (!await bounded(() => trustedReadNode(document, stableState, retained))) throw Error('RECORDING_SCROLL_UNSETTLED');
    };
    await check(); await stable();
    // Native capture avoids Playwright's screenshot preflight, which walks every
    // DOM node in every frame to hide carets. Fields are already black here.
    const shot = await bounded(() => cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: 1 / geometry.pixelRatio } }), 1700);
    if (typeof shot?.data !== 'string' || shot.data.length > Math.ceil(8 * 1024 * 1024 * 4 / 3)) throw Error('RECORDING_IMAGE_LIMIT');
    const png = Buffer.from(shot.data, 'base64');
    await check(); await stable();
    if (png.length > 8 * 1024 * 1024) throw Error('RECORDING_IMAGE_LIMIT');
    const { PNG } = require('../../vendor/playwright-core/lib/utilsBundle.js');
    const start = performance.now(), image = PNG.sync.read(png, { checkCRC: true });
    if (image.width !== viewport.clientWidth || image.height !== viewport.clientHeight) throw Error('RECORDING_GEOMETRY_UNAVAILABLE');
    const pointer = page._connection?.toImpl?.(page)?.mouse?._currentPoint?.();
    maskRecordingPixels(image, geometry, acted, pointer);
    image.decodeMaskMs = performance.now() - start;
    return image;
  } finally {
    let resumeFailed = false;
    try { if (freezeAttempted) await resumeScripts(cdp, page); } catch { resumeFailed = true; }
    // Resume comes first, even if the utility-world read is still pending.
    for (const handle of [retained, document]) if (handle) try { await bounded(() => handle.dispose(), CLEANUP_MS); } catch {}
    try { await bounded(() => cdp.detach(), CLEANUP_MS); }
    finally { if (resumeFailed) throw Error('RECORDING_RESUME_UNCONFIRMED'); }
  }
}
