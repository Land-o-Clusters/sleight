import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import * as production from '../bench/windows/notepad-state.mjs';

const url = new URL('../bench/windows/notepad-state.mjs', import.meta.url);
const source = readFileSync(url, 'utf8');
const name = '7f8f1320-1225-4ddd-be91-5f3c18b0f111';
const path = 'C:\\sleight-setup\\uc3f-354a937340cd4573\\driver-notepad.txt';
function saved(path) {
  assert.ok(path.length < 128);
  return Buffer.concat([Buffer.from([0x4e, 0x50, 0, 1, path.length]), Buffer.from(path, 'utf16le'), Buffer.from('PRIVATE DOCUMENT CONTENT')]);
}
function bank(t, paths = [path]) {
  const local = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st4-notepad-')));
  t.after(() => removeTemp(local));
  mkdirSync(join(local, 'TabState'));
  paths.forEach((p, i) => writeFileSync(join(local, 'TabState', `${i ? 'e578ab3c-3f54-4d0e-bc86-678cb1bf2a35' : name}.bin`), saved(p)));
  writeFileSync(join(local, 'TabState', name + '.0.bin'), 'opaque journal');
  writeFileSync(join(local, 'TabState', name + '.1.bin'), '');
  return local;
}
const options = { assertIdle: async () => {}, now: () => new Date('2026-11-03T01:20:00Z') };
const foreign = e => e.code === 'NOTEPAD_FOREIGN_TABS';

