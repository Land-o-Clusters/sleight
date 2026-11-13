import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createGlideStopSession } from '../plugins/sleight/lib/mac-driver/stop.mjs';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';
import { runScript } from '../plugins/sleight/lib/launch.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function variant(path, before, after, name) {
  const url = new URL(path, import.meta.url), source = readFileSync(url, 'utf8');
  let mutated = source;
  for (const [from, to] of Array.isArray(before) ? before : [[before, after]]) {
    assert.ok(mutated.includes(from), 'missing mutation anchor: ' + from);
    mutated = mutated.replace(from, to);
  }
  const changed = mutated.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
    (_, prefix, quote, relative) => prefix + quote + new URL(relative, url).href + quote)
    .replace(/new URL\((['"])(\.[^'"]+)\1,\s*import.meta.url\)/g,
      (_, quote, relative) => `new URL(${JSON.stringify(new URL(relative, url).href)})`);
  return (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64')))[name];
}

function relayFixture(create = createRelay, mod = false) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const replies = [], forwarded = [];
  let click, reported = false;
  const session = createGlideStopSession({ control: { async beginGlideStop(_, stop) { click = stop; return () => {}; } } });
  clientOut.on('data', bytes => replies.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => {
    for (const line of String(bytes).trim().split('\n')) {
      const row = JSON.parse(line); forwarded.push(row);
      if (row.params?.arguments?.sleight_glide_turn_end) session.userPrompt();
      if (row.id !== undefined) serverOut.write(JSON.stringify({ id: row.id, result: { content: [] } }) + '\n');
    }
  });
  const relay = create({ clientIn, clientOut, serverIn, serverOut, nativeMac: true, modHost: () => mod,
    nativeSession: { ...session, setPolicy() {} },
    changeReview: false, idleTurnEndMs: 0, stopGraceMs: 1, stderr: { write() {} },
    stopEngine: async () => { await session.settled(); return { collected: true }; },
    restartEngine: async () => ({ serverIn, serverOut }), inspectRelease: async () => ({ ok: true }),
    onStopReported: () => { reported = true; } });
  let next = 0;
  return { session, forwarded,
    async personStop() {
      const end = await session.begin({}, () => {}); click(); await end();
      for (let i = 0; i < 50 && !reported; i++) await tick();
      assert.equal(reported, true, 'the person control collected the stopped runtime');
    },
    async call(name, args = {}, meta) {
      const id = ++next;
      clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args, ...meta ? { _meta: meta } : {} } }) + '\n');
      for (let i = 0; i < 50 && !replies.some(row => row.id === id); i++) await tick();
      const reply = replies.find(row => row.id === id);
      assert.ok(reply, 'relay replied to ' + name); return reply;
    },
    close() { relay.dispose(); streams.forEach(stream => stream.destroy()); },
  };
}

async function modelEndAfterStop(create = createRelay, mod = false, bootstrap = false) {
  const f = relayFixture(create, mod);
  try {
    if (bootstrap) await f.call('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
    await f.personStop();
    await f.call('turn_ended', { hook_event_name: 'Stop' });
    assert.throws(f.session.check, { code: 'USER_STOPPED' }, 'a model Stop hook must preserve the person Stop');
    const reply = await f.call('js_reset');
    assert.equal(reply.result.isError, true, 'model turn end cannot restart input');
    assert.match(reply.result.content[0].text, /Stop lasts for this session; start a new session to continue\./);
    assert.equal(reply.result.content[0].text.split('\n').length, 1);
    for (const args of [{}, { hook_event_name: 'Stop', session_id: 'known', turn_id: 'known' },
      { sleight_resume: true }, { hook_event_name: 'Stop', sleight_glide_turn_end: true }]) {
      const response = await f.call('turn_ended', args);
      if (Object.hasOwn(args, 'sleight_resume')) assert.equal(response.result?.isError, true, 'model resume cannot reopen input or enter its private path');
      assert.throws(f.session.check, { code: 'USER_STOPPED' });
      assert.equal((await f.call('js_reset')).result.isError, true, 'model resume cannot reopen input');
    }
  } finally { f.close(); }
}
test('a model-called turn_ended on a no-mod host cannot clear a person Stop', () => modelEndAfterStop());
test('a nominal mod host without mod attribution keeps Stop for the session', () => modelEndAfterStop(createRelay, true));
test('a model bootstrap cannot hide the session-long Stop refusal', () => modelEndAfterStop(createRelay, true, true));
test('broken bootstrap-only attribution of the Stop refusal is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/relay.mjs', [
    ['privateFrame && (!modAttributed(msg) || disposed', 'privateFrame && (false || disposed'],
    ['installedBootstrapped = true;', 'installedBootstrapped = true; modPersonPromptAttributable = true;'],
  ], undefined, 'createRelay');
  await assert.rejects(modelEndAfterStop(create, true, true), /start a new session/);
});
test('broken bare-resume protection is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/relay.mjs', [
    ['privateFrame && (!modAttributed(msg) || disposed', 'privateFrame && (!args.sleight_resume && !modAttributed(msg) || disposed'],
    ['!(nativeRuntime && closing)', 'true'],
  ], undefined, 'createRelay');
  await assert.rejects(modelEndAfterStop(create), /model resume cannot reopen input/);
});

