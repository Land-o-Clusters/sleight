import test from 'node:test';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner, overlaySignature, inspectTarget, placeClear } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { deliverSnapshot } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { createSessionPause, PAUSED_NOTE } from '../plugins/sleight/lib/session-pause.mjs';

// Playwright boundary only. There is no engine object and no catch-all method fake.
function fixture({ effect = '', submit = false, fail, onClick, snapshotFail = false, onCheck, backgroundClick } = {}) {
  const page = new EventEmitter(), actions = [], states = new Map(); let time = 0, number = 1, overlay = { count: 0, hash: 1 };
  const metadata = { name: 'Continue', submit, payment: false, form: submit, formSignature: 'before' };
  const loc = ref => utilityLocator({
    async evaluate(fn, arg) {
      if (fn.name === 'inspectTarget') return { ...metadata, ...(states.get(ref) ?? {}) };
      if (fn.name === 'overlaySignature') return overlay;
      if (fn.name === 'placeClear') return states.get(ref)?.cover ?? 'clear';
      if (fn.name === 'coverDetails' && states.get(ref)?.own) return { own: true };
      if (fn.name === 'scrollPoint') return { x: 10, y: 20 };
      if (fn.name === 'coverDetails') return { name: 'Cookie notice', buttons: ['Accept cookies'] };
      throw Error('unexpected evaluate ' + fn.name);
    },
    async count() { return 1; },
    async click(options) { actions.push(['click', ref, options]); await onClick?.(page); if (fail) throw Error(fail); },
    async fill(text, options) { actions.push(['fill', ref, text, options]); },
    async press(key, options) { actions.push(['press', ref, key, options]); },
    async selectOption(values, options) { actions.push(['selectOption', ref, values, options]); },
    async check(options) { actions.push(['check', ref, options]); },
    async uncheck(options) { actions.push(['uncheck', ref, options]); },
    async hover(options) { actions.push(['hover', ref, options]); },
    async dragTo(to, options) { actions.push(['dragTo', ref, to, options]); },
    async scrollIntoViewIfNeeded(options) { actions.push(['scrollIntoView', ref, options]); },
    async setInputFiles(paths, options) { actions.push(['upload', ref, paths, options]); },
    async waitFor(options) { actions.push(['wait', ref, options]); },
    locator(selector) { return { async check(options) { actions.push(['check', ref + ' ' + selector, options]); }, async uncheck(options) { actions.push(['uncheck', ref + ' ' + selector, options]); } }; },
  });
  page.getByRef = loc; page.url = () => 'https://example.invalid/';
  page.locator = selector => { assert.equal(selector, ':focus'); return loc('e1'); };
  page.mainFrame = () => page;
  page.evaluate = async () => { time += 16; };
  page.keyboard = { async press(key) { actions.push(['key', key]); } };
  page.mouse = { async move(x, y) { actions.push(['move', x, y]); }, async wheel(dx, dy) { actions.push(['wheel', dx, dy]); } };
  for (const method of ['goBack', 'goForward', 'reload', 'setViewportSize']) page[method] = async options => { actions.push([method, options]); };
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } }, checks = [];
  const check = async (ctx, kind, target) => {
    checks.push({ ctx, kind, target }); onCheck?.(page, checks.length);
    if (target.submit && target.state.submitUnconfirmed) return { kind: 'refuse', message: 'Read before resubmitting' };
    return { kind: 'allow' };
  };
  const run = createActionRunner({ check, ...(backgroundClick ? { backgroundClick } : {}), now: () => time, sleep: async ms => { time += ms; },
    snapshot: async (p, options) => { assert.equal(p, page); if (snapshotFail) throw Error('read unavailable');
      return { text: effect || 'No visible changes.', number: ++number, options }; } });
  return { page, tab, run, checks, actions, states, time: () => time, setOverlay: next => { overlay = next; } };
}

