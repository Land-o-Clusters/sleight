import { test, after } from 'node:test';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import assert from 'node:assert/strict';
import { runInNewContext, constants as vmConstants } from 'node:vm';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedCode, GUARD_MARK, GUARD_OMIT_MARK, GUARD_END, sameElement, samePlace, refusedPlace } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { inspect } from './helpers/window-identity-fixture.mjs';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const { loadCheck } = parserSkip ? {} : await import('../bench/replay/run.mjs');
const { checkEvidence } = parserSkip ? {} : await import('../bench/replay/checks.mjs');
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
const tree = (window = expected, rows = '\t1 button Save, ID: Save') =>
  `Window: ${JSON.stringify(window.title)}, App: ${window.app}.\n0 standard window${window.url ? `, URL: ${window.url}` : ''}\n${rows}`;
// Obtain the ordinary native options from the relay, so the default tests exercise its routing.
const leaseDir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-guard-default-')));
after(() => removeTemp(leaseDir));
function defaultOptions() {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(line => JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory: leaseDir, holder: 'default-test' }) });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  try {
    call(1, 'let app = await cua.getApp("TextEdit")');
    serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: tree() }],
      _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
    call(2, 'await app.typeText("x");');
    const code = sent.find(message => message.id === 2)?.params.arguments.code ?? '';
    const update = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(code)?.[1] ?? '{}');
    return Object.fromEntries(['firstOff', 'focused', 'quietEdits', 'bind'].map(key => [key, update[key]]));
  } finally { relay.dispose(); }
}

function fixture({ current = () => tree(), action = () => {}, screenshotState, strict = false, ordinary = false } = {}) {
  const calls = [], output = [];
  const raw = {
    async getAXState(options) { calls.push(['read', options]); return current(); },
    async getAXStateAndScreenshot(options) {
      calls.push(['both', options]);
      const state = screenshotState ? screenshotState(options) : current();
      if (options?.emit !== false) output.push(state);
      return { state, screenshot: new Uint8Array([1, 2, 3]) };
    },
    async getScreenshot() { calls.push(['screenshot']); return new Uint8Array([1]); },
  };
  for (const name of ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']) {
    raw[name] = async (...args) => { calls.push([name, ...args]); return action(name, args); };
  }
  const engine = strict ? new Proxy(raw, { get(object, key) {
    if (key in object || typeof key === 'symbol' || key === 'then') return object[key];
    throw Error('unsupported engine method ' + key);
  } }) : raw;
  const context = { app: engine, setTimeout, clearTimeout, cua: { getApp: async () => engine, listApps: async () => [{ id: 'fixture.app', displayName: expected.app, windows: [{ id: 1, title: expected.title }] }] }, nodeRepl: { write: value => output.push(value), emitImage: async () => {} } };
  const run = (code, options = ordinary ? defaultOptions() : {}, target = expected) => runInNewContext(`(async () => { ${guardedCode(code, target, 'changed window', undefined, { focused: true, ...options })} })()`, context,
    { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { run, raw, calls, output, context };
}

const closeTarget = { ...expected, appId: 'fixture.app', nativeIdentity: { pid: 123, processStart: 1 } };
const closeOptions = { dp1: true, guardStopMark: 'private-close-mark' };
const nativeClosed = { status: 'ok', appId: 'fixture.app', pid: 123, processStart: 1,
  running: true, windowCount: 0, modalCount: 0, closedWindowPresent: false };
// Recorded engine AppInfo shape from sleight-arch's 25.3 s passing smoke.
const recordedApp = { displayName: 'TextEdit', id: 'com.apple.TextEdit', isRunning: true };
function closeClock(f, onTick = () => {}) {
  let now = 10000;
  const timers = new Set(), scheduled = [], fired = [], cleared = [];
  const advance = ms => {
    now += ms;
    onTick(now);
    for (const due of [...timers]) if (due.at <= now) { timers.delete(due); fired.push(due); due.fn(); }
  };
  f.context.Date = class extends Date { static now() { return now; } };
  f.context.setTimeout = (fn, ms) => {
    const timer = { fn, ms, at: now + ms };
    timers.add(timer);
    scheduled.push(timer);
    if (ms < 1500) setImmediate(() => {
      if (!timers.has(timer)) return;
      advance(Math.max(0, timer.at - now));
    });
    return timer;
  };
  f.context.clearTimeout = timer => { if (timers.delete(timer)) cleared.push(timer); };
  f.clock = () => now;
  f.advance = advance;
  f.timers = { pending: timers, scheduled, fired, cleared };
}
function closeFixture({ sample = nativeClosed, action = () => {}, ...options } = {}) {
  const path = join(leaseDir, `close-${Math.random()}.obs`);
  let armed = false, keyAt, observations = [];
  const publish = start => {
    if (!armed) return;
    observations.push({ start, end: start, ...(typeof sample === 'function' ? sample(start - keyAt) : sample) });
    writeFileSync(path + '.tmp', JSON.stringify({ observations }));
    renameSync(path + '.tmp', path);
  };
  const f = fixture({ ...options, action: async (...args) => {
    await action(...args);
    armed = true; keyAt = f.clock();
  } });
  closeClock(f, publish);
  const run = f.run;
  f.context.cua.listApps = async () => [recordedApp];
  f.run = (code, options = closeOptions, target = closeTarget) => {
    writeFileSync(path, JSON.stringify({ observations: [] }));
    armed = false; observations = [];
    return run(code, { closeRead: { path }, ...options }, target).finally(() => { armed = false; });
  };
  return f;
}
const recordedClose = 'let app = __sleightOpenedApp2;\nawait app.pressKey("super+w");\n' +
  'const s = await app.getAXStateAndScreenshot();\nnodeRepl.write(s.state.split("\\n").slice(0, 6).join("\\n"));';

test('DP1 identity conflicts block reads in both prompt variants', async () => {
  for (const prompt of [undefined, 'lean']) {
    const f = closeFixture({ sample: { ...nativeClosed, processStart: 2 } });
    await assert.rejects(f.run('await app.pressKey("super+w"); await app.getAXState();',
      { ...closeOptions, prompt }), error => {
      assert.equal(error.message, prompt === 'lean'
        ? 'Close read: process mismatch. Window unknown; no engine read.'
        : 'sleight stopped the read after Close: process mismatch. Native metadata could not confirm a window. No engine read was sent.');
      return true;
    });
    assert.equal(f.calls.filter(call => call[0] === 'read').length, 1);
    assert.ok(f.output.some(text => text.includes('"decision":"blocked-read"') && text.includes('"reason":"process mismatch"')));
  }
});

test('DPm waits through the closing window before forwarding a caller read that would reopen the app', async () => {
  for (const enabled of [false, true]) for (const method of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot', 'tail']) {
    let closed = false, samples = 0, reopened = 0;
    const f = closeFixture({ action: () => { closed = true; },
      sample: () => {
        const closing = samples++ === 0;
        return { ...nativeClosed, windowCount: closing ? 1 : 0, closedWindowPresent: closing };
      },
      current: () => {
        if (!closed) return tree();
        // The immediate B read reports the closed window. A delayed engine read
        // resolves the windowless app again and sends a reopen event.
        if (!samples) throw Error('noWindowsAvailable');
        reopened++;
        return tree({ ...expected, title: 'Untitled', url: undefined });
      } });
    const run = f.run('await app.pressKey("super+w");' + (method === 'tail' ? '' : `await app.${method}();`),
      { ...closeOptions, dp1: enabled });
    if (!enabled) await assert.rejects(run, /noWindowsAvailable/);
    else if (method === 'tail') await run;
    else await assert.rejects(run, /\[sleight:closed-read\]/);
    assert.equal(reopened, 0, `${enabled ? 'A' : 'B'} ${method}`);
    assert.equal(f.calls.filter(c => ['read', 'both', 'screenshot'].includes(c[0])).length, enabled ? 1 : 2);
  }
});

test('DPn retains the engine read when the closing window remains at the 1500 ms deadline', async () => {
  for (const closedWindowPresent of [true, undefined]) {
    const f = closeFixture({ sample: { ...nativeClosed, windowCount: 1, closedWindowPresent } });
    const start = f.clock();
    await f.run('await app.pressKey("super+w"); await app.getAXState();');
    assert.equal(f.clock() - start, 1500);
    assert.equal(f.calls.filter(call => call[0] === 'read').length, 2);
    assert.equal(f.timers.fired.filter(timer => timer.ms === 1500).length, 1);
    assert.equal(f.timers.pending.size, 0);
    assert.ok(f.output.some(text => text.includes('"decision":"kept-read"') && text.includes('"reason":"timeout"') && text.includes('"windowCount":1')));
  }
});

test('DPn skips caller and tail reads when a fake observer sees the last window gone at 600 ms', async () => {
  for (const caller of [false, true]) {
    const f = closeFixture({ sample: ms => ({ ...nativeClosed,
      windowCount: ms < 600 ? 1 : 0, closedWindowPresent: ms < 600 }) });
    const start = f.clock();
    const run = f.run('await app.pressKey("super+w");' + (caller ? 'await app.getAXState();' : ''));
    if (caller) await assert.rejects(run, /\[sleight:closed-read\]/);
    else await run;
    assert.equal(f.clock() - start, 600);
    assert.equal(f.calls.filter(call => call[0] === 'read').length, 1);
    assert.ok(f.output.some(text => text.includes('"decision":"skipped-read"')));
  }
});

for (const [name, layer] of [['six unheld CG rows', undefined], ['another-Space document', 0], ['another-Space alert', 8]]) {
  test(`DPj caller-read decision with AX windows empty and ${name}`, async () => {
    const target = { ...closeTarget, appId: 'com.apple.TextEdit' };
    const sample = inspect({ ...target, closeCount: true }, [], 0, false, [], (app, windows, list, runtime) => {
      runtime.cgWindows = Array.from({ length: 6 }, (_, i) => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: 0, kCGWindowNumber: 100 + i }));
      runtime.spaces = Object.fromEntries(runtime.cgWindows.map(row => [row.kCGWindowNumber, []]));
      if (layer !== undefined) {
        runtime.cgWindows.push({ kCGWindowOwnerPID: 123, kCGWindowLayer: layer, kCGWindowNumber: 200 });
        runtime.spaces[200] = [5];
      }
    });
    const f = closeFixture({ sample });
    await f.run('globalThis.__sleightOpenedApp2 = await cua.getApp("com.apple.TextEdit");', closeOptions, target);
    f.calls.length = 0; f.output.length = 0;
    const run = f.run(recordedClose, closeOptions, target);
    if (layer === undefined) await assert.rejects(run, /\[sleight:closed-read\]/);
    else await run;
    const decision = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(decision.source, 'caller-read');
    assert.equal(decision.decision, layer === undefined ? 'skipped-read' : 'kept-read');
    assert.equal(decision.windowCount, layer === undefined ? 0 : 1);
    assert.equal(f.calls.filter(call => call[0] === 'both').length, layer === undefined ? 0 : 1);
  });
}

test('DP1 uses native zero counts despite the recorded inventory lacking pid and windows', async () => {
  for (const key of ['super+w', 'cmd+shift+w', 'command+q']) {
    const f = closeFixture();
    f.context.cua.listApps = async () => { throw Error('DP1 must not depend on engine inventory'); };
    await f.run(`await app.pressKey(${JSON.stringify(key)});`);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(event.decision, 'skipped-read');
    assert.equal(event.windowCount, 0);
    assert.equal(event.modalCount, 0);
    assert.equal(event.match, 'native-ax+leased-pid');
    assert.ok(f.output.some(text => text.includes('private-close-mark:closed')));
  }
});

test('DPo uncertainty matrix records both the decision and its reason', async () => {
  for (const [sample, decision, reason] of [
    [{ ...nativeClosed, windowCount: 1 }, 'kept-read', 'windows non-empty'],
    [{ ...nativeClosed, modalCount: 1 }, 'kept-read', 'modal child'],
    [{ ...nativeClosed, windowCount: undefined }, 'kept-read', 'native counts missing'],
    [{ ...nativeClosed, modalCount: undefined }, 'kept-read', 'native counts missing'],
    [{ ...nativeClosed, windowCount: -1 }, 'kept-read', 'native counts missing'],
    [{ ...nativeClosed, windowCount: '0' }, 'kept-read', 'native counts missing'],
    [{ ...nativeClosed, pid: 456 }, 'blocked-read', 'process mismatch'],
    [{ ...nativeClosed, processStart: 2 }, 'blocked-read', 'process mismatch'],
    [{ ...nativeClosed, appId: 'other.app' }, 'blocked-read', 'process mismatch'],
    [{ status: 'unknown', unknownReason: 'process-changed', pid: 123, processStart: 2 }, 'blocked-read', 'process mismatch'],
    [{ ...nativeClosed, pid: 456, running: false }, 'blocked-read', 'process mismatch'],
    [{ ...nativeClosed, running: false }, 'skipped-read', 'process exited'],
    [{ ...nativeClosed, pid: undefined }, 'kept-read', 'native identity missing'],
    [{ ...nativeClosed, processStart: undefined }, 'kept-read', 'native identity missing'],
    [{ ...nativeClosed, appId: undefined }, 'kept-read', 'native identity missing'],
    [{ ...nativeClosed, appId: 123 }, 'kept-read', 'native identity missing'],
    [{ ...nativeClosed, running: undefined }, 'kept-read', 'native identity missing'],
    [{ status: 'unknown', unknownReason: 'process-changed' }, 'kept-read', 'native unavailable'],
    [{ ...nativeClosed, end: 1 }, 'kept-read', 'stale native sample'],
    [{ ...nativeClosed, start: 1, end: 2 }, 'kept-read', 'timeout'],
    [{ status: 'unknown' }, 'kept-read', 'native unavailable'],
    [{ status: 'denied' }, 'kept-read', 'native unavailable'],
  ]) {
    const f = closeFixture({ sample });
    const run = f.run('await app.pressKey("super+w");');
    if (decision === 'blocked-read') await assert.rejects(run, /process mismatch/);
    else await run;
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(event.decision, decision, JSON.stringify(sample));
    assert.equal(event.reason, reason, JSON.stringify(sample));
    assert.equal(f.calls.filter(c => c[0] === 'read').length, decision === 'kept-read' ? 2 : 1, JSON.stringify(sample));
  }
});

