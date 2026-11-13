import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import * as provider from './fixtures/windows-driver-fake.mjs';
import { verifyWindowIdentity, windowBinding } from '../plugins/sleight/lib/windows-repl/identity.mjs';
import { RAW_SCHEMA, collectorPlan, parseCollectArgs, casePresence, assertFixture,
  parseGuestLines, projectReply, waitForGo, collectRow, measureGuestTrial, main, createGuestBackend,
  assertVmIdentity, instrumentedClient, runCancelTrial, runDirectTrial, createGuestInspector, guestFixtureSource,
  GUEST_OPERATIONS, GUEST_FIXTURE, FIXTURE_LAUNCHER, proveFixtureLaunch } from '../bench/windows/uc3f-collect.mjs';
import { syntheticObserver } from './fixtures/uc3f-observer-synthetic.mjs';
import * as collector from '../bench/windows/uc3f-collect.mjs';

const source = readFileSync(new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), 'utf8');
const observerFixture = readFileSync(new URL('./fixtures/uc3f-observer-lines.jsonl', import.meta.url), 'utf8');
const revision = 'a'.repeat(40), now = Date.parse('2026-11-02T01:00:00.000Z');
const lease = (presence, row = 'person-key-before') => ({ presence, row, token: 'c'.repeat(32),
  issuedUtc: new Date(now).toISOString(), expiresUtc: new Date(now + 900000).toISOString() });
const refusal = (code, extra = {}) => Object.assign(Error('PRIVATE EXCEPTION'), { code, ...extra });
const expected = [
  ['person-idle', [['notepad', 50], ['wpf', 50], ['calculator-refused', 10], ['background-word', 20]]],
  ['person-key-before', [['scheduled-key', 20]]], ['person-key-during', [['typing', 10]]],
  ['lock-refused', [['read', 10], ['capture', 10], ['action', 10], ['unlocked-action', 50], ['wts-query', 1000], ['flags', 1]]],
  ['lock-during-type', [['typing', 10]]], ['screensaver-refused', [['screensaver', 5]]], ['session-switch-refused', [['switch', 5]]],
  ['uac-refused', [['prompt', 10], ['idle-probe', 100], ['idle-action', 50]]], ['uac-hint', [['raised-prompt', 10]]],
  ['escape-stop-hardware', [['hardware', 10]]], ['escape-ignored-injected', [['injected', 10]]], ['escape-ignored-posted', [['posted', 10]]],
  ['cancel-frame', [['cancel-first', 5], ['job-first', 5]]],
  ...['direct-launch-terminal', 'direct-launch-override'].map(id => [id,
    ['direct-terminal', 'parent-terminal', 'direct-settings', 'parent-settings'].map(c => [c, 10])]),
  ['browser-refused-edge', [['name', 10], ['hwnd', 10], ['notepad', 50], ['wpf', 100]]],
  ['browser-refused-firefox', [['name', 10], ['hwnd', 10]]], ['browser-refused-renamed', [['renamed', 10]]],
  ['checkpoint-cost', [...['session-probe', 'lock-check', 'desktop-check', 'person-input', 'budget-check', 'hook-install', 'hook-remove'].map(c => [c, 50]), ['hook-callback', 100]]],
];
const fixtures = () => ['notepad', 'calculator-refused', 'wpf', 'terminal', 'edge', 'firefox', 'cover'].map((target, n) => ({
  ...provider.fakeWindows[n === 1 ? 1 : 0], target, windowId: String(101 + n), pid: 41 + n,
  processStart: String(BigInt(provider.fakeWindows[0].processStart) + BigInt(n)),
  title: `fixture-${target}`, image: `C:\\fixtures\\${target}.exe`, className: 'Fixture',
}));
const count = { postedMessages: 0, patternCalls: 0, uiaFetches: 0, captures: 0, finalReads: 0 };
const injection = (tick, operation, key) => JSON.stringify({ schema: 'sleight.windows-uc3f-inject/1', kind: 'injector', invocation: '2',
  operation, key: operation === 'key' ? key === 'escape' ? 'escape' : 'other' : 'none', tickMs: tick, eventTickMs: tick % 0x100000000,
  vk: operation === 'key' ? key === 'escape' ? 27 : 81 : 0, sentInputs: operation === 'key' ? 2 : 0, code: 'OK' }) + '\n';

