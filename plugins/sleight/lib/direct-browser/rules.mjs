// v3's four rules. ctx is private worker state, never tool arguments: userMessage
// is the relay's current {source:'user',session,turn,id,text,payment?,upload?};
// consent.consume(terms,target) and files.check(paths,target,message) are trusted,
// synchronous providers. An allow consumes payment authority immediately before
// dispatch. target carries final element metadata, prior metadata, page-observed
// {terms:{page:{item,amount,payee,currency?},method}}, and the owning tab state.
const allow = Object.freeze({ verdict: 'allow' });
const refuse = (message, capability = false) => ({ verdict: 'refuse', message: message + (capability || process.env.SLEIGHT_MT === '0' ? ' Use the engine browser path if needed.' : '') });
const payments = new WeakMap();
const captures = new WeakMap();
const nativeKeyboardTargets = new WeakSet();
// Internal only: v3 grants this after native capability, attachment and exact focus proof. Tool/page flags grant nothing.
export function internalNativeKeyboardTarget(target, allowed) {
  nativeKeyboardTargets.delete(target);
  if (allowed === true) nativeKeyboardTargets.add(target);
}
function nativeKeyboardInput(kind, target) {
  return nativeKeyboardTargets.has(target) && (kind === 'type' || kind === 'press' && keyClass(target.key).kind === 'safe')
    && [target.element, target.prior].filter(Boolean).every(el => el.kind === 'text' && ['textbox', 'searchbox'].includes(el.role)
      && ['payment', 'submit', 'formPayment'].every(key => el[key] === false));
}
const paymentPages = new WeakSet(), historyRequests = new WeakMap();
export const paymentWords = text => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(text ?? '');
const ordinary = new Set(['read', 'open', 'click', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'drag', 'upload',
  'dialog', 'wait', 'back', 'forward', 'reload', 'viewport', 'close', 'keep', 'handoff', 'Target.createTarget']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sameTerms = (a, b) => ['item', 'method', 'amount', 'payee', 'currency'].every(key => a?.[key] === b?.[key]);
const sameDocument = (a, b) => ['session', 'turn', 'document', 'origin'].every(key => text(a?.[key]) && a[key] === b?.[key]);

// Closure-free: pass to locator.evaluate in the target's own frame. Page words
// can only increase risk. Read visible text, aria-label and input value together.
export function inspectElement(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }, seal) {
  const get = (node, key) => Element.prototype.getAttribute.call(node, key) ?? '';
  const inputType = node => node instanceof HTMLInputElement ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get.call(node).toLowerCase() : '';
  const words = node => [get(node, 'aria-label'), read(node, 'textContent'), get(node, 'value'), inputType(node) === 'image' ? get(node, 'alt') : ''].join(' ');
  const payment = value => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(value);
  const type = inputType(el);
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
  const labelControl = (() => {
    if (typeof HTMLLabelElement === 'undefined') return null;
    const label = read(el, 'closest')('label');
    if (!label) return null;
    const interactive = 'a[*|href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),label,select,textarea,video[controls]';
    for (let at = el; at && at !== label; at = read(at, 'parentElement')) if (read(at, 'matches')(interactive)) return null;
    return read(label, 'control');
  })();
  const activation = labelControl || el;
  const formOf = () => {
    const owner = read(activation, 'form');
    if (owner) return owner;
    if (owner === undefined) return enclosing(el, 'form');
    const root = read(el, 'getRootNode')?.();
    return root && read(root, 'nodeType') === 11 ? enclosing(read(root, 'host'), 'form') : owner;
  };
  // A label click forwards to its control, so a label for a file or color input opens the native picker like the input does.
  const forwarded = (() => { try { const label = typeof HTMLLabelElement === 'undefined' ? null : Element.prototype.closest.call(el, 'label'), control = label && Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, 'control').get.call(label);
    return control instanceof HTMLInputElement ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get.call(control).toLowerCase() : ''; } catch { return ''; } })();
  // The control's own accessible name (aria-label, else its text, value, alt or title); empty when aria-labelledby decides it.
  const accName = (get(el, 'aria-labelledby') ? '' : (get(el, 'aria-label') || read(el, 'textContent') || get(el, 'value') || get(el, 'alt') || get(el, 'title') || '')).replace(/\s+/g, ' ').trim().slice(0, 100);
  const tag = read(el, 'localName'), role = get(el, 'role'), form = formOf(), rect = read(el, 'getBoundingClientRect')(), style = getComputedStyle(el);
  const button = tag === 'button' || role === 'button' || ['submit', 'image', 'button', 'reset'].includes(type);
  const state = { tag, role, kind: ['file', 'color'].includes(type) ? type : ['file', 'color'].includes(forwarded) ? forwarded : tag === 'select' ? 'select' : button ? 'button' : tag === 'a' || role === 'link' ? 'link' : 'text',
    form: !!form, connected: read(el, 'isConnected'), visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    enabled: !read(el, 'matches')(':disabled') && get(el, 'aria-disabled') !== 'true', payment: payment(words(el)), accName,
    submit: ['submit', 'image'].includes(type) || tag === 'button' && !!form && get(el, 'type') !== 'button' && get(el, 'type') !== 'reset' ||
      button && /\b(?:save|submit|send|confirm|book|pay|place order|finish|complete)\b/i.test(words(el)) };
  const nativeActivation = implicit => {
    const nativeURL = (node, href) => {
      if (!href) return false;
      try { return !/^(https?|javascript|blob|data|about):$/.test(new URL(href, read(read(node, 'ownerDocument'), 'baseURI')).protocol); }
      catch { return true; }
    };
    const anchor = ['a', 'area'].includes(tag) ? el : read(el, 'closest')('a,area[href]');
    if (anchor && nativeURL(anchor, read(anchor, 'getAttribute')('href') || read(anchor, 'getAttributeNS')?.('http://www.w3.org/1999/xlink', 'href'))) return true;
    if (!form) return false;
    const isSubmitter = node => read(node, 'localName') === 'button' && !/^(button|reset)$/.test(read(node, 'type') ?? '') ||
      read(node, 'localName') === 'input' && /^(submit|image)$/.test(read(node, 'type') ?? '');
    const control = isSubmitter(activation) ? activation : read(activation, 'closest')('button,input');
    const explicit = control && isSubmitter(control);
    if (!explicit && !(implicit && tag === 'input' && /^(text|search|tel|url|email|password|date|month|week|time|datetime-local|number|checkbox|radio|range)$/.test(read(el, 'type') ?? 'text'))) return false;
    const root = read(form, 'getRootNode')?.() ?? read(form, 'ownerDocument'), query = read(root, 'querySelectorAll');
    const candidates = query ? [...query('button,input')].filter(node => read(node, 'form') === form) : [...read(form, 'querySelectorAll')('button,input')];
    const submitter = control && isSubmitter(control) ? control : candidates.find(isSubmitter);
    const override = submitter && read(submitter, 'getAttribute')('formaction');
    return nativeURL(form, override == null ? read(form, 'getAttribute')('action') : override);
  };
  state.appLink = nativeActivation(false);
  state.nativeFormEnter = nativeActivation(true);
  state.formPayment = !!form && Array.from(read(form, 'querySelectorAll')('input,button,iframe')).some(node => {
    const attrs = ['name', 'id', 'autocomplete', 'title', 'aria-label'].map(key => get(node, key)).join(' ');
    if (/\bcc-|card|cvv|cvc/i.test(attrs)) return true;
    if (read(node, 'localName') === 'iframe') { try { return new URL(get(node, 'src'), location.href).origin !== location.origin; } catch { return true; } }
    return (read(node, 'localName') === 'button' || ['submit', 'image'].includes(inputType(node))) && payment(words(node));
  });
  // A candidate for navigation, not yet one: a plain http(s) link whose only payment word is "checkout". The element keeps its payment
  // classification until the caller has the page's listener evidence on the element and calls releaseNavigation, so every other caller of
  // this reader fails closed. Not a candidate: a link in a payment form; a javascript:, #, mailto: or other-scheme href; no href; any
  // other payment word (buy, pay, purchase, place order, subscribe ...); a money figure in its words; a button or other role; a
  // non-anchor link; or a declarative handler attribute (on*, ping, Rails data-method, Turbo, Stimulus, htmx, Vue, Alpine, Angular).
  const href = get(el, 'href').replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  const names = Element.prototype.getAttributeNames ? Array.from(Element.prototype.getAttributeNames.call(el)) : null;
  const matched = words(el).match(/\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/gi) ?? [];
  state.navigation = state.payment && tag === 'a' && !button && state.kind === 'link' && !state.formPayment && href !== '' && !href.startsWith('#') &&
    (!/^[a-z][a-z0-9+.\-]*:/i.test(href) || /^https?:/i.test(href)) && ['', 'link'].includes(role.toLowerCase()) &&
    matched.length > 0 && matched.every(word => word.toLowerCase() === 'checkout') &&
    names !== null && !names.some(name => /^(?:ping$|on|data-(?:method|turbo|remote|action|confirm)|hx-|@|x-on|v-on|ng-|\(click\)|\[)/i.test(name)) &&
    !/[$\u20ac\u00a3\u00a5]\s*\d|\d\s*(?:usd|eur|gbp|dollars?|euros?)\b|\d[.,]\d{2}\b/i.test(words(el));
  if ((button || state.kind === 'link') && state.payment) state.submit = true;
  // Any script-driven button in a payment form (div[role=button], button type=button) can charge: its handler is invisible here.
  if (button && state.formPayment && !state.submit && get(el, 'type').toLowerCase() !== 'reset') { state.submit = true; state.scriptButton = true; }
  if (state.submit && state.formPayment) state.payment = true;
  // Digest of the same node in the same step, for the click shield to compare with what it sealed.
  if (typeof seal === 'function') state.seal = seal(el, read);
  return state;
}

