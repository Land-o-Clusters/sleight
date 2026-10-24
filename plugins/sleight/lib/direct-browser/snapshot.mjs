import { assertEndpointRead } from './endpoint-guard.mjs';
import { closedLocator, keyboardFocusChain } from './closed-handle.mjs';
import { trustedReadNode } from './trusted-dom.mjs';
import { readNativeEditContext, retainNativeEditContext, sameNativeEditContext } from './edit-context.mjs';
import { declaredRows, readCompleteness } from '../read-completeness.mjs';
// Compact page snapshots for turbo v3, with an independent CR1 closed-root reader.
const pages = new WeakMap();
const REF = /^(?:(?:f\d+)?e\d+|[sx]\d+)$/;
const MORE = /^more\d+_\d+$/;
export const SENSITIVE = /password|passcode|secret|one.?time|(?:^|[\W_])otp(?=$|[\W_])|\bcc[-_ ]|card|expiry|expiration|cvv|cvc|security.?code/i;
// Extra plain code/PIN hints belong to the handoff readiness check. Pending
// handoff refuses reads entirely, including any echoed code values.
const TIMEOUT = 3000;
const scalarRole = role => /^(textbox|searchbox|combobox)$/.test(role);
const normalized = value => String(value ?? '').replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
// https://www.w3.org/TR/wai-aria-1.2/#widget_roles: operable widgets and
// composites. Exclude read-only progressbar and the tabpanel content container;
// separator needs native focusability below. Chromium's AXNodeObject native
// mapping adds color/date/time and summary controls (details itself is a group):
// https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/accessibility/ax_node_object.cc
const CONTROL_ROLE = /^(button|checkbox|gridcell|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|scrollbar|searchbox|separator|slider|spinbutton|switch|tab|textbox|treeitem|combobox|grid|listbox|menu|menubar|radiogroup|tablist|tree|treegrid|ColorWell|Date|DateTime|InputTime|DisclosureTriangle|DisclosureTriangleGrouped)$/;

async function bounded(action) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Snapshot read timed out; try browser_read again.')), TIMEOUT);
    })]);
  } finally { clearTimeout(timer); }
}

function stateOf(page) {
  let state = pages.get(page);
  if (!state) {
    state = { number: 0, generation: 0, busy: false, history: new Map(), continuations: new Map(),
      closed: new Map(), shadowNumber: 0, deliveredClosed: new Set(), rawRefs: new Map(), usedRefs: new Set(),
      refBank: new Map(), deliveredRefs: new Set(), pending: new Map(), nextRef: 0, listed: null,
      keyboard: new Map(), keyboardNumber: 0, keyboardEpoch: 0, deliveredKeyboard: new Set(), keyboardPending: new Set(), keyboardTasks: new Set() };
    pages.set(page, state);
    if (typeof page.locator === 'function') {
      Object.defineProperty(page, 'getByRef', { configurable: true, value(ref) {
        assertKeyboardSettled(state);
        if (/^x\d+$/.test(ref)) {
          keyboardRefBinding(page, ref);
          return closedLocator(() => keyboardRefBinding(page, ref));
        }
        if (/^s\d+$/.test(ref)) {
          // A closed-root control resolves from its CDP backend node on every use, never through a page-side query.
          closedRefBinding(page, ref);
          return closedLocator(() => closedRefBinding(page, ref));
        }
        return snapshotRefBinding(page, ref);
      } });
    }
    page.on('framenavigated', () => forget(state));
    page.on('framedetached', () => retireKeyboard(state));
    page.on('close', () => forget(state));
  }
  return state;
}
// A new generation: every ref, continuation and diff baseline of the old document is retired.
function forget(state) {
  retireKeyboard(state);
  state.generation++; state.listed = null; state.rawRefs.clear(); state.deliveredRefs.clear(); state.pending.clear(); state.history.clear(); state.continuations.clear(); state.closed.clear(); state.deliveredClosed.clear();
}
function disposeContext(context) { try { Promise.resolve(context.dispose()).catch(() => {}); } catch { /* detached context */ } }
function assertKeyboardSettled(state) {
  if (state?.busy || state?.keyboardTasks.size) throw Error('Snapshot acquisition is still pending; wait before another action or read.');
}
function retireKeyboard(state) {
  state.keyboardEpoch++;
  const contexts = new Set([...state.keyboard.values()].map(record => record.context));
  for (const context of state.keyboardPending) contexts.add(context);
  state.keyboard.clear(); state.deliveredKeyboard.clear(); state.keyboardPending.clear();
  for (const context of contexts) disposeContext(context);
}

// A utility-world native getter identifies the exact active node; neither MAIN properties nor labels locate it.
function nativeActiveElement() { return Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get.call(document); }
function activeNativeNode(el, unused, read) {
  return read(el, 'isConnected') === true && read(read(el, 'ownerDocument'), 'activeElement') === el;
}
const retainedExpression = '([el]) => { return (' + retainNativeEditContext.toString() + ')(el); ' +
  (retainNativeEditContext.helpers ?? []).map(helper => helper.toString()).join(' ') + ' }';