test('pause during a turbo step finishes that input and drops later steps', async () => {
  const pause = createSessionPause();
  const f = fixture({ onClick() { pause.set(true); pause.set(false); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {}, { pauseCheck: pause.checkpoint() });
  assert.equal(f.actions.filter(a => a[0] === 'click').length, 1);
  assert.match(result.lines.join('\n'), /Paused by the user/);
  assert.equal(result.stoppedAt, 2);
});

test('pause while turbo awaits a confirmation stops before the first input', async () => {
  const pause = createSessionPause();
  const f = fixture({ onCheck() { pause.set(true); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {}, { pauseCheck: pause.checkpoint() });
  assert.equal(f.actions.filter(a => a[0] === 'click').length, 0);
  assert.ok(result.lines.some(line => line.includes(PAUSED_NOTE)));
});

test('v3 action reports an unproved click as an observation and returns a diff', async () => {
  const f = fixture(); const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /no visible change/i); assert.equal(result.stoppedAt, null);
  assert.equal(result.observe.text, 'No visible changes.'); assert.equal(result.observe.options.since, 1);
  assert.equal(f.actions.filter(a => a[0] === 'click').length, 1);
});

test('MC1 action reports the settled retry in the same step and disables recovery for submits', async () => {
  for (const submit of [false, true]) {
    const f = fixture({ submit, backgroundClick: async (tab, locator, click, options) => {
      const result = await click({});
      assert.equal(options.recover(), !submit);
      if (options.recover()) options.onRetry();
      return result;
    } });
    const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
    if (submit) assert.doesNotMatch(result.lines[0], /retried/);
    else assert.match(result.lines[0], /waited for the page to settle and retried the click once/);
    assert.equal(f.actions.filter(action => action[0] === 'click').length, 1);
  }
});

for (const [modifier, want] of [['cmd', 'Meta'], ['ctrl', 'Control']])
  test(`click modifier ${modifier} reaches the observed element through the background guard`, async () => {
    let guarded = 0;
    const f = fixture({ backgroundClick: async (tab, loc, click, opts) => {
      assert.equal(opts.modifier, want);
      assert.equal(typeof opts.recover, 'function');
      assert.equal(typeof opts.onRetry, 'function');
      guarded++; return click({ modifiers: ['ControlOrMeta'] });
    } });
    const result = await f.run(f.tab, [{ do: 'click', ref: 'e1', modifier }], {});
    assert.equal(result.stoppedAt, null); assert.equal(guarded, 1);
    assert.deepEqual(f.actions[0][2].modifiers, ['ControlOrMeta', process.platform === 'darwin' && modifier === 'ctrl' ? 'Meta' : want]);
    assert.equal(f.checks[0].target.ref, 'e1');
  });

test('click modifiers cannot bypass payment refusal, pending input or element cover checks', async () => {
  const paid = fixture({ submit: true }); paid.states.set('e1', { payment: true });
  paid.tab.state.submitUnconfirmed = { snapshotNo: 1 };
  const result = await paid.run(paid.tab, [{ do: 'click', ref: 'e1', modifier: 'cmd' }], {});
  assert.match(result.lines[0], /not run:.*Read before resubmitting/); assert.deepEqual(paid.actions, []);
  const pending = fixture(); pending.tab.state.actionPending = {};
  assert.match((await pending.run(pending.tab, [{ do: 'click', ref: 'e1', modifier: 'ctrl' }], {})).lines[0], /pending/);
  assert.deepEqual(pending.actions, []);
  const covered = fixture({ fail: 'Timeout: covering element intercepts pointer events' });
  assert.match((await covered.run(covered.tab, [{ do: 'click', ref: 'e1', modifier: 'cmd' }], {})).lines[0], /not run:.*cover/);
  assert.equal(covered.actions.length, 1, 'Playwright checks the hit and refuses without replay');
});

test('invalid modifiers or modifiers on non-click steps reject the whole batch before input', async () => {
  const f = fixture();
  for (const step of [{ do: 'click', ref: 'e1', modifier: 'shift' }, { do: 'click', ref: 'e1', modifier: 'alt' }, { do: 'click', ref: 'e1', modifier: 'super' }, { do: 'click', ref: 'e1', modifier: ['cmd'] },
    { do: 'press', ref: 'e1', key: 'Enter', modifier: 'cmd' }, { do: 'navigate', ref: 'e1', modifier: 'cmd' }])
    await assert.rejects(f.run(f.tab, [{ do: 'click', ref: 'e1' }, step], {}), /modifier/);
  assert.deepEqual(f.actions, []);
});

test('v3 validates the whole batch before input, including every required field', async () => {
  const f = fixture();
  for (const step of [{ do: 'click' }, { do: 'type', ref: 'e1' }, { do: 'press' }, { do: 'select', ref: 'e1' },
    { do: 'drag', ref: 'e1' }, { do: 'upload', ref: 'e1' }, { do: 'dialog' }, { do: 'viewport', width: 0, height: 800 },
    { do: 'evaluate', text: 'window.focus()' }, { do: 'scroll', dy: Infinity }]) {
    await assert.rejects(f.run(f.tab, [{ do: 'click', ref: 'e1' }, step], {}), /needs|unsupported|invalid/i);
  }
  await assert.rejects(f.run(f.tab, [], {}), /1 to 12/);
  await assert.rejects(f.run(f.tab, Array.from({ length: 13 }, () => ({ do: 'back' })), {}), /1 to 12/);
  assert.deepEqual(f.actions, []);
});

test('v3 runs text, keys, choice, toggle, hover and drag operations in order', async () => {
  const f = fixture({ effect: '+ textbox changed' });
  const steps = [{ do: 'type', ref: 'e1', text: 'hello' }, { do: 'press', ref: 'e1', key: 'Tab' },
    { do: 'select', ref: 'e2', values: ['A', 'B'] }, { do: 'check', ref: 'e3' }, { do: 'uncheck', ref: 'e3' },
    { do: 'hover', ref: 'e4' }, { do: 'drag', ref: 'e4', to: 'f2e5' }];
  const result = await f.run(f.tab, steps, { userMessage: 'Fill these fields' });
  assert.equal(result.lines.filter(line => /^\d+ /.test(line)).length, 7);
  assert.equal(result.lines.at(-1), 'Batch observation: 1 lines changed.');
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(f.actions.map(a => a[0]), ['fill', 'press', 'selectOption', 'check', 'uncheck', 'hover', 'dragTo']);
  assert.equal(f.checks.length, 7);
  assert.equal(f.actions[0][2], 'hello');
});

test('v3 reports viewport, navigation controls, keyboard and bounded wait', async () => {
  const f = fixture();
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }, { do: 'press', key: 'Escape' },
    { do: 'wait', ref: 'e1' }, { do: 'back' }, { do: 'forward' }, { do: 'reload' }], {});
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(f.actions.map(a => a[0]), ['setViewportSize', 'key', 'wait', 'goBack', 'goForward', 'reload']);
  assert.deepEqual(f.actions[0][1], { width: 390, height: 844 });
});

for (const event of ['navigation', 'document', 'dialog', 'popup', 'close']) test(`v3 stops after ${event} and lists untouched steps`, async () => {
  const f = fixture({ onClick(page) {
    if (event === 'navigation') page.emit('framenavigated', page);
    if (event === 'document') page.emit('load');
    if (event === 'dialog') page.emit('dialog', { type: () => 'confirm', message: () => 'Leave?' });
    if (event === 'popup') page.emit('popup', { url: () => 'https://example.invalid/popup', isClosed: () => false });
    if (event === 'close') page.emit('close');
  } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'must not run' }], {});
  assert.equal(result.stoppedAt, 1); assert.match(result.lines[1], /not reached/);
  assert.equal(f.actions.length, 1);
  for (const name of ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'dialog', 'popup', 'close'])
    assert.equal(f.page.listenerCount(name), 0, name);
});

test('v3 never retries a timed out dispatched input and keeps the cover\'s page text out of the harness line', async () => {
  const f = fixture({ fail: 'Timeout 1000ms exceeded: Cookie notice intercepts pointer events' });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {});
  assert.match(result.lines[0], /covering element/); assert.doesNotMatch(result.lines[0], /Cookie notice|Accept cookies/); // page text belongs in the labelled blocker read
  assert.match(result.lines[1], /not reached/); assert.equal(f.actions.length, 1);
});

test('v3 a cover refusal before input says not run, not effect unconfirmed', async () => {
  const f = fixture({ fail: 'Timeout 1000ms exceeded: Cookie notice intercepts pointer events' });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /^1 click e1: not run: covered by a covering element/); assert.doesNotMatch(result.lines[0], /unconfirmed/);
  const own = fixture({ fail: 'Timeout 1000ms exceeded: label intercepts pointer events' }); own.states.set('e1', { own: true });
  assert.match((await own.run(own.tab, [{ do: 'click', ref: 'e1' }], {})).lines[0], /not run: covered by its own label; use check or uncheck/);
});

