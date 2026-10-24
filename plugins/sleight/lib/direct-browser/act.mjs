// Independent implementation informed by FowlBrowser (MIT), pinned 8b68924:
// request-before-input watching and short Playwright actionability timeouts.
// No upstream source copied. All browser input stays on the owned Playwright page.
import { stageUserUploads } from './files.mjs';
import { isV3Context } from './v3-context.mjs';
import { intent, deferRefund, refundableName, lineBreakRefusal } from './rules.mjs';
import { observeActivity } from './activity.mjs';
import { trustedLocatorRead } from './trusted-dom.mjs';
import { endpointURL, endpointBlock } from './endpoint-guard.mjs';
import { setViewport } from './viewport.mjs';
import { snapshotAcquisitionPending } from './snapshot.mjs';
import { originOf, pathOf, guardChooser } from './output-hygiene.mjs';
import { downloadLink } from './download-link.mjs';
const OPS = new Set('click type press select check uncheck hover scroll drag upload download dialog wait back forward reload viewport navigate'.split(' '));
const REF_OPS = new Set('click type select check uncheck hover drag upload download'.split(' '));
const WAIT_CAP = 5000, SCROLL_CAP = 10000, navigateNeeds = 'the ref of an http(s) link (browser_open takes a url); to press other elements use click';
const TIMEOUT = 1000;
const clickModifiers = Object.freeze({ cmd: 'Meta', ctrl: 'Control' });
const pendingInputs = new WeakMap();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const closedSubmitWarning = 'its submit is unconfirmed; check the opener or the account before paying again';
export const shortStepOutcomes = Object.freeze({ quiet: 'page quiet after <ms> ms', pending: 'page activity still pending after <ms> ms (cap); page below' });
const dialogOutcome = dialog => `dialog ${clean(dialog.type())} is waiting; message (untrusted page content): "${clean(dialog.message())}"`;
const lineBreak = /[\r\n]/;
const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
const refOf = value => typeof value === 'string' && /^(?:(?:f\d+)?e\d+|[sx]\d+)$/.test(value) ? value : null;
async function bounded(task, ms) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('action still pending after its deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// A key that activates the focused element, by what the page sees: every spelling of Enter (the numpad one and
// the \r and \n characters included) is Enter, and Space is Space. A chord such as Shift+Enter ends in its key.
const ENTER_KEYS = new Set(['enter', 'numpadenter', 'return', '\r', '\n']), SPACE_KEYS = new Set(['space', ' ', 'spacebar']);
export function activationKey(key) {
  const last = String(key).split('+').pop().toLowerCase();
  return ENTER_KEYS.has(last) ? 'enter' : SPACE_KEYS.has(last) ? 'space' : null;
}

function validate(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 12) throw Error('steps needs 1 to 12 operations');
  for (const s of steps) {
    if (!s || !OPS.has(s.do)) throw Error('unsupported do operation');
    if (/^x\d+$/.test(s.to) || /^x\d+$/.test(s.ref) && !['type', 'press'].includes(s.do))
      throw Error('keyboard-only refs support only type and press');
    if (s.modifier !== undefined && (s.do !== 'click' || typeof s.modifier !== 'string' || !Object.hasOwn(clickModifiers, s.modifier)))
      throw Error('click modifier must be cmd or ctrl');
    const needs = name => { throw Error(s.do + ' needs ' + name); };
    if (REF_OPS.has(s.do) && !refOf(s.ref)) needs('ref');
    if (s.do === 'navigate' && !refOf(s.ref)) needs(navigateNeeds);
    if (s.ref !== undefined && !refOf(s.ref)) needs('a valid ref');
    if (s.do === 'type' && typeof s.text !== 'string') needs('text');
    if (s.do === 'press' && (typeof s.key !== 'string' || !s.key || s.key.length > 100)) needs('key');
    if (s.do === 'select' && (!Array.isArray(s.values) || !s.values.length || s.values.some(v => typeof v !== 'string'))) needs('values');
    if (s.do === 'drag' && !refOf(s.to)) needs('to');
    if (s.do === 'upload' && (!Array.isArray(s.paths) || !s.paths.length || s.paths.some(p => typeof p !== 'string' || !p))) needs('paths');
    if (s.do === 'dialog' && typeof s.accept !== 'boolean') needs('accept');
    if (s.do === 'viewport' && ([s.width, s.height].filter(n => n === undefined).length === 1 ||
      [s.width, s.height].some(n => n !== undefined && !(Number.isInteger(n) && n >= 100 && n <= 10000)))) needs('width and height between 100 and 10000, or neither to restore');
    if (s.do === 'wait' && s.ms !== undefined && !(Number.isFinite(s.ms) && s.ms >= 0)) needs('ms of 0 or more');
    if (s.do === 'scroll') {
      if (s.until !== undefined && (typeof s.until !== 'string' || !s.until.trim() || s.until.length > 500)) needs('until text');
      if ([s.dx, s.dy].some(n => n !== undefined && !Number.isFinite(n))) needs('finite dx and dy (beyond 10000 is clamped to it); give until the row text to find a row in a long list');
    }
  }
}