// Base G3 predates UC3A/B. Reuse UC3A's safety fixture when integrated; these
// in-memory transport scenarios keep the base tests independent of other lanes.
function memoryBackend(options = {}) {
  let clock = now, tick = 100, activeScenario, context, currentLease, observerStart;
  const owned = fixtures(), events = [], raw = new Map(), actions = [], closes = [], scenarios = new Set();
  const client = { pid: 909, request: async (method, params) => {
    events.push(`request:${method}`);
    if (context?.caseId === 'calculator-refused')
      throw refusal('HOSTED_APP_UNRESOLVED', { counters: { ...count } });
    const w = owned.find(f => f.windowId === params.windowId);
    if (activeScenario) {
      scenarios.add(activeScenario);
      if (provider.windowsSafetyFixture && ['person', 'locked', 'secure'].includes(activeScenario)) {
        const at = method === 'getAXState' ? 'read' : 'admission';
        const r = provider.windowsSafetyFixture({ scenario: activeScenario }).run(at);
        if (r.code) throw refusal(r.code, { ...r, counters: { ...count } });
      } else if (activeScenario !== 'slow-type' && !(activeScenario === 'person' && method === 'getAXState')) {
        const [code, reason] = activeScenario === 'person' ? ['PERSON_TOOK_OVER', 'person-active'] :
          activeScenario === 'locked' ? ['SCREEN_LOCKED', 'session-locked'] : ['SECURE_DESKTOP_ACTIVE', 'secure-desktop'];
        throw refusal(code, { reason, delivery: 'not-sent', retry: 'safe', unhealthy: false, counters: { ...count } });
      }
    }
    if (method === 'typeText' || method === 'click' || method === 'stuckMenuEscape') {
      actions.push({ method, params });
      if (activeScenario === 'slow-type' || context.rowId === 'escape-stop-hardware')
        throw refusal(context.rowId === 'person-key-during' ? 'PERSON_TOOK_OVER' : context.rowId === 'lock-during-type' ? 'SCREEN_LOCKED' : 'USER_STOPPED',
          { reason: context.rowId === 'person-key-during' ? 'person-active' : context.rowId === 'lock-during-type' ? 'session-locked' : 'escape',
            typed: 128, delivery: 'sent-unverified', retry: 'read-first', unhealthy: false, counters: { ...count, postedMessages: 128 } });
    }
    return { window: w, readId: 1, text: '0 standard window fixture\n1 text area Editor, ID: Editor, Value: PRIVATE\n2 button Seven, ID: num7Button\n3 button Prompt, ID: UacButton',
      screenshot: { data: 'iVBORw0KGgoPRIVATE' }, counters: { ...count }, typed: 200, elapsedMs: 9999,
      ...options.cost ? { checkpointTimings: { [context.caseId]: context.caseId === 'hook-callback' ? { elapsedUs: 3.5 } :
        { elapsedMs: 0.75 } } } : {} };
  } };
  const backend = {
    events, raw, actions, closes, scenarios, owned,
    now: () => clock, tick: () => tick++, sleep: async ms => { clock += ms; events.push('sleep'); },
    guard: async () => { events.push('guard'); if (options.hold && actions.length) throw refusal('TIMED_WINDOW_HOLD'); },
    lease: async () => options.expired ? { ...currentLease, expiresUtc: new Date(now).toISOString() } : currentLease,
    preflight: async () => { events.push('preflight'); if (options.preflight) throw refusal(options.preflight); },
    setup: async (_row, { register }) => { for (const f of owned) { register(f); if (options.partialSetup) throw refusal('SETUP_FAILED'); } },
    inspect: async f => options.foreign ? { ...f, pid: 999 } : options.recycled ? { ...f, processStart: '134059077770009999' } : { ...f },
    startObserver: async () => {
      events.push('observer'); observerStart = tick++;
      const observerLease = await backend.lease();
      return { ready: !options.notReady, invocation: '1', finish: async () => {
        events.push('observer-finish');
        const template = parseGuestLines(observerFixture, 'observer');
        const start = { ...template[0], rowId: observerLease.row, rowToken: observerLease.token, tickMs: observerStart, leaseExpiresUtc: new Date(now + 900000).toISOString() };
        const poll = template.find(r => r.kind === 'poll');
        const rows = [start, ...Array.from({ length: tick - observerStart + 1 }, (_, n) => ({ ...poll, tickMs: observerStart + n, pollCount: n + 1 })),
          { ...template.at(-1), tickMs: tick + 1 }];
        const end = rows.at(-1); end.records = rows.length; end.pollCount = rows.at(-2).pollCount;
        rows.forEach((r, n) => { r.seq = n + 1; });
        if (options.badHook) end.hookRemoved = end.mouseHookRemoved = false;
        if (options.truncated) end.truncated = true;
        return rows.map(r => JSON.stringify(r)).join('\n');
      } };
    },
    readGo: async () => { events.push('go'); return !options.noGo; },
    measure: async c => {
      context = c; activeScenario = undefined;
      events.push(`measure:${c.caseId}`);
      const io = { checkpointTimingProducer: options.cost === true, client: async () => client, sleep: backend.sleep, pe: () => ({ originalFilenamePreserved: true, productNamePreserved: true }),
        retainedReadId: () => 1, requireDefaultDesktop: async () => {},
        settings: async f => c.rebindSettings(f, { ...f, title: 'Settings', refused: 'FORBIDDEN_SETTINGS' }),
        raisePrompt: async () => { activeScenario = 'secure'; },
        arm: async (operation, _target, { key }) => ({ invocation: '2', go: async () => {
          events.push('injector-go');
          activeScenario = operation === 'key' ? c.rowId === 'person-key-before' ? 'person' : 'slow-type' : 'locked';
          scenarios.add(activeScenario);
        }, finish: async () => injection(tick++, operation, key) }),
        recover: async () => { events.push('recover'); activeScenario = undefined; },
        parent: async target => ({ counts: () => ({ cards: 0, leases: 0, contentReads: 0 }), acquire: async () => ({
          tickMs: tick++, replyTickMs: tick++, raw: target.target === 'terminal' ?
            { ok: false, code: 'FORBIDDEN_TARGET', counters: { ...count } } : { ok: false, code: 'BROWSER_TARGET_REFUSED' },
        }) }),
        direct: async (_target, override) => ({ driver: [{ tickMs: tick++, replyTickMs: tick++, raw: {
          ok: override, ...override ? { windowMatched: true } : { code: 'FORBIDDEN_TARGET' }, counters: { ...count } } }],
        parent: { driverPid: 910 }, launch: { source: 'scheduled-direct', override, nonceSha256: 'b'.repeat(64) } }),
        cancel: async () => { scenarios.add('slow-type'); return { driver: [{ tickMs: tick++, replyTickMs: tick++, raw: {
          ok: false, code: 'USER_STOPPED', reason: 'cancel', typed: 128, counters: { ...count } } }],
        parent: { jobId: 1, jobReplyId: 1, cancelId: 2, cancelReplyId: 2, flagMs: 1 } }; },
      };
      const result = await (options.measure ?? measureGuestTrial)(c, io);
      if (options.expireAfterMeasure) currentLease = { ...currentLease, expiresUtc: new Date(now).toISOString() };
      if (options.dirtyRaw) { result.windowTitle = 'PRIVATE'; result.driver[0].raw.screenshot = 'iVBORw0KGgoPRIVATE'; }
      return result;
    },
    removeTasks: async () => { events.push('remove-tasks'); if (options.taskFailure) throw refusal('TASK_CLEANUP_UNPROVED'); },
    closeFixture: async f => { closes.push(f); events.push('close-fixture'); },
    removeRenamedCopy: async () => { events.push('remove-copy'); }, closeClients: async () => { events.push('close-clients'); },
    cleanupCheck: async ({ hookRemoved }) => ({ tasks: options.leftoverTask ? ['task'] : [], fixturePids: [],
      bankFiles: options.leftoverFile ? ['unknown'] : [], renamedCopies: options.leftoverCopy ? ['native-fixture.exe'] : [],
      hookRemoved, sessionRestored: !options.lockLeft }),
    writeRaw: async (id, records) => { raw.set(id, records.map(r => JSON.stringify(r)).join('\n') + '\n'); },
    run: async (rowId, extra = {}) => {
      const ownerAway = rowId === 'person-idle' || !collectorPlan([rowId])[0].cases.some(c => c.presence === 'present');
      currentLease = lease((extra.ownerAway ?? ownerAway) ? 'away' : 'present', rowId);
      return (options.collect ?? collectRow)({ rowId, revision, ownerAway, rowToken: currentLease.token, ...extra }, backend);
    },
  };
  return backend;
}

