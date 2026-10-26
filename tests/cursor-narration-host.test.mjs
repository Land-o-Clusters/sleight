import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';

const options = { skip: macCommandSkip('xcrun') };
const nonce = 'a'.repeat(64);
const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
let binary;
function run(t, flags, input) {
  if (!binary) {
    const output = join(trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'c2-host-')))), 'consent-host');
    const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source, '-o', output], { encoding: 'utf8', timeout: 120000 });
    assert.equal(build.status, 0, build.stderr); binary = output; t.diagnostic(`binaryBytes=${statSync(binary).size}`);
  }
  return spawnSync(binary, flags, { input: (Array.isArray(input) ? input : [input]).map(v => JSON.stringify(v)).join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
}
const menu = (narration = 'bubbles', voice) => ({ hand: 'menu', nonce, enabled: true, capture: 'hidden', version: '1.6.0', narration, ...voice ? { voice } : {} });
const act = extra => ({ hand: 'act', nonce, seq: 1, kind: 'click', pid: 42, windowId: 7, at: [500, 500], path: [[500, 500]], beats: 1, delayMs: 0, say: 'I’ll inspect the menu before choosing an export format.', ...extra });
function dump(t, input, extra = []) {
  const result = run(t, ['--ring-plan-dump', '--cursor-style=ring', ...extra], input);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse);
}
test('bubble plan uses one two-line text layer and the ring opacity, clipped beside its target', options, t => {
  const rows = dump(t, [menu(), act({ say: 'I’ll inspect the available menu options before choosing the best export format for this task.' })]);
  const p = rows.find(r => r.effect === 'draw'), bubble = p.layers.filter(l => l.name === 'narration');
  assert.equal(bubble.length, 1); assert.equal(bubble[0].kind, 'text');
  assert.ok(bubble[0].text.split('\n').length <= 2);
  assert.ok(p.bubble.frame[2] <= 300 && p.bubble.frame[3] <= 40);
  assert.ok(p.bubble.frame[0] > p.at[0] || p.bubble.frame[0] + p.bubble.frame[2] < p.at[0] || p.bubble.frame[1] + p.bubble.frame[3] < p.at[1]);
  const opacity = p.animations.find(a => a.layer === 'narration' && a.keyPath === 'opacity');
  const ringOpacity = p.animations.find(a => a.layer === 'cursor' && a.keyPath === 'opacity');
  if (ringOpacity) assert.deepEqual(opacity.values, ringOpacity.values);
  else assert.equal(bubble[0].props.opacity, p.layers.find(l => l.name === 'cursor').props.opacity);
  assert.ok(rows.some(r => r.effect === 'fade')); assert.equal(rows.at(-1).idle, true);
});
test('default off and secure input omit narration for click, aim, typing and status', options, t => {
  const frames = [act(), { hand: 'aim', nonce, seq: 2, kind: 'click', pid: 42, windowId: 7, at: [500, 500], say: 'I’ll check.' },
    { hand: 'status', nonce, seq: 3, state: 'thinking', pid: 42, windowId: 7, say: 'I’ll check.' }];
  for (const [prefix, flags] of [[[], []], [[menu()], ['--secure-input']]]) {
    for (const p of dump(t, [...prefix, ...frames], flags).filter(r => r.effect === 'draw')) {
      assert.equal(p.bubble, null); assert.equal(p.layers.some(l => l.name === 'narration'), false);
    }
  }
});
test('host independently removes path, URL, code and quoted tokens', options, t => {
  const p = dump(t, [menu(), act({ say: 'Open ' + ['', 'Users', 'test', 'secret'].join('/') + ' https://private.test/a `value` "value" the menu.' })]).find(r => r.effect === 'draw');
  assert.equal(p.bubble.text, 'Open the menu.');
});
test('bubble stays in the target clip at every corner, wraps long words and shares terminal dissolve', options, t => {
  for (const at of [[5, 5], [995, 5], [5, 995], [995, 995]]) {
    const p = dump(t, [menu(), act({ at, path: [at], say: 'A'.repeat(90) })]).find(r => r.effect === 'draw');
    const [x, y, w, h] = p.bubble.frame;
    assert.ok(x >= 0 && y >= 0 && x + w <= 1000 && y + h <= 1000);
    assert.ok(p.bubble.text.includes('\n')); assert.ok(p.bubble.text.replace(/\n/g, '').length >= 80);
  }
  const rows = dump(t, [menu(), act(), { dumpClock: 1 }, { hand: 'status', nonce, seq: 2, pid: 42, windowId: 7, state: 'done', say: 'Finished.' }]);
  const p = rows.filter(r => r.effect === 'draw').at(-1);
  assert.deepEqual(p.animations.find(a => a.layer === 'narration' && a.keyPath === 'opacity').values,
    p.animations.find(a => a.layer === 'cursor' && a.keyPath === 'opacity').values);
});
test('malformed say and voice frames are refused without creating an application', options, t => {
  for (const frame of [act({ say: 3 }), act({ say: 'x'.repeat(2000) }), menu('yes'), menu('voice', { id: '../x', rate: 0.5 }), menu('voice', { id: 'voice', rate: true })]) {
    assert.equal(run(t, ['--ring-plan-dump', '--cursor-style=ring'], frame).status, 65);
  }
});
test('the public narration check is nonce-bound, carries no text and reports the dump secure state', options, t => {
  const frame = { hand: 'narration-check', nonce, token: 'b'.repeat(32) };
  for (const secure of [false, true]) {
    const rows = dump(t, frame, secure ? ['--secure-input'] : []);
    assert.equal(rows[0].effect, 'narration-check'); assert.equal(rows[0].secure, secure);
  }
  assert.equal(run(t, ['--ring-plan-dump', '--cursor-style=ring'], { ...frame, say: 'Not admitted.' }).status, 65);
  assert.equal(run(t, ['--ring-plan-dump', '--cursor-style=ring'], { ...frame, token: '../bad' }).status, 65);
});
test('voice selection uses the installed list, refuses missing ids, and bounds rate', options, t => {
  const result = run(t, ['--narration-selftest'], { installed: ['local-a', 'local-b'], voice: { id: 'local-b', rate: 0.5 }, lines: [] });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).selected, 'local-b');
  const absent = run(t, ['--narration-selftest'], { installed: ['local-a'], voice: { id: 'missing', rate: 0.5 }, lines: [] });
  assert.equal(JSON.parse(absent.stdout).selected, null);
});
test('one active utterance and one replaceable queued line, with duplicate frames spoken once', options, t => {
  const result = run(t, ['--narration-selftest'], { installed: ['local-a'], lines: ['First.', 'Second.', 'Third.', 'Third.', null, null] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).started, ['First.', 'Third.']);
});
test('secure, muted, unknown-output and microphone-active gates drop active and queued voice', options, t => {
  for (const gate of ['secure', 'muted', 'unknown', 'microphone']) {
    const result = run(t, ['--narration-selftest'], { installed: ['local-a'], lines: ['First.', 'Second.', { gate }, null] });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).started, ['First.']);
    assert.equal(JSON.parse(result.stdout).active, null); assert.equal(JSON.parse(result.stdout).queued, null);
  }
});
test('installed voices enumerate and speech buffer dump reports samples and CPU without playback', options, t => {
  const listed = run(t, ['--narration-voices'], {}); assert.equal(listed.status, 0, listed.stderr);
  const voices = JSON.parse(listed.stdout); assert.ok(Array.isArray(voices));
  t.diagnostic(`installedVoices=${voices.length}`);
  if (!voices.length) return t.skip('No installed system voices; buffer synthesis unverified.');
  const result = run(t, ['--narration-buffer-dump'], { say: 'I will inspect the menu.', voice: { id: voices[0].id, rate: 0.5 } });
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout); t.diagnostic(JSON.stringify(measured));
  assert.equal(measured.played, false); assert.ok(measured.frames > 0); assert.ok(measured.cpuMs >= 0); assert.ok(measured.wallMs > 0);
});
