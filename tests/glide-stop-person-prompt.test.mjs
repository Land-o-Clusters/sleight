// Offline safety regressions. The streams and driver never reach an app or host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { MOD_META } from './fixtures/mod-attribution.mjs';

const mutations = {
  'desktop-notice': ['relay.mjs', "modPersonPromptAttributable = frame.origin !== 'desktop';", 'modPersonPromptAttributable = true;'],
  'bootstrap-notice': ['relay.mjs', 'installedBootstrapped = true;', 'installedBootstrapped = true; modPersonPromptAttributable = true;'],
  'interrupt-notice': ['mac-driver/errors.mjs', 'Input resumes after release completes.', 'Input resumes after release completes; unconfirmed cleanup keeps it blocked.'],
  'generic-notice': ['mac-driver/errors.mjs', "USER_STOPPED: 'Glide input stopped.'", "USER_STOPPED: 'Glide input stopped. Start a new session to continue.'"],
  'turn-end': ['relay.mjs', "    if (closing && msg.method === 'tools/call') {",
    "    if (closing && stopFinished && modAttributed(msg) && modEndFrame(msg.params?.arguments)) { nativeSession.userPrompt(); glideStopLatched = false; resumeRequested = true; resumeAfterStop(); }\n    if (closing && msg.method === 'tools/call') {"],
  'runtime-end': ['runtime-select.mjs', "          await safety.endTurn({ clipboardTurnEnded: params.arguments?.sleight_clipboard_turn_end === true });",
    "          await safety.endTurn({ clipboardTurnEnded: params.arguments?.sleight_clipboard_turn_end === true });\n          if (params.arguments?.sleight_glide_turn_end) stopSession.userPrompt();"],
  'model-frames': ['relay.mjs', 'privateFrame && (!modAttributed(msg) || disposed', 'privateFrame && (false || disposed'],
  'no-prompt': ['relay.mjs', "nativeSession?.userPrompt?.() !== false", 'false'],
  'no-host': ['relay.mjs', "const modAttributed = msg => modHost() && modToolUseId(msg.params?._meta?.['claudecode/toolUseId'])", 'const modAttributed = msg => true'],
  'interrupt-latch': ['relay.mjs', 'else nativeSession?.interrupt?.();', 'else nativeSession?.stop?.();'],
  'legacy-prompt': ['relay.mjs', '// Legacy begin frames have no person origin and cannot lift Stop.',
    'if (stopFinished && nativeSession?.userPrompt?.() !== false) { glideStopLatched = false; resumeRequested = true; resumeAfterStop(); }'],
  'desktop-prompt': ['relay.mjs', "&& frame.origin !== 'desktop') resumeAtPersonPrompt();", ') resumeAtPersonPrompt();'],
  'stop-release': ['mac-driver/stop.mjs', 'if (interrupted && !operations.size) reset();', 'if (!operations.size) reset();'],
  'duplicate-prompt': ['relay.mjs', "&& !modPersonPromptFrames && frame.origin !== 'desktop'", "&& frame.origin !== 'desktop'"],
};
const mutant = process.env.INT22I_RELAY_MUTANT ?? process.env.INT22H_MUTANT;
let hook;
if (mutant) {
  assert.ok(Object.hasOwn(mutations, mutant), 'known broken variant');
  const [path, before, after] = mutations[mutant];
  const target = new URL('../plugins/sleight/lib/' + path, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    const source = String(loaded.source);
    assert.ok(source.includes(before), 'broken variant anchor: ' + mutant);
    return { ...loaded, source: source.replace(before, after) };
  } });
}
const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
const { createGlideStopSession } = await import('../plugins/sleight/lib/mac-driver/stop.mjs');
const { createOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
const { createV3Bridge, createV3Frontend, serveV3Worker } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
const { GLIDE_STOP_PERSON_NOTICE, GLIDE_STOP_SESSION_NOTICE, GLIDE_INTERRUPT_NOTICE, formatMacDriverError } =
  await import('../plugins/sleight/lib/mac-driver/errors.mjs');
hook?.deregister();
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = reply => reply.result?.content?.map(row => row.text ?? '').join('\n') ?? '';
const modelMeta = { 'claudecode/toolUseId': 'toolu_' + 'b'.repeat(24) };

function fixture(t, { mod = true, directHost, directBrowser, desktopTurns = true } = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, replies = [], forwarded = [];
  let click, reports = 0, sequence = 0, resets = 0;
  const session = createGlideStopSession({ control: { async beginGlideStop(_, stop) { click = stop; return () => {}; } },
    resetHelper() { resets++; return true; } });
  clientOut.on('data', bytes => replies.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => {
    for (const line of String(bytes).trim().split('\n')) {
      const row = JSON.parse(line); forwarded.push(row);
      if (row.id !== undefined) serverOut.write(JSON.stringify({ id: row.id, result: { content: [] } }) + '\n');
    }
  });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, nativeMac: true, modHost: () => mod,
    nativeSession: { ...session, setPolicy() {} }, desktopTurns, directHost, directBrowser,
    changeReview: false, idleTurnEndMs: 0, stopGraceMs: 1, stderr: { write() {} },
    stopEngine: async () => { await session.settled(); return { collected: true }; },
    restartEngine: async () => ({ serverIn, serverOut }), inspectRelease: async () => ({ ok: true }),
    onStopReported: () => { reports++; } });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  const call = async (name, args = {}, meta) => {
    const id = ++sequence;
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args, ...meta ? { _meta: meta } : {} } }) + '\n');
    for (let n = 0; n < 100 && !replies.some(row => row.id === id); n++) await tick();
    const reply = replies.find(row => row.id === id);
    assert.ok(reply, 'relay replied to ' + name); return reply;
  };
  return { session, call, forwarded, resets: () => resets,
    async stop() {
      const before = reports, end = await session.begin({}, () => {});
      click(); await end();
      for (let n = 0; n < 100 && reports === before; n++) await tick();
      assert.equal(reports, before + 1, 'person control collection completed');
    },
    async bootstrap(meta = MOD_META) {
      const reply = await call('turn_ended', { sleight_turbo: { event: 'bootstrap' } }, meta);
      return JSON.parse(reply.result.content[0].text).sleightTurbo;
    },
    prompt(envelope, { origin = 'composer', meta = MOD_META, turn = 'person-' + sequence, ...extra } = {}) {
      return call('turn_ended', { sleight_turbo: { ...envelope, event: 'begin', turn, text: 'continue', origin, turbo: false, ...extra } }, meta);
    },
  };
}
async function blocked(f, notice = GLIDE_STOP_SESSION_NOTICE) {
  assert.throws(f.session.check, { code: 'USER_STOPPED' });
  const reply = await f.call('js', { code: 'await app.click(1)' });
  assert.equal(reply.result?.isError, true, 'Glide input remains refused');
  assert.equal(text(reply), 'Input lease: ' + notice);
  assert.ok(!f.forwarded.some(row => row.params?.arguments?.code === 'await app.click(1)'), 'no input reached the runtime');
}