test('DPo compares header bundle ids and keeps reads for display-name differences', async () => {
  for (const [header, decision, reason] of [
    [undefined, 'kept-read', 'app header missing'],
    [{ app: 'Localized TextEdit' }, 'kept-read', 'app header name differs'],
    [{ app: 'Localized TextEdit', appId: 'fixture.app' }, 'skipped-read', 'no windows'],
    [{ app: 'TextEdit', appId: 'other.app' }, 'blocked-read', 'app header mismatch'],
  ]) {
    const f = closeFixture();
    const run = f.run('await app.pressKey("super+w"); const guard = globalThis.__sleightDocumentGuard;' +
      `guard.callHeaders.set(guard.activeApp, ${JSON.stringify(header)});`);
    if (decision === 'blocked-read') await assert.rejects(run, /app header mismatch/);
    else await run;
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(event.decision, decision);
    assert.equal(event.reason, reason);
  }
});

test('DPo polls through transient unknown, denied, stale and incomplete samples until fresh zero counts', async () => {
  for (const transient of [
    { status: 'unknown', unknownReason: 'deadline' }, { status: 'denied' },
    { ...nativeClosed, end: 1 }, { ...nativeClosed, pid: undefined }, { ...nativeClosed, windowCount: -1 },
  ]) {
    const f = closeFixture({ sample: ms => ms < 100 ? transient : nativeClosed });
    await f.run('await app.pressKey("super+w");');
    assert.equal(f.clock(), 10100);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(event.decision, 'skipped-read');
    assert.equal(event.reason, 'no windows');
  }
});

test('DPo returns the kept-read decision at once when another window remains', async () => {
  const f = closeFixture({ sample: { ...nativeClosed, windowCount: 1 } });
  await f.run('await app.pressKey("super+w");');
  assert.equal(f.clock(), 10025);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
});

test('DPo reuses a decision for repeated reads after the same action', async () => {
  const f = closeFixture({ sample: { status: 'unknown', unknownReason: 'deadline' } });
  await f.run('await app.pressKey("super+w"); await app.getAXState(); await app.getAXState();');
  assert.equal(f.clock(), 11500);
  assert.equal(f.output.filter(text => text.startsWith('[sleight:dp1]')).length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
});

test('DPo a new close action gets a new decision and deadline', async () => {
  const f = closeFixture({ sample: { status: 'unknown', unknownReason: 'deadline' } });
  await f.run('await app.pressKey("super+w"); await app.getAXState(); await app.pressKey("super+w"); await app.getAXState();');
  assert.equal(f.clock(), 13000);
  assert.equal(f.output.filter(text => text.startsWith('[sleight:dp1]')).length, 2);
});

const targetModal = { ...nativeClosed, windowCount: 1, closedWindowPresent: true, modalCount: 1 };
test('DPp two fresh modal samples on the closing target keep caller and tail reads at once', async () => {
  for (const caller of [false, true]) {
    const f = closeFixture({ sample: targetModal });
    await f.run('await app.pressKey("super+w");' + (caller ? 'await app.getAXState();' : ''));
    assert.equal(f.clock(), 10050);
    const events = f.output.filter(text => text.startsWith('[sleight:dp1]')).map(text => JSON.parse(text.slice(13)));
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, 'kept-read');
    assert.equal(events[0].reason, 'modal child');
    assert.equal(events[0].source, caller ? 'caller-read' : undefined);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
  }
});

test('DPp one modal sample followed by the last window disappearing still skips the read', async () => {
  for (const caller of [false, true]) {
    const f = closeFixture({ sample: ms => ms < 50 ? targetModal : nativeClosed });
    const run = f.run('await app.pressKey("super+w");' + (caller ? 'await app.getAXState();' : ''));
    if (caller) await assert.rejects(run, /\[sleight:closed-read\]/);
    else await run;
    assert.equal(f.clock(), 10050);
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(event.decision, 'skipped-read');
    assert.equal(event.reason, 'no windows');
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
  }
});

test('DPp a modal on another window does not end the closing target wait early', async () => {
  const target = { ...closeTarget, appId: 'com.apple.TextEdit' };
  const sample = inspect({ ...target, closeCount: true }, [11, 12], 0, false, [], (app, windows, list, runtime) => {
    runtime.seedWindowIdentity = true;
    runtime.afterBaseline = () => { windows[1].AXChildren = list([{ AXRole: 'AXSheet' }]); };
  });
  assert.equal(sample.closedWindowPresent, true);
  assert.equal(sample.modalCount, 0);
  const f = closeFixture({ sample });
  await f.run('await app.pressKey("super+w");', closeOptions, target);
  assert.equal(f.clock(), 11500);
  const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
  assert.equal(event.decision, 'kept-read');
  assert.equal(event.reason, 'timeout');
});

test('DPp repeated, stale, incomplete or interrupted modal samples cannot supply the second confirmation', async () => {
  for (const interruption of [
    { ...targetModal, modalCount: 0 }, { status: 'unknown' }, { ...targetModal, end: 1 },
    { ...targetModal, pid: undefined }, { ...targetModal, closedWindowPresent: undefined },
    { ...targetModal, windowCount: 0 },
  ]) {
    const f = closeFixture({ sample: ms => ms === 50 ? interruption : targetModal });
    await f.run('await app.pressKey("super+w");');
    assert.equal(f.clock(), 10100, JSON.stringify(interruption));
  }
  const f = closeFixture({ sample: ms => ms < 100 ? { ...targetModal, start: 10025, end: 10025 } : nativeClosed });
  await f.run('await app.pressKey("super+w");');
  assert.equal(f.clock(), 10100);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
});

test('DPo Cmd+Q and quit-on-close return a closed notice for the same leased process exit', async () => {
  for (const key of ['cmd+q', 'super+w']) for (const caller of [false, true]) {
    const sample = { status: 'ok', appId: 'fixture.app', pid: 123, processStart: 1, running: false };
    const f = closeFixture({ sample });
    const run = f.run(`await app.pressKey(${JSON.stringify(key)});` + (caller ? 'await app.getAXState();' : ''));
    if (caller) await assert.rejects(run, /\[sleight:closed-read\]/);
    else await run;
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(event.decision, 'skipped-read');
    assert.equal(event.reason, 'process exited');
    assert.equal(f.clock(), 10050, 'two distinct fresh exit observations are required');
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
  }
});

test('DPr transient, repeated, stale and interrupted exit samples keep polling', async () => {
  const exited = { ...nativeClosed, running: false };
  for (const sample of [
    ms => ms < 50 ? exited : { ...nativeClosed, windowCount: 1 },
    ms => ms < 100 ? { ...exited, start: 10025, end: 10025 } : nativeClosed,
    ms => ms < 100 ? { ...exited, end: 1 } : nativeClosed,
    ms => ms === 50 ? { status: 'unknown' } : ms < 100 ? exited : nativeClosed,
  ]) {
    const f = closeFixture({ sample });
    await f.run('await app.pressKey("super+w");');
    const event = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.notEqual(event.reason, 'process exited');
    assert.equal(f.clock(), event.reason === 'windows non-empty' ? 10050 : 10100);
  }
});

test('DPr a concrete identity mismatch in an old post-key sample still blocks', async () => {
  const f = closeFixture({ sample: { ...nativeClosed, pid: 456, start: 10001, end: 10025 } });
  await assert.rejects(f.run('await app.pressKey("super+w"); await new Promise(resolve => setTimeout(resolve, 250));'), /process mismatch/);
  assert.equal(f.clock(), 10250);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
  assert.ok(f.output.some(text => text.includes('"decision":"blocked-read"')));
});

test('DPr valid exit timestamps older than 200 ms keep polling until fresh zero counts', async () => {
  const f = closeFixture({ sample: ms => ms < 350
    ? { ...nativeClosed, running: false, start: 10001, end: 10025 } : nativeClosed });
  await f.run('await app.pressKey("super+w"); await new Promise(resolve => setTimeout(resolve, 250));');
  assert.equal(f.clock(), 10350);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
  assert.ok(f.output.some(text => text.includes('"reason":"no windows"')));
});

test('DPr modal confirmation uses a fresh newest sample and a 175 ms pair cadence', async () => {
  const f = closeFixture({ sample: ms => {
    if (ms < 250) return { status: 'unknown' };
    const end = 10150 + Math.floor((ms - 250) / 175) * 175;
    return { ...targetModal, start: end - 125, end };
  } });
  await f.run('await app.pressKey("super+w");');
  assert.equal(f.clock(), 10425);
  assert.ok(f.output.some(text => text.includes('"reason":"modal child"')));
});

test('DPr rejects modal pairs more than 200 ms apart', async () => {
  const f = closeFixture({ sample: ms => {
    if (ms < 250) return { status: 'unknown' };
    const end = 10150 + Math.floor((ms - 250) / 225) * 225;
    return { ...targetModal, start: end - 125, end };
  } });
  await f.run('await app.pressKey("super+w");');
  assert.equal(f.clock(), 11500);
});

test('DPr a proven skip that wins the race survives crossing the deadline before continuation', async () => {
  const f = closeFixture();
  let checks = 0;
  f.context.Date = class extends Date { static now() {
    if (f.clock() > 10000 && ++checks >= 5) return 11500;
    return f.clock();
  } };
  await f.run('await app.pressKey("super+w");');
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
  assert.ok(f.output.some(text => text.includes('"decision":"skipped-read"')));
  assert.equal(f.timers.cleared.filter(timer => timer.ms === 1500).length, 1);
});

