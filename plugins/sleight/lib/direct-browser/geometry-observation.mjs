// Private native layout observations. Nothing in this bank is returned in a
// snapshot, cursor event or worker message. A CDP capture describes its instant;
// it supplies no permission to draw after that instant.
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const layoutRequests = new AsyncLocalStorage();
export const withBrowserLayoutRequest = (page, request, read) => layoutRequests.run({ page, request }, read);
export const browserLayoutRequest = observation => observations.get(observation)?.request;

const pages = new WeakMap(), batches = new WeakMap(), observations = new WeakMap(), heldNodes = new WeakMap(), nativeReads = new WeakMap();
const MAX_NODES = 50000, MAX_STRINGS = 200000, MAX_TEXT = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = values => Array.isArray(values) && values.every(Number.isFinite);
const rect = value => finite(value) && value.length === 4 && value[2] > 0 && value[3] > 0;
const impl = item => item?._connection?.toImpl?.(item);
const union = (a, b) => {
  if (!a) return b?.slice();
  if (!b) return a.slice();
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};
function stateOf(page) {
  let state = pages.get(page);
  if (state) return state;
  state = { epoch: 0, serial: 0, latest: undefined, listeners: new Set() };
  pages.set(page, state);
  const invalidate = () => { state.epoch++; state.latest = undefined; };
  for (const event of ['framenavigated', 'frameattached', 'framedetached', 'close']) page.on(event, invalidate);
  return state;
}
function scopeOf(page) {
  const target = impl(page), frames = page.frames?.();
  if (!target?.delegate?._targetId || !page._connection || !frames?.length || frames.length > 32 || page.isClosed?.()) return;
  return { connection: page._connection, target, frames: frames.map(frame => ({ frame, impl: impl(frame) })) };
}
function current(batch) {
  const { page, state, epoch, scope } = batch;
  const now = scopeOf(page);
  return !batch.failed && state.epoch === epoch && now?.connection === scope.connection && now.target === scope.target &&
    now.frames.length === scope.frames.length && now.frames.every((row, i) => row.frame === scope.frames[i].frame &&
      row.impl === scope.frames[i].impl && !row.frame.isDetached?.());
}

export function beginBrowserLayout(page) {
  const state = pages.get(page);
  if (!state?.listeners.size) return;
  const scope = scopeOf(page);
  if (!scope) { state.latest = undefined; return; }
  const ticket = Object.freeze({});
  const request = layoutRequests.getStore();
  batches.set(ticket, { page, request: request?.page === page ? request.request : undefined, state, epoch: state.epoch, serial: ++state.serial, scope, captures: [], failed: false });
  return ticket;
}

// Copy bounded native metadata before rendering text. Semantic hashes include
// subtree identities and values, plus ancestor attributes. They only veto joins.
function project(capture) {
  const { strings, documents } = capture;
  if (!Array.isArray(strings) || strings.length > MAX_STRINGS || !Array.isArray(documents) || !documents.length || documents.length > 32) return;
  let text = 0, count = 0, attributeEntries = 0;
  for (const value of strings) if (typeof value !== 'string' || (text += Buffer.byteLength(value)) > MAX_TEXT) return;
  const result = [];
  for (const doc of documents) {
    const n = doc.nodes, l = doc.layout, size = n?.nodeType?.length;
    if (!size || (count += size) > MAX_NODES || !l || !Array.isArray(l.nodeIndex) || l.nodeIndex.length > MAX_NODES ||
        !['backendNodeId', 'parentIndex', 'nodeName', 'nodeValue', 'attributes'].every(key => n[key]?.length === size) ||
        !Number.isFinite(doc.scrollOffsetX) || !Number.isFinite(doc.scrollOffsetY)) return;
    const values = new Map();
    for (const key of ['inputValue', 'textValue', 'inputChecked', 'optionSelected']) {
      const field = n[key];
      if ((field?.index?.length ?? 0) > size) return;
      for (const [i, index] of (field?.index ?? []).entries()) {
        if (!Number.isInteger(index) || index < 0 || index >= size) return;
        const value = field.value ? field.value[i] : true;
        if (!values.has(index)) values.set(index, []);
        values.get(index).push([key, typeof value === 'boolean' ? value : strings[value]]);
      }
    }
    const rows = [], byId = new Map();
    for (let i = 0; i < size; i++) {
      const id = n.backendNodeId[i], parent = n.parentIndex[i], attrs = n.attributes[i];
      if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id) || !Number.isInteger(parent) || parent >= i || parent < -1 ||
          !Array.isArray(attrs) || attrs.length > 4096 || attrs.length % 2 ||
          ![n.nodeName[i], ...attrs].every(index => Number.isInteger(index) && typeof strings[index] === 'string') ||
          n.nodeValue[i] !== -1 && typeof strings[n.nodeValue[i]] !== 'string') return;
      if ((attributeEntries += attrs.length) > 250000) return;
      const depth = parent < 0 ? 0 : rows[parent].depth + 1;
      if (depth > 128) return;
      const attributes = attrs.map(index => strings[index]);
      const context = hash([n.nodeType[i], strings[n.nodeName[i]], attributes, parent < 0 ? null : rows[parent].context]);
      const row = { id, parent, depth, context, children: [], paint: undefined,
        own: [n.nodeType[i], strings[n.nodeName[i]], strings[n.nodeValue[i]] ?? '', attributes, values.get(i) ?? []] };
      rows.push(row); byId.set(id, row);
      if (parent >= 0) rows[parent].children.push(i);
    }
    for (let i = 0; i < l.nodeIndex.length; i++) {
      const row = rows[l.nodeIndex[i]], box = l.bounds?.[i];
      if (!row || !finite(box) || box.length !== 4 || box[2] < 0 || box[3] < 0) return;
      if (rect(box)) row.paint = union(row.paint, box);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      row.semantic = hash([row.own, row.children.map(child => [rows[child].id, rows[child].semantic])]);
      for (const child of row.children) row.paint = union(row.paint, rows[child].paint);
      delete row.own; delete row.children;
    }
    const root = rows.find((row, i) => n.nodeType[i] === 9 && row.parent === -1);
    const frameId = strings[doc.frameId];
    if (!root || typeof frameId !== 'string') return;
    result.push({ frameId, document: root.id, scroll: [doc.scrollOffsetX, doc.scrollOffsetY], byId });
  }
  return result;
}