async function keyboardEditors(page, state, generation, epoch) {
  const records = new Map(), children = [], previous = new Map(state.keyboard);
  const previousContexts = new Set([...previous.values()].map(record => record.context));
  const current = () => {
    if (state.generation !== generation || state.keyboardEpoch !== epoch || page.isClosed?.()) throw Error('keyboard acquisition changed');
  };
  try {
    const frames = page.frames();
    if (frames.length > 32) throw Error('keyboard frame budget exceeded');
    for (const frame of frames) {
      current();
      // Non in-process callers get no capability. Existing ordinary and closed refs keep their own paths.
      const frameImpl = frame?._connection?.toImpl?.(frame);
      if (!frameImpl) continue;
      if (frameImpl._page?.delegate?.noUtilityWorld?.() || frame.isDetached?.()) throw Error('keyboard utility unavailable');
      const utility = await frameImpl.utilityContext(); current();
      if (utility?.world !== 'utility' || typeof utility.evaluateExpressionHandle !== 'function') throw Error('keyboard utility unavailable');
      let active, context, kept = false, borrowed = false;
      try {
        const handle = await utility.evaluateExpressionHandle(nativeActiveElement.toString(), { isFunction: true });
        active = handle.asElement?.();
        if (!active) { await handle.dispose(); current(); continue; }
        current();
        if (active._frame !== frameImpl || typeof active._objectId !== 'string') throw Error('keyboard active identity unavailable');
        const evidence = await trustedReadNode(active, readNativeEditContext); current();
        if (evidence?.native !== true || evidence.eligible !== true || evidence.zeroArea !== true || !['textbox', 'searchbox'].includes(evidence.role)) continue;
        if (await trustedReadNode(active, activeNativeNode) !== true) continue;
        current();
        const session = frameImpl._page.delegate._sessionForFrame(frameImpl);
        const described = await session._client._sendMayFail('DOM.describeNode', { objectId: active._objectId }); current();
        const backendNodeId = described?.node?.backendNodeId;
        if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) throw Error('keyboard backend identity unavailable');
        if ((described.node.shadowRoots?.length ?? 0) > 0 || await trustedReadNode(active, keyboardFocusChain) !== true) continue;
        current();
        const ax = await session._client._sendMayFail('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }); current();
        if (!Array.isArray(ax?.nodes)) throw Error('keyboard AX identity unavailable');
        const node = ax?.nodes?.find(row => row.backendDOMNodeId === backendNodeId && row.ignored === false && row.role?.value === evidence.role);
        if (!node || node.properties?.some(property => ['disabled', 'readonly', 'hidden'].includes(property.name) && property.value?.value === true)) continue;
        const prior = [...previous].find(([, record]) => record.frame === frame && record.backendNodeId === backendNodeId && record.generation === generation);
        if (prior && await trustedReadNode(active, sameNativeEditContext, prior[1].context) === true) {
          current(); context = prior[1].context; borrowed = true;
        } else {
          current();
          context = await utility.evaluateExpressionHandle(retainedExpression, { isFunction: true }, [active]);
          state.keyboardPending.add(context); current();
        }
        if (await trustedReadNode(active, sameNativeEditContext, context) !== true || await trustedReadNode(active, keyboardFocusChain) !== true) continue;
        current();
        const ref = borrowed ? prior[0] : 'x' + (++state.keyboardNumber);
        const record = borrowed ? prior[1] : { frame, backendNodeId, generation, context, keyboardOnly: true, deliveryEpoch: 0 };
        records.set(ref, record); kept = true;
        children.push({ role: evidence.role, name: node.name?.value ?? '', ref, active: true, keyboardOnly: true, protected: true });
      } finally {
        if (active) await active.dispose();
        if (context && !kept && !borrowed) { state.keyboardPending.delete(context); disposeContext(context); }
      }
    }
    current();
    const after = page.frames();
    if ([...records.values()].some(({ frame }) => !after.includes(frame) || frame.isDetached?.())) throw Error('keyboard frames changed');
    return { records, sections: children.length ? [{ role: 'group', name: 'Keyboard-only editor controls', children }] : [] };
  } catch (error) {
    for (const { context } of records.values()) if (!previousContexts.has(context)) { state.keyboardPending.delete(context); disposeContext(context); }
    throw error;
  }
}

export function keyboardRefBinding(page, ref) {
  const state = pages.get(page), record = state?.keyboard.get(ref);
  assertKeyboardSettled(state);
  if (!record || record.generation !== state.generation || !state.deliveredKeyboard.has(ref) || record.frame.isDetached?.())
    throw Error('Keyboard-only ref is stale or its snapshot was not delivered; use browser_read again.');
  return { ...record,
    current: () => state.keyboard.get(ref) === record && state.generation === record.generation && state.deliveredKeyboard.has(ref) &&
      !state.busy && !state.keyboardTasks.size && !page.isClosed?.() && !record.frame.isDetached?.() && page.frames().includes(record.frame),
    retire: () => { if (state.keyboard.get(ref) === record) { state.keyboardEpoch++; state.keyboard.delete(ref); state.deliveredKeyboard.delete(ref); disposeContext(record.context); } },
  };
}
// For a page that reuses its elements without navigating (a virtual list recycles rows on scroll, EPV3-5):
// old refs then refuse with the browser_read hint, and the next read mints new ones. A page never read has none.
export function invalidateRefs(page) {
  const state = pages.get(page);
  if (state) forget(state);
}
export const snapshotAcquisitionPending = page => Boolean(pages.get(page)?.keyboardTasks.size);

