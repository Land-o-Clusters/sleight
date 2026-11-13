import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererProbePlan, rendererClickTrial, rendererProbeVerdict, rendererWitnessValid, rendererProbeMain } from '../bench/runtime-renderer-probe.mjs';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { spawnSync } from 'node:child_process';
import { REAL_APPS } from '../bench/tasks.mjs';
import { driverProbeAdapter, createRendererProbe } from '../bench/runtime-probe-live.mjs';

const window = { windowId: '42', pid: 321, processStart: '1.2', bundleId: 'com.microsoft.VSCode' };
const snapshot = selected => ({ window, readId: 1, renderer: { web: true, complete: true },
  text: `Window: Fixture\n0 standard window\n\t1 tab${selected === 'a' ? ' (selected)' : ''} UC2C-a.txt\n\t2 tab${selected === 'b' ? ' (selected)' : ''} UC2C-b.txt` });
const witness = () => ({ covered: true, sampleIntervalMs: 20,
  events: [1, 2].map(type => ({ type, flags: 0, pid: 321, source: -1, windowId: 42 })),
  samples: [0, 20, 40].map(ms => ({ ms, frontmostPID: 500, pointer: [100, 200], covered: true })) });
function rig({ before = snapshot('a'), after = snapshot('b'), log = witness(), fail } = {}) {
  const calls = []; let reads = 0;
  return { calls, driver: {
    async read() { calls.push('read'); return reads++ ? after : before; },
    async act(...args) { calls.push(args); if (fail) throw Error(fail); return { delivery: 'sent-unverified', postedEvents: 2 }; },
  }, witness: { async call(row) { calls.push(row.op); return row.op === 'renderer-watch-end' ? log : { covered: true, watching: true }; } } };
}
test('renderer subset has two covered 20-click cells, a temporary VS Code profile and no wake', () => {
  const cells = rendererProbePlan({ includeDiscord: true });
  assert.deepEqual(cells.map(c => c.app), ['vscode', 'discord']);
  assert.deepEqual(rendererProbePlan().map(c => c.app), ['vscode']);
  assert.ok(cells.every(c => REAL_APPS.includes(c.bundle)));
  assert.ok(cells.every(c => c.trials === 20 && c.requiredPasses === 20 && c.wake === false && c.read === 'none'));
  assert.equal(cells[0].profile, 'temporary');
});
test('renderer adapter obtains a fresh person token and explicitly requests no post-input read', async () => {
  for (const person of [{ token: 'private-person-token', personTookOver: false }, { token: '', personTookOver: false },
    { token: 'private-person-token', personTookOver: true }]) {
    const calls = [];
    const driver = driverProbeAdapter({ async request(method, params) {
      calls.push({ method, params });
      if (method === 'getApp') return snapshot('a');
      if (method === 'personState') return person;
      return { delivery: 'sent-unverified' };
    } }, { inputAdmission: true });
    await driver.acquire({ windowId: '42' });
    if (person.token && !person.personTookOver) {
      await driver.act('click', 2);
      assert.deepEqual(calls.slice(1), [
        { method: 'personState', params: { windowId: '42', processStart: '1.2' } },
        { method: 'click', params: { windowId: '42', processStart: '1.2', readId: 1, args: [2], personToken: person.token, read: 'none' } },
      ]);
    } else {
      await assert.rejects(driver.act('click', 2), /PERSON_TOOK_OVER/);
      assert.ok(calls.every(c => c.method !== 'click'));
    }
  }
});
test('one renderer click is timed separately from the confirming read and retains all witness rows', async () => {
  const f = rig(); let now = 0;
  const result = await rendererClickTrial(rendererProbePlan()[0], f, { now: () => (now += 30) });
  assert.equal(result.passed, true); assert.equal(result.elapsedMs, 30);
  assert.deepEqual(f.calls.filter(Array.isArray), [['click', 2]]);
  assert.deepEqual(result.witness, witness());
  assert.ok(f.calls.indexOf('renderer-watch-begin') < f.calls.findIndex(Array.isArray));
  assert.ok(f.calls.indexOf('renderer-watch-end') > f.calls.lastIndexOf('read'));
});
for (const [name, breakLog] of [
  ['Cmd on press', log => { log.events[0].flags = 0x100000; }],
  ['modifier on release', log => { log.events[1].flags = 0x20000; }],
  ['missing release', log => { log.events.pop(); }],
  ['wrong pid', log => { log.events[0].pid++; }],
  ['wrong window', log => { log.events[0].windowId++; }],
  ['inherited source', log => { log.events[0].source = 0; }],
  ['extra move', log => { log.events.push({ ...log.events[0], type: 5 }); }],
  ['focus excursion', log => { log.samples[1].frontmostPID = 321; }],
  ['pointer excursion', log => { log.samples[1].pointer[0]++; }],
  ['cover lost', log => { log.samples[1].covered = false; }],
  ['missing samples', log => { log.samples = []; }],
  ['sampling gap', log => { log.samples[2].ms = 100; }],
  ['tap failure', log => { log.tapFailed = true; }],
  ['log overflow', log => { log.overflow = true; }],
]) test(`renderer trial rejects ${name}`, async () => {
  const log = witness(); breakLog(log);
  assert.equal((await rendererClickTrial(rendererProbePlan()[0], rig({ log }))).passed, false);
});
test('a missed click is retained once and cannot become a pass from witness flags alone', async () => {
  const f = rig({ after: snapshot('a') });
  assert.equal((await rendererClickTrial(rendererProbePlan()[0], f)).passed, false);
  assert.equal(f.calls.filter(Array.isArray).length, 1);
});
test('only a complete read and valid witness can classify a measured click miss', async () => {
  const cell = rendererProbePlan()[0], log = witness(); log.events = [];
  for (const [input, reason] of [
    [{ after: snapshot('a') }, 'RENDERER_CLICK_MISS'],
    [{ after: snapshot('a'), log }, 'RENDERER_WITNESS_UNCONFIRMED'],
    [{ after: { ...snapshot('a'), truncated: true } }, 'RENDERER_READ_UNCONFIRMED'],
    [{ after: { ...snapshot('a'), window: { ...window, processStart: 'new' } } }, 'IDENTITY_CHANGED'],
  ]) assert.equal((await rendererClickTrial(cell, rig(input))).reason, reason);
});
test('uncertain input closes the witness and is never retried', async () => {
  const f = rig({ fail: 'INPUT_DELIVERY_UNCONFIRMED' });
  await assert.rejects(rendererClickTrial(rendererProbePlan()[0], f), error => {
    assert.match(error.message, /INPUT_DELIVERY_UNCONFIRMED/);
    assert.deepEqual(error.rendererEvidence.witness, witness()); return true;
  });
  assert.equal(f.calls.filter(Array.isArray).length, 1);
  assert.equal(f.calls.at(-1), 'renderer-watch-end');
});

