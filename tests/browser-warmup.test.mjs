import { fixtureDocumentation } from './helpers/canonical-docs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { replSetupCode, browserWarmupUseCode } from '../plugins/sleight/lib/repl-warmup.mjs';
import { selectedBrowserCode } from '../plugins/sleight/lib/browser-discovery.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const choice = { extensionInstanceId: 'fixture', profileName: 'Fixture' };
const row = () => ({ id: '1', type: 'extension', profileName: 'Fixture', metadata: { extensionInstanceId: 'fixture' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const closed = object => new Proxy(object, { get(target, name) {
  if (name === 'then') return undefined;
  // sleight's own markers on engine objects (tab-reuse.mjs) aren't engine methods.
  if (typeof name === 'string' && name.startsWith('__sleight')) return target[name];
  if (!(name in target)) throw Error('unsupported engine method: ' + String(name));
  return target[name];
} });
function engine(options = {}) {
  const calls = { gets: 0, lists: 0, inventories: 0 }, docs = [];
  const forbidden = () => assert.fail('warm-up must not acquire or create a tab');
  // The engine's Tabs has no close (api.json); tab-reuse.mjs checks for it with typeof before wrapping.
  const browser = closed({ browserId: '1', tabs: closed({ get: forbidden, new: forbidden, close: undefined, list: async () => {
    calls.lists++;
    return options.list ? options.list() : [];
  } }) });
  const context = createContext({ cua: closed({ getApp: undefined, getTab: forbidden, createBrowserTab: forbidden,
    getAXState: undefined, readBrowserTab: undefined, getTabState: undefined,
    listBrowsers: async () => { calls.inventories++; return options.inventory ? options.inventory() : [row()]; },
    getBrowser: async query => {
      assert.equal(query.id, '1'); calls.gets++;
      docs.push('# Browser safety\nKeep approval and ownership checks.');
      return browser;
    },
  }), nodeRepl: { write() {} } });
  const run = code => runInContext(`(async () => {${code}})()`, context);
  const prime = scope => run(replSetupCode({ browserChoice: choice, scope }));
  const activate = (scope, confirmed) => run(browserWarmupUseCode('void 0;', { browserChoice: choice, scope, confirmed }));
  const acquire = scope => run(selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"fixture"})', choice, scope));
  return { calls, context, browser, docs, run, prime, activate, acquire };
}

test('explicit warm-up primes only an empty session list and retains the verified browser', async () => {
  const h = engine(); await h.prime('session:turn');
  assert.deepEqual(h.calls, { gets: 1, lists: 1, inventories: 3 });
  assert.equal(h.context.__sleightSelectedBrowser, undefined, 'private readiness never publishes an unacknowledged handle');
  await h.activate('session:turn', true);
  assert.equal(await h.acquire('session:turn'), h.browser);
  assert.deepEqual(h.calls, { gets: 1, lists: 1, inventories: 4 });
  assert.equal(h.docs.length, 1);
});

test('warm-up without an explicit browser keeps the existing setup path', async () => {
  const h = engine(); await h.run(replSetupCode());
  assert.deepEqual(h.calls, { gets: 0, lists: 0, inventories: 0 });
  assert.equal(typeof h.context.__sleightDocumentGuardSetup, 'function');
});

test('an absent selected backend fails closed without acquiring or creating anything', async () => {
  const h = engine({ inventory: () => [] });
  await assert.rejects(h.prime('s:t'), /identity changed/);
  assert.deepEqual(h.calls, { gets: 0, lists: 0, inventories: 1 });
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
});

test('unexpected owned tabs are never touched or retained by warm-up', async () => {
  const h = engine({ list: () => [{ id: 'existing' }] });
  await assert.rejects(h.prime('s:t'), /empty session/);
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
  assert.equal(h.calls.lists, 1);
});

test('identity replacement while the empty list is pending drops the warmed handle', async () => {
  let replaced = false;
  const h = engine({ list: () => { replaced = true; return []; },
    inventory: () => [{ ...row(), metadata: { extensionInstanceId: replaced ? 'replacement' : 'fixture' } }] });
  await assert.rejects(h.prime('s:t'), /identity changed/);
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
});

test('a readiness error drops its handle and retains no created resources', async () => {
  const h = engine({ list: () => { throw Error('permission declined'); } });
  await assert.rejects(h.prime('s:t'), /permission declined/);
  assert.equal(h.calls.gets, 1); assert.equal(h.calls.lists, 1);
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
});

test('a new turn revalidates and reacquires instead of borrowing an earlier turn cache', async () => {
  const h = engine(); await h.prime('session:turn-one');
  await h.activate('session:turn-two', true);
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
  assert.equal(h.context.__sleightBrowserReadiness, undefined);
  await h.acquire('session:turn-two');
  assert.equal(h.calls.gets, 2);
  assert.equal(h.calls.lists, 1, 'startup readiness runs once, not once per turn');
});

test('concurrent session warmups keep independent handles and readiness work', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const one = engine({ list: async () => { await ready; return []; } });
  const two = engine({ list: async () => { await ready; return []; } });
  const pending = [one.prime('one:turn'), two.prime('two:turn')];
  await tick(); assert.equal(one.calls.lists, 1); assert.equal(two.calls.lists, 1);
  release(); await Promise.all(pending);
  await one.activate('one:turn', true); await two.activate('two:turn', true);
  assert.equal(await one.acquire('one:turn'), one.browser);
  assert.equal(await two.acquire('two:turn'), two.browser);
  assert.notEqual(one.context.__sleightSelectedBrowser, two.context.__sleightSelectedBrowser);
  assert.equal(one.calls.gets, 1); assert.equal(two.calls.gets, 1);
});

test('a timed-out readiness cannot publish its handle after the real call has resumed', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const h = engine({ list: async () => { await ready; return []; } });
  const pending = h.prime('session:turn');
  await tick();
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
  await h.activate('session:turn', false);
  release(); await pending;
  assert.equal(h.context.__sleightSelectedBrowser, undefined);
  await h.acquire('session:turn');
  assert.equal(h.calls.gets, 2, 'the ordinary path verifies a fresh acquisition after timeout');
});

function relayFixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, out] of [[serverIn, sent], [clientOut, received]]) stream.on('data', bytes => out.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ documentationTrust: fixtureDocumentation('# Browser safety\nKeep approval and ownership checks.'), clientIn, clientOut, serverIn, serverOut, warmRepl: true, browserChoice: choice,
    changeReview: false, firstCallRules: '', ...options });
  t.after(() => relay.close());
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  const respond = msg => serverOut.write(JSON.stringify(msg) + '\n');
  send({ id: 1, method: 'initialize' }); respond({ id: 1, result: { capabilities: {} } });
  send({ method: 'notifications/initialized' });
  return { sent, received, relay, send, respond, warm: sent.find(m => String(m.id).startsWith('sleight-warm-')) };
}
const call = id => ({ id, method: 'tools/call', params: { name: 'js', arguments: {
  code: 'let b = await cua.getBrowser({extensionInstanceId:"fixture"});',
} } });
const prompt = id => ({ id, method: 'elicitation/create', params: {
  message: 'Fixture permission', _meta: { connector_id: 'browser-use' },
} });

test('the first real call waits for readiness, shares its identity and gets every docs block once', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const e = engine({ list: async () => { await ready; return []; } });
  const h = relayFixture(t);
  const pending = e.run(h.warm.params.arguments.code);
  await tick(); h.send(call(2));
  assert.equal(h.sent.some(m => m.id === 2), false);
  release(); await pending;
  assert.equal(e.calls.lists, 1);
  const docs = { type: 'text', text: '# Browser safety\nKeep approval and ownership checks.' };
  h.respond({ id: h.warm.id, result: { content: [docs] } }); await tick();
  const actual = h.sent.find(m => m.id === 2);
  assert.equal(actual.params._meta['x-codex-turn-metadata'], h.warm.params._meta['x-codex-turn-metadata']);
  await e.run(actual.params.arguments.code);
  assert.equal(e.calls.gets, 1);
  h.respond({ id: 2, result: { content: [{ type: 'text', text: 'actual' }] } });
  assert.equal(h.received.find(m => m.id === 2).result.content.filter(c => c.text === docs.text).length, 1);
  h.send(call(3)); h.respond({ id: 3, result: { content: [] } });
  assert.equal(h.received.find(m => m.id === 3).result.content.filter(c => c.text === docs.text).length, 0);
});