test('UC3E layout has 19 rows, 47 cases and 2201 observations, independent of pass expectations', () => {
  const plan = collectorPlan();
  assert.deepEqual(plan.map(r => [r.id, r.cases.map(c => [c.id, c.trials])]), expected);
  assert.equal(plan.length, 19);
  assert.equal(plan.flatMap(r => r.cases).length, 47);
  assert.equal(plan.flatMap(r => r.cases).reduce((n, c) => n + c.trials, 0), 2201);
  assert.equal(plan.at(-1).measurementOnly, 'bounds not registered');
  assert.equal(plan.at(-1).skip, undefined);
  for (const ids of [[], ['unknown'], ['person-idle', 'person-idle']]) assert.throws(() => collectorPlan(ids));
});

for (const [id, cases] of expected) test(`raw ${id} retains grader case IDs and fake counts`, async () => {
  const b = memoryBackend(), result = await b.run(id);
  const rows = b.raw.get(id).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].schema, RAW_SCHEMA);
  const selectedCases = id === 'person-idle' ? cases.slice(0, 3) : cases;
  assert.deepEqual(rows[0].cases.map(c => [c.id, c.trials]), selectedCases);
  const trials = rows.filter(r => r.kind === 'trial');
  assert.equal(result.status, 'recorded', JSON.stringify(result));
  assert.equal(result.trials, selectedCases.reduce((n, [, trials]) => n + trials, 0));
  for (const [caseId, count] of selectedCases) {
    assert.deepEqual(trials.filter(r => r.caseId === caseId).map(r => r.trial), Array.from({ length: count }, (_, n) => n));
  }
  assert.equal(result.hookRemoved, true);
  assert.deepEqual(Object.keys(rows.at(-1)).sort(), ['schema', 'kind', 'rowId', 'trials', 'hookRemoved', 'code'].sort());
  if (id === 'checkpoint-cost') {
    assert.equal(trials.length, 450);
    assert.ok(trials.every(t => t.costSamples.length === 0 && t.unmeasured === 'CHECKPOINT_TIMING_UNAVAILABLE'));
  }
  assert.equal(rows.at(-1).kind, 'end');
  assert.ok(rows.some(r => r.kind === 'observer' && r.observation.kind === 'end'));
  assert.doesNotMatch(b.raw.get(id), /PRIVATE|iVBORw0KGgo|windowTitle|"text"|"screenshot"|"source":"owner-keyboard"/);
  assert.equal(b.closes.length, 0);
});

