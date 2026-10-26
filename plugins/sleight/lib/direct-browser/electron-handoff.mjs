// Input to an opted-in Electron app's renderer (EPV3-5). Each step runs alone inside the app page registry's guard
// (electron-pages.mjs), which checks the instance fence, the target epoch and the native join before and after it, so a
// native sheet, menu or dialog that arrives mid-step stops the batch with the step reported as sent. Input needs a read
// delivered to the model at the page's current join number: a page that parked and joined again has a new join number,
// and its old refs may point at other content. Keys that quit, close, hide or resize the app window, input into a
// terminal, history navigation, viewport changes and file choosers are refused, since they belong to the app itself.
// The base runner is act.mjs's with a plain click: no hook script ever runs in a third-party renderer, so app pages have
// no click or key shield. act.mjs and fill.mjs are unchanged. Nothing imports this file in the installed path yet
// (EPV3-7 wires `runSteps`, `fillFields`, `read` and `acknowledgeSnapshot` into the worker's turn runtime).
import { createActionRunner } from './act.mjs';
import { createFillFields } from './fill.mjs';
import { keyClass } from './rules.mjs';
import { trustedLocatorRead } from './trusted-dom.mjs';
import { staleDOMReference } from './electron-cdp-errors.mjs';

export const APP_KEY_REFUSED = /^(?:Meta|Cmd|Command)\+(?:N|Q|W|H|M|Shift\+(?:N|W)|Option\+H|Alt\+H)$|^(?:Control|Ctrl)\+(?:Meta|Cmd|Command)\+F$/i;
export const APP_REFUSALS = Object.freeze({
  terminal:   'ELECTRON_TERMINAL_REFUSED: input to a terminal is refused on turbo, as the engine refuses it',
  appKey:     'ELECTRON_APP_KEY_REFUSED: this key opens, quits, closes, hides or resizes an app window; use the app itself',
  navigation: 'ELECTRON_NATIVE_HANDOFF: reload, back, forward and navigate would reload the app window; nothing was sent',
  viewport:   'ELECTRON_NATIVE_HANDOFF: viewport changes are not available in an app window',
  upload:     'ELECTRON_NATIVE_HANDOFF: file choosers in an app are native; use the app tools',
  stale:      'ELECTRON_STALE_READ: the app window changed since your last read (join N); read again before input',
  staleElement: 'ELECTRON_STALE_READ: the element changed since your last read; read again before input',
  staleNative: 'ELECTRON_STALE_READ: the element changed since your last read; use the native path for that element',
  parked:     'ELECTRON_PARKED: <reason>. The app window needs native handling or a fresh read; nothing was sent',
});

// One canonical spelling per chord (Control, Meta, Shift, Alt, then the key), so Shift+Meta+W and Cmd+Shift+W are one key.
const MODIFIERS = { control: 'Control', ctrl: 'Control', meta: 'Meta', cmd: 'Meta', command: 'Meta', controlormeta: 'Meta', shift: 'Shift', alt: 'Alt', option: 'Alt' };
const ORDER = ['Control', 'Meta', 'Shift', 'Alt'];
export function appKeyRefusal(key) {
  if (typeof key !== 'string' || !key || !keyClass(key).chord) return undefined;
  const tokens = []; let building = '';
  for (const char of key) { if (char === '+' && building) { tokens.push(building); building = ''; } else building += char; }
  tokens.push(building);
  const main = tokens.pop(), held = new Set(tokens.map(token => MODIFIERS[token.toLowerCase()] ?? token));
  const canonical = [...ORDER.filter(name => held.has(name)), ...[...held].filter(name => !ORDER.includes(name)), /^Key([A-Z])$/i.exec(main)?.[1] ?? main].join('+');
  return APP_KEY_REFUSED.test(canonical) ? APP_REFUSALS.appKey : undefined;
}

// Closure-free, for the trusted utility world (trusted-dom.mjs passes the native reader as `read`). Label-based: xterm.js
// renders a terminal as a textarea, so the element or an ancestor within 8 levels, crossing shadow hosts, is checked.
export const terminalAncestor = function terminalAncestor(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  let node = el;
  for (let level = 0; node && level <= 8; level++) {
    if (read(node, 'nodeType') === 1) {
      const attribute = read(node, 'getAttribute');
      if (['role', 'class', 'aria-label'].some(name => /\bterminal\b|xterm/i.test(String(attribute(name) ?? '')))) return true;
    }
    const parent = read(node, 'parentNode');
    node = parent && read(parent, 'nodeType') === 11 ? read(parent, 'host') : parent;
  }
  return false;
};