test('v3 check and uncheck click the control\'s own centre when its own label sits over it (never the label\'s centre), and wait for a clear hit otherwise', async () => {
  const f = fixture(); f.states.set('e1', { cover: 'label' });
  await f.run(f.tab, [{ do: 'check', ref: 'e1' }, { do: 'uncheck', ref: 'e1' }, { do: 'check', ref: 'e2' }, { do: 'check', ref: 'e3' }], {});
  assert.deepEqual(f.actions.filter(a => /check/.test(a[0])).map(a => [a[0], a[1], a[2]?.force === true]),
    [['check', 'e1', true], ['uncheck', 'e1', true], ['check', 'e2', false], ['check', 'e3', false]]);
  const clicked = fixture(); clicked.states.set('e1', { cover: 'label' });
  await clicked.run(clicked.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {});
  assert.deepEqual(clicked.actions.filter(a => a[0] === 'click').map(a => [a[1], a[2]?.force === true]), [['e1', true], ['e2', false]]);
  const broken = fixture(); broken.states.set('e1', { cover: 'label' });
  broken.page.getByRef = ref => { const l = fixture().page.getByRef(ref); l.evaluate = async () => { throw Error('read failed'); }; return l; };
  await broken.run(broken.tab, [{ do: 'check', ref: 'e1' }], {}); // a failed read leaves the plain check
});

test('placeClear centres a covered control, tries each edge once, and names an own label, a fixed cover or another cover', () => {
  const run = (hits, { label = true, fixed = ['bar'], views = [true] } = {}) => {
    let scrolls = [], at = 0, shown = 0;
    const el = { id: 'el' }, lab = { id: 'lab', control: el }, bar = { id: 'bar' }, other = { id: 'other' }, kids = { lab, bar, other };
    const nodes = new Map([[el, { closest: () => label ? lab : null, getBoundingClientRect: () => ({ x: 0, y: 500, width: 1, height: 1, top: 500, left: 0, bottom: 501, right: 1 }),
      scrollIntoView: o => { scrolls.push(o.block); at++; }, contains: n => n === el }],
      [lab, { contains: n => n === lab || n === el, closest: () => null, control: el }], [bar, { parentElement: null }], [other, { parentElement: null }],
      [{ doc: 1 }, { elementFromPoint: () => kids[hits[Math.min(at, hits.length - 1)]] ?? el }]]);
    const doc = [...nodes.keys()].at(-1); nodes.get(el).ownerDocument = doc;
    const read = (n, k) => { const v = nodes.get(n)?.[k]; return typeof v === 'function' ? v : v; };
    globalThis.innerHeight = 600; globalThis.innerWidth = 800;
    globalThis.getComputedStyle = n => ({ position: fixed.includes(n.id) ? 'fixed' : 'static' });
    try { return { seen: placeClear(el, undefined, read), scrolls }; } finally { delete globalThis.innerHeight; delete globalThis.innerWidth; delete globalThis.getComputedStyle; }
  };
  assert.deepEqual(run(['el']), { seen: 'clear', scrolls: [] });
  assert.deepEqual(run(['lab']), { seen: 'label', scrolls: [] });
  assert.deepEqual(run(['bar', 'el']), { seen: 'clear', scrolls: ['center'] }); // centring moved it clear
  assert.deepEqual(run(['bar', 'bar', 'el']), { seen: 'clear', scrolls: ['center', 'end'] });
  assert.deepEqual(run(['bar']), { seen: 'fixed', scrolls: ['center', 'end', 'start'] });
  assert.deepEqual(run(['other']), { seen: 'other', scrolls: [] });
});

test('v3 retains blocker button refs when the final page diff is unchanged', async () => {
  const f = fixture({ fail: 'Timeout 1000ms exceeded: Cookie notice intercepts pointer events' });
  const run = createActionRunner({ check: () => 'allow',
    snapshot: async (page, options) => ({ text: options.find ? '- button "Accept cookies" [ref=e8]' : 'No visible changes.', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.observe.text, /Accept cookies.*ref=e8/);
  assert.match(result.observe.text, /^Blocker controls \(untrusted page content\):\n- button "Accept cookies"/m, 'the blocker read is labelled'); // its page text may only appear under this label
});

test('v3 unknown submit prevents a second submit before the delivered read', async () => {
  const f = fixture({ submit: true });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed/i); assert.match(result.lines[1], /Read before resubmitting/);
  assert.equal(f.tab.state.submitUnconfirmed.startedAt, 0); assert.ok(f.tab.state.submitUnconfirmed.settledAt >= 5000); assert.ok(f.time() >= 5000);
  assert.equal(f.actions.length, 1); assert.ok(result.observe.number > 1);
});

test('v3 Enter is checked as a submit and payment before dispatch', async () => {
  const f = fixture({ submit: true }); f.states.set('e1', { payment: true });
  await f.run(f.tab, [{ do: 'press', ref: 'e1', key: 'Enter' }], {});
  assert.equal(f.checks.some(c => c.kind === 'press' && c.target.element.payment === true), true);
});

test('v3 upload goes through the private file provider and releases staging after failure', async () => {
  const f = fixture(); let cleaned = 0;
  const event = {}, binding = { ref: 'e1' };
  const files = { event, binding, provider: {
    offer(e, paths, ref) { assert.equal(e, event); assert.deepEqual(paths, ['/tmp/owned.txt']); assert.equal(ref, 'e1'); return 'fhandle'; },
    async stage(handles, b) { assert.deepEqual(handles, ['fhandle']); assert.equal(b, binding);
      return { payloads: [{ name: 'owned.txt', mimeType: 'text/plain', buffer: Buffer.from('approved') }], cleanup() { cleaned++; } }; },
  } };
  await f.run(f.tab, [{ do: 'upload', ref: 'e1', paths: ['/tmp/owned.txt'] }], { files });
  assert.equal(f.actions[0][0], 'upload'); assert.equal(f.actions[0][2][0].buffer.toString(), 'approved'); assert.equal(cleaned, 1);
  const refused = await f.run(f.tab, [{ do: 'upload', ref: 'e1', paths: ['/tmp/page.txt'] }], {});
  assert.match(refused.lines[0], /file/i); assert.equal(f.actions.length, 1);
  const original = f.page.getByRef;
  f.page.getByRef = ref => utilityLocator({ ...original(ref), async setInputFiles() { throw Error('raw private bytes must stay private'); } });
  const failed = await f.run(f.tab, [{ do: 'upload', ref: 'e1', paths: ['/tmp/owned.txt'] }], { files });
  assert.equal(cleaned, 2); assert.doesNotMatch(JSON.stringify(failed), /raw private bytes/);
});

test('v3 confirmation is returned without executing input', async () => {
  for (const modifier of [undefined, 'cmd', 'ctrl']) {
    const f = fixture({ submit: true }); f.states.set('e1', { payment: true }); let guarded = 0;
    const run = createActionRunner({ check: (ctx, kind, target) => {
      assert.equal(kind, 'click'); assert.equal(target.element.payment, true);
      return { kind: 'confirm', terms: { amount: '25' } };
    }, backgroundClick: () => { guarded++; throw Error('payment input must not start'); },
    snapshot: async () => ({ text: 'untrusted page', number: 2 }) });
    const result = await run(f.tab, [{ do: 'click', ref: 'e1', ...(modifier ? { modifier } : {}) }], { userMessage: 'Read' });
    assert.match(result.lines[0], /confirm/i); assert.equal(f.actions.length, 0); assert.equal(guarded, 0);
    assert.deepEqual(result.confirmation, { step: 1, terms: { amount: '25' } });
  }
});

test('v3 read failure after input remains an observation, with no automatic resend', async () => {
  const f = fixture({ snapshotFail: true });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines.join('\n'), /read unavailable/i); assert.equal(f.actions.length, 1);
});

test('v3 a changed diff is described as changed rather than no visible change', async () => {
  const f = fixture({ effect: '+ button "Next" [ref=e2]\n- button "Previous" [ref=e1]' });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /2 lines changed/);
});

