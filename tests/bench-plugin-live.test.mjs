import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../bench/plugin-live.mjs').catch(() => ({}));

function fixture({ held = false, load = 2, onScreen = true, bundle = 'com.apple.calculator' } = {}) {
  const calls = [];
  return { calls, options: { held: () => held, loads: () => [load, 3, 4], inspector: '/managed/inspector',
    run: async (command, args) => {
      calls.push([command, ...args]);
      const stdout = command === '/usr/bin/pgrep' ? '123\n' : args[0] === 'app-info'
        ? JSON.stringify([{ pid: 123, bundleIdentifier: bundle }])
        : JSON.stringify([{ ownerPID: 123, layer: 0, alpha: 1, onScreen, bounds: { width: 300, height: 400 } }]);
      return { exit: { code: 0 }, groupClean: true, stdout };
    } } };
}

test('Calculator live gate stops before inspection for a hold or load at twenty', async () => {
  for (const conditions of [{ held: true }, { load: 20 }, { load: NaN }]) {
    const f = fixture(conditions);
    await assert.rejects(api.assertCalculatorReady(f.options), /hold|load/);
    assert.equal(f.calls.length, 0);
  }
});

test('Calculator live gate requires the exact app and a visible current-Space window', async () => {
  for (const conditions of [{ onScreen: false }, { bundle: 'com.example.replacement' }]) {
    const f = fixture(conditions);
    await assert.rejects(api.assertCalculatorReady(f.options), /Calculator|Space/);
  }
  const f = fixture();
  assert.deepEqual(await api.assertCalculatorReady(f.options), { load: [2, 3, 4], calculatorPid: 123, onScreenWindows: 1 });
  assert.deepEqual(f.calls, [['/usr/bin/pgrep', '-x', 'Calculator'], ['/managed/inspector', 'app-info', '123'],
    ['/managed/inspector', 'windows-for-pid', '123', '--scope', 'on-screen']]);
});
