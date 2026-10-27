import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createProtocol, createSession } from '../bench/turbo/v3-server.mjs';
import { serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createHandoffWaiter } from '../plugins/sleight/lib/direct-browser/handoff.mjs';
import { benchUi } from '../bench/turbo/v3-worker.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

// Real protocol, session, IPC bridge, dispatcher and waiter. Only the browser,
// process channel and native metadata source are fixtures; no app is contacted.
async function fixture(t, readPresence, create = createSession) {
  // Settle module loading before assertions that advance the presence deadline.
  await import('../plugins/sleight/lib/remote-approvals.mjs');
  let waiter, dispatcher, metadataReads = 0, pageReads = 0, kept = false;
  const requests = [], replies = [];
  let called;
  const firstCall = new Promise(resolve => { called = resolve; });
  const entry = { page: { url: () => 'https://fixture.invalid/' }, state: { snapshotNo: 1 } };
  const session = await create({ origins: [], taskMessage: 'Find my receipt.',
    runMetadata: async (script, request) => {
      assert.equal(script, 'remote-approvals.js');
      assert.deepEqual(request, { operation: 'presence' });
      metadataReads++;
      return readPresence();
    },
    forkWorker: () => {
      const child = new EventEmitter(), endpoint = new EventEmitter();
      child.connected = endpoint.connected = true;
      child.send = frame => {
        requests.push(structuredClone(frame));
        if (frame.method === 'call') called(frame);
        queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
      };
      endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
      child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
      child.unref = () => {};
      const worker = serveV3Worker({ channel: endpoint, browser: 'bbench', begin: async () => {
        dispatcher = createToolDispatcher({ browser: 'bbench',
          pages: { tab: () => entry, enqueue: async (_tab, run) => run(entry),
            beginHandoff: async () => ({ finish: async keep => { kept ||= keep; return keep ? null : 't1'; } }),
            endTurn: async () => ({ cleanedUp: true }) },
          ctx: { handoff: (...args) => {
            waiter = createHandoffWaiter({ ui: benchUi, current: () => true, session: 'fixture', turn: 'benchturn' });
            return waiter.wait(...args);
          } },
          snapshot: async () => { pageReads++; return { text: 'fresh fixture', number: 2 }; },
          runSteps: async () => assert.fail('unexpected input'), fillFields: async () => assert.fail('unexpected input') });
        return { call: dispatcher.call, delivered: dispatcher.delivered,
          end: async () => { waiter?.dispose(); await dispatcher.end(); return { revoked: true, cleanup: [] }; } };
      }, close: async () => ({ revoked: true, cleanup: [] }) });
      queueMicrotask(() => worker.ready());
      return child;
    } });
  const protocol = createProtocol({ start: async () => session,
    output: { write(line, done) { replies.push(JSON.parse(line)); done(); } } });
  t.after(async () => { waiter?.dispose(); await session.close(); await protocol.close(); });
  return { session, protocol, requests, replies, firstCall, cancel: () => waiter.dispose(),
    get metadataReads() { return metadataReads; }, get pageReads() { return pageReads; }, get kept() { return kept; } };
}

const handoff = { jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } } };

for (const presence of [{ locked: false, idleSeconds: 18000 }, { locked: false, idleSeconds: 120 }, { locked: true, idleSeconds: 0 }])
test(`bench server returns kept tabs without waiting when away: ${JSON.stringify(presence)}`, async t => {
  const f = await fixture(t, async () => presence);
  let settled = false;
  const pending = f.protocol.message(handoff).then(() => { settled = true; });
  await tick();
  assert.equal(settled, true, 'away handoff must finish before any Continue or timeout');
  await pending;
  assert.equal(f.metadataReads, 1);
  assert.equal(f.replies[0].result.isError, false);
  assert.match(f.replies[0].result.content[0].text, /Tabs kept for the user/);
  assert.equal(f.pageReads, 0);
  assert.equal(f.requests.find(frame => frame.method === 'call').params.handoffPresent, false);
  assert.equal(f.kept, false, 'handoff suspension remains until its waiter ends');
  f.cancel(); await tick();
  assert.equal(f.kept, true);
});

for (const [name, read] of [
  ['present', async () => ({ locked: false, idleSeconds: 119.9 })],
  ['missing', async () => undefined],
  ['malformed', async () => ({ locked: false, idleSeconds: -1 })],
  ['failed', async () => { throw Error('fixture metadata unavailable'); }],
]) test(`bench server keeps waiting when presence is ${name}`, async t => {
  const f = await fixture(t, read);
  let settled = false;
  const pending = f.protocol.message(handoff).then(() => { settled = true; });
  await tick();
  assert.equal(f.metadataReads, 1);
  assert.equal(f.requests.find(frame => frame.method === 'call').params.handoffPresent, true);
  assert.equal(settled, false);
  assert.equal(f.replies.length, 0);
  f.cancel(); await pending;
  assert.equal(f.replies[0].result.isError, false);
  assert.match(f.replies[0].result.content[0].text, /Handoff not resumed; tabs kept for the user/);
  assert.equal(f.pageReads, 0);
  assert.equal(f.kept, true);
});