test('person, locked, secure and slow-type scenarios reach the executor without native calls', async () => {
  const seen = new Set();
  for (const id of ['person-key-before', 'lock-refused', 'uac-refused', 'cancel-frame']) {
    const b = memoryBackend(); await b.run(id); b.scenarios.forEach(s => seen.add(s));
  }
  assert.deepEqual([...seen].sort(), ['locked', 'person', 'secure', 'slow-type']);
});

test('invariant 3: foreign foreground HWND and recycled process refuse with zero posts', async () => {
  for (const options of [{ foreign: true }, { recycled: true }]) {
    const b = memoryBackend(options), result = await b.run('person-key-before');
    assert.equal(result.status, 'fail'); assert.equal(result.code, 'FOREGROUND_NOT_FIXTURE');
    assert.equal(b.actions.length, 0); assert.equal(b.closes.length, 0);
    assert.ok(b.events.includes('close-clients'));
  }
  const owned = fixtures();
  assert.throws(() => assertFixture({ ...owned[0], windowId: '999' }, owned), /FOREGROUND_NOT_FIXTURE/);
  assert.throws(() => assertFixture({ ...owned[0], title: 'other document' }, owned), /FIXTURE_IDENTITY_CHANGED/);
});

// Execute the actual exported pure decision bodies, then remove the exact safety
// check in memory. The same assertions must reject each broken source variant.
function pureFunction(text, name, imports) {
  const match = new RegExp(`export function ${name}\\([^]*?\\n\\}`).exec(text);
  assert.ok(match, name);
  return Function(...Object.keys(imports), match[0].replace('export ', '') + `; return ${name};`)(...Object.values(imports));
}
const throwCode = code => { throw refusal(code); };
const binding = w => { if (!/^[1-9]\d*$/.test(w.windowId) || !/^[1-9]\d*$/.test(w.processStart)) throw Error('binding'); };
test('invariant 3 broken variant: removing fixture membership admits Explorer and the refusal assertion fails', () => {
  const needle = "if (!fixture) fail('FOREGROUND_NOT_FIXTURE');";
  assert.ok(source.includes(needle));
  const mutated = source.replace(needle, 'if (!fixture) return window;');
  const broken = pureFunction(mutated, 'assertFixture', { fail: throwCode, windowBinding: binding });
  const explorer = { ...fixtures()[0], pid: 999, windowId: '999' };
  const check = fn => assert.throws(() => fn(explorer, fixtures()), /FOREGROUND_NOT_FIXTURE/);
  check(assertFixture); assert.throws(() => check(broken), assert.AssertionError);
});

test('present trials wait for distinct owner go files before any measured request', async () => {
  let time = now, checks = 0, go = 0, sleeps = 0;
  await waitForGo({ readGo: async () => ++go === 4, check: async () => { checks++; },
    sleep: async ms => { sleeps++; time += ms; }, clock: () => time });
  assert.equal(checks, 4); assert.equal(sleeps, 3);
  const b = memoryBackend({ noGo: true }), result = await b.run('escape-stop-hardware');
  assert.equal(result.code, 'OWNER_GO_TIMEOUT'); assert.equal(b.actions.length, 0);
  assert.equal(b.events.some(e => e.startsWith('measure:')), false);
  assert.ok(b.events.includes('observer-finish')); assert.equal(b.closes.length, 0);
});

test('presence and split Word cases cannot be relabeled unattended', async () => {
  assert.equal(casePresence('person-idle', 'background-word'), 'present');
  assert.equal(casePresence('person-idle', 'notepad'), 'away');
  for (const rowId of ['lock-refused', 'screensaver-refused', 'session-switch-refused', 'escape-stop-hardware']) {
    const b = memoryBackend();
    await assert.rejects(b.run(rowId, { ownerAway: true }), /OWNER_PRESENT_REQUIRED/);
    assert.equal(b.actions.length, 0);
  }
  const b = memoryBackend(); await assert.rejects(b.run('person-key-before', { ownerAway: false }), /OWNER_AWAY_REQUIRED/);
});

test('observer and injector lines preserve raw flags and reject extra, pixel or malformed fields', () => {
  const lines = parseGuestLines(observerFixture, 'observer');
  assert.ok(lines.some(r => r.kind === 'key' && r.injected));
  const key = lines.find(r => r.kind === 'key');
  for (const change of [{ windowTitle: 'PRIVATE' }, { key: 'q' }, { injected: 'false' }, { screenshot: 'iVBORw0KGgo' }])
    assert.throws(() => parseGuestLines(JSON.stringify({ ...key, ...change }), 'observer'), /RAW_LINE_INVALID/);
  const i = injection(4294967301, 'key', 'escape');
  assert.equal(parseGuestLines(i, 'injector')[0].eventTickMs, 5);
  assert.throws(() => parseGuestLines(i.replace('"sentInputs":2', '"sentInputs":3'), 'injector'));
  assert.throws(() => parseGuestLines('{', 'observer'));
  assert.throws(() => parseGuestLines(JSON.stringify({ ...key, key: 'x'.repeat(300) }), 'observer'));
});