test('PF3 a batch reports its shared change count once while keeping each input outcome', async () => {
  const effect = '+ textbox "Name" [ref=e1]\n- textbox "Old name" [ref=e2]';
  const f = fixture({ effect });
  const result = await f.run(f.tab, [{ do: 'type', ref: 'e1', text: 'Ada' }, { do: 'type', ref: 'e2', text: 'Lee' }], {});
  assert.deepEqual(result.lines, ['1 type e1: input sent', '2 type e2: input sent', 'Batch observation: 2 lines changed.']);
  assert.equal(result.observe.text, effect);
  assert.equal(result.stoppedAt, null);
  assert.equal(f.actions.filter(a => a[0] === 'fill').length, 2);
});

test('PF3 shared observations preserve refusals and later unexecuted steps', async () => {
  const f = fixture({ effect: '+ textbox "Name" [ref=e1]' });
  f.states.set('e3', { submit: true, form: true });
  f.tab.state.submitUnconfirmed = { snapshotNo: 1 };
  const result = await f.run(f.tab, [
    { do: 'type', ref: 'e1', text: 'Ada' }, { do: 'type', ref: 'e2', text: 'Lee' },
    { do: 'click', ref: 'e3' }, { do: 'type', ref: 'e4', text: 'not sent' },
  ], {});
  assert.deepEqual(result.lines, ['1 type e1: input sent', '2 type e2: input sent',
    '3 click e3: not run: Read before resubmitting', '4 type: not reached', 'Batch observation: 1 lines changed.']);
  assert.equal(result.stoppedAt, 3);
  assert.equal(f.actions.filter(a => a[0] === 'fill').length, 2);
  assert.ok(f.tab.state.submitUnconfirmed, 'formatting cannot clear the submit fence');
});

test('PF3 compaction never calls absent or unchanged evidence a successful batch', async () => {
  for (const options of [{}, { snapshotFail: true }]) {
    const f = fixture(options);
    const result = await f.run(f.tab, [{ do: 'type', ref: 'e1', text: 'Ada' }, { do: 'type', ref: 'e2', text: 'Lee' }], {});
    assert.doesNotMatch(result.lines.join('\n'), /Batch observation:.*lines changed|success|verified/);
    assert.match(result.lines.join('\n'), options.snapshotFail ? /Read unavailable/ : /no visible change/i);
    assert.equal(f.actions.filter(a => a[0] === 'fill').length, 2);
  }
});

test('v3 bare Enter classifies the focused field and its payment form', async () => {
  const f = fixture({ submit: true }); f.states.set('e1', { payment: true });
  await f.run(f.tab, [{ do: 'press', key: 'Enter' }], {});
  assert.equal(f.checks.some(c => c.kind === 'press' && c.target.element.payment), true);
});

test('v3 page dialogs wait for an explicit answer and clear after acceptance', async () => {
  const f = fixture(); let accepted;
  f.tab.state.dialog = { type: () => 'prompt', message: () => 'Name?', accept: async text => { accepted = text; }, dismiss: async () => {} };
  const result = await f.run(f.tab, [{ do: 'dialog', accept: true, text: 'Example' }], {});
  assert.equal(accepted, 'Example'); assert.equal(f.tab.state.dialog, null); assert.equal(result.stoppedAt, null);
  assert.equal(f.checks.length, 1); assert.equal(f.checks[0].target.message, 'Name?');
});

test('v3 refuses to input behind a waiting dialog', async () => {
  const f = fixture(); f.tab.state.dialog = { type: () => 'confirm', message: () => 'Continue?' };
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.equal(f.actions.length, 0); assert.match(result.lines[0], /dialog/);
});

test('v3 action failure redacts echoed text and files', async () => {
  const f = fixture({ fail: 'failed while setting secret-card-value' });
  f.page.getByRef = () => utilityLocator({ async evaluate() { return {}; }, async fill() { throw Error('failed while setting secret-card-value'); } });
  const result = await f.run(f.tab, [{ do: 'type', ref: 'e1', text: 'secret-card-value' }], {});
  assert.doesNotMatch(JSON.stringify(result), /secret-card-value/);
});

