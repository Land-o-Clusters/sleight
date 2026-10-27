import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandoffWaiter } from '../plugins/sleight/lib/direct-browser/handoff.mjs';
import { validateToolCall, createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { isPresent } from '../plugins/sleight/lib/remote-approvals.mjs';

function uiFixture() {
  const cards = [], dismissed = [], events = new WeakSet();
  return { cards, dismissed, ui: { authenticate: event => events.delete(event), dismiss: id => dismissed.push(id),
    present(id, data, choices, deliver, options) { cards.push({ id, data, choices, deliver, options }); } },
  answer(choice, trusted = true) { const card = cards.at(-1), event = { id: card.id, choice }; if (trusted) events.add(event); card.deliver(event); } };
}

test('native handoff card uses guarded Continue and fixed instructions outside page content', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.match(source, /\["action", "debugger", "relaunch", "opt-in", "resume", "turbo-off", "handoff"\]/);
  assert.match(source, /"continue": "Continue"/);
  assert.match(source, /func handoffFrame\(/);
  assert.match(source, /Finish signing in or entering your code in /);
  assert.match(source, /override var canBecomeMain: Bool \{ false \}/);
  assert.match(source, /Confirm Continue only after the secret fields are gone/);
  assert.match(source, /else if data\["kind"\] as\? String == "handoff"/);
  assert.match(source, /if let handoff = handoffFrame\(data, choices\)/);
});

test('premature Continue re-presents through the same deadline and dismisses ended cards', async () => {
  const f = uiFixture(); let ready = false;
  const waiter = createHandoffWaiter({ ui: f.ui, current: () => true, session: 's', turn: 't', timeoutMs: 1000 });
  const pending = waiter.wait('t1', async () => ready);
  const first = f.cards[0];
  f.answer('continue');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cards.length, 2);
  assert.equal(f.cards[1].options.deadline, first.options.deadline);
  assert.deepEqual(f.dismissed, [first.id]);
  ready = true; f.answer('continue');
  assert.equal(await pending, true);
  assert.deepEqual(f.dismissed, f.cards.map(card => card.id));
});

test('expiry during a Continue check dismisses the card and cannot grant a late resume', async () => {
  const f = uiFixture(); let complete;
  const waiter = createHandoffWaiter({ ui: f.ui, current: () => true, session: 's', turn: 't', timeoutMs: 15 });
  const pending = waiter.wait('t1', () => new Promise(resolve => { complete = resolve; }));
  f.answer('continue');
  assert.equal(await pending, false);
  complete(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cards.length, 1);
  assert.deepEqual(f.dismissed, [f.cards[0].id]);
});