test('raw projection retains observed failures and counters while excluding content and claimed sources', async () => {
  const projected = projectReply({ code: 'PERSON_TOOK_OVER', reason: 'person-active', unhealthy: false, typed: 64,
    delivery: 'sent-unverified', retry: 'read-first', elapsedMs: 0.25, counters: { ...count, ignored: 'PRIVATE' },
    limits: ['secure-desktop-seen', 'PRIVATE'], screenshot: 'PRIVATE', text: 'PRIVATE', source: 'owner-keyboard' }, true);
  assert.equal(projected.typed, 64); assert.equal(projected.elapsedMs, .25); assert.deepEqual(projected.counters, count);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|owner-keyboard/);
  const b = memoryBackend({ dirtyRaw: true }); await b.run('person-key-before');
  assert.doesNotMatch(b.raw.get('person-key-before'), /PRIVATE|windowTitle|screenshot/);
});

test('VM preflight binds QEMU and the two recorded identity hashes', () => {
  const identity = { manufacturer: 'QEMU', model: 'Virtual Machine', hostnameSha256: 'a'.repeat(64), machineGuidSha256: 'b'.repeat(64) };
  assertVmIdentity(identity, { ...identity });
  for (const change of [{ manufacturer: 'Apple' }, { hostnameSha256: 'c'.repeat(64) }, { machineGuidSha256: '' }, { model: 'other' }])
    assert.throws(() => assertVmIdentity({ ...identity, ...change }, identity), /VM_IDENTITY_MISMATCH/);
});

test('imports, dry run and Mac platform refusal start zero processes and write zero banks', async () => {
  let calls = 0, printed = '';
  const deps = { platform: 'darwin', createBackend: () => { calls++; }, print: s => { printed += s; } };
  const plan = await main(['--dry-run'], deps);
  assert.equal(plan.rows.length, 19); assert.equal(calls, 0); assert.match(printed, /dry-run/);
  await assert.rejects(main(['--row', 'person-key-before', '--bank', 'C:\\sleight-setup\\uc3f-0123456789abcdef', '--revision', revision, '--owner-away'], deps), /WINDOWS_REQUIRED/);
  assert.throws(() => createGuestBackend({}, { platform: 'darwin' }), /WINDOWS_REQUIRED/);
  assert.equal(calls, 0);
});

test('CLI rejects arbitrary hosts, HWNDs, scripts, duplicate options and malformed banks', () => {
  const base = ['--bank', 'C:\\sleight-setup\\uc3f-0123456789abcdef', '--revision', revision, '--row', 'person-idle'];
  assert.deepEqual(parseCollectArgs([...base, '--cases', 'notepad,wpf,calculator-refused', '--owner-away']).cases, ['notepad', 'wpf', 'calculator-refused']);
  for (const extra of [['--host', 'other'], ['--hwnd', '101'], ['--script', 'other.ps1'], ['--owner-away', '--owner-away'], ['--cases', 'unknown']])
    assert.throws(() => parseCollectArgs([...base, ...extra]));
  assert.throws(() => parseCollectArgs(['--bank', 'C:\\owner', '--revision', revision, '--row', 'person-idle']));
});

test('instrumentation preserves native reason/counters with fresh product nonces and a closed counter environment', async () => {
  const observed = [];
  let makeHost;
  const fakeSpawn = (_command, _args, options) => {
    observed.push(options.env);
    const child = new EventEmitter(); child.pid = 701; child.stdout = new PassThrough();
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const f = JSON.parse(bytes.toString());
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: f.protocol, nonce: f.nonce, id: f.id, ok: false,
        error: { code: 'PERSON_TOOK_OVER', reason: 'person-active', unhealthy: false, counters: count, typed: 0 } }) + '\n'));
      done();
    } });
    return child;
  };
  const c = instrumentedClient({ directSpawn: fakeSpawn, prepare: async o => { makeHost = o.run; return { status: 'ready' }; },
    createClient: ({ prepare }) => ({ request: async () => {
      await prepare({ kind: 'driver' });
      const child = makeHost('driver.exe', ['--driver'], { env: { SystemRoot: 'C:\\Windows', SLEIGHT_DRIVER_NONCE: '1'.repeat(64) } });
      return new Promise((_, reject) => {
        child.stdout.once('data', () => reject(refusal('PERSON_TOOK_OVER')));
        child.stdin.write(JSON.stringify({ protocol: 'sleight.windows-driver/1', nonce: '1'.repeat(64), id: 1, method: 'typeText', params: {} }) + '\n');
      });
    }, close: async () => {} }) });
  await assert.rejects(c.request('typeText', {}), e => e.reason === 'person-active' && e.typed === 0 && e.counters.postedMessages === 0);
  assert.equal(observed[0].SLEIGHT_DRIVER_COUNTERS, '1');
  assert.equal(observed[0].SLEIGHT_ALLOW_FORBIDDEN_TARGETS, undefined);
  assert.equal(c.frames().filter(f => f.kind === 'reply').length, 1);
  await c.close();
});

test('raw fake artifact can be retained under an ordinary temporary directory', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-uc3f-collect-')));
  const b = memoryBackend(); await b.run('person-key-before');
  const path = join(root, 'person-key-before.jsonl'); writeFileSync(path, b.raw.get('person-key-before'), { flag: 'wx' });
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').filter(s => JSON.parse(s).kind === 'trial').length, 20);
});

