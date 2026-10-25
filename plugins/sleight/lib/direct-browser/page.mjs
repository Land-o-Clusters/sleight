// Background popup disposition for turbo v3, independently implemented for CR1.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { trackPage } from './activity.mjs';
import { endpointURL, endpointTarget, endpointBlock, bindEndpointPage, assertEndpointRead } from './endpoint-guard.mjs';
import { trustedRead } from './trusted-dom.mjs';
import { tabHandle } from './tab-handle.mjs';
import { terminatePageScripts, guardPageTask, disableRecoveryFetch } from './page-health.mjs';
import { trackPageWaits, waitForThinPage, stopPageWaits } from './waits.mjs';
import { invalidateRefs } from './snapshot.mjs';
import { restoreViewport } from './viewport.mjs';
import { receiveDownload } from './download-response.mjs';
import { createDownloadStore } from './downloads.mjs';
import { handoffReadReady, handoffMessages } from './handoff.mjs';
import { createDeveloperRead } from './developer-read.mjs';

// Preserve recovery advice when the dispatcher hides an uncertain operation's details.
const capabilityError = message => Object.assign(Error(message), { capability: true });

function deadline(task, ms, message = 'background preparation timed out') {
  let timer;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

// MAIN world, before page scripts. Every name stays inside this function so it
// can be serialized. The hook controls disposition, never grants authority.
//
// popupHook({ key, secret }): the controller picks a random property name and a random secret per page registry
// and writes both into the install source (secret as an array of byte values, built by hookSource), so a page can find neither before the hook runs. The api lives at
// window[key] as a frozen, non-configurable, non-writable, non-enumerable value, so a page cannot replace, delete or
// redefine it. A page can still list the property and call the methods, so every method takes a proof as its first
// argument: HMAC-SHA-256(secret, method + ':' + nonce) as 'nonce.tag', checked against the secret held in this
// closure, valid once, and good for that one method. A page that reads the proof off a call (Playwright hands its
// arguments through page-reachable code) can burn it, which fails that call closed, and can do nothing more with it.
// If the property already exists the install returns false and changes nothing (a page or a stale install got there
// first), and the controller must treat that document as having no hook.
export function popupHook(options) {
  const { key, secret } = options !== null && typeof options === 'object' ? options : {};
  if (typeof key !== 'string' || key.length === 0 || typeof secret !== 'object' || secret === null) return false;
  // Every global this hook reads after install is captured here, before page scripts, so a page that replaces or
  // deletes window.Element, window.Object, window.Set and the rest cannot change what the hook sees. These locals
  // shadow the page-visible names for everything below.
  const { Object, Function, Symbol, Math, Number, String, Error, Set, WeakMap, Promise, URL, JSON, Date, RegExp, Array,
    Element, WeakSet, HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLLabelElement, HTMLTextAreaElement,
    HTMLFormElement, Event, EventTarget, MouseEvent, KeyboardEvent, Node, Document, DocumentFragment, ShadowRoot, NodeList,
    Window, Uint8Array, Uint32Array, setTimeout, clearTimeout, navigator } = globalThis;
  const { defineProperty, getOwnPropertyDescriptor: getOwn, freeze } = Object, isFinite = Number.isFinite, stringify = JSON.stringify;
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  // Whole-thread expansion never authorizes a popup, dialog, submit or history change.
  let wholeUntil = 0, wholeToken, wholeBlocked = [], wholeShared = 0, wholeSubmit = 0, wholeRequestSubmit = 0;
  const wholeNow = Date.now.bind(Date);
  const wholeJoin = uncurry(Array.prototype.join);
  const wholeNavigation = window.navigation;
  const wholeNavigate = event => {
    if (!wholeBlock('navigation')) return;
    nativePrevent.call(event); stopNow(event);
  };
  if (wholeNavigation) EventTarget.prototype.addEventListener.call(wholeNavigation, 'navigate', wholeNavigate);
  const wholeActive = () => wholeNow() < wholeUntil;
  const wholeBlock = kind => { if (!wholeActive()) return false; if (wholeBlocked.length < 100) wholeBlocked[wholeBlocked.length] = kind; return true; };
  const randomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto), nativeRandom = Math.random;
  // The secret arrives as an array of 16 to 64 byte values written into the install source (hookSource builds it), so
  // nothing here converts a string in the page. It is copied once, now, into a typed array nothing outside this closure
  // can reach; after install the hook never reads secret again, and never reads a length off a typed array (a page can
  // redefine %TypedArray%.prototype.length): every loop below runs to a count held in a local number.
  const secretLength = Array.isArray(secret) ? secret.length : 0;
  if (secretLength < 16 || secretLength > 64) return false;
  const secretBytes = new Uint8Array(64);
  for (let i = 0; i < secretLength; i++) {
    const value = secret[i];
    if (typeof value !== 'number' || !(value >= 0 && value <= 255) || value % 1 !== 0) return false;
    secretBytes[i] = value;
  }
  if (getOwn(window, key)) return false;
  // The source a window.open handle's first document runs to get this same hook (see installInto). It is built now, at
  // install, from the key and the secret bytes by string concatenation and String(number) only, and held in this
  // closure: nothing a page can redefine touches it afterwards, and the page never holds it. The key must be plain
  // identifier characters so it can stand inside quotes.
  const keyCharCode = uncurry(String.prototype.charCodeAt);
  for (let i = 0; i < key.length; i++) {
    const code = keyCharCode(key, i);
    if (!(code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95)) return false;
  }
  let secretText = '';
  for (let i = 0; i < secretLength; i++) secretText += (i === 0 ? '' : ',') + String(secretBytes[i]);
  const installSource = '(' + uncurry(Function.prototype.toString)(popupHook) + ')({"key":"' + key + '","secret":[' + secretText + ']})';
  // https://html.spec.whatwg.org/multipage/document-sequences.html#navigable-container
  // and iframe-embed-object.html, obsolete.html#frames; fenced frames:
  // https://wicg.github.io/fenced-frame/#fenced-frame-element. Do not cross documents.
  const CR2_FOCUSED = focus => { while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement; return focus; };
  const CR2_NESTED_DOCUMENT = focus => /^(iframe|object|embed|frame|fencedframe)$/.test(CR2_FOCUSED(focus)?.localName);
  const nativeBlur = globalThis.HTMLElement?.prototype.blur;
  const getAttribute = Element.prototype.getAttribute, hasAttribute = Element.prototype.hasAttribute;
  const nativeMatches = Element.prototype.matches;
  // Target decisions read only natives captured here, before any page script: a page can
  // redefine document.querySelector, window.name or window.frames, never these references.
  const nativeQuery = globalThis.Document?.prototype.querySelector, nativeQueryAll = globalThis.Document?.prototype.querySelectorAll;
  const query = (root, selector) => (nativeQuery ?? root.querySelector).call(root, selector);
  const queryAll = (root, selector) => (nativeQueryAll ?? root.querySelectorAll).call(root, selector);
  const nameGetter = getOwn(window, 'name')?.get, openerGetter = getOwn(window, 'opener')?.get, framesGetter = getOwn(window, 'frames')?.get;
  const nameOf = context => nameGetter ? nameGetter.call(context) : context.name;
  const framesOf = context => framesGetter ? framesGetter.call(context) : context.frames;
  const editable = getOwn(HTMLElement.prototype, 'isContentEditable').get;
  const attribute = (node, name) => getAttribute.call(node, name);
  const has = (node, name) => hasAttribute.call(node, name);
  // A link is an HTML a or area with href, or an SVG a with href or xlink:href (href wins). The selector side matches an href in
  // any namespace, so a link cannot hide behind the xlink spelling; the reading side takes the two spellings the browser follows.
  const xlinkNamespace = 'http://www.w3.org/1999/xlink', svgNamespace = 'http://www.w3.org/2000/svg';
  const linkSelector = 'a[*|href],area[href]', controlSelector = linkSelector + ',button,input,label';
  const getAttributeNS = Element.prototype.getAttributeNS, hasAttributeNS = Element.prototype.hasAttributeNS;
  const namespaceOf = getOwn(Element.prototype, 'namespaceURI')?.get;
  const isSvg = node => { try { return (namespaceOf ? namespaceOf.call(node) : node.namespaceURI) === svgNamespace; } catch { return false; } };
  const hasHref = node => has(node, 'href') || isSvg(node) && hasAttributeNS.call(node, xlinkNamespace, 'href');
  const hrefOf = node => attribute(node, 'href') ?? (isSvg(node) ? getAttributeNS.call(node, xlinkNamespace, 'href') : null);
  // Brand-checked natives: a node, form or window from another realm (an iframe, a window.open handle) is
  // never an `instanceof` of this realm's constructors, but these getters accept it and reject anything else.
  const nodeProto = globalThis.Node?.prototype ?? {};
  const nodeGetter = name => getOwn(nodeProto, name)?.get;
  const nodeTypeOf = nodeGetter('nodeType'), parentNodeOf = nodeGetter('parentNode'), ownerDocumentOf = nodeGetter('ownerDocument');
  const rootNodeOf = nodeProto.getRootNode;
  const shadowHostOf = getOwn(globalThis.ShadowRoot?.prototype ?? {}, 'host')?.get;
  const localNameOf = getOwn(Element.prototype, 'localName')?.get;
  const defaultViewOf = getOwn(globalThis.Document?.prototype ?? {}, 'defaultView')?.get;
  const formElementsOf = getOwn(globalThis.HTMLFormElement?.prototype ?? {}, 'elements')?.get;
  const collectionLength = getOwn(globalThis.HTMLCollection?.prototype ?? {}, 'length')?.get;
  const postTask = globalThis.scheduler?.postTask?.bind(globalThis.scheduler);
  const NativeObserver = globalThis.MutationObserver, nativeObserve = NativeObserver?.prototype.observe, nativeDisconnect = NativeObserver?.prototype.disconnect;
  const isElement = node => {
    if (!nodeTypeOf) return node instanceof Element; // A test double has no Node interface to brand-check.
    try { return nodeTypeOf.call(node) === 1; } catch { return false; }
  };
  const nameOfElement = node => { try { return localNameOf ? localNameOf.call(node) : node.localName; } catch { return ''; } };
  const isLinkTag = node => { const name = nameOfElement(node); return name === 'a' || name === 'area'; };
  const docOf = node => {
    try { return nodeTypeOf.call(node) === 9 ? node : ownerDocumentOf.call(node) ?? document; } catch { return document; }
  };
  const viewOf = node => { try { return defaultViewOf.call(docOf(node)) ?? window; } catch { return window; } };
  const parentOf = node => {
    if (!parentNodeOf) return node.parentElement ?? node.getRootNode?.().host;
    try { const parent = parentNodeOf.call(node); if (parent) return parent; } catch { return null; }
    try { return shadowHostOf?.call(node) ?? null; } catch { return null; }
  };
  // The shadow-including ancestors that are elements, innermost first.
  const ancestors = element => {
    const result = [], seen = new Set();
    for (let node = element; node && !seen.has(node); node = parentOf(node)) { seen.add(node); if (isElement(node)) result.push(node); }
    return result;
  };
  // True for a node in the document's own light tree, where the window-level guard sees its events.
  const inDocument = node => {
    if (!isConnected(node)) return false;
    try { return rootNodeOf ? nodeTypeOf.call(rootNodeOf.call(node)) === 9 : true; } catch { return false; }
  };
  // Capture native IDL getters before page scripts. Form ownership includes
  // controls outside a form using form=id; button's missing/invalid type is submit.
  const formControls = [HTMLButtonElement, HTMLInputElement].map(constructor => ({
    constructor, form: getOwn(constructor.prototype, 'form').get,
    type: getOwn(constructor.prototype, 'type').get,
  }));
  const selectControl = { constructor: HTMLSelectElement,
    multiple: getOwn(HTMLSelectElement.prototype, 'multiple').get,
    size: getOwn(HTMLSelectElement.prototype, 'size')?.get };
  const labelControl = { constructor: HTMLLabelElement,
    control: getOwn(HTMLLabelElement.prototype, 'control').get };
  const controlOf = node => {
    for (const control of formControls) {
      if (!nodeTypeOf && !(node instanceof control.constructor)) continue;
      try { return { control, type: control.type.call(node) }; } catch { /* Not this kind of control. */ }
    }
  };
  const isSubmitType = type => /^(submit|image)$/.test(type);
  const labelTarget = node => {
    if (!nodeTypeOf && !(node instanceof labelControl.constructor)) return node;
    try { return labelControl.control.call(node) ?? node; } catch { return node; }
  };
  const isMultiSelect = node => {
    if (!nodeTypeOf && !(node instanceof selectControl.constructor)) return false;
    try { return selectControl.multiple.call(node) || (selectControl.size?.call(node) ?? 0) > 1; } catch { return false; }
  };
  const isEditable = node => { try { return editable.call(node); } catch { return false; } };
  const designModeGetter = getOwn(globalThis.Document?.prototype ?? {}, 'designMode')?.get;
  const inDesignMode = () => { try { return (designModeGetter ? designModeGetter.call(document) : document.designMode) === 'on'; } catch { return false; } };
  const elementsOf = form => {
    const list = [];
    try {
      const collection = formElementsOf ? formElementsOf.call(form) : form.elements;
      const length = collection ? (collectionLength ? collectionLength.call(collection) : collection.length) : 0;
      for (let i = 0; i < length && i < 4096; i++) list.push(collection[i]);
    } catch { /* No readable controls. */ }
    return list;
  };
  // HTML forms.html#the-label-element: an interactive descendant does
  // not forward label activation. This selector limits label forwarding only;
  // it does not give any of these elements a plain-click exception.
  const interactive = 'a[*|href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),label,select,textarea,video[controls]';
  // The form and submit control a click or Enter on this node would submit, if any. Enter in another field
  // submits through the form's default button, the first submit control among form.elements.
  const submission = (node, implicit) => {
    const own = controlOf(node);
    if (!own) return;
    const form = own.control.form.call(node);
    if (!form) return;
    if (isSubmitType(own.type)) return { form, submitter: node };
    if (!implicit || !/^(text|search|tel|url|email|password|date|month|week|time|datetime-local|number|checkbox|radio|range)$/.test(own.type)) return;
    for (const candidate of elementsOf(form)) {
      const other = controlOf(candidate);
      if (other && isSubmitType(other.type)) return { form, submitter: candidate };
    }
    return { form, submitter: undefined };
  };
  // Same-context submissions and multiple-select selection need plain input.
  // New-context submissions keep the modifier that selects a background tab.
  const submits = node => {
    const found = submission(node, false);
    return !!found && sameContext(found.form, submitTarget(found.form, found.submitter));
  };
  const submitTarget = (form, submitter) => {
    const own = submitter && has(submitter, 'formtarget') ? attribute(submitter, 'formtarget') : null;
    return own ?? targetOf(form); // An empty formtarget still overrides: it names the current context.
  };
  const plainControl = node => submits(node) || isMultiSelect(node);
  const retired = new Set(), replacements = [], events = new WeakMap(), masked = new WeakMap(), visibleModifiers = new WeakMap();
  const nativeOpen = window.open, nativePrevent = Event.prototype.preventDefault;
  const composedPath = Event.prototype.composedPath, now = Date.now;
  const prevented = getOwn(Event.prototype, 'defaultPrevented');
  const returnValue = getOwn(Event.prototype, 'returnValue');
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const openedWindows = [];
  const dispatch = EventTarget.prototype.dispatchEvent, elementQueryAll = Element.prototype.querySelectorAll;
  const typeGetter = getOwn(Event.prototype, 'type')?.get, connectedGetter = getOwn(globalThis.Node?.prototype ?? {}, 'isConnected')?.get;
  const eventType = event => typeGetter ? typeGetter.call(event) : event.type;
  const isConnected = node => connectedGetter ? connectedGetter.call(node) : node.isConnected;
  // Script-started openings held since the last agent step, so the result can say so.
  let held = 0, arm;
  // A replaced native keeps the original's name and length and answers Function.prototype.toString with the original's text, and
  // each wrapper is a method (no prototype property), so a page that inspects it sees what it would have seen without the hook.
  const reflectApply = Reflect.apply, nativeToString = Function.prototype.toString;
  const looks = new WeakMap(), looksHas = uncurry(WeakMap.prototype.has), looksGet = uncurry(WeakMap.prototype.get), looksSet = uncurry(WeakMap.prototype.set);
  const look = (wrapper, original) => {
    if (typeof wrapper !== 'function' || typeof original !== 'function') return;
    try {
      defineProperty(wrapper, 'length', { value: original.length, configurable: true });
      defineProperty(wrapper, 'name', { value: original.name, configurable: true });
      looksSet(looks, wrapper, reflectApply(nativeToString, original, []));
    } catch { /* A wrapper that cannot be dressed is still a working wrapper. */ }
  };
  const replace = (object, name, descriptor) => {
    const before = getOwn(object, name);
    if (before) for (const part of ['value', 'get', 'set']) look(descriptor[part], before[part]);
    defineProperty(object, name, descriptor);
    replacements.push(() => {
      const current = getOwn(object, name);
      if (current?.value !== descriptor.value || current?.get !== descriptor.get || current?.set !== descriptor.set) return;
      if (before) defineProperty(object, name, before);
      else delete object[name];
    });
  };
  // Install before page script in every hooked document, including child realms.
  // off() restores only wrappers still owned by this hook, for keep and handoff.
  const NativeDOMException = globalThis.DOMException;
  const NativeSharedWorker = globalThis.SharedWorker, NativeProxy = globalThis.Proxy, nativeConstruct = globalThis.Reflect.construct;
  // Shared workers are not tab descendants in Chromium's Target auto-attach
  // tree. Refuse construction while this tab is being read instead of claiming
  // their independent network target is covered by the tab's Fetch guard.
  if (typeof NativeSharedWorker === 'function') {
    const guarded = new NativeProxy(NativeSharedWorker, { construct(target, args, newTarget) {
      let refused = false;
      if (wholeActive()) { wholeShared++; refused = true; }
      else {
        // A newly created same-origin frame can see its ancestor's active guard
        // before the controller sees the frame. Cross-origin frames are armed
        // through their private CDP routes before their scripts resume.
        let parent = window;
        for (let depth = 0; depth < 64; depth++) {
          try {
            if (parent === parent.parent) break;
            parent = parent.parent;
            const proof = proofFor('wholeWorker');
            if (openAnswer('wholeWorker', proof, parent[key]?.wholeWorker(proof)) === 't') { refused = true; break; }
          } catch { break; }
        }
      }
      if (refused) throw NativeDOMException ? new NativeDOMException('SharedWorker creation is held during a whole read.', 'NotAllowedError') : Error('SharedWorker creation held');
      return nativeConstruct(target, args, newTarget);
    } });
    replace(globalThis, 'SharedWorker', { configurable: true, writable: true, value: guarded });
    replace(NativeSharedWorker.prototype, 'constructor', { configurable: true, writable: true, value: guarded });
  }
  const refuseNativeUI = () => { throw NativeDOMException ? new NativeDOMException('Native UI is blocked while sleight owns this tab; tell the user.', 'NotAllowedError') : Error('Native UI is blocked'); };
  const blockNative = (object, name) => {
    if (!object) return;
    let owner = object;
    while (owner && !getOwn(owner, name)) owner = Object.getPrototypeOf(owner);
    const descriptor = owner && getOwn(owner, name);
    if (typeof descriptor?.value === 'function') replace(owner, name, { ...descriptor,
      value: function (...args) { if (dead) return reflectApply(descriptor.value, this, args); return refuseNativeUI(); } });
  };
  for (const name of ['print', 'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) blockNative(window, name);
  for (const [type, methods] of [
    ['EyeDropper', ['open']], ['Element', ['requestFullscreen', 'webkitRequestFullscreen', 'requestPointerLock']],
    ['HTMLInputElement', ['showPicker']], ['HTMLSelectElement', ['showPicker']],
    ['HTMLVideoElement', ['requestPictureInPicture', 'webkitEnterFullscreen', 'webkitSetPresentationMode']],
    ['DocumentPictureInPicture', ['requestWindow']],
  ]) for (const name of methods) blockNative(globalThis[type]?.prototype, name);
  for (const [object, methods] of [[navigator, ['share', 'registerProtocolHandler']], [navigator?.credentials, ['get', 'create']],
    [navigator?.mediaDevices, ['getUserMedia', 'getDisplayMedia']], [window.documentPictureInPicture, ['requestWindow']]])
    for (const name of methods) blockNative(object, name);
  const nativeBase = getOwn(globalThis.Node?.prototype ?? {}, 'baseURI')?.get;
  const nativeStop = Event.prototype.stopImmediatePropagation;
  const nativeKey = getOwn(KeyboardEvent?.prototype ?? {}, 'key')?.get;
  const nativeSubmitter = getOwn(globalThis.SubmitEvent?.prototype ?? {}, 'submitter')?.get;
  const nativeProtocol = getOwn(URL?.prototype ?? {}, 'protocol')?.get;
  const nativeTest = uncurry(RegExp.prototype.test), nativeLower = uncurry(String.prototype.toLowerCase);
  const nativeClosest = Element.prototype.closest;
  const nativeURL = (node, href) => {
    if (!href) return false;
    try {
      const base = nativeBase ? nativeBase.call(node) : window.location?.href ?? 'https://fixture.invalid/';
      const url = new URL(href, base);
      return !nativeTest(/^(https?|javascript|blob|data|about):$/, nativeProtocol ? nativeProtocol.call(url) : url.protocol);
    } catch { return true; }
  };
  const nativeFormAction = (form, submitter) => {
    const override = submitter && attribute(submitter, 'formaction');
    return nativeURL(form, override == null ? attribute(form, 'action') : override);
  };
  const opensNativeControl = (node, implicit = false) => {
    const target = labelTarget(node), link = nativeMatches.call(target, linkSelector) ? target : nativeClosest?.call(target, linkSelector);
    if (link && nativeURL(link, hrefOf(link))) return true;
    const label = nativeClosest?.call(node, 'label'), control = label ? labelTarget(label) : target;
    const submit = submission(control, implicit);
    if (submit && nativeFormAction(submit.form, submit.submitter)) return true;
    const tag = localNameOf ? localNameOf.call(control) : control.localName;
    const kind = controlOf(control)?.type ?? (tag === 'input' ? nativeLower(attribute(control, 'type') ?? '') : tag);
    return kind === 'file' || kind === 'color' || tag === 'select' && !isMultiSelect(control);
  };
  const nativeUIEvent = event => {
    const type = eventType(event);
    const key = type === 'keydown' ? nativeKey ? nativeKey.call(event) : event.key : '';
    if (type === 'keydown' && key !== 'Enter' && key !== ' ' && key !== 'ArrowDown' && key !== 'F4') return;
    const path = composedPath.call(event);
    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (!isElement(node)) continue;
      // Native picker defaults can also be invoked by a page's own .click().
      const submitter = type === 'submit' ? nativeSubmitter?.call(event) : undefined;
      if (type === 'submit' && (localNameOf ? localNameOf.call(node) : node.localName) === 'form' ? nativeFormAction(node, submitter)
        : opensNativeControl(node, type === 'keydown' && key === 'Enter')) { nativePrevent.call(event); nativeStop.call(event); return; }
    }
  };
  for (const type of ['click', 'auxclick', 'keydown', 'submit']) add.call(window, type, nativeUIEvent, true);
  replacements.push(() => { for (const type of ['click', 'auxclick', 'keydown', 'submit']) remove.call(window, type, nativeUIEvent, true); });
  const live = () => arm && now() < arm.until;
  const active = () => live() && arm.masking;
  // composedPath() from window leaves out nodes inside a closed shadow root, so the arm also matches the outermost closed host (anchorOf, below).
  const onPath = (path, node) => pathIndex(path, node) >= 0;
  const matches = event => event.isTrusted && (path => onPath(path, arm.element) || onPath(path, arm.anchor))(composedPath.call(event));
  // A form watch follows its submit control too: Enter in a field clicks the form's default button.
  const matchesWatch = event => event.isTrusted && ((path => onPath(path, arm.element) || onPath(path, arm.anchor))(composedPath.call(event))
    || !!arm.watch?.submitter && onPath(composedPath.call(event), arm.watch.submitter));
  const hide = (event, modifier) => {
    // The token was bound while this event matched its arm. Retirement changes
    // which new events can be masked, never a retained event's modifier values.
    if (masked.has(event)) return visibleModifiers.get(event) !== modifier && (arm?.token === masked.get(event) || retired.has(masked.get(event)));
    if (!active()) return false;
    if (arm.clicked || !matches(event)) return false;
    masked.set(event, arm.token); visibleModifiers.set(event, arm.modifier); return arm.modifier !== modifier;
  };
  // Read before the masking getters below replace ctrlKey and metaKey. A script-made click picks its disposition (a new
  // window with Shift, a background tab with Ctrl or Meta or the middle button, a download with Alt) from the event itself.
  const mouseGetter = name => getOwn(MouseEvent.prototype, name)?.get;
  const mouseGetters = ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'].map(name => [name, mouseGetter(name)]), buttonGetter = mouseGetter('button');
  const cancelableGetter = getOwn(Event.prototype, 'cancelable')?.get;
  const modifiedClick = event => {
    try {
      if (eventType(event) === 'auxclick') return true;
      for (let i = 0; i < mouseGetters.length; i++) if ((mouseGetters[i][1] ? mouseGetters[i][1].call(event) : event[mouseGetters[i][0]]) === true) return true;
      const button = buttonGetter ? buttonGetter.call(event) : event.button;
      return typeof button === 'number' && button !== 0;
    } catch { return false; /* Not a mouse event: the browser reads no modifier from it. */ }
  };
  const isCancelable = event => { try { return (cancelableGetter ? cancelableGetter.call(event) : event.cancelable) !== false; } catch { return true; } };
  // On macOS a Control click uses the injected Meta as its carrier, keeping the
  // trusted event a left click. Only events bound to that explicit arm expose it
  // as Control. The weak maps preserve the flags on retained events after finish.
  const exposeModifier = (event, name, actual, meta) => !hide(event, name) &&
    (actual || name === 'Control' && visibleModifiers.get(event) === 'Control' && meta());
  for (const name of ['ctrlKey', 'metaKey']) {
    const descriptor = getOwn(MouseEvent.prototype, name);
    replace(MouseEvent.prototype, name, { ...descriptor, get() {
      return exposeModifier(this, name === 'ctrlKey' ? 'Control' : 'Meta', descriptor.get.call(this), () => mouseGetters[3][1].call(this));
    } });
  }
  const modifierState = MouseEvent.prototype.getModifierState;
  replace(MouseEvent.prototype, 'getModifierState', { configurable: true, writable: true, value(name) {
    return name === 'Control' || name === 'Meta'
      ? exposeModifier(this, name, modifierState.call(this, name), () => modifierState.call(this, 'Meta')) : modifierState.call(this, name);
  } });
  // Enter pressed with the modifier held (a keyboard-started link or form) hides it the same way.
  if (globalThis.KeyboardEvent) {
    const keyMeta = getOwn(KeyboardEvent.prototype, 'metaKey').get;
    for (const name of ['ctrlKey', 'metaKey']) {
      const descriptor = getOwn(KeyboardEvent.prototype, name);
      replace(KeyboardEvent.prototype, name, { ...descriptor, get() {
        return exposeModifier(this, name === 'ctrlKey' ? 'Control' : 'Meta', descriptor.get.call(this), () => keyMeta.call(this));
      } });
    }
    const keyModifierState = KeyboardEvent.prototype.getModifierState;
    replace(KeyboardEvent.prototype, 'getModifierState', { configurable: true, writable: true, value(name) {
      return name === 'Control' || name === 'Meta'
        ? exposeModifier(this, name, keyModifierState.call(this, name), () => keyModifierState.call(this, 'Meta')) : keyModifierState.call(this, name);
    } });
  }
  replace(Event.prototype, 'preventDefault', { configurable: true, writable: true, value() {
    const record = events.get(this);
    if (record && this.cancelable !== false) record.cancelled = true;
    const result = nativePrevent.call(this);
    if (!record && (this.isTrusted || eventType(this) === probeType)) forward(this);
    return result;
  } });
  replace(Event.prototype, 'defaultPrevented', { ...prevented, get() {
    return events.has(this) ? events.get(this).cancelled : prevented.get.call(this);
  } });
  replace(Event.prototype, 'returnValue', { ...returnValue, get() {
    return events.has(this) ? !events.get(this).cancelled : returnValue.get.call(this);
  }, set(value) {
    const record = events.get(this);
    if (record && !value && this.cancelable !== false) record.cancelled = true;
    const result = returnValue.set.call(this, value);
    // Setting it false cancels like preventDefault: a hooked realm's setter tells every hook that can reach the event.
    if (!record && !value && (this.isTrusted || eventType(this) === probeType)) forward(this);
    return result;
  } });
  const cancelEvent = event => { const record = events.get(event); if (record && event.cancelable !== false) record.cancelled = true; };
  // A new window's first document runs no hook yet, and a function the page takes from it now stays native.
  // Run the whole hook in it before the handle reaches the page; if that realm cannot be reached or its
  // policy forbids eval, at least forward its preventDefault.
  const coverInitialDocument = opened => {
    try {
      const prototype = opened.Event.prototype, original = prototype.preventDefault;
      defineProperty(prototype, 'preventDefault', { configurable: true, writable: true, value() {
        const result = original.apply(this, arguments);
        cancelEvent(this);
        return result;
      } });
    } catch { /* Cross-origin: nothing readable to cancel with. */ }
  };
  // The install source carries the key and the secret, so it goes to a window's eval once, and only for a window not
  // already hooked. A window offered it before (the page got another handle to it by name) is never offered it again:
  // by then page scripts may have replaced its eval, which would read the secret.
  const offered = new WeakSet(), wasOffered = uncurry(WeakSet.prototype.has), offer = uncurry(WeakSet.prototype.add);
  const installInto = opened => {
    if (hooked(opened)) return;
    let fresh = false;
    try { fresh = !wasOffered(offered, opened); if (fresh) offer(offered, opened); } catch { /* Not an object a set can hold. */ }
    if (fresh) try { opened.eval(installSource); } catch { /* Cross-origin, or a policy that forbids eval. */ }
    if (!hooked(opened)) coverInitialDocument(opened);
  };
  const open = { open(url, target, features) {
    if (wholeBlock('new tab')) return null;
    // Explicit selection modifiers never authorize a page handler to open a window.
    if (live() && arm.modifier) { held++; if (shield?.token === arm.token) shield.violation ??= changedReason; return null; }
    if (/^_(self|parent|top)$/i.test(String(target))) return nativeOpen.apply(this, arguments);
    if (!active() || !navigator.userActivation?.isActive) { held++; return null; }
    const kept = String(features ?? '').split(',').map(value => value.trim()).filter(value => /^(noopener|noreferrer)(?:=|$)/i.test(value));
    const opened = nativeOpen.call(this, url, target, kept.join(','));
    if (opened) { openedWindows.push(opened); installInto(opened); }
    return opened;
  } }.open;
  replace(window, 'open', { configurable: true, writable: true, value: open });
  for (const name of ['alert', 'confirm', 'prompt']) {
    const original = window[name];
    replace(window, name, { configurable: true, writable: true, value() {
      if (wholeBlock('dialog')) return undefined;
      return original.apply(this, arguments);
    } });
  }
  for (const name of ['pushState', 'replaceState', 'go', 'back', 'forward']) {
    const original = globalThis.History?.prototype?.[name];
    if (typeof original === 'function') replace(globalThis.History.prototype, name, { configurable: true, writable: true, value() {
      if (wholeBlock('navigation')) return;
      return original.apply(this, arguments);
    } });
  }
  const keyEvent = event => {
    if (!live() || !event.isTrusted || !['Control', 'Meta'].includes(event.key)) return;
    if (event.key === arm.modifier) { if (event.type === 'keydown' && !arm.clicked) arm.masking = true; return; }
    // Playwright restores its modifiers after dispatch; our explicit release
    // may send another keyup. Keep both hidden until this arm finishes.
    if (event.type === 'keyup' && arm.modifiers.has(event.key)) { event.stopImmediatePropagation(); return; }
    if (event.type === 'keydown' && !arm.clicked) { arm.masking = true; arm.modifiers.add(event.key); }
    if (!active()) return;
    event.stopImmediatePropagation();
  };
  const baseTarget = (doc = document) => {
    const base = query(doc, 'base[target]');
    return base ? attribute(base, 'target') : '';
  };
  const targetOf = element => attribute(element, 'target') ?? baseTarget(docOf(element));
  // Child windows by index: WindowProxy indexed properties cannot be redefined by a page.
  const childWindows = context => {
    const list = [];
    for (let i = 0, frames; i < 256; i++) {
      let child;
      try { child = (frames ??= framesOf(context))[i]; } catch { break; }
      if (!child) break;
      list.push(child);
    }
    return list;
  };
  const readable = context => { try { return !!context.document; } catch { return false; } };
  // A frame element's name attribute names its window only while the window still carries that name: script can rename the
  // window (frame.contentWindow.name = 'x') without touching the attribute, and then a link to the old name opens a new
  // window. An unreadable (cross-origin) frame keeps the name the attribute gave it.
  const frameWindowGetters = [globalThis.HTMLIFrameElement, globalThis.HTMLFrameElement].map(type => getOwn(type?.prototype ?? {}, 'contentWindow')?.get).filter(Boolean);
  const namesFrame = (frame, target) => {
    try {
      for (let i = 0; i < frameWindowGetters.length; i++) {
        let child;
        try { child = frameWindowGetters[i].call(frame); } catch { continue; /* Not this class of frame. */ }
        if (child && readable(child)) return nameOf(child) === target;
        break;
      }
    } catch { /* Cross-origin: the attribute stands. */ }
    return true;
  };
  // Resolved from the element's own window, so a native taken from another realm decides the same way.
  const sameContext = (element, target = targetOf(element)) => {
    // The HTML spec checks `_blank` before names, so window.name = '_blank' cannot make it current.
    if (/^_blank$/i.test(target)) return false;
    const view = viewOf(element);
    if (!target || /^_(self|parent|top)$/i.test(target) || target === nameOf(view)) return true;
    // A window the page opened by name is not the current context: navigating it by link raises it.
    // Indexed WindowProxy children remain traversable across origins, while
    // names and documents are readable only where same-origin access permits.
    const seen = new Set(), pending = [view.top ?? view];
    while (pending.length) {
      const context = pending.pop();
      if (!context || seen.has(context)) continue;
      seen.add(context);
      try { if (nameOf(context) === target) return true; } catch { /* Cross-origin name. */ }
      try {
        for (const frame of queryAll(context.document, 'iframe[name],frame[name]'))
          if (attribute(frame, 'name') === target && namesFrame(frame, target)) return true;
      } catch { /* Cross-origin document. */ }
      // A same-origin page can shadow named access with its own property; a cross-origin one cannot.
      let named;
      try { if (!readable(context) || !getOwn(context, target)) named = framesOf(context)[target]; } catch { /* Cross-origin named access. */ }
      for (const child of childWindows(context)) {
        if (named && child === named) return true;
        pending.push(child);
      }
    }
    try {
      for (const frame of queryAll(docOf(element), 'iframe[name],frame[name]'))
        if (attribute(frame, 'name') === target && namesFrame(frame, target)) return true;
    } catch { /* No document to search. */ }
    return false;
  };
  // preventDefault from another realm sets the same native flag, so it is invisible here unless that
  // realm is hooked too: a hooked realm forwards the call to every hook it can reach (forward/cancel).
  // Every same-origin window this page reaches counts, including handles from window.open and the opener.
  const probeType = 'sleight.probe';
  // A frame the page later removes keeps its way back to the owner that was its parent when it was hooked.
  const home = [window.parent, window.top];
  const realms = () => {
    const seen = new Set([window]), found = [], pending = [window.top, window.parent, ...home, ...childWindows(window), ...openedWindows];
    try { const opener = openerGetter?.call(window); if (opener) pending.push(opener); } catch { /* No opener. */ }
    for (let steps = 0; pending.length && steps < 512; steps++) {
      const context = pending.pop();
      if (!context || seen.has(context)) continue;
      seen.add(context);
      if (readable(context)) {
        found.push(context);
        try { pending.push(context.top, context.parent, openerGetter?.call(context)); } catch { /* Unreadable. */ }
      }
      pending.push(...childWindows(context));
    }
    return found;
  };
  const forward = event => { for (const context of realms()) try { context[key]?.cancel(proofFor('cancel'), event); } catch { /* Not a hook. */ } };
  // A realm is hooked when its preventDefault reaches this hook. A page cannot fake that without the native
  // function, which only an unhooked realm still holds.
  const hooked = context => {
    try {
      const canary = new Event(probeType, { cancelable: true }), record = { cancelled: false };
      events.set(canary, record);
      context.Event.prototype.preventDefault.call(canary);
      return record.cancelled;
    } catch { return false; }
  };
  const otherRealm = () => realms().some(context => !hooked(context));
  // Script-initiated openings (a timer, a later event) carry no agent modifier, so the browser
  // would raise the new tab. Refuse them unless an agent click is being dispatched.
  const holdsNewContext = node => {
    try {
      node = labelTarget(node);
      if (nativeMatches.call(node, linkSelector)) return !has(node, 'download') && !sameContext(node);
      const found = submission(node, false);
      if (found) return !sameContext(found.form, submitTarget(found.form, found.submitter));
    } catch { return isElement(node); /* Undecidable for an element: hold it. */ }
    return false;
  };
  // The node itself or the nearest link or control above it (shadow trees included) decides.
  const holdsChain = node => {
    for (const candidate of ancestors(node)) {
      let hit = false;
      try { hit = nativeMatches.call(candidate, controlSelector); } catch { /* Not an element. */ }
      if (hit) return holdsNewContext(candidate);
    }
    return false;
  };
  const holdsForm = (form, submitter) => {
    try { return !sameContext(form, submitTarget(form, submitter)); }
    catch { return true; }
  };
  // Enter in this control submits a form into a new context (the form's, or its default button's formtarget).
  // A form whose target cannot be decided counts as new-context.
  const opensForm = node => {
    try {
      const found = submission(node, true);
      return !!found && !sameContext(found.form, submitTarget(found.form, found.submitter));
    } catch { return true; }
  };
  // A modified or non-primary synthetic click (Shift, Ctrl, Meta, Alt, the middle button, auxclick) on a link, an image-map
  // area or a submit control: the browser opens it in a new window or tab, or downloads it, whatever the link's own target says.
  const activates = node => {
    try {
      node = labelTarget(node);
      if (nativeMatches.call(node, linkSelector)) return true;
      return !!submission(node, false);
    } catch { return isElement(node); /* Undecidable for an element: hold it. */ }
  };
  const activatesChain = node => {
    for (const candidate of ancestors(node)) {
      let hit = false;
      try { hit = nativeMatches.call(candidate, controlSelector); } catch { /* Not an element. */ }
      if (hit) return activates(candidate);
    }
    return false;
  };
  // A script-started click or submit the hook let through because it looked like it stays in this context (outside an agent
  // click). A listener can still change where it goes before the browser acts, and no microtask runs in between, so the
  // setters a page uses to do that (window.name, target, formtarget, setAttribute) check again at once and cancel the event
  // that is still being dispatched. { node } for a link, { form, submitter } for a submit; events fills in as they are seen.
  let scripted;
  const pushEvent = uncurry(Array.prototype.push);
  const flipped = () => {
    const current = scripted;
    if (!current || current.cancelled || active()) return;
    try {
      if (!current.events.length || !(current.form ? holdsForm(current.form, current.submitter) : holdsNewContext(current.node))) return;
      // Only an event that can be cancelled can be stopped; the backstop reports a tab that opens anyway.
      let stopped = false;
      for (let i = 0; i < current.events.length; i++) if (isCancelable(current.events[i])) { nativePrevent.call(current.events[i]); stopped = true; }
      if (stopped) { current.cancelled = true; held++; }
    } catch { /* Undecided: the backstop reports a tab that opened. */ }
  };
  const trackable = node => {
    for (const candidate of ancestors(node)) {
      let hit = false;
      try { hit = nativeMatches.call(candidate, controlSelector); } catch { /* Not an element. */ }
      if (!hit) continue;
      const target = labelTarget(candidate);
      if (nativeMatches.call(target, linkSelector)) return { node: target };
      const found = submission(target, false);
      return found ? { form: found.form, submitter: found.submitter } : undefined;
    }
  };
  // The setters of another window or frame that runs this hook can re-aim this window's link too (Element.prototype.setAttribute
  // taken from an iframe's realm). While a script click is in flight here, every other hook is told, and tells this one when it sees such a change.
  let outer = false;
  const tellRealms = (method, argument) => {
    try { for (const context of realms()) try { context[key]?.[method](proofFor(method), argument); } catch { /* Not a hook. */ } } catch { /* No other windows. */ }
  };
  const scriptStarted = (tracked, events, run) => {
    if (!tracked || active()) return run();
    const before = scripted;
    scripted = { ...tracked, events };
    tellRealms('watching', true);
    try { return run(); } finally { scripted = before; tellRealms('watching', false); }
  };
  const flip = () => { if (scripted) flipped(); else if (outer) tellRealms('changed'); };
  const trackNode = node => { try { return trackable(node); } catch { return undefined; } };
  // Script entry points that open a context without an agent click. Held outside agent dispatch.
  const hold = (constructor, name, holds, track) => {
    const native = constructor?.prototype?.[name];
    if (typeof native === 'function') replace(constructor.prototype, name, { configurable: true, writable: true, value() {
      if ((name === 'submit' || name === 'requestSubmit') && wholeBlock('submit')) { if (name === 'submit') wholeSubmit++; else wholeRequestSubmit++; return; }
      if (!dead && name === 'click' && opensNativeControl(this)) return refuseNativeUI();
      if (!dead && (name === 'submit' || name === 'requestSubmit') && nativeFormAction(this, arguments[0])) return refuseNativeUI();
      if (active() || !holds.apply(this, arguments)) return scriptStarted(track?.apply(this, arguments), [], () => native.apply(this, arguments));
      held++;
    } });
  };
  hold(globalThis.HTMLElement, 'click', function() { return holdsChain(this); }, function() { return trackNode(this); });
  hold(globalThis.HTMLFormElement, 'submit', function() { return holdsForm(this); });
  hold(globalThis.HTMLFormElement, 'requestSubmit', function(submitter) { return holdsForm(this, submitter); }, function(submitter) { return { form: this, submitter }; });
  // The window-level guard below never sees a click dispatched on a detached element, or one inside a shadow
  // tree (a closed root hides its inside from composedPath). Refuse those here instead of dispatching: a
  // listener registered first could otherwise stop a cancel. A click that cannot be cancelled is held here too: the
  // guard's preventDefault would do nothing to it. A modified or auxiliary click on a link or submit control is held
  // wherever it is, even inside an agent click's own handler. Realm-independent: brand checks, no instanceof.
  if (typeof dispatch === 'function') replace(EventTarget.prototype, 'dispatchEvent', { configurable: true, writable: true, value(event) {
    if (!dead && event && isElement(this) && (eventType(event) === 'click' || eventType(event) === 'auxclick') && opensNativeControl(this)) return refuseNativeUI();
    let tracked;
    try {
      if (event && !event.isTrusted && isElement(this)) {
        const type = eventType(event);
        if (type === 'click' || type === 'auxclick') {
          if (modifiedClick(event) ? activatesChain(this)
            : !active() && type === 'click' && (!inDocument(this) || !isCancelable(event)) && holdsChain(this)) { held++; return false; }
          if (!active() && type === 'click') tracked = trackNode(this);
        }
      }
    } catch { /* Not an event or element: the native call reports it. */ }
    return tracked ? scriptStarted(tracked, [event], () => dispatch.apply(this, arguments)) : dispatch.apply(this, arguments);
  } });
  // The setters a page uses to change where a link or form goes. After each, a script-started click or submit that is still
  // being dispatched is checked again (flipped); the agent's own click is watched by the observer and the name setter below.
  for (const [constructor, name] of [[globalThis.HTMLAnchorElement, 'target'], [globalThis.HTMLAreaElement, 'target'], [globalThis.HTMLFormElement, 'target'],
    [globalThis.HTMLBaseElement, 'target'], [globalThis.HTMLButtonElement, 'formTarget'], [globalThis.HTMLInputElement, 'formTarget'], [globalThis.Attr, 'value'],
    // An Attr is also written through the Node setters, and a frame named as a target stops naming it when its owner's markup goes.
    [Node, 'nodeValue'], [Node, 'textContent'], [Element, 'innerHTML'], [Element, 'outerHTML']]) {
    const descriptor = getOwn(constructor?.prototype ?? {}, name);
    if (descriptor?.set && descriptor.configurable) replace(constructor.prototype, name, { ...descriptor, set(value) {
      const result = descriptor.set.call(this, value);
      flip();
      return result;
    } });
  }
  for (const [owner, name] of [[Element.prototype, 'setAttribute'], [Element.prototype, 'removeAttribute'], [Element.prototype, 'toggleAttribute'],
    [Element.prototype, 'setAttributeNS'], [Element.prototype, 'setAttributeNode'], [Element.prototype, 'setAttributeNodeNS'],
    [globalThis.NamedNodeMap?.prototype, 'setNamedItem'], [globalThis.NamedNodeMap?.prototype, 'setNamedItemNS'],
    [globalThis.NamedNodeMap?.prototype, 'removeNamedItem'], [globalThis.NamedNodeMap?.prototype, 'removeNamedItemNS'], [Element.prototype, 'removeAttributeNode'],
    // A frame whose name was the target goes away: the name then means a new window.
    [Node?.prototype, 'removeChild'], [Node?.prototype, 'replaceChild'], [Element.prototype, 'remove'], [Element.prototype, 'replaceWith'],
    [Element.prototype, 'replaceChildren'], [Document?.prototype, 'replaceChildren'], [DocumentFragment?.prototype, 'replaceChildren']]) {
    const native = owner?.[name];
    if (typeof native === 'function') replace(owner, name, { configurable: true, writable: true, value() {
      const result = native.apply(this, arguments);
      flip();
      return result;
    } });
  }
  // A top-level window the page opened is raised by focus(); a frame is not. Nothing here needs the page to take focus.
  const focusOwner = getOwn(window, 'focus') ? window : globalThis.Window?.prototype;
  const nativeFocus = focusOwner?.focus;
  if (focusOwner && typeof nativeFocus === 'function') replace(focusOwner, 'focus', { configurable: true, writable: true, value() {
    let topLevel = true;
    try { const subject = this ?? window; topLevel = subject.top === subject; } catch { /* Unreadable: treat as raisable. */ }
    return topLevel ? undefined : nativeFocus.apply(this, arguments);
  } });
  // A dispatched click (not a user's) on a connected link or submit control.
  const guard = event => {
    if (event.isTrusted) return;
    if (scripted) pushEvent(scripted.events, event);
    const modified = modifiedClick(event);
    if (!modified && active()) return;
    for (const node of composedPath.call(event)) {
      let hit = false;
      try { hit = isElement(node) && nativeMatches.call(node, controlSelector); } catch { /* Not an element. */ }
      if (hit) { if (modified ? activates(node) : holdsNewContext(node)) { held++; nativePrevent.call(event); } return; }
    }
  };
  const linkState = element => {
    if (!element || !isLinkTag(element) || !hasHref(element) || has(element, 'download')) return;
    if (sameContext(element)) return;
    let url;
    try { url = new URL(hrefOf(element), document.baseURI); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const target = targetOf(element);
    const rel = attribute(element, 'rel') ?? '';
    return { url: url.href, target, rel, signature: stringify([url.href, target, rel]) };
  };
  const pointerEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const handlerNames = [...pointerEvents, 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keyup'];
  const handlerGetters = handlerNames.map(name => [name, getOwn(HTMLElement.prototype, 'on' + name)?.get]);
  const handlerText = fn => typeof fn === 'function' ? reflectApply(nativeToString, fn, []) : '';
  const opensWindow = text => /\bopen\s*(?:\(|\[)/.test(text);
  const openListeners = new WeakMap();
  // Remember visible window.open listeners before the page can hide their source. Object options stay
  // conservative after removal, since reading capture again could call a page getter or see a changed value.
  const rememberListener = (node, type, listener, options) => {
    if (handlerNames.includes(type) && (typeof listener === 'object' && listener !== null || opensWindow(handlerText(listener)))) {
      const rows = openListeners.get(node) ?? [];
      rows.push({ type, listener, capture: typeof options === 'object' && options !== null ? options : !!options });
      openListeners.set(node, rows);
    }
  };
  replace(EventTarget.prototype, 'removeEventListener', { configurable: true, writable: true, value(type, listener, options) {
    const result = remove.apply(this, arguments), rows = openListeners.get(this);
    if (rows && (options === undefined || typeof options === 'boolean')) openListeners.set(this,
      rows.filter(row => row.type !== type || row.listener !== listener || row.capture !== !!options));
    return result;
  } });
  const registeredOpen = node => !!openListeners.get(node)?.length;
  const openHandler = node => handlerGetters.some(([name, get]) =>
    opensWindow(attribute(node, 'on' + name) ?? '') || opensWindow(handlerText(get ? get.call(node) : node['on' + name]))) || registeredOpen(node);
  const modifierControl = node => {
    const tag = nameOfElement(node), role = attribute(node, 'role') ?? '';
    return isLinkTag(node) && hasHref(node) || labelTarget(node) !== node ||
      /^(button|input|select|option|textarea|label|iframe|object|embed|frame|fencedframe|details|summary)$/.test(tag) ||
      /^(audio|video)$/.test(tag) && has(node, 'controls') || tag === 'img' && has(node, 'usemap') || isEditable(node) ||
      /^(button|link|checkbox|radio|switch|textbox|searchbox|combobox|slider|spinbutton|scrollbar|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|gridcell)$/.test(role);
  };
  const shadowRootGetter = getOwn(Element.prototype, 'shadowRoot')?.get;
  const fragmentQueryAll = globalThis.DocumentFragment?.prototype.querySelectorAll;
  const nodeListLength = getOwn(NodeList?.prototype ?? {}, 'length')?.get;
  // Check both the forwarding chain and every possible descendant hit, including open shadow roots.
  // The page's option/listbox roles remain available for selection through its own handlers.
  const refusesModifier = element => {
    try {
      if (registeredOpen(document) || registeredOpen(window)) return true;
      if (ancestors(element).some(node => modifierControl(node) || openHandler(node))) return true;
      const roots = [element]; let count = 0;
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i], list = root === element ? elementQueryAll.call(root, '*') : fragmentQueryAll.call(root, '*');
        const length = nodeListLength ? nodeListLength.call(list) : list.length;
        for (let index = -1; index < length; index++) {
          const node = index < 0 ? root : list[index];
          if (++count > 4096 || isElement(node) && (modifierControl(node) || openHandler(node))) return true;
          const shadow = isElement(node) && (shadowRootGetter ? shadowRootGetter.call(node) : node.shadowRoot);
          if (shadow) roots.push(shadow);
        }
      }
      return false;
    } catch { return true; }
  };
  // A link that would open a new context, whether or not sleight can decide where.
  const opensLink = element => isLinkTag(element) && hasHref(element) && !has(element, 'download') && !sameContext(element);
  // Cancel the browser's own open and keep the request for the background tab. Inline handlers that return false
  // are read at dispatch, after pointer handlers may have changed them; a browser cancels internally when one
  // does, so observe that return without calling the handler a second time.
  const engage = (event, link) => {
    const record = { ...link, cancelled: prevented.get.call(event), event };
    events.set(event, record); arm.request = record;
    nativePrevent.call(event);
    // Every node on the event's path, so an inline handler on a descendant of the checked element (a span inside the
    // link) counts too, beside the checked element's own ancestors, the document and the window.
    const seen = new Set();
    let path = [];
    try { path = composedPath.call(event); } catch { /* Not dispatching. */ }
    for (const node of [...path, ...ancestors(arm.element), document, window]) {
      if (!node || typeof node !== 'object' && typeof node !== 'function' || seen.has(node)) continue;
      seen.add(node);
      let before;
      try { before = node.onclick; } catch { continue; }
      let wrapper = before;
      if (typeof before === 'function') {
        wrapper = function(event) {
          const result = before.apply(this, arguments);
          if (result === false && events.has(event)) events.get(event).cancelled = true;
          return result;
        };
        node.onclick = wrapper;
      }
      arm.handlers.push({ node, before, wrapper });
    }
  };
  // The event is still being dispatched: stop the browser acting on it, and tell the agent.
  const block = reason => {
    arm.blocked = reason;
    for (const event of [arm.clicked, arm.submit]) if (event) try { nativePrevent.call(event); } catch { /* Not an event. */ }
  };
  // A listener can change a same-context link's or form's target after the agent decided it was plain
  // (including a flip in the link's own click handler). Decide again from what the page has now.
  const recheck = () => {
    if (!arm?.watch || arm.done || arm.blocked || !arm.clicked) return;
    const { kind, element, form, submitter } = arm.watch;
    try {
      if (kind === 'form') { if (holdsForm(form, submitter)) block('form'); return; }
      if (arm.link) return;
      const link = linkState(element);
      if (link) { arm.link = link; engage(arm.clicked, link); }
      else if (opensLink(element)) block('link');
    } catch { block(kind); }
  };
  const capture = event => {
    if (!live() || !arm.watch && arm.clicked || !(arm.watch ? matchesWatch(event) : matches(event))) return;
    if (active()) { masked.set(event, arm.token); visibleModifiers.set(event, arm.modifier); }
    // Bind the mask during dispatch, while composedPath still identifies the prepared element. A deferred
    // handler may first read modifiers much later. Only the click starts the dispatch window.
    if (eventType(event) !== 'click') return;
    arm.clicked = event;
    // A task queued by the capture listener runs after synchronous dispatch,
    // even when a page stops propagation. Keep the arm for takeRequest.
    const current = arm, endDispatch = () => { if (arm === current) { arm.masking = false; arm.done = true; } };
    clearTimeout(arm.dispatchTimer);
    arm.dispatchTimer = setTimeout(endDispatch, 0);
    // A page task at the highest priority (scheduler.postTask 'user-blocking') can run before a timer. This one is
    // queued first, so it ends the dispatch before any such page task.
    try { postTask?.(endDispatch, { priority: 'user-blocking' }); } catch { /* The timer ends it. */ }
    if (arm.watch) { arm.done = false; recheck(); return; }
    if (!arm.link) return;
    engage(event, arm.link);
  };
  const submitted = event => {
    if (wholeBlock('submit')) { nativePrevent.call(event); stopNow(event); return; }
    if (scripted?.form) try {
      const path = composedPath.call(event);
      for (let i = 0; i < path.length; i++) if (path[i] === scripted.form) { pushEvent(scripted.events, event); break; }
    } catch { /* Not an event. */ }
    if (!live() || arm.watch?.kind !== 'form' || arm.done) return;
    try { if (composedPath.call(event).includes(arm.watch.form)) { arm.submit = event; recheck(); } } catch { /* Not an event. */ }
  };
  // A change that can re-aim a link or form: what the agent's click is watching, and a script click still in flight.
  const changed = () => { recheck(); flipped(); };
  // window.name decides which window a named target means, and a name has no attribute for the observer to see. Setting it
  // (in this window or a frame or window the page reached that runs this hook) checks again at once, in every hook that can
  // reach this one, because a listener can rename a window while the browser is still about to follow the link.
  const nameDescriptor = getOwn(window, 'name');
  if (nameDescriptor?.set && nameDescriptor.configurable) replace(window, 'name', { ...nameDescriptor, set(value) {
    const result = nameDescriptor.set.call(this, value);
    changed();
    tellRealms('changed');
    return result;
  } });
  const watchChanges = () => {
    if (!NativeObserver) return;
    // Attributes anywhere (a link, a form, its submit control) and nodes added or removed (a <base>): any change
    // makes the watch decide again, in the microtask after the listener that made it.
    arm.observer = new NativeObserver(changed);
    const options = { subtree: true, childList: true, attributes: true, attributeFilter: ['target', 'href', 'rel', 'download', 'formtarget', 'form', 'name'] };
    nativeObserve.call(arm.observer, document, options);
    // A document observer does not see inside a shadow root, closed or open. A control in one is watched through each root
    // on the way up to the document (a flip made in the control's own root is then seen like one in the page).
    try {
      for (let node = arm.element, depth = 0; node && depth < 1000; depth++) {
        const root = rootOf(node);
        let host;
        try { host = shadowHost(root); } catch { break; }
        nativeObserve.call(arm.observer, root, options);
        node = host;
      }
    } catch { /* A root that cannot be observed leaves the document observer. */ }
  };
  // AD1 dispatch guard. The click that lands must be the click that was classified. backgroundClick seals
  // what the checked element activates (itself, its label's control, its image map's areas) once hover has
  // settled; every trusted press, release and click is then cancelled if that changed or landed elsewhere.
  // Natives are captured here, before page scripts, and registered first so no page listener runs earlier.
  //
  // The check fails closed. It calls only natives captured here, uncurried so no page-visible lookup happens
  // (no Function.prototype.call, Array, String, RegExp or Math method, no Symbol.hasInstance, no own property
  // on an element or event). Classes are told apart by a native getter's brand check, not by instanceof, and
  // no page value ever builds a selector. If anything in the check throws, the input is cancelled.
  //
  // What the seal covers: each node's words, attributes, form owner and that form's controls, plus the
  // document's base URL, URL and base target (a relative action or href resolves through them). Trusted input
  // that arrives after the soft cap (capMs) is cancelled, not passed; a separate hard cap (4 x capMs + 5 s) only
  // drops a shield nobody finished. Every other frame is armed as foreign from Node (frameShield): any trusted press or
  // click in it is cancelled, because the sealed element is not there; a same-origin frame created while armed arms
  // itself at document start. document.open() and document.write erase a window's listeners, so they are wrapped to
  // add them again, and `reinstall` does the same on request.
  //
  // Key-shield API (window[key], the key the controller passed to popupHook), for callers that send trusted input.
  // Every method takes a proof from hookProof(hook, method) as its first argument, one proof per call; the rest follow:
  //   guard(proof, element, token, capMs, { keys, press }) seals what activating `element` touches and arms the shield for
  //     capMs; { keys: true } also vetoes keydown, keypress, keyup and submit events (the form's action, method,
  //     target, enctype, novalidate and the default submitter's own attributes are in the seal; a key event must
  //     reach the field itself, a submit event must name the sealed submitter; after the first activation keydown only the
  //     routing facts must still match, see `routing`). { press: true } lets the click the
  //     browser makes on the form's default button count as landing on `element` without checking key events, and
  //     the landed check is not made for it (a key press may produce no click). Returns false if it cannot arm.
  //   verdict(proof, token) returns the veto reason, or undefined if every guarded event matched the seal.
  //   finish(proof, token) disarms and returns the veto reason, or true.
  //   expect(proof, token, evidence) compares the digests of what the rules read with the seal: true, or a veto reason.
  //   conclude(proof, token) is finish with { bad, landed, passed }: landed is false if no trusted press or click
  //     reached the sealed element's document, undefined if the shield is gone (the document changed); passed is true
  //     if any guarded event was delivered to the page's listeners (false: the page saw no press, release or click).
  //   adopt(proof, token, capMs, keys) arms this frame as foreign; release(proof, token) disarms it and returns its
  //     veto, if any; armed(proof) tells a new child frame what its parent holds; reinstall(proof) re-adds the
  //     listeners and confirms them.
  //   changed(proof) and watching(proof, on) are the hook's calls to the hooks of other windows and frames it can reach (a
  //     window.name or attribute change in one can re-aim a link another is watching); they return nothing.
  //   The key path (backgroundClick with keys) also uses: lock(proof, token, capMs) vetoes every trusted key and press in a
  //     frame that does not hold the checked element (a foreign shield with a different message), resync(proof, token, capMs)
  //     restores the listeners a reused window lost and locks the document if the checked element is not in it, tree(proof)
  //     lists this window and every window below it that script can reach as { id, n, fresh } (fresh: the hook was there before
  //     the document's first script), and lockAll, resyncAll and finishAll(proof, token) do the same walk for lock, resync and
  //     release. A call this hook makes to another window's hook carries a proof and checks the signed answer, like the controller.
  //   flight(proof) is a new frame's or window's question to the hooks above it: is a script-started click being dispatched there? (boolean)
  const getter = (type, name) => {
    const get = getOwn(type?.prototype ?? {}, name)?.get;
    return get ? uncurry(get) : () => { throw Error('native ' + name + ' unavailable'); };
  };
  const textOf = getter(globalThis.Node, 'textContent'), shieldNameOf = getter(Element, 'localName'), connected = getter(globalThis.Node, 'isConnected');
  const parentElementOf = getter(globalThis.Node, 'parentElement'), listLength = getter(globalThis.NodeList, 'length'), typeOf = getter(Event, 'type');
  const shadowMode = getter(globalThis.ShadowRoot, 'mode'), shadowHost = getter(globalThis.ShadowRoot, 'host');
  const labelOf = getter(HTMLLabelElement, 'control'), baseURIOf = getter(globalThis.Node, 'baseURI'), urlOf = getter(globalThis.Document, 'URL');
  const submitterOfEvent = getter(globalThis.SubmitEvent, 'submitter');
  const controlGetters = [HTMLButtonElement, HTMLInputElement, globalThis.HTMLTextAreaElement, HTMLSelectElement].map(type => [getter(type, 'form'), getter(type, 'type')]);
  const rootOf = uncurry(globalThis.Node?.prototype.getRootNode), queryElementAll = uncurry(Element.prototype.querySelectorAll), closest = uncurry(Element.prototype.closest);
  const queryDocAll = uncurry(globalThis.Document?.prototype.querySelectorAll), queryFragAll = uncurry(globalThis.DocumentFragment?.prototype.querySelectorAll);
  const attrNS = uncurry(getAttributeNS), attr = uncurry(getAttribute), hasAttr = uncurry(hasAttribute), matchesNode = uncurry(nativeMatches), slice = uncurry(String.prototype.slice), charCodeAt = uncurry(String.prototype.charCodeAt);
  const stopNow = uncurry(Event.prototype.stopImmediatePropagation), cancel = uncurry(nativePrevent), pathOf = uncurry(composedPath);
  const scrollInto = uncurry(Element.prototype.scrollIntoView), rectOf = uncurry(Element.prototype.getBoundingClientRect), pointHit = uncurry(globalThis.Document?.prototype.elementFromPoint), styleOf = window.getComputedStyle?.bind(window), nativeTimeout = setTimeout, nativeClear = clearTimeout, nativeFrame = window.requestAnimationFrame?.bind(window);
  const imul = Math.imul, ids = new WeakMap(), idsHas = uncurry(WeakMap.prototype.has), idsGet = uncurry(WeakMap.prototype.get), idsSet = uncurry(WeakMap.prototype.set);
  // Proofs. SHA-256 and HMAC written with typed arrays and operators only: a page cannot reach any step of them.
  // The constants come from the cube roots of the first 64 primes, the start state from the square roots of the first 8.
  const sha = (() => {
    const K = new Uint32Array(64), IV = new Uint32Array(8), floor = Math.floor, pow = Math.pow;
    for (let n = 2, found = 0; found < 64; n++) {
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (!prime) continue;
      const fraction = (value) => (value - floor(value)) * 4294967296;
      K[found] = floor(fraction(pow(n, 1 / 3)));
      if (found < 8) IV[found] = floor(fraction(pow(n, 1 / 2)));
      found++;
    }
    const w = new Uint32Array(64), h = new Uint32Array(8);
    // bytes holds `length` message bytes (a typed array with room to spare); only the count passed in is used.
    return (bytes, length) => {
      const total = ((length + 9 + 63) >> 6) << 6, data = new Uint8Array(total);
      for (let i = 0; i < length; i++) data[i] = bytes[i];
      data[length] = 0x80;
      const bits = length * 8;
      data[total - 4] = bits >>> 24; data[total - 3] = bits >>> 16; data[total - 2] = bits >>> 8; data[total - 1] = bits;
      for (let i = 0; i < 8; i++) h[i] = IV[i];
      for (let offset = 0; offset < total; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = (data[offset + 4 * i] << 24) | (data[offset + 4 * i + 1] << 16) | (data[offset + 4 * i + 2] << 8) | data[offset + 4 * i + 3];
        for (let i = 16; i < 64; i++) {
          const x = w[i - 15], y = w[i - 2];
          w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], q = h[7];
        for (let i = 0; i < 64; i++) {
          const t1 = (q + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
          const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
          q = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += q;
      }
      const digest = new Uint8Array(32);
      for (let i = 0; i < 32; i++) digest[i] = h[i >> 2] >>> (24 - 8 * (i & 3));
      return digest;
    };
  })();
  const hexDigits = '0123456789abcdef';
  // HMAC-SHA-256 over the UTF-8 bytes of text (a lone surrogate becomes U+FFFD, as in Node), written with charCodeAt
  // (uncurried above), typed array writes and operators. Lengths come from the string (a primitive's length cannot be
  // redefined) and from counters; no typed array length is read.
  const hmacHex = text => {
    const count = text.length, inner = new Uint8Array(64 + 3 * count), outer = new Uint8Array(96);
    let used = 64;
    for (let i = 0; i < count; i++) {
      let unit = charCodeAt(text, i);
      if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < count) {
        const next = charCodeAt(text, i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { unit = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00); i++; }
      }
      if (unit >= 0xd800 && unit <= 0xdfff) unit = 0xfffd;
      if (unit < 0x80) inner[used++] = unit;
      else if (unit < 0x800) { inner[used++] = 0xc0 | (unit >> 6); inner[used++] = 0x80 | (unit & 63); }
      else if (unit < 0x10000) { inner[used++] = 0xe0 | (unit >> 12); inner[used++] = 0x80 | ((unit >> 6) & 63); inner[used++] = 0x80 | (unit & 63); }
      else { inner[used++] = 0xf0 | (unit >> 18); inner[used++] = 0x80 | ((unit >> 12) & 63); inner[used++] = 0x80 | ((unit >> 6) & 63); inner[used++] = 0x80 | (unit & 63); }
    }
    for (let i = 0; i < 64; i++) { const k = secretBytes[i]; inner[i] = k ^ 0x36; outer[i] = k ^ 0x5c; }
    const digest = sha(inner, used);
    for (let i = 0; i < 32; i++) outer[64 + i] = digest[i];
    const tag = sha(outer, 96);
    let hex = '';
    for (let i = 0; i < 32; i++) hex += hexDigits[tag[i] >> 4] + hexDigits[tag[i] & 15];
    return hex;
  };
  const indexOf = uncurry(String.prototype.indexOf), usedNonces = new Set(), setHas = uncurry(Set.prototype.has), setAdd = uncurry(Set.prototype.add);
  // A nonce only has to be unique among the proofs this realm has accepted; the tag is what cannot be forged.
  let instance = '';
  if (randomValues) { const bytes = new Uint8Array(12); randomValues(bytes); for (let i = 0; i < 12; i++) instance += hexDigits[bytes[i] >> 4] + hexDigits[bytes[i] & 15]; }
  else instance = String(nativeRandom()).slice(2, 14);
  let proofs = 0;
  const proofFor = method => { const nonce = instance + '-' + ++proofs; return nonce + '.' + hmacHex(method + ':' + nonce); };
  const verify = (method, proof) => {
    if (dead && method !== 'off') throw Error('background popup hook is off');
    const dot = typeof proof === 'string' ? indexOf(proof, '.') : -1;
    if (dot < 1 || proof.length > 256) throw Error('background popup hook refused the call');
    const nonce = slice(proof, 0, dot), expected = hmacHex(method + ':' + nonce), given = slice(proof, dot + 1);
    let difference = expected.length ^ given.length;
    for (let i = 0; i < expected.length && i < given.length; i++) difference |= charCodeAt(expected, i) ^ charCodeAt(given, i);
    if (difference !== 0 || setHas(usedNonces, nonce)) throw Error('background popup hook refused the call');
    setAdd(usedNonces, nonce);
    return nonce;
  };
  let dead = false;
  let serial = 0, shield;
  const ident = node => { if (!idsHas(ids, node)) idsSet(ids, node, ++serial); return idsGet(ids, node); };
  // The same digest runs in the rules' own reader (seal-digest.mjs), so the words the rules classified can be
  // compared with the words that were sealed. Keep the two in step.
  const hash = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = imul(h ^ charCodeAt(value, i), 16777619); return h + ':' + value.length; };
  const SEP = '\u0001';
  const attributes = ['role', 'aria-label', 'aria-disabled', 'disabled', 'value', 'alt', 'title', 'href', 'target', 'type', 'name', 'form', 'formaction', 'formtarget', 'formmethod', 'formenctype', 'formnovalidate', 'for', 'usemap'];
  // After the first keydown the key seal keeps only what decides where activation goes: words, values and disabled state are
  // what a handler legitimately changes (a login button that disables itself, a chat box synced by a framework), so they drop out.
  const routingAttributes = ['href', 'target', 'type', 'form', 'formaction', 'formtarget', 'formmethod', 'formenctype', 'formnovalidate', 'for', 'usemap'];
  const dataAttributes = ['name', 'value'];
  const formAttributes = ['action', 'method', 'target', 'enctype', 'novalidate'];
  // The rows of a form's controls match the rules' own reader (seal-digest.mjs): keep rowAttributes in step with it.
  // Boolean attributes are sealed by presence, not value: formnovalidate="" and no attribute differ.
  const isBoolean = name => name === 'disabled' || name === 'formnovalidate' || name === 'novalidate';
  const attrOf = (node, name) => isBoolean(name) ? (hasAttr(node, name) ? '+' : '-') : attr(node, name) ?? '';
  const rowAttributes = ['type', 'autocomplete', 'name', 'id', 'aria-label', 'value', 'form', 'title', 'alt', 'src'];
  const changedReason = 'the checked element changed', elsewhereReason = 'the input landed on a different element', lateReason = 'the input arrived after the shield expired';
  const shieldIsElement = node => { try { shieldNameOf(node); return true; } catch { return false; } };
  // { form, type } for a form-associated button, input, textarea or select; a brand mismatch throws and falls to the next, so no instanceof.
  const shieldControlOf = node => {
    for (let i = 0; i < controlGetters.length; i++) { try { return { form: controlGetters[i][0](node), type: controlGetters[i][1](node) }; } catch { /* Not this class. */ } }
    return null;
  };
  // A control's form owner (form= included), or the nearest form around any other element.
  const formOwner = (node, control) => control ? control.form : closest(node, 'form');
  const hostOf = node => { try { return shadowHost(rootOf(node)); } catch { return null; } };
  const shieldParentOf = node => parentElementOf(node) ?? hostOf(node);
  // A form's default submitter is its first submit button in tree order among the controls it owns (what Enter in a field presses).
  const submitterOf = form => {
    let nodes;
    try { nodes = queryDocAll(rootOf(form), 'button,input'); } catch { nodes = queryFragAll(rootOf(form), 'button,input'); }
    for (let i = 0; i < listLength(nodes); i++) {
      const control = shieldControlOf(nodes[i]);
      if (control?.form === form && (control.type === 'submit' || control.type === 'image')) return nodes[i];
    }
    return null;
  };
  // The form's hidden inputs by name and value: what the request carries that the page chose.
  const hiddenData = form => {
    let nodes, row = '';
    try { nodes = queryDocAll(rootOf(form), 'input'); } catch { nodes = queryFragAll(rootOf(form), 'input'); }
    for (let i = 0; i < listLength(nodes); i++) {
      const control = shieldControlOf(nodes[i]);
      if (control?.form === form && control.type === 'hidden') row += '\u0004' + (attr(nodes[i], 'name') ?? '') + SEP + (attr(nodes[i], 'value') ?? '');
    }
    return row;
  };
  // Relative actions and hrefs resolve through these, and an unset target falls back to the first base target.
  const baseState = () => {
    const bases = queryDocAll(document, 'base[target]');
    return baseURIOf(document) + SEP + urlOf(document) + SEP + (listLength(bases) > 0 ? attr(bases[0], 'target') ?? '' : '');
  };
  const formContent = form => {
    let parts = '';
    for (let i = 0; i < formAttributes.length; i++) parts += attrOf(form, formAttributes[i]) + SEP;
    const nodes = queryElementAll(form, 'input,button,iframe,select,textarea');
    for (let i = 0; i < listLength(nodes); i++) {
      const node = nodes[i];
      parts += '\u0002' + shieldNameOf(node) + SEP + textOf(node);
      for (let j = 0; j < rowAttributes.length; j++) parts += SEP + (attr(node, rowAttributes[j]) ?? '');
    }
    return parts;
  };
  // Everything the rules read to classify a node: words, type, form owner and that form's controls, base state. No identity.
  const content = node => {
    const control = shieldControlOf(node), form = formOwner(node, control);
    let row = shieldNameOf(node) + SEP + connected(node) + SEP + hash(textOf(node)) + SEP + (control ? control.type : '') + SEP + (form ? hash(formContent(form)) : '');
    for (let i = 0; i < attributes.length; i++) row += SEP + attrOf(node, attributes[i]);
    row += SEP + (attrNS(node, xlinkNamespace, 'href') ?? ''); // An SVG link's other spelling of href.
    return row + SEP + baseState();
  };
  const digest = node => hash(content(node));
  // Content plus which node it is and which form owns it.
  const describe = node => {
    const form = formOwner(node, shieldControlOf(node));
    return ident(node) + SEP + (form ? ident(form) : '') + SEP + content(node);
  };
  // The default submitter by identity and by its own attributes (formaction, formtarget, ...).
  const submitterPart = element => {
    const form = shieldControlOf(element)?.form, submitter = form ? submitterOf(form) : null;
    return submitter ? ident(submitter) + SEP + content(submitter) : '';
  };
  // The routing facts of a control: its identity, form owner, the form's action, method, target, enctype and default submitter
  // (with that submitter's own formaction and formtarget), and the attributes that point a link or button somewhere else.
  const routing = node => {
    const control = shieldControlOf(node), form = control?.form;
    let row = ident(node) + SEP + shieldNameOf(node) + SEP + connected(node) + SEP + (control ? control.type : '');
    if (form) {
      const submitter = submitterOf(form);
      row += SEP + ident(form) + '|' + (submitter ? ident(submitter) : '');
      for (let i = 0; i < formAttributes.length; i++) row += SEP + attrOf(form, formAttributes[i]);
      for (let i = 0; submitter && i < routingAttributes.length; i++) row += SEP + attrOf(submitter, routingAttributes[i]);
      // What the request carries that the page chose: the submitter's own name and value, and the form's hidden inputs.
      for (let i = 0; submitter && i < dataAttributes.length; i++) row += SEP + attrOf(submitter, dataAttributes[i]);
      row += hiddenData(form);
    }
    for (let i = 0; i < routingAttributes.length; i++) row += SEP + attrOf(node, routingAttributes[i]);
    return row;
  };
  // HTML label activation: the first label at or above the element forwards to its control unless interactive content sits between.
  const forwardedOf = element => {
    let node = element;
    for (let depth = 0; node && depth < 100000; depth++, node = shieldParentOf(node)) {
      let label = false, control;
      try { control = labelOf(node); label = true; } catch { /* Not a label. */ }
      if (label) return control;
      if (matchesNode(node, interactive)) return null;
    }
    return null;
  };
  // The image map's areas, as the static list the browser returns. The map name is page data, compared as a string.
  const areasOf = element => {
    let name = attr(element, 'usemap') ?? '';
    if (name.length > 0 && charCodeAt(name, 0) === 35) name = slice(name, 1);
    if (name.length === 0) return null;
    const maps = queryDocAll(document, 'map');
    for (let i = 0; i < listLength(maps); i++) if (attr(maps[i], 'name') === name) return queryElementAll(maps[i], 'area');
    return null;
  };
  const sealed = (element, forwarded, areas, withSubmitter) => {
    let value = describe(element) + '\u0003' + (forwarded ? describe(forwarded) : '');
    for (let i = 0; areas && i < listLength(areas); i++) value += '\u0003' + describe(areas[i]);
    return withSubmitter ? value + '\u0004' + submitterPart(element) : value;
  };
  // Native media controls handle their own presses without dispatching them to the page, so for those a missing
  // press says nothing about where the click went.
  const swallowsInput = element => {
    let node = element;
    for (let depth = 0; node && depth < 100000; depth++, node = shieldParentOf(node)) if (matchesNode(node, 'audio[controls],video[controls]')) return true;
    return false;
  };
  const routed = (element, forwarded, areas) => {
    let value = routing(element) + '\u0003' + (forwarded ? routing(forwarded) : '');
    for (let i = 0; areas && i < listLength(areas); i++) value += '\u0003' + routing(areas[i]);
    // A relative action or href still resolves through the document's base URL, URL and base target.
    return value + '\u0004' + baseState();
  };
  const listHas = (list, node) => { for (let i = 0; list && i < listLength(list); i++) if (list[i] === node) return true; return false; };
  const pathIndex = (path, node) => { for (let i = 0; i < path.length; i++) if (path[i] === node) return i; return -1; };
  // composedPath() from window omits nodes inside a closed shadow root; the outermost closed host stands for them.
  const anchorOf = element => {
    let anchor = element;
    for (let node = element, depth = 0; node && depth < 100000; depth++) {
      const root = rootOf(node);
      let host;
      try { host = shadowHost(root); } catch { break; }
      node = host;
      if (shadowMode(root) === 'closed') anchor = node;
    }
    return anchor;
  };
  // An unreadable chain leaves the element itself as the anchor, as on a page where the natives are absent (the unit fakes).
  const armAnchor = element => { try { return anchorOf(element); } catch { return element; } };
  const pointerType = type => type === 'pointerdown' || type === 'mousedown' || type === 'pointerup' || type === 'mouseup' || type === 'click' || type === 'auxclick' || type === 'dblclick' || type === 'contextmenu';
  const keyType = (type, paste = false) => type === 'keydown' || type === 'keypress' || type === 'keyup' || type === 'submit' || paste && (type === 'paste' || type === 'beforeinput');
  const interactiveBetween = (path, at, forwarded) => {
    for (let i = 0; i < at; i++) if (path[i] !== forwarded && shieldIsElement(path[i]) && matchesNode(path[i], interactive)) return true;
    return false;
  };
  // A clipped radio receives its initial press on its own label, then HTML forwards a click to the radio.
  // Seal that label too. A nested interactive control or a label reassigned to another input still refuses.
  const ownLabel = element => {
    const control = shieldControlOf(element);
    if (control?.type !== 'radio' && control?.type !== 'checkbox') return null;
    const label = closest(element, 'label');
    return label && labelOf(label) === element ? label : null;
  };
  const labelPath = (current, path) => {
    const label = current.label, at = label ? pathIndex(path, label) : -1;
    return at >= 0 && labelOf(label) === current.element && describe(label) === current.labelSignature
      && !interactiveBetween(path, at, current.element);
  };
  const geometryOf = element => { const r = rectOf(element); return r.x + ',' + r.y + ',' + r.width + ',' + r.height; };
  const clearCentre = current => {
    const r = rectOf(current.element), hit = pointHit(document, r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && (hit === current.element || pathIndex(ancestors(hit), current.element) >= 0 || labelPath(current, ancestors(hit)));
  };
  const keyOf = getter(globalThis.KeyboardEvent, 'key'), bodyOf = getter(globalThis.Document, 'body'), rootElementOf = getter(globalThis.Document, 'documentElement');
  const modifierKey = event => { const key = keyOf(event); return key === 'Control' || key === 'Shift' || key === 'Meta' || key === 'Alt' || key === 'AltGraph'; };
  // A locked frame lets no key through. A key release alone is reported separately: a page that navigates on the key leaves the
  // release to its new document, which is blocked there without anything having activated, so the caller may ignore it.
  const DENIED = 'the key landed in a frame that was not checked', RELEASED = 'the key was released in a document that was not checked';
  const inspect = (event, type) => {
    const { element, anchor, forwarded, areas, keys, activation, form, submitter } = shield;
    if (shield.paste && (type === 'submit' || pointerType(type))) return 'paste cannot activate a control or submit a form';
    if (!connected(element)) return 'target left the page';
    if (arm?.modifier && refusesModifier(element)) return changedReason;
    const path = pathOf(event);
    if (keys && type === 'submit') {
      // The submit event names the button that submitted; it must be the one that was sealed (null when no button).
      if (!(form && pathIndex(path, form) >= 0) || submitterOfEvent(event) !== submitter) return elsewhereReason;
    } else if (keys && !pointerType(type)) {
      // A key lands on the focused element; it must be the field itself, not another control of the same form.
      if (pathIndex(path, anchor) < 0) return elsewhereReason;
    } else {
      // The browser's own click on a label's control is trusted too, and its path skips the label; an area's click skips the image.
      // Enter in a field (keys, or a press the caller made: activation) clicks the form's default submitter, which must be the sealed one.
      const at = pathIndex(path, anchor);
      if (at < 0) {
        if (!(forwarded && pathIndex(path, forwarded) >= 0) && !listHas(areas, path[0]) && !((keys || activation) && submitter && pathIndex(path, submitter) >= 0)
          && !labelPath(shield, path)) return elsewhereReason;
      } else if (anchor === element && interactiveBetween(path, at, forwarded)) return elsewhereReason;
    }
    // Until the activation key goes down the whole seal must match. From then on only the routing facts must: what a handler
    // changes about itself while it works (words, value, disabled) is not a change of where the key's effect goes.
    // Once the key's own click or submit has passed, a later key release has nothing left to activate (a link's Enter, a form's
    // implicit submission): a listener that re-aims the link in its click handler is the page's flip, which the click path above
    // (arm and watch) cancels and reroutes, and the release is only checked to have landed on the field.
    if (keys && type === 'keyup' && shield.fired) return undefined;
    const next = keys && shield.down;
    return (next ? routed(element, forwardedOf(element), areasOf(element)) : sealed(element, forwardedOf(element), areasOf(element), keys))
      === (next ? shield.routing : shield.signature) ? undefined : changedReason;
  };
  // A key released on the empty page (the checked button disabled itself, so focus fell to body) is cancelled without a report:
  // nothing was released on anything that could act, and the earlier events passed the seal.
  const onEmptyPage = event => { const target = pathOf(event)[0]; return target === bodyOf(document) || target === rootElementOf(document); };
  // Fail closed: if the check cannot run on this DOM, the input is cancelled.
  const guardEvent = event => {
    const current = shield;
    if (!current || !event.isTrusted) return;
    let bad, quiet = false;
    try {
      const type = typeOf(event);
      if (!(pointerType(type) || current.keys && keyType(type, current.paste))) return;
      if (current.violation && current.violation !== RELEASED) bad = current.violation;
      else if (now() >= current.until) bad = lateReason;
      // A frame locked for a key (not the checked one): a key landing there is denied, and a key release is reported on its own.
      else if (current.foreign) bad = current.deny ? type === 'keyup' ? RELEASED : DENIED : elsewhereReason;
      else {
        bad = inspect(event, type);
        if (bad === elsewhereReason && !current.violation && type === 'keyup' && current.down && onEmptyPage(event)) quiet = true;
        else if (!bad) {
          current.passed = true;
          if (type === 'pointerdown' || type === 'mousedown' || type === 'click') current.landed = true;
          if (current.keys && type === 'keydown' && !modifierKey(event)) current.down = true;
          if (current.keys && (type === 'click' || type === 'submit')) current.fired = true;
        }
      }
    } catch { bad = changedReason; }
    if (!bad) return;
    if (current.mc1 && !current.violation) {
      try { current.retryBlocked = !clearCentre(current) || bad === elsewhereReason && geometryOf(current.element) === current.geometry; }
      catch { current.retryBlocked = true; }
    }
    if (!quiet && (!current.violation || current.violation === RELEASED && bad !== RELEASED)) current.violation = bad;
    try { stopNow(event); } catch { /* The prevent below still cancels the default. */ }
    try { cancel(event); } catch { /* Nothing further can be done to this event. */ }
  };
  const guarded = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'keyup', 'paste', 'beforeinput', 'submit'];
  // Three ways a window loses its listeners while the hook stays. document.open() (and a document.write that opens implicitly)
  // erases every one, so they are added by a function that can run again: add is idempotent for the same callback, and a re-add
  // lands before any listener the page registers afterwards. A script-created frame whose first navigation is same-origin reuses
  // the window of its initial empty document: the start-of-document script ran once, on the empty document, and the commit left the
  // listeners registered but dead, and only removing and adding a listener again makes it fire in that window. The document the
  // listeners were added for tells a reused window (a new document) from a settled one, whose listeners must keep their place
  // ahead of the page's. A private event type tells whether they are present.
  const dispatchNow = uncurry(EventTarget.prototype.dispatchEvent), NativeEvent = Event, random = Math.random;
  const liveProbe = 'sleight-' + random().toString(36).slice(2) + random().toString(36).slice(2);
  const addOn = uncurry(add), removeOn = uncurry(remove);
  const lengthOf = uncurry(getOwn(window, 'length')?.get ?? (() => 0));
  const hookId = String(random()) + ':' + now();
  // A hook put into a document after its scripts ran sits behind the page's own listeners and cannot veto what they do. At the
  // start of a document no script element has been parsed yet; a late one finds scripts already there.
  const atStart = (() => { try { return document.scripts.length === 0; } catch { return false; } })();
  let alive = false, attachedTo;
  const onProbe = () => { alive = true; };
  const install = () => {
    if (dead) return false;
    const stale = attachedTo !== undefined && attachedTo !== document;
    const set = (type, listener) => { if (stale) removeOn(window, type, listener, true); addOn(window, type, listener, true); };
    for (const type of ['click', 'auxclick', 'keydown', 'submit']) set(type, nativeUIEvent);
    for (let i = 0; i < guarded.length; i++) set(guarded[i], guardEvent);
    set('keydown', keyEvent);
    set('keyup', keyEvent);
    for (let i = 0; i < pointerEvents.length; i++) set(pointerEvents[i], capture);
    set('click', guard);
    set('auxclick', guard);
    set('submit', submitted);
    set(liveProbe, onProbe);
    attachedTo = document;
    alive = false;
    try { dispatchNow(window, new NativeEvent(liveProbe)); } catch { /* Reported as not alive. */ }
    return alive;
  };
  install();
  // Natives for the rewriters, captured before page scripts. The listeners are re-added for the window of the
  // document that was rewritten, which can belong to another realm (a parent calling its own prototype's open). A page that
  // rewrote itself in a keydown handler would otherwise take the key unguarded.
  const documentProto = globalThis.Document?.prototype;
  const rewriters = ['open', 'write', 'writeln'].filter(name => typeof documentProto?.[name] === 'function');
  const shieldViewOf = getter(globalThis.Document, 'defaultView'), readyOf = getter(globalThis.Document, 'readyState');
  const afterRewrite = doc => {
    let view = null;
    try { view = shieldViewOf(doc); } catch { /* Not a document; the native call has already thrown. */ }
    try { if (view && view !== window) view[key].reinstall(proofFor('reinstall')); else install(); } catch { install(); }
    flip(); // The document's frames and links went with the rewrite.
  };
  for (const name of rewriters) {
    const original = documentProto[name];
    replace(documentProto, name, { configurable: true, writable: true, value: { [name]() {
      // write() on a document still being parsed appends to it; on a loaded one it opens it first, which erases the listeners.
      let opens = name === 'open';
      try { opens ||= readyOf(this) !== 'loading'; } catch { /* Not a document: the native call throws below. */ }
      try { return reflectApply(original, this, arguments); } finally { if (opens) afterRewrite(this); }
    } }[name] });
  }
  // A page that registers a capture listener on a reused window before anything restores ours would run first, so a
  // registration on the window while a shield is armed restores ours before it is recorded.
  replace(EventTarget.prototype, 'addEventListener', { configurable: true, writable: true, value: { addEventListener(type, listener, options) {
    if (this === window && shield && attachedTo !== document) install(); // a settled window keeps its place ahead of the page's
    const result = reflectApply(add, this, arguments);
    rememberListener(this, type, listener, options);
    return result;
  } }.addEventListener });
  replace(Function.prototype, 'toString', { configurable: true, writable: true, value: { toString() {
    return looksHas(looks, this) ? looksGet(looks, this) : reflectApply(nativeToString, this, arguments);
  } }.toString });
  const finish = token => {
    retired.add(token);
    if (arm?.token !== token) return true;
    clearTimeout(arm.timer); clearTimeout(arm.dispatchTimer);
    if (arm.observer) try { nativeDisconnect.call(arm.observer); } catch { /* Already gone. */ }
    for (const { node, before, wrapper } of arm.handlers) if (wrapper !== before && node.onclick === wrapper) node.onclick = before;
    arm = undefined; return true;
  };
  // A closed shadow root hides its inside from every listener above it: the window's guard sees the outermost closed host in the
  // path, and a control the page slid over the checked one in the same root looks like the checked one. The hook is run with the
  // checked element in hand, so it can reach each closed root above the element and listen there too, still ahead of the
  // controls inside the root. This listener cancels any press, release or click (and key, with { keys }) whose path from inside the
  // root does not hold the sealed element. A listener the page put on the same root earlier still runs before it; the hook cannot be
  // first in a root the page made.
  // From a listener on a closed root, a closed root nested below it is hidden too: what stands for the checked element there is the
  // host of the closed root below (the element itself, for the innermost one).
  const rootGuardFor = stand => event => {
    const current = shield;
    if (!current || current.foreign || !event.isTrusted || current.element === current.anchor) return;
    let bad;
    try {
      const type = typeOf(event);
      if (!(pointerType(type) || current.keys && keyType(type, current.paste)) || type === 'submit') return;
      const path = pathOf(event);
      if (pathIndex(path, stand) >= 0 || current.forwarded && pathIndex(path, current.forwarded) >= 0 || listHas(current.areas, path[0])
        || (current.keys || current.activation) && current.submitter && pathIndex(path, current.submitter) >= 0) return;
      bad = elsewhereReason;
    } catch { bad = changedReason; }
    if (!current.violation || current.violation === RELEASED) current.violation = bad;
    try { stopNow(event); } catch { /* The prevent below still cancels the default. */ }
    try { cancel(event); } catch { /* Nothing further can be done to this event. */ }
  };
  const closedRootsOf = element => {
    const roots = [];
    try {
      for (let node = element, stand = element, depth = 0; node && depth < 1000; depth++) {
        const root = rootOf(node);
        let host;
        try { host = shadowHost(root); } catch { break; }
        if (shadowMode(root) === 'closed') { roots[roots.length] = { root, listener: rootGuardFor(stand) }; stand = host; }
        node = host;
      }
    } catch { /* A chain that cannot be read leaves the window's guard. */ }
    return roots;
  };
  const dropShield = current => {
    nativeClear(current.drop);
    if (current.roots) for (let i = 0; i < current.roots.length; i++) for (let j = 0; j < guarded.length; j++) try { removeOn(current.roots[i].root, guarded[j], current.roots[i].listener, true); } catch { /* Gone with the root. */ }
    if (shield === current) shield = undefined;
  };
  const holdShield = (current, capMs) => {
    // Hard cap: well past the soft cap, only to drop a shield nobody finished.
    current.drop = nativeTimeout(() => { if (shield === current) shield = undefined; }, capMs * 4 + 5000);
    return current;
  };
  // Disarms this frame's shield and reports the first veto, whether a press or click landed on the sealed
  // element's document, and whether any guarded event passed (so the page's own handlers saw part of the click).
  // The other frames are armed and released from Node over every frame Playwright knows (see frameShield).
  // All three properties are always own properties of the result, so reading them reaches nothing a page can define.
  const conclude = token => {
    const current = shield?.token === token && !shield.foreign ? shield : undefined;
    const bad = current?.violation;
    if (current) dropShield(current);
    finish(token);
    return { bad, landed: current?.reports ? current.landed : undefined, passed: current ? current.passed : undefined };
  };
  const impl = {
    // See the key-shield API above. Any throw here reaches the caller as a rejected call, which reads as "page changed".
    guard(element, token, capMs, { keys = false, press = false, paste = false, mc1 = false } = {}) {
      if (retired.has(token) || !isFinite(capMs) || capMs <= 0 || !shieldIsElement(element) || !connected(element)) return false;
      const withKeys = keys === true, activation = press === true, control = shieldControlOf(element), form = withKeys || activation ? control?.form ?? null : null;
      const forwarded = forwardedOf(element), areas = areasOf(element);
      const parts = [digest(element), forwarded ? digest(forwarded) : ''];
      for (let i = 0; areas && i < listLength(areas); i++) parts[parts.length] = digest(areas[i]);
      const until = now() + capMs;
      shield = holdShield({ token, element, anchor: anchorOf(element), forwarded, areas, keys: withKeys, activation, form, submitter: form ? submitterOf(form) : null,
        paste: paste === true, parts, signature: sealed(element, forwarded, areas, withKeys), routing: withKeys ? routed(element, forwarded, areas) : undefined, down: false,
        until, landed: false, passed: false, reports: !activation && !swallowsInput(element) }, capMs);
      if (mc1 && !withKeys && !activation) {
        shield.mc1 = true;
        shield.geometry = geometryOf(element);
        shield.label = ownLabel(element);
        shield.labelSignature = shield.label ? describe(shield.label) : '';
      }
      if (shield.anchor !== element) {
        shield.roots = closedRootsOf(element);
        for (let i = 0; i < shield.roots.length; i++) for (let j = 0; j < guarded.length; j++) addOn(shield.roots[i].root, guarded[j], shield.roots[i].listener, true);
      }
      return install();
    },
    // A frame that is not the checked element's: any trusted press or click here (and key, with { keys }) is
    // cancelled until the shield is released or its cap passes. Called from Node for every frame but the owner's,
    // and again before the click (idempotent for one token); a frame created while armed calls it on itself.
    // Returns true only when the listeners are confirmed present.
    adopt(token, capMs, keys = false, paste = false) {
      if (retired.has(token) || !isFinite(capMs) || capMs <= 0) return false;
      if (shield && (!shield.foreign || shield.token !== token)) {
        if (!shield.foreign) return false;
        dropShield(shield); shield = undefined;
      }
      shield ??= holdShield({ foreign: true, token, keys: keys === true, paste: paste === true, until: now() + capMs, landed: false, passed: false }, capMs);
      return install();
    },
    armed() { return shield ? { token: shield.token, until: shield.until, keys: shield.keys === true, paste: shield.paste === true } : undefined; },
    // Node releases a frame's foreign shield (the token is retired, so a late adopt of it is refused) and reads its veto.
    release(token) {
      retired.add(token);
      const current = shield?.token === token && shield.foreign ? shield : undefined;
      if (!current) return undefined;
      dropShield(current);
      return current.violation;
    },
    // Re-adds the listeners (a document rewrite erased them); true when they are confirmed present.
    reinstall() { return install(); },
    // Locks this frame for a key: every trusted key and press here is vetoed until release(token) or capMs, for a frame other than
    // the one holding the checked element (a page script could move focus into it). A foreign shield with its own messages. Called
    // at document start by the script that is registered for the key's duration, so no page listener is earlier. Refused where
    // an owner's shield is already armed.
    lock(token, capMs, paste = false) {
      if (retired.has(token) || !isFinite(capMs) || capMs <= 0 || shield && !shield.foreign) return false;
      if (shield) dropShield(shield);
      shield = holdShield({ foreign: true, deny: true, token, keys: true, paste: paste === true, until: now() + capMs, landed: false, passed: false }, capMs);
      install(); // Not read: a document that may not run scripts (a sandbox without allow-scripts) fires no listener, and nothing in it can act on a key.
      return true;
    },
    // After a key goes down: restore the listeners a reused window lost, and lock this window if it is not the checked one (a frame
    // the key's handler created or navigated). The checked document keeps its seal while the checked element is still in it; if the
    // element left, the lock replaces the seal and keeps any veto it had recorded.
    resync(token, capMs, paste = false) {
      if (retired.has(token) || !isFinite(capMs) || capMs <= 0) return false;
      install(); // The result is not read, as in lock.
      const own = shield?.token === token ? shield : undefined;
      if (own && !own.foreign && connected(own.element)) return true;
      if (shield && !own && !shield.foreign) return false;
      const violation = own?.violation;
      if (shield) dropShield(shield);
      shield = holdShield({ foreign: true, deny: true, token, keys: true, paste: paste === true, until: now() + capMs, violation, landed: false, passed: false }, capMs);
      return true;
    },
    // This window as one of the windows a walk visits.
    info() { return { id: hookId, n: lengthOf(window), fresh: atStart }; },
    // What the rules read, as digests taken in the same step as their read, must equal what was sealed.
    expect(token, evidence) {
      const current = shield;
      if (!current || current.foreign || current.token !== token) return changedReason;
      let bad = current.violation;
      if (!bad && now() >= current.until) bad = lateReason;
      if (!bad && !install()) bad = changedReason;
      if (!bad) {
        const parts = current.parts, given = evidence?.areas;
        let same = evidence?.element === parts[0] && (evidence?.forwarded ?? '') === parts[1] && given?.length === parts.length - 2;
        for (let i = 0; same && i < given.length; i++) same = given[i] === parts[i + 2];
        if (!same) bad = changedReason;
      }
      if (!bad) return true;
      current.violation ??= bad;
      return bad;
    },
    // Scroll the element into view without animation, so the pointer can be moved onto it (the click would scroll anyway).
    reveal(element) {
      scrollInto(element, { block: 'nearest', inline: 'nearest', behavior: 'instant' });
      // 'nearest' leaves the element at an edge, which is where a fixed or sticky bar sits: while one covers its centre, try the middle, then each edge.
      try {
        const covered = () => {
          const r = rectOf(element), hit = r.width + r.height > 0 && r.top >= 0 && r.bottom <= innerHeight ? pointHit(document, r.x + r.width / 2, r.y + r.height / 2) : null;
          return !!hit && hit !== element && ancestors(hit).some(node => { const p = styleOf(node).position; return p === 'fixed' || p === 'sticky'; }) && !ancestors(hit).includes(element);
        };
        for (const block of ['center', 'end', 'start']) { if (!covered()) break; scrollInto(element, { block, inline: 'nearest', behavior: 'instant' }); }
      } catch { /* No hit test here: the plain scroll stands. */ }
    },
    // Resolves after the next frame (or 40 ms if frames are throttled) and one more task, so swaps scheduled by the
    // pointer's arrival (events, observers, timers, animation frames) land before the seal is taken.
    settle(done) {
      let waiting = true;
      const next = () => { if (waiting) { waiting = false; nativeTimeout(done, 0); } };
      nativeFrame?.(next); nativeTimeout(next, 40);
    },
    // Keep the old seal while waiting. Only the very same node with the same classification can earn one retry.
    // Both mutation quiet and stable geometry are required, with a hard 300 ms cap after the next frame.
    retry(element, token, done) {
      const current = shield;
      const eligible = () => shield === current && current?.token === token && current.element === element
        && !current.keys && !current.activation && current.passed === false && current.reports
        && current.mc1 && !current.retryBlocked
        && (!current.label || ownLabel(element) === current.label)
        && (current.violation === changedReason || current.violation === elsewhereReason)
        && connected(element) && now() < current.until;
      if (!eligible()) { done(false); return; }
      let observer, timer, cap, finished = false, quietAt = now(), geometry = '';
      const finish = value => {
        if (finished) return;
        finished = true; nativeClear(timer); nativeClear(cap);
        if (observer) nativeDisconnect.call(observer);
        done(value);
      };
      const sample = () => {
        try {
          if (!eligible()) return finish(false);
          const r = rectOf(element), next = r.x + ',' + r.y + ',' + r.width + ',' + r.height;
          if (next !== geometry) { geometry = next; quietAt = now(); }
          const style = styleOf(element), clear = clearCentre(current);
          if (now() - quietAt >= 50 && r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
            && r.bottom <= innerHeight && r.right <= innerWidth && style.visibility === 'visible' && style.display !== 'none' && clear
            && (!current.label || describe(current.label) === current.labelSignature)
            && sealed(element, forwardedOf(element), areasOf(element), false) === current.signature) return finish(true);
          timer = nativeTimeout(sample, 25);
        } catch { finish(false); }
      };
      try {
        observer = new NativeObserver(() => { quietAt = now(); });
        nativeObserve.call(observer, document, { subtree: true, childList: true, attributes: true, characterData: true });
        const root = rootOf(element);
        if (root !== document) nativeObserve.call(observer, root, { subtree: true, childList: true, attributes: true, characterData: true });
        this.settle(() => { if (finished) return; quietAt = now(); cap = nativeTimeout(() => finish(false), 300); sample(); });
      } catch { finish(false); }
    },
    verdict(token) { return shield?.token === token ? shield.violation : undefined; },
    prepare(element, token, capMs, press, modifier) {
      if (retired.has(token)) return false;
      held = 0;
      if (arm) finish(arm.token);
      // The modifier goes to the focused document, so a frame still holding focus (a card field just filled) is let go first; one that keeps it refuses.
      if (CR2_NESTED_DOCUMENT(document.activeElement)) {
        try { nativeBlur.call(CR2_FOCUSED(document.activeElement)); } catch { /* No native blur; the check below refuses. */ }
        if (CR2_NESTED_DOCUMENT(document.activeElement)) throw Error('document focus is inside a frame');
      }
      if (!isElement(element) || !isConnected(element) || !isFinite(capMs) || capMs <= 0) return false;
      if (modifier && (modifier !== 'Meta' && modifier !== 'Control' || refusesModifier(element))) return { kind: 'refuse', reason: 'modifier' };
      // The native getter inherits editability and keeps a non-editable island inside an editor non-editable, so
      // only the element itself is asked, beside document.designMode (read through its captured getter).
      if (inDesignMode() || isEditable(element)) return modifier ? { kind: 'refuse', reason: 'modifier' } : false;
      const space = press === 'space';
      const chain = ancestors(element);
      let watch;
      for (const [index, node] of chain.entries()) {
        // A multiple select needs plain input to select.
        if (isMultiSelect(node)) return false;
        if (press) continue;
        const found = submission(node, false);
        if (found && sameContext(found.form, submitTarget(found.form, found.submitter))) { watch = { kind: 'form', ...found }; break; }
        // A label can forward activation to a submit control outside its tree.
        const control = labelTarget(node);
        if (control !== node && !chain.slice(0, index).some(child => nativeMatches.call(child, interactive))) {
          const forwarded = submission(control, false);
          if (forwarded && sameContext(forwarded.form, submitTarget(forwarded.form, forwarded.submitter))) { watch = { kind: 'form', ...forwarded }; break; }
        }
      }
      let link, linkElement;
      if (press) {
        // Keyboard activation acts on the focused element only. Enter follows a link and, in a field, submits the
        // form through its default button; Space presses a button and does nothing to a link or a field.
        if (isLinkTag(element) && hasHref(element) && !space) {
          if (has(element, 'download')) return false;
          linkElement = element;
          if (sameContext(element)) watch = { kind: 'link', element };
          else {
            link = linkState(element);
            // Ctrl+Enter follows a decidable link into a background tab. One sleight cannot decide (credentials,
            // about:blank) would open in the foreground on a plain Enter, so the press is refused.
            if (!link) return { kind: 'refuse', reason: 'link' };
          }
        } else {
          const found = submission(element, !space);
          if (!found) return false;
          if (holdsForm(found.form, found.submitter)) return { kind: 'refuse', reason: 'form' };
          watch = { kind: 'form', ...found };
        }
      } else if (!watch) {
        linkElement = chain.find(node => isLinkTag(node) && hasHref(node));
        if (linkElement && isEditable(linkElement)) return false;
        if (linkElement && sameContext(linkElement)) {
          if (has(linkElement, 'download')) return false;
          watch = { kind: 'link', element: linkElement };
        } else link = linkState(linkElement);
      }
      if (modifier && watch) return { kind: 'refuse', reason: 'modifier' };
      arm = { element, anchor: armAnchor(element), token, until: now() + capMs, masking: false, modifiers: new Set(), modifier, link, linkElement, watch, handlers: [] };
      arm.timer = setTimeout(() => finish(token), capMs);
      if (watch) { watchChanges(); return { kind: 'watch' }; }
      return link ? { kind: 'link' } : true;
    },
    takeRequest(token) {
      // A flip the watch caught says what changed; the shield's veto, which the same flip also trips, says only that something did.
      if (live() && arm.token === token && !arm.taken && arm.blocked) { arm.taken = true; return { blocked: arm.blocked }; }
      // A key released in a new document of the checked frame (a form that navigated) is not a veto; the key path reads the
      // other frames' vetoes itself and drops that one for the checked frame.
      if (shield?.token === token && shield.violation && shield.violation !== RELEASED) return { violation: shield.violation };
      if (!live() || arm.token !== token || arm.taken) return { unavailable: true, lost: true };
      arm.taken = true;
      if (!arm.request) return arm.watch ? undefined : { unavailable: true };
      if (arm.request.cancelled) return;
      if (otherRealm()) return { unavailable: true };
      const current = linkState(arm.linkElement ?? arm.watch?.element);
      if (!arm.element.isConnected || current?.signature !== arm.request.signature
        || arm.handlers.some(({ node, wrapper }) => node.onclick !== wrapper)) return { unavailable: true };
      return { url: arm.request.url, target: arm.request.target, rel: arm.request.rel };
    },
    // A blocked input reports why, so the caller never mistakes a cancelled click for a delivered one.
    finish(token) { return conclude(token).bad ?? true; },
    conclude,
    cancel(event) { cancelEvent(event); },
    // Another hook (a frame's, a window's) saw something that can re-aim a link or form this hook is watching.
    changed() { changed(); },
    watching(on) { outer = on === true; },
    // Whether a script-started click or submit is being dispatched here or in a window that told this one (a new frame asks at install).
    flight() { return !!scripted || outer; },
    // The top window of a tab also collects what the hooks of its frames held, so a page cannot open a tab from a frame unreported.
    take() {
      let count = held; held = 0;
      if (window.parent === window) {
        const seen = new Set(), pending = childWindows(window);
        for (let steps = 0; pending.length && steps < 512; steps++) {
          const context = pending.pop();
          if (!context || seen.has(context)) continue;
          seen.add(context);
          if (!readable(context)) continue;
          try {
            const proof = proofFor('take'), text = openAnswer('take', proof, context[key].take(proof));
            if (text !== undefined && charCodeAt(text, 0) === 100) count += Number(slice(text, 1));
          } catch { /* Not a hook. */ }
          pending.push(...childWindows(context));
        }
      }
      return count;
    },
    // Every window from this one down that script can reach, as { id, n, fresh } (id null: a window with no hook, or one that did
    // not answer), and the same walk for the calls the key path makes. A frame in another process has its own session and is
    // reached by that.
    tree() { const out = []; walk((peer, info) => { out[out.length] = info ? info : { id: null, n: 0, fresh: false }; }); return out; },
    lockAll(token, capMs, skip, paste) { let ok = true; walk((peer, info) => { if (!peer) ok = false; else if (info.id !== skip && !peer.lock(token, capMs, paste)) ok = false; }); return ok; },
    resyncAll(token, capMs, paste) { let ok = true; walk(peer => { if (!peer || !peer.resync(token, capMs, paste)) ok = false; }); return ok; },
    finishAll(token) {
      const out = [];
      walk((peer, info) => { if (peer) { const reason = peer.release(token); if (typeof reason === 'string') out[out.length] = [info.id, reason]; } });
      return out;
    },
    off() {
      if (wholeNavigation) remove.call(wholeNavigation, 'navigate', wholeNavigate);
      dead = true;
      if (arm) finish(arm.token);
      remove.call(window, 'keydown', keyEvent, true);
      remove.call(window, 'keyup', keyEvent, true);
      for (const type of pointerEvents) remove.call(window, type, capture, true);
      remove.call(window, 'click', guard, true);
      remove.call(window, 'auxclick', guard, true);
      remove.call(window, liveProbe, onProbe, true);
      for (let i = 0; i < guarded.length; i++) remove.call(window, guarded[i], guardEvent, true);
      shield = undefined;
      remove.call(window, 'submit', submitted, true);
      for (const restore of replacements.reverse()) restore();
      return true;
    },
  };
  // What a caller gets back is signed too: 'nonce.tag.text', the tag an HMAC of method, the call's nonce and the text
  // under the secret, so a page that forges or replays a return value (Playwright carries returns through code the page
  // can replace) cannot pass for the hook. The text is built here from fixed shapes, never by JSON.stringify, which a
  // page can steer through Object.prototype.toJSON. hookOpen in the controller checks the tag and decodes the text.
  const NUL = String.fromCharCode(0);
  const sign = (method, nonce, text) => nonce + '.' + hmacHex(method + ':' + nonce + ':' + text) + '.' + text;
  const booleanText = value => value === true ? 't' : 'f';
  const preparedText = value => value === true ? 't' : value === false ? 'f' : value.kind === 'link' ? 'link' : value.kind === 'watch' ? 'watch'
    : value.kind === 'refuse' ? (value.reason === 'modifier' ? 'refuse-modifier' : value.reason === 'link' ? 'refuse-link' : 'refuse-form') : 'form';
  const requestText = value => {
    if (value === undefined) return 'u';
    if (getOwn(value, 'violation')) return 's' + value.violation;
    if (getOwn(value, 'blocked')) return value.blocked === 'form' ? 'bform' : 'blink';
    if (getOwn(value, 'unavailable')) return getOwn(value, 'lost') ? 'l' : 'n';
    return 'q' + value.url + NUL + value.target + NUL + value.rel;
  };
  const stringText = value => typeof value === 'string' ? 's' + value : value === undefined ? 'u' : 't';
  const triText = value => value === true ? 't' : value === false ? 'f' : 'u';
  // conclude: 'c', landed and passed as t/f/u, then 's' and the veto or 'u'. Its fields are always own properties.
  const concludeText = value => 'c' + triText(value.landed) + triText(value.passed) + (typeof value.bad === 'string' ? 's' + value.bad : 'u');
  const armedText = value => value === undefined ? 'u' : 'a' + value.token + NUL + String(value.until) + NUL + (value.paste === true ? 'p' : value.keys === true ? 't' : 'f');
  // info: 'i', the window's id, its child count and whether its hook was there at the start of its document, NUL between.
  const infoText = value => 'i' + value.id + NUL + String(value.n) + NUL + (value.fresh === true ? 't' : 'f');
  // tree: 'r' and one record per window, NUL between records, SOH between the fields (an empty id: a window with no hook).
  // finishAll: 'p' and one record per veto, the window's id and the reason.
  const SOH = String.fromCharCode(1);
  const treeText = list => {
    let text = 'r';
    for (let i = 0; i < list.length; i++) text += (i === 0 ? '' : NUL) + (list[i].id ?? '') + SOH + String(list[i].n) + SOH + (list[i].fresh === true ? 't' : 'f');
    return text;
  };
  const pairsText = list => {
    let text = 'p';
    for (let i = 0; i < list.length; i++) text += (i === 0 ? '' : NUL) + list[i][0] + SOH + list[i][1];
    return text;
  };
  const seal = (method, proof, run, text) => { const nonce = verify(method, proof); return sign(method, nonce, text(run())); };
  const nothing = () => 'u';
  // The same check hookOpen makes in the controller, for an answer another window's copy of this hook gave to a call
  // made here: the text if nonce and tag are right for that proof and method, else undefined. Natives and primitives only.
  const equalText = (a, b) => {
    let difference = a.length ^ b.length;
    for (let i = 0; i < a.length && i < b.length; i++) difference |= charCodeAt(a, i) ^ charCodeAt(b, i);
    return difference === 0;
  };
  const openAnswer = (method, proof, answer) => {
    if (typeof answer !== 'string') return undefined;
    const nonce = slice(proof, 0, indexOf(proof, '.')), start = nonce.length + 1;
    if (slice(answer, 0, start) !== nonce + '.') return undefined;
    const rest = slice(answer, start), dot = indexOf(rest, '.');
    if (dot < 0) return undefined;
    const text = slice(rest, dot + 1);
    return equalText(slice(rest, 0, dot), hmacHex(method + ':' + nonce + ':' + text)) ? text : undefined;
  };
  const parseInfo = text => {
    if (charCodeAt(text, 0) !== 105) return undefined;
    const first = indexOf(text, NUL), second = indexOf(text, NUL, first + 1);
    if (first < 1 || second <= first) return undefined;
    const n = Number(slice(text, first + 1, second));
    if (!(n >= 0 && n <= 4096) || n % 1 !== 0) return undefined;
    return { id: slice(text, 1, first), n, fresh: slice(text, second + 1) === 't' };
  };
  // The windows a walk visits: this one (direct calls) and each child whose hook is asked through its signed API. Every call to a
  // child carries a proof and its answer is checked here, so a page that planted an object under the key takes no part.
  const selfPeer = { lock: (token, capMs, paste) => impl.lock(token, capMs, paste), resync: (token, capMs, paste) => impl.resync(token, capMs, paste), release: token => impl.release(token) };
  // undefined: a window this one cannot read (another origin; the controller reaches it through its own route). null: a window with
  // no hook, or one whose answer cannot be vouched for.
  const peerOf = child => {
    let hook;
    try { hook = child[key]; } catch { return undefined; }
    if (typeof hook !== 'object' || hook === null) return null;
    const ask = (method, invoke) => { const proof = proofFor(method); try { return openAnswer(method, proof, invoke(proof)); } catch { return undefined; } };
    return {
      info: () => { const text = ask('info', proof => hook.info(proof)); return text === undefined ? undefined : parseInfo(text); },
      lock: (token, capMs, paste) => ask('lock', proof => hook.lock(proof, token, capMs, paste)) === 't',
      resync: (token, capMs, paste) => ask('resync', proof => hook.resync(proof, token, capMs, paste)) === 't',
      // A hook that does not answer may have vetoed something: report a change rather than nothing.
      release: token => {
        const text = ask('release', proof => hook.release(proof, token));
        return text === undefined ? changedReason : charCodeAt(text, 0) === 115 ? slice(text, 1) : undefined;
      },
    };
  };
  // fn(peer, info) for this window and every descendant script can reach, depth first; fn(null, null) for a reachable window
  // that has no usable hook.
  const walk = fn => {
    const seen = [];
    const visit = (win, peer, info, depth) => {
      for (let i = 0; i < seen.length; i++) if (seen[i] === win) return;
      seen[seen.length] = win;
      if (depth > 64) { fn(null, null); return; }
      fn(peer, info);
      for (let i = 0; i < info.n; i++) {
        let child, found;
        try { child = win[i]; found = peerOf(child); } catch { continue; }
        if (found === undefined) continue;
        const childInfo = found === null ? undefined : found.info();
        if (childInfo === undefined) fn(null, null); else visit(child, found, childInfo, depth + 1);
      }
    };
    visit(window, selfPeer, impl.info(), 0);
  };
  const api = {
    whole: (proof, token, capMs) => seal('whole', proof, () => {
      if (capMs === 0) { if (token !== wholeToken) return false; wholeUntil = 0; wholeToken = undefined; return true; }
      if (wholeActive() && token === wholeToken) return true;
      if (!wholeNavigation || wholeActive() || typeof token !== 'string' || !isFinite(capMs) || capMs <= 0 || capMs > 125000) return false;
      wholeUntil = wholeNow() + capMs; wholeToken = token; wholeBlocked = []; wholeShared = wholeSubmit = wholeRequestSubmit = 0; return true;
    }, booleanText),
    wholeWorker: proof => seal('wholeWorker', proof, () => { if (!wholeActive()) return false; wholeShared++; return true; }, booleanText),
    wholeTake: proof => seal('wholeTake', proof, () => {
      const value = wholeJoin(wholeBlocked, ', ') + '\n' + wholeShared + '\n' + wholeSubmit + '\n' + wholeRequestSubmit;
      wholeBlocked = []; wholeShared = wholeSubmit = wholeRequestSubmit = 0; return value;
    }, stringText),
    guard: (proof, element, token, capMs, options) => seal('guard', proof, () => impl.guard(element, token, capMs, options), booleanText),
    reveal: (proof, element) => seal('reveal', proof, () => impl.reveal(element), nothing),
    settle: proof => { const nonce = verify('settle', proof); return new Promise(resolve => impl.settle(() => resolve(sign('settle', nonce, 'u')))); },
    retry: (proof, element, token) => { const nonce = verify('retry', proof); return new Promise(resolve => impl.retry(element, token, value => resolve(sign('retry', nonce, booleanText(value))))); },
    verdict: (proof, token) => seal('verdict', proof, () => impl.verdict(token), stringText),
    prepare: (proof, element, token, capMs, press, modifier) => seal('prepare', proof, () => impl.prepare(element, token, capMs, press, modifier), preparedText),
    takeRequest: (proof, token) => seal('takeRequest', proof, () => impl.takeRequest(token), requestText),
    finish: (proof, token) => seal('finish', proof, () => impl.finish(token), stringText),
    cancel: (proof, event) => { verify('cancel', proof); impl.cancel(event); },
    changed: proof => { verify('changed', proof); impl.changed(); },
    watching: (proof, on) => { verify('watching', proof); impl.watching(on); },
    take: (proof) => seal('take', proof, () => impl.take(), count => 'd' + count),
    off: proof => seal('off', proof, () => impl.off(), booleanText),
    expect: (proof, token, evidence) => seal('expect', proof, () => impl.expect(token, evidence), stringText),
    conclude: (proof, token) => seal('conclude', proof, () => impl.conclude(token), concludeText),
    adopt: (proof, token, capMs, keys, paste) => seal('adopt', proof, () => impl.adopt(token, capMs, keys, paste), booleanText),
    armed: proof => seal('armed', proof, () => impl.armed(), armedText),
    release: (proof, token) => seal('release', proof, () => impl.release(token), stringText),
    reinstall: proof => seal('reinstall', proof, () => impl.reinstall(), booleanText),
    lock: (proof, token, capMs, paste) => seal('lock', proof, () => impl.lock(token, capMs, paste), booleanText),
    resync: (proof, token, capMs, paste) => seal('resync', proof, () => impl.resync(token, capMs, paste), booleanText),
    info: proof => seal('info', proof, () => impl.info(), infoText),
    tree: proof => seal('tree', proof, () => impl.tree(), treeText),
    lockAll: (proof, token, capMs, skip, paste) => seal('lockAll', proof, () => impl.lockAll(token, capMs, skip, paste), booleanText),
    resyncAll: (proof, token, capMs, paste) => seal('resyncAll', proof, () => impl.resyncAll(token, capMs, paste), booleanText),
    finishAll: (proof, token) => seal('finishAll', proof, () => impl.finishAll(token), pairsText),
    flight: proof => seal('flight', proof, () => impl.flight(), booleanText),
  };
  try { defineProperty(window, key, { value: freeze(api), configurable: false, writable: false, enumerable: false }); }
  catch { for (const restore of replacements.reverse()) restore(); return false; }
  // A frame created while its parent is guarded starts armed. The parent's answer is checked here against the shared
  // secret, like the controller checks one, so a window that is not this hook cannot arm or disarm this frame.
  try {
    const parent = window.parent;
    if (parent !== window) {
      const proof = proofFor('armed'), text = openAnswer('armed', proof, parent[key].armed(proof));
      if (text !== undefined && charCodeAt(text, 0) === 97) {
        const first = indexOf(text, NUL), second = indexOf(text, NUL, first + 1);
        const until = Number(slice(text, first + 1, second)), mode = slice(text, second + 1), keys = mode === 't' || mode === 'p';
        if (first > 0 && second > first && until > now()) impl.adopt(slice(text, 1, first), until - now(), keys, mode === 'p');
      }
    }
  } catch { /* A cross-origin parent, or none: nothing to inherit. */ }
  // A frame or window created inside a script-started click's listener missed the watching(true) the click sent, so it asks
  // the windows above it and the one that opened it, and checks the answer like any other signed answer.
  try {
    const above = [window.parent, window.top, openerGetter?.call(window)];
    for (let i = 0; i < above.length; i++) {
      const other = above[i];
      if (!other || other === window) continue;
      try { const proof = proofFor('flight'); if (openAnswer('flight', proof, other[key].flight(proof)) === 't') outer = true; } catch { /* Not a hook, or cross-origin. */ }
    }
  } catch { /* Nothing above to ask. */ }
  return true;
}

// The controller's side of the hook's proof. hook is { key, secret } as popupHook received it (build the pair with
// newHook()). hookProof(hook, method) returns the first argument for one call of that method, for example
//   window[hook.key].guard(proof, element, token, capMs, { keys: true })
// Make a proof per call, never reuse one, and send it only to the method it names. The hook answers with a signed string;
// hookOpen(hook, answer) checks the signature, which proves the answer came from the hook for that very call and not from a
// page that replaced the evaluate machinery, and returns the decoded value (what the method returned before answers were
// signed): guard and off a boolean, reveal and settle undefined, verdict and finish a string or undefined or true, prepare
// false, true, { kind: 'link' }, { kind: 'watch' }, { kind: 'form' } or { kind: 'refuse', reason: 'link' | 'form' }, takeRequest undefined,
// { unavailable: true }, { unavailable: true, lost: true }, { blocked: 'link' | 'form' }, { violation } or { url, target, rel }, take a number,
// expect true or a string, conclude { bad, landed, passed }, adopt and reinstall a boolean, armed undefined or { token, until, keys }, release a string or undefined, flight a boolean. It throws an Error with code HOOK_ANSWER_REFUSED for anything it cannot vouch for.
export const newHook = () => Object.freeze({ key: 'k' + randomBytes(16).toString('hex'), secret: randomUUID() });
// The install expression for a hook: popupHook called with { key, secret } where secret is the secret's bytes as numeric
// literals (an array of 16 to 64 byte values). The page never holds a string it must convert, and an array or object
// literal runs no page code.
export function hookSource(hook) {
  if (typeof hook?.key !== 'string' || typeof hook?.secret !== 'string') throw capabilityError('background popup hook unavailable; use the engine browser path');
  return `(${popupHook})(${JSON.stringify({ key: hook.key, secret: Array.from(Buffer.from(hook.secret, 'latin1')) })})`;
}
const issued = new WeakMap();
export function hookProof(hook, method) {
  if (typeof hook?.key !== 'string' || typeof hook?.secret !== 'string' || typeof method !== 'string') throw capabilityError('background popup hook unavailable; use the engine browser path');
  const nonce = randomBytes(12).toString('hex');
  if (!issued.has(hook)) issued.set(hook, new Map());
  const calls = issued.get(hook);
  calls.set(nonce, method);
  if (calls.size > 4096) calls.delete(calls.keys().next().value);
  return nonce + '.' + createHmac('sha256', hook.secret).update(method + ':' + nonce).digest('hex');
}
export function hookOpen(hook, answer) {
  const refused = () => Object.assign(Error('background popup hook answer refused'), { code: 'HOOK_ANSWER_REFUSED' });
  const first = typeof answer === 'string' ? answer.indexOf('.') : -1, second = first < 0 ? -1 : answer.indexOf('.', first + 1);
  if (second < 0) throw refused();
  const nonce = answer.slice(0, first), tag = answer.slice(first + 1, second), text = answer.slice(second + 1);
  const method = issued.get(hook)?.get(nonce);
  if (method === undefined) throw refused();
  const expected = createHmac('sha256', hook.secret).update(method + ':' + nonce + ':' + text).digest('hex');
  if (tag.length !== expected.length || !timingSafeEqual(Buffer.from(tag), Buffer.from(expected))) throw refused();
  issued.get(hook).delete(nonce);
  if (method === 'conclude') {
    if (!/^c[tfu][tfu][su]/.test(text)) throw refused();
    const tri = letter => letter === 't' ? true : letter === 'f' ? false : undefined;
    return { bad: text[3] === 's' ? text.slice(4) : undefined, landed: tri(text[1]), passed: tri(text[2]) };
  }
  if (method === 'armed' && text !== 'u') {
    const [token, until, keys, ...extra] = text.slice(1).split('\0');
    if (text[0] !== 'a' || extra.length || keys === undefined || !Number.isFinite(Number(until))) throw refused();
    return { token, until: Number(until), keys: keys === 't' || keys === 'p', ...(keys === 'p' ? { paste: true } : {}) };
  }
  if (method === 'tree') {
    if (text[0] !== 'r') throw refused();
    return text.slice(1).split('\0').map(record => {
      const [id, n, fresh, ...extra] = record.split('\u0001');
      if (extra.length || !/^\d+$/.test(n ?? '') || fresh !== 't' && fresh !== 'f') throw refused();
      return { id: id === '' ? null : id, n: Number(n), fresh: fresh === 't' };
    });
  }
  if (method === 'finishAll') {
    if (text[0] !== 'p') throw refused();
    return text.length === 1 ? [] : text.slice(1).split('\0').map(record => {
      const at = record.indexOf('\u0001');
      if (at < 0) throw refused();
      return [record.slice(0, at), record.slice(at + 1)];
    });
  }
  if (method === 'info') {
    const [id, n, fresh, ...extra] = text.slice(1).split('\0');
    if (text[0] !== 'i' || extra.length || !/^\d+$/.test(n ?? '') || fresh !== 't' && fresh !== 'f') throw refused();
    return { id, n: Number(n), fresh: fresh === 't' };
  }
  if (text === 'u') return undefined;
  if (text === 't' || text === 'f') return text === 't';
  if (text === 'link' || text === 'form' || text === 'watch') return { kind: text };
  if (text === 'refuse-link' || text === 'refuse-form' || text === 'refuse-modifier') return { kind: 'refuse', reason: text.slice(7) };
  if (text === 'n') return { unavailable: true };
  if (text === 'l') return { unavailable: true, lost: true };
  if (text === 'bform' || text === 'blink') return { blocked: text.slice(1) };
  if (/^d\d+$/.test(text)) return Number(text.slice(1));
  if (text[0] === 's') return method === 'takeRequest' ? { violation: text.slice(1) } : text.slice(1);
  if (text[0] === 'q') { const [url, target, rel, ...extra] = text.slice(1).split('\0'); if (extra.length || rel === undefined) throw refused(); return { url, target, rel }; }
  throw refused();
}
const hookOf = tab => {
  const hook = tab?.hook;
  if (typeof hook?.key !== 'string' || typeof hook?.secret !== 'string') throw capabilityError('background popup hook unavailable; use the engine browser path');
  return hook;
};

// A cancelled click reaches the model as one of these. The guard cancels the browser input in the page; whether a
// retry is safe depends on whether any press, release or click was delivered to the page's listeners first
// (a page can act on pointerdown or mousedown), which the hook reports as `passed`.
export const changedMidClick = 'page changed during the click; read again. The page received no press, release or click, so a fresh read and one retry is safe.';
export const changedAfterPress = 'page changed during the click; the page had already received part of it.';
const missedClick = 'the click did not reach the checked element and may have landed somewhere else; read the page before trying again';
const hookUnavailable = 'background popup hook did not answer; use the engine browser path';
// A refused proof, an answer the controller cannot verify, a missing or switched-off hook: the page may be hostile or the
// hook gone, and reading the page again will not help, so the model is sent to the engine browser path.
const hookFailed = error => error?.code === 'HOOK_ANSWER_REFUSED'
  || /background popup hook (refused the call|unavailable|is off|answer refused)/.test(String(error?.message));

// The frame that owns the element: the guard lives in that frame's hook, so it is the frame to disarm and read.
async function ownerFrame(locator, page, timeoutMs) {
  try {
    const pinned = typeof locator.ownerFrame === 'function';
    const handle = pinned ? locator : typeof locator.elementHandle === 'function' ? await locator.elementHandle({ timeout: timeoutMs }) : undefined;
    try { return (await handle?.ownerFrame()) ?? page; } finally { if (!pinned) await handle?.dispose().catch(() => {}); }
  } catch { return page; }
}

// A frame whose site differs from the tab's runs no hook here (cross-site frames are separate processes, and the
// registry's script is on the page target). Same-site frames, about:blank and srcdoc frames that can run scripts always
// have one, so a frame of those that answers "absent" is not trusted to be hookless: a page can forge that answer, and it
// would then be left unarmed. Such a frame fails the arm closed instead. A frame that cannot run scripts at all (its
// iframe's sandbox attribute, or an ancestor's, lacks allow-scripts) is hookless by design: nothing in it can forge an
// answer or run page code, so it needs no hook and does not block the click.
const siteOf = url => {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return /^[\d.]+$|:/.test(hostname) ? hostname : hostname.split('.').slice(-2).join('.');
  } catch { return ''; }
};

// The sandbox attribute of the iframe that holds `frame`, read in the pristine utility world from the parent's side: a string, or
// null for an iframe with none. Throws when the owner cannot be reached.
async function ownerSandbox(frame, timeoutMs) {
  const owner = await deadline(() => frame.frameElement(), timeoutMs, 'frame owner unavailable');
  try { return await deadline(() => trustedRead(owner, (el, arg, native) => native(el, 'getAttribute')('sandbox')), timeoutMs); }
  finally { await owner?.dispose?.().catch(() => {}); }
}

// Every frame Playwright knows except the owner's (same-origin or not, in a shadow root or not, ancestors and
// siblings included) is armed from Node as foreign: any trusted press or click in it is cancelled, because the
// sealed element is not there. Frames created or navigated while armed are armed again as the events arrive (and a
// same-origin one also arms itself at document start); `confirm` re-arms them all just before the click, which also
// repairs a document.open() that erased a frame's listeners. A frame the hook never reached (cross-site frames run no
// hook here) is skipped and only reported afterwards by the landed check; a frame that has a hook but cannot be armed
// fails the click before it is sent. `release` reaches every frame, retries once, and runs even after errors.
// Every call to a frame's hook carries a fresh proof and its signed answer is opened with hookOpen; `hook` is the
// tab's { key, secret } (every frame has the same key and secret).
export function frameShield(page, owner, { hook, token, capMs, timeoutMs = 1000, keys = false, sandboxOf = frame => ownerSandbox(frame, timeoutMs) } = {}) {
  hookOf({ hook });
  const mainFrame = typeof page?.mainFrame === 'function' ? page.mainFrame() : undefined;
  const ownerIs = frame => frame === owner || owner === page && frame === mainFrame;
  // A closed tab's frames are not marked detached, so a closed page counts as gone too.
  const gone = frame => frame.isDetached?.() || frame.page?.().isClosed?.();
  const others = () => (typeof page?.frames === 'function' ? page.frames() : []).filter(frame => !ownerIs(frame) && !frame.isDetached?.());
  const mayLackHook = frame => {
    const here = siteOf(frame.url?.() ?? '');
    return here !== '' && here !== siteOf(mainFrame?.url?.() ?? page?.url?.() ?? '');
  };
  // True when this frame or an ancestor frame is an iframe whose sandbox attribute lacks allow-scripts. The attribute is read
  // from the owner's side in the pristine utility world (trustedRead), so page script cannot answer for it. It is asked only
  // after a frame answered "absent" or could not arm. A frame sandboxed by a CSP header instead (no attribute) is not
  // detected and fails closed. Any doubt reads as false.
  const unscripted = new Map();
  const scriptsOff = frame => {
    if (!unscripted.has(frame)) unscripted.set(frame, (async () => {
      for (let at = frame; at && at !== mainFrame && typeof at.parentFrame === 'function' && at.parentFrame(); at = at.parentFrame()) {
        let value;
        try { value = await sandboxOf(at); } catch { return false; }
        if (typeof value === 'string' && !/(^|[\t\n\f\r ])allow-scripts($|[\t\n\f\r ])/i.test(value)) return true;
      }
      return false;
    })());
    return unscripted.get(frame);
  };
  // null: the frame has no hook and is allowed to have none. Throws for anything else that is not a verified answer.
  const call = async (frame, method) => {
    const { key } = hook, proof = hookProof(hook, method);
    const answer = await deadline(() => method === 'adopt'
      ? frame.evaluate(({ key, proof, token, capMs, keys }) => window[key] ? window[key].adopt(proof, token, capMs, keys) : 'absent',
        { key, proof, token, capMs, keys: keys === true })
      : frame.evaluate(({ key, proof, token }) => window[key] ? window[key].release(proof, token) : 'absent', { key, proof, token }),
    timeoutMs, 'frame unreachable');
    if (answer === 'absent') {
      if (mayLackHook(frame) || await scriptsOff(frame)) return null;
      throw capabilityError('background popup hook unavailable; use the engine browser path');
    }
    const opened = hookOpen(hook, answer);
    // The registry's script also runs in a frame whose scripts are off, but no listener there ever fires (the install probe
    // fails), so its hook answers that it could not arm. Nothing in such a frame runs page code either: skip it like a hookless one.
    if (method === 'adopt' && opened === false && await scriptsOff(frame)) return null;
    return opened;
  };
  const pending = new Set(), late = new Set();
  let ending = false, failed = false, unarmable = false;
  // 'armed', 'skipped' (no hook, or the frame is gone) or 'failed' (a hook that would not arm, or would not answer).
  // unarmable: a frame failed in a way another try will not mend (it lacks a hook it should have, or its hook refused), as
  // against one that was slow, so the click's message can say the engine browser path is needed instead of promising a retry.
  const adoptOne = async frame => {
    let error;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await call(frame, 'adopt');
        if (reply !== null && reply !== true) unarmable = true;
        return reply === null ? 'skipped' : reply === true ? 'armed' : 'failed';
      } catch (caught) { if (gone(frame)) return 'skipped'; error = caught; }
    }
    if (hookFailed(error)) unarmable = true;
    return 'failed';
  };
  const onFrame = frame => {
    if (ownerIs(frame)) return;
    // Once release has started, a frame that appears or navigates is only released again, never armed.
    if (ending) { late.add(frame); return; }
    const task = adoptOne(frame).then(result => { if (result === 'failed') failed = true; }, () => { failed = true; });
    pending.add(task); task.then(() => pending.delete(task));
  };
  page?.on?.('framenavigated', onFrame);
  page?.on?.('frameattached', onFrame);
  const armAll = async () => {
    await Promise.all([...pending]);
    const results = await Promise.all(others().map(adoptOne));
    return !failed && results.every(result => result !== 'failed');
  };
  const releaseOne = async frame => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const reason = await call(frame, 'release'); return typeof reason === 'string' ? reason : undefined; }
      catch { if (gone(frame)) return undefined; }
    }
    return 'the checked element changed';
  };
  return {
    get unarmable() { return unarmable; },
    // Arms every other frame; false when one that has a hook could not be armed.
    arm: armAll,
    // Called just before the click is sent: arms again whatever is new or was rewritten since.
    confirm: armAll,
    // Releases every frame (also those created while the first pass ran) and returns the first veto, if any.
    async release() {
      ending = true;
      await Promise.allSettled([...pending]);
      const done = new Set();
      let bad;
      try {
        for (let pass = 0; pass < 4; pass++) {
          const frames = others().filter(frame => !done.has(frame) || late.has(frame));
          late.clear();
          if (!frames.length) break;
          for (const frame of frames) done.add(frame);
          for (const reason of await Promise.all(frames.map(releaseOne))) bad ??= reason;
        }
      } finally { page?.off?.('framenavigated', onFrame); page?.off?.('frameattached', onFrame); }
      return bad;
    },
  };
}

