import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { callLocalTool, openDocument } from './fixtures/local-tools.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createHandoffWaiter, handoffMessages } from '../plugins/sleight/lib/direct-browser/handoff.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const calls = [
  ['hover', { app: 'Google Chrome', at: [1, 2] }],
  ['drag', { app: 'Google Chrome', from: [1, 2], to: [3, 4] }],
  ['select_window', { app: 'Google Chrome', title: 'Sign in' }],
  ['menu_bar', { app: 'Google Chrome', op: 'press', item: 0 }],
  ['notifications', { op: 'list' }],
  ['notifications', { op: 'press', banner: 0, button: 'Close' }],
];

async function harness(t, name, args, { fast = false, afterApproval = false, runLocal } = {}) {
  const approval = deferred(), presence = deferred(), handoffPresence = deferred(), target = deferred(), cards = [], dismissed = [], actions = [];
  let asked = 0, presenceReads = 0, releaseHandoff;
  const child = new EventEmitter(), channel = new EventEmitter();
  child.connected = channel.connected = true;
  child.send = value => queueMicrotask(() => channel.emit('message', structuredClone(value)));
  channel.send = value => queueMicrotask(() => child.emit('message', structuredClone(value)));
  child.disconnect = () => { child.connected = channel.connected = false; channel.emit('disconnect'); child.emit('disconnect'); };
  const waiter = createHandoffWaiter({ current: () => true, session: 's', turn: 't', timeoutMs: 30000,
    ui: { authenticate: () => false, dismiss: id => dismissed.push(id), present: id => cards.push(id) } });
  const dispatcher = createToolDispatcher({ pages: {
    async beginHandoff() { return { async finish() { return null; } }; }, async endTurn() { return { cleanedUp: true }; }
  }, ctx: { handoff: (...input) => waiter.wait(...input) }, snapshot: () => assert.fail('no page read'), runSteps() {}, fillFields() {} });
  const session = serveV3Worker({ channel, browser: 'bfixture', begin: async () => ({
    call: (request, options) => dispatcher.call(request, options), end: () => dispatcher.end()
  }) });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }), shareConsent: () => undefined,
    forkWorker() { queueMicrotask(() => session.ready()); return child; } });
  const streams = Array.from({ length: 4 }, () => new PassThrough()), replies = [];
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, openFast: fast,
    ask: () => { asked++; return approval.promise; },
    remoteApprovals: { presence: () => ++presenceReads === 1 ? presence.promise : handoffPresence.promise },
    directBrowser: createV3Frontend(bridge),
    localTools: { tools: [{ name, inputSchema: { type: 'object' } }], target: () => fast ? target.promise : { appId: 'com.google.Chrome', app: 'Google Chrome' },
      prepareOpen: (_args, approve) => ({ approval: approve(['open_file', args.app], 'Allow?'),
        bundleId: Promise.resolve('com.google.Chrome'), exec: async () => actions.push('open'), hasDocument: async () => false }),
      call: (tool, input, approve, _run, resolved, prepared, options) => callLocalTool(tool, input,
        async (...approvalArgs) => {
          const allowed = await approve(...approvalArgs);
          // This microtask is after the relay's approval check and before the
          // launcher's await resumes. It reproduces the last execution gap.
          if (afterApproval) releaseHandoff();
          return allowed;
        }, async (script, input, options) => { actions.push(script); return runLocal ? runLocal(script, input, options)
          : { ok: true, path: 'background', target: { appId: 'com.google.Chrome', title: 'Sign in' } }; },
        resolved, prepared, options) }
  });
  t.after(async () => { approval.resolve('cancel'); presence.resolve({ locked: true }); handoffPresence.resolve({ locked: true }); target.resolve(undefined);
    waiter.dispose(); relay.dispose(); await bridge.detach(); for (const stream of streams) stream.destroy(); });
  await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'race-turn', text: 'Find the receipt.' });
  const send = (id, tool, input) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: tool, arguments: input } }) + '\n');
  releaseHandoff = () => send('handoff', 'browser_tabs', { do: 'handoff', tab: 't1', wait: true });
  return { approval, presence, handoffPresence, target, cards, dismissed, actions, replies, bridge,
    asked: () => asked, local: (id = 'local') => send(id, name, args), handoff: releaseHandoff,
    async reply(id) {
      for (let i = 0; i < 50 && !replies.some(row => row.id === id); i++) await tick();
      const reply = replies.find(row => row.id === id); assert.ok(reply, id); return reply.result;
    } };
}

for (const [name, args] of calls) for (const timing of ['just-before', 'during-presence', 'after-card'])
test(`${name} ${args.op ?? ''} approval ${timing} handoff begin cannot execute`, async t => {
  const h = await harness(t, name, args, { afterApproval: timing === 'just-before' });
  h.local(); await tick();
  assert.equal(h.asked(), 0, 'approval first waits for presence');
  // Keep the approval attended, then gate the handoff presence separately.
  h.presence.resolve({ locked: false, idleSeconds: 0 }); await tick();
  assert.equal(h.asked(), 1);
  if (timing !== 'just-before') {
    h.handoff();
    if (timing === 'after-card') {
      h.handoffPresence.resolve({ locked: false, idleSeconds: 0 });
      for (let i = 0; i < 30 && !h.cards.length; i++) await tick();
      assert.equal(h.cards.length, 1); assert.equal(h.bridge.handoffPending(), true);
    }
  }
  h.approval.resolve('accept');
  const reply = await h.reply('local');
  assert.equal(reply.isError, true); assert.equal(reply.content[0].text, handoffMessages.pending);
  assert.deepEqual(h.actions, []);
});