test('null readiness ends the handoff immediately while false readiness remains retryable', async () => {
  const f = uiFixture();
  const waiter = createHandoffWaiter({ ui: f.ui, current: () => true, session: 's', turn: 't', timeoutMs: 1000 });
  const pending = waiter.wait('t1', async () => null);
  f.answer('continue');
  let result = 'pending'; pending.then(value => { result = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result, false);
  assert.equal(f.cards.length, 1);
  assert.deepEqual(f.dismissed, [f.cards[0].id]);
  waiter.dispose();
});

test('waiting handoff takes no authority or secret from tool arguments', () => {
  const call = arguments_ => validateToolCall({ name: 'browser_tabs', arguments: arguments_ });
  assert.doesNotThrow(() => call({ do: 'handoff', tab: 't1', wait: true }));
  for (const args of [{ do: 'keep', tab: 't1', wait: true }, { do: 'list', wait: false },
    { do: 'handoff', tab: 't1', wait: true, signedIn: true }, { do: 'handoff', tab: 't1', wait: true, password: 'secret' },
    { do: 'handoff', tab: 't1', wait: true, handoffPresent: false }]) {
    assert.throws(() => call(args));
  }
});

test('only an authenticated Continue for this card resumes, once', async () => {
  const f = uiFixture(); let current = true;
  const waiter = createHandoffWaiter({ ui: f.ui, current: () => current, session: 'session', turn: 'turn' });
  const pending = waiter.wait('t1');
  assert.deepEqual(f.cards[0].choices, ['continue', 'cancel']);
  assert.deepEqual(f.cards[0].data, { kind: 'handoff', session: 'session', turn: 'turn', tab: 't1' });
  f.answer('continue', false);
  let settled = false; pending.then(() => settled = true);
  await Promise.resolve(); assert.equal(settled, false);
  f.answer('continue'); assert.equal(await pending, true);
  current = false; assert.equal(await waiter.wait('t1'), false);
});

test('cancel, expiry and turn end return without granting a resume', async () => {
  for (const mode of ['cancel', 'expiry', 'end']) {
    const f = uiFixture(), waiter = createHandoffWaiter({ ui: f.ui, current: () => true, session: 's', turn: 't', timeoutMs: 10 });
    const pending = waiter.wait('t1');
    if (mode === 'cancel') f.answer('cancel');
    if (mode === 'end') waiter.dispose();
    assert.equal(await pending, false, mode);
    f.answer('continue');
  }
});

test('missing host and host presentation failure never resume', async () => {
  for (const ui of [undefined, {}, { present() { throw Error('private host detail'); }, authenticate: () => true }]) {
    const waiter = createHandoffWaiter({ ui, current: () => true, session: 's', turn: 't' });
    assert.equal(await waiter.wait('t1'), false);
  }
});

function dispatcherFixture({ presence, realWaiter = false, host = 'ok' } = {}) {
  let resume, paused = false, released = false, reads = 0, actions = 0, ready = true;
  const ui = uiFixture();
  const hostUi = host === 'missing' ? undefined : host === 'throws'
    ? { ...ui.ui, present() { throw Error('private host detail'); } } : ui.ui;
  const waiter = createHandoffWaiter({ ui: hostUi, current: () => true, session: 's', turn: 't' });
  const entry = { page: { url: () => 'https://fixture.invalid/' }, state: { snapshotNo: 1 } };
  const pages = { tab: () => entry, enqueue: async (_id, run) => { assert.equal(paused, false); return run(entry); },
    async beginHandoff() { paused = true; return { async finish(keep) { if (!keep && !ready) return false; paused = false; released = keep; return keep ? null : 't1'; } }; },
    async endTurn() { return { cleanedUp: true }; } };
  const dispatcher = createToolDispatcher({ pages, ctx: { handoff: (...args) => realWaiter ? waiter.wait(...args) : new Promise(resolve => { resume = resolve; }) },
    snapshot: async () => { reads++; return { text: '# fresh untrusted snapshot', number: 2 }; },
    runSteps: async () => { actions++; return { lines: [] }; }, fillFields: async () => assert.fail('unexpected fill') });
  return { dispatcher, ui, waiter, setReady: value => { ready = value; },
    call: input => dispatcher.call(input, { handoffPresent: isPresent(presence) }),
    resume: value => realWaiter ? ui.answer(value ? 'continue' : 'cancel') : resume(value),
    get reads() { return reads; }, get actions() { return actions; }, get released() { return released; } };
}

for (const presence of [{ locked: true, idleSeconds: 0 }, { locked: false, idleSeconds: 120 }])
test(`away browser handoff returns before Continue and keeps the suspension (locked=${presence.locked})`, async t => {
  const f = dispatcherFixture({ presence, realWaiter: true });
  t.after(() => { f.waiter.dispose(); return f.dispatcher.end(); });
  let result;
  f.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } }).then(value => { result = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(result, 'away handoff must return without waiting for the person');
  assert.equal(result.isError, false);
  assert.match(result.text, /kept for the user/);
  assert.match(result.text, /card.*turn ends/i);
  assert.match(result.text, /end.*turn/i);
  assert.match(result.text, /reply/i);
  assert.doesNotMatch(result.text, /click Continue/i);
  assert.equal(f.reads, 0);
  assert.equal(f.ui.cards.length, 1);
  assert.equal(f.ui.dismissed.length, 0);
  f.ui.answer('continue', false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ui.dismissed.length, 0);
  const blocked = await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(blocked.isError, true);
  f.resume(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads, 0, 'a late Continue must not create an unsolicited snapshot');
  const fresh = await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(fresh.isError, false, fresh.text);
  assert.equal(f.reads, 1);
});

