import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandoffWaiter } from '../plugins/sleight/lib/direct-browser/handoff.mjs';
import { validateToolCall, createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function uiFixture() {
  const cards = [], events = new WeakSet();
  return { cards, ui: { authenticate: event => events.delete(event),
    present(id, data, choices, deliver, options) { cards.push({ id, data, choices, deliver, options }); } },
  answer(choice, trusted = true) { const card = cards.at(-1), event = { id: card.id, choice }; if (trusted) events.add(event); card.deliver(event); } };
}

test('native handoff card uses guarded Continue and fixed instructions outside page content', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.match(source, /\["action", "debugger", "relaunch", "opt-in", "resume", "turbo-off", "handoff"\]/);
  assert.match(source, /"continue": "Continue"/);
  assert.match(source, /func handoffFrame\(/);
  assert.match(source, /Finish signing in or entering your code in tab /);
  assert.match(source, /Only click Continue after the secret fields are gone/);
  assert.match(source, /else if data\["kind"\] as\? String == "handoff"/);
  assert.match(source, /if let handoff = handoffFrame\(data, choices\)/);
});

test('waiting handoff takes no authority or secret from tool arguments', () => {
  const call = arguments_ => validateToolCall({ name: 'browser_tabs', arguments: arguments_ });
  assert.doesNotThrow(() => call({ do: 'handoff', tab: 't1', wait: true }));
  for (const args of [{ do: 'keep', tab: 't1', wait: true }, { do: 'list', wait: false },
    { do: 'handoff', tab: 't1', wait: true, signedIn: true }, { do: 'handoff', tab: 't1', wait: true, password: 'secret' }]) {
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

function dispatcherFixture() {
  let resume, paused = false, released = false, reads = 0, actions = 0;
  const entry = { page: { url: () => 'https://fixture.invalid/' }, state: { snapshotNo: 1 } };
  const pages = { tab: () => entry, enqueue: async (_id, run) => { assert.equal(paused, false); return run(entry); },
    async beginHandoff() { paused = true; return { async finish(keep) { paused = false; released = keep; return keep ? null : 't1'; } }; },
    async endTurn() { return { cleanedUp: true }; } };
  const dispatcher = createToolDispatcher({ pages, ctx: { handoff: () => new Promise(resolve => { resume = resolve; }) },
    snapshot: async () => { reads++; return { text: '# fresh untrusted snapshot', number: 2 }; },
    runSteps: async () => { actions++; return { lines: [] }; }, fillFields: async () => assert.fail('unexpected fill') });
  return { dispatcher, resume: value => resume(value), get reads() { return reads; }, get actions() { return actions; }, get released() { return released; } };
}

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