for (const rejects of [false, true]) test(`DPr the 1500 ms race ignores a stuck file read's late ${rejects ? 'rejection' : 'reply'}`, async t => {
  const f = closeFixture();
  const readFile = fsPromises.readFile;
  let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  t.mock.method(fsPromises, 'readFile', (...args) => {
    if (!String(args[0]).includes('close-')) return readFile(...args);
    started();
    return new Promise((resolve, reject) => { finish = rejects ? reject : resolve; });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const run = f.run('await app.pressKey("super+w");');
  await waiting;
  f.advance(1500);
  await run;
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
  assert.equal(f.timers.fired.filter(timer => timer.ms === 1500).length, 1);
  assert.equal(f.timers.pending.size, 0);
  finish(rejects ? Error('late file error') : JSON.stringify({ observations: [{ ...nativeClosed, start: 10025, end: 11500 }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.output.filter(text => text.startsWith('[sleight:dp1]')).length, 1);
  assert.ok(f.output.some(text => text.includes('"decision":"kept-read"')));
  assert.equal(f.timers.pending.size, 0);
});

test('DPn caller-read retains the engine read and carries the native failure code', async () => {
  for (const unknownReason of ['cgs-unbound', 'cgs-error', 'predicate-error', 'deadline']) {
    const f = closeFixture({ sample: { status: 'unknown', unknownReason } });
    await f.run('globalThis.__sleightOpenedApp2 = await cua.getApp("fixture.app");', closeOptions, closeTarget);
    f.calls.length = 0; f.output.length = 0;
    await f.run(recordedClose);
    const decision = JSON.parse(f.output.find(text => text.startsWith('[sleight:dp1]')).slice(13));
    assert.equal(decision.decision, 'kept-read');
    assert.equal(decision.reason, 'native unavailable');
    assert.equal(decision.unknownReason, unknownReason);
    assert.equal(f.calls.filter(call => call[0] === 'both').length, 1);
  }
});

test('DP1 preserves action, private mark and opt-in checks in fresh and cached guards', async () => {
  for (const cached of [false, true]) for (const c of [
    { options: { dp1: false } }, { options: { guardStopMark: undefined } },
    { options: { closeRead: undefined } }, { noTimers: true }, { target: expected },
    { target: { ...closeTarget, nativeIdentity: { pid: 123 } } },
    { target: { ...closeTarget, appId: undefined } },
    { key: 'super+s' }, { key: 'ctrl+w' }, { key: 'super+alt+w' },
    { code: 'await app.pressKey("super+w"); await app.typeText("x");' },
    { code: 'try { await app.pressKey("super+w"); } catch {}', fail: true },
  ]) {
    const f = closeFixture({ action: (name, args) => { if (c.fail && args[0] === 'super+w') throw Error('failed'); } });
    if (cached) await f.run('await app.pressKey("super+s");');
    if (c.noTimers) f.context.clearTimeout = undefined;
    f.calls.length = 0; f.output.length = 0;
    const run = f.run(c.code ?? `await app.pressKey(${JSON.stringify(c.key ?? 'super+w')});`,
      { ...closeOptions, reuseSetup: cached, ...c.options }, c.target ?? closeTarget);
    await run;
    assert.ok(f.calls.filter(call => call[0] === 'read').length >= 2, JSON.stringify(c));
    assert.ok(!f.output.some(text => text.includes('private-close-mark:closed')), JSON.stringify(c));
  }
});

test('DP1 covers the recorded caller observations without inventing a state or screenshot', async () => {
  for (const cached of [false, true]) for (const method of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot']) {
    for (const remaining of [false, true]) {
      const f = closeFixture({ sample: { ...nativeClosed, windowCount: remaining ? 1 : 0 } });
      await f.run('globalThis.__sleightOpenedApp2 = await cua.getApp("fixture.app");');
      f.calls.length = 0; f.output.length = 0;
      const code = method === 'getAXStateAndScreenshot' ? recordedClose : `await app.pressKey("super+w"); await app.${method}();`;
      const run = f.run(code, { ...closeOptions, reuseSetup: cached });
      if (remaining) await run;
      else await assert.rejects(run, /\[sleight:closed-read\]/, JSON.stringify({ cached, method, output: f.output }));
      assert.equal(f.calls.filter(c => c[0] === 'pressKey').length, 1);
      assert.equal(f.calls.filter(c => c[0] === 'both' || c[0] === 'screenshot').length,
        remaining && method !== 'getAXState' ? 1 : 0);
      const events = f.output.filter(text => text.startsWith('[sleight:dp1]')).map(text => JSON.parse(text.slice(13)));
      assert.equal(events[0].source, 'caller-read');
      assert.equal(events[0].decision, remaining ? 'kept-read' : 'skipped-read');
      assert.equal(events[0].windowCount, remaining ? 1 : 0);
      assert.equal(f.output.some(text => text.includes('private-close-mark:closed-read')), !remaining);
    }
  }
});

test('DPn keeps reads when samples predate the key, files fail or input overtakes the sample', async () => {
  const f = fixture();
  const path = join(leaseDir, 'stale-close.obs');
  writeFileSync(path, JSON.stringify({ observations: [{ start: 1, end: 2, ...nativeClosed }] }));
  closeClock(f);
  const start = f.clock();
  await f.run('await app.pressKey("super+w");', { ...closeOptions, closeRead: { path } }, closeTarget);
  assert.equal(f.clock() - start, 1500);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
  assert.ok(f.output.some(text => text.includes('"reason":"timeout"')));
  const race = closeFixture();
  await race.run('await app.pressKey("super+w"); const observation = app.getAXStateAndScreenshot(); await app.typeText("x"); await observation;');
  assert.ok(race.output.some(text => text.includes('"reason":"action changed"')));
  assert.equal(race.calls.filter(c => c[0] === 'both').length, 1);
  const missing = fixture();
  closeClock(missing);
  await missing.run('await app.pressKey("super+w");', { ...closeOptions, closeRead: { path: path + '.missing' } }, closeTarget);
  assert.equal(missing.clock(), 11500);
  assert.equal(missing.calls.filter(c => c[0] === 'read').length, 2);
  assert.ok(missing.output.some(text => text.includes('"decision":"kept-read"') && text.includes('"reason":"error"')));
});

test('DP1 recorded close runs through relay wrapping, emits its call id and returns the close notice', { skip: parserSkip }, async () => {
  for (const [remaining, enabled, exited] of [[false, true, false], [false, true, true], [true, true, false], [true, false, false]]) {
    let closed = false, nativeReads = 0;
    const f = fixture({ action: () => { closed = true; }, current: () => {
      if (closed && !remaining) throw Error('noWindowsAvailable');
      return closed ? tree({ ...expected, title: 'Untitled', url: undefined }) : tree();
    } });
    f.context.cua.listApps = async () => [{ ...recordedApp, id: 'fixture.app' }];
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [], replies = [], traces = [];
    serverIn.on('data', data => sent.push(JSON.parse(data)));
    clientOut.on('data', data => replies.push(JSON.parse(data)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, closeReadSkip: enabled, guardTiming: true,
      inputLease: new InputLease({ directory: leaseDir, holder: 'recorded-close' }),
      windowIdentity: async window => window.closeCount ? (nativeReads++, { ...nativeClosed, running: !exited, windowCount: remaining ? 1 : 0 }) : ({ ...window, status: 'ok', epoch: 'fixture', window: 1,
        windowNumber: 44, pid: 123, processStart: 1, matches: 1 }),
      trace: (direction, msg) => traces.push({ direction, msg }) });
    const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    try {
      call(1, 'let __sleightOpenedApp2 = await cua.getApp("TextEdit");');
      // The VM wraps each execution in an async function; save the binding that
      // the engine's persistent REPL would keep across calls.
      await runInNewContext(`(async () => { ${sent.find(msg => msg.id === 1).params.arguments.code}
        globalThis.__sleightOpenedApp2 = __sleightOpenedApp2; })()`, f.context,
      { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      serverOut.write(JSON.stringify({ id: 1, result: { content: [...f.output.map(text => ({ type: 'text', text })), { type: 'text', text: tree() }],
        _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
      await new Promise(resolve => setImmediate(resolve));
      call(8, exited ? recordedClose.replace('super+w', 'cmd+q') : recordedClose);
      await new Promise(resolve => setImmediate(resolve));
      const forwarded = sent.find(msg => msg.id === 8)?.params.arguments.code;
      assert.ok(forwarded?.includes('guardStopMark'), 'the recorded handle alias receives the native guard');
      f.output.length = 0; f.calls.length = 0;
      let error;
      try { await runInNewContext(`(async () => { ${forwarded} })()`, f.context,
        { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
      catch (caught) { error = caught; }
      serverOut.write(JSON.stringify({ id: 8, result: { isError: !!error,
        content: [...f.output.map(text => ({ type: 'text', text })), ...(error ? [{ type: 'text', text: error.message }] : [])],
        _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
      const decisions = traces.filter(t => t.direction === 'dp1-decision').map(t => t.msg);
      assert.equal(decisions.length, enabled ? 1 : 0, JSON.stringify({ error: error?.message, output: f.output }));
      if (enabled) {
        assert.equal(decisions[0].id, 8);
        assert.equal(decisions[0].source, 'caller-read');
        assert.equal(decisions[0].reason, remaining ? 'windows non-empty' : exited ? 'process exited' : 'no windows');
        assert.equal(decisions[0].windowCount, remaining ? 1 : 0);
        assert.ok(nativeReads > 0);
      } else assert.equal(nativeReads, 0);
      const reply = replies.find(msg => msg.id === 8);
      assert.equal(reply.result.isError, false);
      const check = loadCheck('DP1');
      const replay = { calls: [{ index: 0, name: 'js', recordedArguments: { code: recordedClose },
        result: reply.result, startedAt: '0', finishedAt: '2' }] };
      const events = traces.map(({ direction, msg }) => ({ t: '1', direction, msg }));
      assert.equal(checkEvidence(check, replay, events).verdict, enabled && !remaining ? 'pass' : 'fail');
      if (enabled && !remaining) assert.equal(checkEvidence(check, replay,
        [...events, { t: '1', direction: 'guard-read', msg: { phase: 'after-call' } }]).verdict, 'fail');
      const text = JSON.stringify(reply.result.content);
      assert.match(text, remaining ? /Untitled/ : /the app has no windows left/);
      assert.ok(!text.includes('[sleight:dp1]') && !text.includes(':closed-read'));
      assert.equal(f.calls.filter(c => c[0] === 'both').length, remaining ? 1 : 0);
      if (!remaining) {
        const count = sent.length;
        call(9, 'await app.click(1)');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sent.length, count, 'a confirmed last-window close clears the recovery target');
        assert.equal(replies.find(msg => msg.id === 9).result.isError, true);
      }
    } finally { await relay.dispose(); }
  }
});

test('DPr relay renews close observation on accepted app keys and pauses before tracing the decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const clearTimer = globalThis.clearTimeout;
  let cleared = 0, clearedBeforeResult, clearedAtDecision;
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer !== undefined) cleared++; return clearTimer(timer); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], starts = [];
  serverIn.on('data', data => sent.push(JSON.parse(data)));
  clientOut.on('data', data => received.push(JSON.parse(data)));
  let sampledAtDecision;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory: leaseDir, holder: 'bounded-close' }),
    windowIdentity: async window => {
      if (window.closeCount) { starts.push(Date.now()); return nativeClosed; }
      return { ...window, status: 'ok', epoch: 'fixture', window: 1, windowNumber: 44, pid: 123, processStart: 1, matches: 1 };
    },
    trace: direction => {
      if (direction !== 'dp1-decision') return;
      sampledAtDecision = starts.length;
      clearedAtDecision = cleared;
      // stripDP1Trace invokes pause before this trace, while finishedCall has
      // not yet invoked end. A waiting observer must already be cancelled.
      t.mock.timers.tick(25);
      assert.equal(starts.length, sampledAtDecision);
    } });
  t.after(() => relay.dispose());
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const tick = async ms => { t.mock.timers.tick(ms); await settle(); };
  const key = async (id, app, action) => {
    serverOut.write(JSON.stringify({ id, method: 'elicitation/create', params: { message: 'Allow?', mode: 'form',
      requestedSchema: { type: 'object', properties: {} }, _meta: { connector_id: 'computer-use', tool_name: 'press_key',
        tool_params: { app }, persist: ['session'], riskLevel: 'low' } } }) + '\n');
    await settle();
    if (!sent.some(message => message.id === id && message.result)) {
      const request = received.find(message => message.id === id);
      assert.ok(request, 'the fake approval is forwarded to the fake client');
      clientIn.write(JSON.stringify({ id, result: { action, content: {} } }) + '\n');
      await settle();
    }
  };
  call(1, 'let app = await cua.getApp("TextEdit");');
  serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: tree() }],
    _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
  await settle();
  call(8, 'await app.pressKey("super+w");');
  await settle();
  await tick(0);
  assert.equal(starts.length, 1);
  await tick(1500);
  await key('declined', 'fixture.app', 'decline');
  await tick(500);
  const stopped = starts.length;
  await tick(500);
  assert.equal(starts.length, stopped, 'a decline does not extend the initial bound');
  await key('wrong-app', 'other.app', 'accept');
  await tick(100);
  assert.equal(starts.length, stopped, 'another app cannot restart the observer');
  await key('accepted', 'fixture.app', 'accept');
  await tick(80);
  assert.equal(starts.length, stopped + 1, 'an accepted key restarts the expired observer');
  await tick(1500);
  await key('cached', 'fixture.app', 'accept');
  await tick(600);
  assert.ok(starts.at(-1) > 14000, 'a cached approval also renews the bound');
  clearedBeforeResult = cleared;
  serverOut.write(JSON.stringify({ id: 8, result: { content: [{ type: 'text', text:
    '[sleight:dp1]{"decision":"kept-read","reason":"windows non-empty"}\n' + tree() }] } }) + '\n');
  await settle();
  assert.ok(clearedAtDecision > clearedBeforeResult, 'pause clears the observer wait before the decision trace and end');
  assert.equal(sampledAtDecision, starts.length);
  await tick(2000);
  assert.equal(starts.length, sampledAtDecision);
});

test('lean calls keep a strict native handle across calls and report an unchanged action compactly', async () => {
  const f = fixture({ strict: true });
  await f.run('globalThis.saved = await cua.getApp("fixture.app");');
  await f.run('await saved.click(1);');
  await f.run('await saved.pressKey("a");');
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'pressKey').length, 1);
  const compactor = createReadCompactor({ leanCalls: true });
  compactor.process([{ type: 'text', text: tree() }]);
  const content = compactor.process([{ type: 'text', text: f.output.at(-1) }], { action: compactor.beginAction('await app.pressKey("a");') });
  assert.match(content[0].text, /^Window: /);
  assert.match(content[0].text, /no change since/);
  assert.doesNotMatch(content[0].text, /1 button Save/);
});

test('lean action results retain changed rows, explicit full reads and stale-number refusals', () => {
  const compactor = createReadCompactor({ leanCalls: true });
  compactor.process([{ type: 'text', text: tree() }]);
  const next = tree(expected, '\t2 button Save, ID: Save');
  const marked = [{ type: 'text', text: GUARD_MARK + next + GUARD_END }];
  const action = compactor.beginAction('await app.click(1);');
  const content = compactor.process(marked, { action });
  assert.match(content[0].text, /other elements have new numbers/);
  assert.ok(compactor.staleIndex(expected, 'await app.click(1);'));
  assert.equal(compactor.process(marked, { forceFull: true })[0].text, next);
  const changed = tree(expected, '\t2 button Done, ID: Done');
  const changedContent = compactor.process([{ type: 'text', text: GUARD_MARK + changed + GUARD_END }],
    { action: compactor.beginAction('await app.click(2);') });
  assert.match(changedContent[0].text, /\+ \t2 button Done, ID: Done/);
  assert.match(changedContent[0].text, /- \tbutton Save, ID: Save/);
  const defaultCompactor = createReadCompactor({ leanCalls: false });
  defaultCompactor.process([{ type: 'text', text: tree() }]);
  assert.equal(defaultCompactor.process([{ type: 'text', text: GUARD_MARK + tree() + GUARD_END }],
    { action: defaultCompactor.beginAction('await app.click(1);') })[0].text, tree());
});

test('the relay selects compact native results only for lean calls and honors explicit full reads', async t => {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  for (const leanCalls of [false, true]) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [], received = [];
    serverIn.on('data', data => sent.push(JSON.parse(data.toString())));
    clientOut.on('data', data => received.push(JSON.parse(data.toString())));
    const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lean-calls-')));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, leanCalls, changeReview: false,
      inputLease: new InputLease({ directory, holder: 'lean-test' }) });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); removeTemp(directory); });
    const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    const reply = (id, text) => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }],
      _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
    call(1, 'let app = await cua.getApp("fixture.app");'); await settle(); reply(1, tree()); await settle();
    call(2, 'await app.click(1);'); await settle();
    assert.ok(sent.some(message => message.id === 2), 'the saved app handle can act without acquisition');
    reply(2, GUARD_MARK + tree() + GUARD_END); await settle();
    const result = received.find(message => message.id === 2).result.content[0].text;
    if (leanCalls) { assert.match(result, /no change since/); assert.doesNotMatch(result, /1 button Save/); }
    else assert.equal(result, tree());
    call(3, 'await app.getAXState({ disableDiffing: true });'); await settle();
    reply(3, GUARD_MARK + tree() + GUARD_END); await settle();
    assert.equal(received.find(message => message.id === 3).result.content[0].text, tree());
  }
});

test('a combined observation supplies the first action and a full post-call header', async () => {
  const f = fixture();
  await f.run('await app.getAXStateAndScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  assert.equal(f.calls[0][1].disableDiffing, true);
  assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END);
});

test('a final combined read avoids an extra read and preserves hidden output semantics', async () => {
  for (const emit of [true, false]) {
    const f = fixture();
    await f.run(`await app.click(1); const observed = await app.getAXStateAndScreenshot({ emit: ${emit} });
      if (observed.screenshot[2] !== 3) throw new Error('screenshot changed');`);
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'both']);
    assert.equal(f.calls.at(-1)[1].emit, emit);
    if (!emit) assert.equal(f.output.at(-1), GUARD_OMIT_MARK + tree() + GUARD_END);
    else assert.equal(f.output.at(-1), tree());
  }
});

