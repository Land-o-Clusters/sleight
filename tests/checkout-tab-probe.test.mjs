import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, openSync, closeSync, mkdtempSync, existsSync, writeFileSync, readFileSync, utimesSync, lstatSync } from 'node:fs';
import * as engineFS from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createTabProbe, tabProbeRefusal, nativeTabPlan } from '../plugins/sleight/lib/tab-probe.mjs';
import { splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';

const chrome = (tabs = [{ ref: 10, selected: true }]) => ({ complete: true, group: 8,
  childCount: tabs.length, children: tabs.map(t => t.ref), tabCount: tabs.length, tabs, addressField: 20, focused: 20 });

const expected = { appId: 'org.test.browser', app: 'Fixture Browser', title: 'New Tab', url: null, windowNumber: 22 };
const identity = { ...expected, status: 'ok', matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1,
  headerMatches: 1, windowSubrole: 'AXStandardWindow', chrome: chrome(), hidIdleSeconds: 1000, focus: { sheets: 0, role: 'AXComboBox', subrole: null, inWindow: true, inPage: false } };
const target = { ...expected, nativeIdentity: identity };
const tree = 'Window: "New Tab", App: Fixture Browser.\n0 standard window New Tab\n\t1 combo box (settable) Address\n\t2 HTML content New Tab\n\nThe focused UI element is 1 combo box (settable) Address';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('CK3 admits only a literal awaited new-tab URL and Return chain', () => {
  const code = 'await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");';
  assert.equal(nativeTabPlan(splitMenuActions(code)), true);
  for (const other of [code.replace('super+t', 'super+l'), code.replace('typeText', 'paste'),
    code.replace('https://example.test', 'Confirm purchase'), code.replace('https://example.test', 'https://example.test\\n'),
    code.replace('await app.typeText', 'app.typeText'), code.replace('Return', 'Tab'),
    code.replace('await app.typeText', 'await app.getAXState(); await app.typeText')]) {
    assert.equal(nativeTabPlan(splitMenuActions(other)), false, other);
  }
});

const requestPaths = info => Array.from({ length: 8 }, (_, i) => info.request + '-' + i);
const requestSample = (info, index = 0) => openSync(requestPaths(info)[index], constants.O_RDONLY | constants.O_NONBLOCK);

test('CK3 measures FIFO creation on the relay event loop', t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-create-time-'))));
  const probe = createTabProbe({ directory, observe: async () => identity });
  t.after(() => probe.dispose());
  const elapsed = [];
  for (let id = 0; id < 25; id++) {
    const start = performance.now();
    probe.begin(id, target);
    elapsed.push(performance.now() - start);
    probe.end(id);
  }
  elapsed.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ beginMs: { min: elapsed[0], median: elapsed[12], p95: elapsed[23], max: elapsed[24] } }));
});

test('CK3 a plain observation timeout leaves the failure step and errno empty', async t => {
  const f = await fixture(t, { sandboxFS: { constants, promises: { ...engineFS.promises,
    readFile: async () => { throw Object.assign(Error('not published yet'), { code: 'ENOENT', syscall: 'open' }); } } } });
  await f.run();
  const { tabProbe: decision } = JSON.parse(f.output[0].slice(4));
  assert.equal(decision.reason, 'probe-timeout');
  assert.equal(decision.failureStep, null);
  assert.equal(decision.errno, null);
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
});