// Native CDP values and attributes cannot be hidden by MAIN-world getters.
function sensitiveValues({ strings, documents }) {
  const values = []; values.names = new Set(); values.unnamed = false; values.protectedFields = false;
  for (const { nodes } of documents) {
    const count = nodes.nodeName.length;
    if (count > 50000) throw Error('DOM acquisition budget exceeded');
    const attrs = index => {
      const raw = nodes.attributes[index] ?? [], result = {};
      for (let i = 0; i < raw.length; i += 2) result[strings[raw[i]]] = strings[raw[i + 1]];
      return result;
    };
    const labels = new Map(), labelFor = new Map();
    for (let i = 0; i < count; i++) if (strings[nodes.nodeName[i]] === 'LABEL') labels.set(i, '');
    for (let i = 0; i < count; i++) {
      let parent = i, depth = 0;
      while (parent >= 0) {
        if (++depth > 128) throw Error('DOM ancestry budget exceeded');
        if (labels.has(parent)) labels.set(parent, labels.get(parent) + ' ' + (strings[nodes.nodeValue[i]] ?? ''));
        parent = nodes.parentIndex[parent];
      }
    }
    for (const [index, text] of labels) if (attrs(index).for) labelFor.set(attrs(index).for, text);
    const shadows = new Map((nodes.shadowRootType?.index ?? []).map((index, i) => [index, strings[nodes.shadowRootType.value[i]]]));
    const protectedNodes = new Set();
    for (let index = 0; index < count; index++) {
      const attributes = attrs(index), hints = [attributes.type, attributes.name, attributes.id, attributes.autocomplete,
        attributes['aria-label'], attributes['aria-labelledby'], attributes.placeholder, labelFor.get(attributes.id)];
      let closed = false, parent = index;
      const ownLabels = [];
      while (parent >= 0) {
        closed ||= shadows.get(parent) === 'closed';
        if (labels.has(parent)) { hints.push(labels.get(parent)); ownLabels.push(labels.get(parent)); }
        parent = nodes.parentIndex[parent];
      }
      if (closed || SENSITIVE.test(hints.join(' '))) protectedNodes.add(index);
      if (protectedNodes.has(index) && (/^(INPUT|TEXTAREA|SELECT)$/.test(strings[nodes.nodeName[index]])
        || /^(textbox|searchbox|combobox|spinbutton)$/.test(attributes.role ?? '')
        || Object.hasOwn(attributes, 'contenteditable') && /^(|true|plaintext-only)$/i.test(attributes.contenteditable))) values.protectedFields = true;
      if (strings[nodes.nodeName[index]] !== 'INPUT' && strings[nodes.nodeName[index]] !== 'TEXTAREA') continue;
      if (!protectedNodes.has(index)) continue;
      // Native attributes/label text mark password fields even with neutral
      // accessible names and blank values. Ambiguous unnamed fields mask scalars.
      const names = [attributes['aria-label'], labelFor.get(attributes.id), ...ownLabels, attributes.placeholder].map(normalized).filter(Boolean);
      for (const name of names) values.names.add(name);
      if (!names.length) values.unnamed = true;
    }
    for (const column of [nodes.inputValue, nodes.textValue]) {
      for (const [i, index] of (column?.index ?? []).entries()) {
        const value = strings[column.value[i]];
        // A checkbox's "on" is a label, not a secret, and as a scrub term it would blank every "on" in the page.
        const label = strings[nodes.nodeName[index]] === 'INPUT' && /^(checkbox|radio|button|submit|reset|image)$/i.test(attrs(index).type ?? '');
        if (value && protectedNodes.has(index) && !label) values.push(value);
      }
    }
  }
  return values;
}

// Pixels cannot be text-redacted. Conservatively refuse even hidden/offscreen
// protected fields, which may have visible echoes or be revealed by CSS alone.
export const screenshotHasProtectedFields = capture => sensitiveValues(capture).protectedFields;

