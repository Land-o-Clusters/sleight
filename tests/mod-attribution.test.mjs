// Offline MCP and fork-channel fixtures. No host, model, app, card or window runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { createV3Bridge, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { MOD_ID, MODEL_ID, MOD_META } from './fixtures/mod-attribution.mjs';

// Explicit test-only broken variants instrument the loaded relay, never disk.
const mutant = process.env.MB1B_MUTANT;
const replacements = {
  'wide-shape': ["value.length === 45 && /^toolu_plugin_[0-9a-f]{32}$/.test(value)", "/^toolu_[A-Za-z0-9_]+$/.test(value)"],
  'doctor-row': ['  log(claudeModDoctorLine());', ''],
  'exact-meta': ["const modAttributed = msg => modHost() &&", "const modAttributed = msg => Object.keys(msg.params?._meta ?? {}).length === 1 && modHost() &&"],
  'stale-queue': ["      if (epoch !== remoteEpoch) return { available: false, deferred: false };", ''],
  'shared-nonce': ["directHost?.bootstrapEnvelope() ?? { version: 1, session: randomUUID(), nonce: randomBytes(32).toString('hex') }", "{ version: 1, session: 'shared-session', nonce: 'a'.repeat(64) }"],
  'no-mods': ["modHost() && modToolUseId(msg.params?._meta?.['claudecode/toolUseId'])", 'false'],
  'name-only': ["modHost() && modToolUseId(msg.params?._meta?.['claudecode/toolUseId'])", 'modHost()'],
  'all-tools': ["    // Check attribution before any stats ownership", "    if (msg.method === 'tools/call' && msg.params?.name !== TURN_END_TOOL) { refuseModFrame(msg); return; }\n    // Check attribution before any stats ownership"],
  'echo-refusal': ["text: 'Trusted turn binding unavailable.'", "text: JSON.stringify(msg.params)"],
  'fixed-nonce': ["remoteEnvelope = { ...remoteEnvelope, nonce: randomBytes(32).toString('hex') }", 'remoteEnvelope = { ...remoteEnvelope }'],
  'stale-begin': ['generation === stopGeneration && epoch === remoteEpoch', 'generation === stopGeneration'],
  'stats-reset': ["      if (privateFrame && (!modAttributed(msg)", "      if (Object.hasOwn(args, 'sleight_stats_begin')) statsOpen = undefined;\n      if (privateFrame && (!modAttributed(msg)"],
  'host-bypass': ["const modAttributed = msg => modHost() &&", 'const modAttributed = msg =>'],
  'no-attribution-log': ["stderr.write('sleight: mod frame refused:", "(() => {})('sleight: mod frame refused:"],
  'nonce-log': ["        installedBootstrapped = true;", "        stderr.write(remoteEnvelope.nonce);\n        installedBootstrapped = true;"],
  'no-end-attribution': ["      if (privateFrame && (!modAttributed(msg)", "      if (privateFrame && args.sleight_turbo?.event !== 'end' && (!modAttributed(msg)"],
  'stale-end-clears': ['const modEnd = attributed && modEndFrame(args);', "const modEnd = attributed && args.sleight_turbo?.event === 'end';"],
  'stale-end-refused': ["      if (args.sleight_turbo?.event === 'end') {", "      if (args.sleight_turbo?.event === 'end' && !modEndFrame(args)) { refuseModFrame(msg); return; }\n      if (args.sleight_turbo?.event === 'end') {"],
  'nested-meta': ["modToolUseId(msg.params?._meta?.['claudecode/toolUseId'])", "modToolUseId(msg.params?.arguments?._meta?.['claudecode/toolUseId'] ?? msg.params?._meta?.['claudecode/toolUseId'])"],
};
let hook;
if (mutant) {
  assert.ok(Object.hasOwn(replacements, mutant), 'known explicit broken variant');
  const relayUrl = new URL(`../plugins/sleight/lib/${mutant === 'doctor-row' ? 'launch' : 'relay'}.mjs`, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== relayUrl) return loaded;
    const source = loaded.source.toString(), [before, after] = replacements[mutant];
    assert.ok(source.includes(before), `broken variant ${mutant} still matches the implementation`);
    return { ...loaded, source: source.replace(before, after) };
  } });
}
const { createRelay, modToolUseId } = await import('../plugins/sleight/lib/relay.mjs');
const { prepareInstalledStartup, approvalLogging, doctor, claudeModDoctorLine } = await import('../plugins/sleight/lib/launch.mjs');
hook?.deregister();
const text = result => result?.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') ?? '';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const ids = [
  ['mod', MOD_ID, true], ['model', MODEL_ID, false],
  ...['bdrk', 'vrtx', 'patch', 'serve', 'unknown'].map(prefix => [prefix, `toolu_${prefix}_${'a'.repeat(32)}`, false]),
  ['uppercase', 'toolu_plugin_' + 'A'.repeat(32), false],
  ['short', 'toolu_plugin_' + 'a'.repeat(31), false], ['long', 'toolu_plugin_' + 'a'.repeat(33), false],
  ['model tail', 'toolu_plugin_' + MODEL_ID.slice(6), false], ['number', 42, false],
  ['object', { id: MOD_ID }, false], ['array', [MOD_ID], false], ['null', null, false],
  ['missing', undefined, false], ['newline', MOD_ID + '\n', false],
];
const catalog = { apps: [{ id: 'com.apple.TextEdit', name: 'TextEdit', names: ['TextEdit'] }] };
const card = id => ({ id, method: 'elicitation/create', params: {
  message: 'Allow Computer Use to use "TextEdit"?', _meta: { connector_id: 'computer-use', tool_params: { app: 'com.apple.TextEdit' },
    tool_params_display: [{ name: 'app', value: 'TextEdit' }], persist: ['session', 'always'], riskLevel: 'low' } } });