test('warm-up permission requests are declined even after its relay deadline, without showing a prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const h = relayFixture(t, { ask: async message => { asked.push(message); return 'accept'; } });
  h.respond(prompt('permission-one')); await tick();
  assert.equal(h.sent.find(m => m.id === 'permission-one').result.action, 'decline');
  t.mock.timers.tick(6000); await tick();
  h.respond(prompt('permission-late')); await tick();
  assert.equal(h.sent.find(m => m.id === 'permission-late').result.action, 'decline');
  assert.deepEqual(asked, []);
  h.respond({ id: h.warm.id, result: { isError: true, content: [] } }); await tick();
  h.respond(prompt('permission-real')); await tick();
  assert.equal(asked.length, 1, 'ordinary requests keep the existing approval path after warm-up settles');
});

test('closing during readiness refuses the held caller and never publishes a late handle', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const e = engine({ list: async () => { await ready; return []; } });
  const h = relayFixture(t);
  const pending = e.run(h.warm.params.arguments.code);
  await tick(); h.send(call(2));
  await h.relay.close();
  assert.equal(h.received.find(m => m.id === 2).result.isError, true);
  release(); await pending;
  h.respond({ id: h.warm.id, result: { content: [] } }); await tick();
  assert.equal(h.sent.some(m => m.id === 2), false);
  assert.equal(e.context.__sleightSelectedBrowser, undefined);
  assert.equal(e.calls.lists, 1);
});

test('a late readiness error preserves its safety docs without confirming its cached handle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = relayFixture(t); h.send(call(2));
  t.mock.timers.tick(6000); await tick();
  const actual = h.sent.find(m => m.id === 2);
  const docs = { type: 'text', text: '# Browser safety\nKeep approval and ownership checks.' };
  h.respond({ id: h.warm.id, result: { isError: true, content: [docs] } }); await tick();
  h.respond({ id: 2, result: { content: [] } });
  assert.ok(h.received.find(m => m.id === 2).result.content.some(c => c.text === docs.text));
  const e = engine(); await e.prime('other:turn');
  await e.run(actual.params.arguments.code);
  assert.equal(e.calls.gets, 2, 'the resumed call ignores private readiness from another identity');
});

test('Stop revokes completed but unused readiness when the engine remains alive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = relayFixture(t, { stopGraceMs: 1, stopEngine: async () => ({ collected: false }),
    inspectInput: async () => ({ ok: true }) });
  const e = engine(); await e.run(h.warm.params.arguments.code);
  h.respond({ id: h.warm.id, result: { content: [] } }); await tick();
  h.send({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  await tick(); t.mock.timers.tick(1); await tick();
  const ended = h.sent.find(m => String(m.id).startsWith('sleight-stop-'));
  if (ended) h.respond({ id: ended.id, result: { content: [] } });
  await tick();
  h.send({ id: 'resume', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_resume: true } } });
  await tick(); h.send(call(2));
  const actual = h.sent.find(m => m.id === 2);
  assert.ok(actual, 'the existing uncollected Stop path resumes');
  await e.run(actual.params.arguments.code);
  assert.equal(e.calls.gets, 2, 'cancelled readiness must be re-acquired after Stop');
});