for (const replacement of ['file', 'symlink']) {
  test(`CK3 the guard refuses a request replaced by a ${replacement}`, async t => {
    const f = await fixture(t, { setupProbe: info => {
      const path = requestPaths(info)[0];
      engineFS.unlinkSync(path);
      const file = path + '.file';
      if (replacement === 'symlink') { writeFileSync(file, ''); engineFS.symlinkSync(file, path); }
      else writeFileSync(path, '');
    } });
    await f.run();
    const { tabProbe: decision } = JSON.parse(f.output[0].slice(4));
    assert.equal(decision.reason, 'probe-failed');
    assert.equal(decision.failureStep, replacement === 'file' ? 'request-stat' : 'request-open');
    assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
  });

  test(`CK3 the relay refuses a request replaced by a ${replacement}`, async t => {
    const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-swap-'))));
    const traces = [];
    let walks = 0;
    const probe = createTabProbe({ directory, intervalMs: 2, observe: async () => { walks++; return identity; },
      trace: (direction, record) => { if (direction === 'tab-probe-channel') traces.push({ direction, ...record }); } });
    t.after(() => probe.dispose());
    const info = probe.begin(1, target), path = requestPaths(info)[0];
    engineFS.unlinkSync(path);
    if (replacement === 'symlink') { writeFileSync(path + '.file', ''); engineFS.symlinkSync(path + '.file', path); }
    else writeFileSync(path, '');
    for (let i = 0; i < 100 && !traces.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(walks, 0);
    assert.equal(traces[0]?.failureStep, 'request-accept');
    assert.equal(traces[0]?.errno, replacement === 'file' ? 'EINVAL' : 'ELOOP');
  });
}

async function fixture(t, { observe = async () => identity, current = () => tree, onType = () => {}, onOutput = () => {}, guardDate = Date,
  sandboxFS = engineFS, setupProbe = () => {}, probeFreshMs = 30, probeDeadlineMs = 650 } = {}) {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-'))));
  const probe = createTabProbe({ directory, observe, intervalMs: 2, timeoutMs: 20, deadlineMs: probeDeadlineMs, freshMs: probeFreshMs });
  const info = probe.begin(1, target);
  setupProbe(info);
  t.after(() => probe.dispose());
  const calls = [], output = [];
  const raw = { getAXState: async () => { calls.push('read'); return current(); },
    typeText: async () => { calls.push('typeText'); onType(); }, pressKey: async () => calls.push('pressKey') };
  return { info, calls, output, run: async (options = {}) => {
    const { lease, ...checks } = options;
    try {
      const code = guardedCode('await app.typeText("https://example.test"); await app.pressKey("Return");',
        expected, 'window changed', lease, { careful: true, tabProbe: info, guardStopMark: '[ck]', ...checks });
      await new AsyncFunction('app', 'cua', 'nodeRepl', 'Date', 'sandboxFS', code.replace("await import('node:fs')", 'sandboxFS'))(raw,
        { getApp: async () => raw }, { write: value => { output.push(value); onOutput(value); } }, guardDate, sandboxFS);
    } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; probe.end(1); }
  } };
}

test('CK3 remainder probes address focus before typing and Return and keeps its final tree', async t => {
  const f = await fixture(t);
  await f.run({ payment: { setting: 'always', message: null } });
  assert.deepEqual(f.calls, ['typeText', 'pressKey', 'read']);
  assert.equal(existsSync(f.info.path), false);
  assert.equal(f.output.filter(line => /"tabProbe"/.test(line)).length, 2);
});