async function harness(t, { host = 'claude-code', turbo = false, stoppable = false, presence = async () => ({ idleSeconds: 0, locked: false }), trace, ...options } = {}) {
  let bridge;
  const worker = [], logs = [], traces = [], received = [], sent = [], statuses = [], answers = [], stops = [], pending = new Map();
  if (turbo) {
    const child = new EventEmitter(), endpoint = new EventEmitter();
    child.connected = endpoint.connected = true;
    child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
    endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
    child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
    child.unref = () => {};
    const server = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin(message) {
      worker.push(['begin', message.text]);
      return { call: async request => { worker.push(['call', request.name]); return { text: 'fixture', isError: false }; },
        delivered: () => true, end: async () => { worker.push(['end']); return { revoked: true, cleanup: [] }; } };
    } });
    bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
      forkWorker() { queueMicrotask(() => server.ready()); return child; } });
  }
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  let seq = 0;
  const engine = message => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  clientOut.on('data', bytes => {
    for (const message of String(bytes).trim().split('\n').map(JSON.parse)) {
      received.push(message); pending.get(message.id)?.(message.result); pending.delete(message.id);
    }
  });
  const tree = readFileSync(new URL('fixtures/payment-gate/firefox-checkout-sol.txt', import.meta.url), 'utf8');
  serverIn.on('data', bytes => {
    for (const message of String(bytes).trim().split('\n').map(JSON.parse)) {
      sent.push(message);
      if (message.method === 'initialize') engine({ id: message.id, result: { capabilities: {}, serverInfo: { name: 'fixture' } } });
      if (message.method === 'tools/call') queueMicrotask(() => engine({ id: message.id, result: { content: [{ type: 'text', text: message.params.name === 'js' ? tree : '' }],
        _meta: { 'codex/toolSurface': { app: { appId: 'org.mozilla.firefox' } } } } }));
    }
  });
  const prepared = turbo ? await prepareInstalledStartup(() => bridge, undefined, { env: {} }) : {};
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, ...prepared, changeReview: false, idleTurnEndMs: 0,
    modHost: () => host === 'claude-code', desktopTurns: true,
    inputLease: new InputLease({ directory: registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-mod-lease-'))), holder: 'mod-attribution' }),
    ask: async (...args) => { answers.push(args); return 'decline'; },
    remoteApprovals: { presence, catalog: async () => catalog },
    trace: (event, data) => { traces.push({ event, data }); trace?.(event, data); },
    stderr: { write: line => logs.push(line) },
    cursor: { narration: 'bubbles', close() {}, status: (state, detail) => statuses.push({ state, ...detail }) },
    ...(stoppable ? { stopEngine: async () => { stops.push('collected'); return { collected: true }; },
      restartEngine: async () => ({ serverIn, serverOut }), inspectInput: async () => ({ ok: true }) } : {}), ...options });
  t.after(async () => { relay.dispose(); await bridge?.detach(); streams.forEach(stream => stream.destroy()); });
  const request = (name, args = {}, idValue, extraMeta = {}, root = {}) => {
    const id = ++seq;
    const result = new Promise(resolve => pending.set(id, resolve));
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', ...root, params: { name, arguments: args,
      _meta: { ...extraMeta, ...(idValue === undefined ? {} : { 'claudecode/toolUseId': idValue }) } } }) + '\n');
    return result;
  };
  const control = (args, ...values) => request('turn_ended', args, values.length ? values[0] : MOD_ID);
  const bootstrap = async (...values) => {
    const result = await control({ sleight_turbo: { event: 'bootstrap' } }, ...values);
    return { result, envelope: result.isError ? undefined : JSON.parse(text(result)).sleightTurbo };
  };
  const begin = (envelope, idValue = MOD_ID, extra = {}) => control({ sleight_turbo: { ...envelope,
    event: 'begin', turn: 'turn-' + (seq + 1), text: 'allow TextEdit', origin: 'composer', turbo, ...extra } }, idValue);
  const initialize = new Promise(resolve => {
    pending.set('initialize', resolve);
    clientIn.write(JSON.stringify({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: host, version: '2.1.309' }, capabilities: {} } }) + '\n');
  });
  await initialize;
  return { relay, worker, sent, received, logs, traces, statuses, answers, stops, engine, request, control, bootstrap, begin,
    async approval(id = 'card') { engine(card(id)); await settle(); return sent.find(message => message.id === id)?.result; },
    async payment() {
      await request('js', { code: 'let app = await cua.getApp("Firefox")' }, MODEL_ID);
      await request('js', { code: 'await app.click(88)' }, MODEL_ID);
      const code = sent.filter(message => message.params?.name === 'js').at(-1)?.params.arguments.code ?? '';
      const match = /__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(code);
      assert.ok(match, 'real relay sends its payment guard to the fake engine');
      return JSON.parse(match[1]).payment;
    } };
}