// The caller read the listeners on the link and its descendants (closed-handle.mjs clickListeners): false means none for click,
// mousedown, pointerdown, pointerup, auxclick or keydown. Only then does a navigation candidate stop being a payment. true or
// undefined (the enumeration failed or was unavailable) leaves it a payment.
export function releaseNavigation(element, listeners) {
  if (element?.navigation === true && listeners === false) { element.payment = false; element.submit = false; return true; }
  return false;
}

// Every spelling of a key that activates (Enter, NumpadEnter, \r, \n, Space) maps to one name, so no alias can dodge the
// submit rules or the checked path. Other keys must be on an explicit non-activating list; anything else is 'unknown'.
// Returns { name: 'Enter' | 'Space' | undefined, kind: 'Enter' | 'Space' | 'safe' | 'unknown', chord }.
export function keyClass(key) {
  if (typeof key !== 'string' || !key) return { kind: 'unknown' };
  const tokens = []; let building = '';
  for (const char of key) { if (char === '+' && building) { tokens.push(building); building = ''; } else building += char; }
  tokens.push(building);
  const main = tokens.pop(), chord = tokens.length > 0, modifier = /^(?:Alt|Control|Ctrl|Meta|Cmd|Command|Option|Shift|ControlOrMeta)$/;
  if (tokens.some(token => !modifier.test(token))) return { kind: 'unknown', chord };
  if (['Enter', 'Return', 'NumpadEnter', '\r', '\n'].includes(main)) return { kind: 'Enter', name: 'Enter', chord };
  if (['Space', ' '].includes(main)) return { kind: 'Space', name: 'Space', chord };
  const safe = modifier.test(main) || /^(?:Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Left|Right|Up|Down)|F\d{1,2}|Key[A-Z]|Digit\d|Numpad(?!Enter)\w+)$/.test(main) ||
    /^\S$/u.test(main);
  return { kind: safe ? 'safe' : 'unknown', chord };
}

