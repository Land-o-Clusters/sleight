import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork, execFileSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { validateActionParams } from '../plugins/sleight/lib/windows-driver/actions.mjs';
import { createWindowsReplClient } from '../plugins/sleight/lib/windows-repl/client.mjs';

const collectorURL = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
const baseline = process.env.UC3ST13_BASELINE === '1';
let collector;
if (baseline) {
  const source = execFileSync('/usr/bin/git', ['show', '3077b36c3:bench/windows/uc3f-collect.mjs'],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' })
    .replace(/from '(\.\.?\/[^']+)'/g, (_match, path) => `from '${new URL(path, collectorURL).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(collectorURL.href));
  collector = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
} else collector = await import(collectorURL.href);

const birth = '134382652462791842';
const target = { windowId: '101', processStart: birth, bindingId: 'b'.repeat(32), pid: 42,
  image: 'C:\\fixture\\receiver.exe', imageIdentity: '134382652462791840:6656',
  className: 'Fixture', title: 'fixture', integrity: 'medium', target: 'wpf', refused: null };
const counts = { postedMessages: 0, patternCalls: 0, uiaFetches: 0, captures: 0, finalReads: 0 };
const fault = code => Object.assign(Error(code), { code });

// The transport enforces native request contracts. The real product client and
// collector run on this side of it; no desktop or native executable is opened.
function transport(t, { refused, cancelOrder = 'cancel-first', holdTyping = false, stateCounters = counts } = {}) {
  const frames = [], pending = new Map(); let readId = 0;
  const window = { ...target, ...refused ? { refused, bindingId: null } : {} };
  const dispatch = frame => {
    const p = frame.params;
    if (frame.method === 'getState') return { windows: [window], counters: stateCounters };
    if (frame.method === 'getApp') {
      assert.deepEqual(Object.keys(p), ['selector']);
      if (refused) throw fault(refused);
      return { window, readId: ++readId, text: '0 standard window fixture\n1 text area Editor\n2 button Invoke, ID: InvokeButton' };
    }
    if (['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(frame.method)) {
      if (Object.keys(p).sort().join(' ') !== 'bindingId processStart windowId' || p.bindingId !== window.bindingId || !p.bindingId)
        throw fault('INVALID_PARAMS');
      if (refused) throw fault(refused);
      return { window, readId: ++readId, text: `0 standard window fixture\n1 text area Editor, Value: ${readId}\n2 button Invoke, ID: InvokeButton` };
    }
    if (['turn-start', 'turn-end'].includes(frame.method)) return { turn: p.turn, active: frame.method === 'turn-start' };
    if (frame.method === 'cancel') return { cancelled: p.id, inFlight: true };
    validateActionParams(frame.method === 'stuckMenuEscape' ? 'pressKey' : frame.method, p);
    if (p.readId !== readId || !Array.isArray(p.clipboardBlocked)) throw fault('STALE_READ');
    return { window, readId: ++readId, text: `0 standard window fixture\n1 text area Editor, Value: ${readId}`, counters: counts };
  };
  const directSpawn = (_command, _args, options) => {
    const child = new EventEmitter(); child.pid = 701;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const reply = (frame, error, result) => child.stdout.write(JSON.stringify({ protocol: frame.protocol,
      nonce: frame.nonce, id: frame.id, ...error ? { ok: false, error: { code: error.code ?? 'INVALID_PARAMS', message: 'refused', unhealthy: false } } : { ok: true, result } }) + '\n');
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const frame = JSON.parse(bytes); frames.push(frame); done();
      queueMicrotask(() => {
        try {
          const result = dispatch(frame);
          if (holdTyping && frame.method === 'typeText' && frame.params.args[0].length === 3000) { pending.set(frame.id, frame); return; }
          if (frame.method === 'cancel' && pending.has(frame.params.id)) {
            const job = pending.get(frame.params.id); pending.delete(frame.params.id);
            const end = () => reply(job, Object.assign(fault('USER_STOPPED'), { typed: 64 }), undefined);
            if (cancelOrder === 'job-first') end();
            reply(frame, undefined, result);
            if (cancelOrder === 'cancel-first') end();
          } else reply(frame, undefined, result);
        } catch (error) { reply(frame, error); }
      });
    } });
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    return child;
  };
  const client = collector.instrumentedClient({ directSpawn, prepare: async ({ run }) => ({ status: 'ready',
    spawn: options => run('fixture-driver', ['--driver'], { ...options, env: {} }) }) });
  t.after(() => client.close());
  return { client, frames, dispatch, window };
}