test('combined read always requests a full tree, even when its caller requests a diff', async () => {
  const f = fixture({ screenshotState: options => options?.disableDiffing ? tree() : '+ 2 button Other' });
  await f.run('await app.getAXStateAndScreenshot({ disableDiffing: false }); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
});

test('each action invalidates the combined snapshot before checking title, app and URL again', async () => {
  for (const key of ['title', 'app', 'url']) {
    let changed = false;
    const f = fixture({ current: () => tree(changed ? { ...expected, [key]: 'other' } : expected),
      action: () => { changed = true; } });
    await assert.rejects(f.run('await app.getAXStateAndScreenshot(); await app.click(1); await app.click(1);'), /changed window/);
    assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  }
});

test('every native method checks the identity returned by a combined observation', async () => {
  for (const expression of ['click(1)', 'drag([1,1],[2,2])', 'scroll(1,"down",1)', 'selectText(1,"x")',
    'setValue(1,"x")', 'performSecondaryAction(1,"Raise")', 'paste("x")', 'pressKey("a")', 'typeText("x")']) {
    const f = fixture({ current: () => tree({ ...expected, url: 'file:///tmp/b.txt' }) });
    await assert.rejects(f.run(`await app.getAXStateAndScreenshot(); await app.${expression};`), /changed window/);
    assert.deepEqual(f.calls.map(c => c[0]), ['both']);
  }
});

test('a renumbered element is followed only when its line is in the new tree exactly once', async () => {
  for (const [after, clicks] of [['\t2 button Delete\n\t3 button Save, ID: Save', [2, 3]],
    ['\t2 button Delete\n\t3 button Save, ID: Save\n\t4 button Save, ID: Save', [2]]]) {
    let changed = false;
    const f = fixture({ current: () => tree(expected, changed ? after : '\t2 button Save, ID: Save'), action: () => { changed = true; } });
    const done = f.run('await app.getAXStateAndScreenshot(); await app.click(2); await app.click(2);');
    if (clicks.length === 1) await assert.rejects(done, /changed what element 2 is/); else await done;
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), clicks);
  }
});

test('a combined snapshot cannot preserve a stale number, ID or label after an action', async () => {
  for (const selector of ['2', '{ id: "Save" }', '{ label: "Save" }']) {
    let changed = false;
    const f = fixture({ current: () => tree(expected, changed ? '\t2 button Delete\n\t3 button Save, ID: Save' : '\t2 button Save, ID: Save'),
      action: () => { changed = true; } });
    const done = f.run(`await app.getAXStateAndScreenshot(); await app.click(2); await app.click(${selector});`);
    if (selector === '2') {
      // The line Claude saw ("button Save, ID: Save") is now 3, once: the click goes there.
      await done;
      assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
    } else {
      await done;
      assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
    }
  }
});

test('a read that drops an element\'s attributes under load still matches that element', async () => {
  // Under load the engine read "button Two" where it had read "button Description: 2, ID: Two".
  const full = '\t2 button Description: 1, ID: One\n\t3 button Description: 2, ID: Two';
  const bare = '\t2 button One\n\t3 button Two';
  let clicks = 0;
  const f = fixture({ current: () => tree(expected, clicks ? bare : full), action: () => { clicks++; } });
  await f.run('await app.click(2); await app.click(3);');
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
  let moved = 0;
  const g = fixture({ current: () => tree(expected, moved ? '\t2 button One\n\t3 button Three' : full), action: () => { moved++; } });
  await assert.rejects(g.run('await app.click(2); await app.click(3);'), /changed what element 3 is/);
});

test('sameElement accepts only a bare line named by the fuller line\'s ID or label', () => {
  assert.equal(sameElement('button Description: 2, ID: Two', 'button Two'), true);
  assert.equal(sameElement('button Two', 'button Description: 2, ID: Two'), true);
  assert.equal(sameElement('button Description: 2, ID: Two', 'button 2'), true, 'by description');
  assert.equal(sameElement('toggle button Description: Bold, ID: bold', 'toggle button Bold'), true);
  for (const now of ['button Three', 'checkbox Two', 'button Two, ID: Other', 'button', 'button Tw', undefined]) {
    assert.equal(sameElement('button Description: 2, ID: Two', now), false, String(now));
  }
  assert.equal(sameElement(undefined, undefined), true);
});

test('keys, text, paste and coordinates go ahead without a read only after typing, pasting or a plain key', async () => {
  // After a click, Return or a shortcut the next action reads, which also waits for a panel to open.
  const sequence = 'await app.click(1); await app.typeText("x"); await app.pressKey("Return"); await app.paste("y"); await app.click([5, 5]); await app.drag([1, 1], [2, 2]);';
  const f = fixture();
  await f.run(sequence);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'typeText', 'pressKey', 'read', 'paste', 'click', 'read', 'drag', 'read']);
  const keys = fixture();
  await keys.run('await app.typeText("a"); await app.pressKey("b"); await app.pressKey("Left"); await app.pressKey("super+shift+g"); await app.typeText("/tmp"); await app.pressKey("Return");');
  assert.deepEqual(keys.calls.map(c => c[0]), ['read', 'typeText', 'pressKey', 'pressKey', 'pressKey', 'read', 'typeText', 'pressKey', 'read']);
  const careful = fixture();
  await careful.run(sequence, { careful: true });
  assert.deepEqual(careful.calls.map(c => c[0]), ['read', 'click', 'read', 'typeText', 'read', 'pressKey', 'read', 'paste', 'read', 'click', 'read', 'drag', 'read']);
  // The first action of a call is still checked, and a numbered action after another still reads.
  const first = fixture();
  await first.run('await app.typeText("x"); await app.click(1);');
  assert.deepEqual(first.calls.map(c => c[0]), ['read', 'typeText', 'read', 'click', 'read']);
});

for (const action of ['app.pressKey("a")', 'app.pressKey("Return")', 'app.typeText("x")', 'app.paste("x")',
  'app.click([5,5])', 'app.drag([1,1],[2,2])', 'app.scroll([5,5], "down", 1)'])
  test('first-off skips only the first guard read for ' + action, async () => {
    for (const [options, reads] of [[{}, 2], [{ firstOff: true }, 1], [{ firstOff: true, careful: true }, 2],
      [{ firstOff: true, fileOnly: true }, 2]]) {
      const f = fixture({ strict: true }); await f.run('await ' + action + ';', options);
      assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
      assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END);
    }
  });

for (const action of ['app.click(1)', 'app.click({id:"Save"})', 'app.click({label:"Save"})',
  'app.setValue(1,"x")', 'app.selectText(1,"x")', 'app.performSecondaryAction(1)'])
  test('first-off retains a fresh lookup for ' + action, async () => {
    const f = fixture({ strict: true }); await f.run('await ' + action + ';', { firstOff: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', action.match(/app\.(\w+)/)[1], 'read']);
  });

for (const action of ['app.click([5,5])', 'app.pressKey("super+o")', 'app.pressKey("Return")',
  'app.pressKey("Escape")', 'app.pressKey("Tab")', 'app.pressKey("Space")'])
  test('first-off keeps the next settle read after ' + action, async () => {
    const f = fixture({ strict: true }); await f.run('await ' + action + '; await app.typeText("x");', { firstOff: true });
    assert.deepEqual(f.calls.map(c => c[0]), [action.match(/app\.(\w+)/)[1], 'read', 'typeText', 'read']);
  });

test('first-off leaves the first numbered baseline unset until its fresh lookup', async () => {
  const f = fixture({ strict: true });
  await f.run('await app.typeText("x"); await app.click(1);', { firstOff: true, literals: [1], seenLines: { 1: 'button Save, ID: Save' } });
  assert.deepEqual(f.calls.map(c => c[0]), ['typeText', 'read', 'click', 'read']);
});

test('first-off uses an explicit in-call read and still refuses its changed window', async () => {
  const f = fixture({ strict: true, current: () => tree({ ...expected, title: 'other.txt' }) });
  await assert.rejects(f.run('await app.getAXState(); await app.typeText("x");', { firstOff: true }), /changed window/);
  assert.equal(f.calls.some(c => c[0] === 'typeText'), false);
});

test('first-off resets each call and does not use the prior inventory for its skipped read', async () => {
  const f = fixture({ strict: true });
  f.context.cua.listApps = () => { assert.fail('first-off must not inventory to reuse the skipped first read'); };
  const prior = { text: tree(), id: 'fixture.app', title: 'a.txt', windows: [{ title: 'a.txt' }] };
  for (let i = 0; i < 2; i++) {
    f.calls.length = 0;
    await f.run('await app.typeText("x"); await app.pressKey("a");', { firstOff: true, prior });
    assert.deepEqual(f.calls.map(c => c[0]), ['typeText', 'pressKey', 'read']);
  }
  f.calls.length = 0; await f.run('await app.typeText("x");');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'typeText', 'read']);
});

test('first-off still refuses input after lease expiry or replacement, before any read or write', async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-first-off-lease-')));
  t.after(() => removeTemp(dir)); const path = join(dir, 'lease.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const record of [{ token: 'owner', expires: 0 }, { token: 'successor', expires: Date.now() + 30000 }]) {
    writeFileSync(path, JSON.stringify(record)); let reads = 0, writes = 0;
    const raw = new Proxy({ getAXState: async () => { reads++; return tree(); }, typeText: async () => { writes++; } }, {
      get(object, key) { if (key in object || typeof key === 'symbol' || key === 'then') return object[key]; throw Error('unsupported fake ' + key); },
    });
    const code = guardedCode('await app.typeText("x");', expected, 'changed window', { path, token: 'owner' }, { firstOff: true });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw }, { write() {} }), /ownership lost or expired/);
      assert.equal(reads, 0); assert.equal(writes, 0);
    } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
  }
});

test('bind sends seven clicks from one capture and retains the final read', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `\t${i + 1} button Description: Key ${i + 1}, ID: key-${i + 1}`).join('\n');
  for (const [options, reads] of [[{}, 8], [{ bind: true }, 2], [{ bind: true, careful: true }, 8]]) {
    const f = fixture({ strict: true, current: () => tree(expected, rows) });
    await f.run(Array.from({ length: 7 }, (_, i) => `await app.click(${i + 1});`).join('\n'), options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(f.output.at(-1), GUARD_MARK + tree(expected, rows) + GUARD_END);
  }
});

test('bound Calculator-style clicks take no inventory or AX read between clicks', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `\t${i + 1} button Description: ${i + 1}, ID: key-${i + 1}`).join('\n');
  const f = fixture({ strict: true, current: () => tree(expected, rows) });
  let inventories = 0, clock = 0;
  f.context.performance = { now: () => clock };
  f.context.cua.listApps = async options => {
    assert.equal(options.emit, false); inventories++; clock += 11;
    return [{ id: 'fixture.app', displayName: expected.app, isRunning: true }];
  };
  await f.run(Array.from({ length: 7 }, (_, i) => `await app.click(${i + 1});`).join('\n'), { bind: true, timing: true });
  assert.equal(inventories, 0);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', ...Array(7).fill('click'), 'read']);
  const metrics = f.output.filter(line => line.startsWith('[sleight:guard-timing]')).map(line => JSON.parse(line.slice(22)));
  assert.deepEqual(metrics.filter(m => m.phase === 'bound-windows'), []);
});

test('a plain button swapping to a look-alike document stays bound until the final read', async () => {
  let replaced = false;
  const replacement = { ...expected, url: 'file:///tmp/look-alike/a.txt' };
  const rows = '\t1 button First\n\t2 button Second';
  const f = fixture({ strict: true, current: () => tree(replaced ? replacement : expected, rows),
    action: () => { replaced = true; } });
  f.context.cua.listApps = () => { assert.fail('bound actions must not request a window inventory'); };
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  assert.equal(f.output.at(-1), GUARD_MARK + tree(replacement, rows) + GUARD_END);
});

test('macOS listApps without windows does not disable a bound capture', async () => {
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button First\n\t2 button Second') });
  // Installed Mac adapter: id, displayName, isRunning, lastUsedDate and useCount; no windows.
  f.context.cua.listApps = async () => [{ id: 'fixture.app', displayName: expected.app, isRunning: true }];
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
});

for (const title of ['Delete', 'Remove Group', 'Revert', 'Discard', 'Erase', 'Empty Trash', 'Close', 'Quit', 'Exit',
  'Sign Out', 'Log Out', 'Reset', 'Clear', 'Replace', "Don't Save", 'Do Not Save', 'Save', 'OK', 'Done', 'Apply',
  'Continue', 'Proceed', 'Next', 'Back', 'Finish', 'Confirm', 'Accept', 'Cancel', 'Dismiss'])
  test('binding reads after a plain confirming button: ' + title, async () => {
    const f = fixture({ current: () => tree(expected, '\t1 button ' + title + '\n\t2 button Second') });
    await f.run('await app.click(1); await app.click(2);', { bind: true });
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
  });

for (const line of ['button Delete, ID: opener', 'button Description: Delete, ID: opener',
  'button (enabled) Description: Remove Group, ID: opener', 'button ID: opener, Description: Save',
  'button Description: Delete, Help: Delete the last digit, ID: opener',
  'button Description: Browse…, ID: opener', 'close button, ID: opener', 'close button (enabled), ID: opener']) {
  for (const target of ['1', '{ id: "opener" }', '{ line: ' + JSON.stringify(line) + ' }']) {
    for (const careful of [false, true]) {
      test(`confirming row refreshes before a stale click: ${line}, ${target}, careful=${careful}`, async () => {
        let changed = false;
        const f = fixture({ strict: true,
          current: () => tree(expected, changed ? '\t3 sheet Confirm\n\t1 button Cancel\n\t2 button Confirm unrelated deletion'
            : '\t1 ' + line + '\n\t2 button Second'), action: () => { changed = true; } });
        if (target === '1' && line.startsWith('close button')) {
          await assert.rejects(f.run(`await app.click(${target}); await app.click(2);`, { bind: true, careful }),
            /element 1 is the window's close button; close a window by label or with Cmd\+W/);
          assert.deepEqual(f.calls.map(c => c[0]), ['read']);
          return;
        }
        await assert.rejects(f.run(`await app.click(${target}); await app.click(2);`, { bind: true, careful }),
          /changed what element 2 is/);
        assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
        assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 1]]);
      });
    }
  }
}

for (const line of ['button Description: Delete, ID: opener', 'button ID: opener, Description: Delete']) {
  test('a label click refreshes after the displayed confirming label: ' + line, async () => {
    let changed = false;
    const f = fixture({ strict: true, current: () => tree(expected,
      changed ? '\t1 button Cancel\n\t2 button Other' : '\t1 ' + line + '\n\t2 button Second'),
    action: () => { changed = true; } });
    await assert.rejects(f.run('await app.click({ label: "Delete" }); await app.click(2);', { bind: true }),
      /changed what element 2 is/);
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
  });
}

