import { fileURLToPath } from 'node:url';
import { createClipboardPasteSession, createNativeClipboardIO } from '../clipboard.mjs';
import { randomUUID } from 'node:crypto';
import { createHandoffWaiter } from './handoff.mjs';
import { trustedRead, trustedReadNode, trustedHandle } from './trusted-dom.mjs';
import { closedDetails, hostsRootEvidence, clickListeners, nativeEditContextDetails } from './closed-handle.mjs';
import { readNativeEditContext, retainNativeEditContext, sameNativeEditContext, nativeEditContextSelection } from './edit-context.mjs';
import { canonical } from './authority.mjs';
import { check, inspectElement, releaseNavigation, intent, expirePaymentDialog, keyClass, activationKey, textChord, deferRefund, endDeferredRefund, internalNativeKeyboardTarget, lineBreakRefusal } from './rules.mjs';
import { createUserFileProvider, stageUserUploads } from './files.mjs';
import { uploadRefusalMessage } from './upload-paths.mjs';
import { createConsentUi } from './consent-ui.mjs';
import { isAppBinding } from './electron-identity.mjs';
import { moneyFigures, moneyConflicts } from '../payment-figures.mjs';

const bindings = new WeakMap(), contexts = new WeakSet();
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const refused = () => ({ verdict: 'refuse', message: 'Trusted turn or target evidence is unavailable. Use the engine browser path.' });
const equal = (a, b) => canonical(a) === canonical(b);
export const isV3Context = ctx => !!ctx && contexts.has(ctx);

// Called only by the inherited worker's begin handler. No model-facing endpoint
// accepts a binding, parsed permission or payment method. Copy the exact message.
export function createV3TurnBinding(message, current) {
  if (message?.source !== 'user' || !['session', 'turn', 'id'].every(key => text(message[key])) ||
      typeof message.text !== 'string' || Buffer.byteLength(message.text) > 65536 || typeof current !== 'function')
    throw Error('TRUSTED_TURN_REQUIRED');
  const binding = Object.freeze({});
  bindings.set(binding, { message: Object.freeze({ source: 'user', session: message.session, turn: message.turn, id: message.id, text: message.text }), current });
  return binding;
}

// A page or tool argument cannot authorize reading a local file. Keep this grammar narrow until the owner expands it.
export function pdfFileAllowed(binding, path) {
  const bound = bindings.get(binding);
  try {
    if (!bound || bound.current() !== true) return false;
    const match = /^(?:Please\s+)?(?:Read|Summarize)\s+(?:the\s+)?PDF\s+("(?:[^"\\\r\n]|\\.)*")(?=$|[.\s])/i.exec(bound.message.text.trim());
    return !!match && JSON.parse(match[1]) === path;
  } catch { return false; }
}

// A closed request grammar: ambiguous prose, negations and mentions ask the
// native UI. JSON here is text from the authenticated user message, not tool JSON.
// The quoted prose form has the same exact terms. Never infer omitted terms.
export function requestedPayment(message) {
  const source = message.trim(); let value;
  const json = /^(?:Please\s+)?(?:Pay|Buy|Purchase)\s+(\{[^\n]*\})\.?$/i.exec(source);
  const prose = /^(?:Please\s+)?Pay\s+"([^"\n]+)"\s+for\s+"([^"\n]+)"\s+to\s+"([^"\n]+)"\s+with\s+"([^"\n]+)"(?:\s+in\s+"([A-Z]{3})")?\.?$/.exec(source);
  try {
    if (json) value = JSON.parse(json[1]);
    else if (prose) value = { amount: prose[1], item: prose[2], payee: prose[3], method: prose[4], ...(prose[5] ? { currency: prose[5] } : {}) };
    else return;
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !['item', 'amount', 'payee', 'method', 'currency'].includes(key)) ||
        !['item', 'amount', 'payee', 'method'].every(key => text(value[key])) || value.currency !== undefined && !/^[A-Z]{3}$/.test(value.currency)) return;
    return Object.freeze({ ...value });
  } catch { return; }
}

// Focus and its synchronous page handlers run in the same evaluation. Never
// let a failed focus silently send a key to the previously active control.
// options is true/false (focus first or not) or { focus, hostsRoot }. hostsRoot is the Node side's CDP evidence about
// whether el itself hosts a closed shadow root; page-side DOM cannot tell a closed host from a plain focusable div.
// An opaque host (div, span, custom element) may hide the real receiver of a key, so a key to it is not tied to the checked ref.
const focusRequired = 'CHECKED_FOCUS_REQUIRED: the key could not be tied to the checked element (focus moved, or it is a div, span or custom element that may hide the real receiver). Use the engine browser path';
export function focusCheckedNode(el, options, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const { focus, hostsRoot } = typeof options === 'object' && options !== null ? options : { focus: options };
  if (!read(el, 'isConnected')) return false;
  if (focus) HTMLElement.prototype.focus.call(el, { preventScroll: true });
  try {
    // A closed root hides its real receiver behind activeElement's host. DOM
    // evidence cannot distinguish that host from an ordinary focusable div.
    // Refuse opaque potential hosts; an open root exposes the receiver below.
    // The CDP evidence that el hosts no closed root replaces that guess.
    const opaqueHost = hostsRoot !== false && !read(el, 'shadowRoot') && (read(el, 'localName').includes('-') ||
      ['article','aside','blockquote','body','div','footer','h1','h2','h3','h4','h5','h6','header','main','nav','p','section','span'].includes(read(el, 'localName')));
    if (opaqueHost) return false;
    let node = el;
    for (;;) {
      const doc = read(node, 'ownerDocument'), view = read(doc, 'defaultView');
      // Focus inside this node's own open root would retarget to this node, so look for it directly.
      if (read(read(node, 'shadowRoot'), 'activeElement')) return false;
      let active = read(doc, 'activeElement');
      while (read(read(active, 'shadowRoot'), 'activeElement')) active = read(read(active, 'shadowRoot'), 'activeElement');
      if (active !== node) {
        // The descent above cannot enter a closed root. A root is readable from a node inside it, open or closed, so
        // each tree on the way up must report exactly this level as its active element, up to the document.
        if (typeof read(node, 'getRootNode') !== 'function') return false;
        for (let level = node;;) {
          const root = read(level, 'getRootNode')();
          if (read(root, 'activeElement') !== level) return false;
          if (read(root, 'nodeType') !== 11) break;
          level = read(root, 'host');
        }
      }
      const frame = read(view, 'frameElement');
      if (!frame) return view === read(view, 'top');
      if (!read(frame, 'isConnected')) return false;
      node = frame;
    }
  } catch { return false; }
}

// The page-side guess refuses a focused div, span, body or custom element, because it cannot see a closed root. The
// Node side can ask CDP, so a refusal on a light-DOM node is asked again once the DOM agent says it hosts no root.
async function focusProved(handle, focus, closed) {
  if (await trustedRead(handle, focusCheckedNode, { focus, hostsRoot: closed?.hostsRoot })) return true;
  if (closed || await hostsRootEvidence(handle) !== false) return false;
  return trustedRead(handle, focusCheckedNode, { focus, hostsRoot: false });
}

export function pasteFieldReady(el, unused, read) {
  return read(el, 'readOnly') !== true && read(el, 'getAttribute')('aria-readonly') !== 'true';
}

export function ownDocument(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) { return read(el, 'ownerDocument'); }
export function samePageDocument(el, doc, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) { return read(el, 'isConnected') && read(el, 'ownerDocument') === doc; }

// The final native input evidence is one synchronous utility-world read, including focus and document identity.
export function checkedNativeEditContextSelection(el, arg, read) {
  if (!samePageDocument(el, arg.document, read) || !focusCheckedNode(el, { focus: false, hostsRoot: arg.hostsRoot }, read)) return null;
  return nativeEditContextSelection(el, arg.context, read);
}
checkedNativeEditContextSelection.helpers = [...nativeEditContextSelection.helpers, nativeEditContextSelection, samePageDocument, focusCheckedNode];

