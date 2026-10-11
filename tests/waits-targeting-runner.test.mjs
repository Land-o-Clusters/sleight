import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Execute the runner with controlled OS boundaries: these cases must never take the real lock,
// inspect the Mac, launch an app or start an engine.
async function measureFailure({ quitFails = false, spawnFails = false, workerCollected = true, loadClass, load = [20, 20, 20] } = {}) {
  const script = new URL('../bench/waits-targeting-live.mjs', import.meta.url);
  const source = readFileSync(script, 'utf8').replace(/^import[^\n]*\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(script.href));
  const timers = new Set();
  let runningReads = 0, unlocks = 0, removed = false, report;
  const context = {
    assert, join, fileURLToPath, URL, performance,
    process: { argv: ['node', fileURLToPath(script), 'measure', ...(loadClass ? ['--' + loadClass] : [])], env: {}, execPath: 'node', once() {} },
    console: { log() {} },
    loadavg: () => load, userInfo: () => ({ username: 'fixture-user' }), homedir: () => '/fixture-home',
    mkdtempSync: () => '/private/tmp/sleight-runner-fixture',
    existsSync: path => path.endsWith('.json'),
    readFileSync: () => JSON.stringify({ childrenCollected: workerCollected, attempts: [{ label: 'action', load }] }),
    writeFileSync: (path, data) => { if (path.endsWith('.json')) report = JSON.parse(data); },
    rmSync: () => { removed = true; },
    reliabilityEvidence: value => JSON.stringify(value),
    chessMovePoints: () => ({ from: [0, 0], to: [0, 0], source: 'fixture' }),
    acquireLiveLock: async () => async () => { unlocks++; },
    execFile() {},
    promisify: () => async (cmd, args) => {
      if (cmd === '/usr/bin/osascript') {
        const request = JSON.parse(args.at(-1));
        if (request.op === 'running') return { stdout: JSON.stringify({ running: runningReads++ > 0 || !quitFails, pids: [123] }) };
        if (request.op === 'quit' && quitFails) throw new Error('Owned app quit unconfirmed');
        throw new Error('Unexpected fixture operation');
      }
      if (cmd.endsWith('codex-macos-inspect')) return { stdout: JSON.stringify([{ layer: 0, alpha: 1, bounds: { width: 200, height: 200 } }]) };
      if (cmd === '/usr/bin/open') return { stdout: '' };
      throw new Error('Unexpected OS command');
    },
    spawn: () => {
      const child = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => spawnFails ? child.emit('error', new Error('spawn refused')) : child.emit('close', 0, null));
      return child;
    },
    setInterval: callback => { const timer = { callback }; timers.add(timer); return timer; },
    clearInterval: timer => timers.delete(timer),
  };
  await runInNewContext(`(async () => { ${source}\n})()`, context, { filename: fileURLToPath(script) });
  return { report, unlocks, removed, timers: timers.size, runningReads };
}

test('unconfirmed Calculator cleanup retains the measurement lock and evidence bank', async () => {
  const result = await measureFailure({ quitFails: true });
  assert.match(result.report.error, /quit unconfirmed/);
  assert.equal(result.unlocks, 0);
  assert.equal(result.removed, false);
  assert.equal(result.report.lockRetained, true);
  assert.equal(result.report.childrenCollected, false);
});

test('a failed measurement worker spawn cancels its polling timer', async () => {
  const result = await measureFailure({ spawnFails: true });
  assert.match(result.report.error, /spawn refused/);
  assert.equal(result.timers, 0);
  assert.equal(result.unlocks, 0, 'unconfirmed worker collection retains ownership');
});

test('a worker without confirmed engine collection retains the parent lock', async () => {
  const result = await measureFailure({ workerCollected: false });
  assert.equal(result.unlocks, 0);
  assert.equal(result.removed, false);
  assert.equal(result.report.lockRetained, true);
});
test('cost slots refuse the wrong natural load before launching an app', async () => {
  for (const [loadClass, load] of [['idle', [20, 20, 20]], ['loaded', [5, 5, 5]]]) {
    const result = await measureFailure({ loadClass, load });
    assert.match(result.report.error, /Natural load does not qualify/);
    assert.equal(result.runningReads, 0); assert.equal(result.unlocks, 1);
  }
});
test('a qualified cost slot compares identity on and off in reversed order', async () => {
  const result = await measureFailure({ loadClass: 'loaded' });
  assert.equal(result.report.error, undefined);
  assert.deepEqual(result.report.attempts.map(a => a.arm), ['off', 'native', 'native', 'off']);
});