test('v3 uses V6 verdicts once per operation with the inspected element', async () => {
  const f = fixture(); let calls = 0;
  const run = createActionRunner({ now: () => 0, sleep: async () => {},
    check: (ctx, kind, target) => { calls++; assert.equal(kind, 'click'); assert.equal(target.element.name, 'Continue');
      return { verdict: 'refuse', message: 'owner consent needed' }; },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /owner consent needed/); assert.equal(calls, 1); assert.equal(f.actions.length, 0);
});

test('v3 a still-pending timed out input blocks later input until it settles', async () => {
  let release; const f = fixture({ onClick: () => new Promise(resolve => { release = resolve; }) });
  const run = createActionRunner({ actionTimeoutMs: 10, check: () => 'allow',
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  const first = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(first.lines[0], /unconfirmed/); assert.equal(f.tab.state.actionPending, true);
  const second = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(second.lines[0], /pending/); assert.equal(f.actions.length, 1);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.tab.state.actionPending, false);
});

test('v3 settles a request started by input and records a finished-request observation', async () => {
  const request = { resourceType: () => 'fetch' };
  const f = fixture({ submit: true, onClick(page) { page.emit('request', request); queueMicrotask(() => page.emit('requestfinished', request)); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /request finished/); assert.equal(f.tab.state.submitUnconfirmed, false); assert.ok(f.time() < 5000);
});

test('v3 failed and preexisting requests cannot confirm a submit', async () => {
  const request = { resourceType: () => 'fetch' };
  const f = fixture({ submit: true, onClick(page) { page.emit('request', request); page.emit('requestfailed', request);
    page.emit('requestfinished', { resourceType: () => 'fetch' }); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed/); assert.ok(f.tab.state.submitUnconfirmed);
});

test('v3 form change confirms its submit without turning unrelated clicks into errors', async () => {
  let f; f = fixture({ submit: true, onClick() { f.states.set('e1', { formSignature: 'after' }); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /form changed/); assert.equal(f.tab.state.submitUnconfirmed, false);
});

test('v3 passes the background-click disposition to the single Playwright click', async () => {
  const f = fixture(); let time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    backgroundClick: (tab, loc, click) => { assert.equal(tab, f.tab); return click({ modifiers: ['ControlOrMeta'] }); },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.equal(f.actions.length, 1); assert.deepEqual(f.actions[0][2], { timeout: 1000, modifiers: ['ControlOrMeta'] });
});

// The guard's two cancel messages (page.mjs): "not run" and "retry is safe" only when the page saw no press, release or click.
for (const [name, message, pattern, absent] of [
  ['safe', 'page changed during the click; read again. The page received no press, release or click, so a fresh read and one retry is safe.', /^1 click e1: not run: page changed during the click; read again\. The page received no press, release or click, so a fresh read and one retry is safe\./, /effect unconfirmed/],
  ['after a press', 'page changed during the click; the page had already received part of it.', /^1 click e1: effect unconfirmed; read before retrying\. page changed during the click; the page had already received part of it\./, /not run|retry is safe/],
]) test('v3 a guard-cancelled click is worded ' + name, async () => {
  const f = fixture(); let time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    backgroundClick: async (tab, loc, click) => { await click({}); throw Error(message); },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], pattern); assert.doesNotMatch(result.lines[0], absent);
});

test('v3 scroll until finds the text in a bounded search and returns its ref', async () => {
  const f = fixture(); let reads = 0, time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: ++reads < 3 ? '- option "other" [ref=e7]' : '- option "Norcrest" [ref=e8]', number: reads + 1 }) });
  const result = await run(f.tab, [{ do: 'scroll', ref: 'e1', until: 'Norcrest' }], {});
  assert.match(result.lines[0], /e8/); assert.equal(f.actions.filter(a => a[0] === 'wheel').length, 2);
});

test('v3 scroll until stops after at most sixty wheels when text never appears', async () => {
  const f = fixture(); let time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: '- option "other" [ref=e7]', number: 2 }) });
  const result = await run(f.tab, [{ do: 'scroll', ref: 'e1', until: 'missing' }], {});
  assert.match(result.lines[0], /not found/i); assert.equal(f.actions.filter(a => a[0] === 'wheel').length, 60);
});

function pendingDialog(t, { early = false, rejectAnswer = false, holdAnswer = false, submit = false } = {}) {
  const page = new EventEmitter(), calls = []; let release, answerRelease, time = 0;
  const held = new Promise(resolve => { release = resolve; });
  const answerHeld = new Promise(resolve => { answerRelease = resolve; });
  t.after(() => { release(); answerRelease(); });
  const answer = async kind => {
    calls.push(kind);
    if (holdAnswer) await answerHeld;
    if (rejectAnswer) throw Error('answer failed');
  };
  const dialog = { type: () => 'confirm', message: () => 'Continue?', accept: () => answer('accept'), dismiss: () => answer('dismiss') };
  page.mainFrame = () => page; page.url = () => 'about:blank';
  page.getByRef = ref => utilityLocator({
    async evaluate(fn) { assert.equal(fn.name, 'inspectTarget'); return { name: 'Continue', submit, form: submit, formSignature: 'same' }; },
    async click() { calls.push(ref); if (ref === 'e1') { if (early) page.emit('dialog', dialog); await held; } },
  });
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } };
  const run = createActionRunner({ actionTimeoutMs: 10, check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { page, tab, run, calls, dialog, release, answerRelease, tick };
}

for (const mode of ['accept', 'dismiss', 'rejected answer']) test('v3 ' + mode + ' cannot release the original pending click', async t => {
  const f = pendingDialog(t, { early: true, rejectAnswer: mode === 'rejected answer' });
  const first = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(first.lines[0], /dialog confirm/);
  await f.run(f.tab, [{ do: 'dialog', accept: mode !== 'dismiss' }], {});
  assert.equal(f.tab.state.actionPending, true);
  await f.run(f.tab, [{ do: 'click', ref: 'e2' }], {});
  assert.deepEqual(f.calls, ['e1', mode === 'dismiss' ? 'dismiss' : 'accept']);
  assert.equal(f.tab.state.dialog, mode === 'rejected answer' ? f.dialog : null);
  f.release(); await f.tick();
  assert.equal(f.tab.state.actionPending, false);
  assert.equal(f.page.listenerCount('dialog'), 0);
  if (mode !== 'rejected answer') {
    await f.run(f.tab, [{ do: 'click', ref: 'e2' }], {});
    assert.equal(f.calls.at(-1), 'e2');
  }
});

test('v3 a late dialog from a timed-out submit remains answerable without replay', async t => {
  const f = pendingDialog(t, { submit: true });
  const first = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(first.lines[0], /still pending/);
  assert.equal(f.page.listenerCount('dialog'), 1);
  const marker = f.tab.state.submitUnconfirmed;
  f.page.emit('dialog', f.dialog);
  assert.equal(f.tab.state.dialog, f.dialog);
  await f.run(f.tab, [{ do: 'dialog', accept: true }], {});
  assert.deepEqual(f.calls, ['e1', 'accept']);
  assert.equal(f.tab.state.submitUnconfirmed, marker);
  f.release(); await f.tick();
  assert.equal(f.tab.state.actionPending, false);
  for (const name of ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'dialog', 'popup', 'close'])
    assert.equal(f.page.listenerCount(name), 0, name);
});

test('v3 settling the original click cannot release a still-pending dialog answer', async t => {
  const f = pendingDialog(t, { early: true, holdAnswer: true });
  await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  const answer = await f.run(f.tab, [{ do: 'dialog', accept: true }], {});
  assert.match(answer.lines[0], /still pending/);
  f.release(); await f.tick();
  assert.equal(f.tab.state.actionPending, true);
  await f.run(f.tab, [{ do: 'dialog', accept: true }], {});
  assert.deepEqual(f.calls, ['e1', 'accept'], 'the pending answer cannot be dispatched twice');
  f.answerRelease(); await f.tick();
  assert.equal(f.tab.state.actionPending, false);
  assert.equal(f.tab.state.dialog, null);
  assert.equal(f.page.listenerCount('dialog'), 0);
});

test('v3 page teardown removes a pending input watcher without replay or a late dialog', async t => {
  const f = pendingDialog(t);
  await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.equal(f.page.listenerCount('dialog'), 1);
  f.page.emit('close');
  for (const name of ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'dialog', 'popup', 'close'])
    assert.equal(f.page.listenerCount(name), 0, name);
  f.page.emit('dialog', f.dialog);
  assert.equal(!!f.tab.state.dialog, false);
  assert.deepEqual(f.calls, ['e1']);
});