for (const timing of ['before-probe', 'during-probe'])
test(`open_file rechecks handoff ${timing} before opening anything`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ho6-open-')), path = join(dir, 'fixture.html'), actions = [];
  t.after(() => rmSync(dir, { recursive: true, force: true })); writeFileSync(path, '<p>fixture</p>');
  let pending = false;
  const opened = openDocument({ app: 'Google Chrome', path }, { fast: true, resolve: async () => 'com.google.Chrome',
    current() {
      if (pending) throw Error(handoffMessages.pending);
      if (timing === 'before-probe') queueMicrotask(() => { pending = true; });
    },
    hasDocument: async () => { actions.push('probe'); pending = true; return false; },
    exec: async () => actions.push('open') });
  await assert.rejects(opened, { message: handoffMessages.pending });
  assert.deepEqual(actions, timing === 'before-probe' ? [] : ['probe']);
});

test('handoff between drag capture and input refuses the drag without releasing or restoring focus', async () => {
  let pending = false;
  const actions = [];
  const reply = await callLocalTool('drag', { app: 'Google Chrome', from: [1, 2], to: [3, 4] }, async () => true,
    async (script, args, options) => {
      assert.equal(script, 'drag-focus.js'); actions.push(args.op);
      if (args.op === 'capture') { pending = true; return { ok: true }; }
      assert.equal(options.cleanup, true); return { ok: true, released: true };
    }, undefined, undefined, { current() { if (pending) throw Error(handoffMessages.pending); } });
  assert.equal(reply.isError, true); assert.match(reply.content[0].text, /Handoff pending/);
  assert.deepEqual(actions, ['capture']);
});

test('handoff after drag input starts keeps release and focus restoration on unknown termination', async () => {
  let pending = false;
  const actions = [];
  const reply = await callLocalTool('drag', { app: 'Google Chrome', from: [1, 2], to: [3, 4] }, async () => true,
    async (script, args, options) => {
      actions.push(script === 'drag.js' ? script : args.op);
      if (script === 'drag.js') { pending = true; throw Error('drag timed out'); }
      if (args.op !== 'capture') assert.equal(options.cleanup, true);
      return { ok: true, released: args.op === 'release' };
    }, undefined, undefined, { current() { if (pending) throw Error(handoffMessages.pending); } });
  assert.equal(reply.isError, true); assert.match(reply.content[0].text, /drag timed out/);
  assert.deepEqual(actions, ['capture', 'drag.js', 'release', 'restore']);
});

test('hover already running when handoff begins returns its real result and screenshot once', async t => {
  const started = deferred(), completed = deferred();
  t.after(() => completed.resolve());
  const h = await harness(t, 'hover', { app: 'Google Chrome', at: [1, 2] }, { runLocal: async script => {
    assert.equal(script, 'hover.js'); started.resolve(); await completed.promise;
    return { ok: true, hovered: [1, 2], image: 'fixture-image' };
  } });
  h.local(); h.presence.resolve({ locked: false, idleSeconds: 0 }); await tick(); h.approval.resolve('accept');
  await started.promise;
  h.handoff(); h.handoffPresence.resolve({ locked: false, idleSeconds: 0 });
  for (let i = 0; i < 30 && !h.bridge.handoffPending(); i++) await tick();
  assert.equal(h.bridge.handoffPending(), true);
  completed.resolve();
  const reply = await h.reply('local');
  assert.notEqual(reply.isError, true);
  assert.deepEqual(JSON.parse(reply.content[0].text), { hovered: [1, 2] });
  assert.deepEqual(reply.content[1], { type: 'image', data: 'fixture-image', mimeType: 'image/png' });
  assert.deepEqual(h.actions, ['hover.js']);
});

test('fast open approval before handoff cannot pass a target lookup that finishes during the handoff', async t => {
  const h = await harness(t, 'open_file', { app: 'Google Chrome', path: '/tmp/fixture.html' }, { fast: true });
  h.local(); h.presence.resolve({ locked: false, idleSeconds: 0 }); await tick();
  h.approval.resolve('accept'); await tick();
  h.handoff(); await tick();
  h.target.resolve({ appId: 'com.google.Chrome', app: 'Google Chrome' });
  const reply = await h.reply('local');
  assert.equal(reply.isError, true); assert.equal(reply.content[0].text, handoffMessages.pending);
  assert.deepEqual(h.actions, []);
});

test('a local call completed before handoff remains valid and new calls are refused while the card waits', async t => {
  const h = await harness(t, 'hover', { app: 'Google Chrome', at: [1, 2] });
  h.local(); h.presence.resolve({ locked: false, idleSeconds: 0 }); await tick(); h.approval.resolve('accept');
  assert.notEqual((await h.reply('local')).isError, true); assert.deepEqual(h.actions, ['hover.js']);
  h.handoff(); h.handoffPresence.resolve({ locked: false, idleSeconds: 0 });
  for (let i = 0; i < 30 && !h.cards.length; i++) await tick();
  assert.equal(h.cards.length, 1); assert.equal(h.bridge.handoffPending(), true);
  h.local('during-card');
  const refused = await h.reply('during-card');
  assert.equal(refused.isError, true); assert.equal(refused.content[0].text, handoffMessages.pending);
  assert.deepEqual(h.actions, ['hover.js']);
});