for (const [label, id, accepted] of ids) {
  test(`bootstrap shape: ${label}`, async t => {
    const h = await harness(t);
    const first = await h.bootstrap(id);
    assert.equal(first.result.isError, !accepted);
    if (!accepted) {
      assert.deepEqual(first.result, { isError: true, content: [{ type: 'text', text: 'Trusted turn binding unavailable.' }] });
      assert.equal(first.envelope, undefined);
      assert.equal((await h.bootstrap(MOD_ID)).result.isError, false, 'refusal spends no bootstrap');
    }
  });
  for (const origin of ['composer', 'bridge', 'desktop', undefined]) test(`begin shape: ${label}, origin=${origin ?? 'legacy'}`, async t => {
    const h = await harness(t, { turbo: true });
    const { envelope } = await h.bootstrap();
    const frame = { ...envelope, event: 'begin', turn: 'same-turn', text: 'allow TextEdit', ...(origin ? { origin, turbo: true } : {}) };
    const result = await h.control({ sleight_turbo: frame }, id);
    assert.equal(result.isError, !accepted);
    assert.equal(h.worker.filter(row => row[0] === 'begin').length, accepted && origin !== 'desktop' ? 1 : 0);
    const answer = await h.approval();
    assert.equal(answer?.action, accepted && origin !== undefined ? 'accept' : 'decline');
    assert.equal(h.traces.some(row => row.event === 'answered-by-typed-session'), accepted && origin !== undefined);
    if (!accepted) {
      assert.equal((await h.control({ sleight_turbo: frame }, MOD_ID)).isError, false, 'refusal spends no turn id');
    }
  });
  for (const field of ['end', 'sleight_resume', 'sleight_stats_begin', 'sleight_say', 'sleight_stats_skip', 'snapshot', 'sleight_stats'])
    test(`${field} shape: ${label}`, async t => {
      const h = await harness(t);
      const { envelope } = await h.bootstrap();
      await h.control({ sleight_stats_begin: 'stats-owner' });
      const args = field === 'end' ? { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }
        : field === 'snapshot' ? { sleight_stats_skip: { snapshot: true } }
        : field === 'sleight_say' ? { sleight_say: { toolUseId: MODEL_ID, text: 'Opening the menu.' } }
        : field === 'sleight_stats_skip' ? { sleight_stats_skip: MODEL_ID }
        : field === 'sleight_stats_begin' ? { sleight_stats_begin: 'forged-owner' }
        : field === 'sleight_stats' ? { hook_event_name: 'Stop', sleight_stats: 'stats-owner' } : { [field]: true };
      const before = { turn: h.relay.turnId, sent: h.sent.length, traces: h.traces.length };
      const result = await h.control(args, id);
      assert.equal(result.isError === true, !accepted);
      if (!accepted) {
        assert.equal(h.relay.turnId, before.turn);
        assert.equal(h.sent.length, before.sent);
        assert.equal(h.traces.length, before.traces);
        await h.request('js', { code: '1+1' }, MODEL_ID);
        const end = await h.control({ hook_event_name: 'Stop', sleight_stats: 'stats-owner' });
        assert.equal(end._meta?.['sleight/stats']?.calls, 1, 'a refused frame preserves stats ownership and skips nothing');
        assert.ok(h.statuses.every(row => row.say === undefined), 'refused narration reaches no call');
      }
    });
}