// With { keys: true } (a trusted Enter or Space, with Shift or Control in a text field) the click callback sends a key, not a click:
// the shield is armed with { keys: true } so every keydown, keypress, keyup, click and submit is checked against the sealed element
// and its form, every other frame and every document created while the key is in flight is locked (keyFrames), and the callback's
// `between` lets the key be sent in two halves so the frames the key's handler created can be locked before it is released. The
// outcome of a veto then says the key may have activated and must not be resent.
export async function backgroundClick(tab, locator, click, options = {}) {
  if (process.env.SLEIGHT_MC1 === '0' || options.press || options.keys)
    return backgroundClickOnce(tab, locator, click, options);
  const pinned = typeof locator.ownerFrame !== 'function' && typeof locator.elementHandle === 'function'
    ? await locator.elementHandle({ timeout: options.timeoutMs ?? 1000 }) : undefined;
  try {
    const target = pinned ?? locator;
    try { return await backgroundClickOnce(tab, target, click, { ...options, mc1: true }); }
    catch (error) {
      if (error.code !== 'MC1_RETRY') throw error;
      options.onRetry?.();
      try { return await backgroundClickOnce(tab, target, click, { ...options, mc1: true, retried: true }); }
      catch (retryError) { if (retryError.message === changedMidClick) retryError.message += ' (after one settled click retry)'; throw retryError; }
    }
  } finally { await pinned?.dispose().catch(() => {}); }
}