for (const order of ['cancel-first', 'job-first']) test(`real cancel trial uses the Windows typing contract, ${order}`, async t => {
  const h = transport(t, { cancelOrder: order, holdTyping: true });
  await h.client.request('getState', {});
  const read = await h.client.request('getAXState', { windowId: target.windowId, processStart: birth });
  let clock = 0;
  const result = await collector.runCancelTrial({ client: h.client, target, readId: read.readId, order,
    tick: () => clock++, now: () => clock, sleep: async () => { clock++; await new Promise(done => setImmediate(done)); }, check: async () => {} });
  assert.equal(result.unmeasured, undefined);
  assert.equal(result.driver[0].raw.code, 'USER_STOPPED');
  assert.equal(result.driver[0].method, 'typeText');
  assert.equal(result.driver[0].requestedUnits, 3000);
  assert.equal(result.driver[1].method, 'cancel');
  assert.equal(result.parent.jobReplyId, result.parent.jobId);
  assert.equal(result.parent.cancelReplyId, result.parent.cancelId);
  assert.equal(result.orderEvidence.observed, order);
});

test('cancel mismatch retains the observed wire order instead of promise or requested order', async t => {
  const h = transport(t, { cancelOrder: 'cancel-first', holdTyping: true });
  await h.client.request('getState', {});
  const read = await h.client.request('getAXState', { windowId: target.windowId, processStart: birth });
  let clock = 0;
  const result = await collector.runCancelTrial({ client: h.client, target, readId: read.readId, order: 'job-first',
    tick: () => clock++, now: () => clock, sleep: async () => { clock++; await new Promise(done => setImmediate(done)); }, check: async () => {} });
  assert.equal(result.unmeasured, 'REPLY_ORDER_NOT_OBSERVED');
  assert.equal(result.orderEvidence.requested, 'job-first');
  assert.equal(result.orderEvidence.observed, 'cancel-first');
  assert.deepEqual(result.orderEvidence.frames.filter(f => f.kind === 'reply').map(f => f.id), [result.parent.cancelId, result.parent.jobId]);
});

test('published file retries stop on lease revocation and never retry identity or parse failures', async () => {
  let reads = 0, checks = 0;
  await assert.rejects(collector.readPublishedFile('fixture', { check: async () => { if (++checks === 2) throw fault('LEASE_EXPIRED'); },
    sleep: async () => {}, read: () => { reads++; throw fault('EBUSY'); } }), { code: 'LEASE_EXPIRED' });
  assert.equal(reads, 1);
  for (const code of ['RAW_FILE_INVALID', 'EACCES']) {
    let tries = 0;
    await assert.rejects(collector.readPublishedFile('fixture', { check: async () => {}, sleep: async () => assert.fail('retry'),
      read: () => { tries++; throw fault(code); } }), { code });
    assert.equal(tries, 1);
  }
});