// The field's own row is replaced whole (rowsOf), so this only removes echoes of a secret elsewhere.
// 1-3 characters: nothing, since a match cannot be told from page text ("o" is in "Account controls").
// 4-7 letters of a spaced script (a likely word, "test" is inside "latest"): whole tokens only.
// Anything else (digits, symbols, 8+ letters, CJK and other unspaced scripts): wherever it appears.
const SHORT_SECRET = 4, WORD_SECRET = 8;
const SPACED_LETTERS = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}]+$/u;
const escapeRegExp = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
export function scrub(value, secrets) {
  let text = String(value ?? '');
  const forms = [...new Set(secrets.flatMap(secret => [secret, normalized(secret)]).filter(Boolean))]
    .map(secret => ({ secret, size: Array.from(secret).length })).filter(({ size }) => size >= SHORT_SECRET)
    .sort((a, b) => b.size - a.size || b.secret.length - a.secret.length);
  for (const { secret, size } of forms) {
    if (size < WORD_SECRET && SPACED_LETTERS.test(secret)) {
      text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escapeRegExp(secret)}(?![\\p{L}\\p{N}\\p{M}])`, 'gu'), '[redacted]');
    } else text = text.split(secret).join('[redacted]');
  }
  return text.replace(/(?:\d[ -]?){12,19}/g, '[redacted]');
}

// Each owned frame session has one native capture. In-process children are
// already included in their parent's capture and pierced DOM document.
async function sessionsOf(page, read) {
  const frames = page.frames(), results = new Array(frames.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < frames.length) {
      const index = cursor++, frame = frames[index];
      let session;
      try { session = await bounded(() => page.context().newCDPSession(frame)); }
      catch (error) {
        if (frame !== page.mainFrame() && /This frame does not have a separate CDP session, it is a part of the parent frame's session/.test(error.message)) continue;
        throw error;
      }
      try { results[index] = await read({ frame, send: (method, params = {}) => bounded(() => session.send(method, params)) }); }
      finally { await bounded(() => session.detach()); }
    }
  };
  // Drain all workers even on failure so their sessions are detached before
  // another snapshot can start. Result order is frame order, not reply order.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, frames.length) }, worker));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.filter(Boolean);
}

// Structured exports use the same native secret discovery and scrub policy as snapshots.
export async function readSnapshotSecrets(page) {
  const results = await sessionsOf(page, async ({ send }) => {
    const capture = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    return { secrets: sensitiveValues(capture), closed: capture.documents.some(({ nodes }) =>
      (nodes.shadowRootType?.value ?? []).some(value => capture.strings[value] === 'closed')) };
  });
  const secrets = results.flatMap(result => result.secrets);
  secrets.hasClosed = results.some(result => result.closed);
  return secrets;
}

function closedCandidates({ strings, documents }) {
  const controls = new Set();
  let hasClosed = false, count = 0;
  for (const { nodes } of documents) {
    count += nodes.nodeName.length;
    if (count > 50000) throw Error('DOM acquisition budget exceeded');
    const roots = new Set((nodes.shadowRootType?.index ?? []).filter((_, i) => strings[nodes.shadowRootType.value[i]] === 'closed'));
    hasClosed ||= roots.size > 0;
    const closed = [];
    for (let index = 0; index < nodes.nodeName.length; index++) {
      closed[index] = roots.has(index) || closed[nodes.parentIndex[index]] === true;
      if (!closed[index] || nodes.nodeType[index] !== 1 || !nodes.backendNodeId[index]) continue;
      const attributes = {}, raw = nodes.attributes[index] ?? [];
      for (let i = 0; i < raw.length; i += 2) attributes[strings[raw[i]]] = strings[raw[i + 1]];
      const tag = strings[nodes.nodeName[index]];
      if (tag === 'OPTION') continue;
      const native = /^(BUTTON|TEXTAREA|SELECT|SUMMARY)$/.test(tag)
        || tag === 'INPUT' && attributes.type?.toLowerCase() !== 'hidden'
        || /^(A|AREA)$/.test(tag) && Object.hasOwn(attributes, 'href')
        || Object.hasOwn(attributes, 'contenteditable') && /^(|true|plaintext-only)$/i.test(attributes.contenteditable);
      if (native || Object.hasOwn(attributes, 'role')) controls.add(nodes.backendNodeId[index]);
    }
  }
  return { hasClosed, controls };
}

async function closedRoots(page, state, completeness) {
  const results = await sessionsOf(page, async ({ frame, send }) => {
    const capture = await send('DOMSnapshot.captureSnapshot', { computedStyles: completeness ? ['overflow-x', 'overflow-y'] : [] });
    const secrets = sensitiveValues(capture), { hasClosed, controls } = closedCandidates(capture);
    const children = [], refs = new Map();
    if (hasClosed) {
      // Enable the DOM agent only when native data proves a closed root exists.
      // This also makes backend nodes available to per-control AX probes.
      await send('DOM.getDocument', { depth: -1, pierce: true });
      let probes = 0;
      for (const backendNodeId of controls) {
        if (probes++ === 512) break;
        const { nodes } = await send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
        const node = nodes.find(node => node.backendDOMNodeId === backendNodeId && !node.ignored && CONTROL_ROLE.test(node.role?.value)
          && (node.role.value !== 'separator' || node.properties?.some(property => property.name === 'focusable' && property.value?.value === true)));
        if (!node) continue;
        const role = node.role.value, ref = state.closed.get(frame)?.get(backendNodeId) ?? 's' + (++state.shadowNumber);
        const row = { role, name: node.name?.value ?? '', ref, protected: scalarRole(role) };
        for (const { name, value } of node.properties ?? []) {
          if (!['checked', 'disabled', 'expanded', 'pressed', 'selected'].includes(name)) continue;
          if (value?.value === true || value?.value === 'true') row[name] = true;
          else if (value?.value === 'mixed') row[name] = 'mixed';
        }
        refs.set(backendNodeId, ref); children.push(row);
      }
    }
    if (controls.size > 512) children.push({ role: 'note', name: (controls.size - 512) + ' closed shadow candidates omitted (512 candidate limit)' });
    // The page's visible size, for the offscreen markers; the main frame's session already exists.
    let viewport = null;
    if (frame === page.mainFrame()) {
      try {
        const { cssLayoutViewport: v } = await send('Page.getLayoutMetrics');
        if (v?.clientWidth > 0 && v?.clientHeight > 0) viewport = { width: v.clientWidth, height: v.clientHeight };
      } catch { /* no markers without a size */ }
    }
    const documents = capture.documents.map(doc => [capture.strings[doc.frameId], {
      base: capture.strings[doc.baseURL], url: capture.strings[doc.documentURL],
    }]);
    return { frame, secrets, refs, children, viewport, documents, hasClosed, completeness: completeness ? declaredRows(capture, { viewport }) : { omitted: 0, unknown: false }, limited: controls.size > 512 };
  });
  const sections = [], secrets = [], next = new Map();
  secrets.names = new Set(); secrets.unnamed = false;
  for (const result of results) {
    secrets.push(...result.secrets);
    for (const name of result.secrets.names) secrets.names.add(name);
    secrets.unnamed ||= result.secrets.unnamed;
    if (result.refs.size) next.set(result.frame, result.refs);
    if (result.children.length) sections.push({ role: 'group', name: 'Closed shadow controls', children: result.children });
  }
  const current = new Set([...next.values()].flatMap(refs => [...refs.values()]));
  for (const ref of state.deliveredClosed) if (!current.has(ref)) state.deliveredClosed.delete(ref);
  state.closed = next;
  const documents = new Map(results.flatMap(result => result.documents)), bases = new Map();
  for (const frame of page.frames()) {
    const impl = frame?._connection?.toImpl?.(frame), doc = documents.get(impl?._id);
    if (impl && doc && typeof doc.base === 'string' && typeof doc.url === 'string') bases.set(frame === page.mainFrame() ? '' : 'f' + impl.seq, doc);
  }
  return { sections, secrets, bases, viewport: results.find(result => result.viewport)?.viewport ?? null,
    completeness: { omitted: results.reduce((n, r) => n + r.completeness.omitted, 0),
      unknown: results.some(r => r.completeness.unknown || r.limited),
      renderedUnknown: results.some(r => r.completeness.renderedUnknown), closed: results.some(r => r.hasClosed) } };
}

// V4/V5 can resolve an s ref into an owned frame's CDP backend node. Only refs
// actually returned in a snapshot are eligible; caller owns its CDP session.
export function closedRefBinding(page, ref) {
  const state = pages.get(page);
  assertKeyboardSettled(state);
  if (state?.deliveredClosed.has(ref)) {
    for (const [frame, refs] of state.closed) for (const [backendNodeId, known] of refs) {
      if (known === ref) return { frame, backendNodeId };
    }
  }
  throw Error('Closed-root ref is stale or unavailable; take a new snapshot.');
}

// Public refs remain distinct across document generations. Playwright may reuse
// eN after navigation; the private map retains its actual aria-ref for resolution.
function publicRefs(nodes, state) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const raw = node.ref;
    if (REF.test(raw) && !/^[sx]\d+$/.test(raw)) {
      let ref = state.rawRefs.get(raw);
      if (!ref) {
        ref = raw;
        const match = /e(\d+)$/.exec(raw); state.nextRef = Math.max(state.nextRef, Number(match[1]));
        while (state.usedRefs.has(ref)) ref = 'e' + (++state.nextRef);
        state.usedRefs.add(ref); state.rawRefs.set(raw, ref);
        state.refBank.set(ref, { raw, generation: state.generation });
      }
      node.ref = ref;
    }
    if (node.children) publicRefs(node.children, state);
  }
}

// The worker calls this only after the exact snapshot text reaches the client.
// A private read or an observation suppressed by observe:none does not qualify.
export function acknowledgeSnapshot(page, number) {
  const state = pages.get(page), record = state?.pending.get(number);
  if (!record || record.generation !== state.generation) return false;
  state.pending.delete(number);
  for (const ref of record.refs) {
    if (/^x\d+$/.test(ref)) {
      const current = state.keyboard.get(ref), printed = record.keyboard?.get(ref);
      if (current && printed?.record === current && printed.epoch === current.deliveryEpoch) state.deliveredKeyboard.add(ref);
    }
    else if (!/^s\d+$/.test(ref)) state.deliveredRefs.add(ref);
  }
  return true;
}
export function snapshotRefBinding(page, ref) {
  const state = pages.get(page), record = state?.refBank.get(ref);
  assertKeyboardSettled(state);
  if (!record || record.generation !== state.generation || !state.deliveredRefs.has(ref))
    throw Error('Ref is stale or its snapshot was not delivered; use browser_read again.');
  // Playwright resolves aria-ref only against the latest read of the ref's frame, whoever took it, and never reuses a ref
  // in a document. A read the model saw in part (find, observe:none) can retire a held ref whose role or name changed,
  // which then resolves to nothing; refuse it now rather than wait out the locator.
  const frame = /^(?:f\d+)?/.exec(record.raw)[0];
  if (state.listed?.frames.has(frame) && !state.listed.refs.has(record.raw))
    throw Error('Ref changed on the page since it was read; use browser_read again.');
  return page.locator('aria-ref=' + record.raw);
}
// The raw refs one read listed, and the frames it listed any for (the main frame always). Each listed frame's map moved.
function listedRefs(tree) {
  const refs = new Set(), frames = new Set(['']);
  const visit = nodes => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (REF.test(node.ref) && !/^[sx]\d+$/.test(node.ref)) { refs.add(node.ref); frames.add(/^(?:f\d+)?/.exec(node.ref)[0]); }
      if (Array.isArray(node.children)) visit(node.children);
    }
  };
  visit(Array.isArray(tree) ? tree : []);
  return { refs, frames };
}

// A ref's box is relative to the viewport, so it says whether the element is in view without scrolling.
// Frame refs (f2e1) are boxed inside their own frame, and a box with no area says nothing.
function placement(node, ref, viewport) {
  const box = node.box;
  if (!viewport || !ref || /^f\d/.test(ref) || !box || !(box.width > 0 && box.height > 0)) return '';
  if (box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= viewport.width || box.y >= viewport.height) return ' [offscreen]';
  return box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height ? ' [partly offscreen]' : '';
}

function rowsOf(tree, secrets, viewport) {
  const rows = [];
  const visit = (nodes, parent = null, depth = 0) => {
    let previous = null;
    for (const [index, raw] of nodes.entries()) {
      const node = typeof raw === 'string' ? { role: 'text', text: raw } : raw;
      const ref = REF.test(node.ref) ? node.ref : null;
      const role = /^[a-zA-Z][\w-]*$/.test(node.role) ? node.role : 'group';
      const namedSensitive = node.protected === true || secrets.names?.has(normalized(node.name)) || SENSITIVE.test([node.name, node.placeholder].join(' '));
      // A number field (a CVV, a PIN) shows its value in its own row, which scrub no longer removes for a short secret.
      const protectedValue = scalarRole(role) && (namedSensitive || secrets.unnamed) || role === 'spinbutton' && node.text !== undefined && namedSensitive;
      let line = '- ' + role;
      if (node.name) line += ' ' + JSON.stringify(scrub(node.name, secrets));
      for (const flag of ['checked', 'disabled', 'expanded', 'active', 'pressed', 'selected', 'invalid', 'level']) {
        if (node[flag]) line += ` [${flag}${node[flag] === true ? '' : '=' + JSON.stringify(node[flag])}]`;
      }
      if (node.keyboardOnly === true && /^x\d+$/.test(ref)) line += ' [keyboard-only]';
      if (ref) line += ` [ref=${ref}]` + placement(node, ref, viewport);
      if (protectedValue) line += ': "[redacted]"';
      else if (node.text !== undefined) line += ': ' + JSON.stringify(scrub(node.text, secrets));
      else if (node.children?.length) line += ':';
      // Non-ref text rows are keyed by parent and position. Refs keep their key
      // through value changes and sibling reorders, including child-frame refs.
      const key = ref ?? `${parent ?? 'root'}/${index}`;
      rows.push({ key, ref, parent, depth, line, previous,
        ...(role === 'link' && !protectedValue && node.url ? { link: { name: scrub(node.name || node.text || '', secrets), url: scrub(node.url, secrets) } } : {}) });
      previous = key;
      if (!protectedValue && node.children) visit(node.children, key, depth + 1);
      if (!protectedValue && node.url) rows.push({ key: key + '/url', parent: key, depth: depth + 1,
        line: '- /url: ' + JSON.stringify(scrub(node.url, secrets)), ref: null });
    }
  };
  visit(tree);
  return rows;
}

function ancestors(rows, wanted) {
  const byKey = new Map(rows.map(row => [row.key, row]));
  for (const key of [...wanted]) {
    let row = byKey.get(key);
    while (row?.parent) { wanted.add(row.parent); row = byKey.get(row.parent); }
  }
  return rows.filter(row => wanted.has(row.key));
}

// Keep the snapshot's page order and redaction. Hrefs are page data, never navigation authority.
function linkRows(rows, pageURL, bases, state, secrets) {
  const seen = new Set(), links = [];
  for (const { link, ref } of rows) {
    if (!link) continue;
    const href = link.url.trim().replace(/[\t\r\n]/g, '');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    const raw = state.refBank.get(ref)?.raw ?? ref ?? '', prefix = /^(?:f\d+)?/.exec(raw)[0];
    const doc = bases.get(prefix) ?? (prefix ? null : { base: pageURL, url: pageURL });
    let identity = href;
    try {
      if (!doc) continue; // A child frame without native base evidence cannot supply a resolved URL.
      const url = new URL(href, doc.base), source = new URL(doc.url);
      if (url.hash && url.origin === source.origin && url.pathname === source.pathname && url.search === source.search) continue;
      if (url.protocol === 'javascript:') continue;
      identity = scrub(url.href, secrets);
    } catch { continue; }
    if (seen.has(identity)) continue;
    seen.add(identity);
    links.push({ key: 'link/' + identity, ref: null, parent: null, depth: 0,
      line: JSON.stringify(normalized(link.name)) + ' -> ' + JSON.stringify(identity) });
  }
  return links;
}

// A reason the caller can act on (our own text, never page content); anything else collapses to the generic message.
const hinted = text => Object.assign(Error(text), { hinted: true });
function select(rows, ref, find) {
  let selected = rows;
  if (ref) {
    if (!rows.some(row => row.ref === ref)) throw hinted(`ref ${ref} is not on the page now; read again without ref (find narrows) for fresh refs`);
    const wanted = new Set([ref]);
    for (const row of rows) if (wanted.has(row.parent)) wanted.add(row.key);
    selected = ancestors(rows, wanted);
  }
  if (find !== undefined) {
    // "a|b" matches either: 193 of 254 empty finds in the 2026-10-16 rounds were alternations a literal match never met.
    const terms = [find, ...find.split('|')].map(term => term.trim().toLowerCase()).filter(Boolean);
    const wanted = new Set(selected.filter(row => terms.some(term => row.line.toLowerCase().includes(term))).map(row => row.key));
    selected = ancestors(rows, wanted);
  }
  return selected;
}

function changes(rows, baseline) {
  const old = new Map(baseline.map(row => [row.key, row]));
  const changed = new Set(rows.filter(row => {
    const before = old.get(row.key);
    return !before || before.line !== row.line || before.parent !== row.parent || before.previous !== row.previous;
  }).map(row => row.key));
  const current = new Set(rows.map(row => row.key));
  const removed = baseline.filter(row => !current.has(row.key));
  return [...ancestors(rows, changed).map(row => ({ ...row, marker: changed.has(row.key) ? '+ ' : '  ' })),
    ...removed.map(row => ({ ...row, key: 'removed/' + row.key, parent: null, depth: 0,
      line: `# Removed from this view: ${row.ref ? '[ref=' + row.ref + ']' : 'text row'}`, marker: '- ', removed: row.key }))];
}

function cap(rows, offset, header, maxChars, continuation, completeness) {
  const footer = completeness ? '# ' + readCompleteness({ cut: maxChars, ref: continuation, ...completeness })
    : `# Cut: more rows omitted. Continue with ref="${continuation}".`;
  const lines = [header], delivered = [];
  let size = header.length, next = offset, shortenedRows = 0, shortenedAt;
  const context = offset ? ancestors(rows.filter(row => !row.removed), new Set([rows[offset]?.key])).filter(row => row.key !== rows[offset]?.key) : [];
  const keptContext = [];
  let contextSize = 0;
  for (const row of context.toReversed()) {
    const line = (row.marker ?? '') + '  '.repeat(Math.min(row.depth, 32)) + row.line;
    if (contextSize + line.length + 1 > Math.floor((maxChars - header.length - footer.length - 2) / 3)) break;
    keptContext.unshift(row); contextSize += line.length + 1;
  }
  if (keptContext.length < context.length) { lines.push('# Earlier ancestors omitted by size cap.'); size += lines.at(-1).length + 1; }
  for (const row of [...keptContext, ...rows.slice(offset)]) {
    const prefix = (row.marker ?? '') + '  '.repeat(Math.min(row.depth, 32));
    let line = prefix + row.line, shortened = false;
    const available = maxChars - size - footer.length - 2;
    if (line.length > available) {
      if (next > offset) break;
      // Keep valid YAML and any usable ref, rather than slicing a quoted name.
      const role = /^- ([\w-]+)/.exec(row.line)?.[1] ?? 'text';
      line = prefix + `- ${role}${/^x\d+$/.test(row.ref) ? ' [keyboard-only]' : ''}${row.ref ? ' [ref=' + row.ref + ']' : ''}: `
        + JSON.stringify('[line shortened; read with max_chars: 40000 or the engine browser path]');
      shortened = true;
      shortenedRows++;
      shortenedAt ??= next;
    }
    lines.push(line); size += line.length + 1;
    delivered.push(shortened ? { ...row, line: line.slice(prefix.length) } : row);
    if (!keptContext.includes(row)) next++;
    if (shortened) break;
  }
  if (next < rows.length) lines.push(footer);
  else if (completeness && shortenedRows) lines.push('# ' + readCompleteness({ cut: maxChars, ...completeness }));
  else if (completeness) lines.push('# ' + readCompleteness(completeness));
  return { text: lines.join('\n'), delivered, next, ...(completeness ? { shortenedAt } : {}) };
}

export async function snapshot(page, { ref, find, maxChars = 8000, since, links, completeness: completenessEnabled = process.env.SLEIGHT_COMPLETENESS === '1' } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 40000
    || find !== undefined && (typeof find !== 'string' || find.length > 512)
    || since !== undefined && (!Number.isSafeInteger(since) || since < 1)
    || links !== undefined && typeof links !== 'boolean'
    || ref !== undefined && (typeof ref !== 'string' || !REF.test(ref) && !MORE.test(ref))) throw Error('Invalid snapshot request');
  await assertEndpointRead(page);
  const state = stateOf(page);
  assertKeyboardSettled(state);
  if (state.busy) throw Error('Snapshot read in progress; try browser_read again.');
  state.busy = true;
  const keyboardEpoch = ++state.keyboardEpoch, generation = state.generation, url = page.url();
  try {
    const keyboardTask = keyboardEditors(page, state, generation, keyboardEpoch);
    state.keyboardTasks.add(keyboardTask);
    keyboardTask.then(() => state.keyboardTasks.delete(keyboardTask), () => state.keyboardTasks.delete(keyboardTask));
    const acquired = await Promise.allSettled([
      bounded(() => page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: TIMEOUT })), closedRoots(page, state, completenessEnabled),
      bounded(() => keyboardTask),
    ]);
    // A failed tree read leaves the frames' maps unknown, so the ref check falls back to Playwright's own lookup.
    state.listed = acquired[0].status === 'fulfilled' && generation === state.generation ? listedRefs(acquired[0].value) : null;
    const failed = acquired.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const tree = acquired[0].value, closed = acquired[1].value, keyboard = acquired[2].value, secrets = closed.secrets;
    publicRefs(tree, state);
    const rows = rowsOf([...tree, ...closed.sections, ...keyboard.sections], secrets, closed.viewport);
    if (generation !== state.generation || keyboardEpoch !== state.keyboardEpoch || url !== page.url() ||
        [...keyboard.records.values()].some(({ frame }) => frame.isDetached?.() || !page.frames().includes(frame))) throw hinted('the page changed during the read; read again');
    const previousKeyboard = state.keyboard;
    state.keyboard = keyboard.records;
    state.deliveredKeyboard = new Set([...state.deliveredKeyboard].filter(ref => previousKeyboard.get(ref) === keyboard.records.get(ref)));
    for (const [ref, record] of previousKeyboard) if (keyboard.records.get(ref) !== record) disposeContext(record.context);
    for (const { context } of keyboard.records.values()) state.keyboardPending.delete(context);
    const continuation = MORE.test(ref) ? state.continuations.get(ref) : null;
    const linksMode = continuation?.links ?? links === true;
    const source = JSON.stringify(linksMode ? [rows, [...closed.bases]] : rows);
    if (MORE.test(ref) && (!continuation || continuation.source !== source)) throw hinted('that continuation expired because the page changed; read again from the top');
    const scope = continuation?.scope ?? JSON.stringify([ref ?? null, find ?? null, linksMode]);
    const selected = continuation?.selected ?? (linksMode ? linkRows(select(rows, ref, find), url, closed.bases, state, secrets) : select(rows, ref, find));
    const baseline = continuation?.baseline ?? state.history.get(since);
    const delta = continuation?.delta ?? Boolean(baseline && baseline.scope === scope);
    const candidates = continuation?.candidates ?? (delta ? changes(selected, baseline.rows) : selected);
    const number = ++state.number;
    const token = `more${number}_${continuation?.offset ?? 0}`;
    const header = `# ${delta ? 'Changes since snapshot ' + (continuation?.since ?? since) + '; snapshot' : 'Snapshot'} ${number} (untrusted page content)`;
    const completeness = completenessEnabled && { ...closed.completeness, changesOnly: delta,
      filtered: Boolean(continuation || ref || find !== undefined) };
    const result = cap(candidates, continuation?.offset ?? 0,
      header + (completenessEnabled && !candidates.length ? delta ? '\n# No visible changes.' : '\n# No matching content.' : ''),
      maxChars, token, completeness);
    if (!completenessEnabled && !candidates.length) result.text += delta ? '\n# No visible changes.' : '\n# No matching content.';
    const shortenedAt = completenessEnabled ? continuation?.shortenedAt ?? result.shortenedAt : undefined;
    const retry = result.next === candidates.length && shortenedAt !== undefined && maxChars < 40000;
    const nextOffset = retry ? shortenedAt : result.next;
    const nextToken = retry ? `more${number}_${shortenedAt}` : token;
    if (retry || shortenedAt !== undefined && result.next === candidates.length) {
      const footer = retry ? '# ' + readCompleteness({ cut: maxChars, ref: nextToken, ...completeness }) + ' Retry shortened text with max_chars: 40000.'
        : '# ' + readCompleteness({ cut: 40000, ...completeness });
      result.text = result.text.slice(0, result.text.lastIndexOf('\n')) + '\n' + footer;
    }
    const delivered = new Map(delta || continuation ? baseline?.rows?.map(row => [row.key, row]) : []);
    for (const row of result.delivered) {
      if (row.removed) delivered.delete(row.removed);
      else delivered.set(row.key, row);
      if (/^s\d+$/.test(row.ref)) state.deliveredClosed.add(row.ref);
    }
    const history = { scope, rows: [...delivered.values()] };
    const printedKeyboard = new Set(result.delivered.filter(row => /^x\d+$/.test(row.ref) && !row.removed).map(row => row.ref));
    for (const [known, record] of state.keyboard) if (!printedKeyboard.has(known)) {
      // Keep internal native identity for an unchanged continuation, but an omitted row confers no authority.
      // A delayed ACK for an older printed slice must not restore that authority after this omission.
      record.deliveryEpoch++; state.deliveredKeyboard.delete(known);
    }
    const keyboardReceipt = new Map([...printedKeyboard].map(known => [known, { record: state.keyboard.get(known), epoch: state.keyboard.get(known)?.deliveryEpoch }]));
    state.pending.set(number, { generation, refs: result.delivered.filter(row => row.ref && !row.removed).map(row => row.ref), keyboard: keyboardReceipt });
    state.history.set(number, history);
    if (nextOffset < candidates.length) state.continuations.set(nextToken, { source, scope, selected,
      candidates, baseline: history, delta, links: linksMode, since: continuation?.since ?? since, offset: nextOffset,
      ...(!retry && shortenedAt !== undefined ? { shortenedAt } : {}) });
    if (continuation) state.continuations.delete(ref);
    for (const map of [state.history, state.continuations, state.pending]) while (map.size > 8) map.delete(map.keys().next().value);
    await assertEndpointRead(page);
    return { text: result.text, number };
  } catch (error) {
    retireKeyboard(state);
    state.deliveredClosed.clear();
    if (error.message === 'blocked: DevTools endpoint') throw error;
    throw Error(error.hinted ? 'Snapshot unavailable: ' + error.message : 'Snapshot unavailable; try browser_read again');
  } finally { state.busy = false; }
}
