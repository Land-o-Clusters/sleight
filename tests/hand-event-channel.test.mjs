import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { constants, openSync, closeSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const test = (name, body) => nodeTest(name, { skip: process.platform !== 'darwin' && 'macOS private FIFO bench only' }, body);

const modulePath = '../bench/hand/event-channel.mjs';
const collected = async () => {};
const fakeLock = () => ({ path: '/tmp/sleight-live.lock', dev: 1, ino: 2, uid: 501, mode: 0o755, birthtimeMs: 1000 });
const fakeIdentity = () => Object.freeze({ source: Object.freeze({ head: 'mock-head', probes: Object.freeze({}) }), engine: Object.freeze({}) });
const load = async () => {
  const module = await import(modulePath);
  return { ...module, runProbe: options => module.runProbe({ collect: collected, ...options }) };
};
const loadLive = async () => {
  const module = await import('../bench/hand/event-channel-live.mjs');
  return { ...module, runLive: options => module.runLive({ collect: collected, identify: fakeIdentity, inspectLock: fakeLock, ...options }) };
};
// This macOS bench requires the canonical directory behind the operating system's shared temporary alias.
const temporary = () => trackTemp(mkdtempSync(join(realpathSync('/tmp'), 'sleight-hand-channel-test-')));
const reader = slot => openSync(slot.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
const identity = { epoch: 'epoch-test', call: 'call-test', action: 0, attempt: 1, stage: 'invoke' };

// Removing the held-reader observation or consuming on result loses these real FIFO demands.
test('real FIFO holds final demand after result and polling consumes each slot once', async () => {
  const { createChannel } = await load();
  const root = temporary();
  let fd, channel;
  try {
    channel = createChannel({ root, epoch: identity.epoch, call: identity.call });
    assert.equal(lstatSync(channel.manifest.directory.path).mode & 0o777, 0o700);
    const slot = channel.manifest.slots.find(s => s.action === 0 && s.attempt === 1 && s.stage === 'invoke');
    fd = reader(slot);
    const resultAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 15));
    channel.poll(); channel.poll();
    assert.equal(channel.events.length, 1);
    assert.deepEqual(Object.fromEntries(Object.keys(identity).map(k => [k, channel.events[0][k]])), identity);
    assert.ok(channel.events[0].receivedAt >= resultAt);
    closeSync(fd); fd = undefined;
    assert.equal(channel.cleanup().ok, true);
    assert.deepEqual(readdirSync(root), []);
  } finally { if (fd !== undefined) closeSync(fd); channel?.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('replaced FIFO or symlink is rejected and cleanup leaves replacement untouched', async () => {
  const { createChannel } = await load();
  for (const kind of ['symlink', 'fifo']) {
    const root = temporary();
    const channel = createChannel({ root, epoch: 'e', call: 'c' });
    const slot = channel.manifest.slots[0];
    const moved = slot.path + '.original';
    renameSync(slot.path, moved);
    if (kind === 'symlink') symlinkSync(moved, slot.path);
    else (await import('node:child_process')).execFileSync('/usr/bin/mkfifo', ['-m', '600', slot.path]);
    assert.throws(() => channel.poll(), /identity|symlink/);
    assert.equal(channel.cleanup().ok, false);
    assert.ok(lstatSync(slot.path));
    rmSync(root, { recursive: true, force: true });
  }
});

function mockEngine({ delay = 0, mutate = code => code, close = true } = {}) {
  const context = { setTimeout, clearTimeout, console, nodeRepl: { write: value => output.push(value) } };
  let output = [];
  const engine = {
    pid: 424242,
    calls: 0,
    async call(name, args) {
      assert.equal(name, 'js'); engine.calls++; output = [];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      // The external sandbox is mocked. Execute its submitted source with real Node filesystem behavior.
      await new Function('nodeRepl', `return (async()=>{${mutate(args.code)}})();`)(context.nodeRepl);
      return { content: output.map(text => ({ type: 'text', text })) };
    },
    async close() { return close; },
  };
  return engine;
}

// This keeps real guardedCode, real node:fs opens and real polling; only the external engine is replaced.
test('mocked engine executes the real guard retry with and without fake approvals', async () => {
  const { runProbe } = await load();
  for (const approval of [false, true]) for (const delivery of ['during', 'after-result']) {
    const root = temporary();
    try {
      const receipt = await runProbe({ engine: mockEngine(), root, approval, delivery, timeoutMs: 3000, pollMs: 2 });
      assert.equal(receipt.status, 'pass', JSON.stringify(receipt));
      assert.deepEqual(receipt.sent.filter(e => e.stage === 'invoke').map(e => [e.action, e.attempt]), [[0, 1], [1, 1], [1, 2], [2, 1]]);
      assert.deepEqual(receipt.sent.filter(e => e.stage === 'fulfilled').map(e => [e.action, e.attempt]), [[0, 1], [1, 2], [2, 1]]);
      assert.equal(receipt.sent.filter(e => e.stage === 'rejected').length, 1);
      assert.equal(receipt.sent.filter(e => e.stage === 'approval').length, approval ? 4 : 0);
      assert.equal(receipt.received.length, approval ? 12 : 8);
      assert.equal(receipt.cleanup.ok, true);
      const firstReturn = receipt.received.find(e => e.action === 0 && e.stage === 'fulfilled');
      assert.ok(delivery === 'during' ? firstReturn.receivedAt < receipt.resultAt : firstReturn.receivedAt > receipt.resultAt);
      assert.ok(receipt.sent.every(e => Number.isFinite(e.sentAt)));
      assert.deepEqual(readdirSync(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('duplicate demand and missing event fail with retained diagnostic receipts', async () => {
  const { runProbe } = await load();
  for (const fault of ['duplicate', 'missing']) {
    const root = temporary();
    try {
      // Allow the same wall time as the successful FIFO cases. The next test covers expiry.
      const receipt = await runProbe({ engine: mockEngine(), root, timeoutMs: 3000, pollMs: 2, fault });
      assert.equal(receipt.status, 'fail');
      assert.match(receipt.failure.message, fault === 'duplicate' ? /duplicate/ : /missing/);
      assert.equal(receipt.retainedDiagnostic, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('timeout and cancellation stop polling and retain channel until engine cleanup is proved', async () => {
  const { runProbe } = await load();
  for (const abort of [false, true]) {
    const root = temporary();
    const controller = new AbortController();
    let timer;
    try {
      if (abort) timer = setTimeout(() => controller.abort(Error('cancelled')), 20);
      const engine = { pid: 424242, call: () => new Promise(() => {}), close: async () => false };
      const receipt = await runProbe({ engine, root, timeoutMs: 50, signal: controller.signal });
      assert.equal(receipt.status, 'fail');
      assert.match(receipt.failure.message, abort ? /cancelled/ : /timeout/);
      assert.equal(receipt.cleanup.ok, false);
      assert.equal(receipt.retainLiveLock, true);
      assert.ok(readdirSync(root).length > 0);
    } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
  }
});

test('a settled bounded call removes cancellation listeners and never starts a cancelled operation', async () => {
  const { bounded } = await load();
  const controller = new AbortController();
  assert.equal(await bounded(() => 42, 100, controller.signal), 42);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(Error('already cancelled'));
  let calls = 0;
  await assert.rejects(bounded(() => { calls++; }, 100, controller.signal), /already cancelled/);
  assert.equal(calls, 0);
});

test('sandbox refusal remains a failed receipt and is never retried through a different transport', async () => {
  const { runProbe } = await load();
  const root = temporary();
  let calls = 0;
  try {
    const receipt = await runProbe({ root, timeoutMs: 500, engine: {
      pid: 424242,
      call: async () => { calls++; return { isError: true, content: [{ type: 'text', text: 'EACCES: sandbox denied read-only FIFO open' }] }; },
      close: async () => true,
    } });
    assert.equal(receipt.status, 'fail');
    assert.match(receipt.failure.message, /EACCES/);
    assert.equal(calls, 1);
    assert.equal(receipt.retainedDiagnostic, true);
    assert.equal(receipt.cleanup.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live runner completes all four transport cases and releases only its own lock', async () => {
  const { runLive } = await loadLive();
  const root = temporary();
  let released = 0;
  try {
    const report = await runLive({ live: true, out: join(root, 'run'), timeoutMs: 3000, exists: () => false,
      lock: async () => async () => { released++; }, resolve: () => ({ command: 'mock', args: [], env: {} }),
      open: async () => mockEngine(),
    });
    assert.equal(report.status, 'pass', JSON.stringify(report));
    assert.equal(report.cases.length, 4);
    assert.equal(released, 1);
    assert.deepEqual(readdirSync(join(root, 'run')), ['receipt.json']);
    const terminal = JSON.parse(readFileSync(join(root, 'run', 'receipt.json'), 'utf8'));
    assert.deepEqual(terminal.liveLock, fakeLock());
    assert.equal(terminal.lockRelease.confirmed, false);
    assert.equal(terminal.lockRelease.state, 'eligible-after-terminal-save');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live runner refuses implicit live work and respects hold before opening engine', async () => {
  const { runLive } = await loadLive();
  let opens = 0;
  const open = async () => { opens++; throw Error('must not open'); };
  assert.equal((await runLive({ open })).status, 'refused');
  assert.equal((await runLive({ live: true, exists: path => path === '/tmp/sleight-hold', open })).status, 'refused');
  assert.equal(opens, 0);
});

test('live runner retains receipt, recorded channel and live lock on uncertain child cleanup', async () => {
  const { runLive } = await loadLive();
  const root = temporary();
  let released = 0;
  try {
    const report = await runLive({ live: true, out: join(root, 'run'), timeoutMs: 50, exists: () => false,
      lock: async () => async () => { released++; },
      resolve: () => ({ command: 'mock', args: [], env: {} }),
      open: async () => ({ call: () => new Promise(() => {}), close: async () => false }),
    });
    assert.equal(report.status, 'fail');
    assert.equal(report.retainLiveLock, true);
    assert.equal(released, 0);
    assert.equal(JSON.parse(readFileSync(join(root, 'run', 'receipt.json'), 'utf8')).status, 'fail');
    assert.ok(readdirSync(join(root, 'run')).some(name => name.startsWith('channel-')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancellation during engine startup collects a client that resolves after the run stops', async () => {
  const { runLive } = await loadLive();
  const root = temporary(), controller = new AbortController();
  let deliver, closed = 0, released = 0;
  try {
    const running = runLive({ live: true, out: join(root, 'run'), timeoutMs: 50, signal: controller.signal,
      exists: () => false, lock: async () => async () => { released++; }, resolve: () => ({ command: 'mock' }),
      open: () => new Promise(resolve => { deliver = resolve; }),
    });
    while (!deliver) await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort(Error('cancelled startup'));
    const report = await running;
    assert.equal(report.retainLiveLock, true);
    assert.equal(released, 0);
    deliver({ close: async () => { closed++; return true; } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(closed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('receipt replacement cannot overwrite a foreign file and retains diagnostic ownership', async () => {
  const { runLive } = await loadLive();
  const root = temporary(), target = join(root, 'foreign');
  writeFileSync(target, 'leave this alone');
  let released = 0;
  try {
    const report = await runLive({ live: true, out: join(root, 'run'), timeoutMs: 3000, exists: () => false,
      lock: async () => async () => { released++; }, resolve: () => ({ command: 'mock' }),
      open: async () => {
        const engine = mockEngine(), original = engine.call;
        let replaced = false;
        engine.call = async (...args) => {
          if (!replaced) {
            replaced = true;
            renameSync(join(root, 'run', 'receipt.json'), join(root, 'run', 'receipt.original'));
            symlinkSync(target, join(root, 'run', 'receipt.json'));
          }
          return original(...args);
        };
        return engine;
      },
    });
    assert.equal(readFileSync(target, 'utf8'), 'leave this alone');
    assert.equal(report.status, 'fail');
    assert.equal(report.retainLiveLock, true);
    assert.equal(released, 0);
    assert.equal(JSON.parse(readFileSync(report.receiptPath, 'utf8')).status, 'fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a hold appearing during a call cancels the owned engine and records its cleanup', async () => {
  const { runLive } = await loadLive();
  const root = temporary();
  let held = false, closed = 0, released = 0;
  try {
    const report = await runLive({ live: true, out: join(root, 'run'), timeoutMs: 1000,
      exists: path => path === '/tmp/sleight-hold' && held,
      lock: async () => async () => { released++; }, resolve: () => ({ command: 'mock' }),
      open: async () => { held = true; return { pid: 424242, call: () => new Promise(() => {}), close: async () => { closed++; return true; } }; },
    });
    assert.equal(report.status, 'fail');
    assert.match(report.failure.message, /sleight-hold/);
    assert.equal(closed, 1);
    assert.equal(released, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('top-level child close cannot remove a bank when owned group collection fails', async () => {
  const { runProbe } = await load();
  const root = temporary(), order = [];
  const engine = mockEngine(), originalClose = engine.close;
  engine.close = async () => { order.push('close'); return originalClose(); };
  try {
    const receipt = await runProbe({ root, engine, delivery: 'after-result', timeoutMs: 1000,
      collect: async pid => { assert.equal(pid, 424242); order.push('collect'); throw Error('residual owned group remains'); },
    });
    assert.deepEqual(order, ['close', 'collect']);
    assert.equal(receipt.clientClosed, true);
    assert.equal(receipt.groupCollected, false);
    assert.equal(receipt.status, 'fail');
    assert.equal(receipt.retainLiveLock, true);
    assert.ok(readdirSync(root).some(name => name.startsWith('channel-')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown child PID cannot qualify cleanup even when close returns true', async () => {
  const { runProbe } = await load();
  const root = temporary(), engine = mockEngine();
  delete engine.pid;
  try {
    const receipt = await runProbe({ root, engine, delivery: 'after-result', timeoutMs: 1000,
      collect: async () => { throw Error('must not collect an unknown group'); },
    });
    assert.equal(receipt.status, 'fail');
    assert.equal(receipt.groupCollected, false);
    assert.equal(receipt.retainLiveLock, true);
    assert.match(receipt.groupCleanupFailure.message, /PID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal receipt write failure happens before any lock release and retains a diagnostic', async () => {
  const { runLive } = await loadLive();
  const root = temporary();
  let released = 0, failed = false;
  try {
    const report = await runLive({ live: true, out: join(root, 'run'), timeoutMs: 1000, exists: () => false,
      lock: async () => async () => { released++; }, resolve: () => ({ command: 'mock', args: [] }), open: async () => mockEngine(),
      write: (fd, data, ...args) => {
        if (!failed && JSON.parse(data.toString()).finishedAt) { failed = true; throw Error('terminal receipt ENOSPC'); }
        return writeSync(fd, data, ...args);
      },
    });
    assert.equal(failed, true);
    assert.equal(released, 0);
    assert.equal(report.status, 'fail');
    assert.equal(report.retainLiveLock, true);
    const terminal = JSON.parse(readFileSync(report.receiptPath, 'utf8'));
    assert.equal(terminal.status, 'fail');
    assert.equal(terminal.lockRelease.state, 'retained');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('identity receipt binds source and engine bytes without exposing argument values', async () => {
  const { captureIdentity } = await loadLive();
  const root = temporary(), command = join(root, 'engine'), entrypoint = join(root, 'entrypoint');
  writeFileSync(command, 'fake executable bytes'); writeFileSync(entrypoint, 'fake entrypoint bytes');
  const secret = 'private-argument-do-not-print';
  try {
    const first = captureIdentity({ command, args: [entrypoint, secret] });
    assert.match(first.source.head, /^[a-f0-9]{40}$/);
    assert.match(first.source.probes['bench/hand/event-channel.mjs'], /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first).includes(secret), false);
    assert.equal(JSON.stringify(first).includes(entrypoint), false);
    assert.throws(() => { first.source.head = 'changed'; }, TypeError);
    writeFileSync(entrypoint, 'changed entrypoint bytes');
    const changedBytes = captureIdentity({ command, args: [entrypoint, secret] });
    assert.notEqual(first.engine.entrypointSha256, changedBytes.engine.entrypointSha256);
    const changedArgs = captureIdentity({ command, args: [entrypoint, 'different'] });
    assert.notEqual(first.engine.argsSha256, changedArgs.engine.argsSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('candidate identity drift stops before the next engine submission', async () => {
  const { runLive } = await loadLive();
  const root = temporary();
  let captures = 0, opens = 0;
  try {
    const report = await runLive({ live: true, out: join(root, 'run'), timeoutMs: 1000, exists: () => false,
      lock: async () => async () => {}, resolve: () => ({ command: 'mock', args: [] }),
      identify: () => ({ source: { head: ++captures === 1 ? 'first' : 'changed' } }),
      open: async () => { opens++; return mockEngine(); },
    });
    assert.equal(opens, 0);
    assert.equal(report.status, 'fail');
    assert.match(report.failure.message, /identity changed/);
    assert.equal(JSON.parse(readFileSync(report.receiptPath, 'utf8')).identity.source.head, 'first');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