test('v3 answering a dialog preserves a pending gate owned outside this runner', async () => {
  const f = fixture();
  f.tab.state.actionPending = true;
  f.tab.state.dialog = { type: () => 'confirm', message: () => 'Continue?', accept: async () => {} };
  await f.run(f.tab, [{ do: 'dialog', accept: true }], {});
  assert.equal(f.tab.state.actionPending, true);
});

test('endpoint popup outcome reports the blocked line without its URL or content', async () => {
  const f = fixture({ onClick: page => page.emit('popup', { url: () => 'http://alias.invalid:9222/json/list', isClosed: () => true }) });
  f.tab.endpoint = 'ws://127.0.0.1:9222/devtools/browser/private';
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines.join('\n'), /blocked: DevTools endpoint/);
  assert.doesNotMatch(result.lines.join('\n'), /9222|alias.invalid|json\/list/);
});

test('v3 destroyed form evidence stops the batch after dispatched submit', async () => {
  const f = fixture({ submit: true }); let reads = 0;
  f.page.getByRef = () => utilityLocator({
    async evaluate(fn) {
      assert.equal(fn.name, 'inspectTarget');
      if (++reads > 1) throw Error('Execution context was destroyed');
      return { name: 'Submit', submit: true, payment: false, form: true, formSignature: 'before' };
    },
    async click() { f.actions.push(['click']); },
  });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'suffix' }], {});
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /effect unconfirmed;.*Execution context was destroyed/);
  assert.match(result.lines[1], /not reached/);
  assert.equal(f.actions.length, 1);
  assert.ok(f.tab.state.submitUnconfirmed);
});

test('v3 a submit that opens a dialog with no request settles after one second and stays unconfirmed until a fresh read', async () => {
  let f; f = fixture({ submit: true, onClick() { f.setOverlay({ count: 1, hash: 7 }); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /the page answered with a dialog or panel \(below\) and no request has started/);
  assert.ok(f.time() >= 1000 && f.time() < 1200, 'settled at ' + f.time());
  assert.match(result.lines[1], /Read before resubmitting/); assert.equal(f.actions.length, 1);
  const submit = f.tab.state.submitUnconfirmed; assert.ok(submit && submit.settledAt >= 1000);
  // The retry protection is the unchanged delivered-read rule: a read taken before the one-second mark does not clear it.
  assert.equal(deliverSnapshot(f.tab.state, { state: f.tab.state, number: 9, capturedAt: submit.startedAt + 999 }), false);
  assert.ok(f.tab.state.submitUnconfirmed);
  assert.equal(deliverSnapshot(f.tab.state, { state: f.tab.state, number: 9, capturedAt: submit.settledAt }), true);
  assert.equal(f.tab.state.submitUnconfirmed, false);
});

test('v3 a dialog that was already open, or a new one while a request is in flight, still waits the full five seconds', async () => {
  let f = fixture({ submit: true }); f.setOverlay({ count: 1, hash: 7 });
  let result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed after 5 s/); assert.ok(f.time() >= 5000);
  f = fixture({ submit: true, onClick(page) { f.setOverlay({ count: 1, hash: 7 }); page.emit('request', { resourceType: () => 'fetch' }); } });
  result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed after 5 s/); assert.ok(f.time() >= 5000); assert.ok(f.tab.state.submitUnconfirmed);
});

test('v3 a submit with no visible effect keeps the five second wait and the unconfirmed state', async () => {
  const f = fixture({ submit: true }); const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed after 5 s/); assert.ok(f.time() >= 5000); assert.ok(f.tab.state.submitUnconfirmed);
});

test('v3 overlay signature counts visible dialogs, alerts and status panels and their text', () => {
  const node = (text, { width = 10, display = 'block' } = {}) => ({ textContent: text, getBoundingClientRect: () => ({ width, height: 5 }), display });
  const doc = nodes => ({ querySelectorAll: () => nodes, defaultView: { getComputedStyle: n => ({ display: n.display, visibility: 'visible' }) } });
  const sig = nodes => overlaySignature({ ownerDocument: doc(nodes) });
  const none = sig([]), one = sig([node('Save these settings?')]);
  assert.equal(none.count, 0); assert.equal(one.count, 1); assert.notEqual(one.hash, none.hash);
  assert.deepEqual(sig([node('Save these settings?'), node('hidden', { display: 'none' }), node('flat', { width: 0 }), node('  ')]), one);
  assert.notDeepEqual(sig([node('Saved')]), sig([node('Failed')]));
  assert.equal(overlaySignature({ ownerDocument: null }), null);
});

test('v3 a batch of repeated key presses settles briefly per step and fully once, with every step still gated', async () => {
  const f = fixture(); const steps = Array.from({ length: 12 }, () => ({ do: 'press', key: 'ArrowRight' }));
  const result = await f.run(f.tab, steps, {});
  assert.equal(result.stoppedAt, null); assert.equal(f.actions.filter(a => a[0] === 'key').length, 12); assert.equal(f.checks.length, 12);
  assert.ok(f.time() <= 600 + 11 * 60, 'settled in ' + f.time()); assert.ok(f.time() >= 600);
  for (const name of ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'dialog', 'popup', 'close'])
    assert.equal(f.page.listenerCount(name), 0, name);
});

test('v3 typing and key presses defer their settle, but Enter, Space, a click or the last step settle in full', async () => {
  const timeFor = async steps => { const f = fixture(); await f.run(f.tab, steps, {}); return f.time(); };
  assert.ok(await timeFor([{ do: 'type', ref: 'e1', text: 'a' }, { do: 'type', ref: 'e2', text: 'b' }]) < 800);
  assert.ok(await timeFor([{ do: 'press', key: 'Enter' }, { do: 'press', key: 'ArrowRight' }]) >= 1200);
  assert.ok(await timeFor([{ do: 'press', key: 'Space' }, { do: 'press', key: 'ArrowRight' }]) >= 1200);
  assert.ok(await timeFor([{ do: 'press', key: 'Control+Enter' }, { do: 'press', key: 'ArrowRight' }]) >= 1200);
  assert.ok(await timeFor([{ do: 'press', key: 'ArrowRight' }, { do: 'click', ref: 'e1' }]) >= 1200);
  assert.ok(await timeFor([{ do: 'click', ref: 'e1' }, { do: 'press', key: 'ArrowRight' }]) >= 1200);
});

