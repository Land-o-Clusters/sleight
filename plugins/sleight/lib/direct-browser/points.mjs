import { createHash } from 'node:crypto';
import { resolveClosedHandle } from './closed-handle.mjs';
import { trustedHandle, trustedRead, trustedReadNode } from './trusted-dom.mjs';

// All coordinates are viewport CSS pixels. Native layout captures include closed
// roots, input state, frame scroll offsets and CSS geometry. Only their digest is
// retained. Utility-world epochs also retire a view after a change-and-restore.
const views = new WeakMap();
const lifetimes = new WeakMap();
const stale = () => Error('Point coordinates are stale or unavailable; use browser_read again.');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const pointInputEnabled = () => process.env.SLEIGHT_POINT_INPUT === '1';
export const hasPoint = step => step.x !== undefined || step.y !== undefined;
export function validatePointStep(step) {
  const point = hasPoint(step), destination = step.to && typeof step.to === 'object';
  if (!pointInputEnabled() && (point || destination || step.view !== undefined)) throw Error('Point input requires SLEIGHT_POINT_INPUT=1.');
  const valid = value => value && [value.x, value.y].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000);
  if (point ? typeof step.view !== 'string' || !/^[a-f0-9]{16}$/.test(step.view) : step.view !== undefined)
    throw Error('Point input requires view from the latest read; refs do not take view.');
  if (point && (!['click', 'hover', 'drag'].includes(step.do) || step.ref !== undefined || !valid(step)))
    throw Error('Point input needs click, hover or drag with x,y between 0 and 10000, and no ref.');
  if (destination && (step.do !== 'drag' || !point || !valid(step.to)) || point && step.do === 'drag' && !destination)
    throw Error('Point drag needs x,y and to:{x,y}; ref drags need ref and a to ref.');
  if (point && step.do !== 'drag' && step.to !== undefined) throw Error('Only drag accepts to.');
  if (point && step.do === 'drag' && Math.hypot(step.to.x - step.x, step.to.y - step.y) < 5)
    throw Error('Point drag needs at least 5 CSS pixels of travel; use click for a press.');
  return point;
}
function epoch() {
  const key = '__sleightPointEpoch';
  if (!globalThis[key]) {
    const state = { version: 0, roots: new WeakSet() };
    state.observer = new MutationObserver(() => state.version++);
    state.events = ['scroll', 'resize', 'input', 'change'];
    state.changed = () => state.version++;
    for (const event of state.events) addEventListener(event, state.changed, true);
    globalThis[key] = state;
  }
  const state = globalThis[key];
  let count = 0, overflow = false;
  const checks = [];
  const visit = root => {
    if (!state.roots.has(root)) { state.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); state.roots.add(root); }
    const elements = root.querySelectorAll('*'); count += elements.length;
    if (count > 50000) { overflow = true; return; }
    for (const el of elements) {
      // CSSOM edits, pseudo-class layout and script-set form values need no DOM
      // mutation. Include them in the cheap epoch before reusing native layout.
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      checks.push([r.x, r.y, r.width, r.height, el.scrollLeft, el.scrollTop,
        style.display, style.visibility, style.pointerEvents, style.zIndex,
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
          ? [el.value, el.checked, el.selectedIndex] : null]);
      if (!overflow && el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  if (state.observer.takeRecords().length) state.version++;
  return { version: state.version, width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, overflow, checks };
}
// Native captures already carry form state. Keep cheap samples private too:
// retain only a SHA-256 digest rather than a collision-prone numeric checksum.
async function sampleEpoch(utility) {
  const { checks, ...stamp } = await utility.evaluateExpression(epoch.toString(), { isFunction: true });
  return { ...stamp, hash: digest(checks) };
}
const implOf = frame => frame?._connection?.toImpl?.(frame);
const sessionOf = impl => impl?._page?.delegate?._sessionForFrame?.(impl);

export function invalidatePointView(page) { views.delete(page); }
export function acknowledgePointView(page, view) { if (view) views.set(page, view); }
export async function releasePointView(page) {
  views.delete(page);
  await Promise.allSettled((page.frames?.() ?? []).map(async frame => {
    const utility = await implOf(frame)?.utilityContext?.();
    if (utility?.world !== 'utility') return;
    await utility.evaluateExpression(`() => {
      const state = globalThis.__sleightPointEpoch;
      if (!state) return;
      state.observer.disconnect();
      for (const event of state.events) removeEventListener(event, state.changed, true);
      delete globalThis.__sleightPointEpoch;
    }`, { isFunction: true });
  }));
}

export async function capturePointView(page, { cache } = {}) {
  if (!pointInputEnabled()) return null;
  const frames = page.frames?.();
  // Unit fakes and out-of-process transports confer no point capability.
  if (!frames?.length || frames.length > 32 || !implOf(frames[0])) return null;
  let lifetime = lifetimes.get(page);
  if (!lifetime) {
    lifetime = { version: 0 }; lifetimes.set(page, lifetime);
    const retire = () => { lifetime.version++; views.delete(page); };
    for (const event of ['framenavigated', 'frameattached', 'framedetached', 'close']) page.on(event, retire);
  }
  const version = lifetime.version, samples = [];
  for (const frame of frames) {
    const impl = implOf(frame), utility = await impl?.utilityContext?.();
    if (utility?.world !== 'utility' || impl._page.delegate.noUtilityWorld?.()) return null;
    const before = await sampleEpoch(utility);
    const session = sessionOf(impl);
    if (!session?._client?._sendMayFail || before.overflow) return null;
    samples.push({ frame, utility, session, stamp: JSON.stringify(before) });
  }
  const stable = () => version === lifetime.version && frames.length === page.frames().length &&
    frames.every((frame, i) => frame === page.frames()[i] && !frame.isDetached?.());
  // The caller owns this cache for one action only. Always take a new native
  // capture on the first check; later checks reuse it only at identical epochs.
  const prior = cache?.view;
  if (stable() && prior?.version === version && prior.records.length === samples.length &&
      samples.every((row, i) => row.frame === prior.records[i].frame && row.stamp === prior.records[i].stamp)) return prior;
  const layouts = new Map(), records = [];
  let cacheable = true;
  for (const { session } of samples) if (!layouts.has(session)) {
    const capture = await session._client._sendMayFail('DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'pointer-events'], includeDOMRects: true, includePaintOrder: true,
    });
    if (!capture?.documents || capture.documents.reduce((n, doc) => n + doc.nodes.nodeType.length, 0) > 50000) return null;
    // Utility observers cannot see closed-root changes. Keep their full native
    // rechecks instead of granting cache reuse on an incomplete epoch.
    if (capture.documents.some(doc => doc.nodes.shadowRootType?.value?.some(index => capture.strings[index] === 'closed'))) cacheable = false;
    layouts.set(session, digest(capture));
  }
  const seen = new Set();
  for (const { frame, utility, session, stamp } of samples) {
    const after = await sampleEpoch(utility);
    if (stamp !== JSON.stringify(after)) return null;
    records.push({ frame, stamp, layout: seen.has(session) ? undefined : layouts.get(session) }); seen.add(session);
  }
  if (!stable()) return null;
  const view = { version, records, signature: digest([version, records.map(({ stamp, layout }) => [stamp, layout])]).slice(0, 16) };
  if (cache) cache.view = cacheable ? view : undefined;
  return view;
}

export async function assertPointView(page, signature, cache) {
  const view = views.get(page);
  if (!view || signature !== undefined && signature !== view.signature) throw stale();
  const current = await capturePointView(page, { cache });
  if (!current || current.signature !== view.signature || current.records.some((record, i) => record.frame !== view.records[i]?.frame)) {
    views.delete(page); throw stale();
  }
  return view;
}

// A span inside a button is that button's input, including across open or
// closed shadow hosts. Never classify the harmless span instead of its control.
function actionable(el, controlsOnly, read) {
  let surface;
  for (let node = el; node;) {
    if (pointNameExcluded(node, null, read)) { node = read(node, 'parentElement'); continue; }
    if (read(node, 'localName') === 'label' && read(node, 'control')) return read(node, 'control');
    if (read(node, 'matches')('button,a,area,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="combobox"],[role="radio"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="textbox"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="listbox"]')) return node;
    if (!surface && read(node, 'matches')('[draggable="true"],[contenteditable]')) surface = node;
    const parent = read(node, 'parentElement'), root = read(node, 'getRootNode')();
    node = parent || (read(root, 'nodeType') === 11 ? read(root, 'host') : null);
  }
  return controlsOnly ? null : surface ?? null;
}
// Map viewport CSS coordinates to every ancestor document and the hit's root.
// Rects account for scrolling; borders stay outside each frame's content box.
function pointScopes(el, point, read) {
  const chain = [];
  let doc = read(el, 'ownerDocument'), view = read(doc, 'defaultView');
  while (view !== read(view, 'top')) {
    const owner = read(view, 'frameElement');
    if (!owner || chain.length >= 32) throw Error('Use a ref for the child-frame control.');
    // Positive axis-aligned scaling is invertible from the border box.
    // Rotation, reflection and perspective require a control ref.
    for (let at = owner; at; at = read(at, 'parentElement')) {
      const transform = getComputedStyle(at).transform;
      if (transform !== 'none') {
        const matrix = new DOMMatrixReadOnly(transform);
        if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) throw Error('Use a ref for the transformed child-frame control.');
      }
    }
    chain.push({ owner, doc }); doc = read(owner, 'ownerDocument'); view = read(doc, 'defaultView');
  }
  let { x, y } = point;
  const scopes = [{ root: doc, x, y, owner: null }];
  for (const { owner, doc } of chain.reverse()) {
    const r = read(owner, 'getBoundingClientRect')();
    if (!r.width || !r.height) throw Error('Point frame unavailable; use a control ref.');
    x = (x - r.left) * read(owner, 'offsetWidth') / r.width - read(owner, 'clientLeft');
    y = (y - r.top) * read(owner, 'offsetHeight') / r.height - read(owner, 'clientTop');
    scopes.push({ root: doc, x, y, owner });
  }
  const root = read(el, 'getRootNode')();
  if (root !== read(el, 'ownerDocument')) scopes.push({ root, x, y, owner: null });
  return scopes;
}
// Coordinate input is only for plain targets. Names alone are enough: a div
// need not advertise a role, receive pointer events, or be on the hit stack.
export function guardedPointWords(text) {
  return /(?:^|[^\p{L}\p{N}])(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete purchase|complete order|confirm payment|confirm purchase|confirm order|add payment|order now|send money|payer|acheter|abonner|pagar|comprar|suscribir|bezahlen|kaufen|bestellen|abonnieren|acquista|pagare|abbonati|betalen|kopen|оплатить|купить|подписаться)(?=$|[^\p{L}\p{N}])|支付|付款|购买|購買|订阅|訂閱|注文|購入|支払|구매|결제|الدفع|شراء/u.test(String(text).normalize('NFKC').replace(/[\p{Cf}\u034f\u17b4\u17b5\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, '').toLowerCase().replace(/\s+/g, ' '));
}
// Kept closure-free for the same utility-world name read after native listener proof.
function pointWords(node, full, read) {
  const start = performance.now(), unavailable = () => { throw Error('Point geometry scan unavailable; use a control ref.'); };
  const bounded = value => {
    value ??= '';
    if (value.length > 65536) unavailable();
    return value;
  };
  let text = '', count = 0;
  const append = value => {
    text += ' ' + bounded(value);
    if (text.length > 65536) unavailable();
  };
  const pending = [node];
  while (pending.length) {
    const at = pending.pop();
    if (++count > 20000 || performance.now() - start > 50) unavailable();
    const get = key => read(at, 'getAttribute')(key) ?? '';
    // Keep direct text beside full text: adjacent child labels may join PayGo.
    if (full || at === node) {
      if (full && at === node) append(read(at, 'textContent'));
      for (let child = read(at, 'firstChild'); child; child = read(child, 'nextSibling')) {
        if (read(child, 'nodeType') === 3) append(read(child, 'nodeValue'));
        if (++count > 20000 || performance.now() - start > 50) unavailable();
      }
    }
    for (const key of ['aria-label', 'value', 'alt', 'title']) append(get(key));
    if (read(at, 'localName') === 'input') append(read(at, 'value'));
    const ids = bounded(get('aria-labelledby')).trim().split(/\s+/).filter(Boolean);
    if (ids.length > 32) unavailable();
    const root = read(at, 'getRootNode')();
    for (const id of ids) {
      const named = read(root, 'getElementById')?.(id);
      if (named) append(read(named, 'textContent'));
    }
    for (const pseudo of ['::before', '::after']) {
      const content = getComputedStyle(at, pseudo).content;
      if (content && content !== 'none' && content !== 'normal') append(content);
    }
    if (!full) continue;
    // Native DOM access sees open roots without using the page's prototypes.
    const shadow = read(at, 'shadowRoot');
    if (shadow) append(read(shadow, 'textContent'));
    for (const parent of [at, shadow].filter(Boolean)) {
      for (let child = read(parent, 'firstChild'); child; child = read(child, 'nextSibling')) {
        if (read(child, 'nodeType') === 1) pending.push(child);
        if (++count > 20000 || performance.now() - start > 50) unavailable();
      }
    }
  }
  return text;
}
// Layout containers do not become named actions through delegated listeners.
function pointNameExcluded(node, unused, read) {
  const tag = read(node, 'localName');
  if (tag === 'html' || tag === 'body' || read(node, 'getAttribute')('tabindex') === '-1' && !read(node, 'getAttribute')('role')) return true;
  const doc = read(node, 'ownerDocument'), view = read(doc, 'defaultView');
  const width = read(view, 'innerWidth'), height = read(view, 'innerHeight');
  const box = read(node, 'getBoundingClientRect')();
  const visibleWidth = Math.max(0, Math.min(box.right, width) - Math.max(0, box.left));
  const visibleHeight = Math.max(0, Math.min(box.bottom, height) - Math.max(0, box.top));
  return width > 0 && height > 0 && visibleWidth * visibleHeight >= width * height * 0.9;
}
function namedPointAction(node, unused, read) { return !pointNameExcluded(node, null, read) && guardedPointWords(pointWords(node, true, read)); }
namedPointAction.helpers = [guardedPointWords, pointWords, pointNameExcluded];
function paymentProviderFrame(node, unused, read) {
  const src = read(node, 'getAttribute')('src') ?? '';
  if (src.length > 4096) throw Error('Point geometry scan unavailable; use a control ref.');
  try {
    const url = new URL(src, read(read(node, 'ownerDocument'), 'baseURI'));
    return /^https?:$/.test(url.protocol) && /(?:^|\.)(?:stripe\.com|paypal\.com|paypalobjects\.com|braintreegateway\.com|braintree-api\.com|adyen\.com|checkout\.com|squareup\.com|squareupsandbox\.com)$/.test(url.hostname);
  } catch { return false; }
}
function pointGeometry(el, point, read) {
  const start = performance.now(), scopes = pointScopes(el, point, read);
  const unavailable = () => { throw Error('Point geometry scan unavailable; use a control ref.'); };
  let count = 0;
  const budget = () => { if (++count > 20000 || performance.now() - start > 50) unavailable(); };
  const ancestors = new Set(), paymentForms = new Set(), candidates = new Set(), opaque = new Set(), roots = new Set();
  const parentOf = node => {
    if (performance.now() - start > 50) unavailable();
    const parent = read(node, 'parentElement'), root = read(node, 'getRootNode')();
    return parent || (read(root, 'nodeType') === 11 ? read(root, 'host') : null);
  };
  const exclude = node => { for (; node; node = parentOf(node)) ancestors.add(node); };
  exclude(el);
  for (const { owner } of scopes) if (owner) exclude(owner);
  const target = pointTarget(el, null, read);
  ancestors.add(target); // Includes a label's forwarded control.
  const get = (node, key) => read(node, 'getAttribute')(key) ?? '';
  const formOf = node => {
    const owner = read(node, 'form');
    if (owner) return owner;
    for (let at = node; at; at = parentOf(at)) if (read(at, 'localName') === 'form') return at;
    return null;
  };
  const boundedText = value => {
    value = value ?? '';
    if (value.length > 4096) unavailable();
    return value;
  };
  const isControl = node => read(node, 'matches')('button,a,area,input,select,textarea,label,summary,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="combobox"],[role="radio"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="textbox"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="listbox"]');
  // Layout exemptions affect names, while covered action geometry still refuses.
  const rawActionSignal = node => isControl(node) || read(node, 'hasAttribute')('onclick') || read(node, 'hasAttribute')('tabindex') || getComputedStyle(node).cursor === 'pointer';
  const actionSignal = node => !pointNameExcluded(node, null, read) && rawActionSignal(node);
  const words = (node, full = false) => pointWords(node, full || actionSignal(node), read);
  const add = (set, node) => {
    if (ancestors.has(node) || set.has(node)) return;
    if (set === candidates) opaque.delete(node);
    else if (candidates.has(node)) return;
    set.add(node);
    if (candidates.size + opaque.size > 128) unavailable();
  };
  const contains = (r, x, y) => r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const visit = (root, x, y) => {
    if (roots.has(root)) return;
    roots.add(root);
    // Walk nodes incrementally, with no unbounded querySelectorAll allocation.
    const pending = [root], images = [], areas = [];
    while (pending.length) {
      const node = pending.pop(); budget();
      const next = read(node, 'nextSibling'), child = read(node, 'firstChild');
      if (node !== root && next) pending.push(next);
      if (child) pending.push(child);
      if (read(node, 'nodeType') !== 1) continue;
      const tag = read(node, 'localName'), r = read(node, 'getBoundingClientRect')();
      if (tag === 'img' && contains(r, x, y) && get(node, 'usemap')) images.push(node);
      if (tag === 'area') areas.push(node);
      if (/^(input|select|textarea|iframe)$/.test(tag) && (tag === 'iframe' ? paymentProviderFrame(node, null, read) : /^cc-/i.test(get(node, 'autocomplete')) ||
          /card|cc[-_ ]?(number|csc)|cvv|cvc|expiry|expiration/i.test(['id', 'name', 'aria-label', 'placeholder'].map(key => boundedText(get(node, key))).join(' ')))) {
        const form = formOf(node); if (form) paymentForms.add(form);
      }
      if (contains(r, x, y) && !ancestors.has(node)) {
        add(candidates, node);
      }
      if (contains(r, x, y)) {
        // A zero-box or display:contents control owns its overflowing descendants.
        for (let at = parentOf(node); at; at = parentOf(at)) {
          const box = read(at, 'getBoundingClientRect')();
          if (!box.width || !box.height) add(candidates, at);
        }
      }
      const shadow = read(node, 'shadowRoot');
      // Closed-root overflow has no utility-world boxes. Check possible zero-box
      // hosts natively even when their origin lies beyond the point.
      if (!shadow && (!r.width || !r.height) && getComputedStyle(node).display !== 'none' &&
          (tag.includes('-') || /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(tag))) add(opaque, node);
      if (shadow) visit(shadow, x, y); // Overflowing children may lie outside their host.
      if ((tag === 'iframe' || tag === 'frame') && contains(r, x, y)) {
        if (tag === 'frame') throw Error('covered by frame; use its ref');
        const doc = read(node, 'contentDocument');
        if (!doc) throw Error('covered by iframe; use its ref');
        // Reject transforms we cannot invert, even when this is a covered frame.
        for (let at = node; at; at = parentOf(at)) {
          const transform = getComputedStyle(at).transform;
          if (transform !== 'none') {
            const m = new DOMMatrixReadOnly(transform);
            if (!m.is2D || m.b || m.c || m.a <= 0 || m.d <= 0)
              throw Error('Use a ref for the transformed child-frame control.');
          }
        }
        const fx = (x - r.left) * read(node, 'offsetWidth') / r.width - read(node, 'clientLeft');
        const fy = (y - r.top) * read(node, 'offsetHeight') / r.height - read(node, 'clientTop');
        if (fx >= 0 && fy >= 0 && fx < read(node, 'clientWidth') && fy < read(node, 'clientHeight')) visit(doc, fx, fy);
      }
    }
    for (const area of areas) {
      let map = parentOf(area);
      while (map && read(map, 'localName') !== 'map') { budget(); map = parentOf(map); }
      if (!map) continue;
      for (const image of images) {
        budget();
        if (get(image, 'usemap') !== '#' + get(map, 'name')) continue;
        for (let at = image; at; at = parentOf(at)) {
          const transform = getComputedStyle(at).transform;
          if (transform !== 'none') {
            const m = new DOMMatrixReadOnly(transform);
            if (!m.is2D || m.b || m.c || m.a <= 0 || m.d <= 0) unavailable();
          }
        }
        const r = read(image, 'getBoundingClientRect')();
        const ix = (x - r.left) * read(image, 'offsetWidth') / r.width - read(image, 'clientLeft');
        const iy = (y - r.top) * read(image, 'offsetHeight') / r.height - read(image, 'clientTop');
        const shape = get(area, 'shape').toLowerCase(), raw = boundedText(get(area, 'coords')).trim();
        const coords = raw ? raw.split(/[\s,]+/).map(Number) : [];
        if (coords.some(n => !Number.isFinite(n))) unavailable();
        let covered;
        if (shape === 'default') covered = true;
        else if (shape === 'circle' || shape === 'circ') {
          if (coords.length !== 3 || coords[2] < 0) unavailable();
          covered = Math.hypot(ix - coords[0], iy - coords[1]) <= coords[2];
        } else {
          // The bounding box also guards polygon edges and concave shapes.
          if (shape && !['rect', 'rectangle', 'poly', 'polygon'].includes(shape) || coords.length < 4 || coords.length % 2) unavailable();
          const xs = coords.filter((_, i) => i % 2 === 0), ys = coords.filter((_, i) => i % 2);
          covered = ix >= Math.min(...xs) && ix <= Math.max(...xs) && iy >= Math.min(...ys) && iy <= Math.max(...ys);
        }
        if (covered) add(candidates, area);
      }
    }
  };
  // Start at the top document. Include the hit's closed root, if native hit
  // testing reached it, without granting access to any other closed tree.
  visit(scopes[0].root, scopes[0].x, scopes[0].y);
  for (const { root, x, y } of scopes) visit(root, x, y);
  const guarded = node => {
    const tag = read(node, 'localName'), type = read(node, 'type');
    return !pointNameExcluded(node, null, read) && guardedPointWords(words(node, node === target)) || actionSignal(node) && paymentForms.has(formOf(node)) ||
      (tag === 'button' || tag === 'input') && type === 'submit' && !!formOf(node) ||
      node !== target && isControl(node) || ['object', 'embed'].includes(tag);
  };
  // Guard the intended node too, so even an authorized payment uses its ref.
  // Its plain ancestors can contain unrelated guarded text elsewhere.
  for (const node of [target, ...candidates]) {
    if (guarded(node) || node !== target && rawActionSignal(node))
      throw Error('covered by ' + pointKind({ tag: read(node, 'localName') }) + '; use its ref');
    if (performance.now() - start > 50) unavailable();
  }
  const knownHosts = new Set([...roots].filter(root => read(root, 'nodeType') === 11).map(root => read(root, 'host')));
  const result = { target };
  for (const node of candidates) result['covered' + Object.keys(result).length] = node;
  for (const node of opaque) if (!candidates.has(node)) result['opaque' + Object.keys(result).length] = node;
  for (const node of ancestors) {
    if (node === target) continue;
    // Full descendant text belongs to an ancestor with an action signal.
    // Otherwise defer that read until CDP proves a native listener on this node.
    if (actionSignal(node) && guardedPointWords(words(node, true)))
      throw Error('covered by ' + pointKind({ tag: read(node, 'localName') }) + '; use its ref');
    const box = read(node, 'getBoundingClientRect')();
    const kind = !box.width || !box.height ? 'ancestorZero' : knownHosts.has(node) ? 'ancestorKnown' : 'ancestor';
    // Excluded layout ancestors need no listener-name query. Closed roots are
    // still checked unless their complete nonzero hit path is already known.
    result[(pointNameExcluded(node, null, read) ? 'layout' : actionSignal(node) ? 'ancestorAction' : kind) + Object.keys(result).length] = node;
    if (Object.keys(result).length > 129) unavailable();
  }
  if (Object.keys(result).length > 129 || performance.now() - start > 50) unavailable();
  return result;
}
pointGeometry.helpers = [actionable, pointTarget, pointScopes, guardedPointWords, pointKind, pointWords, pointNameExcluded, paymentProviderFrame];

async function assertPointGeometry(leaf, frame, point) {
  let geometry;
  try { geometry = await trustedHandle(leaf, pointGeometry, point); }
  catch (error) {
    // Utility-world evaluation errors carry stacks. Only our fixed refusals may
    // cross this boundary; page text and executable details stay private.
    const refusal = String(error.message).match(/covered by (?:[a-z][a-z0-9-]{0,39}|element); use its ref|Use a ref for the (?:transformed )?child-frame control\.|Point (?:geometry scan|frame) unavailable; use a control ref\./)?.[0];
    throw Error(refusal ?? 'Point geometry scan unavailable; use a control ref.');
  }
  let nodes;
  try {
    nodes = await geometry.internalGetProperties();
    const client = sessionOf(implOf(frame))?._client;
    if (!client || nodes.size > 129) throw Error('Point geometry scan unavailable; use a control ref.');
    // The first node is the intended target, whose computed accessible name
    // can include CSS content or an associated label outside the point's box.
    // Other nodes need opaque-root and listener checks too. No query runs JS.
    const results = await Promise.allSettled([...nodes.entries()].map(async ([key, node]) => {
      const described = await client._sendMayFail('DOM.describeNode', { objectId: node._objectId });
      if (!described?.node?.backendNodeId) throw Error('Point geometry scan unavailable; use a control ref.');
      const excluded = await trustedReadNode(node, pointNameExcluded);
      if (key === 'target' && !excluded) {
        const tree = await client._sendMayFail('Accessibility.getPartialAXTree', {
          backendNodeId: described.node.backendNodeId, fetchRelatives: false,
        });
        const subject = tree?.nodes?.find(row => row.backendDOMNodeId === described.node.backendNodeId);
        const name = subject?.name?.value ?? '';
        if (!subject || typeof name !== 'string' || name.length > 4096)
          throw Error('Point geometry scan unavailable; use a control ref.');
        if (guardedPointWords(name)) throw Error('covered by ' + pointKind({ tag: described.node.localName }) + '; use its ref');
      }
      // A known hit inside a nonzero closed root has already supplied that root
      // to the geometry walker. Opaque covers and zero-box hosts still refuse.
      if (described.node.shadowRoots?.some(root => root.shadowRootType === 'closed') &&
          !key.startsWith('ancestorKnown')) return true;
      if (key.startsWith('opaque') || excluded && !key.startsWith('covered')) return false;
      // Listeners belong to their registration world. A utility-world object
      // hides MAIN-world listeners, so resolve the native id in the default
      // world for this CDP-only query. No MAIN-world JavaScript is evaluated.
      const resolved = await client._sendMayFail('DOM.resolveNode', { backendNodeId: described.node.backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) throw Error('Point geometry scan unavailable; use a control ref.');
      try {
        const listeners = await client._sendMayFail('DOMDebugger.getEventListeners', { objectId, depth: 1, pierce: false });
        if (!Array.isArray(listeners?.listeners)) throw Error('Point geometry scan unavailable; use a control ref.');
        const action = listeners.listeners.some(listener => /^(click|dblclick|auxclick|submit|mouse.*|pointer.*|touch.*|drag.*|drop)$/.test(listener.type));
        if (!action) return false;
        if (described.node.shadowRoots?.some(root => root.shadowRootType === 'closed')) return true;
        return key.startsWith('covered') || await trustedReadNode(node, namedPointAction);
      } finally { await client._sendMayFail('Runtime.releaseObject', { objectId }); }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      const refusal = String(failed.reason?.message).match(/covered by (?:[a-z][a-z0-9-]{0,39}|element); use its ref/)?.[0];
      throw Error(refusal ?? 'Point geometry scan unavailable; use a control ref.');
    }
    if (results.some(result => result.value)) throw Error('covered by element; use its ref');
  } finally {
    if (nodes) await Promise.allSettled([...nodes.values()].map(node => node.dispose()));
    await geometry.dispose();
  }
}
function sameHit(el, expected, read) { return el === expected && read(el, 'isConnected') === true; }

function pointTarget(el, unused, read) { return actionable(el, unused, read) ?? el; }
pointTarget.helpers = [actionable, pointNameExcluded];

async function hit(page, point) {
  const main = implOf(page.mainFrame()), reply = await sessionOf(main)?._client?._sendMayFail('DOM.getNodeForLocation', {
    x: Math.floor(point.x), y: Math.floor(point.y), includeUserAgentShadowDOM: false,
  });
  if (!reply?.backendNodeId) throw Error('No page element at the point.');
  const frame = page.frames().find(frame => implOf(frame)?._id === reply.frameId);
  if (!frame) throw Error('Point frame unavailable; use a control ref.');
  const leaf = await resolveClosedHandle({ frame, backendNodeId: reply.backendNodeId });
  let node;
  try {
    await assertPointGeometry(leaf, frame, point);
    node = await trustedHandle(leaf, pointTarget);
    const impl = implOf(frame), described = await sessionOf(impl)._client._sendMayFail('DOM.describeNode', { objectId: node._objectId });
    if (!described?.node?.backendNodeId) throw stale();
    return await resolveClosedHandle({ frame, backendNodeId: described.node.backendNodeId });
  } finally { try { await node?.dispose(); } catch {} await leaf.dispose().catch(() => {}); }
}

export async function resolvePoint(page, point, cache) {
  const view = await assertPointView(page, point.view, cache), viewport = JSON.parse(view.records[0].stamp);
  if (![point.x, point.y].every(n => Number.isFinite(n) && n >= 0) || point.x >= viewport.width || point.y >= viewport.height)
    throw Error('Point is outside the tab viewport.');
  const handle = await hit(page, point);
  return handle;
}

export async function assertPointTarget(page, point, handle, cache) {
  await assertPointView(page, point.view, cache);
  const current = await hit(page, point);
  try {
    const node = handle._connection?.toImpl?.(handle);
    if (!node || !await trustedRead(current, sameHit, node)) throw Error('The element at the point changed; read again.');
  } finally { await current.dispose().catch(() => {}); }
}

// Report types only: input values and page-authored names can contain secrets.
export function pointKind(info) {
  return /^[a-z][a-z0-9-]{0,39}$/i.test(info.tag) ? info.tag + (['file', 'color', 'select', 'button'].includes(info.kind) && info.kind !== info.tag ? ' (' + info.kind + ')' : '') : 'element';
}

export async function assertPointNotProtected(handle) {
  const protectedField = await trustedRead(handle, function protectedPoint(el, unused, read) {
    if (read(el, 'localName') === 'label' && read(el, 'control')) el = read(el, 'control');
    const get = key => read(el, 'getAttribute')(key) ?? '';
    if (!['input', 'textarea'].includes(read(el, 'localName')) && !read(el, 'isContentEditable') &&
        !['textbox', 'searchbox', 'combobox'].includes(get('role'))) return false;
    return read(el, 'localName') === 'input' && read(el, 'type') === 'password' ||
      /password|passcode|secret|one.?time|\botp\b|\bcc[-_ ]|card|expiry|expiration|cvv|cvc|security.?code/i.test(
        ['autocomplete', 'name', 'id', 'aria-label', 'placeholder'].map(get).join(' '));
  });
  if (protectedField) throw Error('Protected controls need an observed ref, not point input.');
}

export function assertDragSurface(info) {
  if (info.button || info.submit || info.payment || info.formPayment || info.link || info.kind === 'link' ||
      /^(button|link|checkbox|switch|combobox|radio|menuitem|menuitemcheckbox|menuitemradio|option|tab|textbox|searchbox|slider|spinbutton|listbox)$/.test(info.role) ||
      ['a', 'area', 'input', 'select', 'textarea', 'label', 'summary', 'iframe', 'frame', 'object', 'embed', 'audio', 'video'].includes(info.tag) ||
      ['file', 'color', 'select'].includes(info.kind)) throw Error('Point drag endpoints must be non-activating page surfaces; use click or a control ref.');
}

export function pointDragSteps(from, to) { return Math.max(5, Math.min(40, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 15))); }