async function backgroundClickOnce(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000, press = false, keys = false, paste = false, mc1 = false, retried = false, recover = true, modifier } = {}) {
  const token = randomUUID(), hook = hookOf(tab), { key } = hook;
  let frame = tab.page, completed = false, others;
  // Concludes the owner frame's shield and releases every other frame; each runs even if the other throws. A key concludes the
  // owner first: the release of the other frames also walks the owner's own tree, and must find its shield already read.
  // 'absent' stands for no hook in the document the click left behind; a page can fake it, which only fails the call.
  const disarm = async () => {
    const concluding = Promise.resolve().then(() => frame.evaluate(({ key, proof, token }) => window[key] ? window[key].conclude(proof, token) : 'absent', { key, proof: hookProof(hook, 'conclude'), token }));
    const releasing = keys ? concluding.then(() => {}, () => {}).then(() => others?.release()) : others?.release() ?? Promise.resolve(undefined);
    const [own, rest] = await Promise.allSettled([concluding, releasing]);
    // A click that closed its own tab leaves nothing to veto in the other frames.
    const closed = tab.closed || tab.page.isClosed?.();
    const elsewhere = rest.status === 'fulfilled' && !closed ? rest.value : undefined;
    let report = {}, refused = false;
    if (own.status === 'fulfilled' && own.value !== 'absent') {
      try { report = hookOpen(hook, own.value); }
      catch (error) { if (!hookFailed(error)) throw error; refused = true; }
    }
    return { bad: report.bad ?? elsewhere, landed: report.landed, passed: report.passed, refused };
  };
  // The click callback calls this once the rules have read the element, before it spends any authority.
  const verify = async evidence => {
    const [reply, armed] = await Promise.all([
      deadline(async () => hookOpen(hook, await frame.evaluate(({ key, proof, token, evidence }) => window[key].expect(proof, token, evidence),
        { key, proof: hookProof(hook, 'expect'), token, evidence })), timeoutMs).catch(error => hookFailed(error) ? hookUnavailable : undefined),
      others.confirm().catch(() => false)]);
    if (reply === hookUnavailable) return hookUnavailable;
    if (reply === true && !armed && others.unarmable) return hookUnavailable;
    return reply === true && armed ? true : changedMidClick;
  };
  let cancelled, failure, reported, report;
  try {
    let prepared;
    try {
      prepared = hookOpen(hook, await deadline(() => locator.evaluate((element, { key, prepare, reveal, token, capMs, press, modifier }) => {
        const hook = window[key];
        if (!hook) throw Error('background popup hook unavailable; use the engine browser path');
        const result = hook.prepare(prepare, element, token, capMs, press, modifier);
        hook.reveal(reveal, element);
        return result;
      }, { key, prepare: hookProof(hook, 'prepare'), reveal: hookProof(hook, 'reveal'), token, capMs: timeoutMs + 1000, press, modifier }, { timeout: timeoutMs }), timeoutMs));
    } catch (error) {
      // The one refusal the hook states itself: name it, so the model is not sent to the engine path for a focus it can move.
      failure = /document focus is inside a frame/.test(error?.message)
        ? Error('focus is held inside a frame (a card field, say) that would receive the background modifier; click a page element outside it first')
        : capabilityError('background popup preparation failed; use the engine browser path');
      throw failure;
    }
    if (prepared?.kind === 'refuse' && prepared.reason === 'modifier') throw Error('modified clicks require Command or Control on a target without links, controls or window.open handlers; use a plain click');
    if (prepared?.kind === 'refuse') throw Error(prepared.reason === 'link'
      ? 'Enter would open this link in a new tab, and sleight cannot check where it goes; click the link instead'
      : 'Enter would submit this form into a new tab; click its submit button instead');
    const modified = prepared === true || prepared?.kind === 'link';
    frame = await ownerFrame(locator, tab.page, timeoutMs);
    others = keys ? keyFrames(tab, frame === tab.page ? tab.page.mainFrame?.() ?? frame : frame, { hook, token, capMs: timeoutMs + 4000, timeoutMs, paste })
      : frameShield(tab.page, frame, { hook, token, capMs: timeoutMs + 4000, timeoutMs });
    // Move the pointer onto the element first, so a swap the pointer's arrival triggers lands before the seal is
    // taken, then wait one frame in the page and seal what this click activates. The click callback classifies
    // after this; the hook cancels any input that no longer matches. An element with no box (an image-map area)
    // gets no move; the seal still covers it.
    if (typeof locator.boundingBox === 'function' && tab.page.mouse) {
      const box = await locator.boundingBox({ timeout: timeoutMs });
      if (box) await tab.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }
    try {
      // The shield outlives the click timeout: a click delayed by a busy page is still checked, and one that
      // arrives after this cap is cancelled. The other frames are armed in the same step. Enter in a field makes the
      // browser click the form's default button: for a press that click is the press working.
      const [armed, othersArmed] = await Promise.all([deadline(() => locator.evaluate(async (element, { key, settle, guard, token, capMs, press, keys, paste, mc1 }) => {
        const hook = window[key];
        await hook.settle(settle);
        return hook.guard(guard, element, token, capMs, { press, keys, paste, ...(mc1 ? { mc1: true } : {}) });
      }, { key, settle: hookProof(hook, 'settle'), guard: hookProof(hook, 'guard'), token, capMs: timeoutMs + 4000, press: !!press, keys: keys === true, paste: paste === true, ...(mc1 ? { mc1: true } : {}) }, { timeout: timeoutMs }), timeoutMs), others.arm()]);
      if (hookOpen(hook, armed) !== true) throw capabilityError('click guard unavailable; use the engine browser path');
      if (!othersArmed) throw others.unarmable ? capabilityError('background popup hook unavailable; use the engine browser path') : capabilityError('frame unavailable; use the engine browser path');
    } catch (error) {
      if (error?.code === 'KEY_FRAMES') throw error;
      if (/^(?:click guard|frame) unavailable;/.test(error?.message)) throw failure = error;
      throw hookFailed(error) ? failure = capabilityError(hookUnavailable) : (keys ? capabilityError(keyGuardUnavailable) : Error(changedMidClick));
    }
    const checkpoint = tab.popupCheckpoint?.();
    tab.background = modified; // Read by the result: a popup after an unmodified click probably took the foreground.
    let result;
    try {
      result = await click({ ...(modified ? { modifiers: ['ControlOrMeta'] } : {}), ...(keys && tab.cdp?.on ? { between: others.between } : {}) }, verify);
      // A frame the key created, or a frame that cannot be reached, may have taken the key unguarded.
      if (keys && others.unguarded()) throw Error('a frame created by the key could not be guarded; use the engine browser path');
    } catch (error) {
      if ((tab.closed || tab.page.isClosed?.()) && tab.parent && !tab.parent.page.isClosed()
        && /target.*closed/i.test(error.message)) result = { closed: true, opener: tab.opener };
      else {
        // Paste owns clipboard cleanup inside the callback. Preserve its
        // restoration result even when the shield also observed a page change.
        if (paste) failure = error;
        throw error;
      }
    } finally { if (modified) await tab.page.keyboard.up('ControlOrMeta').catch(() => {}); }
    if (result?.closed !== true && !tab.closed && !tab.page.isClosed?.() && (prepared?.kind === 'link' || prepared?.kind === 'watch')) {
      // A plain click on a watched link or form often navigates, which destroys the arm with the document: that
      // is the click working, not a default that changed. Only the evaluate may fail that way; a refused or forged
      // answer still throws. The arm lives in the frame that owns the element.
      let answer;
      try { answer = await frame.evaluate(({ key, proof, token }) => window[key] ? window[key].takeRequest(proof, token) : 'absent',
        { key, proof: hookProof(hook, 'takeRequest'), token }); }
      catch (error) { if (prepared.kind !== 'watch') throw error; }
      const request = answer === undefined ? undefined : answer === 'absent' ? { unavailable: true, lost: true } : hookOpen(hook, answer);
      if (request?.violation) { cancelled = request.violation; return result; }
      if (request?.unavailable && !(prepared.kind === 'watch' && request.lost))
        throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request?.blocked) throw reported = Error(request.blocked === 'form'
        ? 'the page changed this form to submit into a new tab while it was being submitted; nothing was sent, read the page before retrying'
        : 'the page changed this link to open somewhere sleight cannot check; nothing was opened, read the page before retrying');
      if (request?.url) {
        if (typeof tab.openChild !== 'function') throw capabilityError('background link opening needs the owned page registry; use the engine browser path');
        await tab.openChild(request.url, { target: request.target, rel: request.rel });
      }
    }
    await tab.settlePopups?.(checkpoint, { background: modified });
    completed = result?.closed !== true && !tab.closed && !tab.page.isClosed?.();
    return result;
  } catch (error) {
    if (failure || !hookFailed(error)) throw error;
    throw failure = capabilityError(hookUnavailable);
  } finally {
    let retry = false;
    if (mc1 && !retried && !failure && !reported && !press && !keys) {
      try {
        if (typeof recover === 'function' ? recover() === true : recover === true)
          retry = hookOpen(hook, await deadline(() => locator.evaluate((element, { key, proof, token }) => window[key].retry(proof, element, token),
            { key, proof: hookProof(hook, 'retry'), token }, { timeout: timeoutMs }), timeoutMs)) === true;
      } catch { /* An absent, late or unverified answer grants no retry. */ }
    }
    // A hook that cannot vouch for its own answer, or refused the call, may have vetoed the input: say so rather than
    // report a click delivered. A page that navigated away or closed just ends the evaluate, which is not a veto.
    try { report = await disarm(); } catch { report = {}; }
    if (report.refused) cancelled ??= 'the page hook did not answer';
    cancelled ??= report.bad;
    // The guard cancelled the input: say so instead of reporting a delivered click. A retry is safe only when the hook
    // confirms that no press, release or click reached the page before the veto. An error already on its way out that
    // names the hook (refused proof, unavailable hook) or the change the page made (a flipped link or form) is clearer
    // than this and stays.
    if (cancelled && !failure && !reported) {
      const error = Error(keys ? keyMessage(cancelled) : report.passed === false ? changedMidClick : changedAfterPress);
      if (retry && report.passed === false && (cancelled === 'the checked element changed' || cancelled === 'the input landed on a different element')) error.code = 'MC1_RETRY';
      throw error;
    }
    // A click was sent and no press or click reached the sealed element's document: it went somewhere else.
    if (completed && (paste ? report.passed === false : report.landed === false) && !failure && !reported) throw Error(missedClick);
  }
}