test('CK3 requests reach the relay when the engine sandbox refuses every file write', async t => {
  let writes = 0, opens = 0, delayed = false;
  const promises = { ...engineFS.promises,
    writeFile: async () => { writes++; throw Object.assign(Error('sandbox denied write'), { code: 'EPERM', syscall: 'open' }); },
    open: async (path, flags) => {
      opens++;
      assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      assert.equal(lstatSync(path).isFIFO(), true);
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      const handle = await engineFS.promises.open(path, flags);
      if (opens === 3) {
        delayed = true;
        // The relay can publish while an engine filesystem promise waits to resume.
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      return handle;
    } };
  await assert.rejects(promises.writeFile('/sandbox/request', '{}'), { code: 'EPERM', syscall: 'open' });
  // This checks read-only transport. Freshness expiry has separate tests with the strict fixture defaults.
  const f = await fixture(t, { sandboxFS: { constants, promises }, probeFreshMs: 1000, probeDeadlineMs: 5000 });
  await f.run();
  assert.equal(delayed, true, 'the first Return observation reached the delayed reader');
  assert.equal(writes, 1, 'only the simulated old request write was refused');
  assert.equal(opens, 4, 'two samples for each guarded input');
  assert.deepEqual(f.calls, ['typeText', 'pressKey', 'read']);
  const decisions = f.output.filter(line => line.includes('"tabProbe"')).map(line => JSON.parse(line.slice(4)).tabProbe);
  assert.equal(decisions.length, 2);
  for (const decision of decisions) {
    assert.equal(decision.decision, 'probe');
    assert.equal(decision.channel, 'read-fifo');
    assert.equal(decision.failureStep, null);
    assert.equal(decision.errno, null);
    assert.equal(decision.syscall, null);
    assert.ok(Number.isFinite(decision.sampleMs));
  }
});

test('CK3 a sandboxed FIFO open refusal traces the step and errno and keeps every read', async t => {
  const f = await fixture(t, { sandboxFS: { constants, promises: { ...engineFS.promises,
    open: async () => { throw Object.assign(Error('sandbox denied open'), { code: 'EPERM', syscall: 'open' }); } } } });
  await f.run();
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
  const { tabProbe: decision } = JSON.parse(f.output[0].slice(4));
  assert.equal(decision.decision, 'read');
  assert.equal(decision.reason, 'probe-failed');
  assert.equal(decision.failureStep, 'request-open');
  assert.equal(decision.errno, 'EPERM');
  assert.equal(decision.syscall, 'open');
});

test('CK3 a native probe refusal traces its errno and retains full reads', async t => {
  const f = await fixture(t, { observe: async () => { throw Object.assign(Error('helper pipe failed'), { code: 'EPIPE', syscall: 'write' }); } });
  await f.run();
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
  const { tabProbe: decision } = JSON.parse(f.output[0].slice(4));
  assert.equal(decision.reason, 'probe-failed');
  assert.equal(decision.failureStep, 'native-observe');
  assert.equal(decision.errno, 'EPIPE');
  assert.equal(decision.syscall, 'write');
});

test('CK3 an unreadable observation traces its errno and closes its request reader', async t => {
  let closes = 0;
  const f = await fixture(t, { sandboxFS: { constants, promises: { ...engineFS.promises,
    open: async (...args) => {
      const handle = await engineFS.promises.open(...args);
      return { stat: () => handle.stat(), close: async () => { closes++; await handle.close(); } };
    },
    readFile: async () => { throw Object.assign(Error('sandbox denied read'), { code: 'EACCES', syscall: 'open' }); } } } });
  await f.run();
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
  assert.equal(closes, 1);
  const { tabProbe: decision } = JSON.parse(f.output[0].slice(4));
  assert.equal(decision.reason, 'probe-timeout');
  assert.equal(decision.failureStep, 'observation-read');
  assert.equal(decision.errno, 'EACCES');
});

test('CK3 request creation failure is traced by the guard before its ordinary reads', async t => {
  const f = await fixture(t, { setupProbe: info => {
    info.failure = { failureStep: 'request-create', errno: 'EACCES', syscall: 'mkfifo' };
  } });
  await f.run();
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
  const { tabProbe: decision } = JSON.parse(f.output[0].slice(4));
  assert.equal(decision.failureStep, 'request-create');
  assert.equal(decision.errno, 'EACCES');
  assert.equal(decision.syscall, 'mkfifo');
});

test('CK3 a failed relay FIFO utility returns a fallback with its process status', t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-create-'))));
  const probe = createTabProbe({ directory: join(directory, 'absent'), observe: async () => assert.fail('no native work') });
  t.after(() => probe.dispose());
  const info = probe.begin(1, target);
  assert.equal(info.channel, 'read-fifo');
  assert.equal(info.failure.failureStep, 'request-create');
  assert.equal(info.failure.exitCode, 1);
  assert.equal(info.failure.errno, null, 'mkfifo exits without exposing an errno code');
});

for (const [reason, observed] of [
  ['page focus', { ...identity, focus: { ...identity.focus, inPage: true } }],
  ['outside window', { ...identity, focus: { ...identity.focus, inWindow: false } }],
  ['sheet', { ...identity, focus: { ...identity.focus, sheets: 1 } }],
  ['password', { ...identity, focus: { ...identity.focus, subrole: 'AXSecureTextField' } }],
  ['button', { ...identity, focus: { ...identity.focus, role: 'AXButton' } }],
  ['missing focus', { ...identity, focus: undefined }],
  ['pid', { ...identity, pid: 456 }],
  ['process start', { ...identity, processStart: 2 }],
  ['epoch', { ...identity, epoch: 'other' }],
  ['window ref', { ...identity, window: 2 }],
  ['window number', { ...identity, windowNumber: 23 }],
  ['title', { ...identity, title: 'Other' }],
  ['url', { ...identity, url: 'https://other.test' }],
  ['ambiguous', { ...identity, matches: 2 }],
  ['user input', { ...identity, hidIdleSeconds: 0 }],
  ['unknown', { status: 'unknown' }],
]) test(`CK3 reads the tree on ${reason}`, async t => {
  assert.ok(tabProbeRefusal(target, observed, Date.now() - 100, Date.now()));
  const f = await fixture(t, { observe: async () => observed });
  await f.run();
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
});