for (const line of ['button Description: Mode, Help: Delete the last digit, ID: mode',
  'button Description: Mode, Secondary Actions: Delete, Cancel, ID: mode',
  'button Description: Mode, Help: Browse…, ID: mode', 'button Mode, ID: Delete',
  'button Help: Delete, ID: mode', 'button Secondary Actions: Delete, Cancel, ID: mode']) {
  test('binding ignores confirming words in unrelated fields: ' + line, async () => {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + line + '\n\t2 button Second') });
    await f.run('await app.click(1); await app.click(2);', { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  });
}

for (const field of ['Help', 'Secondary Actions', 'ID', 'Value']) {
  for (const value of ['Delete', 'Browse…', 'Open...']) {
    test(`leading ${field} metadata never supplies an opener label: ${value}`, async () => {
      const line = `button ${field}: ${value}${field === 'ID' ? '' : ', ID: mode'}`;
      const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + line + '\n\t2 button Second') });
      f.context.cua.listApps = () => { assert.fail('bound clicks must not request an inventory'); };
      await f.run('await app.click(1); await app.click(2);', { bind: true });
      assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
    });
  }
}

test('setValue invalidates binding before the next element action', async () => {
  let changed = false;
  const f = fixture({ current: () => tree(expected, changed ? '\t1 text field Editor\n\t2 button Other' : '\t1 text field Editor\n\t2 button Second'),
    action: () => { changed = true; } });
  await assert.rejects(f.run('await app.setValue(1,"x"); await app.click(2);', { bind: true }), /changed what element 2 is/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'setValue', 'read']);
});

test('first-off checks another window handle in the same app even with a focus confirmation', async () => {
  const f = fixture();
  let keys = 0;
  f.context.otherRaw = { getAXState: async () => tree({ ...expected, title: 'other.txt' }), pressKey: async () => { keys++; } };
  await assert.rejects(f.run('const other = globalThis.__sleightDocumentGuard.wrap(globalThis.otherRaw); await other.pressKey("super+a");',
    { firstOff: true, focused: true }), /changed window/);
  assert.equal(keys, 0);
});

for (const target of ['2', '{ id: "second" }', '{ label: "Second" }', '{ line: "button Second, ID: second" }', '"Second"'])
  test('bind keeps the capture number for ' + target + ' until a read occurs', async () => {
    let acted = false;
    const f = fixture({ strict: true,
      current: () => tree(expected, acted ? '\t1 button First\n\t2 button Other\n\t3 button Second, ID: second' : '\t1 button First\n\t2 button Second, ID: second'),
      action: () => { acted = true; } });
    await f.run(`await app.click(1); await app.click(${target});`, { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [1, 2]);
  });

for (const line of ['menu button Actions', 'pop up button Choices', 'menu bar item File', 'menu item Save',
  'link Details', 'tab General', 'disclosure triangle More', 'button Browse…', 'button Browse...'])
  test('bind reads after the resolved opener ' + line, async () => {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + line + ', ID: opener\n\t2 button Next') });
    await f.run('await app.click({ id: "opener" }); await app.click(2);', { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read']);
  });

for (const key of ['super+o', 'Return', 'Escape', 'Space', 'Tab'])
  test('bind keeps the read before an element after ' + key, async () => {
    const f = fixture({ strict: true });
    await f.run(`await app.pressKey(${JSON.stringify(key)}); await app.click(1);`, { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'pressKey', 'read', 'click', 'read']);
  });

for (const target of ['{ id: "duplicate" }', '{ label: "Duplicate" }', '{ line: "button Duplicate, ID: duplicate" }', '"Duplicate"'])
  test('bind reads when the first capture is non-unique for ' + target, async () => {
    let acted = false;
    const rows = '\t1 button First\n\t2 button Duplicate, ID: duplicate';
    const f = fixture({ strict: true, current: () => tree(expected, rows + (acted ? '' : '\n\t3 button Duplicate, ID: duplicate')),
      action: () => { acted = true; } });
    await f.run(`await app.click(1); await app.click(${target});`, { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read']);
  });

// AB3 (Firefox travel, 2026-10-17): a click re-rendered the elements the bound capture held, and the engine refused the next number.
// lp1 (fix 4): when the fresh read has the refused line in the same place, the click goes once more there.
test('lp1: a bound click the engine refuses after an earlier action goes once more when its whole line is in the same place', async () => {
  let stale = false;
  const f = fixture({ strict: true, current: () => { stale = false; return tree(expected, '\t1 button First\n\t2 button Second'); },
    action: (name, [number]) => {
      if (stale) throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`);
      stale = true;
    } });
  await f.run('await app.click(1); await app.click({ label: "Second" }); await app.click(1);', { bind: true, guardStopMark: '[stop]' });
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [['read', f.calls[0][1]], ['click', 1], ['click', 2], ['read', f.calls[3][1]], ['click', 2],
    ['read', f.calls[5][1]], ['click', 1], ['read', f.calls[7][1]]]);
  // A resend that worked shows no stop: no receipt, and no tree but the call's closing read.
  assert.equal(f.output.filter(line => typeof line === 'string' && line.startsWith('[stop]{"index"')).length, 0);
  assert.equal(f.output.filter(line => typeof line === 'string' && line.startsWith(GUARD_MARK)).length, 1);
});

test('AB3: a bound element the engine refuses is not resent when its line moved, the stop carries a fresh tree, and that window stops binding', async () => {
  let stale = false, swapped = false;
  // A sort swapped the two rows: "button Second" is now element 1, which samePlace refuses.
  const rows = () => swapped ? '\t1 button Second\n\t2 button First' : '\t1 button First\n\t2 button Second';
  const f = fixture({ strict: true, current: () => { stale = false; return tree(expected, rows()); },
    action: (name, [number]) => {
      if (stale) { swapped = true; throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`); }
      stale = true;
    } });
  await assert.rejects(f.run('await app.click(1); await app.click({ label: "Second" }); await app.click(1);', { bind: true, guardStopMark: '[stop]' }),
    /2 is an invalid element ID/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  assert.ok(f.output.includes(GUARD_MARK + tree(expected, '\t1 button Second\n\t2 button First') + GUARD_END));
  swapped = false;
  const receipt = JSON.parse(f.output.find(line => line.startsWith('[stop]{"index"')).slice(6));
  assert.equal(receipt.refused, true); assert.equal(receipt.bound, true);
  f.calls.length = 0;
  await f.run('await app.click(1); await app.click({ label: "Second" });', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read']);
});

// lp1 (fix 4), Safari b7 r2 call 5 (race-1017): click(43) picked December 14, the picker rebuilt its day buttons, and the
// engine refused click(48) with AXError.invalidUIElement although the fresh read had "button Saturday, December 19, 2026" at
// 48 as before. The refusal cost 1.7 to 5.2 s a run in 10 of 11 sleight form-travel runs.
const travel = { title: 'sleight benchmark — Book a trip · Skyway', app: 'Safari', url: null };
const picker = (value, extra = '') => [`Window: ${JSON.stringify(travel.title)}, App: Safari.`, `0 standard window ${travel.title}, ID: SafariWindow?IsSecure=false`,
  '\t5 HTML content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel', '\t\t23 text Dates', '\t\t24 container',
  `\t\t\t25 text field Dates, ${value}Placeholder: Check-in – check-out`, '\t\t\t26 container Choose dates', '\t\t\t\t27 button Previous month',
  '\t\t\t\t28 text December 2026', '\t\t\t\t29 button Next month', ...extra ? [extra] : [],
  ...Array.from({ length: 31 }, (_, i) => `\t\t\t\t${(extra ? 31 : 30) + i} button ${['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday'][i % 7]}, December ${i + 1}, 2026`),
  '\t\t61 text Pick check-in, then check-out.', '\t\t74 button Next'].join('\n');
function pickerFixture({ before = () => picker(''), after = () => picker('Value: Dec 14, 2026 – choose check-out, '), refuse = 1,
  error = 'Accessibility error: AXError.invalidUIElement' } = {}) {
  let picked = false, refusals = refuse;
  const f = fixture({ strict: true, current: () => picked ? after() : before(),
    action: (name, [number]) => {
      if (picked && refusals-- > 0) throw new Error(error.replace('N', number));
      picked = true;
    } });
  return { ...f, run: (code, options = {}) => f.run(code, { bind: true, guardStopMark: '[stop]', ...options }, travel) };
}

test('lp1: the date picker\'s refused check-out click goes once more to the same day, and nothing else changes', async () => {
  const f = pickerFixture();
  await f.run('await app.click(43); await app.click(48);');
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 48, 48]);
  assert.ok(!f.output.some(line => typeof line === 'string' && line.startsWith('sleight: click(')), 'same number: no note');
  // The engine's own wording is resent the same way.
  const g = pickerFixture({ error: 'Computer Use server error -10005: N is an invalid element ID' });
  await g.run('await app.click(43); await app.click({ label: "Saturday, December 19, 2026" });');
  assert.deepEqual(g.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 48, 48]);
});

test('lp1: a refused click whose line moved with an inserted row goes to its new number and says so', async () => {
  // samePlace's rules: every other row is the same element, so only the inserted row differs here.
  const f = pickerFixture({ after: () => picker('', '\t\t\t\t30 text Check-in Dec 14') });
  await f.run('await app.click(43); await app.click(48);');
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 48, 49]);
  assert.ok(f.output.includes('sleight: click(48) went to element 49, the same "button Saturday, December 19, 2026": an earlier action in this call renumbered the window.\n'));
});

test('lp1: a refused click is not resent as the first action, for a bare role, after a reorder, in another window, or twice', async () => {
  // First action: nothing in this call replaced the element.
  const lone = fixture({ strict: true, current: () => picker(''), action: () => { throw new Error('Accessibility error: AXError.invalidUIElement'); } });
  await assert.rejects(lone.run('await app.click(48);', { bind: true }, travel), /invalidUIElement/);
  assert.equal(lone.calls.filter(c => c[0] === 'click').length, 1);
  // A bare role says nothing about which element it was.
  const unnamed = () => picker('').replace('29 button Next month', '29 button');
  const bare = pickerFixture({ before: unnamed, after: unnamed });
  await assert.rejects(bare.run('await app.click(43); await app.click(29);'), /invalidUIElement/);
  assert.deepEqual(bare.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 29]);
  // The fresh read is another window.
  const moved = pickerFixture({ after: () => picker('').replaceAll(travel.title, 'Trips · Skyway') });
  await assert.rejects(moved.run('await app.click(43); await app.click(48);'), /invalidUIElement/);
  assert.deepEqual(moved.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 48]);
  // The days were re-sorted: the same line at another number with no inserted block.
  const sorted = pickerFixture({ after: () => picker('').replace('47 button Friday, December 18, 2026', '47 button Saturday, December 19, 2026')
    .replace('48 button Saturday, December 19, 2026', '48 button Friday, December 18, 2026') });
  await assert.rejects(sorted.run('await app.click(43); await app.click(48);'), /invalidUIElement/);
  assert.deepEqual(sorted.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 48]);
  assert.ok(sorted.output.some(line => typeof line === 'string' && line.startsWith(GUARD_MARK)), 'the stop keeps its fresh tree');
  // Refused again: one resend only, and the stop carries the fresh tree and a receipt.
  const twice = pickerFixture({ refuse: 2 });
  await assert.rejects(twice.run('await app.click(43); await app.click(48);'), /invalidUIElement/);
  assert.deepEqual(twice.calls.filter(c => c[0] === 'click').map(c => c[1]), [43, 48, 48]);
  const receipt = JSON.parse(twice.output.find(line => line.startsWith('[stop]{"index"')).slice(6));
  assert.equal(receipt.refused, true); assert.equal(receipt.fresh, true);
});

// lp1 review: refusedPlace's own checks, each one alone, so a version that always answered "same place" fails here.
test('lp1 review: refusedPlace keeps a line only at the same number, depth, parent and previous row, and only when it is unique', () => {
  const rows = lines => lines.join('\n');
  const before = rows(['0 standard window W', '\t1 container Choose dates', '\t\t2 button Friday, December 18', '\t\t3 button Saturday, December 19',
    '\t4 container Guests', '\t\t5 button Add adult']);
  assert.deepEqual(refusedPlace(before, 3, before), [[3, 'button Saturday, December 19']]);
  const variants = {
    parent: before.replace('1 container Choose dates', '1 container Choose return dates'),
    depth: before.replace('\t\t3 button Saturday', '\t3 button Saturday'),
    previous: before.replace('2 button Friday, December 18', '2 button Thursday, December 17'),
    lookalike: before.replace('\t\t5 button Add adult', '\t\t5 button Saturday, December 19'),
    missing: before.replace('3 button Saturday, December 19', '3 button Saturday, December 19, Value: 1'),
  };
  for (const [name, after] of Object.entries(variants)) assert.deepEqual(refusedPlace(before, 3, after), [], name);
  // A lookalike already in the first tree, and a bare role, never resolve either.
  const twice = before.replace('\t\t5 button Add adult', '\t\t5 button Saturday, December 19');
  assert.deepEqual(refusedPlace(twice, 3, twice), []);
  const bare = before.replace('3 button Saturday, December 19', '3 button');
  assert.deepEqual(refusedPlace(bare, 3, bare), []);
});