for (const order of ['cancel-first', 'job-first']) test(`cancel uses actual native IDs and ${order} wire order`, async () => {
  let tick = 100, jobResolve;
  const trace = [];
  const c = { frames: () => structuredClone(trace), request: async method => {
    if (method === 'typeText') {
      trace.push({ kind: 'sent', method, id: 17, tickMs: tick++ });
      return new Promise(done => { jobResolve = done; });
    }
    assert.equal(method, 'cancel'); trace.push({ kind: 'sent', method, id: 18, tickMs: tick++ });
    const j = () => { trace.push({ kind: 'reply', method: 'typeText', id: 17, tickMs: tick++ }); jobResolve({ typed: 64 }); };
    const r = () => trace.push({ kind: 'reply', method, id: 18, tickMs: tick++ });
    if (order === 'cancel-first') { r(); j(); } else { j(); r(); }
    return { cancelled: 17, inFlight: true };
  } };
  const result = await runCancelTrial({ client: c, target: fixtures()[0], readId: 1, order,
    tick: () => tick++, now: () => now, sleep: async () => {}, check: async () => {} });
  assert.deepEqual([result.parent.jobId, result.parent.jobReplyId, result.parent.cancelId, result.parent.cancelReplyId], [17, 17, 18, 18]);
  assert.equal(result.unmeasured, undefined);
  assert.equal(result.driver[1].raw.cancelled, 17);
});

test('warm identity worker checks its private nonce and closes its own pipe without launching a host', async () => {
  let captured = '', writes = 0;
  const spawnChild = (_command, args, options) => {
    assert.equal(options.shell, false); assert.ok(args.includes('-NonInteractive'));
    const nonce = args.at(-1), child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const frame = JSON.parse(bytes.toString()); writes++;
      assert.equal(frame.nonce, nonce);
      queueMicrotask(() => child.stdout.write(JSON.stringify({ nonce, id: frame.id, ok: true, value: { pid: frame.fixture.pid } }) + '\n'));
      done();
    }, final(done) { child.emit('close', 0); done(); } });
    child.kill = () => { assert.fail('a normal close must use EOF'); };
    return child;
  };
  const inspector = createGuestInspector({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', executable: 'powershell.exe', env: {},
    writeOwned: (_name, text) => { captured = text; return 'identity-worker.ps1'; }, spawnChild });
  assert.equal((await inspector.inspect(fixtures()[0])).pid, 41);
  assert.equal((await inspector.inspect(fixtures()[1])).pid, 42);
  await inspector.close(); assert.equal(writes, 2);
  for (const word of ['GetWindowThreadProcessId', 'GetWindowTextW', 'FIXTURE_IDENTITY_CHANGED']) assert.ok(captured.includes(word));
});

test('warm identity worker rejects a mismatched nonce before accepting identity metadata', async () => {
  const inspector = createGuestInspector({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', executable: 'powershell.exe', env: {},
    writeOwned: () => 'identity-worker.ps1', spawnChild: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const frame = JSON.parse(bytes.toString());
        queueMicrotask(() => child.stdout.write(JSON.stringify({ nonce: 'wrong', id: frame.id, ok: true, value: { pid: 41 } }) + '\n'));
        done();
      }, final(done) { child.emit('close', 0); done(); } });
      return child;
    } });
  await assert.rejects(inspector.inspect(fixtures()[0]), /INSPECTOR_EXIT/);
  await inspector.close();
});

test('a hung guest inspector detaches its pipes at the close deadline without signaling the process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter(); let detached = 0;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => assert.fail('snapshot restore owns guest process cleanup');
  child.unref = () => { detached++; };
  const inspector = createGuestInspector({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', executable: 'powershell.exe', env: {},
    writeOwned: () => 'identity-worker.ps1', spawnChild: () => child });
  const closed = assert.rejects(inspector.close(), { code: 'INSPECTOR_EXIT' });
  t.mock.timers.tick(5000);
  await closed;
  assert.equal(detached, 1);
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.destroyed, true);
});