for (const [reason, observe] of [['failed probe', async () => { throw Error('failed'); }], ['timeout', () => new Promise(() => {})]]) {
  test(`CK3 reads on ${reason}`, async t => {
    const f = await fixture(t, { observe });
    await f.run();
    assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
  });
}

test('CK3 off restores the old continuation reads', async t => {
  const f = await fixture(t);
  await f.run({ tabProbe: undefined });
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
});

// Feed two valid samples 50 ms apart, then expire the accepted certificate by one
// millisecond. Scheduling cannot age a sample before this test reaches dispatch.
async function expiringFixture(t, options = {}) {
  let now, request = 0, info;
  const sandboxFS = { ...engineFS, promises: { ...engineFS.promises,
    open: async () => ({ stat: async () => ({ isFIFO: () => true }), close: async () => { if (request === 1) now += 50; } }),
    readFile: async (path, ...args) => path === info.path
      ? JSON.stringify({ request: ++request, start: now, end: now, observed: identity })
      : engineFS.promises.readFile(path, ...args),
  } };
  const f = await fixture(t, { ...options, sandboxFS, guardDate: { now: () => now },
    setupProbe: value => { info = value; now = value.since; },
    onOutput: value => { if (value.includes('"decision":"probe"')) now += info.freshMs + 1; } });
  return f;
}

test('CK3 a certificate that ages before dispatch reads and stops before input', async t => {
  const f = await expiringFixture(t);
  await assert.rejects(f.run(), /native tab certificate expired/);
  assert.equal(f.output.filter(value => value.includes('"decision":"probe"')).length, 1);
  assert.deepEqual(f.calls, ['read']);
});

test('CK3 an expired certificate cannot type into a newly tracking menu', async t => {
  const f = await expiringFixture(t, {
    current: () => tree + '\n3 menu bar\n\t4 menu bar item File, Selected: true' });
  await assert.rejects(f.run(), /native tab certificate expired/);
  assert.equal(f.output.filter(value => value.includes('"decision":"probe"')).length, 1);
  assert.deepEqual(f.calls, ['read']);
});

test('CK3 loss of the lease during certification stops before sending input', async t => {
  let path;
  const f = await fixture(t, { onOutput: value => {
    if (value.includes('"decision":"probe"')) writeFileSync(path, JSON.stringify({ token: 'other', expires: Date.now() + 10000 }));
  } });
  path = f.info.path + '.lease';
  writeFileSync(path, JSON.stringify({ token: 'owned', expires: Date.now() + 10000 }));
  await assert.rejects(f.run({ lease: { path, token: 'owned' } }), /ownership lost or expired/);
  assert.deepEqual(f.calls, []);
});

test('CK3 rechecks focus after typing and a payment-page fallback still stops Return', async t => {
  let inPage = false;
  const checkout = 'Window: "New Tab", App: Fixture Browser.\n0 standard window New Tab\n' +
    '\t1 HTML content Checkout, URL: https://shop.test/checkout\n\t\t2 text field (settable) Card number\n' +
    '\t\t3 button Pay now $268.00\nThe focused UI element is 2 text field (settable) Card number';
  const f = await fixture(t, { observe: async () => inPage ? { ...identity, focus: { ...identity.focus, inPage: true } } : identity,
    onType: () => { inPage = true; }, current: () => inPage ? checkout : tree });
  await assert.rejects(f.run({ payment: { setting: 'always', message: null } }), /sleight stopped this payment/);
  assert.deepEqual(f.calls, ['typeText', 'read']);
});

test('CK3 ending a call prevents a late helper reply from recreating its observation file', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-late-'))));
  let finish;
  const probe = createTabProbe({ directory, observe: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => probe.dispose());
  const info = probe.begin(1, target);
  const fd = requestSample(info); t.after(() => closeSync(fd));
  for (let i = 0; i < 100 && !finish; i++) await new Promise(r => setTimeout(r, 5));
  probe.end(1);
  finish(identity);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(existsSync(info.path), false);
  assert.equal(existsSync(info.path + '.tmp'), false);
});

