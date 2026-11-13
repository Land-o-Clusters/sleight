import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { installSyntheticCharacter } from '../bench/hand/synthetic-character.mjs';
import { cursorMenuModel } from '../plugins/sleight/lib/hand/cursor-picker.mjs';

const mac = process.platform === 'darwin';
const options = { skip: mac ? false : 'requires macOS' };
const nonce = 'a'.repeat(64);
let binary, root;
function build(t) {
  if (binary) return binary;
  const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  assert.match(fs.readFileSync(source, 'utf8'), /if arguments.first == "--cursor-menu-dump"/, 'headless entry point must exist before invoking the host');
  root = trackTemp(fs.realpathSync(fs.mkdtempSync(join('/private', 'tmp', 'sleight-picker-native-'))));
  binary = join(root, 'host');
  const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source.pathname, '-o', binary], { encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, r.stderr); t.diagnostic(`binaryBytes=${fs.statSync(binary).size}`); return binary;
}
function run(t, frames, more = {}) {
  const output = spawnSync(build(t), ['--cursor-menu-dump'], { input: frames.map(f => JSON.stringify(f)).join('\n') + '\n', encoding: 'utf8', timeout: 30000,
    env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_THUMBS_ROOT: join(root, 'thumbs'), ...more } });
  return { ...output, records: output.stdout.trim().split('\n').filter(Boolean).map(JSON.parse) };
}
const catalog = rows => ({ hand: 'picker', nonce, op: 'catalog', rows });
const thumbnail = (fixture, key = 'b'.repeat(64)) => ({ hand: 'picker', nonce, op: 'thumbnail', key,
  frame: { hand: 'character', nonce, seq: 0, id: fixture.id, sheet: fixture.sheet, extra: null, cell: [128, 128], table: {
    idle: { sheet: 'sheet', row: 0, frames: [0], ms: [100], loop: false, flip: false, hotspot: [64, 64], size: [1024, 128], scale: 1 },
  } } });