test('direct launch stages distinct nonces and a bounded Limited task instead of borrowing the parent', async () => {
  let invocation = 0, time = 100;
  const scripts = [], registrations = [], results = [];
  for (const override of [false, true]) results.push(await runDirectTrial({ target: fixtures()[3], override,
    bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', tick: () => time++, now: () => now,
    psCall: async (operation, args) => { registrations.push({ operation, args }); return {}; },
    prepare: async () => ({ status: 'ready', receipt: {} }), executableOf: () => 'C:\\fixture\\driver.exe',
    writeOwned: (name, text) => { scripts.push(text); return name; },
    read: () => JSON.stringify({ id: 1, replyId: 1, pid: 501, raw: { ok: false, code: 'FORBIDDEN_TARGET', counters: count } }),
    exists: () => true, check: async () => {}, sleep: async () => {}, nextInvocation: () => String(++invocation) }));
  assert.notEqual(results[0].launch.nonceSha256, results[1].launch.nonceSha256);
  assert.equal(results[0].launch.source, 'scheduled-direct');
  assert.equal(results[0].parent.jobId, results[0].parent.jobReplyId);
  assert.equal(registrations.length, 2);
  assert.ok(registrations.every(r => r.operation === 'register-injector' && r.args.arguments.includes('direct-')));
  for (const text of scripts) {
    assert.match(text, /EnvironmentVariables.Clear\(\)/);
    assert.match(text, /ReadLineAsync\(\)/); assert.match(text, /Wait\(35000\)/);
    assert.doesNotMatch(text, /WaitForExit\(5000\)|StandardInput.Close|\.Kill\(/); assert.doesNotMatch(text, /screenshot|windowTitle/);
  }
  assert.doesNotMatch(scripts[0], /EnvironmentVariables\['SLEIGHT_ALLOW_FORBIDDEN_TARGETS'\]/);
  assert.match(scripts[1], /EnvironmentVariables\['SLEIGHT_ALLOW_FORBIDDEN_TARGETS'\] = '1'/);
});

// Explicit broken variants can run as failing test commands. The ordinary suite
// tests the original module. No variant is written into the working tree.
const variants = {
  costTransport: ["const plan = collectorPlan([row.id])[0];", "const plan = collectorPlan([row.id])[0]; if (plan.measurementOnly) fail('CHECKPOINT_NOISE_UNREGISTERED');"],
  costSkip: ["{ measurementOnly: 'bounds not registered' }", "{ measurementOnly: 'bounds not registered', skip: 'CHECKPOINT_NOISE_UNREGISTERED' }"],
  costProducer: ['measured === undefined ? [] : [measured]', '[]'],
  costProjection: ['result.costSamples = costSamples(interval.caseId, facts.costSamples ?? []);', 'result.costSamples = [];'],
  costMissing: ["return { driver, costSamples: [], unmeasured: 'CHECKPOINT_TIMING_UNAVAILABLE' };",
    "return { driver, costSamples: [Object.fromEntries(COST_FIELDS[caseId].map(k => [k, 0]))] };"],
  costNoProducer: ["rowId === 'checkpoint-cost' && io.checkpointTimingProducer !== true", 'false'],
  goPrefix: ['`${prefix}go-${id}`', '`go-${id}`'],
  injectPrefix: ['`${prefix}inject-${id}.jsonl`', '`inject-${id}.jsonl`'],
  directScriptPrefix: ['`${prefix}direct-${invocation}.ps1`', '`direct-${invocation}.ps1`'],
  directOutputPrefix: ['`${prefix}direct-${invocation}.jsonl`', '`direct-${invocation}.jsonl`'],
  renameRetry: ["attempt >= 3", 'attempt >= 0'],
  stopInit: ['let ready, stopObserver = async () => {};', 'let ready, stopObserver;'],
  stopRethrow: ['if (r.error) throw r.error;', ''],
  stopFirstError: ['if (stopError) throw stopError;', ''],
  rowScope: ['return `${requestInvocation}.${rowId}.`;', "return '1.person-key-before.';"],
  atomicStop: ['rename(temporary, path);', "writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });"],
  observerPriority: ['maxBytes: 16 * 1024 * 1024, normalPriority: true', 'maxBytes: 16 * 1024 * 1024, lowPriority: true'],
  finalLease: ['    await check();\n    return result;', '    return result;'],
  stopDeadline: ["stopTimer = schedule(() => { stopExpired = true; controller.abort(); }, 10000);", 'stopTimer = undefined;'],
  pollDensity: ['r.tickMs - polls[n - 1].tickMs > (r.pollCount - polls[n - 1].pollCount) * 100', 'false'],
  monotonicGap: ['r.maxGapMs < polls[n - 1].maxGapMs', 'false'],
  sequence: ['lines.some((r, n) => r.seq !== n + 1)', 'false'],
  receipt: ["if (start?.kind !== 'start' || end?.kind !== 'end')", "if (false)"],
  overflow: ['end.truncated || end.diskError', 'false'],
  heartbeat: ['r.tickMs - coverage[n - 1].tickMs > maxGap', 'false'],
  receiptInvocation: ['start.invocation !== invocation', 'false'],
  receiptToken: ['start.rowToken !== lease.token', 'false'],
  receiptRow: ['start.rowId !== lease.row', 'false'],
  stopLease: ['JSON.stringify(request.payload.lease) !== JSON.stringify(expectedLease)', 'false'],
  stopBytes: ['!readOrdinary(path, 16384, true).equals(bytes)', 'false'],
  stopRequest: ['validateTransportRequest(request, requestInvocation, /^uc3f-([a-f0-9]{16})$/.exec(basename(bank))?.[1]);', ''],
  pollCount: ['r.pollCount <= polls[n - 1].pollCount', 'false'],
  pollGap: ['r.maxGapMs > 100', 'false'],
  finalPollCount: ['end.pollCount !== polls.at(-1).pollCount', 'false'],
  token: ['lease.token !== expected.token', 'false'],
  row: ['lease.row !== expected.row', 'false'],
  expiry: ['lease.expiresUtc !== expected.expiresUtc', 'false'],
  cases: ["row.id !== 'person-idle' || JSON.stringify(cases) !== JSON.stringify(allowed)", 'false'],
  ordering: ['r.tickMs < lines[n - 1].tickMs', 'false'],
  gap: ['r.tickMs - coverage[n - 1].tickMs > maxGap', 'false'],
  poll: ['r.startTickMs < polls[0].tickMs || r.endTickMs > polls.at(-1).tickMs', 'false'],
  observerLease: ['Date.parse(start.leaseExpiresUtc) !== Date.parse(lease.expiresUtc)', 'false'],
  injectorInvocation: ['r.invocation !== facts.injectorInvocation', 'false'],
  injectorWindow: ['r.tickMs < interval.startTickMs || r.tickMs > interval.endTickMs', 'false'],
  clock: ['guestTick < before - 250 || guestTick > after + 250', 'false'],
  capacity: ["remaining > 900000", 'false'],
  controls: ['!control.test(name)', 'true'],
  cleanupLease: ["JSON.stringify(lease.operations) !== '[\"close\",\"cleanup-check\"]'", 'false'],
  protocol: ['request.protocol !== TRANSPORT_PROTOCOL', 'false'],
  invocation: ['request.invocation !== invocation', 'false'],
  bankToken: ['request.token !== token', 'false'],
  vm: ['request.vmId !== expected.vmId', 'false'],
  success: ["result.status !== 'recorded' || result.hookRemoved !== true", 'false'],
  ownerGo: ["writeFileSync(path, JSON.stringify({ bank: token, rowId, caseId, trial, go: true, observedTickMs: state.tickMs }), { flag: 'wx', mode: 0o600 });", ''],
  marker: ['// sleight.uc3f-transport/1: file-request', '// missing transport marker'],
  helperLease: ['return text.replace(needle, needle +', "return text.replace('MISSING', needle +"],
  vmPin: ['keys.some(k => current[k] !== pinned[k])', 'false'],
};
async function fromSource(text) {
  const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
  return import('data:text/javascript;base64,' + Buffer.from(text.replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href))).toString('base64'));
}
const variant = process.env.UC3G3B_BROKEN;
if (variant && !variants[variant]) throw Error('UNKNOWN_TEST_VARIANT');
if (variant) assert.ok(source.includes(variants[variant][0]), variant);
const activeSource = variant ? source.replace(...variants[variant]) : source;
const api = variant ? await fromSource(activeSource) : collector;