test('Terminal control census is bounded, identity checked and reads no terminal content', () => {
  const body = collector.GUEST_OPERATIONS.slice(collector.GUEST_OPERATIONS.indexOf("  'terminal-control-tree' {"),
    collector.GUEST_OPERATIONS.indexOf("  'terminal-settings-open' {"));
  const audit = source => {
    for (const predicate of ['$controls.Count -ge 256', '$clock.ElapsedMilliseconds -gt 1500', '$info.ProcessId -ne $p.Id', '[void](Bound $r.fixture)'])
      assert.ok(source.includes(predicate), predicate);
    assert.doesNotMatch(source, /ValuePattern|TextPattern|GetText|SetFocus|\.Invoke\(|SendInput|SendKeys/);
    assert.ok(source.includes('$record.name = $info.Name'));
  };
  audit(body);
  for (const predicate of ['$controls.Count -ge 256', '$clock.ElapsedMilliseconds -gt 1500', '$info.ProcessId -ne $p.Id', '[void](Bound $r.fixture)'])
    assert.throws(() => audit(body.replaceAll(predicate, 'false')), assert.AssertionError);
  assert.throws(() => audit(body + '\n$element.GetText()'), assert.AssertionError);
});

test('Calculator refusal probes resolve on their own native driver before bound reads', async t => {
  const h = transport(t, { refused: 'HOSTED_APP_UNRESOLVED' });
  const receipt = { ...target, coreWindowId: target.windowId };
  const admissions = [];
  assert.equal(await collector.requireCalculatorRefusals(receipt, (method, params, admissionFor) => {
    admissions.push(admissionFor); return h.client.request(method, params);
  }), 11);
  assert.deepEqual(admissions, [...Array(5).fill(undefined), 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot']);
  assert.equal(h.frames.some(f => ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(f.method)), false);
});

test('a fresh direct driver resolves its own HWND before a read instead of borrowing a binding', async t => {
  const h = transport(t, { refused: 'FORBIDDEN_TARGET' });
  let raw;
  const result = await collector.runDirectTrial({ target, override: false, bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef',
    tick: () => 1, now: () => 1, psCall: async () => {}, prepare: async () => ({ status: 'ready' }),
    executableOf: () => 'C:\\fixture\\driver.exe', writeOwned: (_name, script) => {
      const encoded = /\$frame = '([^']+)' \| ConvertFrom-Json/.exec(script)[1];
      const frame = JSON.parse(encoded);
      try { raw = { ok: true, ...h.dispatch(frame) }; } catch (error) { raw = { ok: false, code: error.code }; }
      return 'fixture.ps1';
    }, read: () => JSON.stringify({ id: 1, replyId: 1, pid: 701, raw }), exists: () => true,
    check: async () => {}, sleep: async () => {}, nextInvocation: () => '1', ownerAway: true,
    rowId: 'direct-launch-terminal', lease: { row: 'direct-launch-terminal' }, transportInvocation: '3' });
  assert.equal(result.driver[0].raw.code, 'FORBIDDEN_TARGET');
});

for (const stateCounters of [counts, { ...counts, uiaFetches: 3 }])
test(`real Terminal setup proves refusal through the real worker, observed UIA=${stateCounters.uiaFetches}`, { skip: windowsWorkerSkip }, async t => {
  const h = transport(t, { refused: 'FORBIDDEN_TARGET', stateCounters });
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st12-terminal-'))); t.after(() => removeTemp(root));
  const bank = join(root, 'uc3f-0123456789abcdef'); mkdirSync(bank);
  // The filesystem path is a private test bank. The production launch proof
  // remains bound to its own fixed token and process incarnation.
  const token = 'uc3f-0123456789abcdef';
  const { bindingId: _bindingId, ...launchIdentity } = target;
  const receipt = { ...launchIdentity, image: 'C:\\fixture\\WindowsTerminal.exe', title: token, className: 'CASCADIA_HOSTING_WINDOW_CLASS' };
  Object.assign(h.window, receipt, { refused: 'FORBIDDEN_TARGET', bindingId: null, onCurrentDesktop: true, cloaked: false, minimized: false, popup: false });
  const proof = { expectedImage: receipt.image, launcher: { pid: receipt.pid, image: receipt.image, processStart: birth, observedEnd: birth }, windows: [receipt] };
  const registered = [];
  let parentWorkers = 0, trialContext;
  const testRepls = []; t.after(async () => { for (const repl of testRepls) await repl.close(); });
  // Run the production worker's evaluator and IPC. A fake that translates any
  // evaluation into getApp would hide an undefined runtime global.
  const worker = (...args) => { parentWorkers++; return fork(...args); };
  const backend = collector.createGuestBackend({ bank, rows: ['direct-launch-terminal'], revision: 'a'.repeat(40), ownerAway: true,
    selftestTarget: 'terminal', transportInvocation: '3' }, { platform: 'win32', validateBank() {},
    createClient: () => h.client,
    createRepl: options => { const repl = createWindowsReplClient({ ...options, driver: { ...options.driver, restart: async () => {} }, spawn: worker, environment: () => ({}) }); testRepls.push(repl); return repl; },
    guestCall: async (operation, params) => {
      if (operation === 'launch') return proof;
      if (operation === 'inspect') return receipt;
      throw Error(operation);
    } });
  t.after(() => backend.closeClients());
  let measured = false;
  const result = await collector.collectRow({ rowId: 'direct-launch-terminal', revision: 'a'.repeat(40), ownerAway: true, rowToken: 'a'.repeat(32) }, {
    ...backend, guard: async () => {}, now: Date.now, tick: () => 1,
    preflight: async () => {}, inspect: async f => f,
    startObserver: async () => ({ ready: true, invocation: '1', finish: async () => '' }),
    measure: async context => { trialContext = context; registered.push(...context.fixtures); measured = true; throw fault('TEST_SETUP_COMPLETE'); },
    closeClients: async () => {},
    writeRaw: async () => {},
  });
  assert.equal(result.code, 'TEST_SETUP_COMPLETE');
  assert.equal(measured, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].refusalObserved, true);
  assert.equal(h.frames.some(f => f.method === 'getAXState'), false);
  const parent = await backend.measure({ ...trialContext, caseId: 'parent-terminal' });
  assert.equal(parentWorkers, 1);
  assert.equal(parent.driver[0].raw.code, 'FORBIDDEN_TARGET');
  assert.deepEqual(parent.driver[0].raw.counters, stateCounters);
  assert.deepEqual(parent.parent, { cards: 0, leases: 0, contentReads: 0 });
  await backend.closeClients();
});