const initial = { ...identity, title: 'Before', chrome: chrome() };
const added = { ...identity, chrome: chrome([{ ref: 10, selected: false }, { ref: 11, selected: true }]) };

test('CK3 original Cmd+T sequence uses a new-tab certificate and only the final engine read', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-chain-'))));
  let current = initial, ownInputAt = Date.now() - 1000;
  const probe = createTabProbe({ directory, observe: async () => ({ ...current, hidIdleSeconds: (Date.now() - ownInputAt) / 1000 }), intervalMs: 2, deadlineMs: 1000 });
  t.after(() => probe.dispose());
  const info = probe.begin(7, { ...expected, title: 'Before', nativeIdentity: initial }, Date.now(), 'new-tab');
  const calls = [], output = [];
  const raw = { getAXState: async () => { calls.push('read'); return tree; },
    pressKey: async key => { calls.push(key); if (key === 'super+t') current = added; ownInputAt = Date.now(); await new Promise(r => setTimeout(r, 10)); },
    typeText: async () => { calls.push('typeText'); ownInputAt = Date.now(); await new Promise(r => setTimeout(r, 10)); } };
  try {
    await new AsyncFunction('app', 'cua', 'nodeRepl', guardedCode('await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");',
      { ...expected, title: 'Before' }, 'window changed', undefined,
      { tabProbe: info, firstOff: true, focused: true, adoptUrl: true, guardStopMark: '[ck]', payment: { setting: 'always', message: null } }))(
      raw, { getApp: async () => raw }, { write: line => output.push(line) });
    assert.deepEqual(calls, ['super+t', 'typeText', 'Return', 'read']);
    assert.equal(output.filter(line => /"decision":"probe"/.test(line)).length, 2);
    assert.equal(globalThis.__sleightDocumentGuard.binding, undefined, 'metadata never seeds bindings');
    assert.equal(globalThis.__sleightDocumentGuard.callTrees.has(globalThis.__sleightDocumentGuard.activeApp), false);
  } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
});

for (const [reason, update] of [
  ['no native strip', { chrome: undefined }],
  ['same count tab switch', { chrome: chrome([{ ref: 10, selected: true }]) }],
  ['two new tabs', { chrome: chrome([{ ref: 10, selected: false }, { ref: 11, selected: true }, { ref: 12, selected: false }]) }],
  ['old tab replaced', { chrome: chrome([{ ref: 12, selected: false }, { ref: 11, selected: true }]) }],
  ['old tab remains selected', { chrome: chrome([{ ref: 10, selected: true }, { ref: 11, selected: false }]) }],
  ['group replacement', { chrome: { ...added.chrome, group: 9 } }],
  ['address field replacement', { chrome: { ...added.chrome, addressField: 21, focused: 21 } }],
  ['focus on another chrome control', { chrome: { ...added.chrome, focused: 21 } }],
  ['incomplete traversal', { chrome: { ...added.chrome, complete: false } }],
  ['child count mismatch', { chrome: { ...added.chrome, childCount: 3 } }],
  ['ambiguous header', { headerMatches: 2 }],
  ['nonstandard window', { windowSubrole: 'AXDialog' }],
  ['missing title', { title: undefined }],
  ['missing URL identity', { url: undefined }],
  ['invalid process id', { pid: 0 }],
]) test(`CK3 native transition refuses ${reason}`, () => {
  assert.ok(tabProbeRefusal({ ...expected, title: 'Before', nativeIdentity: initial }, { ...added, ...update }, 1000, 1001, true));
});

test('CK3 native transition accepts one retained-strip addition selected in the address field', () => {
  assert.equal(tabProbeRefusal({ ...expected, title: 'Before', nativeIdentity: initial }, added, 1000, 1001, true), undefined);
  assert.ok(tabProbeRefusal({ ...expected, nativeIdentity: added }, { ...added, chrome: chrome() }, 1000, 1001));
});