async function modelEndWhileOpen(create = createRelay) {
  const f = relayFixture(create);
  try {
    await f.call('js_reset'); f.session.stop(); await f.session.settled();
    await f.call('turn_ended', { hook_event_name: 'Stop' });
    assert.throws(f.session.check, { code: 'USER_STOPPED' }, 'unattributed end metadata must not clear Stop');
    assert.ok(f.forwarded.some(row => row.params?.name === 'turn_ended'));
    assert.ok(f.forwarded.filter(row => row.params?.name === 'turn_ended')
      .every(row => !Object.hasOwn(row.params.arguments, 'sleight_glide_turn_end')));
    assert.ok(f.forwarded.filter(row => row.params?.name === 'turn_ended')
      .every(row => row.params.arguments.sleight_clipboard_turn_end === true), 'clipboard lifecycle behavior is unchanged');
  } finally { f.close(); }
}
test('unattributed ends forwarded to the runtime never carry Stop-clear authority', () => modelEndWhileOpen());
test('broken generic turn-end authority is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/relay.mjs',
    "      // The mod and Codex's hooks send Stop or Interrupt.",
    "      sleight_glide_turn_end: !closing,\n      // The mod and Codex's hooks send Stop or Interrupt.", 'createRelay');
  await assert.rejects(modelEndWhileOpen(create), /unattributed end metadata/);
});

async function attributedEnd(create = createRelay) {
  const f = relayFixture(create, true);
  try {
    const bootstrap = await f.call('turn_ended', { sleight_turbo: { event: 'bootstrap' } },
      { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) });
    const envelope = JSON.parse(bootstrap.result.content[0].text).sleightTurbo;
    await f.personStop();
    const args = { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } };
    const meta = { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) };
    for (const [badArgs, badMeta] of [[args, undefined], [args, { 'claudecode/toolUseId': 'toolu_model' }],
      [{ ...args, sleight_turbo: { ...args.sleight_turbo, nonce: 'wrong' } }, meta]]) {
      await f.call('turn_ended', badArgs, badMeta);
      assert.throws(f.session.check, { code: 'USER_STOPPED' });
    }
    await f.call('turn_ended', args, meta);
    assert.throws(f.session.check, { code: 'USER_STOPPED' }, 'even an authenticated mod end keeps Stop');
    assert.equal((await f.call('js_reset')).result?.isError, true);
  } finally { f.close(); }
}
test('an attributed mod end preserves the collected Stop', () => attributedEnd());
test('broken attributed end clearing is rejected', async () => {
  const create = await variant('../plugins/sleight/lib/relay.mjs',
    "    if (closing && msg.method === 'tools/call') {",
    "    if (closing && stopFinished && modAttributed(msg) && modEndFrame(msg.params?.arguments)) { nativeSession.userPrompt(); glideStopLatched = false; resumeRequested = true; resumeAfterStop(); }\n    if (closing && msg.method === 'tools/call') {", 'createRelay');
  await assert.rejects(attributedEnd(create));
});