test('v3 a boundary that arrives after a deferred step stops the batch before the next input', async () => {
  const f = fixture({ onCheck(page, n) { if (n === 3) page.emit('load'); } });
  const result = await f.run(f.tab, Array.from({ length: 5 }, () => ({ do: 'press', key: 'ArrowRight' })), {});
  assert.equal(f.actions.filter(a => a[0] === 'key').length, 2); assert.equal(result.stoppedAt, 3);
  assert.match(result.lines[2], /not run: the page changed after the previous step/); assert.match(result.lines[3], /not reached/);
  for (const name of ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'dialog', 'popup', 'close'])
    assert.equal(f.page.listenerCount(name), 0, name);
});

test('v3 a dialog opened by a deferred step ends the batch at once', async () => {
  const f = fixture(); const press = f.page.keyboard.press;
  f.page.keyboard.press = async key => { await press(key); f.page.emit('dialog', { type: () => 'alert', message: () => 'Hi' }); };
  const result = await f.run(f.tab, [{ do: 'press', key: 'ArrowRight' }, { do: 'press', key: 'ArrowRight' }], {});
  assert.match(result.lines[0], /dialog alert/); assert.equal(result.stoppedAt, 1); assert.match(result.lines[1], /not reached/);
  assert.equal(f.actions.filter(a => a[0] === 'key').length, 1);
});

test('v3 refuses a non-finite scroll step as not run, and clamps a finite one past 10000 with a note', async () => {
  const f = fixture();
  for (const step of [{ do: 'scroll', ref: 'e1', dy: Infinity }, { do: 'scroll', dx: NaN }]) {
    await assert.rejects(f.run(f.tab, [step], {}), error => error.notRun === true && /finite dx and dy .*give until the row text/.test(error.message));
  }
  assert.deepEqual(f.actions, []);
  const result = await f.run(f.tab, [{ do: 'scroll', ref: 'e1', dy: 100000, dx: -20000 }], {});
  assert.deepEqual(f.actions.filter(a => a[0] === 'wheel'), [['wheel', -10000, 10000]]);
  assert.match(result.lines[0], /scrolled \(dx\/dy clamped to 10000\)/); assert.equal(result.stoppedAt, null);
  const plain = await f.run(f.tab, [{ do: 'scroll', dy: 300 }], {});
  assert.doesNotMatch(plain.lines[0], /clamped/);
});

test('v3 wait ends at quiet, including when its requested duration exceeds the cap', async () => {
  const f = fixture();
  const result = await f.run(f.tab, [{ do: 'wait', ms: 1500 }], {});
  assert.equal(f.time(), 150); assert.equal(f.actions.length, 0); assert.doesNotMatch(result.lines[0], /cap/);
  const long = fixture(), capped = await long.run(long.tab, [{ do: 'wait', ms: 60000 }], {});
  assert.equal(long.time(), 150); assert.doesNotMatch(capped.lines[0], /waited 5000/);
  await assert.rejects(fixture().run(fixture().tab, [{ do: 'wait', ms: -1 }], {}), /wait needs ms of 0 or more/);
  const ref = fixture(); await ref.run(ref.tab, [{ do: 'wait', ref: 'e1', ms: 9000 }], {});
  assert.deepEqual(ref.actions.map(a => a[0]), ['wait']); // a ref still waits for the element, not the clock
});

test('v3 navigate follows an http(s) link through the click path and refuses anything else before input', async () => {
  const f = fixture({ onClick: page => page.emit('framenavigated', page) });
  f.states.set('e1', { link: true });
  const result = await f.run(f.tab, [{ do: 'navigate', ref: 'e1' }], {});
  assert.deepEqual(f.actions.filter(a => a[0] === 'click').map(a => a[1]), ['e1']);
  assert.equal(f.checks[0].kind, 'click'); assert.match(result.lines[0], /^1 navigate e1: navigated/);
  const other = fixture(); other.states.set('e2', { link: false });
  const refused = await other.run(other.tab, [{ do: 'navigate', ref: 'e2' }], {});
  assert.match(refused.lines[0], /not run: navigate needs the ref of an http\(s\) link .*use click/);
  assert.deepEqual(other.actions, []); assert.deepEqual(other.checks, []);
  await assert.rejects(fixture().run(fixture().tab, [{ do: 'navigate' }], {}), /navigate needs the ref of an http\(s\) link/);
});

test('inspectTarget marks only an a or area with an http(s) href and no credentials as a link', () => {
  const node = (tag, href, base = 'https://example.invalid/dir/') => ({ localName: tag, getAttribute: key => key === 'href' ? href : null, textContent: '', form: null,
    ownerDocument: { baseURI: base }, closest: () => null, getRootNode: () => null });
  assert.equal(inspectTarget(node('a', '/next')).link, true);
  assert.equal(inspectTarget(node('area', 'https://x.invalid/')).link, true);
  for (const bad of [node('a', null), node('a', 'javascript:void(0)'), node('a', 'mailto:a@b.invalid'), node('a', 'https://u:p@x.invalid/'), node('button', '/next')]) assert.equal(inspectTarget(bad).link, false);
});

for (const [name, background, pageOpened, expected] of [
  ['an unmodified click and a tab the page opened', false, true, /probably took the foreground/],
  ['an unmodified click and a tab sleight opened', false, false, /opened background tab/],
  ['a click with the background modifier', true, true, /opened background tab/],
]) test(`AD1 backstop: the popup outcome for ${name}`, async () => {
  const f = fixture({ onClick: page => page.emit('popup', { url: () => 'https://example.invalid/popup', isClosed: () => false }) });
  f.tab.background = background; f.tab.pageOpened = () => pageOpened;
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], expected);
});

test('AD1 backstop: a popup counted at settle time is reported once, without a popup event', async () => {
  const f = fixture(); let counted = 1;
  f.tab.takeForeground = () => { const count = counted; counted = 0; return count; };
  const first = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(first.lines[0], /probably took the foreground/);
  const second = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.doesNotMatch(second.lines[0], /foreground/);
});

for (const [name, background, backgroundPopup, expected, notExpected] of [
  ['a modified click and a popup no settling classified as background (a script opened it later)', true, false, /probably took the foreground \(the page opened it after a click, outside the background handling/, /opened background tab/],
  ['a modified click and a popup its settling classified as background', true, true, /opened background tab/, /probably took the foreground/],
]) test(`AD1 pop4: the popup outcome for ${name}`, async () => {
  const f = fixture({ onClick: page => page.emit('popup', { url: () => 'https://example.invalid/popup', isClosed: () => false }) });
  f.tab.background = background; f.tab.pageOpened = () => true; f.tab.popupIsBackground = () => backgroundPopup;
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], expected);
  assert.doesNotMatch(result.lines[0], notExpected);
});