// lp1 review finding 1: a line like "button Remove" is unique while a cart holds one item. After the cart re-renders with
// another item, the same line at the same place is another item's control, so a click on a control that opens or confirms
// is never resent, nor a click after one, nor one after an earlier action put a sheet over the page.
const cart = (item, top = '\t1 button Add to cart') => tree(expected, `${top}\n\t2 container Cart\n\t\t3 button Gift wrap\n\t\t4 button Remove\n\t\t5 text ${item}`);
test('lp1 review: a refused Remove, a click after an opener, and a click under a new sheet are not resent', async () => {
  const sort = '\t1 menu button Sort, ID: sort';
  for (const [code, before, after, sent] of [
    // Without these rules each of the first three would be resent: the line is unique and in the same place.
    ['await app.click(1); await app.click(4);', cart('Item A'), cart('Item B'), [1, 4]],
    ['await app.click({ id: "sort" }); await app.click(3);', cart('Item A', sort), cart('Item B', sort), [1, 3]],
    ['await app.click(1); await app.click(3);', cart('Item A'), cart('Item A') + '\n\t6 sheet Confirm\n\t\t7 button Keep', [1, 3]],
    // The same refusal with none of them goes once more.
    ['await app.click(1); await app.click(3);', cart('Item A'), cart('Item B'), [1, 3, 3]],
  ]) {
    let acted = false, refused = false;
    const f = fixture({ strict: true, current: () => refused ? after : before,
      action: (name, [number]) => { if (acted && !refused) { refused = true; throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`); } acted = true; } });
    const run = f.run(code, { bind: true, guardStopMark: '[stop]' });
    if (sent.length === 3) await run;
    else {
      await assert.rejects(run, /invalid element ID/, code);
      assert.ok(f.output.some(line => typeof line === 'string' && line.startsWith(GUARD_MARK)), 'the stop keeps its fresh tree');
    }
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), sent, code);
  }
});

test('lp1 review: a lease lost during the read after a refusal stops the resend', async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-resend-lease-')));
  t.after(() => removeTemp(dir)); const path = join(dir, 'lease.json');
  writeFileSync(path, JSON.stringify({ token: 'owner', expires: Date.now() + 30000 }));
  let picked = false, refused = false;
  const clicks = [];
  const raw = { getAXState: async () => {
    if (refused) writeFileSync(path, JSON.stringify({ token: 'successor', expires: Date.now() + 30000 }));
    return picker(picked ? 'Value: Dec 14, 2026 – choose check-out, ' : '');
  }, click: async number => {
    clicks.push(number);
    if (picked) { refused = true; throw new Error('Accessibility error: AXError.invalidUIElement'); }
    picked = true;
  } };
  // The lease check reads its file with a dynamic import, so this runs in the test's own realm.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const code = guardedCode('await app.click(43); await app.click(48);', travel, 'changed window', { path, token: 'owner' }, { focused: true, bind: true });
  try {
    await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw, listApps: async () => [] }, { write() {} }),
      /Input lease stopped this action/);
  } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
  assert.deepEqual(clicks, [43, 48]);
});

// lp1 review finding 5: after a resend to a new number, the call's last click is that element, so a pickFromList right
// after it accepts the list from the selected row.
test('lp1 review: a resend to a new number is the click pickFromList sees', async () => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  let shifted = false, stale = false, selected;
  const current = () => {
    stale = false;
    const first = shifted ? 4 : 3;
    return tree(expected, '\t1 button Show airports' + (shifted ? '\n\t2 text 6 airports' : '') + `\n\t${first - 1} list Airports\n` +
      names.map((name, i) => `\t\t${first + i} text ${selected === name ? '(selected)' : '(selectable)'} ${name}`).join('\n') +
      (selected ? `\n\nSelected:\n\t${first + names.indexOf(selected)} text (selected) ${selected}\n\nNote: Pay special attention to the content selected by the user.` : '\n\nThe focused UI element is 1 button Show airports'));
  };
  const f = fixture({ strict: true, current, action: (name, [number]) => {
    if (name !== 'click') return;
    if (stale) throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`);
    if (number === 1) { shifted = true; stale = true; return; }
    const first = shifted ? 4 : 3;
    selected = names[number - first];
  } });
  // Use a module cell, matching the engine grammar that literalElements parses.
  await f.run('await app.click(1); await app.click(4); globalThis.pickResult = await app.pickFromList("Delta");', { bind: true });
  const result = f.context.pickResult;
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [1, 4, 5, 7]);
  assert.equal(selected, 'Delta');
  assert.ok(!f.calls.some(c => c[0] === 'pressKey'), 'no key while only a selection names the list');
});

test('AB3 review: a flagged window binds again after three clean actions that read first', async () => {
  let stale = false, refuse = true;
  const rows = '\t1 button First\n\t2 button Second\n\t3 button Third';
  const f = fixture({ strict: true, current: () => { stale = false; return tree(expected, rows); },
    action: (name, [number]) => {
      if (stale && refuse) { refuse = false; throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`); }
      stale = true;
    } });
  // The refused click goes once more (its line is in the same place), and the window is still flagged.
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  f.calls.length = 0;
  // The first action reads anyway; the next three read because the window is flagged, and the fifth binds.
  await f.run('await app.click(1); await app.click(2); await app.click(3); await app.click(2); await app.click(3);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read', 'click', 'read', 'click', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
});

test('AB3 review: a failed read after the refusal leaves no fresh tree and says so in the receipt', async () => {
  let stale = false;
  const f = fixture({ strict: true, current: () => { if (stale) throw new Error('read failed'); return tree(expected, '\t1 button First\n\t2 button Second'); },
    action: (name, [number]) => {
      if (stale) throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`);
      stale = true;
    } });
  await assert.rejects(f.run('await app.click(1); await app.click(2);', { bind: true, guardStopMark: '[stop]' }), /2 is an invalid element ID/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  assert.equal(f.output.filter(line => typeof line === 'string' && line.startsWith(GUARD_MARK)).length, 0);
  const receipt = JSON.parse(f.output.find(line => line.startsWith('[stop]{"index"')).slice(6));
  assert.equal(receipt.refused, true); assert.equal(receipt.fresh, false);
});

test('AB3 review: the read after a refusal gives up after its bound', async () => {
  let stale = false;
  const f = fixture({ strict: true, current: () => stale ? new Promise(() => {}) : tree(expected, '\t1 button First\n\t2 button Second'),
    action: (name, [number]) => {
      if (stale) throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`);
      stale = true;
    } });
  // Fire the bound at once instead of after 5 s.
  f.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 5000 ? 0 : ms);
  await assert.rejects(f.run('await app.click(1); await app.click(2);', { bind: true, guardStopMark: '[stop]' }), /2 is an invalid element ID/);
  assert.equal(JSON.parse(f.output.find(line => line.startsWith('[stop]{"index"')).slice(6)).fresh, false);
});

test('AB3: a refusal on a fresh read leaves binding on', async () => {
  let refuse = true;
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button First\n\t2 button Second'),
    action: (name, [number]) => { if (refuse) { refuse = false; throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`); } } });
  await assert.rejects(f.run('await app.click(1);', { bind: true }), /1 is an invalid element ID/);
  f.calls.length = 0;
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
});

// FM2 (Firefox travel, 2026-10-18): a date picker rebuilt its buttons after the first pick, and the batched second click
// failed with a native error instead of the engine's "invalid element ID".
test('FM2: AXError.invalidUIElement on a bound click gets the same fresh tree, keeps the error, resends nothing', async () => {
  let stale = false, gone = false;
  // The rebuilt window no longer has the clicked line, so nothing is resent.
  const rows = '\t1 button First\n\t2 button Second';
  const f = fixture({ strict: true, current: () => { stale = false; return tree(expected, gone ? '\t1 button First\n\t2 button Second, Value: 1' : rows); },
    action: () => {
      if (stale) { gone = true; throw new Error('Accessibility error: AXError.invalidUIElement'); }
      stale = true;
    } });
  await assert.rejects(f.run('await app.click(1); await app.click({ label: "Second" }); await app.click(1);', { bind: true, guardStopMark: '[stop]' }),
    /Accessibility error: AXError\.invalidUIElement/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  assert.equal(f.output.filter(line => typeof line === 'string' && line.startsWith(GUARD_MARK)).length, 1);
  assert.ok(f.output.includes(GUARD_MARK + tree(expected, '\t1 button First\n\t2 button Second, Value: 1') + GUARD_END));
  const receipt = JSON.parse(f.output.find(line => line.startsWith('[stop]{"index"')).slice(6));
  assert.equal(receipt.refused, true); assert.equal(receipt.bound, true); assert.equal(receipt.fresh, true);
  assert.match(receipt.error, /AXError\.invalidUIElement/);
  gone = false;
  // The binding is cleared: the next call reads before each action instead of trusting a capture.
  f.calls.length = 0;
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read']);
});

for (const [name, message] of [['elementHasNoFrame', 'Computer Use server error -10005: elementHasNoFrame'],
  ['an unrelated accessibility error', 'Accessibility error: AXError.cannotComplete'], ['a timeout', 'timed out']])
  test('FM2: ' + name + ' gets no recovery read and no refusal receipt', async () => {
    let stale = false;
    const f = fixture({ strict: true, current: () => { stale = false; return tree(expected, '\t1 button First\n\t2 button Second'); },
      action: () => { if (stale) throw new Error(message); stale = true; } });
    await assert.rejects(f.run('await app.click(1); await app.click(2);', { bind: true, guardStopMark: '[stop]' }), error => error.message === message);
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click']);
    assert.equal(f.output.filter(line => typeof line === 'string' && line.startsWith(GUARD_MARK)).length, 0);
    assert.equal(JSON.parse(f.output.find(line => line.startsWith('[stop]{"index"')).slice(6)).refused, undefined);
  });

test('bind checks a computed number against the code read after another action', async () => {
  let acted = false;
  const f = fixture({ strict: true, current: () => tree(expected, acted ? '\t1 button First\n\t2 button Other' : '\t1 button First\n\t2 button Second'),
    action: () => { acted = true; } });
  await assert.rejects(f.run('const s = await app.getAXState(); const n = Number(/(\\d+) button Second/.exec(s)[1]); await app.click(1); await app.click(n);',
    { bind: true, literals: [1] }), /element 2 changed since this call read the window/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
});

test('bind compares literal numbers against explicit reads the call actually took', async () => {
  let acted = false;
  const f = fixture({ strict: true, current: () => tree(expected, acted ? '\t1 button First\n\t2 button Other' : '\t1 button First\n\t2 button Second'),
    action: () => { acted = true; } });
  await assert.rejects(f.run('await app.click(1); await app.getAXState(); await app.click(2);', { bind: true }), /changed what element 2 is/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
});

test('the default combines capture binding and quiet edits and resets on the next call', async () => {
  const f = fixture({ ordinary: true, strict: true, current: () => tree(expected, '\t1 text field Editor\n\t2 button Next\n\nThe focused UI element is 1 text field Editor') });
  await f.run('await app.pressKey("super+a"); await app.typeText("x"); await app.click(1); await app.typeText("y"); await app.click(2);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'pressKey', 'typeText', 'click', 'read', 'typeText', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.click(2);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
});

test('bind preserves the first-action remap when the same literal is repeated', async () => {
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button Other\n\t2 button Target, ID: target') });
  await f.run('await app.click(1); await app.click(1);', { bind: true, literals: [1],
    seenLines: { 1: 'button Target, ID: target' }, uniqueSeen: [1] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [2, 2]);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
});

test('bind follows repeated literals through successive observed remaps', async () => {
  let clicks = 0;
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button Other\n' +
    (clicks ? '\t2 button Different\n\t3 button Target, ID: target' : '\t2 button Target, ID: target')),
    action: () => { clicks++; } });
  await f.run('await app.click(1); await app.getAXState(); await app.click(1); await app.click(1);',
    { bind: true, literals: [1], seenLines: { 1: 'button Target, ID: target' }, uniqueSeen: [1] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [2, 3, 3]);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
});

const editKeys = ['super+a', 'cmd+c', 'command+x', 'meta+z', 'super+shift+z', 'cmd+b', 'cmd+i', 'cmd+u',
  ...['Left', 'Right', 'Up', 'Down', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].flatMap(key =>
    [key, 'super+' + key, 'alt+shift+' + key, 'ctrl+' + key])];
for (const key of editKeys) test('quiet-edits skips the next read after ' + key, async () => {
  for (const [options, reads] of [[{}, key.includes('+') ? 3 : 2], [{ quietEdits: true }, 2],
    [{ quietEdits: true, careful: true }, 4]]) {
    const f = fixture({ strict: true });
    await f.run(`await app.typeText("a"); await app.pressKey(${JSON.stringify(key)}); await app.typeText("x");`, options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
  }
});

for (const role of ['text field', 'text area', 'text entry area', 'search field', 'search text field', 'combo box'])
  for (const target of ['1', '{ id: "editor" }', '{ label: "Editor" }'])
    test('quiet-edits recognizes ' + role + ' clicked by ' + target, async () => {
      for (const next of ['typeText("x")', 'paste("x")']) for (const [options, reads] of
        [[{}, 3], [{ quietEdits: true }, 3], [{ quietEdits: true, careful: true }, 3]]) {
        const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + role + ' Description: Editor, ID: editor\n\nThe focused UI element is 1 ' + role + ' Description: Editor, ID: editor') });
        await f.run(`await app.click(${target}); await app.${next};`, options);
        assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
        assert.deepEqual(f.calls.find(c => c[0] === 'click'), ['click', 1]);
      }
    });

for (const action of ['click(1)', 'click([5,5])', ...['super+o', 'super+s', 'super+n', 'super+p', 'super+shift+g',
  'Return', 'Escape', 'Tab', 'Space', 'super+shift+a', 'ctrl+a', 'super+alt+z'].map(key => `pressKey("${key}")`)])
  test('quiet-edits retains the settle read after ' + action, async () => {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 button Description: text field, ID: editor') });
    await f.run(`await app.${action}; await app.typeText("x");`, { quietEdits: true });
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
  });

test('quiet-edits field clicks keep non-text action lookups fresh', async () => {
  for (const next of ['pressKey("super+a")', 'click([5,5])', 'click(1)', 'click({id:"editor"})', 'click({label:"Editor"})']) {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 text field Description: Editor, ID: editor') });
    await f.run(`await app.click(1); await app.${next};`, { quietEdits: true });
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
  }
});

test('the default skips reads between edit shortcuts and typing, and careful reads every time', async () => {
  for (const [options, reads] of [[undefined, 2], [{ careful: true }, 3], [{ careful: true, fileOnly: true }, 3]]) {
    const f = fixture({ ordinary: true, strict: true });
    await f.run('await app.pressKey("super+a"); await app.typeText("x");', options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads);
  }
});

test('a window change mid-batch stops the next numbered action, and careful mode stops keys too', async () => {
  for (const [code, options, stopped] of [['await app.typeText("a"); await app.typeText("x");', {}, false],
    ['await app.typeText("a"); await app.typeText("x");', { careful: true }, true], ['await app.click(1); await app.typeText("x");', {}, true],
    ['await app.click(1); await app.click(1);', {}, true]]) {
    let changed = false;
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'b.txt' } : expected), action: () => { changed = true; } });
    const done = f.run(code, options);
    if (stopped) await assert.rejects(done, /changed window/); else await done;
  }
});