export function recordBrowserLayout(ticket, frame, capture, start, end) {
  const batch = batches.get(ticket);
  if (!batch || !batch.state.listeners.size) return;
  try {
    if (!current(batch) || !batch.scope.frames.some(row => row.frame === frame) ||
        ![start, end].every(Number.isFinite) || start < 0 || end < start || end > performance.now() ||
        batch.captures.length >= 32 || batch.captures.some(row => row.frame === frame)) { batch.failed = true; return; }
    let native = nativeReads.get(capture);
    if (native && (native.page !== batch.page || native.frame !== frame || native.epoch !== batch.epoch ||
        native.connection !== batch.scope.connection || native.target !== batch.scope.target)) { batch.failed = true; return; }
    if (!native) {
      const documents = project(capture);
      if (!documents) { batch.failed = true; return; }
      native = { page: batch.page, frame, epoch: batch.epoch, connection: batch.scope.connection, target: batch.scope.target,
        documents, start, end };
      nativeReads.set(capture, native);
    }
    const nodes = native.documents.reduce((sum, doc) => sum + doc.byId.size, 0) +
      batch.captures.reduce((sum, row) => sum + row.documents.reduce((n, doc) => n + doc.byId.size, 0), 0);
    if (nodes > MAX_NODES) { batch.failed = true; return; }
    batch.captures.push({ frame, documents: native.documents, start: native.start, end: native.end, native });
  } catch { batch.failed = true; }
}

export function finishBrowserLayout(ticket) {
  const batch = batches.get(ticket);
  if (!batch) return;
  batches.delete(ticket);
  if (!batch.state.listeners.size || !current(batch) || batch.serial !== batch.state.serial || !batch.captures.length) { batch.state.latest = undefined; return; }
  const prior = batch.captures[0].native.observation;
  if (prior && batch.captures.every(row => row.native.observation === prior)) return prior;
  if (batch.captures.some(row => row.native.observation)) { batch.state.latest = undefined; return; }
  const observation = Object.freeze({});
  observations.set(observation, { ...batch, start: Math.min(...batch.captures.map(row => row.start)),
    end: Math.max(...batch.captures.map(row => row.end)) });
  batch.state.latest = observation;
  for (const row of batch.captures) row.native.observation = observation;
  for (const listener of batch.state.listeners) { try { listener(observation); } catch { /* collection cannot fail the read */ } }
  return observation;
}
export function cancelBrowserLayout(ticket) {
  const batch = batches.get(ticket);
  if (batch) { batch.failed = true; batch.state.latest = undefined; batches.delete(ticket); }
}
export const latestBrowserLayout = page => pages.get(page)?.latest;
export function watchBrowserLayout(page, listener) {
  const state = stateOf(page);
  if (state.listeners.size >= 1) return;
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (!state.listeners.size) { state.latest = undefined; state.serial++; }
  };
}
export function browserLayoutInterval(observation) {
  const value = observations.get(observation);
  return value && current(value) && { start: value.start, end: value.end };
}

