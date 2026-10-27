// Native utility-world observations, never MAIN-world getters or page promises.
import { randomBytes } from 'node:crypto';
const banks = new WeakMap();
const changedFrames = Symbol('changedFrames');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function visibleSnapshotText(text) {
  // Snapshot headers, roles, refs and link destinations are metadata, not text
  // that appeared on the page. Retain only protected snapshot labels/values.
  return text.split('\n').filter(line => /^\s*- (?!\/url:)/.test(line)).flatMap(line =>
    (line.match(/"(?:\\.|[^"\\])*"/g) ?? []).map(value => JSON.parse(value)).filter(value => value !== '[redacted]'))
    .join(' ').replace(/\s+/g, ' ').toLocaleLowerCase();
}
function observeDocument(key) {
  let bank = globalThis[key];
  if (!bank) {
    bank = { revision: 0 };
    const observer = new MutationObserver(() => bank.revision++);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    bank.observer = observer;
    Object.defineProperty(globalThis, key, { value: bank, configurable: true });
  }
  return { revision: bank.revision, ready: document.readyState === 'complete',
    length: document.body?.innerText?.trim().length ?? 0 };
}
function track(page) {
  let bank = banks.get(page);
  if (!bank) {
    bank = { key: 'sleightWait' + randomBytes(12).toString('hex'), pending: new Set(), handlers: {}, generation: 0 };
    banks.set(page, bank);
    bank.handlers.request = request => {
      if (['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType())) bank.pending.add(request);
    };
    const done = request => bank.pending.delete(request);
    bank.handlers.requestfinished = bank.handlers.requestfailed = done;
    for (const [event, handler] of Object.entries(bank.handlers)) page.on(event, handler);
  }
  return bank;
}
async function sample(page, sleep) {
  const bank = track(page);
  for (let attempt = 0; ; attempt++) {
    try {
      const frames = page.frames?.() ?? [], rows = [];
      for (const frame of frames) {
        const impl = frame?._connection?.toImpl?.(frame), utility = await impl?.utilityContext?.();
        if (utility?.world !== 'utility') throw Error('Trusted wait observation unavailable');
        rows.push(await utility.evaluateExpression(observeDocument.toString(), { isFunction: true }, bank.key));
      }
      const current = page.frames?.() ?? [];
      if (current.length !== frames.length || current.some((frame, i) => frame !== frames[i]))
        throw Object.assign(Error('Trusted wait observation unavailable'), { [changedFrames]: true });
      if (!rows.length) throw Error('Trusted wait observation unavailable');
      return { signature: JSON.stringify([bank.generation, ...rows.map(row => [row.revision, row.length])]),
        length: rows.reduce((n, row) => n + row.length, 0), ready: rows.every(row => row.ready) && !bank.pending.size };
    } catch (error) {
      // Discard partial evidence and retry the whole current frame set. Never replay an input or use MAIN-world reads.
      const transient = error[changedFrames] || /^(?:Execution context was destroyed(?:, most likely because of a navigation)?\.?|Frame was detached)$/.test(error.message);
      if (!transient || attempt >= 4 || page.isClosed?.()) throw error;
      bank.generation++; // A replaced context cannot inherit the previous document's quiet interval.
      await sleep(50);
    }
  }
}
// Start tracking before navigation, so a wait sees requests started by that navigation.
export function trackPageWaits(page) {
  track(page);
}
export async function stopPageWaits(page) {
  const bank = banks.get(page);
  if (!bank) return;
  for (const [event, handler] of Object.entries(bank.handlers)) page.off(event, handler);
  for (const frame of page.frames?.() ?? []) {
    const utility = await frame?._connection?.toImpl?.(frame)?.utilityContext?.();
    if (utility?.world === 'utility') await utility.evaluateExpression('(key) => { globalThis[key]?.observer.disconnect(); delete globalThis[key]; }', { isFunction: true }, bank.key);
  }
  banks.delete(page);
}
export async function waitForThinPage(page, { now = Date.now, sleep = pause, capMs = 3000 } = {}) {
  const initial = await sample(page, sleep);
  if (initial.length >= 50) return;
  const start = now(); let last = initial.signature, stable = start;
  for (;;) {
    const row = await sample(page, sleep), time = now();
    if (row.signature !== last || !row.ready) { last = row.signature; stable = time; }
    if (row.ready && time - stable >= 300) return;
    if ((row.length >= 50 || row.length > 0 && row.signature !== initial.signature) && time - stable >= 300 || time - start >= capMs) return;
    await sleep(50);
  }
}
export async function waitForPage(page, step, { snapshot, active = new Set(), now = Date.now, sleep = pause } = {}) {
  const start = now(), cap = Math.min(step.ms ?? 5000, 5000);
  const condition = step.until !== undefined || step.gone !== undefined || step.url !== undefined;
  let previous, quiet = start, ready = false;
  for (;;) {
    let met;
    if (step.url !== undefined) met = page.url().includes(step.url);
    else if (condition) {
      // Snapshot already covers frames and masks protected text and echoes.
      const read = await snapshot(page, { maxChars: 40000 });
      const text = visibleSnapshotText(read.text), wanted = (step.until ?? step.gone).replace(/\s+/g, ' ').toLocaleLowerCase();
      met = step.until !== undefined ? text.includes(wanted) : !text.includes(wanted);
      // Omitted or protected content cannot prove absence.
      if (step.gone !== undefined && /\[redacted\]|\b(?:truncated|continuation|more\d+_\d+)\b/i.test(read.text)) met = false;
    } else {
      const row = await sample(page, sleep);
      const settled = row.ready && !active.size;
      if (row.signature !== previous || !settled || !ready) { previous = row.signature; quiet = now(); }
      ready = settled;
      met = settled && now() - quiet >= 500;
    }
    const elapsed = now() - start;
    if (met) return (condition ? 'wait condition met after ' : 'settled after ') + elapsed + ' ms' +
      (condition && step.url === undefined ? ' (page text, untrusted)' : '');
    if (elapsed >= cap) return (condition ? 'wait condition not met' : 'page activity still pending') + ' after ' + elapsed + ' ms (cap); page below';
    await sleep(Math.min(100, cap - elapsed));
  }
}