// Only risk classification and a comparison fingerprint cross this boundary.
// Form values never enter an outcome line or a snapshot through this reader.
export function inspectTarget(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const words = node => [read(node, 'getAttribute')('aria-label'), read(node, 'textContent'), read(node, 'getAttribute')('value')].filter(Boolean).join(' ');
  const payment = text => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(text);
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
  const form = formOf(), tag = read(el, 'localName'), role = read(el, 'getAttribute')('role'), name = words(el).trim().slice(0, 100);
  const accName = (read(el, 'getAttribute')('aria-labelledby') ? '' : (read(el, 'getAttribute')('aria-label') || read(el, 'textContent') || read(el, 'getAttribute')('value') || read(el, 'getAttribute')('alt') || read(el, 'getAttribute')('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 100);
  const button = tag === 'button' || tag === 'input' && /^(?:button|submit|image)$/.test(read(el, 'type')) || role === 'button';
  // A label click forwards to its control, so a label for a file or color input opens the native picker like the input does.
  const forwarded = (() => { try { const label = typeof HTMLLabelElement === 'undefined' ? null : Element.prototype.closest.call(el, 'label'), control = label && Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, 'control').get.call(label);
    return control instanceof HTMLInputElement ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get.call(control).toLowerCase() : ''; } catch { return ''; } })();
  const formPayment = !!form && [...read(form, 'querySelectorAll')('input,button,iframe')].some(node =>
    /^cc-/i.test(read(node, 'getAttribute')('autocomplete') ?? '') || /(?:card|cc[-_ ]?(?:number|csc)|cvv|cvc)/i.test(read(node, 'id') + ' ' + read(node, 'getAttribute')('name')) ||
    read(node, 'localName') === 'iframe' || (read(node, 'localName') === 'button' || read(node, 'type') === 'submit') && payment(words(node)));
  // navigate follows only a plain http(s) link; any other scheme, or an element with no href, is a click's job.
  const link = (() => { try { if (tag !== 'a' && tag !== 'area') return false; const href = read(el, 'getAttribute')('href'); if (href == null) return false;
    const url = new URL(href, read(read(el, 'ownerDocument'), 'baseURI')); return /^https?:$/.test(url.protocol) && !url.username && !url.password; } catch { return false; } })();
  const submit = !!(button && (read(el, 'type') === 'submit' && form || /\b(?:save|submit|send|confirm|book|pay|place order|finish|complete)\b/i.test(name) || payment(name)));
  const scriptButton = !submit && !!(button && form && formPayment && read(el, 'type') !== 'reset');
  let hash = 2166136261;
  if (form) {
    const content = read(form, 'textContent') + [...read(form, 'querySelectorAll')('input,select,textarea')].map(n => [read(n, 'value'), read(n, 'checked'), read(n, 'selectedIndex')].join(':')).join('|');
    for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  }
  return { name, accName, tag, role, kind: ['file', 'color'].includes(forwarded) ? forwarded : button ? 'button' : ['file', 'color'].includes(read(el, 'type')) ? read(el, 'type') : tag === 'select' ? 'select' : 'text', button, form: !!form, link, submit: submit || scriptButton, scriptButton, payment: payment(name) || submit && formPayment,
    // An anchor whose only payment word is "checkout": the trusted context may drop this as the prior of a released navigation link (v3-context).
    checkoutLink: tag === 'a' && payment(name) && (name.match(/\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/gi) ?? []).every(word => word.toLowerCase() === 'checkout'),
    formPayment, formSignature: form ? hash : null };
}

// Visible dialogs, alerts and status panels, as a count and a text fingerprint. A submit that opens one of
// these has had a visible effect even though the form itself did not change and no request has started.
export function overlaySignature(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  try {
    const doc = read(el, 'ownerDocument'), style = read(read(doc, 'defaultView'), 'getComputedStyle');
    if (!doc || typeof style !== 'function') return null;
    let count = 0, hash = 2166136261;
    for (const node of read(doc, 'querySelectorAll')('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="alert"],[role="status"]')) {
      const rect = read(node, 'getBoundingClientRect')(), look = style(node), text = String(read(node, 'textContent') ?? '').trim();
      if (!text || !rect.width || !rect.height || look.visibility === 'hidden' || look.display === 'none') continue;
      count++;
      for (let i = 0; i < text.length && i < 2000; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return { count, hash };
  } catch { return null; }
}

function scrollPoint(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.max(1, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(1, Math.min(innerHeight - 1, r.y + r.height / 2)) };
}

// Runs in the trusted utility world (closure-free, like inspectTarget). Puts the element clear of fixed and sticky bars, then says
// what sits on its centre: 'clear', 'label' (its own label, whose click activates it), 'fixed' (a fixed or sticky cover that no
// alignment moved), 'other', or 'off' (still out of view). Blocks are tried centre, end, start; a bar covers one edge, not the middle.
export function placeClear(el, unused, read) {
  const doc = read(el, 'ownerDocument'), label = read(el, 'closest')('label');
  const box = () => read(el, 'getBoundingClientRect')();
  const inView = () => { const r = box(); return r.width + r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; };
  const fixedOver = hit => { for (let n = hit; n; n = read(n, 'parentElement')) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  const own = hit => { if (!label || read(label, 'control') !== el || !read(label, 'contains')(hit)) return false;
    const inner = read(hit, 'closest')('a,button,select,textarea,input,summary,[role=button],[role=link]'); return !inner || inner === el || !read(label, 'contains')(inner); };
  const state = () => { if (!inView()) return 'off'; const r = box(), hit = read(doc, 'elementFromPoint')(r.x + r.width / 2, r.y + r.height / 2);
    return !hit || hit === el || read(el, 'contains')(hit) ? 'clear' : own(hit) ? 'label' : fixedOver(hit) ? 'fixed' : 'other'; };
  let seen = state();
  for (const block of ['center', 'end', 'start']) {
    if (seen !== 'off' && seen !== 'fixed') break;
    read(el, 'scrollIntoView')({ block, inline: 'nearest', behavior: 'instant' }); seen = state();
  }
  return seen;
}
// check and uncheck on a control whose own label sits over it (a visually hidden radio or checkbox) click the control's own centre
// without Playwright's hit-target wait: placeClear just proved that point is the label itself, never a link or button nested in it,
// so the click is the one a person makes there. The label's own centre is not used: it may hold a nested link ("I agree to the terms").
// Anything else keeps the plain path. Never throws: a read that fails leaves the plain path.
async function aimedAt(locator) {
  try { return await trustedLocatorRead(locator, placeClear) === 'label' ? { force: true } : {}; }
  catch { return {}; }
}

function coverDetails(el) {
  const r = el.getBoundingClientRect(); let hit = el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  while (hit?.shadowRoot?.elementFromPoint) { const next = hit.shadowRoot.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); if (!next || next === hit) break; hit = next; }
  if (!hit || hit === el || el.contains(hit)) return null;
  const mine = el.closest('label');
  if (mine && mine.control === el && mine.contains(hit)) return { own: true };
  const root = hit.closest('[role="dialog"],dialog,[aria-modal="true"]') ?? hit;
  return { name: (root.getAttribute('aria-label') || root.innerText || root.localName).slice(0, 100),
    buttons: [...root.querySelectorAll('button,[role="button"],input[type="button"]')].slice(0, 6)
      .map(n => (n.getAttribute('aria-label') || n.innerText || n.value || '').slice(0, 80)) };
}

function watch(page, state, now) {
  const pending = new Set(), active = new Set(), completed = new Set(), listeners = []; let boundary, dialogResolve, stopped = false;
  let lastActivity = now();
  const dialogReady = new Promise(resolve => { dialogResolve = resolve; });
  // Settles when any boundary registers (navigation, new document, dialog, popup, close), so a caller can wait for one event, not a fixed time.
  let boundaryResolve; const boundaryReady = new Promise(resolve => { boundaryResolve = resolve; });
  const mark = value => { lastActivity = now(); boundary = value; boundaryResolve(); };
  const stop = () => { stopped = true; for (const [event, fn] of listeners) page.off(event, fn); };
  const on = (event, fn) => {
    const listener = (...args) => { if (!stopped) fn(...args); };
    page.on(event, listener); listeners.push([event, listener]);
  };
  on('request', r => {
    if (!['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image'].includes(r.resourceType())) return;
    lastActivity = now(); active.add(r);
    if (['document', 'xhr', 'fetch', 'script', 'stylesheet'].includes(r.resourceType())) pending.add(r);
  });
  on('requestfinished', r => { if (active.delete(r)) lastActivity = now(); if (pending.delete(r)) completed.add(r); });
  on('requestfailed', r => { if (active.delete(r)) lastActivity = now(); pending.delete(r); });
  on('framenavigated', frame => { if (frame === page.mainFrame()) mark({ kind: 'navigation' }); });
  on('load', () => { if (!boundary) mark({ kind: 'document' }); });
  on('dialog', dialog => { state.dialog = dialog; mark({ kind: 'dialog', dialog }); dialogResolve(boundary); });
  on('popup', popup => { mark({ kind: 'popup', popup }); });
  on('close', () => { mark({ kind: 'close' }); state.dialog = null; stop(); });
  return { pending, active, completed, dialogReady, boundaryReady, get boundary() { return boundary; }, get lastActivity() { return lastActivity; },
    stop };
}

function pendingGate(state, step) {
  if (state.actionPending && step.do !== 'dialog') throw Error('an earlier input is still pending; wait for it before more input');
  if (step.do === 'dialog' && [...pendingInputs.get(state)?.tokens ?? []].some(token => token.dialog === state.dialog))
    throw Error('the dialog answer is still pending; wait for it before another answer');
}

function ownInput(state, dialog) {
  let bank = pendingInputs.get(state);
  if (!bank) { bank = { tokens: new Set(), external: !!state.actionPending }; pendingInputs.set(state, bank); }
  const token = { dialog }; bank.tokens.add(token); state.actionPending = true;
  return () => {
    bank.tokens.delete(token);
    state.actionPending = bank.external || bank.tokens.size > 0;
    if (!bank.tokens.size) pendingInputs.delete(state);
  };
}

function ruleMessage(result) {
  if (result === 'allow' || result?.verdict === 'allow' || result?.kind === 'allow') return null;
  if (result?.verdict === 'confirm' || result?.kind === 'confirm') return 'confirmation required through the trusted consent UI' + (process.env.SLEIGHT_MT === '0' ? '; use the engine browser path if needed' : '');
  return clean(result?.message ?? result?.msg ?? 'rule check refused; read the page' + (process.env.SLEIGHT_MT === '0' ? ' or use the engine browser path' : ''));
}

// Dependencies are the other v3 lanes' fixed interfaces. Injecting them keeps unit
// and host-runner tests independent while those modules are built in parallel.
// hand (hand/browser-hand.mjs) hears of each step whose input starts, after its rules allowed it. Its step() only
// queues work and returns nothing, and a hand that throws changes nothing here.
export function createActionRunner({ check, snapshot, backgroundClick = (tab, locator, click) => click({}), actionTimeoutMs = 7000, now = Date.now, sleep = pause, hand } = {}) {
  if (typeof check !== 'function' || typeof snapshot !== 'function') throw Error('action runner needs check and snapshot');
  const lossFixes = process.env.SLEIGHT_LB12 !== '0';
  // siteCheck() gives the user's line when the page now shows a site sleight may not act on (permissions.mjs). It runs in the
  // gate, right before each step's input, so a step that moved the page to such a site stops every step after it.
  return async function runSteps(tab, steps, ctx = {}, { nextStep, siteCheck, observe, download, downloadAllowed } = {}) {
    // A bad step list is refused before any input, so the caller must not report it as an unconfirmed outcome.
    try { validate(steps); } catch (error) { error.notRun = true; throw error; }
    const { page, state } = tab, since = state.snapshotNo > 0 ? state.snapshotNo : undefined, lines = []; let stoppedAt = null;
    let observed, observeError, confirmation, blocker, carry, closed = false, observeWaitMs = 600;
    const read = async options => { const capturedAt = now(), result = await snapshot(page, options); observed = { ...result, capturedAt }; return observed; };
    // Keep requests across step watchers: a wait after a click must see work that click left in flight.
    const batchWatch = watch(page, state, now);
    try {
    for (let index = 0; index < steps.length; index++) {
      // navigate on a link is that link's click, so every click rule, guard and popup rule applies unchanged.
      const named = steps[index], step = named.do === 'navigate' ? { ...named, do: 'click' } : named, label = `${index + 1} ${named.do}${step.ref ? ' ' + step.ref : ''}`;
      let locator, target, started = false, armed, activity, deferred = false, staging, submit, inputPending = false, stepFinished = false, settleCapped = false, settleNote, clickRetry = '', recoverClick = false;
      try {
        if (state.dialog && step.do !== 'dialog') throw Error('a page dialog is waiting; answer it with the dialog operation');
        if (step.do === 'dialog' && !state.dialog) throw Error('no waiting dialog; read the page');
        pendingGate(state, step);
        if (snapshotAcquisitionPending(page)) throw Error('Snapshot acquisition is still pending; wait before another action or read.');
        if (step.do === 'download') {
          const file = await downloadLink(tab, step, ctx, { download, siteCheck, allowed: downloadAllowed });
          lines.push(label + ': saved ' + JSON.stringify(file)); stoppedAt = index + 1; break;
        }
        if (/^x\d+$/.test(step.ref) && !isV3Context(ctx)) throw Error('keyboard-only refs require a trusted context');
        locator = step.ref ? page.getByRef(step.ref) : step.do === 'press' ? page.locator(':focus') : null;
        if (step.do === 'press' && !step.ref && !await locator.count()) locator = page.locator('body');
        let info = locator ? await trustedLocatorRead(locator, inspectTarget) : {};
        if (named !== step && info.link !== true) throw Error('navigate needs ' + navigateNeeds);
        // Chrome treats text inserted into a single-line input as implicit submission when it is a lone line break, so a line
        // break typed there is an Enter press that skipped the submit checks. Pressing Enter is the one way to send it.
        if (step.do === 'type' && info.tag === 'input' && lineBreak.test(step.text)) throw Error(lineBreakRefusal);
        const activation = step.do === 'press' ? activationKey(step.key) : null, enter = !!activation;
        let submits = step.do === 'click' && info.submit || enter && (info.submit || info.form && activation === 'enter');
        target = { ...info, element: info, page, locator, state, ref: step.ref, do: step.do, key: step.key,
          paths: step.paths, submit: !!submits, payment: !!submits && (info.payment || info.formPayment),
          ...(step.do === 'dialog' ? { type: state.dialog.type(), message: state.dialog.message(), accept: step.accept } : {}) };
        const trusted = isV3Context(ctx);
        const gate = async () => {
          const refused = siteCheck?.();
          if (refused) throw Error(refused);
          const verdict = trusted ? await ctx.check(step.do, target) : await check(ctx, step.do, target);
          // The trusted check refreshes the target, including when seal verification vetoes the click.
          // Recovery reads this decision after the callback, never the earlier inspectTarget result.
          const risk = intent(step.do, target);
          recoverClick = !risk.submit && !risk.payment && !target.element?.payment && !target.prior?.payment;
          if (verdict?.verdict === 'confirm' || verdict?.kind === 'confirm') confirmation = { step: index + 1, terms: verdict.terms };
          const message = ruleMessage(verdict);
          if (message) throw Error(message);
          if (trusted && target.locator) locator = target.locator;
          if (trusted) submits = intent(step.do, target).submit && step.do !== 'dialog';
          if (submits) {
            submit = { startedAt: now(), snapshotNo: state.snapshotNo ?? 0 };
            state.submitUnconfirmed = submit;
          }
        };
        // Pin the element before popup preparation. Check final risk and consume
        // authority inside the actual click callback, after that preparation.
        if (trusted && locator) { await ctx.prepareTarget(target); locator = target.locator; }
        if (!trusted) await gate();
        if (step.do === 'upload') {
          if (trusted) await gate();
          staging = trusted ? await ctx.stageUploads(target, step.paths) : await stageUserUploads(ctx.files, step.paths, step.ref);
          if (!Array.isArray(staging?.payloads) || !staging.payloads.length) throw Error('user-named file staging required');
        }
        guardChooser(page, state); const popupFrom = tab.popups?.length ?? 0;
        // Visible dialogs and panels before the input, to tell a submit that answered with one from a silent one.
        const overlayRead = async () => { try { return await trustedLocatorRead(locator, overlaySignature); } catch { return null; } };
        const overlayBase = locator && (step.do === 'click' || enter) ? await overlayRead() : null;
        armed = watch(page, state, now); const start = now();
        // A script-driven control on the closed name list may be refunded later, if the whole network stays quiet (activity.mjs).
        if (step.do === 'click' && info.scriptButton === true && refundableName(info.accName)) activity = observeActivity(page);
        const options = { timeout: TIMEOUT };
        // The input starts now: the ghost hand may show it. Never awaited.
        const begin = () => {
          started = true;
          if (hand) try { hand.step({ op: named.do, page, locator, ref: step.ref, text: step.text, to: step.do === 'drag' ? page.getByRef(step.to) : undefined }); } catch {}
        };
        const perform = async () => {
          if (step.do === 'click') return backgroundClick(tab, locator, async (extra, verifySeal) => {
            // A control under its own label (a visually hidden radio) is clicked at the point placeClear proved is that label, as
            // check does: in the 2026-10-16 gate rounds a click on one came back "covered" 5 to 6 times per form-checkout run.
            const aim = await aimedAt(locator);
            // The rules read the element inside gate(); the page confirms those words are the ones it sealed.
            if (trusted) { target.verifySeal = verifySeal; await gate(); ctx.beginInput(target); }
            // Chromium on macOS turns native Control+left into a context click.
            // Carry Control on Meta there; the sealed hook exposes ctrlKey to the page.
            const physical = step.modifier === 'ctrl' && process.platform === 'darwin' ? 'Meta' : clickModifiers[step.modifier];
            const modifiers = step.modifier === undefined ? {} : { modifiers: [...new Set([...(extra.modifiers ?? []), physical])] };
            begin(); return locator.click({ ...options, ...extra, ...aim, ...modifiers });
          }, { recover: () => recoverClick, onRetry: () => { clickRetry = '; waited for the page to settle and retried the click once'; },
            ...(step.modifier === undefined ? {} : { modifier: clickModifiers[step.modifier] }) });
          const pressKey = keys => trusted ? ctx.pressTarget(target, step.key, options, keys) : step.ref ? locator.press(step.key, options) : page.keyboard.press(step.key);
          // Enter and Space can follow a link or submit a form into a new tab: arm the popup hook, as a click does. In a trusted turn
          // the key also goes through the key shield (armed before the key, every other frame locked), so the gate's verdict and the
          // key it sends share one seal; `extra.between` lets the shield look at the page between the key going down and coming up.
          if (step.do === 'press' && enter) return backgroundClick(tab, locator, async extra => {
            if (trusted) { await gate(); ctx.beginInput(target); }
            begin();
            if (extra.modifiers) await page.keyboard.down('ControlOrMeta');
            return pressKey(extra);
          }, { press: activation, keys: trusted });
          if (trusted && step.do !== 'upload') { await gate(); ctx.beginInput(target); }
          begin();
          if (step.do === 'type') return trusted ? ctx.typeTarget(target, step.text, options) : locator.fill(step.text, options);
          if (step.do === 'press') return pressKey();
          if (step.do === 'select') return locator.selectOption(step.values, options);
          if (step.do === 'check') return locator.check({ ...options, ...await aimedAt(locator) });
          if (step.do === 'uncheck') return locator.uncheck({ ...options, ...await aimedAt(locator) });
          if (step.do === 'hover') return locator.hover(options);
          if (step.do === 'drag') return trusted ? ctx.dragTo(target, page.getByRef(step.to)) : locator.dragTo(page.getByRef(step.to), options);
          if (step.do === 'upload') return locator.setInputFiles(staging.payloads, options);
          if (step.do === 'viewport') return setViewport(page, step);
          if (step.do === 'back') return page.goBack({ ...options, waitUntil: 'commit' });
          if (step.do === 'forward') return page.goForward({ ...options, waitUntil: 'commit' });
          if (step.do === 'reload') return page.reload({ ...options, waitUntil: 'commit' });
          if (step.do === 'dialog') {
            const dialog = state.dialog;
            if (step.accept) await dialog.accept(step.text); else await dialog.dismiss();
            if (state.dialog === dialog) state.dialog = null; return;
          }
          if (step.do === 'wait') {
            if (locator) return typeof locator.waitFor === 'function' ? locator.waitFor({ ...options, state: 'visible' }) : locator.waitForElementState('visible', options);
            if (!lossFixes) {
              await sleep(Math.min(step.ms ?? 100, WAIT_CAP));
              return step.ms > WAIT_CAP ? `waited ${WAIT_CAP} ms (cap, not ${step.ms}); page below` : undefined;
            }
            return;
          }
          if (step.do === 'scroll') {
            const end = now() + 4000, clamp = n => Math.max(-SCROLL_CAP, Math.min(SCROLL_CAP, n)), dx = clamp(step.dx ?? 0), dy = clamp(step.dy ?? 500);
            const note = dx !== (step.dx ?? 0) || dy !== (step.dy ?? 500) ? ` (dx/dy clamped to ${SCROLL_CAP})` : '';
            if (locator) { await locator.scrollIntoViewIfNeeded(options); const point = await locator.evaluate(scrollPoint); await page.mouse.move(point.x, point.y); }
            for (let n = 0; n <= (step.until ? 60 : 1); n++) {
              if (step.until) {
                const result = await read({ ref: step.ref, find: step.until, maxChars: 2000 });
                const row = result.text.split('\n').find(line => line.toLocaleLowerCase().includes(step.until.toLocaleLowerCase()) && /\[ref=/.test(line));
                if (row) return 'found (untrusted page content): ' + clean(row) + note;
                if (n === 60 || now() >= end || armed.boundary) return 'text not found within 60 wheel steps or 4 s; read the list' + note;
              } else if (n === 1) return note && 'scrolled' + note + '; page below';
              await page.mouse.wheel(dx, dy); await sleep(16);
            }
          }
        };
        pendingGate(state, step);
        // A step settled early left its watcher running. Any boundary it saw since means the page moved
        // under the batch, so no further input goes out.
        if (carry) {
          const earlier = carry.boundary; carry.stop(); carry = null;
          if (earlier) throw Error('the page changed after the previous step; read it before more input');
        }
        // A Playwright click can remain pending until a page dialog is answered.
        // Returning the dialog stops the batch; the pending promise is observed,
        // never resent, and finishes after a later explicit dialog action.
        const releaseInput = ownInput(state, step.do === 'dialog' ? state.dialog : undefined);
        inputPending = true;
        const performed = perform().finally(() => {
          inputPending = false; releaseInput();
          if (stepFinished) armed.stop();
        });
        const result = await bounded(Promise.race([performed, armed.dialogReady]), actionTimeoutMs);
        let formChanged = false, overlayShown = false;
        // Repeated key presses and typing do not need their own observation: a step followed by another press
        // or type settles briefly and the last of the run settles fully. Enter, Return and Space can activate
        // a control, so they always settle in full, and so does any step that starts a submit.
        const quiet = (step.do === 'type' || step.do === 'press' && !enter) && !submits;
        const short = lossFixes && (['viewport', 'back', 'forward', 'wait'].includes(step.do) || step.do === 'scroll' && !step.until);
        if (short) {
          const until = start + actionTimeoutMs, waiting = step.do === 'wait' && !locator;
          const requestedEnd = start + Math.min(step.ms ?? 150, WAIT_CAP);
          const activityEnd = Math.min(until, (waiting ? requestedEnd : start) + 1500);
          // Give resize/scroll handlers a frame to start their work. A navigation can destroy that
          // evaluation; only an observed boundary makes that failure safe to ignore.
          if (!waiting && !armed.boundary) try {
            await Promise.race([page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve()))), sleep(50), armed.boundaryReady]);
          } catch (error) { if (!armed.boundary) throw error; }
          let landed;
          for (;;) {
            const boundary = armed.boundary;
            if (boundary && !['navigation', 'document'].includes(boundary.kind)) break;
            if (boundary?.kind === 'navigation' && landed !== boundary) {
              await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1000, until - now()) });
              landed = boundary;
            }
            // The previous call may have started a POST we cannot see here. Never shorten a wait
            // while that submit is unconfirmed, since a read can otherwise release its fence too soon.
            const quietEnd = state.submitUnconfirmed ? requestedEnd : Math.min(requestedEnd, Math.max(start, batchWatch.lastActivity) + 150);
            if (!batchWatch.active.size && (!waiting || now() >= quietEnd)) break;
            if (now() >= activityEnd) { settleCapped = true; break; }
            await sleep(Math.min(25, activityEnd - now(), !batchWatch.active.size && waiting ? Math.max(1, quietEnd - now()) : 25));
          }
          observeWaitMs = now() - start;
          if (settleCapped) settleNote = shortStepOutcomes.pending.replace('<ms>', observeWaitMs);
          else if (waiting) settleNote = shortStepOutcomes.quiet.replace('<ms>', observeWaitMs) + (step.ms > WAIT_CAP && observeWaitMs >= WAIT_CAP ? ' (cap)' : '');
        }
        // Electron fences one input per invocation; lookahead changes only settling, never sends that next input.
        const batched = quiet && !inputPending && !armed.boundary && ['type', 'press'].includes((steps[index + 1] ?? nextStep)?.do);
        if (!short) observeWaitMs = batched ? 40 : 600;
        // A submit's clock starts when the gate arms the fence (submit.startedAt), which in a trusted turn is after `start`: the
        // delivered read clears the fence only if taken a full second after that moment (rules.mjs deliverSnapshot), so both wait on it.
        const origin = submits && submit ? Math.max(start, submit.startedAt) : start;
        const settleUntil = batched ? now() + 40 : origin + (submits ? 5000 : 600);
        while (!short && !armed.boundary && now() < settleUntil) {
          if (submits && locator) {
            // A key can return before the navigation it started has committed, and the node is gone mid-read. Give the
            // navigation boundary a moment to register; destroyed evidence without one still stops the batch.
            try { formChanged = (await trustedLocatorRead(locator, inspectTarget)).formSignature !== info.formSignature; }
            catch (error) { await Promise.race([armed.boundaryReady, sleep(150)]); if (!armed.boundary) throw error; }
            if (!formChanged && overlayBase) {
              const latest = await overlayRead();
              overlayShown = !!latest && (latest.count !== overlayBase.count || latest.hash !== overlayBase.hash);
            }
          }
          if ((submits && (formChanged || armed.completed.size)) || (!submits && armed.completed.size && !armed.pending.size)) break;
          // A dialog or panel with no request in flight is the page's answer to the submit. Wait one second
          // from the click, which the delivered read needs to clear the unconfirmed submit, rather than five.
          if (submits && overlayShown && !armed.pending.size && now() >= origin + 1000) break;
          await Promise.race([armed.boundaryReady, sleep(Math.min(50, settleUntil - now()))]);
        }
        // Carry watchers only across steps this invocation will run. The Electron caller guards its next invocation.
        if (batched && steps[index + 1] && !armed.boundary) carry = armed;
        const boundary = armed.boundary;
        closed = lossFixes && boundary?.kind === 'close';
        if (boundary?.kind === 'dialog') state.dialog = boundary.dialog;
        if (submit && state.submitUnconfirmed === submit) {
          if (boundary?.kind === 'navigation' || boundary?.kind === 'document' || formChanged || armed.completed.size) state.submitUnconfirmed = false;
          else {
            submit.settledAt = now();
            // No navigation, document, dialog or popup, no form change, no request in flight: the refund waits for the next payment check.
            if (!boundary && !formChanged && !armed.pending.size && activity?.observable && await activity.verify()) deferred = trusted ? ctx.refund(target, activity) : deferRefund(ctx, target, activity);
          }
        }
        const popupTab = tab.popups?.slice(popupFrom).find(row => row.tab && !row.blocked)?.tab, navPath = boundary?.kind === 'navigation' ? pathOf(page.url()) : '';
        // A tab the page opened during a click without the background modifier is probably in the foreground.
        const clicked = ['click', 'press'].includes(step.do);
        const foregroundTabs = clicked ? (await tab.takeForeground?.() ?? 0) + (boundary?.kind === 'popup' && tab.background === false
          && tab.pageOpened?.(boundary.popup) === true ? 1 : 0)
          + (boundary?.kind === 'popup' && tab.background === true && tab.popupIsBackground?.(boundary.popup) === false ? 1 : 0) : 0;
        // The click carried the background modifier only if sleight sent it; a tab the page opened after the click's dispatch ended got no such help.
        const why = tab.background === false ? 'this click carried no background modifier' : 'the page opened it after a click, outside the background handling';
        const outcome = boundary?.kind === 'navigation' ? 'navigated, address (untrusted page content): ' + originOf(page.url()) + navPath + ' (new page below)'
          : boundary?.kind === 'document' ? 'new document (read below)'
          : boundary?.kind === 'dialog' ? dialogOutcome(boundary.dialog)
          : boundary?.kind === 'popup' ? endpointURL(boundary.popup.url(), tab.endpoint) ? endpointBlock : boundary.popup.isClosed() ? 'opened background tab that closed itself; opener below'
            : foregroundTabs > 0 ? `opened a tab that probably took the foreground (${why}, and sleight cannot tell which tab was active before); opener below: ` + originOf(boundary.popup.url())
            : `opened background tab${popupTab ? ' ' + popupTab : ''} at ${originOf(boundary.popup.url())} (opener ${tab.tab ?? 'this tab'})`
          : boundary?.kind === 'close' ? 'tab closed' + (submit && state.submitUnconfirmed === submit ? '; ' + closedSubmitWarning : '')
          : popupTab && foregroundTabs > 0 ? `opened a tab ${popupTab} that probably took the foreground (${why}, and sleight cannot tell which tab was active before); the opener's page is below`
          : popupTab ? `opened background tab ${popupTab} (opener ${tab.tab ?? 'this tab'}); the opener's page is below`
          : settleNote ?? (typeof result === 'string' ? result
          : submits && state.submitUnconfirmed && overlayShown && !armed.pending.size ? 'the page answered with a dialog or panel (below) and no request has started; answer it, or read before another submit'
          : submits && state.submitUnconfirmed ? 'submit unconfirmed after 5 s; read before resubmitting'
          : formChanged ? 'form changed' : armed.completed.size ? 'request finished; page below' : 'input sent; observation below');
        // A script that opens a tab after the input (a timer, a fetch) is held in the background, never silently.
        const heldOpenings = clicked ? await tab.takeHeld?.().catch(() => 0) : 0;
        // A page can raise a window it opened from another origin with focus(); no patch in the page, and no CDP call, stops or reports that.
        const raisable = clicked ? (await tab.raisablePopups?.().catch(() => []) ?? []) : [];
        lines.push(label + ': ' + outcome + clickRetry + (foregroundTabs > 0 && boundary?.kind !== 'popup' && !popupTab ? `. A tab the page opened probably took the foreground (${why})` : '')
          + (raisable.length ? process.env.SLEIGHT_MT !== '0'
            ? boundary?.kind === 'popup' && raisable.length === 1 && raisable[0] === popupTab && !foregroundTabs
              ? '; the page can bring it forward on its own'
              : `; the page can bring ${raisable.join(', ')} forward on its own`
            : `. ${raisable.length > 1 ? 'Tabs' : 'Tab'} ${raisable.join(', ')} (opened by this page, another origin) can be raised to the foreground by the page at any time, and sleight cannot block or detect that` : '') + (heldOpenings > 0 ? '. Page script tried to open ' + (heldOpenings > 1 ? heldOpenings + ' tabs' : 'a tab') + ' after this input; held, nothing opened' : ''));
        if (boundary || settleCapped) { stoppedAt = index + 1; break; }
      } catch (error) {
        if (lossFixes && started && armed?.boundary?.kind === 'close') {
          closed = true; lines.push(label + ': tab closed' + (submit && state.submitUnconfirmed === submit ? '; ' + closedSubmitWarning : '')); stoppedAt = index + 1; break;
        }
        if (started && submit && state.submitUnconfirmed === submit) submit.settledAt = now();
        let detail = step.do === 'upload' && started ? 'upload did not finish; inspect the control before retrying' : String(error.message);
        for (const value of [step.text, ...step.values ?? [], ...step.paths ?? []]) if (typeof value === 'string' && value) detail = detail.replaceAll(value, '[redacted]');
        detail = clean(detail);
        if (/intercepts pointer events/i.test(error.message)) detail = 'covered by another element; dismiss the cover first'; // Playwright's message quotes the page's own markup
        if (/intercepts pointer events/i.test(error.message) && locator) {
          try {
            const cover = await locator.evaluate(coverDetails, undefined, { timeout: 250 });
            if (cover?.own) detail = 'covered by its own label; use check or uncheck, or click the label';
            else if (cover) {
              // The cover's name and buttons are page text; they reach the model only in the labelled blocker read below.
              detail = 'covered by a covering element; dismiss the cover first (its controls are listed below)';
              blocker = await read({ find: cover.buttons[0] || cover.name, maxChars: 2000 });
            }
          } catch {}
        }
        // The shield cancelled the input before the page saw the click (backgroundClick says so); nothing was sent.
        // Playwright's hit-target check also blocks the page's pointer events when a cover appears mid-action, so a covered target got no input.
        const unsent = step.do === 'click' && /^page changed during the click; read again/.test(error.message) || /intercepts pointer events/i.test(error.message);
        lines.push(label + ': ' + (step.do === 'download' ? 'download failed; no completed path returned: '
          : started && !unsent ? 'effect unconfirmed; read before retrying. ' : 'not run: ') + detail + clickRetry);
        stoppedAt = index + 1; break;
      } finally {
        stepFinished = true;
        if (activity && !deferred) activity.stop();
        if (isV3Context(ctx) && target) ctx.finishInput(target);
        if (carry && carry !== armed) { carry.stop(); carry = null; }
        // A deadline ends the call, not the underlying Playwright input. Keep
        // its dialog listener until that exact promise settles or the page closes.
        if (!inputPending && armed !== carry) armed?.stop();
        try { await staging?.cleanup?.(); } catch { lines.push('Upload staging cleanup unavailable.'); }
        if (isV3Context(ctx) && target && !inputPending) await ctx.releaseTarget(target);
      }
    }
    if (stoppedAt !== null) for (let i = stoppedAt; i < steps.length; i++) lines.push(`${i + 1} ${steps[i].do}: not reached`);
    // Never turn a delivered input into a tool error because its observation
    // failed. The caller delivers this snapshot and records its number.
    const needsRead = !lossFixes || observe !== 'none' || stoppedAt !== null || lines.some(line => /\[ref=/.test(line));
    if (!closed && !state.dialog && state.actionPending) lines.push('Read deferred: input still pending; wait for it before browser_read.');
    else if (!closed && !state.dialog && needsRead) try {
      await Promise.race([read({ since, maxChars: 8000 }), batchWatch.dialogReady]);
    } catch (error) { if (!state.dialog) observeError = clean(error.message); }
    if (state.dialog) {
      observed = undefined;
      const note = dialogOutcome(state.dialog);
      if (!lines.some(line => line.includes(note))) lines.push(note);
    }
    if (blocker && observed && observed !== blocker && !observed.text.includes(blocker.text)) observed.text += '\nBlocker controls (untrusted page content):\n' + blocker.text;
    if (observed) {
      const changed = observed.text.split('\n').filter(line => /^[+~-]\s/.test(line)).length;
      const detail = changed ? changed + ' lines changed (batch observation below)'
        : /no (?:visible )?changes?/i.test(observed.text) ? `no visible change within ${observeWaitMs} ms` : 'input sent; page below';
      for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace('input sent; observation below', detail);
    }
    if (observeError) lines.push('Read unavailable: ' + observeError + '; use browser_read before retrying.');
    if (!needsRead) for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace('input sent; observation below', 'input sent');
    return { lines, stoppedAt, observe: observed, ...(closed ? { closed: true } : {}), ...(confirmation ? { confirmation } : {}) };
    } finally { batchWatch.stop(); }
  };
}

let defaultRunner;
export async function runSteps(tab, steps, ctx, options) {
  if (!isV3Context(ctx)) throw Error('TRUSTED_TURN_REQUIRED');
  if (!defaultRunner) {
    const [{ check }, { snapshot }, { backgroundClick }, { sharedBrowserHand }] = await Promise.all([import('./rules.mjs'), import('./snapshot.mjs'), import('./page.mjs'),
      import('../hand/browser-hand.mjs')]);
    defaultRunner = createActionRunner({ check, snapshot, backgroundClick, hand: sharedBrowserHand() });
  }
  return defaultRunner(tab, steps, ctx, options);
}