test('Discord fixture alternates only signed-out Register and login links and verifies the new tree', async () => {
  const cell = rendererProbePlan({ includeDiscord: true })[1];
  const discordWindow = { ...window, bundleId: cell.bundle };
  const login = { ...snapshot('a'), window: discordWindow, text: 'Window: Discord\n1 link Register' };
  const register = { ...login, text: 'Window: Discord\n2 link Already have an account?' };
  for (const [before, after, id] of [[login, register, 1], [register, login, 2]]) {
    const f = rig({ before, after });
    assert.equal((await rendererClickTrial(cell, f)).passed, true);
    assert.deepEqual(f.calls.filter(Array.isArray), [['click', id]]);
  }
});
test('a partial, native-only, ambiguous or stale window tree refuses before a press', async () => {
  for (const before of [{ ...snapshot('a'), truncated: true }, { ...snapshot('a'), renderer: { web: false, complete: true } },
    { ...snapshot('a'), renderer: { web: true, complete: false } }, { ...snapshot('a'), text: snapshot('a').text + '\n3 tab UC2C-b.txt' }]) {
    const f = rig({ before });
    await assert.rejects(rendererClickTrial(rendererProbePlan()[0], f), /RENDERER_(TREE|TARGET)_UNAVAILABLE/);
    assert.equal(f.calls.filter(Array.isArray).length, 0);
  }
  const f = rig({ after: { ...snapshot('b'), window: { ...window, processStart: 'replaced' } } });
  assert.equal((await rendererClickTrial(rendererProbePlan()[0], f)).passed, false);
});
test('offline mutations prove each witness safety check rejects its broken variant', () => {
  const source = rendererWitnessValid.toString();
  const variants = [
    ['flags', 'event.flags === 0', 'true', log => { log.events[0].flags = 0x100000; }],
    ['pid', 'event.pid === window.pid', 'true', log => { log.events[0].pid++; }],
    ['window', 'String(event.windowId) === window.windowId', 'true', log => { log.events[1].windowId++; }],
    ['source', 'event.source === -1', 'true', log => { log.events[0].source = 0; }],
    ['focus', 's.frontmostPID === first.frontmostPID', 'true', log => { log.samples[1].frontmostPID = 321; }],
    ['pointer', 'n === first.pointer[j]', 'true', log => { log.samples[1].pointer[0]++; }],
    ['cover', 's.covered === true', 'true', log => { log.samples[1].covered = false; }],
    ['cadence', 's.ms - samples[i - 1].ms <= 40', 'true', log => { log.samples[2].ms = 100; }],
    ['tap', 'log.tapFailed === true', 'false', log => { log.tapFailed = true; }],
    ['overflow', 'log.overflow === true', 'false', log => { log.overflow = true; }],
  ];
  for (const [name, from, to, change] of variants) {
    assert.ok(source.includes(from), name);
    const mutant = Function(`return (${source.replace(from, to)});`)();
    const log = witness(); change(log);
    assert.equal(rendererWitnessValid(log, window), false, name);
    assert.equal(mutant(log, window), true, name);
  }
});
test('in-memory module mutations cannot disguise a missed click, stale window or partial tree', async () => {
  const url = new URL('../bench/runtime-renderer-probe.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replace("from './runtime-arm.mjs'", `from '${new URL('../bench/runtime-arm.mjs', import.meta.url).href}'`)
    .replace("from './sitting-process.mjs'", `from '${new URL('../bench/sitting-process.mjs', import.meta.url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  for (const [changes, input] of [
    [[['next.changed(after)', 'true']], { after: snapshot('a') }],
    [[['sameWindow && !after.truncated', 'true'], ["!sameWindow ? 'IDENTITY_CHANGED'", "false ? 'IDENTITY_CHANGED'"]],
      { after: { ...snapshot('b'), window: { ...window, processStart: 'new' } } }],
    [[['!after.truncated', 'true'], ['after.truncated || after.renderer?.complete !== true', 'false']],
      { after: { ...snapshot('b'), truncated: true } }],
  ]) {
    let changed = source;
    for (const [from, to] of changes) { assert.ok(changed.includes(from)); changed = changed.replace(from, to); }
    const mutant = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
    assert.equal((await rendererClickTrial(rendererProbePlan()[0], rig(input))).passed, false);
    assert.equal((await mutant.rendererClickTrial(rendererProbePlan()[0], rig(input))).passed, true);
  }
});
test('CLI renderer dry run is inert and leaves existing RT13 qualification out', () => {
  const result = spawnSync(process.execPath, ['bench/runtime-probe-live.mjs', '--renderer-background', '--dry-run'], {
    timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.totalTrials, 20);
  assert.deepEqual(data.discord, { included: false, requires: '--include-discord', reason: 'Off by owner decision (2026-11-02): login-page input and app updater. --include-discord adds it.' });
  assert.ok(data.liveRequires.includes('--sitting-guard'));
  assert.ok(!data.liveRequires.includes('--owner-away')); assert.equal(data.qualification, false); assert.equal(data.wakeImplemented, false);
});
for (const cleanup of [true, false, 'throws']) test(`renderer orchestration keeps the first miss and sticky cleanup ${cleanup}`, async () => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-renderer-main-'))));
  const events = [], published = [];
  const signals = new EventEmitter();
  const fixture = rig({ after: snapshot('a') });
  try {
    const code = await rendererProbeMain(['--renderer-background', '--sitting-guard', '/fixture/guard', '--out', join(root, 'probe')], {
      platform: 'darwin', held: () => false, signals,
      startGuard: () => ({ start: async () => {}, check: async () => ({ hidIdleMs: 30000 }), close: async () => {} }),
      takeLock: async () => { events.push('lock'); return async () => { events.push('unlock'); }; },
      createBackend: async () => ({ metadata: () => ({ sleightDirty: false }), prepare: async () => fixture,
        closeFixture: async () => { events.push('closeFixture'); if (cleanup === 'throws') throw Error('Lost cleanup reply'); return { confirmed: cleanup }; },
        close: async () => { events.push('close'); return { confirmed: true }; } }),
      publish: (stem, report) => published.push(report),
    });
    assert.equal(code, 1); assert.equal(published.length, 1);
    assert.equal(published[0].cells[0].trialsData.length, 1);
    assert.equal(published[0].stop, cleanup === true ? 'RENDERER_CLICK_MISS' : 'CLEANUP_UNCONFIRMED');
    assert.equal(published[0].cleanupConfirmed, cleanup === true);
    assert.deepEqual(events, ['lock', 'closeFixture', 'close', ...(cleanup === true ? ['unlock'] : [])]);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('renderer verdict requires every selected cell, cleanup and p50 below 150 ms', () => {
  const cells = rendererProbePlan().map(c => ({ ...c, trialsData: Array.from({ length: 20 }, () => ({ passed: true, elapsedMs: 149 })) }));
  assert.equal(rendererProbeVerdict(cells, true).passed, true);
  for (const rows of [[], cells.map(c => ({ ...c, trialsData: c.trialsData.slice(0, 19) })),
    cells.map(c => ({ ...c, trialsData: c.trialsData.map(t => ({ ...t, elapsedMs: 150 })) }))])
    assert.equal(rendererProbeVerdict(rows, true).passed, false);
  assert.equal(rendererProbeVerdict(cells, false).passed, false);
  cells[0].trialsData[0].passed = false;
  assert.equal(rendererProbeVerdict(cells, true).passed, false);
});


test('Discord is opt-in in the CLI preview and changes the required verdict cells', async () => {
  let preview;
  assert.equal(await rendererProbeMain(['--dry-run', '--include-discord'], { print: text => { preview = JSON.parse(text); } }), 0);
  assert.equal(preview.totalTrials, 40); assert.equal(preview.discord.included, true);
  const cells = rendererProbePlan({ includeDiscord: true }).map(c => ({ ...c,
    trialsData: Array.from({ length: 20 }, () => ({ passed: true, elapsedMs: 1 })) }));
  assert.equal(rendererProbeVerdict(cells, true, { includeDiscord: true }).passed, true);
  assert.equal(rendererProbeVerdict(cells.slice(0, 1), true, { includeDiscord: true }).passed, false);
});

test('live renderer mode refuses no guard and a bare owner-away flag before acquiring resources', async () => {
  for (const args of [[], ['--owner-away']]) {
    await assert.rejects(rendererProbeMain(args, {
      takeLock: () => assert.fail('lock acquired without guard'),
      createBackend: () => assert.fail('backend created without guard'),
    }), /SITTING_GUARD_REQUIRED/);
  }
});

test('live backend refuses absent and wrong driver SHA before creating a fixture', async () => {
  for (const driverSha256 of [undefined, 'wrong', '0'.repeat(64)]) {
    await assert.rejects(createRendererProbe({ check: async () => {}, driverBinary: new URL('../package.json', import.meta.url).pathname, driverSha256 }),
      /RENDERER_GATE_HELPER_REQUIRED/);
  }
});

async function guardedRun({ idle = 30000, failAt = Infinity, heldAt = Infinity, holdAfterClick = false, onStart, runMain = rendererProbeMain } = {}) {
  const events = [], reports = []; let checks = 0, holds = 0, reads = 0, clicks = 0;
  let guardOptions, signal;
  const fixture = { driver: {
    async read() { return snapshot(reads++ % 2 ? 'b' : 'a'); },
    async act() { events.push('click'); clicks++; return { delivery: 'sent-unverified', postedEvents: 2 }; },
  }, witness: { async call(row) { return row.op === 'renderer-watch-end' ? witness() : { covered: true, watching: true }; } } };
  const code = await runMain(['--sitting-guard', '/fixture/guard', '--out', join(realpathSync(tmpdir()), 'uc2c2-offline-probe')], {
    platform: 'darwin', held: () => ++holds === heldAt || holdAfterClick && clicks > 0, signals: new EventEmitter(),
    startGuard: (tool, options) => {
      assert.equal(tool, '/fixture/guard'); assert.equal(options.kind, 'renderer'); guardOptions = options;
      return { async start() { events.push('arm'); onStart?.(options); }, async check() {
        events.push('guard'); if (++checks === failAt) throw Error('PERSON_ACTIVE'); return { hidIdleMs: idle };
      }, async close() { events.push('guard-close'); } };
    },
    takeLock: async () => { events.push('lock'); return async () => events.push('unlock'); },
    createBackend: async options => { signal = options.signal; return {
      metadata: () => ({ sleightDirty: false }),
      async prepare() { events.push('prepare'); await options.check(); return fixture; },
      async closeFixture() { events.push('fixture-close'); return { confirmed: true }; },
      async close() { events.push('backend-close'); return { confirmed: true }; },
    }; },
    publish: (stem, report) => reports.push(report),
  });
  return { code, events, report: reports[0], clicks, guardOptions, signal };
}

test('live renderer guard enforces 30 seconds of HID idle before fixture launch', async () => {
  for (const idle of [0, 29999, NaN, undefined]) {
    const result = await guardedRun({ idle: idle === undefined ? null : idle });
    assert.equal(result.code, 1); assert.equal(result.report.stop, 'PERSON_ACTIVE');
    assert.ok(!result.events.includes('prepare')); assert.equal(result.clicks, 0);
    assert.ok(result.events.includes('guard-close'));
  }
  const result = await guardedRun();
  assert.equal(result.code, 0); assert.equal(result.clicks, 20);
  assert.ok(result.events.indexOf('arm') < result.events.indexOf('prepare'));
  assert.ok(result.events.filter(e => e === 'guard').length >= 40);
});

test('live guard stops between trials on person input or a hold and still cleans up', async () => {
  for (const settings of [{ failAt: 6 }, { holdAfterClick: true }]) {
    const result = await guardedRun(settings);
    assert.equal(result.code, 1); assert.equal(result.clicks, 1);
    assert.match(result.report.stop, /PERSON_ACTIVE|HOLD/);
    assert.equal(result.report.cleanupConfirmed, true);
    assert.ok(result.events.includes('fixture-close')); assert.ok(result.events.includes('guard-close'));
  }
});

test('a continuous sitting-guard stop aborts live preparation before a press', async () => {
  const result = await guardedRun({ onStart: options => options.onStop('PERSON_ACTIVE') });
  assert.equal(result.code, 1); assert.equal(result.clicks, 0);
  assert.equal(result.report.stop, 'PERSON_ACTIVE');
});


test('broken Discord, idle, hold and continuous-stop checks are detected offline', async () => {
  const url = new URL('../bench/runtime-renderer-probe.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8')
    .replace("from './runtime-arm.mjs'", `from '${new URL('../bench/runtime-arm.mjs', import.meta.url).href}'`)
    .replace("from './sitting-process.mjs'", `from '${new URL('../bench/sitting-process.mjs', import.meta.url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const variants = [
    ['discord', "cell.app !== 'discord' || includeDiscord", 'true', null],
    ['idle', "if (!Number.isFinite(sample?.hidIdleMs) || sample.hidIdleMs < 30000)", 'if (false)', { idle: 29999 }],
    ['hold', "if (held()) throw Error('HOLD')", "if (false) throw Error('HOLD')", { holdAfterClick: true }],
    ['stop', 'controller.abort(Error(code))', 'void code', { onStart: options => options.onStop('PERSON_ACTIVE') }],
  ];
  for (const [name, from, to, options] of variants) {
    assert.ok(source.includes(from), name);
    const mutant = await import('data:text/javascript;base64,' + Buffer.from(source.replace(from, to)).toString('base64'));
    if (name === 'discord') {
      assert.equal(rendererProbePlan().length, 1); assert.equal(mutant.rendererProbePlan().length, 2);
    } else {
      assert.equal((await guardedRun(options)).code, 1, name);
      assert.equal((await guardedRun({ ...options, runMain: mutant.rendererProbeMain })).code, 0, name);
    }
  }
});
