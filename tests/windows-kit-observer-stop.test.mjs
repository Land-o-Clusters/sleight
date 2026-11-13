import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';

const url = new URL('../bench/windows/kit.mjs', import.meta.url);
let source = readFileSync(url, 'utf8');
const variant = process.env.UC3G3D_KIT_BROKEN;
if (variant) {
  const mutations = {
    signal: ["abortSignal?.addEventListener('abort', abort, { once: true });", ''],
    reap: ['child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref?.();', 'child.unref?.();'],
    guestKill: ["cleanup = 'restore-required'; finish();", "child.kill(); cleanup = 'restore-required'; finish();"],
    macKill: ["if (platform !== 'win32') { child.kill(); return; }", "if (platform !== 'win32') { return; }"],
  };
  assert.ok(mutations[variant] && source.includes(mutations[variant][0]));
  source = source.replace(...mutations[variant]).replaceAll('import.meta.url', JSON.stringify(url.href));
}
const { runChild } = variant ? await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')) : await import(url);

test('observer abort detaches the guest child and leaves cleanup to restore', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), calls = [];
  let child, unrefs = 0;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const proc = new EventEmitter(); proc.pid = 4321;
    assert.equal(child, undefined, 'no guest cleanup child');
    child = proc; proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => assert.fail('only VM restore cleans guest children'); proc.unref = () => unrefs++;
    return proc;
  };
  const pending = runChild('observer.exe', [], { platform: 'win32', spawn, signal: controller.signal, timeout: 1000 });
  controller.abort();
  assert.equal(calls.length, 1);
  assert.equal(unrefs, 1);
  assert.ok([child.stdin, child.stdout, child.stderr].every(s => s.destroyed));
  const result = await pending;
  assert.equal(result.reason, 'aborted'); assert.equal(result.cleanup, 'restore-required');
});

test('observer timeout returns without a guest-close event or another process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let child;
  const spawn = () => {
    const proc = new EventEmitter(); proc.pid = 4321;
    assert.equal(child, undefined);
    child = proc; proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.unref = () => {}; proc.kill = () => assert.fail('guest signal');
    return proc;
  };
  let result;
  const pending = runChild('observer.exe', [], { platform: 'win32', spawn, timeout: 895000 })
    .then(value => { result = value; });
  t.mock.timers.tick(894999); await Promise.resolve(); assert.equal(result, undefined);
  t.mock.timers.tick(1); await Promise.resolve();
  assert.equal(result?.reason, 'timeout'); assert.equal(result?.cleanup, 'restore-required');
  await pending;
});

test('Mac timeout still signals only its owned child and waits for its close event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let child, signals = 0, settled = false;
  const pending = runChild('ssh', [], { platform: 'darwin', timeout: 1000, spawn: () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { signals++; }; return child;
  } }).then(value => { settled = true; return value; });
  t.mock.timers.tick(1000); assert.equal(signals, 1); await Promise.resolve(); assert.equal(settled, false);
  child.emit('close', null, 'SIGTERM'); const result = await pending;
  assert.equal(result.reason, 'timeout'); assert.equal(result.signal, 'SIGTERM'); assert.equal(result.cleanup, null);
});