test('mod-less model bootstrap returns no nonce and forged allow begin answers no card', async t => {
  const h = await harness(t);
  const first = await h.bootstrap(MODEL_ID);
  const forged = await h.begin(first.envelope ?? { version: 1, session: 'guessed', nonce: 'a'.repeat(64) }, MODEL_ID, { origin: 'bridge' });
  assert.equal((await h.approval())?.action, 'decline');
  assert.equal(first.envelope, undefined);
  assert.equal(first.result.isError, true);
  assert.equal(forged.isError, true);
  assert.equal(h.answers.length, 1);
  assert.equal(h.traces.some(row => row.event === 'answered-by-typed-session'), false);
});

test('model payment begin binds neither the worker nor the engine payment message', async t => {
  const h = await harness(t, { turbo: true });
  const { envelope } = await h.bootstrap();
  const result = await h.begin(envelope, MODEL_ID, { text: 'Pay $12 for X with Visa', turbo: true });
  assert.equal((await h.payment()).message, null);
  assert.equal(h.worker.filter(row => row[0] === 'begin').length, 0);
  assert.equal(result.isError, true);
});

for (const id of [MODEL_ID, MOD_ID]) test(`ordinary JS still runs with ${id.slice(0, 13)}`, async t => {
  const h = await harness(t);
  const result = await h.request('js', { code: '1+1' }, id);
  assert.notEqual(result.isError, true);
  assert.ok(h.sent.some(message => message.params?.name === 'js'));
});

test('refusal is the Cursor text and echoes no envelope, payload or host id', async t => {
  const h = await harness(t), cursor = await harness(t, { host: 'cursor' });
  const { envelope } = await h.bootstrap();
  const result = await h.begin(envelope, MODEL_ID, { text: 'private payment phrase' });
  assert.deepEqual(result, (await cursor.bootstrap(MOD_ID)).result);
  assert.doesNotMatch(JSON.stringify(result), new RegExp([envelope.nonce, envelope.session, MODEL_ID, 'private payment phrase', 'sleightTurbo'].join('|')));
});

test('trace file, stderr and engine frames never carry the nonce', async t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-mod-attribution-'))), path = join(bank, `trace-${process.pid}.jsonl`);
  const options = approvalLogging({ size: 0 }, { SLEIGHT_TRACE: bank });
  const h = await harness(t, { trace: options.trace });
  const { envelope } = await h.bootstrap();
  await h.begin(envelope);
  await h.begin(envelope, MODEL_ID);
  await h.control({ hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } });
  assert.ok(existsSync(path));
  for (const sink of [readFileSync(path, 'utf8'), h.logs.join(''), JSON.stringify(h.sent), JSON.stringify(h.traces)]) {
    assert.ok(!sink.includes(envelope.nonce));
    assert.ok(!sink.includes(envelope.session));
  }
  assert.equal(h.received.filter(message => JSON.stringify(message).includes(envelope.nonce)).length, 1, 'only the accepted bootstrap reply');
});