test('a prior read with no inventory is used as it is, and a degraded read still finds an element by ID', async () => {
  const f = fixture({ current: () => tree(expected, '\t1 button One\n\t2 button Two') });
  f.context.cua.listApps = async () => { f.calls.push(['listApps']); return []; };
  await f.run('await app.click({ id: "Two" });', { prior: { text: tree(expected, '\t1 button One\n\t2 button Two'), windows: null } });
  assert.deepEqual(f.calls.map(c => c[0]), ['click', 'read'], 'no inventory and no read before the click');
  assert.deepEqual(f.calls.find(c => c[0] === 'click'), ['click', 2], 'the bare line named Two');
  const ambiguous = fixture({ current: () => tree(expected, '\t1 button Two\n\t2 button Two') });
  await assert.rejects(ambiguous.run('await app.click({ id: "Two" });'), /2 elements|no element/);
  const attributed = fixture({ current: () => tree(expected, '\t1 button Description: 2, ID: Deux') });
  await assert.rejects(attributed.run('await app.click({ id: "Two" });'), /no element/);
});

test('the first action goes where the line Claude saw moved, and stops when that line is gone or ambiguous', async () => {
  // TextEdit gave a saved document a URL and 14 became File (textedit-save, 2026-10-09).
  const f = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Format') });
  await f.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14], uniqueSeen: [14] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 15]]);
  assert.ok(f.output.some(o => /click\(14\) went to element 15, the same "menu bar item Format": the window renumbered since you read it/.test(o)));
  const gone = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Edit') });
  await assert.rejects(gone.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14] }),
    /click\(14\): element 14 changed since you read the window \(was "menu bar item Format", now "menu bar item File"\)[\s\S]*15 menu bar item Edit/);
  const twice = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Format\n\t16 menu bar item Format') });
  await assert.rejects(twice.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14] }), /changed since you read the window/);
  // A bare role says nothing about which element it was.
  const bare = fixture({ current: () => tree(expected, '\t14 group\n\t15 container (selected)') });
  await assert.rejects(bare.run('await app.click(14);', { seenLines: { 14: 'container (selected)' }, literals: [14], uniqueSeen: [14] }), /changed since you read the window/);
  // Claude saw two such rows: the one left may be the other row's.
  const dup = fixture({ current: () => tree(expected, '\t14 text Inbox\n\t15 button Delete') });
  await assert.rejects(dup.run('await app.click(14);', { seenLines: { 14: 'button Delete' }, literals: [14], uniqueSeen: [] }), /changed since you read the window/);
  // CC5: both observed lines shifted and remain unique, so the whole batch can follow them.
  const two = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Format\n\t20 button Go') });
  await two.run('await app.click(14); await app.click(19);', { seenLines: { 14: 'menu bar item Format', 19: 'button Go' }, literals: [14, 19], uniqueSeen: [14, 19],
    seenParents: { 14: 'standard window, URL: file:///tmp/a.txt', 19: 'standard window, URL: file:///tmp/a.txt' } });
  assert.deepEqual(two.calls.filter(c => c[0] === 'click'), [['click', 15], ['click', 20]]);
  assert.deepEqual([gone, twice, bare, dup].flatMap(x => x.calls.filter(c => c[0] === 'click')), []);
  const same = fixture({ current: () => tree(expected, '\t14 menu bar item Format') });
  await same.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14] });
  assert.deepEqual(same.calls.filter(c => c[0] === 'click'), [['click', 14]]);
});

// FT1b: Safari added a "contact info AutoFill" button under the filled name field, so the email field went from 22 to 23
// and Add adult from 31 to 32 while the call ran; the guard stopped there in 3 of 3 form-travel runs (race-1017), and
// recovery took two more calls. The rows replay r3's call 4. A line with no ID, description or help is followed only when
// it is on exactly one element in each tree, at the same depth, under the same parent, after the same row.
const form = ({ autofill = false, values = {}, rows = r => r } = {}) => {
  const v = (n, line) => values[n] ? `${line}, Value: ${values[n]}` : line;
  const lines = ['\t\t\t\t\t\t8 container', '\t\t\t\t\t\t\t17 text Reference code', v(18, '\t\t\t\t\t\t\t18 text field (settable) Reference code'),
    '\t\t\t\t\t\t\t19 text Full name', v(20, '\t\t\t\t\t\t\t20 text field (settable) Full name'),
    ...(autofill ? ['\t\t\t\t\t\t\t\t21 button contact info AutoFill'] : []),
    '\t\t\t\t\t\t\t21 text Email', '\t\t\t\t\t\t\t22 email field (settable) Email', '\t\t\t\t\t\t\t23 text Dates',
    '\t\t\t\t\t\t\t26 text Adults', '\t\t\t\t\t\t\t27 container Adults', '\t\t\t\t\t\t\t\t28 button Remove adult',
    '\t\t\t\t\t\t\t\t29 container 1', '\t\t\t\t\t\t\t\t\t30 text 1', '\t\t\t\t\t\t\t\t31 button Add adult', '\t\t\t\t\t\t\t38 button Next'];
  // After the inserted button every later element is one higher, as in the trace.
  let shift = 0;
  return tree(expected, rows(lines.map(line => {
    if (/AutoFill/.test(line)) { shift = 1; return line; }
    return line.replace(/^(\t*)(\d+) /, (_, tabs, n) => `${tabs}${Number(n) + shift} `);
  })).join('\n'));
};
function formFixture(after) {
  const values = {};
  let filled = false;
  const f = fixture({ current: () => filled ? after(values) : form({ values }),
    action: (name, args) => { if (name === 'setValue') { values[args[0]] = args[1]; if (args[0] === 20) filled = true; } } });
  return f;
}
const formCall = 'await app.setValue(18, "p01"); await app.setValue(20, "Mira Okonkwo-Hale"); await app.setValue(22, "mira.hale@example.net"); await app.click(31);';

test('FT1b: an element with no ID that an inserted button renumbered mid-call is followed when only it matches', async () => {
  const f = formFixture(values => form({ autofill: true, values }));
  await f.run(formCall);
  assert.deepEqual(f.calls.filter(c => ['setValue', 'click'].includes(c[0])).map(c => [c[0], c[1]]),
    [['setValue', 18], ['setValue', 20], ['setValue', 23], ['click', 32]]);
  assert.ok(f.output.some(o => /setValue\(22\) went to element 23, the same "email field \(settable\) Email": an earlier action in this call renumbered the window/.test(o)), f.output.join('\n'));
  assert.ok(f.output.some(o => /click\(31\) went to element 32, the same "button Add adult"/.test(o)));
});

test('FT1b: ambiguous, changed, moved or bare elements still stop before the action', async () => {
  const stops = {
    // A second email field: two elements carry the line.
    ambiguous: values => form({ autofill: true, values, rows: r => [...r, '\t\t\t\t\t\t\t40 email field (settable) Email'] }),
    // The field's own line changed (another field now sits there).
    changed: values => form({ autofill: true, values, rows: r => r.map(l => l.replace('email field (settable) Email', 'email field (settable) Work email')) }),
    // The same line under another parent: a different place in the window.
    moved: values => form({ autofill: true, values, rows: r => r.map(l => l.replace('\t23 email field (settable) Email', '\t23 group\n\t\t24 email field (settable) Email')) }),
    // The row before it is another element now, though the line itself is the same.
    neighbour: values => form({ autofill: true, values, rows: r => r.map(l => l.replace('22 text Email', '22 text Work email')) }),
  };
  for (const [name, after] of Object.entries(stops)) {
    const f = formFixture(after);
    await assert.rejects(f.run(formCall), /setValue\(22\): an earlier action in this call changed what element 22 is \(was "email field \(settable\) Email"/, name);
    assert.deepEqual(f.calls.filter(c => ['setValue', 'click'].includes(c[0])).map(c => c[1]), [18, 20], name);
  }
  // Two such lines in the tree the call started from: the one left may be the other's.
  let filled = false;
  const g = fixture({ current: () => filled ? form({ autofill: true })
    : form({ rows: r => [...r, '\t\t\t\t\t\t\t39 button Add adult'] }), action: (name, args) => { if (args[0] === 20) filled = true; } });
  await assert.rejects(g.run('await app.setValue(20, "x"); await app.click(31);'), /click\(31\): an earlier action in this call changed what element 31 is/);
  assert.deepEqual(g.calls.filter(c => c[0] === 'click'), []);
  // A bare role says nothing about which element it was.
  let grown = false;
  const h = fixture({ current: () => tree(expected, grown ? '\t1 button New\n\t2 button Save, ID: Save\n\t3 container' : '\t1 button Save, ID: Save\n\t2 container'),
    action: () => { grown = true; } });
  await assert.rejects(h.run('await app.click(1); await app.click(2);'), /changed what element 2 is/);
  assert.deepEqual(h.calls.filter(c => c[0] === 'click'), [['click', 1]]);
});

// FT1b review F1: a sort that swaps two product cards keeps the unique "button Add to cart" at the same depth, under a
// "group", after an "image", but on the other product. Only one inserted or removed block of rows explains a shift.
test('FT1b review: a reordered list stops; one inserted or removed block of rows is followed', async () => {
  const card = (n, image, last) => [`\t${n} group`, `\t\t${n + 1} image`, `\t\t${n + 2} ${last}`];
  let sorted = false;
  const f = fixture({ current: () => tree(expected, (sorted ? [...card(1, 0, 'text Sold out'), ...card(4, 0, 'button Add to cart')]
    : [...card(1, 0, 'button Add to cart'), ...card(4, 0, 'text Sold out')]).join('\n') + '\n\t7 button Sort, ID: sort'),
    action: (name, args) => { if (args[0] === 7) sorted = true; } });
  await assert.rejects(f.run('await app.click(7); await app.click(3);'), /click\(3\): an earlier action in this call changed what element 3 is/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 7]]);
  assert.deepEqual(samePlace(tree(expected, [...card(1, 0, 'button Add to cart'), ...card(4, 0, 'text Sold out')].join('\n')), 3,
    tree(expected, [...card(1, 0, 'text Sold out'), ...card(4, 0, 'button Add to cart')].join('\n'))), []);
  // A removed block: the rows after it come back one lower, and the target with them.
  let gone = false;
  const g = fixture({ current: () => tree(expected, gone ? '\t1 button Close, ID: close\n\t2 text Total\n\t3 button Pay'
    : '\t1 button Close, ID: close\n\t2 text Coupon applied\n\t3 text Total\n\t4 button Pay'), action: () => { gone = true; } });
  await g.run('await app.click(1); await app.click(4);');
  assert.deepEqual(g.calls.filter(c => c[0] === 'click'), [['click', 1], ['click', 3]]);
  // Two separate insertions are not one block, wherever the second one is.
  for (const [number, at] of [[22, '\t\t\t\t\t\t\t39 button Next'], [31, '\t\t\t\t\t\t\t27 text Adults']]) {
    const two = form({ autofill: true }).replace(at, '\t\t\t\t\t\t\t90 text New\n' + at);
    assert.ok(two.includes('90 text New'));
    assert.deepEqual(samePlace(form(), number, two), [], String(number));
  }
});

test('FT1b: samePlace names one element only when line, depth, parent and the row before all agree', () => {
  const before = form(), after = form({ autofill: true, values: { 20: 'x' } });
  assert.deepEqual(samePlace(before, 22, after), [[23, 'email field (settable) Email']]);
  assert.deepEqual(samePlace(before, 31, after), [[32, 'button Add adult']]);
  assert.deepEqual(samePlace(before, 99, after), [], 'a number the first tree lacks');
  assert.deepEqual(samePlace(before, 8, after), [], 'a bare role');
  assert.deepEqual(samePlace(undefined, 22, after), [], 'no first tree');
  assert.deepEqual(samePlace(before, 22, after.replace('\t23 email field', '\t\t23 email field')), [], 'another depth');
  assert.deepEqual(samePlace(before, 22, after.replace('22 text Email', '22 text Phone')), [], 'another row before it');
});

test('a number the code read itself in this call is checked against that read, not the tree before the call', async () => {
  // ZCode, 2026-10-12: a click closed a dialog, the code read again and matched the button's new
  // number, and sleight stopped that correct click against the older tree.
  let closed = false;
  const before = '\t5 container Resettable quota\n\t21 button Close';
  const after = '\t4 container\n\t5 button Back to workspace';
  const f = fixture({ current: () => tree(expected, closed ? after : before), action: (name, args) => { if (args[0] === 21) closed = true; } });
  await f.run(`await app.click(21);
    const s = await app.getAXState({ emit: false });
    const m = s.match(/(\\d+) button Back to workspace/);
    await app.click(Number(m[1]));`, { seenLines: { 21: 'button Close' }, literals: [21] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 21], ['click', 5]]);
  // The same computed number with no read in the call keeps the older tree as its reference.
  closed = false;
  const g = fixture({ current: () => tree(expected, closed ? after : before), action: (name, args) => { if (args[0] === 21) closed = true; } });
  await assert.rejects(g.run('await app.click(21); const n = 5; await app.click(n);', { seenLines: { 21: 'button Close' }, literals: [21] }),
    /an earlier action in this call changed what element 5 is/);
  // A computed number whose element moved after the code read goes to that line when it's unique,
  // and stops when it isn't; a combined read counts as the code's read too.
  let moved = false;
  const k = fixture({ current: () => tree(expected, moved ? '\t5 button Back to workspace\n\t6 text entry area (settable) Placeholder: Ask' : '\t5 text entry area (settable) Placeholder: Ask'),
    action: (name) => { if (name === 'pressKey') moved = true; } });
  await k.run(`const r = await app.getAXStateAndScreenshot({ emit: false }); const n = Number(/(\\d+) text entry area/.exec(r.state)[1]);
    await app.pressKey('escape'); await app.click(n);`, { literals: [] });
  assert.deepEqual(k.calls.filter(c => c[0] === 'click'), [['click', 6]]);
  assert.ok(k.output.some(o => /click\(5\) went to element 6.*renumbered after this call read it/.test(o)));
  moved = false;
  const l = fixture({ current: () => tree(expected, moved ? '\t5 button Back to workspace' : '\t5 text entry area (settable) Placeholder: Ask'),
    action: (name) => { if (name === 'pressKey') moved = true; } });
  await assert.rejects(l.run(`const s = await app.getAXState({ emit: false }); const n = Number(/(\\d+) text entry/.exec(s)[1]);
    await app.pressKey('escape'); await app.click(n);`, { literals: [] }), /element 5 changed since this call read the window/);
  // A literal number after a read in the call still means what Claude saw.
  let shifted = false;
  const h = fixture({ current: () => tree(expected, shifted ? '\t7 button Send\n\t8 button Stop' : '\t7 button Stop'), action: () => { shifted = true; } });
  // Since FT1b it follows Stop to 8 (one inserted row), never Send, which the call's own read showed at 7.
  await h.run('await app.click(7); await app.getAXState({ emit: false }); await app.click(7);', { seenLines: { 7: 'button Stop' }, literals: [7] });
  assert.deepEqual(h.calls.filter(c => c[0] === 'click'), [['click', 7], ['click', 8]]);
  shifted = false;
  const reordered = fixture({ current: () => tree(expected, shifted ? '\t7 button Send\n\t8 button Stop' : '\t7 button Stop\n\t8 button Send'), action: () => { shifted = true; } });
  await assert.rejects(reordered.run('await app.click(7); await app.getAXState({ emit: false }); await app.click(7);', { seenLines: { 7: 'button Stop' }, literals: [7] }),
    /an earlier action in this call changed what element 7 is/);
});