// The Playwright spelling of an activation key (Enter or Space, with its modifiers), or undefined for any other key.
export function activationKey(key) {
  const { name, chord } = keyClass(key);
  if (!name) return undefined;
  if (!chord) return name;
  const names = { ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', option: 'Alt', alt: 'Alt', shift: 'Shift', controlormeta: 'ControlOrMeta' };
  const modifiers = key.slice(0, key.lastIndexOf('+', key.length - 2)).split('+').map(token => names[token.toLowerCase()]);
  return [...modifiers, name].join('+');
}

// Chat apps send with Control+Enter and break a line with Shift+Enter: the only activation chords allowed, and only in a text field.
export function textChord(key, el) {
  const modifiers = activationKey(key)?.split('+').slice(0, -1) ?? [];
  return keyClass(key).name === 'Enter' && modifiers.length === 1 && ['Control', 'Shift'].includes(modifiers[0])
    && (['input', 'textarea'].includes(el?.tag) && el?.kind === 'text' || el?.role === 'textbox');
}

// Chrome takes text inserted into a single-line input as implicit submission when it is a lone line break.
export const lineBreakRefusal = 'A line break in a single-line input acts like pressing Enter. Press Enter on it instead, or use the engine browser path';

export function intent(kind, target = {}) {
  const key = keyClass(target.key).name ?? target.key?.split('+').at(-1), activation = kind === 'press' && ['Enter', 'Space'].includes(key);
  let submit = kind === 'submit', payment = false, plain = kind === 'submit';
  for (const el of [target.prior, target.element].filter(Boolean)) {
    const button = el.kind === 'button' || el.role === 'button', link = el.kind === 'link' || el.role === 'link' || el.tag === 'a';
    const sends = kind === 'click' || activation && (['Enter', 'Return'].includes(key) ? button || link || el.submit || el.form && (el.tag !== 'textarea' || keyClass(target.key).chord) : button);
    const submits = kind === 'submit' || sends && (el.submit || el.payment && (button || link) || el.form && activation);
    submit ||= !!submits;
    payment ||= !!submits && (el.payment === true || el.formPayment === true);
  }
  if (kind === 'dialog' && target.accept === true) { payment ||= target.element?.payment === true || paymentWords(target.message); submit = payment; }
  return { submit, payment };
}

// A script-driven control whose activation settled with no navigation, form change, dialog or popup may give back the request's
// one payment activation, but only when (a) its own accessible name is on a closed list of non-payment verbs and (b) no network
// activity of any kind followed the click until the next payment check (activity.mjs: every request started, WebSocket, worker
// and new page, not only finished fetches). The decision waits for that next check (settleRefund), so a request that starts
// later still keeps the budget spent. A real submit button keeps what it spent whatever the page showed.
// Closure-free: the engine-path payment gate (payment-gate.mjs) runs it in the engine's REPL.
export function refundableName(name) {
  const REFUND_VERBS = new Set('apply update remove delete increase decrease plus minus show hide edit change more less'.split(' '));
  const CHARGE_WORDS = new Set('pay paying payment purchase buy checkout donate donation subscribe place complete confirm submit send charge book continue next finish upgrade now tip add'.split(' '));
  const n = String(name ?? '').normalize('NFKC').trim().toLowerCase();
  if (!n || n.length > 40) return false;
  if (/^[+\u2212\-\u2013\u2795\u2796]$/.test(n)) return true;
  const words = n.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.length <= 4 && REFUND_VERBS.has(words[0]) && !words.some(word => CHARGE_WORDS.has(word));
}
export function deferRefund(ctx, target, activity) {
  const spent = target?.paymentSpent, bank = payments.get(ctx);
  if (!spent || !bank || target.element?.scriptButton !== true) return false;
  target.paymentSpent = undefined;
  if (!spent.fresh || !activity?.observable || !refundableName(target.element.accName)) return false;
  bank.deferred?.activity.stop();
  bank.deferred = { requestKey: spent.requestKey, activity };
  return true;
}
function settleRefund(bank) {
  const deferred = bank.deferred;
  if (!deferred) return;
  bank.deferred = undefined;
  const quiet = deferred.activity.quiet(); deferred.activity.stop();
  if (quiet) { bank.used.delete(deferred.requestKey); bank.dialog = undefined; }
}

// The turn is over: no further payment check will settle the refund, so its listeners come off the browser context now.
export function endDeferredRefund(ctx) {
  const bank = payments.get(ctx), deferred = bank?.deferred;
  if (!deferred) return;
  bank.deferred = undefined; deferred.activity.stop();
}

export function expirePaymentDialog(ctx) { const bank = payments.get(ctx); if (bank) bank.dialog = undefined; }

export function check(ctx, kind, target = {}) {
  try {
    if (kind !== 'dialog') expirePaymentDialog(ctx);
    if (!ordinary.has(kind) && kind !== 'submit') return refuse('Background-only operation required.');
    if (kind === 'Target.createTarget') return target.background === true ? allow : refuse('New tabs must use background:true.');
    const el = target.element;
    if (kind === 'press' && keyClass(target.key).chord && keyClass(target.key).name && !textChord(target.key, el)) return refuse('This activation chord may open a foreground window. Only Shift+Enter and Control+Enter in a text field are allowed.');
    if (!['read', 'dialog', 'open', 'wait', 'back', 'forward', 'reload', 'viewport', 'close', 'keep', 'handoff'].includes(kind)) {
      if (!el || !text(el.tag)) return refuse('Read the target before input.');
      if (['iframe', 'frame', 'object', 'embed'].includes(el.tag)) return refuse('Use a ref for the child-frame control.');
      if (['connected', 'enabled', 'hit'].some(key => el[key] === false) || el.visible === false && !nativeKeyboardInput(kind, target)) return refuse('The checked target changed; read it again.');
    }
    if (['click', 'press', 'submit'].includes(kind) && ['payment', 'submit', 'form', 'formPayment'].some(key => typeof el?.[key] !== 'boolean'))
      return refuse('Read final submit and payment classification before activation.');
    const pickerOpening = kind === 'click' || kind === 'press' &&
      (!!keyClass(target.key).name || el?.kind === 'select' && ['Alt+ArrowDown', 'F4'].includes(target.key));
    if (kind === 'click' && el?.appLink || kind === 'press' && keyClass(target.key).name === 'Enter' && (el?.appLink || el?.nativeFormEnter))
      return refuse('This link opens a native app. Tell the user; no browser input was sent.');
    if (pickerOpening && ['file', 'color', 'select'].includes(el?.kind)) return refuse('Use browser_fill or upload instead of opening a native picker.');
    const risk = intent(kind, target);
    if (risk.submit && (!target.state || !Number.isSafeInteger(target.state.snapshotNo))) return refuse('Submit needs its document state.');
    const retry = () => refuse('Submit unconfirmed. Deliver a fresh browser_read before retrying.');
    if (risk.submit && kind !== 'dialog' && target.state.submitUnconfirmed) return retry();
    const message = typeof ctx?.userMessage === 'function' ? ctx.userMessage() : ctx?.userMessage;
    const user = message?.source === 'user' && text(message.id) && text(message.text) && message.session === target.session && message.turn === target.turn ? message : undefined;
    if (kind === 'upload') return user && Array.isArray(target.paths) && target.paths.length && target.paths.length <= 16 &&
      target.paths.every(text) && new Set(target.paths).size === target.paths.length &&
      ctx.files?.check(target.paths, target, user) === true ? allow : refuse('Upload requires exact user-named files and the private files provider.');
    if (['reload', 'back', 'forward'].includes(kind) && (target.state?.submitUnconfirmed || paymentPages.has(target.state))) {
      const commands = { reload: /^(?:Please )?Reload (?:this|the) page[.!]?$/i,
        back: /^(?:Please )?Go back[.!]?$/i, forward: /^(?:Please )?Go forward[.!]?$/i };
      const used = historyRequests.get(ctx) ?? new Set(), requestKey = user && JSON.stringify([user.session,user.turn,user.id,kind]);
      if (!user || !commands[kind].test(user.text.trim()) || used.has(requestKey))
        return refuse('Payment or submit effect is unknown. History navigation needs an explicit user request.');
      used.add(requestKey); historyRequests.set(ctx,used);
    }
    if (!risk.payment) return allow;
    const termsOf = page => ({ item: page?.item, amount: page?.amount, payee: page?.payee, method: target.terms?.method,
      ...(page?.currency !== undefined ? { currency: page.currency } : {}) });
    const complete = t => ['item', 'amount', 'payee', 'method'].every(key => text(t[key]));
    // The user's own message names this payment: item and method, and every other term it names matches.
    const named = t => user?.payment && ['item', 'method'].every(key => text(user.payment[key])) &&
      ['item', 'method', 'amount', 'payee', 'currency'].every(key => user.payment[key] === undefined || user.payment[key] === t[key]);
    const setting = ctx.confirmPayments ?? process.env.SLEIGHT_CONFIRM_PAYMENTS;
    let terms = termsOf(target.terms?.page);
    // 'never' (the user's opt-out): the figure check blanks the amount when a checkout shows a larger figure. For a payment the user's message
    // named with an amount, the amount as the page states it (target.terms.unchecked) stands in, so that one ask goes. Any other payment keeps the blank.
    if (setting === 'never' && !complete(terms) && target.terms?.unchecked && text(user?.payment?.amount)) {
      const open = termsOf(target.terms.unchecked); if (complete(open) && named(open)) terms = open;
    }
    const ask = () => ({ verdict: 'confirm', terms });
    if (!complete(terms) || !sameDocument(target, target)) return ask();
    let bank = payments.get(ctx); if (!bank) { bank = { used: new Set() }; payments.set(ctx, bank); }
    settleRefund(bank);
    if (kind === 'dialog' && bank.dialog &&
        (!ctx.dialogContinuation || ctx.dialogContinuation(target) === true) && sameDocument(bank.dialog, target) && sameTerms(bank.dialog.terms, terms)) {
      bank.dialog = undefined; return allow;
    }
    if (kind === 'dialog' && target.state.submitUnconfirmed && !sameDocument(bank.dialog, target)) return retry();
    const requestKey = user && JSON.stringify([user.session, user.turn, user.id]);
    const requested = named(terms), strict = setting === 'always';
    // One payment activation per user request, whichever kind of control it is: a script-driven button may be Apply or a
    // disguised charge, so it spends the same budget as the real submit. Past the budget, the user is asked through consume.
    if (!(requested && !strict && !bank.used.has(requestKey)) && ctx.consent?.consume(terms, target) !== true) return ask();
    // Remember what this activation spent so a quiet click on a closed-list control can give it back at the next payment check (deferRefund).
    target.paymentSpent = requestKey ? { requestKey, fresh: !bank.used.has(requestKey) } : undefined;
    if (requestKey) bank.used.add(requestKey);
    if (target.state) paymentPages.add(target.state);
    bank.dialog = kind === 'dialog' ? undefined : { session: target.session, turn: target.turn, document: target.document, origin: target.origin, terms: { ...terms } };
    return allow;
  } catch { return refuse('Trusted rule evidence is unavailable.', true); }
}

// One state per document, retained across turns. Capture when the snapshot read
// starts; deliver only after its text reaches the client. A private/failed read
// never calls deliverSnapshot. Do not reuse this state for another document.
export function beginSubmit(state, at = Date.now()) {
  const submit = { startedAt: at, snapshotNo: state.snapshotNo ?? 0 };
  state.submitUnconfirmed = submit; return submit;
}
export function finishSubmit(state, submit, effect = {}, at = Date.now()) {
  if (state.submitUnconfirmed !== submit) return;
  if (['navigated', 'formChanged', 'requestFinished'].some(key => effect[key] === true)) state.submitUnconfirmed = false;
  else submit.settledAt = at;
}
export function captureSnapshot(state, at = Date.now()) {
  const number = Math.max(state.snapshotNo ?? 0, captures.get(state) ?? 0) + 1;
  captures.set(state, number); return { state, number, capturedAt: at };
}
export function deliverSnapshot(state, snapshot) {
  if (snapshot.state !== state || !Number.isSafeInteger(snapshot.number) || snapshot.number < 1 ||
      !Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < 0) return false;
  state.snapshotNo = Math.max(state.snapshotNo ?? 0, snapshot.number);
  const submit = state.submitUnconfirmed;
  if (!submit || !Number.isFinite(submit.settledAt) || snapshot.number <= submit.snapshotNo ||
      snapshot.capturedAt < submit.settledAt || snapshot.capturedAt < submit.startedAt + 1000) return false;
  state.submitUnconfirmed = false; return true;
}