const keyMessage = reason => reason + '. The key may have activated; read the page before deciding, and do not resend it';
const keyReleased = 'the key was released in a document that was not checked';
const keyGuardUnavailable = 'background key guard unavailable; use the engine browser path';
const keyFramesUnguarded = 'a frame could not be guarded before the key; use the engine browser path';
const keyError = message => Object.assign(Error(message), { code: 'KEY_FRAMES' });

// Every frame other than the checked element's, for a key (backgroundClick with { keys: true }). The hook is registered at document
// start, so no page listener runs before it. Every frame is locked, so a page script cannot move focus into it to take the key. A
// document that does not exist yet (a frame the key's handler inserts, re-points or navigates, a cross-site frame that starts in
// another process) is locked too: a script that runs at the start of every new document, before the page's own scripts, installs a
// deny lock that expires with the key (through the page session in the frames that share its process, through the CDP filter in
// the frames in other processes; not through Playwright's addInitScript, which runs its scripts at once in a frame whose document
// has already started and so puts a hook there behind the page's own listeners). The key goes down in two halves, and between() runs
// after it goes down and before it is released: a script-created frame that navigates to a same-origin address reuses the window of
// its initial empty document, and the commit erases the listeners the start-of-document script put there, so between() waits for
// such a navigation to commit, restores the listeners and locks every frame again; only then is the key released.
// Every call to a frame's hook carries a fresh proof and its signed answer is opened with hookOpen; the lock script that runs
// at the start of each new document carries one proof for the whole key, which each document accepts once, and its answer is
// not read (the surveys below check what it did).
// Returns { arm, between, release, unguarded, confirm }: release() removes the scripts, reads every frame's veto and returns the
// first, if any (an Error with code KEY_FRAMES from arm() is a frame that could not be guarded).
function keyFrames(tab, owner, { hook, token, capMs, timeoutMs = 1000, settleMs = 400, paste = false }) {
  const until = Date.now() + capMs, { key } = hook, literal = JSON.stringify;
  const settle = (work, ms = timeoutMs) => deadline(work, ms);
  let lockScript, frameLock, unguarded = false, ownerId = null;
  const cdp = tab.cdp, track = { dirty: false, pending: new Set(), wake: undefined };
  const wake = () => { const resolve = track.wake; track.wake = undefined; resolve?.(); };
  const events = {
    'Page.frameAttached': () => { track.dirty = true; },
    'Page.frameDetached': () => wake(),
    'Page.frameNavigated': event => { track.dirty = true; track.pending.delete(event.frame?.id); wake(); },
    'Page.frameStoppedLoading': event => { track.pending.delete(event.frameId); wake(); },
    // A frame's first navigation, to an address other than about:blank, is the one that reuses the empty document's window.
    'Page.frameRequestedNavigation': event => {
      track.dirty = true;
      if (event.reason === 'initialFrameNavigation' && event.url !== 'about:blank') track.pending.add(event.frameId);
    },
  };
  // One call of a hook method in a frame, in a fixed expression (the key and the proof are literals): its signed answer, opened,
  // or undefined for a frame without a hook.
  const ask = async (context, method, ...args) => {
    const answer = await settle(() => context.run(`window[${literal(key)}] ? window[${literal(key)}].${method}(${[hookProof(hook, method), ...args].map(value => literal(value ?? null)).join(',')}) : 'absent'`));
    return answer === 'absent' ? undefined : hookOpen(hook, answer);
  };
  // Every frame of the page, reached by every route there is: Playwright's frames, and the frames in other processes that the CDP
  // filter holds a session for (Playwright often never attaches those). Each answers with its hook's tree: the windows from it
  // down that script can reach, each with a hook id and the number of children it has (counted by a getter captured before the
  // page's scripts). A frame reached by two routes answers with the same hook id and counts once. A hook counts only if it was
  // there at the start of its document: one put in later sits behind the page's own listeners and vetoes nothing they do.
  const sessions = () => { try { return tab.frames?.sessions() ?? []; } catch { return []; } };
  const gone = context => context.frame ? context.frame.isDetached() : !sessions().includes(context.name);
  const survey = async () => {
    const contexts = [
      ...tab.page.frames().map(frame => ({ frame, run: source => frame.evaluate(source) })),
      ...sessions().map(name => ({ name, run: source => tab.frames.evaluate(name, source) })),
    ];
    await Promise.all(contexts.map(async context => {
      try { context.info = await ask(context, 'tree'); } catch { context.info = undefined; }
      context.valid = Array.isArray(context.info) && context.info.length > 0 && context.info.every(node => node.id !== null && node.fresh === true);
      if (context.frame !== undefined && context.frame === owner && context.valid) ownerId = context.info[0].id;
    }));
    const byId = new Map(), unreached = [];
    for (const context of contexts) {
      context.owner = context.valid && ownerId !== null && context.info.some(node => node.id === ownerId);
      if (!context.valid) { if (!gone(context)) unreached.push(context); continue; }
      for (const node of context.info) byId.set(node.id, byId.get(node.id) ?? { n: node.n, owner: node.id === ownerId });
    }
    return { contexts, unique: [...byId.values()], unreached };
  };
  const finishAll = async () => {
    const { contexts } = await survey().catch(() => ({ contexts: [] }));
    const answers = await Promise.all(contexts.filter(context => context.valid).map(async context => {
      try { return await ask(context, 'finishAll', token); } catch { return undefined; }
    }));
    // The frame holding the checked element may have been navigated by the key (a search form): its new document blocks the
    // release of the key, which is not an activation.
    return answers.flatMap(value => Array.isArray(value) ? value : [])
      .filter(([id, reason]) => !(reason === keyReleased && id === ownerId)).map(([, reason]) => reason);
  };
  const walkAll = async (found, method, args, onFail) => {
    await Promise.all(found.contexts.filter(context => context.valid).map(async context => {
      let value;
      try { value = await ask(context, method, ...args); } catch { value = undefined; }
      if (value !== true && !gone(context)) onFail(context);
    }));
  };
  // The checked frame keeps its seal; every other window below any route is locked. A lock that does not take means the frame is not
  // guarded.
  const lockAll = found => walkAll(found, 'lockAll', [token, capMs, ownerId, paste], () => { throw keyError(keyFramesUnguarded); });
  // Restores a reused window's listeners and locks every document that is not the checked one; a frame that cannot be reached
  // or locked (and is not the checked frame) means the key may have been taken unguarded.
  const resync = async found => {
    if (found.unreached.some(context => !context.owner)) unguarded = true;
    await walkAll(found, 'resyncAll', [token, capMs, paste], context => { if (!context.owner) unguarded = true; });
  };
  // A frame in another process is known to the page before anything can reach it, and one that nothing reaches cannot be locked.
  // Resolves to the frames once every frame the windows count has been reached, or to undefined when that does not happen in ms.
  const reached = async ms => {
    for (const waitUntil = Date.now() + ms; ; await new Promise(resolve => setTimeout(resolve, 25))) {
      try {
        const found = await survey();
        if (!found.unreached.length && 1 + found.unique.reduce((sum, entry) => sum + entry.n, 0) <= found.unique.length) return found;
      } catch { return undefined; }
      if (Date.now() >= waitUntil) return undefined;
    }
  };
  // Called with the key down. A round trip to the page first, so every frame event its handlers caused has arrived.
  const between = async ({ timeoutMs: budgetMs } = {}) => {
    // Paste shares one deadline across the existing frame-lock wait. Enter and
    // Space retain their landed behavior and their existing wait budget.
    const end = paste ? Date.now() + Math.min(500, Math.max(1, budgetMs ?? 500)) : Infinity;
    const remaining = () => {
      if (Date.now() >= end) throw keyError('paste frame-lock wait exceeded the 500 ms staged limit');
      return Math.min(timeoutMs, end - Date.now());
    };
    const bounded = work => paste ? deadline(work, remaining()) : work();
    for (let round = 0; round < 4; round++) {
      if (paste) await bounded(() => tab.page.mainFrame().evaluate(() => 0));
      else await settle(() => tab.page.mainFrame().evaluate(() => 0)).catch(() => {});
      const waitUntil = Math.min(end, Date.now() + settleMs);
      while (track.pending.size && Date.now() < waitUntil) await new Promise(resolve => { track.wake = resolve; setTimeout(wake, Math.max(1, waitUntil - Date.now())); });
      remaining();
      if (!track.dirty) return;
      track.dirty = false;
      const found = await bounded(() => reached(Math.min(settleMs, remaining())));
      remaining();
      if (found) await bounded(() => resync(found)); else unguarded = true;
    }
  };
  return {
    async arm() {
      // The same install source the registry uses (the key and the secret, by hookSource), then the lock with a proof: a document
      // that has no hook yet gets it first, and one that has it (the registry's script ran earlier) is locked at once.
      const lockSource = `${hookSource(hook)};try{window[${literal(key)}].lock(${literal(hookProof(hook, 'lock'))},${literal(token)},${until}-Date.now(),${paste === true})}catch(e){}`;
      try {
        if (tab.cdp?.send) lockScript = (await settle(() => tab.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: lockSource }))).identifier;
        if (tab.frames) frameLock = await settle(() => tab.frames.addScript(lockSource));
      } catch { throw keyError('a document created by the key could not be guarded; use the engine browser path'); }
      const found = await reached(timeoutMs);
      if (!found) throw keyError(keyFramesUnguarded);
      try { await lockAll(found); } catch { throw keyError(keyFramesUnguarded); }
      if (cdp?.on) for (const [name, handler] of Object.entries(events)) cdp.on(name, handler);
      return true;
    },
    // Nothing to re-arm just before a key: the seal and the locks hold until release.
    confirm: async () => true,
    between,
    unguarded: () => unguarded,
    async release() {
      if (cdp?.off) for (const [name, handler] of Object.entries(events)) cdp.off(name, handler);
      if (lockScript) await settle(() => tab.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: lockScript })).catch(() => {});
      if (frameLock) await settle(() => frameLock.remove()).catch(() => {});
      const verdicts = await finishAll().catch(() => []);
      return verdicts.find(value => typeof value === 'string');
    },
  };
}