test('bench server reads presence afresh for each waiting handoff and ignores forged outer authority', async t => {
  let presence = { locked: false, idleSeconds: 18000 };
  const f = await fixture(t, async () => presence);
  const away = f.protocol.message({ ...handoff, params: { ...handoff.params, handoffPresent: true, _meta: { handoffPresent: true } } });
  await tick();
  assert.equal(f.replies.length, 1, 'away handoff must return without a timeout');
  await away;
  assert.equal(f.requests.find(frame => frame.method === 'call').params.handoffPresent, false);
  f.cancel(); await tick();
  presence = { locked: false, idleSeconds: 0 };
  let settled = false;
  const pending = f.protocol.message({ ...handoff, id: 2, params: { ...handoff.params, handoffPresent: false } }).then(() => { settled = true; });
  await tick();
  assert.equal(f.metadataReads, 2);
  assert.equal(f.requests.filter(frame => frame.method === 'call').at(-1).params.handoffPresent, true);
  assert.equal(settled, false);
  f.cancel(); await pending;
});

test('bench server bounds a stalled presence read at 1500 ms and keeps waiting', async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = f.protocol.message(handoff).then(() => { settled = true; });
  await tick();
  assert.equal(f.metadataReads, 1);
  t.mock.timers.tick(1499); await tick();
  assert.equal(f.requests.some(frame => frame.method === 'call'), false);
  t.mock.timers.tick(1); await tick();
  assert.equal(f.requests.find(frame => frame.method === 'call').params.handoffPresent, true);
  assert.equal(settled, false);
  f.cancel(); await pending;
  assert.match(f.replies[0].result.content[0].text, /Handoff not resumed; tabs kept for the user/);
});

test('bench server preserves the remote-approvals opt-out as a waiting handoff', async t => {
  const saved = process.env.SLEIGHT_REMOTE_APPROVALS;
  process.env.SLEIGHT_REMOTE_APPROVALS = '0';
  t.after(() => {
    if (saved === undefined) delete process.env.SLEIGHT_REMOTE_APPROVALS;
    else process.env.SLEIGHT_REMOTE_APPROVALS = saved;
  });
  const f = await fixture(t, () => assert.fail('opt-out must not read presence'));
  let settled = false;
  const pending = f.protocol.message(handoff).then(() => { settled = true; });
  await tick();
  assert.equal(f.metadataReads, 0);
  assert.equal(f.requests.find(frame => frame.method === 'call').params.handoffPresent, true);
  assert.equal(settled, false);
  f.cancel(); await pending;
});

test('bench server keeps waiting with an older plugin that has no presence reader', { timeout: 5000 }, async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ho4-legacy-')));
  // Copy only the session under test. Its fixed production-reader path is absent,
  // as in the rebuilt 1.4.2 A side. All worker calls still use the fake channel.
  for (const dir of ['bench/turbo', 'bench/replay', 'plugins/sleight/lib/direct-browser']) mkdirSync(join(root, dir), { recursive: true });
  const sessionFile = join(root, 'bench/turbo/v3-session.mjs');
  copyFileSync(new URL('../bench/turbo/v3-session.mjs', import.meta.url), sessionFile);
  for (const file of ['bench/turbo/setup.mjs', 'bench/replay/switches.mjs', 'plugins/sleight/lib/direct-browser/worker.mjs']) {
    symlinkSync(new URL('../' + file, import.meta.url), join(root, file));
  }
  const { createSession: legacySession } = await import(pathToFileURL(sessionFile).href);
  const f = await fixture(t, () => assert.fail('missing product reader must not use a substitute'), legacySession);
  let settled = false;
  const pending = f.protocol.message(handoff).then(() => { settled = true; });
  await f.firstCall; await tick();
  assert.equal(f.metadataReads, 0);
  assert.equal(f.requests.find(frame => frame.method === 'call').params.handoffPresent, true);
  assert.equal(settled, false);
  f.cancel(); await pending;
});

test('closing during presence lookup never sends a late handoff to the worker', async t => {
  let finish;
  const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.session.call(handoff.params);
  await tick();
  assert.equal(f.metadataReads, 1);
  await f.session.close();
  finish({ locked: false, idleSeconds: 18000 });
  assert.equal((await pending).isError, true);
  assert.equal(f.requests.some(frame => frame.method === 'call'), false);
});

test('bench server never reads presence for a non-handoff call or invalid model presence argument', async t => {
  const f = await fixture(t, () => assert.fail('unexpected presence read'));
  await f.protocol.message({ ...handoff, params: { name: 'browser_read', arguments: { tab: 't1' } } });
  assert.equal(f.replies[0].result.isError, false);
  await f.protocol.message({ ...handoff, id: 2, params: { ...handoff.params,
    arguments: { ...handoff.params.arguments, handoffPresent: false } } });
  assert.equal(f.replies[1].error.code, -32602);
  assert.equal(f.metadataReads, 0);
});