export function retainLayoutNode(observation, identity) {
  const value = observations.get(observation);
  if (!value || !current(value) || identity?.connection !== value.scope.connection || identity.target !== value.scope.target ||
      !value.scope.frames.some(row => row.impl === identity.frame && row.impl?._id === identity.frameId)) return;
  const documents = value.captures.flatMap(row => row.documents).filter(doc => doc.frameId === identity.frameId && doc.document === identity.document);
  if (documents.length !== 1) return;
  const node = documents[0].byId.get(identity.backendNodeId);
  if (!node) return;
  const held = Object.freeze({});
  heldNodes.set(held, { ...identity, epoch: value.epoch, page: value.page, semantic: node.semantic, context: node.context,
    documentSemantic: documents[0].byId.get(documents[0].document).semantic });
  return held;
}

export function mapBrowserLayout(observation, references, evidence) {
  const value = observations.get(observation);
  if (!value || !current(value) || !Array.isArray(references) || references.length > 512) return;
  // Each frame has a separate acquisition instant. No mixed-frame map is a
  // coherent capture generation. OOPIFs and unproved frame transforms decline.
  if (value.scope.frames.length !== 1 || value.captures.length !== 1 || value.captures[0].documents.length !== 1) return;
  const doc = value.captures[0].documents[0], main = value.scope.frames[0];
  if (doc.frameId !== main.impl?._id) return;
  if (!evidence || evidence.capture !== observation || evidence.connection !== value.scope.connection || evidence.target !== value.scope.target ||
      evidence.frameId !== doc.frameId || evidence.document !== doc.document || evidence.continuous !== true ||
      !Number.isSafeInteger(evidence.pid) || evidence.pid < 1 || !Number.isSafeInteger(evidence.windowId) || evidence.windowId < 1 ||
      typeof evidence.processStart !== 'string' || !evidence.processStart || evidence.processStart.length > 128 ||
      !rect(evidence.bounds) || !rect(evidence.viewport) || !finite(evidence.origin) || evidence.origin.length !== 2 ||
      ![evidence.pageZoom, evidence.visualZoom, evidence.deviceScale, evidence.scale].every(n => Number.isFinite(n) && n > 0 && n <= 8) ||
      Math.abs(evidence.scale - evidence.pageZoom * evidence.visualZoom) > 1e-9 ||
      evidence.viewport[0] !== doc.scroll[0] || evidence.viewport[1] !== doc.scroll[1]) return;
  const { origin, scale, viewport: v, bounds: b } = evidence;
  const right = origin[0] + v[2] * scale, bottom = origin[1] + v[3] * scale;
  if (origin[0] < b[0] || origin[1] < b[1] || right > b[0] + b[2] || bottom > b[1] + b[3]) return;
  const mapped = [];
  for (const { seq, held } of references) {
    const identity = heldNodes.get(held), node = identity && doc.byId.get(identity.backendNodeId);
    if (!identity || identity.page !== value.page || identity.epoch !== value.epoch || identity.connection !== value.scope.connection ||
        identity.target !== value.scope.target || identity.frame !== main.impl || identity.frameId !== doc.frameId || identity.document !== doc.document ||
        !node || node.semantic !== identity.semantic || node.context !== identity.context ||
        doc.byId.get(doc.document).semantic !== identity.documentSemantic || !node.paint) return;
    const r = node.paint, x = Math.max(r[0], v[0]), y = Math.max(r[1], v[1]);
    const r2 = Math.min(r[0] + r[2], v[0] + v[2]), b2 = Math.min(r[1] + r[3], v[1] + v[3]);
    if (r2 <= x || b2 <= y) { mapped.push({ seq, rects: [], departed: true }); continue; }
    const sx = Math.floor(origin[0] + (x - v[0]) * scale), sy = Math.floor(origin[1] + (y - v[1]) * scale);
    const sr = Math.ceil(origin[0] + (r2 - v[0]) * scale), sb = Math.ceil(origin[1] + (b2 - v[1]) * scale);
    if (![sx, sy, sr, sb].every(n => Math.abs(n) <= 100000)) return;
    mapped.push({ seq, rects: [[sx, sy, sr - sx, sb - sy]], departed: false });
  }
  if (new Set(mapped.map(row => row.seq)).size !== mapped.length) return;
  return { pid: evidence.pid, windowId: evidence.windowId, processStart: evidence.processStart,
    semantic: doc.byId.get(doc.document).semantic, bounds: evidence.bounds.slice(), references: mapped };
}
