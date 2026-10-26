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
test('bubble has one text layer with A1 geometry and a separate rounded body', options, t => {
  const p = dump(t, [menu(), act()]).find(r => r.effect === 'draw');
  const bubble = p.layers.filter(l => l.name === 'narrationText');
  assert.equal(bubble.length, 1); assert.equal(bubble[0].kind, 'text');
  assert.equal(p.layers.find(l => l.name === 'narration').width, 0.6);
  assert.ok(bubble[0].text.split('\n').length <= 2);
  assert.ok(p.bubble.frame[2] <= 240 && p.bubble.frame[2] >= 60); assert.ok([26,40].includes(p.bubble.frame[3]));
  assert.equal(p.bubble.fontSize, 11); assert.equal(p.bubble.lineHeight, 14);
  assert.deepEqual(p.bubble.padding, [9,6]); assert.equal(p.bubble.radius, 8);
  const fade = p.animations.find(a => a.layer === 'narration' && a.keyPath === 'opacity');
  assert.equal(fade.duration, 0.09); assert.deepEqual(fade.values, [0,1]);
  const rise = p.animations.find(a => a.layer === 'narration' && a.keyPath === 'position.y');
  assert.deepEqual(rise.values, [4,0]);
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
const intersects = (a,b) => a[0] < b[0]+b[2] && a[0]+a[2] > b[0] && a[1] < b[1]+b[3] && a[1]+a[3] > b[1];
test('all seven action kinds stack the bubble above the chip with a 4 pt gap and avoid their target', options, t => {
  for (const kind of ['click', 'double', 'right', 'key', 'type', 'drag', 'scroll']) {
    for (const y of [500,59]) {
      const rect = [480,y-10,80,20], at = [500,y];
      const p = dump(t, [menu(), act({ kind, at, path: [at], label: 'Send button', rect })]).find(r => r.effect === 'draw');
      const b = p.bubble.frame, c = p.chip.frame;
      assert.equal(b[0],c[0]); assert.equal(c[3],16);
      assert.equal(intersects(b,c),false); assert.equal(intersects(b,rect),false); assert.equal(intersects(c,rect),false);
      if (y === 59) { assert.equal(c[1],y+25); assert.equal(b[1],c[1]+c[3]+4); }
      else assert.equal(b[1]+b[3]+4,c[1]);
    }
  }
});
test('bubble fits short text, follows position only, fades for 220 ms at terminal status and skips a repeated wrapped status', options, t => {
  const rows = dump(t, [menu(), act({ say: 'Open menu.' }), { dumpClock: 1 },
    { hand: 'status', nonce, seq: 2, pid: 42, windowId: 7, state: 'waiting', say: 'I will inspect the available menu options before choosing a format.' },
    { dumpClock: 1.01 }, { hand: 'status', nonce, seq: 3, pid: 42, windowId: 7, state: 'waiting', say: 'I will inspect the available menu options before choosing a format.' },
    { dumpClock: 1.1 }, { hand: 'status', nonce, seq: 4, pid: 42, windowId: 7, state: 'done', say: 'Finished.' }]);
  const plans = rows.filter(r => r.effect === 'draw');
  assert.equal(plans.length,3); assert.equal(plans[0].bubble.frame[3],26);
  assert.ok(plans[1].bubble.text.includes('\n'));
  const fade = plans.at(-1).animations.find(a => a.layer === 'narration' && a.keyPath === 'opacity');
  assert.equal(fade.duration,0.22); assert.deepEqual(fade.values,[1,0]);
  const reduced = dump(t,[menu(),act()],['--reduce-motion']).find(r => r.effect === 'draw');
  assert.equal(reduced.animations.some(a => a.layer === 'narration' && a.keyPath === 'position.y'),false);
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

test('id-only voice uses rate 0.5; repeats can speak again after 10 seconds; missing finish times out and cancels queue', options, t => {
  const input = { installed: ['local-a'], voice: { id: 'local-a' }, lines: ['First.',null,{time:9.9},'First.',{time:10},'First.'] };
  const result = run(t,['--narration-selftest'],input); assert.equal(result.status,0,result.stderr);
  const p = JSON.parse(result.stdout); assert.equal(p.rate,0.5); assert.deepEqual(p.started,['First.','First.']);
  for (const event of [{time:15}, {cancel:true}]) {
    const p = JSON.parse(run(t,['--narration-selftest'],{installed:['local-a'],lines:['First.','Second.',event]}).stdout);
    assert.equal(p.active,null); assert.equal(p.queued,null); assert.deepEqual(p.started,['First.']);
  }
});
test('NarrationAudio.safe itself runs against fake Core Audio metadata for every silence gate and channel-only outputs', options, t => {
  for (const gate of ['safe','channels','secure','muted','zero-volume','unknown-output','unknown-mute','unknown-volume','split-muted','unknown-input','microphone','unknown-process']) {
    const result = run(t,['--narration-audio-selftest'],{gate}); assert.equal(result.status,0,result.stderr);
    const p = JSON.parse(result.stdout); assert.equal(p.safe,['safe','channels'].includes(gate),gate);
    assert.equal(p.reasons.length,p.safe ? 0 : 1);
  }
});
test('host independently strips key shapes, long tokens and Luhn-valid cards', options, t => {
  for (const token of ['sk-ant-api03-AbCdEf123456','ghp_abcdefghijklmnop1234','gho_abcdefghijklmnop1234','xoxb-123456-abcdefghi','AKIAIOSFODNN7EXAMPLE',
    '4111 1111 1111 1111','4000000000000000006','ab12'.repeat(12),'YWJj'.repeat(12)]) {
    const p = dump(t,[menu(),act({say:`Checking ${token} now.`})]).find(r => r.effect === 'draw');
    assert.equal(p.bubble.text,'Checking now.',token);
  }
});

test('Core Audio process reads run off the main thread at most every 500 ms and explain unknown metadata once', options, t => {
  for (const gate of ['safe','unknown-process']) {
    const result = run(t,['--narration-audio-selftest'],{gate,monitor:true}); assert.equal(result.status,0,result.stderr);
    const p = JSON.parse(result.stdout); assert.equal(p.probes,3); assert.equal(p.offMain,true); assert.equal(p.pending,false);
    assert.equal(result.stderr.split('sleight narration silent:').length-1,gate === 'safe' ? 0 : 1);
  }
});

test('a first voice line waits for the background metadata check and then uses fake playback', options, t => {
  const result = run(t,['--narration-selftest'],{installed:['local-a'],asyncAudio:true,lines:['First.']});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout).started,['First.']);
});

test('a changed line on a short key action finishes its fade before parking', options, t => {
  const rows = dump(t,[menu(),act(),{dumpClock:1},act({kind:'key',seq:2,say:'Opening the next menu.'})]);
  const p = rows.filter(r => r.effect === 'draw').at(-1);
  const opacity = p.animations.find(a => a.layer === 'narration' && a.keyPath === 'opacity');
  assert.equal(opacity.beginTime,0.06); assert.equal(opacity.duration,0.09);
  assert.ok(p.total >= 0.15); assert.ok(p.timers.find(t => t[1] === 'park')[0] >= 0.15);
  for (const track of p.animations) assert.ok(track.beginTime+track.duration <= p.total+1e-8);
});