test('attributed reload rotates the nonce, fences old begins and still binds the worker', async t => {
  const h = await harness(t, { turbo: true });
  const { envelope: old } = await h.bootstrap();
  await h.begin(old);
  assert.notEqual((await h.payment()).message, null);
  assert.equal((await h.begin({ ...old, nonce: '0'.repeat(64) })).isError, true);
  const { envelope: fresh } = await h.bootstrap();
  assert.ok(fresh.nonce !== old.nonce, 'reload rotates the nonce');
  assert.equal((await h.payment()).message, null);
  assert.equal((await h.begin(old)).isError, true);
  assert.notEqual((await h.control({ hook_event_name: 'Stop', sleight_turbo: { ...old, event: 'end' } })).isError, true);
  assert.equal((await h.begin(fresh)).isError, false);
  assert.equal(h.worker.filter(row => row[0] === 'begin').length, 2);
});

for (const bootstrapped of [false, true]) for (const event of ['Stop', 'Interrupt'])
  for (const [label, patch] of [
    ['nonce', { nonce: '0'.repeat(64) }], ['session', { session: 'other-session' }],
    ['version', { version: 2 }], ['extra key', { extra: true }],
  ]) test(`attributed unbound ${event}: ${label}, bootstrap=${bootstrapped}`, async t => {
    const h = await harness(t, { nativeWindows: true });
    const envelope = bootstrapped ? (await h.bootstrap()).envelope
      : { version: 1, session: 'previous-relay', nonce: 'a'.repeat(64) };
    await h.request('js', { code: '1 + 1' }, MODEL_ID);
    const before = h.relay.turnId;
    const result = await h.control({ hook_event_name: event, sleight_clipboard_turn_end: true,
      sleight_turbo: { ...envelope, event: 'end', ...patch } });
    assert.notEqual(result.isError, true, 'unbound attributed ends still run ordinary cleanup');
    const end = h.sent.filter(row => row.params?.name === 'turn_ended').at(-1).params.arguments;
    assert.equal(end.hook_event_name, event);
    assert.equal(end.sleight_clipboard_turn_end, false, 'stale mod ends never clear the latch, even after relay restart');
    assert.equal('sleight_turbo' in end, false);
    assert.notEqual(h.relay.turnId, before, 'ordinary cleanup rotates the turn');
    assert.equal((await h.approval()).action, 'decline', 'an invalid end grants no typed app');
  });

test('attributed stale Stop immediately ends the worker and payment message', async t => {
  const h = await harness(t, { turbo: true });
  const { envelope } = await h.bootstrap();
  await h.begin(envelope, MOD_ID, { text: 'Pay $12 for X with Visa' });
  assert.notEqual((await h.payment()).message, null);
  const result = await h.control({ hook_event_name: 'Stop',
    sleight_turbo: { ...envelope, nonce: '0'.repeat(64), event: 'end' } });
  assert.notEqual(result.isError, true);
  assert.equal(h.worker.filter(row => row[0] === 'end').length, 1);
  assert.equal((await h.payment()).message, null);
});

test('Esc with the mod old envelope after reconnect collects the engine without another begin', async t => {
  const prior = await harness(t);
  const { envelope: old } = await prior.bootstrap();
  const h = await harness(t, { nativeWindows: true, stoppable: true });
  // The live mod retains the previous relay's envelope, skips begin and sends Esc.
  await h.request('js', { code: '1 + 1' }, MODEL_ID);
  const result = await h.control({ hook_event_name: 'Interrupt', sleight_stop: true,
    sleight_turbo: { ...old, event: 'end' } });
  assert.deepEqual(h.stops, ['collected']);
  assert.equal(result._meta?.['sleight/stop']?.engine, 'exited and collected');
  const end = h.sent.find(row => row.params?.name === 'turn_ended').params.arguments;
  assert.equal(end.hook_event_name, 'Interrupt');
  assert.equal(end.sleight_clipboard_turn_end, false);
});