test('INT22H attributed turn end and a background turn without a person prompt keep refusing Glide input', async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.stop();
  await f.call('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  // A new task-notification turn may start without prompt.submit in the mod.
  await f.call('turn_ended', { sleight_stats_begin: 'background-turn' }, MOD_META);
  await blocked(f);
  assert.equal(f.resets(), 0);
});

test('INT22H model calls cannot clear Stop even with a copied envelope', async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.stop();
  for (const meta of [undefined, modelMeta, { 'claudecode/toolUseId': 'toolu_plugin_' + 'A'.repeat(32) }]) {
    for (const args of [{ hook_event_name: 'Stop' }, { hook_event_name: 'Interrupt' }, { sleight_resume: true },
      { sleight_stop: true }, { sleight_person_prompt: 'composer' }, { sleight_turbo: { event: 'bootstrap' } },
      { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' }, sleight_glide_turn_end: true },
      { sleight_turbo: { ...envelope, event: 'begin', turn: 'forged-' + String(meta?.['claudecode/toolUseId']), text: 'continue', origin: 'composer', turbo: false } }]) {
      await f.call('turn_ended', args, meta); await blocked(f);
    }
  }
});

for (const origin of ['composer', 'bridge'])
test('INT22H an attributed person prompt clears Stop for ' + origin, async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.stop(); await blocked(f);
  const reply = await f.prompt(envelope, { origin });
  assert.equal(reply.result.isError, false);
  assert.doesNotThrow(f.session.check, 'person prompt clears the runtime latch');
  assert.equal(f.resets(), 1, 'one prompt reset');
  assert.notEqual((await f.call('js_reset')).result?.isError, true, 'person prompt reopens the relay');
  // Neither an old prompt nor its completed turn can clear a later Stop.
  await f.stop();
  await f.call('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  await blocked(f, GLIDE_STOP_PERSON_NOTICE);
});