for (const host of ['missing', 'throws']) test(`away browser handoff with ${host} host reports nothing waiting`, async t => {
  const f = dispatcherFixture({ presence: { locked: true, idleSeconds: 0 }, realWaiter: true, host });
  t.after(() => { f.waiter.dispose(); return f.dispatcher.end(); });
  const result = await f.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } });
  assert.match(result.text, /not resumed/i);
  assert.match(result.text, /nothing is waiting/i);
  assert.match(result.text, /sign-in.*Mac/i);
  assert.doesNotMatch(result.text, /Continue|card|private host detail/);
  assert.equal(f.released, true);
  assert.equal(f.reads, 0);
  assert.equal((await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } })).isError, false);
});

test('ending the dispatcher after an away result dismisses the card and ignores late Continue', async () => {
  const f = dispatcherFixture({ presence: { locked: true, idleSeconds: 0 }, realWaiter: true });
  try {
    await f.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } });
    await f.dispatcher.end();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.ui.dismissed, [f.ui.cards[0].id]);
    assert.equal(f.released, true);
    f.ui.answer('continue');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.released, true);
    assert.equal(f.reads, 0);
    assert.equal((await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } })).isError, true);
  } finally { f.waiter.dispose(); await f.dispatcher.end(); }
});

test('away browser handoff keeps waiting after a premature Continue and preserves tabs on Cancel', async t => {
  const f = dispatcherFixture({ presence: { locked: true, idleSeconds: 0 }, realWaiter: true });
  t.after(() => { f.waiter.dispose(); return f.dispatcher.end(); });
  f.setReady(false);
  const result = await f.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } });
  assert.equal(result.isError, false);
  f.ui.answer('continue'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ui.cards.length, 2);
  assert.equal(f.reads, 0);
  assert.equal((await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } })).isError, true);
  f.ui.answer('cancel'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.released, true);
  assert.equal(f.reads, 0);
});

test('the attended handoff wait expires at four minutes and never resumes on a late Continue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = uiFixture(), waiter = createHandoffWaiter({ ui: f.ui, current: () => true, session: 's', turn: 't' });
  let resumed;
  waiter.wait('t1').then(value => { resumed = value; });
  t.mock.timers.tick(239999); await Promise.resolve();
  assert.equal(resumed, undefined);
  t.mock.timers.tick(1); await Promise.resolve();
  assert.equal(resumed, false);
  f.answer('continue'); await Promise.resolve();
  assert.equal(resumed, false);
});

test('waiting handoff blocks concurrent reads and input, then returns a fresh read', async () => {
  const f = dispatcherFixture();
  const pending = f.dispatcher.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } });
  await new Promise(resolve => setImmediate(resolve));
  for (const name of ['browser_read', 'browser_act']) {
    const result = await f.dispatcher.call({ name, arguments: { tab: 't1', ...(name === 'browser_act' ? { steps: [{ do: 'click', ref: 'e1' }] } : {}) } });
    assert.equal(result.isError, true); assert.match(result.text, /handoff.*pending/i);
  }
  assert.equal(f.reads, 0); assert.equal(f.actions, 0);
  f.resume(true); const result = await pending;
  assert.equal(result.isError, false, result.text); assert.match(result.text, /fresh untrusted snapshot/);
  assert.equal(f.reads, 1); assert.equal(f.dispatcher.delivered(result), true);
});

test('cancelled handoff keeps the user tab and returns no page content', async () => {
  const f = dispatcherFixture();
  const pending = f.dispatcher.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } });
  await new Promise(resolve => setImmediate(resolve)); f.resume(false);
  const result = await pending;
  assert.equal(f.released, true); assert.equal(f.reads, 0); assert.match(result.text, /not resumed/i);
});