const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
const refused = message => Object.assign(Error(message), { notRun: true });
const NAVIGATION = new Set(['reload', 'back', 'forward', 'navigate']);
const TERMINAL_INPUT = new Set(['click', 'type', 'paste', 'press', 'select', 'check', 'uncheck', 'drag', 'fill']);
const SCROLL_KEY = /(?:^|\+)(?:PageUp|PageDown|Home|End|Arrow(?:Up|Down|Left|Right))$/;
const scrolls = step => step.do === 'scroll' || step.do === 'press' && SCROLL_KEY.test(step.key);
const failedLine = result => result?.lines?.some(line => /: not run:|effect unconfirmed;/.test(line));
const sentLine = (n, kind, reason) => `${n} ${kind}: sent. The app window then ${reason}. Read before continuing.`;
// A batch the host stopped by parking the app connection (a revocation, a disconnect, a pipe fault) is an error that says so
// and how far it got: the steps before the stopped one ran, the stopped one is reported by its own line, none after it was sent.
function parkedSummary(reason, lines, stoppedAt, total) {
  const own = lines.filter(line => line.startsWith(stoppedAt + ' '));
  const stopped = own.some(line => /: not run:/.test(line)) ? 'was not sent'
    : own.some(line => /effect unconfirmed;/.test(line)) || !own.length ? 'may have been sent (effect unconfirmed)' : 'was sent';
  return `ELECTRON_PARKED: ${reason}. The app connection was parked during this batch: ${stoppedAt - 1} of ${total} steps ran, step ${stoppedAt} ${stopped}` +
    (stoppedAt < total ? `, and steps ${stoppedAt + 1} to ${total} were not sent` : '') + '. Read before continuing; do not replay input blindly.';
}

function staticRefusal(step) {
  if (NAVIGATION.has(step.do)) return APP_REFUSALS.navigation;
  if (step.do === 'viewport') return APP_REFUSALS.viewport;
  if (step.do === 'upload') return APP_REFUSALS.upload;
  if (step.do === 'press') return appKeyRefusal(step.key);
}

// act.mjs and fill.mjs validate the whole batch before touching the tab. Calling them with a tab whose first property
// read throws runs exactly that validation and nothing else, so a bad later step refuses the batch before step 1 is sent.
const PROBE = Error('ELECTRON_HANDOFF_PROBE');
const probeTab = new Proxy({}, { get() { throw PROBE; }, has() { throw PROBE; } });
async function validated(run) {
  try { await run(probeTab); } catch (error) {
    if (error === PROBE) return;
    error.notRun = true; throw error;
  }
  throw Error('ELECTRON_HANDOFF_PROBE');
}