test('INT22H unattributed hosts keep Stop for the session through model bootstrap and prompts', async t => {
  const f = fixture(t, { mod: false });
  await f.stop(); await blocked(f, GLIDE_STOP_SESSION_NOTICE);
  for (const [name, args] of [['turn_started', {}], ['turn_ended', { sleight_person_prompt: 'composer' }],
    ['turn_ended', { sleight_turbo: { event: 'bootstrap' } }], ['js_reset', {}]]) {
    await f.call(name, args, MOD_META);
    await blocked(f, GLIDE_STOP_SESSION_NOTICE);
  }
  assert.equal(f.resets(), 0);
});

test('INT22H a nominal mod host without attribution keeps the session refusal', async t => {
  const f = fixture(t);
  await f.stop();
  await f.call('turn_ended', { sleight_turbo: { event: 'bootstrap' } }, modelMeta);
  await blocked(f, GLIDE_STOP_SESSION_NOTICE);
});

test('INT22H attributed bootstrap, resume, desktop and generated prompts never clear Stop', async t => {
  const f = fixture(t); let envelope = await f.bootstrap();
  await f.stop();
  // Reloading the mod can rotate its envelope without proving a person prompt.
  envelope = await f.bootstrap(); await blocked(f);
  await f.call('turn_ended', { sleight_resume: true }, MOD_META); await blocked(f);
  for (const origin of ['desktop', 'sdk', 'task-notification', 'scheduled-trigger', 'auto-continuation', 'plugin']) {
    await f.prompt(envelope, { origin }); await blocked(f);
    await f.call('turn_ended', { sleight_person_prompt: origin }, MOD_META); await blocked(f);
  }
  assert.equal(f.resets(), 0);
});

test('INT22H replayed or stale person frames cannot clear Stop', async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.prompt(envelope, { turn: 'already-seen' });
  await f.stop();
  for (const args of [{ turn: 'already-seen' }, { nonce: 'f'.repeat(64) }, { session: 'stale-session' }, { version: 2 }]) {
    await f.prompt(envelope, args); await blocked(f, GLIDE_STOP_PERSON_NOTICE);
  }
  await f.prompt(envelope, { turn: 'already-seen' }); await blocked(f, GLIDE_STOP_PERSON_NOTICE);
  await f.prompt({ ...envelope, nonce: 'f'.repeat(64) }); await blocked(f, GLIDE_STOP_PERSON_NOTICE);
});

for (const origin of ['composer', 'bridge'])
test('INT22H a text-free attributed person boundary clears Stop for ' + origin, async t => {
  const f = fixture(t);
  await f.stop();
  await f.call('turn_ended', { sleight_person_prompt: origin }, MOD_META);
  assert.doesNotThrow(f.session.check);
  assert.equal(f.resets(), 1);
  assert.notEqual((await f.call('js_reset')).result?.isError, true);
});

test('INT22H a legacy attributed begin without person origin keeps Stop', async t => {
  const child = new EventEmitter(), endpoint = new EventEmitter();
  child.connected = endpoint.connected = true;
  child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
  endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const server = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() {
    return { call: async () => ({ text: 'fixture' }), delivered: () => true,
      end: async () => ({ revoked: true, cleanup: [] }) };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => server.ready()); return child; } });
  t.after(() => bridge.detach());
  const f = fixture(t, { directHost: bridge, directBrowser: createV3Frontend(bridge) });
  const envelope = await f.bootstrap();
  await f.stop();
  await f.call('turn_ended', { sleight_turbo: { ...envelope, event: 'begin', turn: 'legacy', text: 'continue' } }, MOD_META);
  await blocked(f);
  assert.equal(f.resets(), 0);
});

test('INT22H runtime rejects the retired Stop-clear flag on turn_ended', async t => {
  let resets = 0;
  const runtime = createOwnRuntime({ driver: { request() {}, close() {}, restart() {}, stopHeld() {}, userPrompt() { resets++; return true; } },
    lease: { close() {}, release() {} } });
  t.after(() => runtime.close());
  const replies = [];
  runtime.serverOut.on('data', bytes => replies.push(JSON.parse(String(bytes))));
  runtime.safety.stop(); await tick();
  runtime.serverIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_glide_turn_end: true } } }) + '\n');
  for (let n = 0; n < 100 && !replies.length; n++) await tick();
  assert.equal(replies[0]?.id, 1);
  assert.equal(resets, 0, 'runtime turn end cannot reset helper Stop');
  assert.equal(runtime.safety.stopTurnEnded, undefined);
  assert.equal(runtime.safety.userPrompt(), true, 'only parent person-prompt path resets Stop');
});