for (const [reason, next] of [
  ['missing strip', { ...added, chrome: undefined }],
  ['tab switch', { ...added, chrome: chrome() }],
  ['replacement tab', { ...added, chrome: chrome([{ ref: 12, selected: false }, { ref: 11, selected: true }]) }],
  ['page focus', { ...added, focus: { ...added.focus, inPage: true } }],
  ['late sheet', { ...added, focus: { ...added.focus, sheets: 1 } }],
  ['unproved traversal', { ...added, chrome: { complete: false } }],
  ['user input', { ...added, hidIdleSeconds: 0 }],
  ['helper restart', { ...added, epoch: 'new' }],
]) test(`CK3 original chain takes the full read before typing on ${reason}`, async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-fallback-'))));
  let current = initial;
  const probe = createTabProbe({ directory, observe: async () => current, intervalMs: 2 });
  t.after(() => probe.dispose());
  const info = probe.begin(1, { ...expected, title: 'Before', nativeIdentity: initial }, Date.now(), 'new-tab');
  const calls = [];
  const raw = { getAXState: async () => { calls.push('read'); return tree; },
    pressKey: async key => { calls.push(key); current = next; }, typeText: async () => calls.push('typeText') };
  try {
    await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', guardedCode(
      'await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");',
      { ...expected, title: 'Before' }, 'window changed', undefined,
      { tabProbe: info, firstOff: true, focused: true, adoptUrl: true }))(raw, { getApp: async () => raw }, { write() {} }), /window changed/);
    assert.deepEqual(calls, ['super+t', 'read']);
  } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
});