// A click can activate something other than the element named by the ref. HTML label activation: the first
// label at or above the element forwards to its control unless interactive content sits between. Closure-free
// readers (they run in the target's utility world); the control is then classified like any other element.
export function labelForward(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  for (let node = el; node; node = read(node, 'parentElement') ?? read(read(node, 'getRootNode')?.(), 'host')) {
    if (read(node, 'localName') === 'label') return read(node, 'control') ?? null;
    if (read(node, 'matches')('a[*|href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),select,textarea,video[controls]')) return null;
  }
  return null;
}
// One cheap read per check: whether a label forwards, and the text of every area of an image map. The point
// under the pointer is unknown here, so every area of the map counts: alt, label, title and resolved href.
export function forwardInfo(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }, seal) {
  let label = false;
  for (let node = el; node; node = read(node, 'parentElement') ?? read(read(node, 'getRootNode')?.(), 'host')) {
    if (read(node, 'localName') === 'label') { label = !!read(node, 'control'); break; }
    if (read(node, 'matches')('a[*|href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),select,textarea,video[controls]')) break;
  }
  // The hook seals the areas of any element's usemap map; the words count for an img, the digests for every element.
  const usemap = read(el, 'getAttribute')('usemap'), areas = [], seals = [];
  if (usemap) {
    const doc = read(el, 'ownerDocument'), name = usemap.replace(/^#/, '');
    for (const map of read(doc, 'querySelectorAll')('map')) {
      if (read(map, 'getAttribute')('name') !== name) continue;
      for (const area of read(map, 'querySelectorAll')('area')) {
        let href = read(area, 'getAttribute')('href') ?? '';
        try { href = new URL(href, read(doc, 'baseURI')).href; } catch {}
        if (read(el, 'localName') === 'img') areas.push([read(area, 'getAttribute')('alt'), read(area, 'getAttribute')('aria-label'), read(area, 'getAttribute')('title'), href].filter(Boolean).join(' '));
        if (typeof seal === 'function') seals.push(seal(area, read));
      }
      break;
    }
  }
  return { label, areas, seals };
}
// Same words as rules.mjs paymentWords, for area text that inspectElement cannot read.
const paymentText = /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i;
// Fold what a click also activates into the classification of the element: it is a submit or payment if the
// forwarded control or any area of its map is, and a picker opener if the control opens a picker.
async function foldForwarded(handle, element) {
  const { label, areas, seals } = await trustedRead(handle, forwardInfo);
  const evidence = { forwarded: '', areas: seals ?? [] };
  if (label) {
    const forwarded = await trustedHandle(handle, labelForward);
    try {
      const control = forwarded.asElement?.();
      if (!control) throw Error('TRUSTED_TARGET_REQUIRED');
      const { seal, ...other } = await trustedReadNode(control, inspectElement);
      evidence.forwarded = seal;
      for (const key of ['submit', 'payment', 'formPayment']) element[key] = element[key] || other[key];
      if (['file', 'color', 'select'].includes(other.kind)) element.kind = other.kind;
    } finally { try { await forwarded.dispose?.(); } catch {} }
  }
  if (areas.some(words => paymentText.test(words))) { element.payment = true; element.submit = true; }
  return evidence;
}

// All names are local so Playwright can serialize this read into the target's
// frame. Page metadata is an observation only; it can never supply the method.
// Require one visible exact labeled value per term in the target form/dialog.
// Two predicates: `visible` (STRICT, a person could read it) lets a term supply
// authority; `looseLines` (LOOSE, anything rendered) can only force an ask when
// it shows a different payable number. Whatever can't be established fails closed.
// lenient (true under SLEIGHT_CONFIRM_PAYMENTS=never) also returns `unchecked`: the terms with the amount read without the figure check.
// The rules use it only for a payment the user's own message named, so a larger add-on figure no longer blanks the amount for that payment.
export function readPaymentPage(el, lenient, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const doc = read(el, 'ownerDocument'), view = read(doc, 'defaultView');
  // Form ownership stops at a shadow root, but a control in one still acts for the form around its host. Climb host by host.
  const enclosing = (node, selector) => {
    for (let at = node; at;) {
      const found = read(at, 'closest')(selector);
      if (found) return found;
      const root = read(at, 'getRootNode')?.();
      at = root && read(root, 'nodeType') === 11 ? read(root, 'host') : null;
    }
    return null;
  };
  const formOf = () => {
    const owner = read(el, 'form');
    if (owner) return owner;
    if (owner === undefined) return enclosing(el, 'form');
    const root = read(el, 'getRootNode')?.();
    return root && read(root, 'nodeType') === 11 ? enclosing(read(root, 'host'), 'form') : owner;
  };
  const root = formOf() ?? enclosing(el, 'dialog,[role="dialog"]');
  const gs = (node, pseudo) => read(view, 'getComputedStyle')(node, pseudo);
  const up = node => read(node, 'parentElement') ?? read(read(node, 'getRootNode')?.(), 'host');
  const shown = node => read(node, 'checkVisibility')({ checkOpacity: true, checkVisibilityCSS: true });
  // rgba(...) -> [r,g,b,a]; anything else (color(), lab(), ...) is unknown and fails closed.
  const rgba = value => { const m = /^rgba?\(([^)]*)\)$/.exec(String(value).trim()); const n = m && m[1].match(/-?\d*\.?\d+/g)?.map(Number);
    return n && n.length >= 3 && n.every(Number.isFinite) ? [n[0], n[1], n[2], n.length > 3 ? n[3] : 1] : undefined; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const effective = node => { let o = 1; for (let n = node; n; n = up(n)) { const s = gs(n); o *= s.opacity === '' ? 1 : Number(s.opacity ?? 1); } return o; };
  // Every element and open shadow root, once. Past the cap, nothing counts as visible. ext is the box plus whatever the element
  // paints outside it (outline, outer shadow, drop-shadow), so a 1px element with a huge outline still counts as a cover.
  let everyone, pseudoBoxes, tooMany = false, layers;
  const px = value => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };
  const colorSeen = value => (rgba(value)?.[3] ?? 1) >= 0.1;
  const outside = s => {
    let reach = 0;
    if (s.outlineStyle && s.outlineStyle !== 'none' && px(s.outlineWidth) > 0 && colorSeen(s.outlineColor)) reach = Math.max(reach, px(s.outlineWidth) + Math.max(0, px(s.outlineOffset)));
    for (const one of String(s.boxShadow ?? 'none').split(/,(?![^(]*\))/)) {
      if (!one.trim() || one.trim() === 'none' || /inset/.test(one)) continue;
      const color = /rgba?\([^)]*\)/.exec(one)?.[0]; if (color && !colorSeen(color)) continue;
      const n = (one.replace(/rgba?\([^)]*\)/, '').match(/-?\d*\.?\d+/g) ?? []).map(Number);
      reach = Math.max(reach, Math.max(Math.abs(n[0] ?? 0), Math.abs(n[1] ?? 0)) + (n[2] ?? 0) + Math.max(0, n[3] ?? 0));
    }
    for (const one of String(s.filter ?? '').matchAll(/drop-shadow\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g))
      reach = Math.max(reach, (one[1].replace(/rgba?\([^)]*\)/, '').match(/-?\d*\.?\d+/g) ?? []).reduce((sum, v) => sum + Math.abs(Number(v)), 0));
    return reach;
  };
  const gather = () => {
    if (everyone) return;
    everyone = [];
    const add = scope => { for (const n of Array.from(read(scope, 'querySelectorAll')?.('*') ?? [])) {
      if (everyone.length > 20000) { tooMany = true; return; }
      const box = read(n, 'getBoundingClientRect')(), reach = outside(gs(n));
      everyone.push({ n, box, reach, ext: reach ? { left: box.left - reach, top: box.top - reach, right: box.right + reach, bottom: box.bottom + reach } : box });
      const shadow = read(n, 'shadowRoot'); if (shadow) add(shadow); } };
    add(doc);
    // Top-layer elements (modal dialog, open popover) paint a ::backdrop over everything outside them.
    layers = [];
    for (const selector of [':modal', ':popover-open', ':fullscreen']) {
      let found = []; try { found = Array.from(read(doc, 'querySelectorAll')(selector)); } catch { /* selector unsupported */ }
      for (const n of found) { const b = gs(n, '::backdrop'); if (!b) continue;
        if (!rgba(b.backgroundColor) || colorSeen(b.backgroundColor) || (b.backgroundImage && b.backgroundImage !== 'none') || [b.backdropFilter, b.webkitBackdropFilter].some(v => v && v !== 'none')) layers.push(n); }
    }
  };
  // What a node paints, whatever the point. Cached: it only depends on style.
  const infoCache = new Map();
  const info = n => {
    if (infoCache.has(n)) return infoCache.get(n);
    const s = gs(n), tag = read(n, 'localName'), bg = rgba(s.backgroundColor), found = {};
    found.replaced = ['img', 'canvas', 'svg', 'video', 'picture', 'iframe', 'object', 'embed', 'input', 'textarea', 'select', 'button'].includes(tag);
    found.fill = !bg || bg[3] >= 0.1 || (s.backgroundImage && s.backgroundImage !== 'none') || [s.backdropFilter, s.webkitBackdropFilter].some(v => v && v !== 'none') || /inset/.test(s.boxShadow ?? '');
    // In-flow generated content: any text or paint counts. Placed ::before/::after boxes are measured in pseudos().
    found.generated = ['::before', '::after'].some(which => { const g = gs(n, which); if (!g || !g.content || g.content === 'none' || g.content === 'normal') return false;
      if (['absolute', 'fixed'].includes(g.position)) return false; // placed boxes are measured in pseudos()
      const gb = rgba(g.backgroundColor); return g.content.replace(/["'\s]/g, '') !== '' || !gb || gb[3] >= 0.1 || (g.backgroundImage && g.backgroundImage !== 'none') || px(g.borderTopWidth) > 0 || px(g.borderLeftWidth) > 0; });
    found.placed = ['absolute', 'fixed'].includes(s.position);
    found.outside = !!(px(s.outlineWidth) > 0 && s.outlineStyle !== 'none' && colorSeen(s.outlineColor)) || outside(s) > 0;
    found.ownText = (rgba(s.webkitTextFillColor || s.color)?.[3] ?? 1) >= 0.1;
    infoCache.set(n, found); return found;
  };
  // Does something painted (background, image, replaced content, control, generated content, inset shadow, border, outline,
  // outer shadow, another element's text) sit at x,y?
  const painted = (n, box, ext, x, y, inside) => {
    if (!shown(n) || effective(n) < 0.1) return false;
    const f = info(n), s = gs(n);
    if (f.outside) return true;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
    if (f.replaced || f.fill || (!inside || f.placed) && f.generated) return true;
    for (const [w, st, c, near] of [['borderTopWidth', 'borderTopStyle', 'borderTopColor', y - box.top], ['borderBottomWidth', 'borderBottomStyle', 'borderBottomColor', box.bottom - y],
        ['borderLeftWidth', 'borderLeftStyle', 'borderLeftColor', x - box.left], ['borderRightWidth', 'borderRightStyle', 'borderRightColor', box.right - x]])
      if (s[st] !== 'none' && s[st] !== 'hidden' && parseFloat(s[w]) > 0 && near <= parseFloat(s[w]) && (rgba(s[c])?.[3] ?? 1) >= 0.1) return true;
    // Another element's own text under the point could hide or replace the digits.
    return !inside && f.ownText && Array.from(read(n, 'childNodes')).some(c => read(c, 'nodeType') === 3 && read(c, 'textContent').trim());
  };
  // Absolutely placed ::before/::after boxes that paint anything. Geometry comes from used values; auto or transforms fail closed.
  const pseudos = () => {
    if (pseudoBoxes) return pseudoBoxes;
    pseudoBoxes = []; gather();
    for (const { n } of everyone) for (const which of ['::before', '::after']) {
      const s = gs(n, which); if (!s || !s.content || s.content === 'none' || s.content === 'normal') continue;
      if (!['absolute', 'fixed'].includes(s.position)) continue;
      const bg = rgba(s.backgroundColor), paints = !bg || bg[3] >= 0.1 || (s.backgroundImage && s.backgroundImage !== 'none') || /inset/.test(s.boxShadow ?? '') ||
        parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0 || s.content.replace(/["'\s]/g, '') !== '';
      if (!paints || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.1) continue;
      let cb = { left: 0, top: 0 };
      if (s.position === 'absolute') for (let a = n; a; a = up(a)) if (gs(a).position !== 'static') { const ab = read(a, 'getBoundingClientRect')(); cb = { left: ab.left + read(a, 'clientLeft'), top: ab.top + read(a, 'clientTop') }; break; }
      const L = parseFloat(s.left), T = parseFloat(s.top), W = parseFloat(s.width), H = parseFloat(s.height);
      if (![L, T, W, H].every(Number.isFinite) || (s.transform && s.transform !== 'none')) { pseudoBoxes.push({ box: { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 } }); continue; }
      const left = cb.left + L + (parseFloat(s.marginLeft) || 0), top = cb.top + T + (parseFloat(s.marginTop) || 0);
      pseudoBoxes.push({ box: { left, top, right: left + W, bottom: top + H } });
    }
    return pseudoBoxes;
  };
  // Every colour the text could sit on: ancestors' colours, gradient stops, then the canvas. Images we can't read fail closed.
  const backdrops = node => {
    const layers = [];
    for (let n = node; n; n = up(n)) {
      const s = gs(n), color = rgba(s.backgroundColor), image = s.backgroundImage;
      if (!color) return;
      let stops;
      if (image && image !== 'none') {
        if (/url\(|image-set|element\(|paint\(|cross-fade/.test(image)) return;
        stops = (image.match(/rgba?\([^)]*\)/g) ?? []).map(rgba); if (!stops.length || stops.some(c => !c)) return;
      }
      layers.push({ color, stops }); if (color[3] >= 0.99 && !stops) break;
    }
    const scheme = gs(read(doc, 'documentElement')).colorScheme ?? '';
    const dark = /dark/.test(scheme) && (!/light/.test(scheme) || read(view, 'matchMedia')?.('(prefers-color-scheme: dark)')?.matches === true);
    let backs = [dark ? [18, 18, 18, 1] : [255, 255, 255, 1]];
    for (const { color, stops } of layers.reverse()) backs = backs.flatMap(b => { const base = over(color, b); return stops ? stops.map(s => over(s, base)) : [base]; }).slice(0, 64);
    return backs;
  };
  // A person sees text only if it is rendered, uncovered at sample points of its own rects (whatever the pointer-events
  // or paint order), has non-zero effective opacity (opacity, filter, mask), a visible fill, a readable size and
  // contrast with everything it could sit on. Anything that cannot be established counts as not visible.
  const visible = (node, rects) => {
    if (!shown(node)) return false;
    if (!rects) {
      const range = ['input', 'select', 'textarea'].includes(read(node, 'localName')) ? undefined : read(doc, 'createRange')();
      if (range) range.selectNodeContents(node);
      const own = range && [...range.getClientRects()];
      rects = own?.length ? own : read(node, 'getClientRects')();
    }
    // Reachable area: the viewport, plus the page below it by scrolling (not left, above or far to the right). Fixed boxes stay in the viewport.
    const innerW = read(view, 'innerWidth'), innerH = read(view, 'innerHeight'), root = read(doc, 'documentElement');
    let fixed = false; for (let parent = node; parent; parent = up(parent)) if (gs(parent).position === 'fixed') fixed = true;
    const scrollX = read(view, 'scrollX') ?? 0, scrollY = read(view, 'scrollY') ?? 0;
    let left = fixed ? 0 : -scrollX, top = fixed ? 0 : -scrollY, right = innerW, opacity = 1;
    let bottom = fixed ? innerH : Math.min(Math.max(innerH, read(root, 'scrollHeight') || 0), innerH * 10) - scrollY;
    for (let parent = node; parent; parent = up(parent)) {
      const style = gs(parent);
      opacity *= style.opacity === '' ? 1 : Number(style.opacity ?? 1);
      for (const f of String(style.filter ?? '').matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) opacity *= Number(f[1]) / (f[2] ? 100 : 1);
      if (!(opacity >= 0.1) || style.visibility === 'hidden' || style.display === 'none' ||
          style.clipPath && style.clipPath !== 'none' || style.clip && style.clip !== 'auto') return false;
      // Blur, brightness, invert and the like change what is seen; only opacity() is understood.
      const rest = String(style.filter ?? 'none').replace(/opacity\([^)]*\)/g, '').trim();
      if (rest !== 'none' && rest !== '') return false;
      if ([style.maskImage, style.webkitMaskImage, style.maskBorderSource].some(v => v && v !== 'none') ||
          style.mixBlendMode && style.mixBlendMode !== 'normal') return false;
      // Text a person could not read as written: mirrored, rotated, bidi-reordered, struck through or outlined heavily.
      if (style.transform && style.transform !== 'none') {
        const m = /^matrix(3d)?\(([^)]*)\)$/.exec(style.transform), n = m && m[2].split(',').map(Number);
        const flat = m && n.every(Number.isFinite) && (m[1] ? n.length === 16 && [2, 3, 6, 7, 8, 9, 11].every(i => Math.abs(n[i]) < 1e-6) && Math.abs(n[10] - 1) < 1e-6 : n.length === 6);
        const [a, b, c, d] = m && flat ? (m[1] ? [n[0], n[1], n[4], n[5]] : n) : [];
        if (!flat || !(a * d - b * c > 0.1) || Math.abs(Math.atan2(b, a)) > 0.5) return false;
      }
      if (/override/.test(style.unicodeBidi ?? '') || style.writingMode && !/^horizontal/.test(style.writingMode)) return false;
      const size = parseFloat(style.fontSize) || 16;
      if (style.textDecorationLine && style.textDecorationLine !== 'none' && colorSeen(style.textDecorationColor)) {
        const t = String(style.textDecorationThickness ?? 'auto'), thick = t.endsWith('%') ? size * parseFloat(t) / 100 : /^[\d.]/.test(t) ? parseFloat(t) : 0;
        if (thick >= size * 0.2) return false;
      }
      if (px(style.webkitTextStrokeWidth) >= size * 0.1 && colorSeen(style.webkitTextStrokeColor)) return false;
      const box = read(parent, 'getBoundingClientRect')();
      const clips = axis => /^(?:auto|scroll|hidden|clip)$/.test(style['overflow' + axis]) || /(?:paint|strict|content)/.test(style.contain ?? '');
      if (clips('X')) { left = Math.max(left, box.left + read(parent, 'clientLeft')); right = Math.min(right, box.left + read(parent, 'clientLeft') + read(parent, 'clientWidth')); }
      if (clips('Y')) { top = Math.max(top, box.top + read(parent, 'clientTop')); bottom = Math.min(bottom, box.top + read(parent, 'clientTop') + read(parent, 'clientHeight')); }
    }
    // A painted fixed layer the size of the viewport (loading overlay, open fixed dialog) covers every spot the page can scroll to.
    gather(); if (tooMany) return false;
    if (!fixed) {
      const mine = new Set(); for (let a = node; a; a = up(a)) mine.add(a);
      const veil = everyone.some(({ n, box }) => !mine.has(n) && box.left <= 2 && box.top <= 2 && box.right >= innerW - 2 && box.bottom >= innerH - 2 &&
        gs(n).position === 'fixed' && shown(n) && effective(n) >= 0.1 && (info(n).fill || info(n).replaced));
      if (veil) { top = Math.max(top, 0); bottom = Math.min(bottom, innerH); }
    }
    const seen = [...rects].filter(r => Math.min(right, r.right) - Math.max(left, r.left) >= 4 && Math.min(bottom, r.bottom) - Math.max(top, r.top) >= 4);
    if (!seen.length) return false;
    const own = gs(node), ink = rgba(own.webkitTextFillColor || own.color);
    if (!ink || ink[3] * opacity < 0.1 || !(parseFloat(own.fontSize) >= 7)) return false;
    const backs = backdrops(node); if (!backs) return false;
    const paint = [ink[0], ink[1], ink[2], ink[3] * opacity];
    for (const b of backs) { const a = lum(over(paint, b)) + 0.05, c = lum(b) + 0.05; if (Math.max(a, c) / Math.min(a, c) < 1.5) return false; }
    gather(); if (tooMany) return false;
    // A modal or popover with a painted ::backdrop hides everything that is not inside it.
    for (const layer of layers) { let inside = false; for (let a = node; a; a = up(a)) if (a === layer) inside = true; if (!inside) return false; }
    const spots = [];
    for (const r of seen.slice(0, 8)) {
      const l = Math.max(left, r.left), t = Math.max(top, r.top), rr = Math.min(right, r.right), b = Math.min(bottom, r.bottom);
      const nx = Math.min(40, Math.max(3, Math.ceil((rr - l) / 6)));
      for (let i = 0; i < nx; i++) for (let j = 0; j < 3; j++) spots.push([l + (rr - l) * (i + 0.5) / nx, t + (b - t) * (j + 0.5) / 3]);
    }
    const ancestors = new Set(); for (let n = node; n; n = up(n)) ancestors.add(n);
    const xs = spots.map(p => p[0]), ys = spots.map(p => p[1]), lo = [Math.min(...xs), Math.min(...ys)], hi = [Math.max(...xs), Math.max(...ys)];
    const near = everyone.filter(({ n, box, reach, ext }) => !ancestors.has(n) && (reach || box.width > 0 && box.height > 0) && ext.right >= lo[0] && ext.left <= hi[0] && ext.bottom >= lo[1] && ext.top <= hi[1]);
    for (const [x, y] of spots) {
      for (const { n, box, ext } of near) {
        if (x < ext.left || x > ext.right || y < ext.top || y > ext.bottom) continue;
        let inside = false; for (let a = n; a; a = up(a)) if (a === node) { inside = true; break; }
        if (painted(n, box, ext, x, y, inside)) return false;
      }
      for (const { box } of pseudos()) if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return false;
    }
    return true;
  };
  const visibleText = node => {
    const walker = read(doc, 'createTreeWalker')(node, 5), parts = []; let part, previous;
    while ((part = walker.nextNode())) if (read(part, 'nodeType') === 1) {
      if (read(part, 'localName') === 'br') { parts.push('\n'); previous = undefined; }
    } else if (read(part, 'parentElement')) {
      const range = read(doc, 'createRange')(); range.selectNodeContents(part);
      if (!read(part, 'textContent').trim() || !visible(read(part, 'parentElement'), range.getClientRects())) continue;
      let block = read(part, 'parentElement');
      while (block !== node && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = read(block, 'parentElement');
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push(read(part, 'textContent').trim()); previous = block;
    }
    return parts.join('');
  };
  // LOOSE: every rendered string under the form (offscreen, faint, ::before/::after, input values, open shadow roots, same-origin frames)
  // plus the activating control's own label. An image or canvas outside a control is a mark (￼) where a figure we cannot read may sit.
  // Known limits: a figure drawn as a CSS background image, or held in a closed shadow root with no text, is not seen.
  const looseLines = () => {
    const parts = []; let previous, count = 0;
    // The text of a control the user has picked (checked box or radio, aria-checked, selected option, the label linked to one, or the
    // row of a bare checked box) is wrapped in two private marks: whatever its label says, a chosen figure is an add-on the user will pay.
    const chosenCache = new Map();
    const chosenAria = a => ['aria-checked', 'aria-pressed', 'aria-selected', 'aria-current'].some(k => read(a, 'getAttribute')(k) === 'true') ||
      /^(?:checked|on|selected)$/.test(read(a, 'getAttribute')('data-state') ?? '') || /(?:^|\s)(?:selected|is-selected|checked|is-checked)(?:\s|$)/.test(read(a, 'getAttribute')('class') ?? '');
    const isBoxNode = c => read(c, 'localName') === 'input' && /^(?:radio|checkbox)$/.test(read(c, 'type'));
    // F-B: chosen state is marked per control and per row. A checked box or radio, or an element that is aria-checked, aria-pressed, aria-selected,
    // aria-current, data-state checked/on/selected or has the class selected/checked, marks every money figure in its row: the nearest ancestor that holds a figure (a table row, list item, label, fieldset, a
    // block that holds both the control and a figure), through span wrappers, hidden inputs, a price in its own column, or a label slotted into
    // a shadow tree that holds the box. Never the form itself or a block that holds the activating control. A flat run (control, then text
    // and inline elements up to the next line break or block) is marked too. A selected option is read through its select.
    const MONEY = /[$€£¥₹₩₽₺₪฿₫₱₦]\s*\d|\d\s*[$€£¥₹₩₽₺₪฿₫₱₦]|\b(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW)\s*\d|\d\s*(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW)\b|\d[,.]\d{2}(?!\d)|\b(?:dollars?|euros?|pounds?|bucks)\b/i;
    const chosenControls = new Set(), chosenRows = new Set();
    {
      // Every element under the form, open shadow roots included (Node members only: a shadow root has no querySelectorAll in this reader).
      const stack = [root], seen = [];
      while (stack.length && seen.length <= 20000) {
        const n = stack.pop(); seen.push(n);
        const shadow = read(n, 'shadowRoot'); if (shadow) for (const c of Array.from(read(shadow, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) stack.push(c);
        for (const c of Array.from(read(n, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) stack.push(c);
      }
      // A host's textContent leaves out its shadow tree: a block holds a figure if its own text or the text of a shadow root under it does.
      const shadowed = seen.filter(n => read(n, 'shadowRoot')).map(n => [n, MONEY.test(read(read(n, 'shadowRoot'), 'textContent') ?? '')]).filter(x => x[1]).map(x => x[0]);
      const holdsMoney = a => MONEY.test(read(a, 'textContent') ?? '') || shadowed.some(h => h === a || read(a, 'contains')(h));
      if (seen.length <= 20000) for (const n of seen) {
        if (n === root || !(isBoxNode(n) ? read(n, 'checked') : chosenAria(n) || /^["']?[✔✓☑✅]/.test(gs(n, '::before')?.content ?? ''))) continue;
        chosenControls.add(n);
        for (let a = isBoxNode(n) ? up(n) : n; a && a !== root; a = up(a)) {
          if (read(a, 'contains')(el)) break;
          if (holdsMoney(a)) { chosenRows.add(a); break; }
        }
      }
    }
    const chosenNode = a => {
      if (chosenRows.has(a)) return true;
      if (chosenCache.has(a)) return chosenCache.get(a);
      const tag = read(a, 'localName'), role = read(a, 'getAttribute')('role'), isBox = c => read(c, 'localName') === 'input' && /^(?:radio|checkbox)$/.test(read(c, 'type'));
      let yes = false;
      if (tag === 'label') { const ctl = read(a, 'control'); yes = !!ctl && isBox(ctl) && !!read(ctl, 'checked'); }
      else if (chosenAria(a)) yes = true;
      else if (tag !== 'form' && a !== root) {
        // A bare checked box (no label) takes the text of its own row when it is the only control in it.
        const kids = Array.from(read(a, 'children') ?? []), controls = kids.filter(c => ['input', 'select', 'textarea'].includes(read(c, 'localName')));
        yes = controls.length === 1 && isBox(controls[0]) && !!read(controls[0], 'checked') && !(read(controls[0], 'labels')?.length);
      }
      chosenCache.set(a, yes); return yes;
    };
    const push = (text, owner, picked = false) => {
      let t = String(text ?? '').normalize('NFKC').replace(/[­​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim(); if (!t) return;
      if (!picked) for (let a = owner; a; a = up(a)) { if (chosenNode(a)) { picked = true; break; } if (a === root) break; }
      if (picked) t = '\uE000' + t + '\uE001';
      let block = owner; while (block && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = up(block);
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push(t); previous = block;
    };
    const pseudo = (n, which, forced = false) => { const c = gs(n, which)?.content; if (/counters?\(/.test(c ?? '')) throw Error('counter content'); if (c && c !== 'none' && c !== 'normal') push(c.replace(/^["']|["']$/g, ''), n, forced); };
    const media = ['img', 'canvas', 'svg', 'video', 'picture', 'object', 'embed'];
    const controlled = n => { const tag = read(n, 'localName'), role = read(n, 'getAttribute')('role'); return ['button', 'a', 'summary', 'select'].includes(tag) || ['button', 'link', 'tab', 'menuitem'].includes(role); };
    // The label of a radio, checkbox or ARIA option the user has not picked is an alternative, not this charge, unless it names a total,
    // an amount due or a payment (and not the activating control).
    const NOT_PAY = /\b(?:total|amount|due|pay|paying|payable|payment|charged?|charges|billed|billing|owe|owed|invoice)\b/i;
    const alternative = n => {
      const role = read(n, 'getAttribute')('role');
      let unpicked = false;
      if (read(n, 'localName') === 'label') {
        const control = read(n, 'control');
        unpicked = !!control && read(control, 'localName') === 'input' && /^(?:radio|checkbox)$/.test(read(control, 'type')) && !read(control, 'checked');
      } else if (/^(?:radio|checkbox|option|menuitemradio|menuitemcheckbox|switch)$/.test(role ?? '')) {
        const state = read(n, 'getAttribute')(role === 'option' ? 'aria-selected' : 'aria-checked');
        unpicked = state !== null && state !== 'true' && state !== 'mixed';
      }
      return unpicked && !NOT_PAY.test(read(n, 'innerText') ?? read(n, 'textContent') ?? '') && !read(n, 'contains')(el);
    };
    const walk = (n, inControl = false, forced = false) => {
      if (++count > 20000) throw Error('too many nodes');
      if (alternative(n)) return;
      const on = shown(n), tag = read(n, 'localName');
      inControl ||= controlled(n);
      if (on && media.includes(tag)) {
        const b = read(n, 'getBoundingClientRect')();
        // A banner-sized image or canvas can show a total we can't read; a smaller one outside a control is a mark: it may hold a figure.
        if (b.width >= 100 && b.height >= 16) throw Error('unreadable content');
        const alt = read(n, 'getAttribute')('alt');
        if (alt) push(alt, n, forced); else if (!inControl && b.width >= (tag === 'svg' ? 50 : 24) && b.height >= (tag === 'svg' ? 12 : 8) && !(tag === 'svg' && (read(n, 'textContent') ?? '').trim())) push('￼', n, forced);
      }
      if (on) {
        pseudo(n, '::before', forced);
        if (tag === 'input') { if (!/^(?:hidden|password|checkbox|radio|file)$/.test(read(n, 'type'))) push(read(n, 'value'), n, forced); }
        else if (tag === 'textarea') push(read(n, 'value'), n, forced);
        else if (tag === 'select') for (const o of Array.from(read(n, 'selectedOptions') ?? [])) push(read(o, 'textContent'), n, true);
      }
      if (['select', 'textarea', 'input'].includes(tag)) { if (on) pseudo(n, '::after', forced); return; }
      const shadow = read(n, 'shadowRoot'); if (shadow) for (const c of Array.from(read(shadow, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) walk(c, inControl, forced);
      if (tag === 'iframe') { try { const body = read(read(n, 'contentDocument'), 'body'); if (body) walk(body, inControl, forced); } catch { /* cross-origin */ } }
      // After a chosen control, the text and inline elements that follow it on the same line are its row too.
      let run = forced;
      for (const c of Array.from(read(n, 'childNodes') ?? [])) {
        if (read(c, 'nodeType') === 1) {
          if (chosenControls.has(c)) run = true;
          else if (read(c, 'localName') === 'br' || !/^(?:inline(?:-.*)?|contents|none)$/.test(gs(c).display)) run = forced;
          walk(c, inControl, run);
        } else if (read(c, 'nodeType') === 3 && on) push(read(c, 'textContent'), n, run);
      }
      if (on) pseudo(n, '::after', forced);
    };
    try { walk(root); } catch { return; }
    const tag = read(el, 'localName'), isField = ['input', 'select', 'textarea'].includes(tag);
    const own = [read(el, 'getAttribute')('aria-label'), isField ? undefined : read(el, 'textContent'), isField ? undefined : read(el, 'getAttribute')('value'),
      tag === 'input' && /^(?:submit|button|image|reset)$/.test(read(el, 'type')) ? read(el, 'value') : undefined].filter(Boolean);
    return parts.join('').split('\n').concat(own.map(t => String(t).normalize('NFKC').replace(/\s+/g, ' ').trim()));
  };
  const field = (key, figures = true) => {
    if (!root) return;
    const values = [], hidden = [];
    const valueOf = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').replace(new RegExp('^' + key + ':\\s*', 'i'), '') : '';
    for (const node of read(root, 'querySelectorAll')('[data-payment-' + key + '],[itemprop="' + key + '"],[name="' + key + '"],[aria-label="' + key + '" i]')) {
      const attribute = read(node, 'getAttribute')('data-payment-' + key);
      if (!visible(node)) {
        // Hidden candidates can contradict evidence, never supply authority.
        hidden.push(valueOf(attribute), valueOf(['input','select','textarea'].includes(read(node, 'localName')) ? read(node, 'value') : read(node, 'textContent')));
        continue;
      }
      const value = ['input', 'select', 'textarea'].includes(read(node, 'localName')) ? read(node, 'value') : visibleText(node);
      const shown = valueOf(value);
      if (attribute !== null && attribute.trim() !== shown) return;
      if (shown) values.push(shown);
    }
    if (!values.length) {
      const label = new RegExp('^' + key + ':\\s*(.+)$', 'i');
      for (const line of visibleText(root).split('\n')) { const match = label.exec(line.trim()); if (match) values.push(match[1].trim()); }
    }
    if (key === 'amount' && values.length === 1) {
      // Anything rendered that shows a different payable figure (LOOSE) leaves the terms ambiguous.
      if (figures) { const lines = looseLines(); if (!lines || moneyConflicts(lines, values[0], field('currency'))) return; }
    }
    return values.length === 1 && values[0].length <= 4096 && !hidden.some(value => value && value !== values[0]) ? values[0] : undefined;
  };
  const page = Object.fromEntries(['item', 'amount', 'payee', 'currency'].map(key => [key, field(key)]).filter(([,value]) => value !== undefined));
  const loose = lenient === true && page.amount === undefined ? field('amount', false) : undefined;
  const unchecked = lenient === true ? loose === undefined ? page : { ...page, amount: loose } : undefined;
  const labels = read(el, 'labels') ? [...read(el, 'labels')].map(label => read(label, 'innerText').trim()).filter(Boolean) : [];
  const name = read(el, 'getAttribute')('aria-label') || (labels.length === 1 ? labels[0] : '');
  return { origin: read(view, 'location').origin, page, name, ...(unchecked ? { unchecked } : {}) };
}
// The money figure rule (payment-figures.mjs), defined beside this reader wherever it is serialized (trusted-dom.mjs).
readPaymentPage.helpers = [moneyFigures, moneyConflicts];

function dialogTerms(message) {
  // Dialog text must independently name all page terms. An amount-only dialog
  // is insufficient evidence for the initiating item/payee and asks/refuses.
  const match = /^Pay\s+(\{[^\n]*\})\??$/i.exec(message ?? '');
  try {
    const value = match && JSON.parse(match[1]);
    if (!value || Object.keys(value).some(key => !['item', 'amount', 'payee', 'currency'].includes(key)) ||
        !['item', 'amount', 'payee'].every(key => text(value[key]))) return;
    return value;
  } catch { return; }
}

// app is the trusted adapter's Electron binding (createAppBinding), never tool JSON or page data. With it the
// document identity is typed (app document or real HTTPS origin) and the app's debugger grant must stay current.
// Without it only HTTP(S) frames pass, as before.
export function createV3Context({ binding, browser, app, ui, confirmPayments, clipboardIO, now = Date.now } = {}) {
  const bound = bindings.get(binding);
  if (app !== undefined && !isAppBinding(app)) throw Error('TRUSTED_TURN_REQUIRED');
  if (!bound || !(app ? app.current() && app.session === bound.message.session && (app.turn === null || app.turn === bound.message.turn) : text(browser))) throw Error('TRUSTED_TURN_REQUIRED');
  const never = (confirmPayments ?? process.env.SLEIGHT_CONFIRM_PAYMENTS) === 'never';
  const requested = requestedPayment(bound.message.text), documents = new Map(), targets = new WeakMap(), held = new Set();
  const watched = new Map();
  const uploads = new WeakMap(), offered = new Map(), tickets = new Map(), pending = new Map();
  let closed = false, live, sequence = 0, dialogOwner, uploadRefusal, pasteSession;
  const current = () => { try { return !closed && bound.current() === true && (!app || app.current()); } catch { return false; } };
  const handoff = createHandoffWaiter({ ui, current, session: bound.message.session, turn: bound.message.turn });
  // One place derives the document identity, so every later check agrees with the first.
  const documentOf = (frame, observed) => {
    if (app) return app.classify(frame, observed);
    const parsed = new URL(frame.url());
    if (!['http:', 'https:'].includes(parsed.protocol) || observed !== undefined && observed !== parsed.origin) throw Error('TRUSTED_TARGET_REQUIRED');
    return { origin: parsed.origin };
  };
  const fileProvider = createUserFileProvider({ now,
    readUserMessage: event => current() && event === binding ? { session: bound.message.session, text: bound.message.text } : undefined,
    resolveInput: ref => current() ? offered.get(ref) : undefined,
    current: () => current() ? live : undefined });
  // checkCurrent compares private data, never caller object identity or a page's
  // approval flag. The consumed ticket still binds every native operation field.
  let consuming;
  const native = ui && createConsentUi({ now, authenticate: event => current() && ui.authenticate(event) === true,
    checkCurrent: operation => current() && consuming === canonical(operation),
    present(view, operation) {
      const key = canonical(operation), record = pending.get(key);
      ui.present(view.id, { view, operation }, view.choices, event => {
        try { const ticket = native.respond(event); if (ticket && current() && pending.get(key) === record) tickets.set(key, ticket);
          else pending.delete(key); }
        catch { pending.delete(key); }
      });
    } });
  const files = Object.freeze({ check(paths, target) {
    try {
      const record = targets.get(target);
      if (!current() || !record || !text(record.name)) return false;
      const input = { ...record.identity, ref: target.ref, name: record.name };
      live = record.identity; offered.set(target.ref, input);
      const handle = fileProvider.offer(binding, paths, target.ref);
      uploads.set(target, { handle, paths: [...paths], record }); return true;
    } catch (error) { uploadRefusal = uploadRefusalMessage(error); return false; }
  } });
  let ruleTarget;
  const consent = Object.freeze({ consume(terms, target) {
    const record = targets.get(target) ?? dialogOwner;
    if (!record || !native || !['item','amount','payee','method'].every(key => text(terms[key]))) return false;
    const action = { type: 'fill', press: 'key', submit: 'click', check: 'click', uncheck: 'click' }[target.do] ?? target.do ?? 'click';
    const base = { ...record.identity, action, args: { ref: target.ref ?? record.ref ?? 'focused', key: target.key ?? null, accept: target.accept ?? null },
      destination: record.origin + '/', payment: { ...terms }, ...(record.principal ? { principal: record.principal } : {}) };
    const keyBase = canonical(base);
    for (const [key, value] of pending) if (now() >= value.expires) { pending.delete(key); tickets.delete(key); }
    let entry = [...pending.values()].find(value => value.keyBase === keyBase);
    if (!entry) {
      if (pending.size >= 32) return false;
      const operation = { ...base, sequence: ++sequence }; entry = { operation, keyBase, expires: now() + 30000 };
      const key = canonical(operation); pending.set(key, entry);
      try { native.request(operation); } catch { pending.delete(key); }
      return false;
    }
    const key = canonical(entry.operation), ticket = tickets.get(key); tickets.delete(key);
    if (!ticket) return false;
    pending.delete(key); consuming = key;
    try { native.consume(ticket, entry.operation); return true; } catch { return false; }
    finally { consuming = undefined; }
  } });
  const ruleContext = { now, dialogContinuation: target => dialogOwner?.dialog === target.state?.dialog &&
      !!dialogOwner?.dialog && dialogOwner.doc.valid,
    session: bound.message.session, turn: bound.message.turn, userMessage: () => {
    if (!current()) return;
    // Under 'never' the user's own request is matched against the terms read without the figure check; the rules apply them only when it matches.
    const page = (never && ruleTarget?.terms?.unchecked) || ruleTarget?.terms?.page;
    const observed = page && { ...page, method: requested?.method };
    // TS1 exactTerms equality: the whole observed terms object must match the
    // authenticated request, including optional currency. No provider echo.
    return { ...bound.message, ...(requested && observed && equal(observed, requested) ? { payment: requested } : {}) };
  }, consent, files, confirmPayments };
  async function prepare(target) {
    internalNativeKeyboardTarget(target, false);
    const old = targets.get(target);
    if (old) old.allowedKind = undefined;
    if (!current() || !target.locator || !target.state) throw Error('TRUSTED_TARGET_REQUIRED');
    const handle = old?.handle ?? (typeof target.locator.elementHandle === 'function' ? await target.locator.elementHandle({ timeout: 1000 }) : target.locator);
    if (!handle) throw Error('TRUSTED_TARGET_REQUIRED');
    held.add(handle);
    let keyboardBinding;
    try {
      const frame = await handle.ownerFrame();
      if (!frame || !current() || old && (!old.doc.valid || !await trustedRead(handle, samePageDocument, old.doc.handle))) throw Error('TRUSTED_TARGET_REQUIRED');
      let doc = documents.get(frame);
      if (!doc || !doc.valid || !await trustedRead(handle, samePageDocument, doc.handle)) {
        const documentHandle = await trustedHandle(handle, ownDocument);
        doc = { valid: true, handle: documentHandle, id: 'd' + randomUUID().replaceAll('-', '') }; documents.set(frame, doc); held.add(documentHandle);
      }
      if (typeof target.page?.on === 'function' && !watched.has(target.page)) {
        const revokeDialog = () => { dialogOwner = undefined; expirePaymentDialog(ruleContext); };
        const navigate = frame => {
          const document = documents.get(frame); if (document) document.valid = false;
          if (dialogOwner?.page === target.page) revokeDialog();
        };
        const dialog = value => {
          if (!dialogOwner?.active || dialogOwner.page !== target.page || !dialogOwner.doc.valid || dialogOwner.dialog) {
            revokeDialog(); return;
          }
          dialogOwner.dialog = value;
        };
        // The pinned Playwright emits dialogclosed even for a user/browser
        // answer outside our action runner. A stale state pointer grants nothing.
        const dialogclosed = value => { if (dialogOwner?.dialog === value) revokeDialog(); };
        const close = () => { if (dialogOwner?.page === target.page) revokeDialog(); };
        const handlers = { framenavigated: navigate, dialog, dialogclosed, close };
        for (const [event, handler] of Object.entries(handlers)) target.page.on(event, handler);
        watched.set(target.page, handlers);
      }
      const closed = closedDetails(handle);
      keyboardBinding = nativeEditContextDetails(handle);
      if (/^x\d+$/.test(target.ref) && !keyboardBinding || keyboardBinding?.keyboardOnly && !['type', 'paste', 'press'].includes(target.do)) throw Error('TRUSTED_TARGET_REQUIRED');
      if (!keyboardBindingCurrent(keyboardBinding)) throw Error('EDIT_CONTEXT_CHANGED');
      let nativeEditor, editContext;
      if (['type', 'paste', 'press'].includes(target.do)) {
        nativeEditor = await trustedRead(handle, readNativeEditContext).catch(() => ({ native: false, eligible: false }));
        if (nativeEditor.native || keyboardBinding) {
          if (!nativeEditor.native || !nativeEditor.eligible) throw Error('EDIT_CONTEXT_CHANGED');
          editContext = keyboardBinding?.context ?? old?.editContext;
          if (!editContext) { editContext = await trustedHandle(handle, retainNativeEditContext); held.add(editContext); }
          if (!await trustedRead(handle, sameNativeEditContext, editContext)) throw Error('EDIT_CONTEXT_CHANGED');
          if (keyboardBinding?.keyboardOnly && !await focusProved(handle, false, closed)) throw Error(focusRequired);
        }
      }
      if ((['press', 'paste'].includes(target.do) || editContext) && !await focusProved(handle, true, closed)) throw Error(focusRequired);
      const observed = await trustedRead(handle, readPaymentPage, never);
      const place = documentOf(frame, observed.origin);
      if (!current()) throw Error('TRUSTED_TARGET_REQUIRED');
      const identity = { browserIncarnation: app ? app.incarnation : browser, brokerEpoch: 1, clientSession: bound.message.session, turn: bound.message.turn,
        leaseGeneration: 1, target: doc.id, frame: doc.id, document: doc.id, origin: place.origin };
      const record = { handle, doc, frame, page: target.page, identity, origin: place.origin, principal: place.principal, name: observed.name, ref: target.ref, closed, editContext, keyboardBinding };
      targets.set(target, record); live = identity;
      // Last inspection is on the exact pinned element, after all page terms.
      const { seal, ...element } = await trustedRead(handle, inspectElement);
      // A "checkout" link is navigation only when no script listens on it (one CDP call, and only for that link); any doubt keeps the ask.
      const freed = element.navigation === true && releaseNavigation(element, await clickListeners(handle));
      // The act's own earlier read of the same link (legacy classifier) carries the same checkout wording; a released link frees it too.
      const before = target.prior ?? target.element, prior = freed && before?.checkoutLink === true ? { ...before, payment: false } : before;
      record.prior = prior;
      const sealEvidence = { element: seal, ...await foldForwarded(handle, element) };
      if (!current() || !keyboardBindingCurrent(keyboardBinding)) throw Error('TRUSTED_TARGET_REQUIRED');
      Object.assign(target, { session: bound.message.session, turn: bound.message.turn, document: doc.id, origin: place.origin,
        sealEvidence, element, prior, locator: handle, terms: { page: observed.page, ...(never && observed.unchecked ? { unchecked: observed.unchecked } : {}), method: requested?.method },
        submit: intent(target.do ?? 'click', { ...target, element }).submit });
      if (editContext && nativeEditor.zeroArea && (['type', 'paste'].includes(target.do) || target.do === 'press' && keyClass(target.key).kind === 'safe'))
        internalNativeKeyboardTarget(target, true);
      return record;
    } catch (error) { keyboardBinding?.retire?.(); held.delete(handle); await handle.dispose().catch(() => {}); throw error; }
  }
  function keyboardBindingCurrent(binding) { return !binding || typeof binding.current === 'function' && binding.current() === true; }
  const nativeFieldOnly = el => el?.kind === 'text' && ['textbox', 'searchbox'].includes(el.role)
    && ['payment', 'submit', 'formPayment'].every(key => el[key] === false);
  async function nativeInputReady(record, selection) {
    try {
      if (!current() || !record?.doc.valid || !record.editContext ||
          !keyboardBindingCurrent(record.keyboardBinding) ||
          !await trustedRead(record.handle, samePageDocument, record.doc.handle) || !current() ||
          !await focusProved(record.handle, false, record.closed)) throw Error(focusRequired);
      const element = await trustedRead(record.handle, inspectElement);
      if (!nativeFieldOnly(element) || record.prior && !nativeFieldOnly(record.prior) ||
          element.connected === false || element.enabled === false || element.hit === false) throw Error('EDIT_CONTEXT_CHANGED');
      const hostsRoot = await hostsRootEvidence(record.handle);
      if (hostsRoot !== false) throw Error(focusRequired);
      const actual = await trustedRead(record.handle, checkedNativeEditContextSelection,
        { context: record.editContext, document: record.doc.handle, hostsRoot });
      if (!actual || selection && (actual.start !== selection.start || actual.end !== selection.end) || !record.doc.valid || !current() ||
          !keyboardBindingCurrent(record.keyboardBinding)) throw Error('EDIT_CONTEXT_CHANGED');
      return actual;
    } catch (error) { record?.keyboardBinding?.retire?.(); throw error; }
  }
  const ctx = Object.freeze({ session: bound.message.session, turn: bound.message.turn, userMessage: ruleContext.userMessage,
    exportTurn: binding,
    consent, files, prepareTarget: prepare, paymentTerms: target => targets.get(target) ? target.terms : undefined,
    async check(kind, target, { fieldOnly = false } = {}) {
      try {
        if (!current()) return refused();
        target.do = kind;
        if (kind === 'press' && keyClass(target.key).kind === 'unknown') return { verdict: 'refuse', message: 'Unsupported key. Use Enter, Space, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, an arrow, F1-F12 or one character, with Alt, Control, Meta or Shift if needed. Use the engine browser path if needed.' };
        if (kind !== 'dialog') { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
        if (kind === 'dialog') {
          if (target.accept === false) { dialogOwner = undefined; expirePaymentDialog(ruleContext); return { verdict: 'allow' }; }
          if (!dialogOwner?.dialog || target.state?.dialog !== dialogOwner.dialog || !dialogOwner.doc.valid || !current()) return refused();
          if (target.page && dialogOwner.page !== target.page) return refused();
          if (documentOf(dialogOwner.frame).origin !== dialogOwner.origin) return refused();
          const page = dialogTerms(target.message), record = dialogOwner;
          Object.assign(target, { session: bound.message.session, turn: bound.message.turn, document: record.doc.id, origin: record.origin,
            terms: { page, method: requested?.method }, element: { payment: !!page || /\bpay|payment|buy|purchase|charge\b/i.test(target.message ?? '') } });
          targets.set(target, record);
        } else if (target.locator) await prepare(target);
        else if (!['wait','back','forward','reload','viewport'].includes(kind)) return refused();
        else Object.assign(target, { session: bound.message.session, turn: bound.message.turn });
        // A click that was sealed in the page: the words the rules just read must be the words that were sealed.
        if (kind === 'click' && target.locator && typeof target.verifySeal === 'function') {
          const verdict = await target.verifySeal(target.sealEvidence);
          if (verdict !== true) return { verdict: 'refuse', message: typeof verdict === 'string' ? verdict : 'page changed during the click; read again' };
        }
        if (fieldOnly && intent(kind, target).submit) return refused();
        ruleTarget = target;
        uploadRefusal = undefined;
        let result = check(ruleContext, kind, target);
        if (kind === 'upload' && result.verdict === 'refuse' && uploadRefusal) result = { ...result, message: uploadRefusal };
        const checked = targets.get(target);
        if (checked) { checked.allowedKind = result.verdict === 'allow' ? kind : undefined; checked.allowedKey = target.key; }
        if (result.verdict === 'allow' && ['click', 'press', 'submit'].includes(kind))
          dialogOwner = { ...targets.get(target), target, active: false };
        if (kind === 'dialog' && result.verdict === 'allow') { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
        return result;
      } catch { return refused(); }
      finally { ruleTarget = undefined; }
    },
    // The action settled with no visible effect: its payment activation goes back to the request's budget at the next payment
    // check, if the control is on the closed name list and the network stayed quiet until then (deferRefund).
    refund(target, activity) {
      if (!current() || dialogOwner?.target !== target || !deferRefund(ruleContext, target, activity)) return false;
      dialogOwner = undefined; expirePaymentDialog(ruleContext); return true;
    },
    beginInput(target) { if (dialogOwner?.target === target && current()) dialogOwner.active = true; },
    finishInput(target) {
      if (dialogOwner?.target !== target) return;
      dialogOwner.active = false;
      if (!dialogOwner.dialog) { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
    },
    async pressTarget(target, key, options, keys) {
      const record = targets.get(target);
      if (!current() || !record?.doc.valid || !await trustedRead(record.handle, samePageDocument, record.doc.handle) ||
          !await focusProved(record.handle, false, record.closed) || !current()) throw Error(focusRequired);
      if (record.editContext) {
        if (record.allowedKind !== 'press' || key !== record.allowedKey) throw Error('EDIT_CONTEXT_CHANGED');
        await nativeInputReady(record);
      }
      const { kind, chord } = keyClass(key);
      if (kind === 'unknown' || chord && kind !== 'safe' && !textChord(key, target.element)) throw Error('KEY_NOT_ALLOWED: this key or chord is not sent in the background (Shift+Enter and Control+Enter in a text field are). Use the engine browser path');
      // ElementHandle.press focuses again without verifying its recipient. Use only the owned page keyboard after
      // the checked ref retained focus. Enter and Space (and Shift or Control with Enter in a text field) are sent
      // by the caller inside the key shield (page.mjs backgroundClick with keys), armed before this key and checked at every
      // event, so a page that moves focus or rewires the control while the key is in flight has the event cancelled.
      if (kind === 'safe') return target.page.keyboard.press(key, options);
      const pressed = activationKey(key);
      if (typeof keys?.between !== 'function') return target.page.keyboard.press(pressed, options);
      // The shield may need to look at the page between the key going down and coming up (frames the key's handler created).
      const names = pressed.split('+'), { keyboard } = target.page;
      let down = 0;
      try {
        for (const name of names) { await keyboard.down(name); down++; }
        await keys.between();
      } finally { for (let i = down - 1; i >= 0; i--) await keyboard.up(names[i]); }
    },
    async pasteTarget(target, value, guarded) {
      // Electron has no page shield. Keep its existing native paste route.
      if (app) throw Error('Paste in an app uses the native app.paste path.');
      const ready = async () => {
        const record = targets.get(target);
        if (!current() || !record?.doc.valid || record.allowedKind !== 'paste' ||
            !await trustedRead(record.handle, samePageDocument, record.doc.handle) ||
            !await focusProved(record.handle, false, record.closed) || !current()) throw Error(focusRequired);
        const el = await trustedRead(record.handle, inspectElement);
        if (el.kind !== 'text' || el.button || el.link || el.enabled === false ||
            !await trustedRead(record.handle, pasteFieldReady) ||
            el.tag === 'input' && /[\r\n]/.test(value)) throw Error('Paste needs a checked text field or editor; single-line inputs cannot take line breaks.');
        if (record.editContext) await nativeInputReady(record);
        return record;
      };
      pasteSession ??= createClipboardPasteSession(clipboardIO ?? createNativeClipboardIO(fileURLToPath(new URL('../clipboard.js', import.meta.url))));
      let record;
      const result = await pasteSession.paste(value, async (verify, keys, begin) => {
        const checked = async () => {
          await verify();
          if (!current() || !record.doc.valid || record.allowedKind !== 'paste') throw Error(focusRequired);
        };
        // Recheck the pinned field and focus after the native stage write,
        // then fence generation and authority directly before Meta down.
        await ready();
        await checked();
        begin?.();
        const { keyboard } = target.page;
        if (typeof keys?.between !== 'function') return keyboard.press('ControlOrMeta+V');
        // Match Enter/Space: lock frames created by keydown before keyup.
        let modifier = false, down = false;
        try {
          await keyboard.down('ControlOrMeta'); modifier = true;
          await checked();
          verify.remaining();
          await keyboard.down('V'); down = true;
          await keys.between({ timeoutMs: verify.remaining() });
        } finally {
          try { if (down) await keyboard.up('V'); }
          finally { if (modifier) await keyboard.up('ControlOrMeta'); }
        }
      }, stage => guarded(async (keys, begin) => {
        record = await ready();
        const restored = await stage(keys, begin);
        // Restoration precedes this read, popup settling and shield disarm.
        if (record.editContext) await nativeInputReady(record);
        return restored;
      }));
      if (!Number.isFinite(pasteSession.stagedMs)) return 'Paste not attempted; your clipboard is unchanged.';
      const rows = value.split(/\r\n|\r|\n/);
      return `paste sent: ${[...value].length} characters, ${rows.length} rows, up to ${Math.max(...rows.map(row => row.split('\t').length))} columns; ${result}; clipboard staged for ${pasteSession.stagedMs.toFixed(1)} ms (500 ms limit); verify the page`;
    },
    async typeTarget(target, value, options) {
      const record = targets.get(target);
      if (typeof value !== 'string' || !current() || !record?.doc.valid || record.allowedKind !== 'type' ||
          !await trustedRead(record.handle, samePageDocument, record.doc.handle) || !current()) throw Error('TRUSTED_TARGET_REQUIRED');
      if (!record.editContext) {
        if (target.element.tag === 'input' && /[\r\n]/.test(value)) throw Error(lineBreakRefusal);
        return record.handle.fill(value, options);
      }
      await nativeInputReady(record);
      await record.page.keyboard.press('ControlOrMeta+A', options);
      // SelectAll is a real editor action, including its keyup handlers. Native offsets can be only a partial buffer;
      // retain their resulting selection without pretending that they prove the whole virtual document was selected.
      const selection = await nativeInputReady(record);
      await nativeInputReady(record, selection);
      if (value === '') await record.page.keyboard.press('Backspace', options);
      else await record.page.keyboard.insertText(value);
      // Input may have been delivered before the document, focus, context or grant changed. Refuse success without replay.
      await nativeInputReady(record);
    },
    async stageUploads(target, paths) {
      const entry = uploads.get(target); uploads.delete(target);
      if (!entry || !current() || !entry.record.doc.valid || !equal(paths, entry.paths) || !await trustedRead(entry.record.handle, samePageDocument, entry.record.doc.handle))
        throw Error('USER_NAMED_FILE_REQUIRED');
      const observed = await trustedRead(entry.record.handle, readPaymentPage);
      let again; try { again = documentOf(entry.record.frame, observed.origin).origin; } catch { again = undefined; }
      if (again !== entry.record.origin || observed.name !== entry.record.name || !current()) throw Error('USER_NAMED_FILE_REQUIRED');
      live = entry.record.identity;
      const bindingData = { ...entry.record.identity, ref: target.ref, operation: 'upload' };
      return stageUserUploads({ event: binding, binding: bindingData, provider: {
        offer(event, exactPaths, ref) {
          if (event !== binding || ref !== target.ref || !equal(exactPaths, entry.paths)) throw Error('USER_NAMED_FILE_REQUIRED');
          return entry.handle;
        }, stage: fileProvider.stage,
      } }, paths, target.ref);
    },
    async dragTo(target, destination) {
      const source = targets.get(target);
      if (!source || !current() || !source.doc.valid) throw Error('TRUSTED_TARGET_REQUIRED');
      const endpoint = { page: target.page, locator: destination, ref: target.ref, state: target.state, do: 'drag' };
      let down = false;
      try {
        const verdict = await ctx.check('drag', endpoint);
        if (verdict.verdict !== 'allow') throw Error('TRUSTED_TARGET_REQUIRED');
        const end = targets.get(endpoint);
        if (end.frame !== source.frame || end.doc !== source.doc) throw Error('TRUSTED_TARGET_REQUIRED');
        // ElementHandle has no dragTo. Its hover uses Playwright actionability
        // on the pinned node, and the mouse belongs only to this owned page.
        await end.handle.hover({ timeout: 1000 }); await source.handle.hover({ timeout: 1000 });
        if (!current() || !source.doc.valid) throw Error('TRUSTED_TARGET_REQUIRED');
        await target.page.mouse.down(); down = true;
        await end.handle.hover({ timeout: 1000 }); await end.handle.hover({ timeout: 1000 });
      } finally {
        if (down) await target.page.mouse.up();
        await ctx.releaseTarget(endpoint);
      }
    },
    async releaseTarget(target) {
      const handle = targets.get(target)?.handle;
      if (handle && held.delete(handle)) await handle.dispose().catch(() => {});
    },
    handoff: (tab, ready, onDeadline) => handoff.wait(tab, ready, onDeadline),
    async dispose() {
      handoff.dispose();
      closed = true; native?.revoke(); endDeferredRefund(ruleContext);
      for (const [page, handlers] of watched) for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
      watched.clear(); tickets.clear(); pending.clear(); offered.clear();
      const receipt = fileProvider.dispose();
      await pasteSession?.close();
      await Promise.allSettled([...held].map(handle => handle.dispose?.())); held.clear(); documents.clear();
      return receipt;
    },
  });
  contexts.add(ctx); return ctx;
}