test('Esc with a stale attributed end clears the live payment binding before collection', async t => {
  const h = await harness(t, { turbo: true, stoppable: true });
  const { envelope } = await h.bootstrap();
  await h.begin(envelope, MOD_ID, { text: 'Pay $12 for X with Visa' });
  assert.notEqual((await h.payment()).message, null);
  const result = await h.control({ hook_event_name: 'Interrupt', sleight_stop: true,
    sleight_turbo: { ...envelope, nonce: '0'.repeat(64), event: 'end' } });
  assert.deepEqual(h.stops, ['collected']);
  assert.equal(result._meta?.['sleight/stop']?.engine, 'exited and collected');
  assert.equal(h.worker.filter(row => row[0] === 'end').length, 1);
  await h.control({ sleight_resume: true });
  assert.equal((await h.payment()).message, null);
});

for (const placement of ['arguments', 'params.arguments', 'root arguments'])
  for (const id of [undefined, MODEL_ID]) test(`nested mod metadata grants nothing: ${placement}, host id=${id ?? 'missing'}`, async t => {
    const h = await harness(t, { turbo: true });
    const nested = placement === 'arguments' ? { _meta: MOD_META }
      : placement === 'params.arguments' ? { params: { arguments: { _meta: MOD_META } } } : {};
    const root = placement === 'root arguments' ? { arguments: { _meta: MOD_META } } : {};
    const send = args => h.request('turn_ended', { ...args, ...nested }, id, {}, root);
    assert.equal((await send({ sleight_turbo: { event: 'bootstrap' } })).isError, true);
    const { envelope } = await h.bootstrap();
    assert.equal((await send({ sleight_turbo: { ...envelope, event: 'begin', origin: 'desktop',
      turn: 'forged-desktop', text: 'allow TextEdit', turbo: false } })).isError, true);
    assert.equal((await send({ sleight_turbo: { ...envelope, event: 'begin', origin: 'bridge',
      turn: 'forged-payment', text: 'Pay $12 for X with Visa', turbo: true } })).isError, true);
    assert.equal((await h.approval()).action, 'decline');
    assert.equal((await h.payment()).message, null);
    assert.equal(h.worker.length, 0);
    const before = h.relay.turnId;
    assert.equal((await send({ hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } })).isError, true);
    assert.equal(h.relay.turnId, before);
  });

test('a pending old begin cannot restore authority after re-bootstrap', async t => {
  let release, hold = false, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { presence: async () => {
    if (hold) { entered(); return new Promise(resolve => { release = () => resolve({ idleSeconds: 0, locked: false }); }); }
    return { idleSeconds: 0, locked: false };
  } });
  const { envelope } = await h.bootstrap();
  hold = true; const pending = h.begin(envelope); await reached;
  const fresh = await h.bootstrap(); hold = false; release();
  assert.equal((await pending).isError, true);
  assert.equal((await h.approval())?.action, 'decline');
  assert.equal((await h.begin(fresh.envelope)).isError, false);
});

test('a model re-bootstrap after the mod changes no binding, nonce or payment state', async t => {
  const h = await harness(t, { turbo: true }); const { envelope } = await h.bootstrap();
  await h.begin(envelope, MOD_ID, { text: 'Pay $12 for X with Visa' });
  const before = await h.payment(), worker = h.worker.length;
  assert.equal((await h.bootstrap(MODEL_ID)).result.isError, true);
  assert.deepEqual((await h.payment()).message, before.message);
  assert.equal(h.worker.length, worker);
  assert.equal((await h.begin(envelope)).isError, false);
});

test('separate sessions and reused turn ids refuse without affecting the valid session', async t => {
  const a = await harness(t), b = await harness(t);
  const ea = (await a.bootstrap()).envelope, eb = (await b.bootstrap()).envelope;
  assert.ok(ea.nonce !== eb.nonce, 'relay sessions have distinct nonces');
  assert.equal((await b.begin(ea)).isError, true);
  const args = { sleight_turbo: { ...ea, event: 'begin', turn: 'only-once', text: 'allow TextEdit', origin: 'composer', turbo: false } };
  assert.equal((await a.control(args)).isError, false);
  assert.equal((await a.control(args)).isError, true);
  assert.equal((await b.begin(eb)).isError, false);
});