test('CK3 performs no native work until the guard requests samples', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-demand-'))));
  let count = 0;
  const probe = createTabProbe({ directory, observe: async () => { count++; return identity; }, intervalMs: 2 });
  t.after(() => probe.dispose());
  const info = probe.begin(1, target);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(count, 0);
  const first = requestSample(info); t.after(() => closeSync(first));
  for (let i = 0; i < 100 && !existsSync(info.path); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(JSON.parse(readFileSync(info.path)).request, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(count, 1);
  const second = requestSample(info, 1); t.after(() => closeSync(second));
  for (let i = 0; i < 100 && count < 2; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(count, 2);
  probe.end(1);
  for (const path of requestPaths(info)) assert.equal(existsSync(path), false);
});

test('CK3 each read-only request is used once and no more than eight walks run', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-bound-'))));
  let count = 0;
  const probe = createTabProbe({ directory, observe: async () => { count++; return identity; }, intervalMs: 2 });
  t.after(() => probe.dispose());
  const info = probe.begin(1, target);
  const fds = requestPaths(info).map(path => openSync(path, constants.O_RDONLY | constants.O_NONBLOCK));
  t.after(() => fds.forEach(fd => closeSync(fd)));
  for (let i = 0; i < 100 && count < 8; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(count, 8);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(count, 8);
});

test('CK3 relay publication failures include the step and errno in the channel trace', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-publish-'))));
  const traces = [];
  let info;
  const probe = createTabProbe({ directory, intervalMs: 2,
    observe: async () => { engineFS.mkdirSync(info.path + '.tmp'); return identity; },
    trace: (direction, record) => { if (direction === 'tab-probe-channel') traces.push({ direction, ...record }); } });
  t.after(() => probe.dispose());
  info = probe.begin(1, target);
  const fd = requestSample(info); t.after(() => closeSync(fd));
  for (let i = 0; i < 100 && !traces.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(traces[0]?.direction, 'tab-probe-channel');
  assert.equal(traces[0].failureStep, 'observation-publish');
  assert.equal(traces[0].errno, 'EISDIR');
  assert.equal(traces[0].syscall, 'open');
  assert.equal(existsSync(info.path), false);
});

test('CK3 startup removes only stale observation and request files', t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-stale-'))));
  for (const name of ['tab-old.obs', 'tab-old.obs.tmp', 'tab-old.req', 'tab-old.req.tmp', 'lease.json', 'other.obs']) {
    const path = join(directory, name); writeFileSync(path, '{}'); utimesSync(path, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  }
  writeFileSync(join(directory, 'tab-active.obs'), '{}');
  const source = createTabProbe({ directory, observe: async () => identity });
  t.after(() => source.dispose());
  const info = source.begin(1, target);
  for (const path of requestPaths(info)) utimesSync(path, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  const probe = createTabProbe({ directory, observe: async () => identity });
  t.after(() => probe.dispose());
  for (const name of ['tab-old.obs', 'tab-old.obs.tmp', 'tab-old.req', 'tab-old.req.tmp']) assert.equal(existsSync(join(directory, name)), false);
  for (const name of ['lease.json', 'other.obs', 'tab-active.obs']) assert.equal(existsSync(join(directory, name)), true);
  for (const path of requestPaths(info)) assert.equal(existsSync(path), false);
});

test('CK3 timing variation does not change the chrome stability signature', async t => {
  let walkMs = 0;
  const f = await fixture(t, { observe: async () => ({ ...identity, chrome: { ...identity.chrome, walkMs: ++walkMs } }) });
  await f.run();
  assert.deepEqual(f.calls, ['typeText', 'pressKey', 'read']);
});
test('CK3 a timed-out request never queues another native walk or publishes a late reply', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-timeout-'))));
  let count = 0, finish;
  const probe = createTabProbe({ directory, timeoutMs: 10, intervalMs: 2, observe: () => { count++; return new Promise(r => { finish = r; }); } });
  t.after(() => probe.dispose());
  const info = probe.begin(1, target);
  const first = requestSample(info); t.after(() => closeSync(first));
  for (let i = 0; i < 100 && !existsSync(info.path); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(JSON.parse(readFileSync(info.path)).observed, undefined);
  const second = requestSample(info, 1); t.after(() => closeSync(second));
  finish(identity);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(count, 1);
  assert.equal(JSON.parse(readFileSync(info.path)).observed, undefined);
});

test('CK3 skips the baseline probe when the ordinary first read covers Cmd+T', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ck3-first-read-'))));
  let current = initial, samples = 0;
  const calls = [];
  const probe = createTabProbe({ directory, intervalMs: 2, observe: async () => { samples++; return current; } });
  t.after(() => probe.dispose());
  const info = probe.begin(1, { ...expected, title: 'Before', nativeIdentity: initial }, Date.now(), 'new-tab');
  const raw = { getAXState: async () => { calls.push('read'); return current === initial ? tree.replaceAll('New Tab', 'Before') : tree; },
    pressKey: async key => { if (key === 'super+t') assert.equal(samples, 0); calls.push(key); current = added; },
    typeText: async () => calls.push('typeText') };
  try {
    await new AsyncFunction('app', 'cua', 'nodeRepl', guardedCode(
      'await app.pressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");',
      { ...expected, title: 'Before' }, 'window changed', undefined, { tabProbe: info }))(
      raw, { getApp: async () => raw }, { write() {} });
    assert.deepEqual(calls, ['read', 'super+t', 'typeText', 'Return', 'read']);
    assert.equal(samples, 4);
  } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
});

for (const side of ['baseline', 'observed']) {
  test(`CK2d traces the ${side} native chrome check and preserves the full-read fallback`, async t => {
    const incomplete = { complete: false, reason: 'unproved-address-field', check: 'address-field', walkMs: 38,
      details: { groups: 1, strips: 1, tabs: 2, selected: 1, fieldCount: 1,
        fields: [{ role: 'AXComboBox', identifierSource: 'AXDOMIdentifier', toolbar: true, editable: true, enabled: true, secure: false, address: false }] } };
    const f = await fixture(t, {
      observe: async () => side === 'observed' ? { ...identity, chrome: incomplete } : identity,
      setupProbe: info => { if (side === 'baseline') info.target = { ...target, nativeIdentity: { ...identity, chrome: incomplete } }; },
    });
    await f.run();
    assert.deepEqual(f.calls, ['read', 'typeText', 'read', 'pressKey', 'read']);
    const decision = f.output.filter(line => line.includes('"tabProbe"')).map(line => JSON.parse(line.slice(4)).tabProbe)[0];
    assert.equal(decision.reason, 'incomplete-chrome');
    assert.equal(decision.chrome[side].nativeReason, 'unproved-address-field');
    assert.equal(decision.chrome[side].check, 'address-field');
    assert.equal(decision.chrome[side].walkMs, 38);
    assert.deepEqual(decision.chrome[side].details, incomplete.details);
    assert.equal(decision.chrome[side === 'baseline' ? 'observed' : 'baseline'].refusal, null);
  });
}

test('CK2d a malformed complete certificate identifies the failed selection check', async t => {
  const f = await fixture(t, { observe: async () => ({ ...identity, chrome: { ...chrome(), tabs: [{ ref: 10, selected: false }] } }) });
  await f.run();
  const decision = f.output.filter(line => line.includes('"tabProbe"')).map(line => JSON.parse(line.slice(4)).tabProbe)[0];
  assert.equal(decision.decision, 'read');
  assert.equal(decision.chrome.observed.refusal, 'tab-selection');
});