export function createAppRunners({ pages, invalidateRefs, check, snapshot, inspectElement, acknowledgeSnapshot = () => true, now, sleep, hand } = {}) {
  if (typeof pages?.guard !== 'function' || typeof invalidateRefs !== 'function' || typeof check !== 'function' ||
      typeof snapshot !== 'function' || typeof acknowledgeSnapshot !== 'function') throw Error('ELECTRON_HANDOFF_REQUIRED');
  // Captures and deliveries carry the join, target epoch and refusal epoch at read start.
  // These maps last one turn. Repeated expired refs on one page require native input until the next turn.
  const captures = new WeakMap(), delivered = new WeakMap(), refusalEpochs = new WeakMap(), staleCounts = new WeakMap();
  const entryOf = page => typeof pages.entryOf === 'function' ? pages.entryOf(page) : undefined;
  async function read(page, options) {
    const entry = entryOf(page), at = entry && { joinNo: entry.joinNo, epoch: entry.epoch,
      state: entry.state, refusalEpoch: refusalEpochs.get(entry.state) ?? 0 };
    const value = await snapshot(page, options);
    if (at && at.refusalEpoch === (refusalEpochs.get(at.state) ?? 0) && Number.isSafeInteger(value?.number)) {
      let bank = captures.get(page);
      if (!bank) { bank = new Map(); captures.set(page, bank); }
      bank.set(value.number, at);
      if (bank.size > 64) bank.delete(bank.keys().next().value);
    }
    return value;
  }
  // The worker calls this once the exact snapshot text reached the client (worker.mjs deliverSnapshot).
  function acknowledge(page, number) {
    const at = captures.get(page)?.get(number), entry = entryOf(page);
    if (!at || !entry || at.state !== entry.state || at.refusalEpoch !== (refusalEpochs.get(entry.state) ?? 0)) return false;
    if (acknowledgeSnapshot(page, number) !== true) return false;
    captures.get(page).delete(number);
    const last = delivered.get(entry.state);
    if (!last || last.epoch !== at.epoch || last.joinNo <= at.joinNo) delivered.set(entry.state, at);
    return true;
  }

  const runner = createActionRunner({ check, snapshot: read, backgroundClick: (tab, locator, click) => click({}), hand,
    ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) });
  const fill = createFillFields({ check, runSteps, inspectElement, ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) });

  async function isTerminal(locator) { return await trustedLocatorRead(locator, terminalAncestor) === true; }
  // Inside the guard, right before the base runner: a delivered read at this join, and no terminal under the input.
  async function preflight(entry, step) {
    const { state } = entry, last = delivered.get(state);
    if (staleCounts.get(entry.page) >= 2) throw refused(APP_REFUSALS.staleNative);
    if (!(state.readJoinNo === entry.joinNo && state.readEpoch === entry.epoch && state.snapshotNo > 0 &&
        last?.joinNo === entry.joinNo && last.epoch === entry.epoch && last.refusalEpoch === (refusalEpochs.get(state) ?? 0)))
      throw refused(refusalEpochs.has(state) ? APP_REFUSALS.staleElement : APP_REFUSALS.stale.replace('join N', 'join ' + entry.joinNo));
    if (!TERMINAL_INPUT.has(step.do)) return;
    const { page } = entry, locators = [];
    if (step.ref) locators.push(page.getByRef(step.ref));
    else if (step.do === 'press') { const focus = page.locator(':focus'); locators.push(await focus.count() ? focus : page.locator('body')); }
    if (step.do === 'drag' && step.to) locators.push(page.getByRef(step.to));
    try {
      for (const locator of locators) if (await isTerminal(locator)) throw refused(APP_REFUSALS.terminal);
    } catch (error) {
      if (!staleDOMReference(error.message)) throw error;
      // No terminal proof means no input. Retire the read as well as its refs, so a caller
      // cannot retry against a replacement node until a new snapshot was delivered.
      refusalEpochs.set(state, (refusalEpochs.get(state) ?? 0) + 1);
      const count = (staleCounts.get(page) ?? 0) + 1;
      staleCounts.set(page, count);
      delivered.delete(state); captures.delete(page); invalidateRefs(page);
      throw refused(count >= 2 ? APP_REFUSALS.staleNative : APP_REFUSALS.staleElement);
    }
  }

  async function runSteps(entry, steps, ctx, { siteCheck, pauseCheck } = {}) {
    await validated(tab => runner(tab, steps, ctx));
    for (const step of steps) { const message = staticRefusal(step); if (message) throw refused(message); }
    const lines = []; let observe, confirmation, stoppedAt = null, paused = false;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index], n = index + 1;
      let phase = 'pre', result;
      try {
        pauseCheck?.();
        await pages.guard(entry, async () => {
          await preflight(entry, step);
          pauseCheck?.();
          phase = 'running';
          result = await runner(entry, [step], ctx, { pauseCheck, nextStep: steps[index + 1], siteCheck });
          phase = 'ran';
        });
      } catch (error) {
        paused ||= error.paused === true;
        if (phase === 'pre' || phase === 'running' && error.notRun) {
          if (index === 0) {
            const reason = pages.connectionParked?.();
            if (reason && !/^ELECTRON_PARKED: /.test(error.message)) throw refused(APP_REFUSALS.parked.replace('<reason>', clean(reason)));
            error.notRun = true; throw error;
          }
          lines.push(`${n} ${step.do}: not run: ${clean(error.message)}`);
        } else if (phase === 'running') lines.push(`${n} ${step.do}: effect unconfirmed; read before retrying.`);
        else {
          // The step ran and the guard's second check then parked the page: keep what the step reported, send no more.
          lines.push(...renumber(result.lines, n));
          if (scrolls(step)) { invalidateRefs(entry.page); lines.push('refs invalidated by scrolling. Read again.'); }
          const reason = clean(entry.parked ?? error.message);
          lines.push(failedLine(result) ? `${n} ${step.do}: the app window then ${reason}. Read before continuing.` : sentLine(n, step.do, reason));
        }
        if (phase === 'running' && scrolls(step)) invalidateRefs(entry.page);
        observe = undefined; stoppedAt = n; break;
      }
      lines.push(...renumber(result.lines, n));
      paused ||= result.paused === true;
      if (result.confirmation) confirmation = { ...result.confirmation, step: n };
      observe = result.observe;
      if (scrolls(step)) { invalidateRefs(entry.page); lines.push('refs invalidated by scrolling. Read again.'); }
      if (result.stoppedAt !== null && result.stoppedAt !== undefined) { stoppedAt = n; break; }
    }
    if (stoppedAt !== null) for (let i = stoppedAt; i < steps.length; i++) lines.push(`${i + 1} ${steps[i].do}: not reached`);
    const parked = stoppedAt !== null ? pages.connectionParked?.() : undefined;
    if (parked) return { lines: [parkedSummary(clean(parked), lines, stoppedAt, steps.length), ...lines], stoppedAt, observe: undefined, parked: clean(parked) };
    return { lines, stoppedAt, observe, ...(paused ? { paused: true } : {}), ...(confirmation ? { confirmation } : {}) };
  }
  // The per-step runner labels its one step "1 <do>"; in the batch it is step n.
  function renumber(stepLines, n) { return stepLines.map(line => /^1 \S/.test(line) ? n + line.slice(1) : line); }

  async function fillFields(entry, fields, options = {}, ctx) {
    const submit = options?.submit;
    await validated(tab => fill(tab, fields, { submit }, ctx));
    const { page } = entry, rows = fields.map(({ ref }) => ({ ref, status: 'not reached' }));
    let stopped, paused = false, submitted = { status: submit === undefined ? 'not requested' : 'not reached' };
    // fill.mjs stops a form on these within one call; one call per field needs them across the whole fill.
    const handlers = { framenavigated: () => { stopped ??= 'new document; read the page before continuing'; },
      dialog: () => { stopped ??= 'dialog is waiting; answer it before continuing'; },
      popup: () => { stopped ??= 'background popup opened; read the tabs before continuing'; },
      close: () => { stopped ??= 'tab closed'; } };
    for (const [name, fn] of Object.entries(handlers)) page.on(name, fn);
    try {
      for (let i = 0; i < fields.length && !stopped; i++) {
        const field = fields[i];
        let phase = 'pre', result;
        try {
          options.pauseCheck?.();
          await pages.guard(entry, async () => {
            await preflight(entry, { do: 'fill', ref: field.ref });
            options.pauseCheck?.();
            phase = 'running';
            result = await fill(entry, [field], { pauseCheck: options.pauseCheck }, ctx);
            phase = 'ran';
          });
          rows[i] = result.rows[0];
          paused ||= result.paused === true;
          if (result.stopped) stopped = result.stopped;
        } catch (error) {
          paused ||= error.paused === true;
          if (phase === 'pre' && i === 0) { error.notRun = true; throw error; }
          rows[i] = { ref: field.ref, status: 'failed', reason: phase === 'pre' ? clean(error.message)
            : phase === 'ran' ? `${result.rows[0]?.status === 'set' ? 'sent' : 'field may have changed'}. The app window then ${clean(entry.parked ?? error.message)}. Read before continuing.`
            : 'field may have changed; read the page before retrying' };
          stopped = 'field failed';
        }
      }
      if (submit !== undefined && !stopped && rows.every(row => row.status === 'set')) {
        try {
          const result = await runSteps(entry, [{ do: 'click', ref: submit }], ctx, { pauseCheck: options.pauseCheck });
          paused ||= result.paused === true;
          submitted = { ...result, status: failedLine(result) ? 'failed'
            : entry.state.submitUnconfirmed || result.lines.some(line => / The app window then /.test(line)) ? 'unconfirmed' : 'done' };
        } catch (error) {
          paused ||= error.paused === true;
          const reason = clean(error.message);
          submitted = error.notRun ? { status: 'failed', reason, lines: [`1 click ${submit}: not run: ${reason}`] } : { status: 'failed', reason: 'submit stopped; read the page before retrying' };
        }
      }
      return { rows, submitted, ...(paused ? { paused: true } : {}), ...(stopped ? { stopped } : {}) };
    } finally { for (const [name, fn] of Object.entries(handlers)) page.off(name, fn); }
  }

  return Object.freeze({ runSteps, fillFields, read, acknowledgeSnapshot: acknowledge });
}