test('cost producer retains 450 supplied numeric timings and records zero when telemetry is absent', async () => {
  assert.equal(api.collectorPlan(['checkpoint-cost'])[0].skip, undefined);
  for (const supplied of [true, false]) {
    const b = memoryBackend({ cost: supplied, collect: api.collectRow, measure: api.measureGuestTrial });
    const result = await b.run('checkpoint-cost');
    assert.equal(result.status, 'recorded', JSON.stringify(result));
    const trials = b.raw.get('checkpoint-cost').trim().split('\n').map(JSON.parse).filter(r => r.kind === 'trial');
    assert.equal(trials.length, 450);
    assert.equal(trials.flatMap(t => t.costSamples).length, supplied ? 450 : 0);
    if (!supplied) { assert.equal(b.actions.length, 0); assert.equal(b.events.filter(e => e.startsWith('request:')).length, 0); }
    for (const t of trials) if (supplied) assert.deepEqual(t.costSamples[0], t.caseId === 'hook-callback' ? { elapsedUs: 3.5 } :
      { elapsedMs: 0.75 });
    else assert.equal(t.unmeasured, 'CHECKPOINT_TIMING_UNAVAILABLE');
  }
  const absent = await api.measureGuestTrial({ rowId: 'checkpoint-cost', caseId: 'click', fixtures: [],
    request: () => assert.fail('no requests without a timing producer') }, { client: () => assert.fail('no client without a timing producer') });
  assert.deepEqual(absent, { driver: [], costSamples: [], unmeasured: 'CHECKPOINT_TIMING_UNAVAILABLE' });
});
const bankToken = '0123456789abcdef';

test('review: only the two exact person-idle slices accept cases', () => {
  const bankArgs = ['--bank', 'C:\\sleight-setup\\uc3f-0123456789abcdef', '--revision', revision];
  for (const [row, cases, away] of [['lock-refused', 'read', false], ['person-idle', 'notepad', true],
    ['person-idle', 'background-word', true], ['person-idle', 'notepad,wpf,calculator-refused,background-word', false]])
    assert.throws(() => api.parseCollectArgs([...bankArgs, '--row', row, '--cases', cases, ...away ? ['--owner-away'] : []]), /INVALID_OPTIONS/);
  assert.deepEqual(api.parseCollectArgs([...bankArgs, '--row', 'person-idle', '--cases', 'background-word']).cases, ['background-word']);
});

test('review: injector proof binds the file invocation and the trial interval', () => {
  const facts = { driver: [], injector: injection(120, 'key', 'q'), injectorInvocation: '2' };
  assert.equal(api.projectTrial(facts, { startTickMs: 110, endTickMs: 130 }).injector.length, 1);
  assert.throws(() => api.projectTrial({ ...facts, injectorInvocation: '3' }, { startTickMs: 110, endTickMs: 130 }), /INJECTOR_UNPROVED/);
  for (const tick of [109, 131]) assert.throws(() => api.projectTrial({ ...facts, injector: injection(tick, 'key', 'q') },
    { startTickMs: 110, endTickMs: 130 }), /INJECTOR_UNPROVED/);
});

test('review: guest clock sample brackets GetTickCount64 within 250 ms', () => {
  api.assertClockSample(100, 150, 200);
  for (const tick of [0, 1000]) assert.throws(() => api.assertClockSample(500, tick, 510), /CLOCK_SOURCE_MISMATCH/);
});