test('menu dump prints model rows and checks fresh hardware input and AX refusal without building an application', options, t => {
  const rows = cursorMenuModel({ installed: [{ id: 'cat', name: 'Cat' }], found: [{ id: 'dog', name: 'Dog', key: 'c'.repeat(64) }], style: 'sprite', character: 'cat' });
  const r = run(t, [catalog(rows), { hand: 'picker', nonce, op: 'input-check' }]);
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.records[0].rows, rows);
  assert.deepEqual(r.records[1], { hardware: true, synthetic: false, keyboard: true, return: true, enter: true, otherKey: false,
    unhighlighted: false, old: false, future: false, mouseDown: false, wrongWindow: false, ax: false, axMethodsRefused: true, absent: false });
});
test('thumbnail misses decode in sandbox, make a 32px PNG and hit the private cache', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const frames = [thumbnail(fixture), thumbnail(fixture)];
  const r = run(t, frames, { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.records.map(r => [r.loaded, r.cached]), [[true, false], [true, true]]);
  const path = r.records[0].path, bytes = fs.readFileSync(path), st = fs.lstatSync(path);
  assert.equal(bytes.readUInt32BE(16), 32); assert.equal(bytes.readUInt32BE(20), 32);
  assert.equal(st.mode & 0o777, 0o600); assert.equal(st.nlink, 1); assert.ok(st.size < 65536);
  t.diagnostic(`thumbnailBytes=${st.size}`);
});
test('thumbnail cache repairs an owned wrong-mode entry and refuses links, linked root and changed source', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const env = { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root }, key = 'c'.repeat(64), request = thumbnail(fixture, key);
  const good = run(t, [request], env); assert.equal(good.records[0].loaded, true, good.stderr);
  const path = good.records[0].path; fs.chmodSync(path, 0o644);
  assert.equal(run(t, [request], env).records[0].loaded, true, 'owned wrong-mode entry is regenerated once');
  fs.chmodSync(path, 0o600); fs.linkSync(path, join(root, 'linked.png'));
  assert.equal(run(t, [request], env).records[0].loaded, false);
  fs.unlinkSync(join(root, 'linked.png')); fs.unlinkSync(path); fs.symlinkSync(fixture.sheet, path);
  assert.equal(run(t, [request], env).records[0].loaded, false);
  const alias = join(root, 'thumbs-alias'); fs.symlinkSync(join(root, 'thumbs'), alias);
  assert.equal(run(t, [thumbnail(fixture, 'd'.repeat(64))], { ...env, SLEIGHT_CURSOR_THUMBS_ROOT: alias }).records[0].loaded, false);
  fs.chmodSync(fixture.sheet, 0o644);
  assert.equal(run(t, [thumbnail(fixture, 'e'.repeat(64))], env).records[0].loaded, false);
});
test('menu parser rejects forged rows, unknown keys and bad nonce without UI', options, t => {
  for (const f of [catalog([{ title: 'Bad', op: 'select', style: 'evil' }]), { ...catalog([]), extra: true }, { ...catalog([]), nonce: 'bad' }]) {
    assert.equal(run(t, [f]).status, 65);
  }
});
test('native thumbnail update preserves both menu rows, selection and placement; AX routes show the fixed notice', options, t => {
  const r = run(t, [{ hand: 'picker', nonce, op: 'menu-check' }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.records[0], { sameItems: true, onlyCatChanged: true, separator: true, aboveHelp: true, axRefused: true,
    notices: ['Choose with the mouse or keyboard', 'Choose with the mouse or keyboard'] });
});
test('thumbnail child failure publishes no PNG, unsafe directories refuse, and oversized owned entries regenerate', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const env = { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root }, request = thumbnail(fixture, 'f'.repeat(64));
  const failed = run(t, [request], { ...env, SLEIGHT_CURSOR_DECODE_FAULT: 'die' });
  assert.equal(failed.records[0].loaded, false);
  assert.equal(fs.existsSync(join(root, 'thumbs', 'f'.repeat(64) + '.png')), false);
  fs.chmodSync(join(root, 'thumbs'), 0o777);
  assert.equal(run(t, [request], env).records[0].loaded, false);
  fs.chmodSync(join(root, 'thumbs'), 0o700);
  const good = run(t, [request], env); assert.equal(good.records[0].loaded, true);
  fs.writeFileSync(good.records[0].path, Buffer.alloc(65537));
  assert.equal(run(t, [request], env).records[0].loaded, true, 'oversized owned entry is regenerated once');
});
test('thumbnail cache sweeps only stale safe staging files after ten minutes', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const bank = join(root, 'sweep-thumbs'); fs.mkdirSync(bank, { mode: 0o700 });
  const env = { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root, SLEIGHT_CURSOR_THUMBS_ROOT: bank };
  const old = new Date(Date.now() - 601000);
  for (const name of ['.thumb-stale', '.thumb-fresh', '.thumb-wrong-mode', 'unrelated']) {
    fs.writeFileSync(join(bank, name), 'fixture', { mode: name === '.thumb-wrong-mode' ? 0o644 : 0o600 });
    if (name !== '.thumb-fresh') fs.utimesSync(join(bank, name), old, old);
  }
  fs.symlinkSync(join(bank, 'unrelated'), join(bank, '.thumb-link'));
  assert.equal(run(t, [thumbnail(fixture)], env).records[0].loaded, true);
  assert.equal(fs.existsSync(join(bank, '.thumb-stale')), false);
  for (const name of ['.thumb-fresh', '.thumb-wrong-mode', 'unrelated', '.thumb-link']) assert.ok(fs.lstatSync(join(bank, name)));
});
test('a crashed publication with two internal links is regenerated, but an outside hardlink is refused', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const bank = join(root, 'repair-thumbs'), env = { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root, SLEIGHT_CURSOR_THUMBS_ROOT: bank };
  const request = thumbnail(fixture), good = run(t, [request], env).records[0];
  assert.equal(good.loaded, true);
  const staging = join(bank, '.thumb-crashed'); fs.linkSync(good.path, staging);
  const repaired = run(t, [request], env).records[0];
  assert.deepEqual([repaired.loaded, repaired.cached], [true, false]);
  assert.equal(fs.lstatSync(good.path).nlink, 1); assert.equal(fs.existsSync(staging), false);
  fs.linkSync(good.path, join(root, 'outside-repair.png'));
  assert.equal(run(t, [request], env).records[0].loaded, false);
  assert.equal(fs.lstatSync(good.path).nlink, 2);
});
test('publication EEXIST retains the decoded image and leaves one published link', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const bank = join(root, 'race-thumbs'), env = { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root,
    SLEIGHT_CURSOR_THUMBS_ROOT: bank, SLEIGHT_CURSOR_THUMB_FAULT: 'eexist' };
  const r = run(t, [thumbnail(fixture)], env).records[0];
  assert.deepEqual([r.loaded, r.cached], [true, false]); assert.equal(fs.lstatSync(r.path).nlink, 1);
  assert.deepEqual(fs.readdirSync(bank), ['b'.repeat(64) + '.png']);
});
test('thumbnail bank keeps at most 64 managed PNGs, evicting the oldest first', options, t => {
  build(t); const fixture = installSyntheticCharacter({ base: root }); trackTemp(fixture.root);
  const bank = join(root, 'cap-thumbs'); fs.mkdirSync(bank, { mode: 0o700 });
  const env = { SLEIGHT_CURSOR_CHARACTERS_ROOT: fixture.root, SLEIGHT_CURSOR_THUMBS_ROOT: bank };
  for (let i = 0; i < 65; i++) {
    const path = join(bank, i.toString(16).padStart(64, '0') + '.png'), date = new Date(Date.now() - 200000 + i * 1000);
    fs.writeFileSync(path, 'fixture', { mode: 0o600 }); fs.utimesSync(path, date, date);
  }
  const r = run(t, [thumbnail(fixture)], env).records[0]; assert.equal(r.loaded, true);
  assert.equal(fs.readdirSync(bank).length, 64);
  assert.equal(fs.existsSync(join(bank, '0'.repeat(64) + '.png')), false);
  assert.equal(fs.existsSync(join(bank, '0'.repeat(63) + '1.png')), false);
  assert.equal(fs.existsSync(join(bank, '0'.repeat(63) + '2.png')), true);
});