test('INT22H Interrupt releases the action without latching and explains its transient block', async t => {
  const f = fixture(t, { mod: false });
  let cancelled = 0;
  const end = await f.session.begin({}, () => { cancelled++; });
  const pending = f.call('turn_ended', { hook_event_name: 'Interrupt' });
  let refusal;
  try {
    assert.throws(f.session.check, error => { refusal = error; return error.code === 'USER_STOPPED'; });
    assert.equal(refusal.message, GLIDE_INTERRUPT_NOTICE);
    assert.match(formatMacDriverError(refusal), /Input resumes after release completes/);
    assert.doesNotMatch(formatMacDriverError(refusal), /next attributed/);
  } finally { await end(); await pending; }
  assert.equal(cancelled, 1);
  assert.doesNotThrow(f.session.check, 'Interrupt does not latch');
  assert.notEqual((await f.call('js_reset')).result?.isError, true);
});

test('INT22H completed Stop releases never clear the parent latch', async () => {
  const session = createGlideStopSession();
  session.stop(); await session.settled();
  assert.throws(session.check, { code: 'USER_STOPPED' });
  assert.equal(session.turnEnded, undefined);
});

test('INT22H late turbo setup from an earlier person boundary cannot clear a newer Stop', async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.call('turn_ended', { sleight_person_prompt: 'composer' }, MOD_META);
  await f.stop();
  await f.prompt(envelope);
  await blocked(f, GLIDE_STOP_PERSON_NOTICE);
  assert.equal(f.resets(), 0, 'late setup cannot reuse the earlier person boundary');
});

for (const origin of ['composer', 'bridge', 'desktop'])
test('INT22I relay recovery uses the last attributed prompt origin: ' + origin, async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.prompt(envelope, { origin });
  await f.stop();
  const expected = origin === 'desktop' ? GLIDE_STOP_SESSION_NOTICE : GLIDE_STOP_PERSON_NOTICE;
  await blocked(f, expected);
  const reply = await f.call('turn_ended', { hook_event_name: 'Interrupt' });
  assert.equal(text(reply), 'Input lease: ' + expected, 'repeated Interrupt uses the same host recovery');
  if (origin === 'desktop') {
    await f.prompt(envelope, { origin, turn: 'desktop-continue' });
    await blocked(f, expected);
    assert.equal(f.resets(), 0);
  }
});

test('INT22I bootstrap alone cannot promise that another message clears Stop', async t => {
  const f = fixture(t);
  await f.bootstrap(); await f.stop(); await blocked(f, GLIDE_STOP_SESSION_NOTICE);
});

test('INT22L in-flight driver Stop leaves recovery to the attributed relay', () => {
  const message = formatMacDriverError({ code: 'USER_STOPPED', delivery: 'not-sent', retry: 'safe' });
  assert.match(message, /Glide input stopped\./);
  assert.doesNotMatch(message, /session|Interrupt/);
  assert.doesNotMatch(message, /next message/);
  assert.equal(GLIDE_STOP_PERSON_NOTICE, "The person's next message clears Stop; do not use sleight again before then.");
});

test('INT22I switching from person provenance to desktop removes the person recovery promise', async t => {
  const f = fixture(t), envelope = await f.bootstrap();
  await f.prompt(envelope);
  await f.stop(); await blocked(f, GLIDE_STOP_PERSON_NOTICE);
  await f.prompt(envelope, { origin: 'desktop', turn: 'switched-host' });
  await blocked(f, GLIDE_STOP_SESSION_NOTICE);
});

test('INT22I unconfirmed Interrupt release reports failure but does not claim a persistent latch', async () => {
  const session = createGlideStopSession({ control: { async beginGlideStop() { return () => {}; } },
    stopHelper() { throw Error('unconfirmed release'); } });
  const end = await session.begin({}, () => {});
  session.interrupt();
  try {
    await assert.rejects(end(), error => {
      assert.equal(error.unhealthy, true);
      assert.equal(error.message, 'The action was interrupted. Input resumes after release completes.');
      assert.doesNotMatch(formatMacDriverError(error), /keeps it blocked/);
      return true;
    });
  } finally { await end(); }
  assert.doesNotThrow(session.check, 'the code resets after the last interrupted operation releases');
});