// browser is the Playwright connection through V1's CDP filter; session is the
// approved root CDP {send,on,off,sessionId}. Existing pages are never acquired.
export function createPageRegistry({ browser, session, context = browser?.contexts()[0], upstream, ownTarget, releaseTarget, frames,
  endpoint, endpointBlocked, timeoutMs = 5000, popupWaitMs = 2000, downloadStore = createDownloadStore(), canResumeHandoff = handoffReadReady } = {}) {
  if (!context || typeof session?.send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('approved browser connection required');
  if (ownTarget !== undefined && (typeof ownTarget !== 'function' || typeof upstream?.send !== 'function'))
    throw capabilityError('trusted popup admission needs the upstream CDP connection; use the engine browser path');
  if (frames !== undefined && !['sessions', 'addScript', 'evaluate'].every(name => typeof frames?.[name] === 'function'))
    throw Error('approved frame sessions required');
  let hook = newHook();
  const records = new Map(), targets = new Map(), metadata = new WeakMap(), seen = new Map(), allocations = new Map(), tasks = new Set(), blockedTargets = new Set();
  const namedChildren = new Map();
  const queued = new WeakMap();
  let namedQueue = Promise.resolve();
  let ended = false, cleanup, handoffActive;
  const track = promise => {
    tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise;
  };
  const startDeveloper = async (entry, resuming = false) => {
    entry.developer?.stop();
    if (ended || entry.closed || entry.released || !entry.cdp || handoffActive && !resuming) return;
    // Round forward so buffered events from the same millisecond are excluded.
    const developer = entry.developer = createDeveloperRead(entry.cdp, { since: Date.now() + 1 });
    await deadline(() => developer.ready, timeoutMs);
    if (ended || entry.closed || entry.released || entry.developer !== developer) developer.stop();
  };
  const identify = page => {
    if (!metadata.has(page)) metadata.set(page, (async () => {
      const cdp = await context.newCDPSession(page);
      try {
        const { targetInfo } = await cdp.send('Target.getTargetInfo');
        if (targetInfo?.type !== 'page' || !targetInfo.targetId) throw capabilityError('owned page identity unavailable; use the engine browser path');
        return { cdp, targetInfo };
      } catch (error) { await cdp.detach().catch(() => {}); throw error; }
    })());
    return metadata.get(page);
  };
  const install = async entry => {
    const cdp = entry.cdp;
    const nativeNavigation = (event, cancel = () => cdp.send('Page.stopLoading')) => {
      if (ended || entry.closed || entry.released || entry.releasing || entry.cdp !== cdp) return;
      let native;
      try { native = !/^(https?|javascript|blob|data|about):$/.test(new URL(event.url).protocol); } catch { native = true; }
      if (!native) return;
      entry.state.nativeNavigationNo = (entry.state.nativeNavigationNo ?? 0) + 1;
      // This event is a notification, not a veto. Cancellation can race the
      // external handler, so the result always reports the attempted escape.
      cancel().catch(() => {});
    };
    if (frames?.watchNavigations) {
      entry.frameNavigationWatch?.remove();
      entry.frameNavigationWatch = await frames.watchNavigations(entry.targetId, nativeNavigation);
    }
    if (entry.nativeSession !== cdp) {
      entry.nativeSession = cdp;
      cdp.on('Page.frameRequestedNavigation', nativeNavigation);
      cdp.on('Page.frameStartedLoading', event => {
        if (!ended && !entry.closed && !entry.released && entry.cdp === cdp && entry.state.recoveryFetchDisablePending &&
          event.frameId === entry.state.recoveryFrameId) track(disableRecoveryFetch(entry));
      });
      cdp.on('close', () => {
        if (ended || entry.closed || entry.page.isClosed() || entry.released || entry.releasing || entry.cdp !== cdp || entry.reattaching) return;
        entry.developer?.stop();
        entry.state.nativeAttachmentLost = true;
        entry.state.nativeNavigationNo = (entry.state.nativeNavigationNo ?? 0) + 1;
        entry.state.nativeDetachNo = entry.state.nativeNavigationNo;
        entry.script = null; entry.cdp = null;
        metadata.delete(entry.page);
        invalidateRefs(entry.page);
        // Keep the actual work tracked after a caller's wait cap, so release
        // cannot race a late hook installation or start another attachment.
        entry.reattaching = track((async () => {
          const next = await context.newCDPSession(entry.page);
          try {
            const { targetInfo } = await next.send('Target.getTargetInfo');
            if (targetInfo?.type !== 'page' || targetInfo.targetId !== entry.targetId || ended || entry.released || entry.closed)
              throw Error('owned target unavailable');
            await entry.frameHook?.remove(); entry.frameHook = null; entry.script = null;
            entry.cdp = next;
            await install(entry);
            if (ended || entry.released || entry.closed) throw Error('owned target released during attachment');
            await startDeveloper(entry);
            metadata.set(entry.page, Promise.resolve({ cdp: next, targetInfo }));
            entry.state.nativeAttachmentLost = false;
          } catch (error) { await next.detach().catch(() => {}); throw error; }
        })().catch(() => {
          entry.developer?.stop();
          entry.state.nativeAttachmentLost = true;
          entry.script = null; entry.cdp = null;
          metadata.delete(entry.page);
        })
          .finally(() => { entry.reattaching = null; }));
      });
    }
    if (!entry.windowOpenHandler) entry.windowOpenHandler = () => {
      entry.windowOpenNo++;
      if (ownTarget && !handoffActive) {
        const discovery = track(discoverPopups(entry)).catch(() => { entry.popupPending = true; });
        entry.openings.add(discovery); discovery.then(() => entry.openings.delete(discovery));
      }
    };
    entry.cdp.off('Page.windowOpen', entry.windowOpenHandler);
    entry.cdp.on('Page.windowOpen', entry.windowOpenHandler);
    await entry.cdp.send('Page.enable');
    await entry.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const source = hookSource(entry.hook);
    const { identifier } = await entry.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    if (!identifier) throw capabilityError('background popup hook installation failed; use the engine browser path');
    entry.script = identifier;
    const result = await entry.cdp.send('Runtime.evaluate', { expression: source, returnByValue: true });
    if (result.exceptionDetails) throw capabilityError('background popup hook installation failed; use the engine browser path');
    // The page session's script does not reach a frame in another process (a cross-site iframe). The filter puts the hook at the
    // start of every document in such a frame, before that frame is resumed. Playwright's addInitScript is not used: it runs its
    // scripts at once in a frame whose document has already started, which puts the hook behind the page's own listeners.
    const framesHooked = async () => {
      await hookFrames(entry, source);
      if (entry.frames) entry.frameHook = await entry.frames.addScript(source);
    };
    if (result.result?.value === true) { await framesHooked(); return; }
    // The install refused because the property is taken. That is fine when the occupant is this registry's own hook,
    // which a window.open handle's first document runs before the handle reaches the page; it must prove it by signing
    // an answer with the secret. Anything else (a stale or planted object) leaves the tab without a hook.
    const probe = await entry.cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { try { return window[${JSON.stringify(entry.hook.key)}].verdict(${JSON.stringify(hookProof(entry.hook, 'verdict'))}, '') } catch { return 'absent' } })()` });
    let genuine = false;
    try { genuine = !probe.exceptionDetails && typeof probe.result?.value === 'string' && probe.result.value !== 'absent' && hookOpen(entry.hook, probe.result.value) === undefined; } catch { /* Not the hook's answer. */ }
    if (!genuine) throw capabilityError('background popup hook installation failed; use the engine browser path');
    await framesHooked();
  };
  // A page adopted after it loaded (a popup) has child frames that began before the registry's script was registered. Give
  // the same-site ones the hook too, so the controller can arm them: frameShield treats a same-site frame with no hook
  // as a failure, since a page can fake that answer. Cross-site frames are separate processes and stay hookless.
  const hookFrames = async (entry, source) => {
    const here = siteOf(entry.page.url()), main = entry.page.mainFrame?.();
    for (const frame of entry.page.frames?.() ?? []) {
      const site = siteOf(frame.url?.() ?? '');
      if (frame === main || (site !== '' && site !== here)) continue;
      try { await frame.evaluate(source); } catch { /* Gone, or cannot run it: arming this frame will fail closed. */ }
    }
  };
  const removeHook = async entry => {
    entry.frameNavigationWatch?.remove(); entry.frameNavigationWatch = null;
    if (entry.script) {
      await entry.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.script }); entry.script = null;
    }
    if (entry.frameHook) { await entry.frameHook.remove(); entry.frameHook = null; }
    // The frames in other processes switch off too, best effort: a session that is gone has nothing left to switch off.
    if (entry.frames) for (const name of entry.frames.sessions()) {
      const { key } = entry.hook, proof = hookProof(entry.hook, 'off');
      await entry.frames.evaluate(name, `window[${JSON.stringify(key)}] ? window[${JSON.stringify(key)}].off(${JSON.stringify(proof)}) : 'absent'`).catch(() => {});
    }
    if (!entry.page.isClosed()) for (const frame of entry.page.frames()) {
      // One proof per frame: each document keeps its own record of the proofs it has accepted.
      const answer = await frame.evaluate(({ key, proof }) => window[key] ? window[key].off(proof) : 'absent', { key: entry.hook.key, proof: hookProof(entry.hook, 'off') });
      if (answer !== 'absent' && hookOpen(entry.hook, answer) !== true) throw Error('background popup hook would not switch off');
    }
  };
  const adopt = async (page, info, opener) => {
    if (blockedTargets.has(info.targetInfo.targetId)) return;
    trackPage(page, { targets: typeof upstream?.send === 'function' ? () => upstream.send('Target.getTargets') : undefined });
    bindEndpointPage(page, endpoint, info.cdp, { blocked: () => endpointBlocked?.(info.targetInfo.targetId),
      close: () => blockPage(page, info, opener) });
    let blocked = endpointTarget(info.targetInfo, endpoint) || endpointURL(page.url(), endpoint);
    if (!blocked) try { await assertEndpointRead(page); }
    catch (error) { if (error.message !== endpointBlock) throw error; blocked = true; }
    if (blocked) { await blockPage(page, info, opener); return; }
    if (targets.has(info.targetInfo.targetId)) return targets.get(info.targetInfo.targetId);
    const handle = tabHandle(records);
    const entry = { tab: handle, targetId: info.targetInfo.targetId, page, cdp: info.cdp,
      state: { snapshotNo: 0, submitUnconfirmed: false }, opener: opener?.tab, popups: [], popupWaitMs, endpoint,
      closed: page.isClosed(), released: false, queue: Promise.resolve(), openedBySleight: allocations.get(info.targetInfo.targetId)?.bySleight === true,
      canAccessOpener: info.targetInfo.canAccessOpener };
    entry.windowOpenNo = 0;
    entry.openings = new Set(); // Popup discoveries still running: a tab the page opened late is counted once they settle.
    // The hook's key and secret stay off enumeration, so a tab object that is logged or copied never carries them.
    Object.defineProperty(entry, 'hook', { value: hook, enumerable: false, writable: true });
    entry.checkAttachment = async () => {
      if (entry.reattaching) await deadline(() => entry.reattaching, timeoutMs, 'Native debugger reattachment still pending; tab retained. Wait, close, keep or handoff.');
      if (entry.state.nativeAttachmentLost) throw capabilityError('Native debugger detach attempted; native UI outcome unconfirmed. Same-target reattachment failed; dead script and CDP handles cleared, tab retained. Tell the user; close, keep or handoff.');
    };
    entry.parent = opener;
    // A window the page itself opened by that name (window.open) is reused like one this registry named.
    const namedPopup = async (opener, name) => {
      for (const notice of [...opener.popups].reverse()) {
        const child = notice.tab && records.get(notice.tab);
        if (!child || child.closed || child.released || child.releasing || child.page.isClosed()) continue;
        try { if (await deadline(() => child.page.evaluate(() => window.name), timeoutMs) === name) return child; } catch { /* Unreadable popup. */ }
      }
    };
    if (frames) entry.frames = { sessions: () => frames.sessions(entry.targetId), addScript: source => frames.addScript(entry.targetId, source),
      evaluate: (name, expression) => frames.evaluate(entry.targetId, name, expression) };
    if (typeof frames?.observeInput === 'function') entry.observeInput = listener => frames.observeInput(entry.targetId, listener);
    if (typeof frames?.guardWholeRequests === 'function') entry.guardWholeRequests = callbacks => frames.guardWholeRequests(entry.targetId, callbacks);
    entry.openChild = (url, { target = '', rel = '' } = {}) => {
      // Never resolve a page-supplied name against arbitrary browser targets.
      // Only this registry's allocations can acquire or reuse a link name.
      const name = target && !target.startsWith('_') ? target : '';
      if (!name) return openOwned(url, entry);
      const opening = namedQueue.then(async () => {
        tab(entry.tab);
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('invalid browser URL');
        const candidate = namedChildren.get(name) ?? await namedPopup(entry, name);
        if (candidate && !candidate.closed && !candidate.released && !candidate.releasing && !candidate.page.isClosed()) {
          // Two owned tabs may link to one another during their queued clicks.
          // Refuse a busy destination instead of making their queues circular.
          if (queued.has(candidate)) throw Error('named link target is busy; read the page before retrying');
          const reused = await api.enqueue(candidate.tab, async child => {
            let verified = false;
            try {
              const { targetInfo } = await deadline(() => child.cdp.send('Target.getTargetInfo'), timeoutMs);
              const actual = await deadline(() => child.page.evaluate(() => ({ name: window.name, origin: location.origin })), timeoutMs);
              verified = targetInfo?.targetId === child.targetId && targetInfo.type === 'page' && actual.name === name
                && actual.origin === new URL(entry.page.url()).origin && actual.origin === new URL(child.page.url()).origin;
            } catch { /* A stale name is not authority to reuse a target. */ }
            if (!verified) return;
            tab(entry.tab);
            tab(child.tab);
            await child.page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            child.link = { target: name, rel };
            return { tab: child.tab };
          });
          if (reused) return reused;
        }
        namedChildren.delete(name);
        const opened = await openOwned(url, entry, name);
        tab(opened.tab).link = { target: name, rel };
        namedChildren.set(name, tab(opened.tab));
        return opened;
      });
      namedQueue = opening.catch(() => {});
      return deadline(() => track(opening), timeoutMs, 'background named open pending; do not retry before cleanup');
    };
    // Script-started openings the hook held since the last agent step (a count, never page text).
    entry.takeHeld = async () => {
      const answer = await deadline(() => page.evaluate(({ key, proof }) => window[key] ? window[key].take(proof) : 'absent', { key: hook.key, proof: hookProof(hook, 'take') }), timeoutMs);
      return answer === 'absent' ? 0 : hookOpen(hook, answer);
    };
    entry.popupCheckpoint = () => ({ windows: entry.windowOpenNo, popups: entry.popups.length,
      ...(entry.parent ? { opener: { tab: entry.parent.tab, windows: entry.parent.windowOpenNo, popups: entry.parent.popups.length } } : {}) });
    // Backstop for a popup the hook did not shape: a tab the page opened during a click that carried no background
    // modifier is probably in the foreground, because the browser opens it that way. CDP does not say which tab is
    // active, so sleight cannot put the previous one back; it tells the agent instead (takeForeground).
    entry.pageOpened = popup => { for (const row of records.values()) if (row.page === popup) return !row.openedBySleight; return true; };
    // True only for a popup sleight opened, or one a modified click's settling saw and classified as background.
    entry.popupIsBackground = popup => {
      for (const row of records.values()) if (row.page === popup) return row.openedBySleight || entry.popups.some(notice => notice.tab === row.tab && notice.background === true);
      return false;
    };
    entry.foregroundPopups = 0;
    // A tab the page opened that no click's settling has accounted for (a script that opens a tab after the click's
    // dispatch ended, so it carried no background modifier) is probably in the foreground too.
    entry.takeForeground = async () => {
      // A tab the page opened a moment ago may not have been admitted yet: wait, for a short bounded time, for those to settle.
      if (entry.openings.size) {
        let timer;
        await Promise.race([(async () => { await Promise.allSettled([...entry.openings]); await idle(); })().catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, Math.min(popupWaitMs, 1000)); })]);
        clearTimeout(timer);
      }
      let count = entry.foregroundPopups; entry.foregroundPopups = 0;
      for (const notice of entry.popups) {
        if (notice.counted || notice.blocked || !notice.tab) continue;
        notice.counted = true;
        const child = records.get(notice.tab);
        if (child && !child.openedBySleight) count++;
      }
      return count;
    };
    // Tabs this page opened that it can still raise to the foreground. A cross-origin window cannot be reached by any patch
    // in the page, the raise runs in the opener's process and the popup's own document sees nothing, and CDP reports no
    // active tab. Same-origin windows run the hook, which makes their focus() do nothing. A window opened with noopener, or
    // one that dropped its opener, gives the page no handle to call focus() on (canAccessOpener is false), so it is not listed.
    entry.raisablePopups = async () => {
      const found = [];
      let origin;
      try { origin = new URL(page.url()).origin; } catch { return found; }
      for (const notice of entry.popups) {
        const child = notice.tab && records.get(notice.tab);
        if (!child || child.openedBySleight || child.closed || child.released || child.releasing || child.page.isClosed()) continue;
        try {
          const url = child.page.url();
          if (url === 'about:blank' || new URL(url).origin === origin) continue;
        } catch { continue; /* No address yet. */ }
        let access = child.canAccessOpener;
        try { access = (await deadline(() => child.cdp.send('Target.getTargetInfo'), timeoutMs)).targetInfo?.canAccessOpener ?? access; } catch { /* Keep what adoption saw. */ }
        if (access !== false) found.push(child.tab);
      }
      return found;
    };
    entry.settlePopups = async (before, { background = true } = {}) => {
      if (!before) return;
      const sources = [{ entry, before }];
      // Chromium can reparent a new popup to the living opener when the page
      // that opened it closes during dispatch. Honor that native identity.
      const parent = entry.closed && records.get(before.opener?.tab);
      if (parent && !parent.closed && !parent.released) sources.push({ entry: parent, before: before.opener });
      if (sources.every(({ entry, before }) => entry.windowOpenNo === before.windows && entry.popups.length === before.popups)) return;
      const until = Date.now() + popupWaitMs;
      while (!ended && sources.every(({ entry, before }) => entry.popups.length === before.popups) && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, Math.min(10, popupWaitMs)));
      for (const { entry: source, before } of sources) for (const notice of source.popups.slice(before.popups)) {
        notice.counted = true; if (background) notice.background = true;
        const child = records.get(notice.tab);
        if (child) await deadline(() => child.ready, timeoutMs).catch(() => {});
        if (child && !background && !child.openedBySleight) entry.foregroundPopups++;
      }
    };
    records.set(entry.tab, entry); targets.set(entry.targetId, entry);
    allocations.delete(entry.targetId);
    const notice = opener && { tab: entry.tab, opener: opener.tab, closed: entry.closed };
    if (notice) opener.popups.push(notice);
    page.once('close', () => { entry.closed = true; entry.developer?.stop(); if (notice) notice.closed = true; });
    entry.ready = track((async () => {
      if (!entry.closed && !ended) await deadline(() => install(entry), timeoutMs);
      if (!entry.closed && !ended) await startDeveloper(entry);
      if (ended && !entry.closed) await deadline(() => page.close({ runBeforeUnload: false }), timeoutMs);
    })());
    return entry;
  };
  const blockPage = async (page, info, opener) => {
    const targetId = info.targetInfo.targetId, entry = targets.get(targetId);
    if (entry) { entry.blocked = true; entry.developer?.stop(); }
    if (!blockedTargets.has(targetId)) {
      const notice = opener && (opener.popups.find(row => row.tab === entry?.tab && row.tab) ??
        { opener: opener.tab, closed: false, blocked: true });
      if (notice) {
        delete notice.tab; notice.blocked = true;
        if (!opener.popups.includes(notice)) opener.popups.push(notice);
      }
      blockedTargets.add(targetId);
      allocations.set(targetId, { page, cdp: info.cdp, notice });
    }
    await closeAllocation(targetId);
  };
  const heard = page => track((async () => {
    // A discovery handle must not detach the persistent handle an open is using.
    const probe = await context.newCDPSession(page);
    let targetInfo;
    try { ({ targetInfo } = await probe.send('Target.getTargetInfo')); }
    finally { await probe.detach(); }
    if (targetInfo?.type === 'page') seen.set(targetInfo.targetId, page);
    const parent = targets.get(targetInfo?.openerId);
    // A closed opener adopts only a late popup that discovery never reserved (CR4);
    // otherwise discovery and this event would hand Playwright the same target twice.
    if (parent && !handoffActive && !parent.released && (!parent.closed || !allocations.has(targetInfo.targetId)))
      await adopt(page, await identify(page), parent);
  })()).catch(() => {});
  context.on('page', heard);
  const idle = async () => { while (tasks.size) await Promise.allSettled([...tasks]); };
  const closeAllocation = targetId => {
    const allocation = allocations.get(targetId);
    if (!allocation) return Promise.resolve();
    if (!allocation.closing) allocation.closing = deadline(async () => {
      const result = allocation.page ? await allocation.page.close({ runBeforeUnload: false }).then(() => ({ success: allocation.page.isClosed() }))
        : await (allocation.blocked ? upstream : session).send('Target.closeTarget', { targetId });
      if (result?.success !== true) throw Error('background target cleanup unconfirmed');
      allocations.delete(targetId);
      if (allocation.notice) allocation.notice.closed = true;
      if (allocation.cdp) await allocation.cdp.detach().catch(() => {});
    }, timeoutMs).finally(() => { allocation.closing = null; });
    return allocation.closing;
  };
  // V1 hides unknown targets from Playwright. A windowOpen on an owned page is
  // the wakeup; trusted upstream metadata supplies the exact opener, then the
  // registry explicitly admits that child through V1's private own() capability.
  async function discoverPopups(parent) {
    const until = Date.now() + popupWaitMs;
    while (!ended && !handoffActive && !parent.released) {
      const { targetInfos } = await deadline(() => upstream.send('Target.getTargets'), timeoutMs);
      const reparented = parent.closed && parent.parent && !parent.parent.closed && !parent.parent.released ? parent.parent.targetId : undefined;
      const children = targetInfos.filter(info => info.type === 'page' && (info.openerId === parent.targetId || reparented && info.openerId === reparented) &&
        !targets.has(info.targetId) && !allocations.has(info.targetId) && !blockedTargets.has(info.targetId));
      for (const child of children) {
        if (ended || handoffActive || parent.released) return;
        // The exact trusted opener proves ownership before any admission/read.
        // Close endpoint targets upstream without exposing their title or URL.
        if (endpointTarget(child, endpoint) || endpointBlocked?.(child.targetId)) {
          const notice = { opener: parent.tab, closed: false, blocked: true };
          parent.popups.push(notice);
          allocations.set(child.targetId, { blocked: true, notice });
          blockedTargets.add(child.targetId);
          await closeAllocation(child.targetId);
          continue;
        }
        allocations.set(child.targetId, {});
        await ownTarget(child.targetId);
        if (ended) await closeAllocation(child.targetId);
      }
      if (children.length || Date.now() >= until) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(10, popupWaitMs)));
    }
  }
  const tab = id => {
    if (handoffActive) throw Error(handoffMessages.pending);
    const entry = records.get(id);
    if (!entry || entry.released || entry.releasing) throw Error('unknown or releasing owned tab');
    if (entry.blocked) throw Error(endpointBlock);
    if (entry.closed || entry.page.isClosed()) throw Error('owned tab closed; read its opener');
    if (ended) throw Error('turn ended');
    return entry;
  };
  const release = async (id, kind) => {
    const entry = tab(id);
    entry.releasing = true;
    const releasing = track((async () => {
      try {
        if (entry.state.stuck) await terminatePageScripts(entry);
        if (entry.reattaching) await deadline(() => entry.reattaching, timeoutMs, 'Native debugger reattachment still pending; tab retained.');
        await deadline(() => stopPageWaits(entry.page), timeoutMs);
        await deadline(() => entry.queue, timeoutMs);
        await deadline(() => entry.ready, timeoutMs);
        const viewport = await deadline(() => restoreViewport(entry.page, { release: true }), timeoutMs);
        await deadline(() => removeHook(entry), timeoutMs);
        entry.developer?.stop();
        await entry.cdp?.detach();
        await releaseTarget?.(entry.targetId);
        if (entry.page.isClosed()) throw Error('owned tab closed during release');
        entry.released = true; entry.release = kind;
        return { tab: id, kept: true, handoff: kind === 'handoff',
          ...(viewport.includes('previous size unknown') ? { viewport } : {}) };
      } finally { entry.releasing = false; }
    })());
    // A delayed detach/ownership reply remains tracked after the caller's cap.
    return deadline(() => releasing, timeoutMs, 'tab release pending; wait for cleanup before retrying');
  };
  async function openOwned(url, opener, name = '', tracePhase) {
      const phase = name => { try { tracePhase?.(name); } catch {} };
      if (ended) throw Error('turn ended');
      let parsed;
      try { parsed = new URL(url); } catch { throw Error('invalid browser URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('invalid browser URL');
      if (endpointURL(parsed.href, endpoint)) {
        if (opener) { opener.popups.push({ opener: opener.tab, closed: true, blocked: true }); return { blocked: true }; }
        throw Error(endpointBlock);
      }
      let openedEntry;
      const opening = track((async () => {
        phase('browser-open-create-start');
        const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
        phase('browser-open-create-end');
        if (!targetId) throw capabilityError('background target allocation unavailable; use the engine browser path');
        allocations.set(targetId, { bySleight: true });
        const until = Date.now() + timeoutMs;
        while (!seen.has(targetId) && !ended && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (ended || !seen.has(targetId)) {
          await closeAllocation(targetId);
          throw Error(ended ? 'turn ended' : 'background page attachment timed out');
        }
        const page = seen.get(targetId);
        phase('browser-open-attach-end');
        const info = await identify(page);
        phase('browser-open-identify-end');
        const entry = await adopt(page, info, opener);
        phase('browser-open-adopt-end');
        if (!entry) throw Error(endpointBlock);
        openedEntry = entry;
        entry.openedBySleight = true;
        await entry.ready;
        phase('browser-open-ready-end');
        if (ended) throw Error('turn ended');
        if (name && await deadline(() => page.evaluate(name => { window.name = name; return window.name; }, name), timeoutMs) !== name)
          throw capabilityError('background target name unavailable; use the engine browser path');
        phase('browser-open-goto-start');
        try {
          if (typeof page._connection?.toImpl === 'function') await trackPageWaits(page);
          await guardPageTask(entry, () => page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs }), { afterMs: 3000 });
          if (typeof page._connection?.toImpl === 'function') await guardPageTask(entry, () => waitForThinPage(page));
        }
        catch (error) { await assertEndpointRead(page); throw error; }
        phase('browser-open-goto-end');
        await assertEndpointRead(page);
        return { tab: entry.tab };
      })());
      try { return await deadline(() => opening, timeoutMs + 6000, 'background open pending; do not retry before cleanup'); }
      catch (error) { if (openedEntry) error.ownedTab = openedEntry.tab; throw error; }
  }
  const api = {
    tab, idle,
    download: options => track(downloadStore.save({ ...options, transfer: receive => receiveDownload({ url: options.url,
      current: () => !ended && options.current(),
      allowed: url => !endpointURL(url, endpoint) && options.allowed(url), receive,
      async createTarget() {
        if (ended || !options.current()) throw Error('download authority expired');
        const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
        allocations.set(targetId, { bySleight: true });
        try {
          const until = Date.now() + timeoutMs;
          while (!seen.has(targetId) && !ended && options.current() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
          if (!seen.has(targetId) || ended || !options.current()) throw Error('download target unavailable');
          const cdp = await context.newCDPSession(seen.get(targetId));
          allocations.get(targetId).cdp = cdp;
          return { targetId, cdp };
        } catch (error) { await closeAllocation(targetId); throw error; }
      }, closeTarget: closeAllocation }) })),
    async beginHandoff(id, onDrain = () => {}) {
      const requested = tab(id);
      let finishing, result = null, keeping = false, preserved;
      const resumeTarget = () => !requested.closed && !requested.page.isClosed() ? requested : requested.parent;
      const entries = [...records.values()].filter(entry => !entry.released && !entry.closed && !entry.page.isClosed());
      const preserve = () => preserved ??= (async () => {
        // Mark every tab before awaiting anything: one failed detach must never
        // make turn cleanup close another tab the person is using.
        for (const entry of entries) { entry.developer?.stop(); entry.released = true; entry.release = 'handoff'; }
        const results = await Promise.allSettled(entries.map(async entry => {
          let unproved = false;
          if (!entry.page.isClosed()) {
            if (!entry.handoffHooksOff) try { await deadline(() => removeHook(entry), timeoutMs); entry.handoffHooksOff = true; }
            catch { unproved = true; }
            try { await deadline(() => entry.cdp?.detach(), timeoutMs); }
            catch { unproved = true; }
          }
          try { await deadline(() => releaseTarget?.(entry.targetId), timeoutMs); }
          catch { unproved = true; }
          entry.handoffCleanupRequired = unproved;
          if (entry.handoffCleanupRequired) throw Error(handoffMessages.cleanup);
        }));
        if (results.some(row => row.status === 'rejected')) throw Error(handoffMessages.cleanup);
      })();
      const suspension = Object.freeze({
        ownedTabs: entries.length,
        async cancel() {
          keeping = true;
          await finishing?.catch(() => {});
          await preserve();
          if (handoffActive === suspension) handoffActive = undefined;
        },
        finish(keep) {
          keeping ||= keep;
          if (!finishing) finishing = (async () => {
            result = null;
            const target = resumeTarget();
            if (keeping || ended || !target || target.released || target.closed || target.page.isClosed()) {
              await preserve();
            } else {
              try {
                // All owned pages are suspended, so check all of them before
                // restoring access, including a login in a still-open popup.
                for (const entry of entries) if (!entry.closed && !entry.page.isClosed()) {
                  try {
                    if (!await deadline(() => canResumeHandoff(entry.page), timeoutMs)) {
                      if (keeping || ended) { await preserve(); return null; }
                      result = false; return false;
                    }
                  } catch {
                    if (!entry.closed && !entry.page.isClosed()) {
                      if (keeping || ended) { await preserve(); return null; }
                      result = false; return false;
                    }
                  }
                }
                if (keeping || ended) { await preserve(); return null; }
                hook = newHook();
                for (const entry of entries) if (!entry.closed && !entry.page.isClosed()) {
                  entry.hook = hook;
                  entry.handoffHooksOff = false;
                  if (!entry.cdp) {
                    const info = await identify(entry.page);
                    if (info.targetInfo.targetId !== entry.targetId) throw Error('owned target unavailable');
                    entry.cdp = info.cdp;
                  }
                  await deadline(() => install(entry), timeoutMs);
                  await startDeveloper(entry, true);
                  entry.state.nativeAttachmentLost = false;
                  invalidateRefs(entry.page); entry.state.snapshotNo = 0;
                }
                if (keeping || ended) { await preserve(); return null; }
              } catch (error) { await preserve().catch(() => {}); throw error; }
              const fresh = resumeTarget();
              if (!fresh || fresh.released || fresh.closed || fresh.page.isClosed()) await preserve();
              else result = fresh.tab;
            }
            return result;
          })().finally(() => {
            if (result === false) finishing = undefined;
            else if (handoffActive === suspension) handoffActive = undefined;
          });
          return finishing;
        },
      });
      handoffActive = suspension;
      try {
        onDrain(entries.length);
        // Drain earlier captures/actions before showing the card. New calls
        // fail above; no page values are read while the card is waiting.
        await deadline(idle, timeoutMs);
        for (const entry of entries) {
          await deadline(() => entry.queue, timeoutMs);
          await deadline(() => entry.ready, timeoutMs);
          entry.developer?.stop();
          await deadline(() => removeHook(entry), timeoutMs);
          entry.handoffHooksOff = true;
          invalidateRefs(entry.page);
        }
        return suspension;
      } catch (error) { await suspension.finish(true); throw error; }
    },
    openTab: ({ url, tracePhase }) => openOwned(url, undefined, '', tracePhase),
    async list() {
      if (handoffActive) throw Error(handoffMessages.pending);
      await deadline(idle, timeoutMs);
      for (const entry of records.values()) if (!entry.closed && !entry.released && !entry.blocked) {
        try { await assertEndpointRead(entry.page); } catch (error) { if (error.message !== endpointBlock) throw error; }
      }
      return [...records.values()].filter(r => !r.closed && !r.released && !r.blocked).map(r => ({ tab: r.tab, targetId: r.targetId,
        opener: r.opener, url: r.page.url() }));
    },
    // A tab the page closed itself (a sign-in popup) reads as its opener, while this session still owns that opener and it is open.
    closedOpener(id) {
      const entry = records.get(id), opener = entry?.opener && records.get(entry.opener);
      return !ended && entry && (entry.closed || entry.page.isClosed()) && !entry.closedByUs && !entry.released && !entry.blocked
        && opener && !opener.closed && !opener.released && !opener.releasing && !opener.blocked && !opener.page.isClosed() ? opener.tab : undefined;
    },
    enqueue(id, run) {
      const entry = tab(id), task = entry.queue.then(async () => { tab(id); await assertEndpointRead(entry.page); return run(entry); });
      queued.set(entry, (queued.get(entry) ?? 0) + 1);
      const finished = () => { const count = queued.get(entry) - 1; if (count) queued.set(entry, count); else queued.delete(entry); };
      task.then(finished, finished);
      entry.queue = task.catch(() => {}); return track(task);
    },
    async close(id) {
      const entry = tab(id); entry.closedByUs = true; await deadline(() => entry.page.close({ runBeforeUnload: false }), timeoutMs);
      return { tab: id, closed: entry.page.isClosed() };
    },
    keep: id => release(id, 'keep'), handoff: id => release(id, 'handoff'),
    endTurn() {
      ended = true;
      for (const entry of records.values()) entry.developer?.stop();
      if (!cleanup) cleanup = (async () => {
        let settled = true;
        if (handoffActive) try { await handoffActive.finish(true); } catch { settled = false; }
        try { await deadline(idle, timeoutMs); } catch { settled = false; }
        const rows = [];
        for (const targetId of allocations.keys()) {
          try { await closeAllocation(targetId); rows.push({ targetId, closed: true }); }
          catch { rows.push({ targetId, closed: false, cleanupRequired: true }); }
        }
        for (const entry of records.values()) {
          if (entry.releasing) {
            rows.push({ tab: entry.tab, closed: entry.page.isClosed(), cleanupRequired: true }); continue;
          }
          if (entry.released || entry.page.isClosed()) { rows.push({ tab: entry.tab, kept: entry.released, closed: entry.page.isClosed(),
            ...(entry.handoffCleanupRequired ? { cleanupRequired: true } : {}) }); continue; }
          try {
            await deadline(() => entry.page.close({ runBeforeUnload: false }), timeoutMs);
            rows.push({ tab: entry.tab, closed: entry.page.isClosed() });
          } catch { rows.push({ tab: entry.tab, closed: entry.page.isClosed(), cleanupRequired: true }); }
        }
        const cleanedUp = settled && rows.every(row => (row.kept || row.closed) && !row.cleanupRequired);
        if (cleanedUp) context.off('page', heard);
        return { cleanedUp, rows };
      })().finally(() => { cleanup = null; });
      return cleanup;
    },
  };
  return Object.freeze(api);
}
