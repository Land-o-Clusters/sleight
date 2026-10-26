import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { makePet, recipe, privateWork } from '../bench/demo/capture.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { checkBuiltinCharacter, builtinCharactersDirectory, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';

test('demo characters decode and the seven recipes validate in the production host without windows', { skip: macCommandSkip('xcrun') }, t => {
  const dir = registerTemp(t, privateWork()), host = join(dir, 'consent-host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), 'plugins/sleight/lib/direct-browser/native/consent-host.swift', '-o', host], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const nonce = 'a'.repeat(64), pet = makePet(dir);
  const env = { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: pet.root, SLEIGHT_BUILTIN_CHARACTERS: builtinCharactersDirectory() };
  for (const pack of [checkBuiltinCharacter('tsugi'), checkBuiltinCharacter('kit'), pet.pack]) {
    const frame = characterFrame(pack, { nonce, seq: 1, resolve: resolveCharacterStates, perch: pack !== pet.pack });
    const checked = spawnSync(host, ['--check-character'], { input: JSON.stringify(frame) + '\n', encoding: 'utf8', env, timeout: 15000 });
    assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).loaded, true, checked.stdout);
  }
  for (const id of ['01-ring', '02-states', '03-tsugi', '03-kit', '04-narration', '05-picker', '06-import']) {
    let seq = 0;
    const rows = [{ hand: 'menu', nonce, enabled: true, capture: 'visible', version: '1.5.0', narration: 'bubbles' }];
    for (const e of recipe(id)) {
      rows.push({ dumpClock: e.atMs / 1000 });
      const base = { nonce, seq: seq++, pid: 2147483647, windowId: 4294967295, at: [200, 200] };
      if (e.op === 'status') rows.push({ ...base, hand: 'status', state: e.state, ...e.state === 'done' ? { ok: true } : {} });
      else if (e.op === 'select') rows.push({ hand: 'picker', nonce, op: 'style', style: 'sprite' });
      else rows.push({ ...base, hand: 'act', kind: e.op, path: e.op === 'drag' ? [[200, 200], [400, 200]] : [[200, 200]], delayMs: 0, beats: 1, ...e.say ? { say: e.say } : {} });
    }
    const result = spawnSync(host, ['--ring-plan-dump', '--cursor-style=ring', '--clip=0,0,800,640'], {
      input: rows.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', env, timeout: 15000,
    });
    assert.equal(result.status, 0, `${id}: ${result.stderr}`);
    const output = result.stdout.trim().split('\n').map(JSON.parse);
    assert.ok(output.some(r => r.effect === 'draw'), id);
    if (id === '04-narration') assert.ok(output.some(r => r.bubble?.text?.includes('blue tile')), result.stdout);
  }
  t.diagnostic('charactersDecoded=3 recipesValidated=7 windowsCreated=0');
  let seq = 0;
  const aims = [];
  for (const e of recipe('01-ring')) {
    if (e.op === 'drag') break;
    if (e.op !== 'click') continue;
    const at = e.index === 1 ? [500, 200] : [200, 200];
    const base = { nonce, pid: 2147483647, windowId: 4294967295, at };
    aims.push({ dumpClock: e.atMs / 1000 }, { ...base, seq: seq++, hand: 'aim', kind: 'click', rect: [at[0] - 60, at[1] - 18, 120, 36] },
      { dumpClock: e.atMs / 1000 + 0.35 }, { ...base, seq: seq++, hand: 'act', kind: 'click', path: [at], delayMs: 0, beats: 1 });
  }
  const glides = spawnSync(host, ['--ring-plan-dump', '--cursor-style=ring', '--clip=0,0,800,640'], {
    input: aims.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', env, timeout: 15000, maxBuffer: 16 << 20,
  });
  assert.equal(glides.status, 0, `${glides.error ?? ''} ${glides.signal ?? ''} ${glides.stderr}`);
  const aimPlans = glides.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'draw' && r.state === 'aim');
  assert.equal(aimPlans.length, 3, glides.stdout);
  for (const plan of aimPlans.slice(1)) assert.ok(plan.animations.some(a => a.keyPath === 'position'), JSON.stringify(plan));
  t.diagnostic('preDragGlides=2/2');
});