test('new calls expire a combined snapshot; screenshots replace it with a fresh combined capture', async () => {
  const f = fixture();
  await f.run('await app.getAXStateAndScreenshot();');
  f.calls.length = 0;
  await f.run('await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.getScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.getAXStateAndScreenshot(); await app.getScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'both', 'click', 'read']);
});

test('input through another handle invalidates a combined observation of the same window', async () => {
  let changed = false;
  const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected),
    action: () => { changed = true; } });
  f.context.cua.getApp = async () => ({ ...f.raw });
  await assert.rejects(f.run('await app.getAXStateAndScreenshot(); const other = await cua.getApp("TextEdit"); await other.pressKey("a"); await app.click(1);'), /changed window/);
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
});

test('a failed or incomplete combined observation cannot preserve an older cached tree', async () => {
  for (const state of [undefined, '', '+ 2 button Changed']) {
    const f = fixture({ screenshotState: () => state });
    await f.run('await app.getAXState(); await app.getAXStateAndScreenshot(); await app.click(1);');
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'both', 'read', 'click', 'read']);
  }
  const f = fixture();
  f.raw.getAXStateAndScreenshot = async () => { throw new Error('unavailable'); };
  await f.run('await app.getAXState(); try { await app.getAXStateAndScreenshot(); } catch {} await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'read', 'click', 'read']);
});

test('a cached combined observation cannot outlive input lease ownership or expiry', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-guard-lease-'));
  t.after(() => removeTemp(bank));
  const path = join(bank, 'lease.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const record of [{ token: 'successor', expires: Date.now() + 30000 }, { token: 'owner', expires: 0 }]) {
    writeFileSync(path, JSON.stringify({ token: 'owner', expires: Date.now() + 30000 }));
    let actions = 0;
    const app = {
      getAXState: async () => tree(),
      getAXStateAndScreenshot: async () => {
        writeFileSync(path, JSON.stringify(record));
        return { state: tree() };
      },
      click: async () => { actions++; },
    };
    const code = guardedCode('await app.getAXStateAndScreenshot({ emit: false }); await app.click(1);',
      expected, 'changed window', { path, token: 'owner' });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(app, { getApp: async () => app }, { write() {} }), /ownership lost or expired/);
      assert.equal(actions, 0);
    } finally { delete globalThis.__sleightDocumentGuard; }
  }
});

for (const method of ['getAXState', 'getAXStateAndScreenshot']) {
  test(`${method} begun before input cannot refill the cache after that input`, async () => {
    let changed = false, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected),
      action: () => { changed = true; finish(); } });
    if (method === 'getAXStateAndScreenshot') {
      f.raw[method] = async () => { const state = tree(); await pending; return { state }; };
    } else {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return state; }
        return tree(changed ? { ...expected, title: 'other.txt' } : expected);
      };
    }
    await assert.rejects(f.run(`const pending = app.${method}({ emit: false });
      await app.pressKey("a"); await pending; await app.click(1);`), /changed window/);
    assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
  });

  test(`${method} begun before a screenshot cannot refill its invalidated cache`, async () => {
    let changed = false, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected) });
    if (method === 'getAXStateAndScreenshot') {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return { state }; }
        changed = true; finish();
        return { state: tree({ ...expected, title: 'other.txt' }), screenshot: new Uint8Array([1]) };
      };
    } else {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return state; }
        return tree(changed ? { ...expected, title: 'other.txt' } : expected);
      };
      f.raw.getAXStateAndScreenshot = async () => {
        changed = true; finish();
        return { state: tree({ ...expected, title: 'other.txt' }), screenshot: new Uint8Array([1]) };
      };
    }
    await assert.rejects(f.run(`const pending = app.${method}({ emit: false });
      await app.getScreenshot(); await pending; await app.click(1);`), /changed window/);
    assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
  });
}

// textedit-save, 2026-10-10: Return after setValue({ id }) read the 54,000-character Save sheet.
test('Return after setValue goes ahead on its header by default, and careful mode reads first', async () => {
  for (const [options, reads] of [[undefined, 2], [{ careful: true }, 3]]) {
    const f = fixture();
    await f.run('await app.setValue(1, "b.txt"); await app.pressKey("Return");', options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
  }
});

test('a call that took no action after a split acquisition takes that read as its header', async () => {
  const f = fixture();
  f.context.cua.listApps = async () => [];
  await f.run('globalThis.app = await cua.getApp("TextEdit");');
  const prior = split => ({ text: tree(), id: 'com.apple.TextEdit', title: 'a.txt', windows: [], split });
  for (const [code, options, reads] of [['app;', { prior: prior(true) }, 0], ['app;', { prior: prior(false) }, 1], ['app;', {}, 1],
    // Any action reads after as before.
    ['await app.click(1);', { prior: prior(true) }, 2]]) {
    f.calls.length = 0; f.output.length = 0;
    await f.run(code, options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, `${code} ${JSON.stringify(options.prior?.split)}`);
    assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END, 'the lease still gets a full header');
  }
  // Another app acquired in the call is read for its own header, never given the split's.
  const notes = 'Window: "n", App: Notes.\n0 standard window n';
  f.output.length = 0;
  await f.run(`globalThis.__sleightDocumentGuard.getApp = async () => ({ async getAXState() { return ${JSON.stringify(notes)}; } });
    globalThis.other = await cua.getApp("Notes");`, { prior: prior(true) });
  assert.equal(f.output.at(-1), GUARD_MARK + notes + GUARD_END);
});

test('a window the call\'s own shortcut or Return opened or named is accepted, in the default mode only', async () => {
  const open = 'Window: "Open", App: TextEdit.\n0 standard window Open, ID: open-panel, Secondary Actions: Raise\n\t1 button Cancel';
  const untitled = 'Window: "Untitled 3", App: TextEdit.\n0 standard window Untitled 3\n\t1 button Save, ID: Save';
  const saved = tree({ title: 'b.txt', app: 'TextEdit', url: 'file:///tmp/x/b.txt' });
  const other = tree({ title: 'c.txt', app: 'TextEdit', url: 'file:///tmp/c.txt' });
  // [code, the action after which the window changes, the window then, options, stopped]
  for (const [code, trigger, after, options, stopped] of [
    ['await app.pressKey("super+o"); await app.pressKey("super+shift+g");', 'super+o', open, { adoptUrl: true }, false],
    ['await app.pressKey("super+n"); await app.pressKey("super+shift+t");', 'super+n', untitled, { adoptUrl: true }, false],
    ['await app.typeText("/tmp/x/b.txt"); await app.pressKey("Return"); await app.click({ id: "Save" });', 'Return', saved, { adoptUrl: true }, false],
    // Not this call's name, not after an opening action, or a strict mode: still a stop.
    ['await app.pressKey("super+o"); await app.pressKey("super+shift+g");', 'super+o', other, { adoptUrl: true }, true],
    ['await app.typeText("abc"); await app.click({ id: "Save" });', 'abc', untitled, { adoptUrl: true }, true],
    ['await app.pressKey("super+n"); await app.pressKey("super+shift+t");', 'super+n', untitled, {}, true]]) {
    let changed = false;
    const f = fixture({ current: () => changed ? after : tree(), action: (name, args) => { if (args[0] === trigger) changed = true; } });
    const done = f.run(code, options);
    if (stopped) await assert.rejects(done, /changed window/, code); else await done;
  }
});

for (const role of ['sheet', 'dialog']) {
  test(`a click continues into its own app's titled ${role}`, async () => {
    let changed = false;
    const modal = `Window: "Confirm removal", App: TextEdit.\n0 ${role}\n\t9 button Delete Group`;
    const f = fixture({ current: () => changed ? modal : tree(expected, '\t19 button Remove Group'),
      action: name => { if (name === 'click') changed = true; } });
    await f.run('await app.click(19); await app.click({ label: "Delete Group" });', { adoptUrl: true });
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19, 9]);
  });
}

test('a click cannot continue into another app or a different document window', async () => {
  for (const after of [
    'Window: "Confirm removal", App: Other.\n0 sheet\n\t9 button Delete Group',
    'Window: "Other document", App: TextEdit.\n0 standard window\n\t9 button Delete Group',
    'Window: "Confirm removal", App: TextEdit.\n0 dialog, URL: file:///tmp/other.txt\n\t9 button Delete Group',
  ]) {
    let changed = false;
    const f = fixture({ current: () => changed ? after : tree(expected, '\t19 button Remove Group'),
      action: name => { if (name === 'click') changed = true; } });
    await assert.rejects(f.run('await app.click(19); await app.click({ label: "Delete Group" });', { adoptUrl: true }),
      /App: Other\./.test(after) ? /app changed\. 1 earlier action in this call ran/ : /changed window/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});

test('waitFor follows a titled sheet opened by the preceding click', async () => {
  let changed = false;
  const modal = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
  const f = fixture({ current: () => changed ? modal : tree(expected, '\t19 button Remove Group'),
    action: name => { if (name === 'click') changed = true; } });
  await f.run('await app.click(19); await app.waitFor({ label: "Delete Group" }); await app.click({ label: "Delete Group" });', { adoptUrl: true });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19, 9]);
});

test('a non-click action cannot adopt a sheet, including an untitled sheet', async () => {
  for (const title of ['Confirm removal', '']) {
    let changed = false;
    const modal = `Window: ${JSON.stringify(title)}, App: TextEdit.\n0 sheet\n\t9 button Delete Group`;
    const f = fixture({ current: () => changed ? modal : tree(), action: () => { changed = true; } });
    await assert.rejects(f.run('await app.typeText("x"); await app.click({ label: "Delete Group" });', { adoptUrl: true }), /changed window/);
    assert.equal(f.calls.some(c => c[0] === 'click'), false);
  }
});

test('a sheet already present before the click cannot be adopted as its result', async () => {
  for (const role of ['sheet', 'dialog']) {
    let changed = false;
    const before = tree(expected, `\t19 button Remove Group\n\t20 ${role} Existing confirmation`);
    const after = `Window: "Confirm removal", App: TextEdit.\n0 ${role}\n\t9 button Delete Group`;
    const f = fixture({ current: () => changed ? after : before, action: () => { changed = true; } });
    await assert.rejects(f.run('await app.click(19); await app.click({ label: "Delete Group" });', { adoptUrl: true }), /changed window/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});

test('a numeric click into a sheet that was already present stops before input', async () => {
  let changed = false;
  const before = tree(expected, '\t19 button Remove Group\n\t20 sheet Existing confirmation\n\t9 button Delete Group');
  const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
  const f = fixture({ current: () => changed ? after : before, action: () => { changed = true; } });
  await assert.rejects(f.run('await app.click(19); await app.click(9);', { adoptUrl: true }), /changed window/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
});

test('an explicit first read after a click cannot authorize a later sheet', async () => {
  for (const read of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot']) {
    let reads = 0;
    const before = tree(expected, '\t19 button Remove Group');
    const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
    const f = fixture({ current: () => ++reads <= 2 ? before : after });
    await assert.rejects(f.run(`await app.click(19); await app.${read}(); await app.getAXState(); await app.click({ label: "Delete Group" });`, { adoptUrl: true }), /changed window/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});

test('repeated explicit reads preserve a sheet seen on the first read after the click', async () => {
  for (const read of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot']) {
    let changed = false;
    const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
    const f = fixture({ current: () => changed ? after : tree(expected, '\t19 button Remove Group'), action: () => { changed = true; } });
    await f.run(`await app.click(19); await app.${read}(); await app.getAXState(); await app.click({ label: "Delete Group" });`, { adoptUrl: true });
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19, 9]);
  }
});

test('waitFor cannot adopt a sheet without a preceding click', async () => {
  for (const title of ['Confirm removal', '']) {
    const after = `Window: ${JSON.stringify(title)}, App: TextEdit.\n0 sheet\n\t9 button Delete Group`;
    const f = fixture({ current: () => after });
    await assert.rejects(f.run('await app.waitFor({ label: "Delete Group" }, { timeoutMs: 0 });', { adoptUrl: true }), /waitFor stopped/);
  }
});

test('waitFor adopts only a sheet on its first read after the click', async () => {
  let reads = 0;
  const before = tree(expected, '\t19 button Remove Group');
  const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
  const f = fixture({ current: () => ++reads <= 2 ? before : after });
  f.context.setTimeout = resolve => resolve();
  await assert.rejects(f.run('await app.click(19); await app.waitFor({ label: "Delete Group" }, { timeoutMs: 1000 });', { adoptUrl: true }), /waitFor stopped/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
});

test('a typed document name cannot authorize a sheet that appeared after the first read', async () => {
  for (const wait of [false, true]) {
    let reads = 0;
    const before = tree(expected, '\t19 button Remove Group');
    const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
    const f = fixture({ current: () => ++reads <= 3 ? before : after });
    f.context.setTimeout = resolve => resolve();
    const tail = wait ? 'await app.waitFor({ label: "Delete Group" }, { timeoutMs: 1000 });'
      : 'await app.getAXState(); await app.getAXState(); await app.click({ label: "Delete Group" });';
    await assert.rejects(f.run(`await app.typeText("Confirm removal"); await app.click(19); ${tail}`, { adoptUrl: true }), /changed window|waitFor stopped/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});