for (const host of ['cursor', 'codex-mcp-client', 'grok', 'grok-cli']) test(`${host} refuses every mod-only frame despite a plugin id`, async t => {
  const h = await harness(t, { host });
  for (const args of [{ sleight_turbo: { event: 'bootstrap' } }, { sleight_resume: true }, { sleight_stats_begin: 'x' },
    { sleight_say: { toolUseId: MODEL_ID, text: 'Opening.' } }, { sleight_stats_skip: MODEL_ID },
    { hook_event_name: 'Stop', sleight_turbo: { version: 1, session: 'x', nonce: 'a'.repeat(64), event: 'end' } }]) {
    assert.equal((await h.control(args)).isError, true);
  }
  assert.equal(h.worker.length, 0);
});

test('the recorded Claude Code 2.1.309 compatibility row matches only the measured mod shape', () => {
  const probe = JSON.parse(readFileSync(new URL('fixtures/claude-mod-attribution.json', import.meta.url)));
  assert.equal(probe.version, '2.1.309'); assert.equal(probe.runs, 4);
  assert.equal(probe.mod.prefix, 'toolu_plugin_'); assert.equal(probe.mod.tailLength, 32); assert.equal(probe.mod.alphabet, '0123456789abcdef');
  assert.equal(modToolUseId(probe.mod.prefix + probe.mod.alphabet.repeat(2)), true);
  for (const model of probe.modelPrefixes) assert.equal(modToolUseId(model + 'a'.repeat(24)), false);
  for (const [, id, accepted] of ids) assert.equal(modToolUseId(id), accepted);
});

test('doctor states the format-change refusal and the lack of a live mod probe, without running a host', async () => {
  const lines = [], empty = () => [];
  const code = await doctor({ log: line => lines.push(line), env: { SLEIGHT_RUNTIME: 'own' }, platform: 'darwin',
    runtime: async () => ({ selected: 'own', ok: true, lines: [] }), turbo: empty, hand: empty, permissions: empty,
    settings: empty, codex: empty, cursor: empty, grok: empty, grokbot: empty });
  assert.equal(code, 0);
  assert.ok(lines.includes(claudeModDoctorLine()));
  assert.match(claudeModDoctorLine(), /Missing or changed IDs refuse typed approvals and turbo/);
  assert.match(claudeModDoctorLine(), /no live mod probe/);
});

test('host metadata may add keys without changing the pinned id contract', async t => {
  const h = await harness(t);
  const result = await h.request('turn_ended', { sleight_turbo: { event: 'bootstrap' } }, MOD_ID,
    { progressToken: 13, futureHostKey: { extra: true } });
  assert.equal(result.isError, false);
});

test('a legacy bind queued just before reload cannot restore the old worker turn', async t => {
  const h = await harness(t, { turbo: true }); const { envelope } = await h.bootstrap();
  const pending = h.control({ sleight_turbo: { ...envelope, event: 'begin', turn: 'old-legacy', text: 'Pay $12 for X with Visa' } });
  const fresh = await h.bootstrap();
  assert.equal((await pending).isError, true);
  assert.equal((await h.payment()).message, null);
  assert.equal(h.worker.filter(row => row[0] === 'begin').length, 0);
  assert.equal((await h.begin(fresh.envelope)).isError, false);
  assert.equal(h.worker.filter(row => row[0] === 'begin').length, 1);
});

test('an unknown format logs a payload-free diagnosis and reuses the existing refusal', async t => {
  const h = await harness(t), id = 'toolu_plugin_v2_' + 'a'.repeat(32);
  const result = await h.control({ sleight_turbo: { event: 'bootstrap' } }, id);
  assert.equal(result.isError, true);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /mod attribution missing or unsupported/);
  assert.ok(!h.logs[0].includes(id));
  assert.doesNotMatch(h.logs[0], /nonce|session|sleightTurbo/);
  assert.equal(text(result), 'Trusted turn binding unavailable.');
});