function restartingFixture(t, collected = true) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const sent = [], received = [], asked = [];
  let epoch = 0, current;
  function fresh() {
    const serverIn = new PassThrough(), serverOut = new PassThrough(), generation = ++epoch;
    serverIn.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const msg = JSON.parse(line); sent.push({ epoch: generation, ...msg });
        if (msg.method === 'initialize' || msg.params?.name === 'turn_ended')
          queueMicrotask(() => serverOut.write(JSON.stringify({ id: msg.id, result: { capabilities: {}, content: [] } }) + '\n'));
      }
    });
    current = { serverIn, serverOut }; return current;
  }
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ documentationTrust: fixtureDocumentation('# Browser safety\nKeep approval and ownership checks.'), clientIn, clientOut, ...fresh(), warmRepl: true, browserChoice: choice,
    changeReview: false, firstCallRules: '', stopEngine: async () => ({ collected }), restartEngine: async () => fresh(),
    inspectInput: async () => ({ ok: true }), ask: async message => { asked.push(message); return 'accept'; } });
  t.after(() => relay.close());
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  const respond = msg => current.serverOut.write(JSON.stringify(msg) + '\n');
  async function start() {
    send({ id: 1, method: 'initialize' }); await tick(); send({ method: 'notifications/initialized' }); await tick();
    assert.ok(sent.some(msg => String(msg.id).startsWith('sleight-warm-')));
  }
  async function resume() {
    send({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
    for (let i = 0; i < 6; i++) await tick();
    assert.ok(received.some(msg => msg.id === 'stop'));
    send({ id: 'resume', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_resume: true } } });
    send(call(2));
    for (let i = 0; i < 6; i++) await tick();
    assert.ok(sent.some(msg => msg.id === 2 && msg.epoch === epoch));
  }
  return { sent, received, asked, start, resume, respond, get epoch() { return epoch; } };
}

test('confirmed collection of an unanswered warm-up restores ordinary replacement approvals', async t => {
  const h = restartingFixture(t); await h.start(); await h.resume();
  assert.equal(h.epoch, 2);
  assert.ok(h.sent.some(msg => msg.epoch === 2 && msg.method === 'initialize'));
  h.respond(prompt('replacement-permission')); await tick();
  assert.equal(h.asked.length, 1, 'the replacement engine uses the ordinary approval callback');
  assert.equal(h.sent.find(msg => msg.id === 'replacement-permission').result.action, 'accept');
});

test('unconfirmed collection keeps declining private permissions until the late reply settles', async t => {
  const h = restartingFixture(t, false); await h.start(); await h.resume();
  assert.equal(h.epoch, 1);
  h.respond(prompt('private-late')); await tick();
  assert.equal(h.asked.length, 0);
  assert.equal(h.sent.find(msg => msg.id === 'private-late').result.action, 'decline');
  const warm = h.sent.find(msg => String(msg.id).startsWith('sleight-warm-'));
  h.respond({ id: warm.id, result: { isError: true, content: [] } }); await tick();
  h.respond(prompt('ordinary-after-late')); await tick();
  assert.equal(h.asked.length, 1);
  assert.equal(h.sent.find(msg => msg.id === 'ordinary-after-late').result.action, 'accept');
});

test('collecting one warm-up leaves another session private until its own reply settles', async t => {
  const a = restartingFixture(t), b = restartingFixture(t);
  await a.start(); await b.start(); await a.resume();
  b.respond(prompt('other-private')); await tick();
  assert.equal(b.asked.length, 0);
  assert.equal(b.sent.find(msg => msg.id === 'other-private').result.action, 'decline');
  a.respond(prompt('collected-ordinary')); await tick();
  assert.equal(a.asked.length, 1);
  assert.equal(a.sent.find(msg => msg.id === 'collected-ordinary').result.action, 'accept');
  const warm = b.sent.find(msg => String(msg.id).startsWith('sleight-warm-'));
  b.respond({ id: warm.id, result: { isError: true, content: [] } }); await tick();
  b.respond(prompt('other-ordinary')); await tick();
  assert.equal(b.asked.length, 1);
  assert.equal(b.sent.find(msg => msg.id === 'other-ordinary').result.action, 'accept');
});