async function earlyRunnerSettlement(t, create = createDragViaDriver, settledAt = 450, stallRelease = false, childDies = false, verifyReceipt = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter(), events = [];
  child.exitCode = null; child.signalCode = null;
  let click, complete, began;
  const started = new Promise(resolve => { began = resolve; });
  const bound = { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fake', title: 'fixture', identityVerified: true };
  child.kill = signal => {
    events.push(signal);
    if (signal === 'SIGKILL') { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal); }
    return true; // SIGTERM is deliberately ignored.
  };
  const run = create({ current() {}, bindings: async () => ({ source: bound }), runLocal: runScript,
    driver: { resolveApp: async () => ({ app: { id: bound.bundleId, pid: 42, processStart: '1.2', running: true } }),
      verifyWindowIdentity: async () => ({ window: bound }),
      releasePostedInput: async () => { events.push('release'); return stallRelease ? new Promise(() => {}) : 'posted'; } },
    beginStop: async (_, stop) => { click = stop; return () => {}; } });
  const call = run('drag.js', { app: bound.bundleId, windowId: 7, from: [1, 1], to: [2, 2] }, {
    run(_, args, options, callback) {
      assert.ok(options.timeout > 0);
      const path = JSON.parse(args[5].match(/,("[^"]+")\);$/)[1]);
      writeFileSync(path + '.holds', JSON.stringify([{ key: 56 }]));
      complete = () => callback(null, JSON.stringify({ ok: true, windowId: '7', path: 'background' }), '');
      began(); return child;
    },
  });
  let stoppedError;
  const refused = assert.rejects(call, error => { stoppedError = error; return error.code === 'USER_STOPPED'; });
  try {
    await started; click();
    if (settledAt >= 400) {
      t.mock.timers.tick(400); await tick(); assert.deepEqual(events, ['SIGSTOP', 'release']);
      t.mock.timers.tick(settledAt - 400);
    } else t.mock.timers.tick(settledAt);
    if (childDies) { child.exitCode = 1; child.emit('exit', 1); child.emit('close', 1); }
    else child.kill('SIGTERM');
    complete();
    if (stallRelease) { await tick(); t.mock.timers.tick(500 - settledAt); }
    await refused;
    if (verifyReceipt) {
      assert.equal(stoppedError.stopRelease, 'posted', 'early release receipt must survive settlement');
      assert.equal(stoppedError.stopHelperRetired, true);
      assert.match(stoppedError.message, /stopRelease=posted/);
    }
    assert.equal(child.signalCode, childDies ? null : 'SIGKILL', 'early runLocal resolution must retire the frozen child');
    assert.deepEqual(events, childDies ? ['release'] : settledAt >= 400 ? ['SIGSTOP', 'release', 'SIGTERM', 'SIGKILL'] : ['SIGTERM', 'SIGSTOP', 'release', 'SIGKILL']);
    t.mock.timers.tick(500 - settledAt);
    assert.equal(events.filter(signal => signal === 'SIGKILL').length, childDies ? 0 : 1);
    assert.equal(events.filter(signal => signal === 'release').length, 1, 'recorded holds must be released exactly once');
  } finally {
    t.mock.timers.tick(500); complete?.(); await refused.catch(() => {});
    if (!child.signalCode) child.emit('close', 0);
    t.mock.timers.reset();
  }
}
test('the launcher retires a frozen SIGTERM-ignoring child when runLocal settles before 500 ms', earlyRunnerSettlement);
test('early settlement before 400 ms releases recorded holds before child retirement', t => earlyRunnerSettlement(t, createDragViaDriver, 100));
test('a stalled release transport after early settlement still retires its child by 500 ms', t => earlyRunnerSettlement(t, createDragViaDriver, 100, true));
test('broken early-settlement child retirement is rejected', async t => {
  const create = await variant('../plugins/sleight/lib/drag-via-driver.mjs',
    'if (stopped) {', 'if (false) {', 'createDragViaDriver');
  await assert.rejects(earlyRunnerSettlement(t, create), /early runLocal resolution must retire/);
});

test('INT22D a stopped child that dies before 400 ms still releases its holds exactly once', async t => {
  const create = process.env.INT22D_MUTANT === 'c' ? await variant('../plugins/sleight/lib/drag-via-driver.mjs',
    'if (stopped) {', 'if (stopped && !childExited && !childRetired) {', 'createDragViaDriver') : createDragViaDriver;
  await earlyRunnerSettlement(t, create, 100, false, true);
});

test('INT22D early settlement reports its posted release and helper retirement', async t => {
  const create = process.env.INT22D_MUTANT === 'f-receipt' ? await variant('../plugins/sleight/lib/drag-via-driver.mjs',
    'if (failure) {', 'if (false) {', 'createDragViaDriver') : createDragViaDriver;
  await earlyRunnerSettlement(t, create, 100, false, false, true);
});

test('INT22D a new Stop replaces a transient interruption', async () => {
  const create = process.env.INT22D_MUTANT === 'f-stale' ? await variant('../plugins/sleight/lib/mac-driver/stop.mjs',
    'stopped = true; interrupted = false;', 'stopped = true; interrupted = true;', 'createGlideStopSession') : createGlideStopSession;
  let ready = false;
  const session = create({ resetHelper: () => ready });
  session.interrupt();
  session.stop(); ready = true;
  await session.settled();
  assert.throws(session.check, { code: 'USER_STOPPED' }, 'the old turn cannot clear the new Stop');
});

test('INT22D a bootstrapped mod does not attribute a model turn_ended', async () => {
  const f = relayFixture(createRelay, true);
  try {
    const meta = { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) };
    const boot = await f.call('turn_ended', { sleight_turbo: { event: 'bootstrap' } }, meta);
    assert.equal(boot.result.isError, false);
    const envelope = JSON.parse(boot.result.content[0].text).sleightTurbo;
    await f.personStop();
    const model = await f.call('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } },
      { 'claudecode/toolUseId': 'toolu_' + 'b'.repeat(24) });
    assert.equal(model.result.isError, true);
    assert.equal(model.result.content[0].text, 'Trusted turn binding unavailable.');
    assert.match((await f.call('js_reset')).result.content[0].text, /start a new session/);
    assert.throws(f.session.check, { code: 'USER_STOPPED' });
  } finally { f.close(); }
});
