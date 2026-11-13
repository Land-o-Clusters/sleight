import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
const url = new URL('../bench/windows/guest-child.mjs', import.meta.url);
let source = readFileSync(url, 'utf8');
if (process.env.WH1F_GUEST_BROKEN) {
  assert.equal(process.env.WH1F_GUEST_BROKEN, 'signal');
  source = source.replace('if (reason) {', 'if (reason) { child.kill();');
}
const { runGuestChild } = process.env.WH1F_GUEST_BROKEN ? await import('data:text/javascript;base64,' + Buffer.from(source.replace(
  "from './kit.mjs'", `from '${new URL('../bench/windows/kit.mjs', import.meta.url).href}'`)).toString('base64')) : await import(url);

function harness() {
  const child = new EventEmitter(), calls = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => calls.push('unref');
  child.kill = () => assert.fail('only VM restore may terminate a guest process');
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return child; };
  return { child, calls, spawn };
}
for (const reason of ['timeout', 'aborted', 'output-limit', 'spawn-error'])
test(`guest ${reason} returns without a signal or a cleanup process`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), controller = new AbortController();
  const pending = runGuestChild('powershell.exe', [], { spawn: h.spawn, timeout: 1000, maxBytes: 10, signal: controller.signal });
  if (reason === 'timeout') t.mock.timers.tick(1000);
  if (reason === 'aborted') controller.abort();
  if (reason === 'output-limit') h.child.stdout.write('elevenbytes');
  if (reason === 'spawn-error') h.child.emit('error', Error('spawn failed'));
  const result = await pending;
  assert.equal(result.reason, reason); assert.equal(result.status, null);
  assert.equal(h.calls.filter(c => typeof c === 'object').length, 1); assert.ok(h.calls.includes('unref'));
});
test('guest child preserves bounded output and the real exit status', async () => {
  const h = harness();
  const pending = runGuestChild('powershell.exe', ['-NoProfile'], { spawn: h.spawn, input: 'fixed source', timeout: 1000 });
  h.child.stdout.write('out'); h.child.stderr.write('err'); h.child.emit('close', 7, null);
  const result = await pending; assert.equal(result.status, 7); assert.equal(result.reason, null);
  assert.equal(result.stdout, 'out'); assert.equal(result.stderr, 'err');
  assert.equal(h.calls[0].options.windowsHide, true); assert.equal(h.calls[0].options.shell, false);
});