test('saved NP metadata reads end at the path, before the document payload', () => {
  const bytes = saved(path); let offset = 0;
  assert.equal(production.readNotepadPath(n => { const b = bytes.subarray(offset, offset + n); offset += n; return b; }), path);
  assert.equal(offset, 5 + path.length * 2);
  for (const bytes of [Buffer.from([]), Buffer.from([0x4e, 0x50, 0, 0]), saved(path).subarray(0, 15)]) {
    let at = 0;
    assert.throws(() => production.readNotepadPath(n => { const b = bytes.subarray(at, at + n); at += n; return b; }), foreign);
  }
});
test('only canonical harness-bank file paths count as owned', () => {
  assert.equal(production.harnessTabPath(path), true);
  for (const p of ['C:\\Users\\Sleight\\notes.txt', path + ':stream', path.replace('driver-notepad.txt', '..\\foreign.txt'),
    path.replace('sleight-setup', 'sleight-setup-other'), path + '.', path + ' ', '\\\\?\\' + path,
    ...['NUL', 'CON.txt', 'CON .txt', 'COM1', 'LPT2.log', 'CONOUT$'].map(name => path.replace('driver-notepad.txt', name))])
    assert.equal(production.harnessTabPath(p), false, p);
});
test('all harness tabs and their journals are preserved by one rename, with receipts', async t => {
  const local = bank(t, [path, path.replace('driver-notepad', 'other-harness')]), audits = []; let checks = 0;
  const result = await production.preserveNotepadState(local, { ...options, assertIdle: async () => { checks++; }, audit: r => audits.push(r) });
  assert.equal(checks, 2); assert.equal(result.tabs.length, 2); assert.equal(result.moved, true);
  assert.equal(existsSync(join(local, 'TabState')), false);
  assert.equal(readdirSync(result.to).length, 4);
  assert.equal(audits.at(-1).moved, true);
  assert.equal(JSON.stringify(audits).includes('PRIVATE DOCUMENT CONTENT'), false);
});
test('one foreign tab refuses without renaming or editing any state file', async t => {
  const local = bank(t, [path, 'C:\\Users\\Sleight\\owner.txt']), audits = [];
  const before = readdirSync(join(local, 'TabState')).map(n => [n, readFileSync(join(local, 'TabState', n))]);
  await assert.rejects(production.preserveNotepadState(local, { ...options, audit: r => audits.push(r) }), foreign);
  assert.equal(readdirSync(local).length, 1);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(local, 'TabState', name)), bytes);
  assert.ok(audits.some(r => r.tab?.filePath === 'C:\\Users\\Sleight\\owner.txt'));
});
test('Notepad running or reappearing, a symlink, an orphan journal and a concurrent change all refuse', async t => {
  for (const mode of ['running', 'reappearing', 'symlink', 'orphan', 'changed']) {
    const local = bank(t); let checks = 0;
    if (mode === 'symlink') symlinkSync(join(local, 'TabState', name + '.bin'), join(local, 'TabState', 'linked.bin'));
    if (mode === 'orphan') writeFileSync(join(local, 'TabState', 'e578ab3c-3f54-4d0e-bc86-678cb1bf2a35.0.bin'), 'journal');
    await assert.rejects(production.preserveNotepadState(local, { ...options, assertIdle: async () => {
      checks++;
      if (mode === 'running' || mode === 'reappearing' && checks === 2) throw Object.assign(Error('FIXTURE_ALREADY_RUNNING'), { code: 'FIXTURE_ALREADY_RUNNING' });
      if (mode === 'changed' && checks === 2) writeFileSync(join(local, 'TabState', name + '.bin'), saved('C:\\foreign.txt'));
    } }));
    assert.equal(existsSync(join(local, 'TabState')), true, mode);
  }
});
test('broken ownership, all-tabs, idle, metadata and rename variants fail the contract', async t => {
  const variants = [
    ['foreign', 'if (!harnessTabPath(filePath)) refuse();', ''],
    ['all-tabs', 'for (const name of entries)', "for (const name of entries.filter(n => !n.startsWith('e578')))"],
    ['idle', 'await assertIdle();', ''],
    ['signature', 'one() !== 0x4e', 'one() !== 0'],
    ['rename', 'move(folder, destination);', ''],
    ['orphan', 'if (!entries.some(n => n.toLowerCase() === `${side[1]}.bin`.toLowerCase())) refuse();', ''],
    ['device', source.split('\n').find(line => line.includes('conin')).trim(), 'true;'],
  ];
  for (const [kind, before, after] of variants) {
    assert.ok(source.includes(before), kind);
    const changed = source.replace(before, after);
    const mod = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
    const local = bank(t, [path, 'C:\\Users\\Sleight\\owner.txt']);
    const verify = async () => {
      if (kind === 'foreign' || kind === 'all-tabs') await assert.rejects(mod.preserveNotepadState(local, options), foreign);
      if (kind === 'idle') { let reads = 0; await mod.preserveNotepadState(bank(t), { ...options, assertIdle: async () => { reads++; } }); assert.equal(reads, 2); }
      if (kind === 'signature') { const b = saved(path); b[0] = 0; let at = 0; assert.throws(() => mod.readNotepadPath(n => { const r = b.subarray(at, at + n); at += n; return r; })); }
      if (kind === 'rename') { const root = bank(t); await mod.preserveNotepadState(root, options); assert.equal(existsSync(join(root, 'TabState')), false); }
      if (kind === 'orphan') { const root = bank(t); writeFileSync(join(root, 'TabState', 'e578ab3c-3f54-4d0e-bc86-678cb1bf2a35.0.bin'), 'x'); await assert.rejects(mod.preserveNotepadState(root, options)); }
      if (kind === 'device') assert.equal(mod.harnessTabPath(path.replace('driver-notepad.txt', 'NUL')), false);
    };
    await assert.rejects(verify(), assert.AssertionError, kind);
  }
});

test('collector checks Notepad before launch and preserves launch and binding metadata', () => {
  const source = readFileSync(new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url), 'utf8');
  const audit = s => {
    assert.ok(s.includes('notepadPreflight = preflightNotepad'));
    assert.ok(s.includes('await notepadPreflight({ call: psCall, check,'));
    assert.ok(s.includes("Get-Process -Name Notepad"));
    assert.ok(s.indexOf('await notepadPreflight(') < s.indexOf("proof = await recordSetup(() => psCall('launch'"));
    assert.ok(s.indexOf('`launch-${target}.json`') > 0);
    assert.ok(s.indexOf('`launch-${target}.json`') < s.indexOf('const receipt = proveFixtureLaunch(proof'));
    assert.ok(s.includes('binding-${target}-${++bindingAttempt}.json'));
    assert.ok(s.includes('w.pid === proof.launcher.pid || proof.windows?.some(p => p.pid === w.pid)'));
  };
  audit(source);
  for (const needle of ['notepadPreflight = preflightNotepad', 'await notepadPreflight({ call: psCall, check,', 'Get-Process -Name Notepad',
    '`launch-${target}.json`', 'binding-${target}-${++bindingAttempt}.json', 'w.pid === proof.launcher.pid || proof.windows?.some(p => p.pid === w.pid)'])
    assert.throws(() => audit(source.replaceAll(needle, 'REMOVED')), assert.AssertionError, needle);
});