test('AD1 pop4: a popup counted late says why, and a modified click is not blamed for it', async () => {
  const f = fixture(); f.tab.background = true; f.tab.takeForeground = () => 1;
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /A tab the page opened probably took the foreground \(the page opened it after a click, outside the background handling\)/);
  assert.doesNotMatch(result.lines[0], /carried no background modifier|had no background modifier/);
});

test('AD1 pop4: tabs the page can raise are listed after a click or key press, and only then', async () => {
  const f = fixture(); f.tab.raisablePopups = async () => ['t7', 't9'];
  const clicked = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(clicked.lines[0], process.env.SLEIGHT_MT === '0' ? /Tabs t7, t9 \(opened by this page, another origin\) can be raised to the foreground by the page at any time, and sleight cannot block or detect that/ : /the page can bring t7, t9 forward on its own/);
  f.tab.raisablePopups = async () => ['t7'];
  const single = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(single.lines[0], process.env.SLEIGHT_MT === '0' ? /Tab t7 \(opened by this page, another origin\) can be raised/ : /the page can bring t7 forward on its own/);
  f.tab.raisablePopups = async () => [];
  const none = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.doesNotMatch(none.lines[0], /can be raised|the page can bring/);
  f.tab.raisablePopups = async () => { throw Error('closed'); };
  const failed = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.doesNotMatch(failed.lines[0], /can be raised|the page can bring/, 'a failed lookup adds nothing and breaks nothing');
});

test('v3 accepts a literal space and a literal newline as keys, and still rejects an empty or oversized key', async () => {
  const f = fixture();
  for (const key of [' ', '\n', '\r']) {
    const result = await f.run(f.tab, [{ do: 'press', ref: 'e1', key }], {});
    assert.equal(result.stoppedAt, null, JSON.stringify(key)); assert.ok(f.actions.some(a => a[0] === 'press' && a[2] === key), JSON.stringify(key));
  }
  for (const key of ['', 'a'.repeat(101), 1]) await assert.rejects(f.run(f.tab, [{ do: 'press', ref: 'e1', key }], {}), /needs key/);
});

test('v3 checks the page\'s site before every step\'s input, so a step that lands on a blocked site stops the rest', async () => {
  const LINE = 'You blocked sleight on https://blocked.example (sleight-mcp permissions unblock https://blocked.example lifts it).';
  const f = fixture({ onClick: page => { page.url = () => 'https://blocked.example/next'; } });
  const checked = [];
  const siteCheck = () => { const url = f.page.url(); checked.push(url); return url.startsWith('https://blocked.example') ? LINE : undefined; };
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'card number' }, { do: 'press', key: 'Enter' }], {}, { siteCheck });
  assert.deepEqual(f.actions.map(a => a[0]), ['click'], 'nothing is typed on the blocked page');
  assert.match(result.lines[1], /^2 type e2: not run: You blocked sleight on https:\/\/blocked\.example/);
  assert.equal(result.lines[2], '3 press: not reached');
  assert.deepEqual(checked, ['https://example.invalid/', 'https://blocked.example/next']);
});


import { withMT } from './fixtures/mt-env.mjs';
import { check as ruleCheck } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { fixture as ruleFixture } from './direct-browser-rules-fixture.mjs';
for (const mode of [undefined, '0']) test(`MTb message-free rule refusal stops input, switch=${mode}`, async () => withMT(mode, async () => {
  const f = fixture();
  const run = createActionRunner({ check: () => ({ verdict: 'refuse' }), snapshot: async () => ({ text: 'page', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'must not run' }], {});
  assert.equal(result.lines[0], '1 click e1: not run: rule check refused; read the page' + (mode === '0' ? ' or use the engine browser path' : ''));
  assert.deepEqual(f.actions, []); assert.match(result.lines[1], /not reached/);
}));
for (const mode of [undefined, '0']) test(`MT1 popup ownership and foreground disclosure, switch=${mode}`, async () => withMT(mode, async () => {
  const popup = { url: () => 'https://other.invalid/private', isClosed: () => false };
  const f = fixture({ onClick(page) { f.tab.popups.push({ tab: 'tchild' }); page.emit('popup', popup); } });
  Object.assign(f.tab, { tab: 'tparent', background: true, popups: [], popupIsBackground: () => true, raisablePopups: async () => ['tchild'] });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'never sent' }], {});
  assert.equal(result.lines[0], mode === '0'
    ? '1 click e1: opened background tab tchild at https://other.invalid (opener tparent). Tab tchild (opened by this page, another origin) can be raised to the foreground by the page at any time, and sleight cannot block or detect that'
    : '1 click e1: opened background tab tchild at https://other.invalid (opener tparent); the page can bring it forward on its own');
  assert.equal(f.actions.length, 1); assert.equal(result.stoppedAt, 1); assert.match(result.lines[1], /not reached/);
}));
for (const mode of [undefined, '0']) test(`MT2 confirmation still refuses every input, switch=${mode}`, async () => withMT(mode, async () => {
  const f = fixture(), payment = ruleFixture();
  const run = createActionRunner({ check: () => ruleCheck(payment.ctx, 'click', payment.pay()),
    snapshot: async () => ({ text: 'page', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'must not run' }], {});
  assert.equal(result.lines[0], '1 click e1: not run: confirmation required through the trusted consent UI' + (mode === '0' ? '; use the engine browser path if needed' : ''));
  assert.equal(result.stoppedAt, 1); assert.match(result.lines[1], /not reached/); assert.deepEqual(f.actions, []);
  const refused = ruleCheck(payment.ctx, 'Target.activateTarget', payment.target());
  assert.deepEqual(refused, { verdict: 'refuse', message: 'Background-only operation required.' + (mode === '0' ? ' Use the engine browser path if needed.' : '') });
}));

for (const [src, expected] of [
  // Default path (sleight-arch, fd2f review): any frame in a form may hold hosted payment fields.
  ['/help', true], ['https://example.invalid/help', true], ['https://js.stripe.com/frame', true],
  ['https://www.paypal.com/frame', true], ['https://stripe.com.evil.invalid/frame', true], ['https://evilstripe.com/frame', true],
]) test('iframe in a form marks it a payment form: ' + src, () => {
  const frame = { localName: 'iframe', ownerDocument: { baseURI: 'https://shop.invalid/' }, getAttribute: key => key === 'src' ? src : null };
  const form = { textContent: '', getAttribute: () => null, querySelectorAll: selector => selector === 'input,button,iframe' ? [frame] : [] };
  const node = { localName: 'input', type: 'text', textContent: '', form, getAttribute: () => null, getRootNode: () => null, closest: () => null };
  assert.equal(inspectTarget(node).formPayment, expected);
});
