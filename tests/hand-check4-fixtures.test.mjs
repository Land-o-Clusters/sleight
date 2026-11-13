import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { prepareCheck4Replay, fixturePath, recordedCoverage } from '../bench/hand/check4-fixtures.mjs';

test('saved fixture validation launches nothing and refuses path escapes and other apps', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-fixture-')));
  const recording = { task: { id: 'calculator-click' }, kind: 'native', calls: [] };
  let launched = 0;
  const saved = { nonce: '1234abcd', sourceDir: join(tmpdir(), 'old-fixture'), files: {}, windows: [{ app: 'Calculator', mode: 'inherit' }], context: { expectedCalculator: '391' } };
  const prepared = prepareCheck4Replay(recording, dir, saved, { open: () => launched++ });
  assert.equal(prepared.native.ctx.expectedCalculator, '391');
  assert.equal(launched, 0); assert.deepEqual(readdirSync(dir), []);
  assert.throws(() => fixturePath(dir, '../elsewhere'), /relative path/);
  assert.throws(() => prepareCheck4Replay(recording, dir, { ...saved, windows: [{ app: 'Microsoft Word', mode: 'inherit' }] }), /app or mode/);
  assert.throws(() => prepareCheck4Replay(recording, dir, { ...saved, files: { 'run.mjs': '' } }), /txt\/pdf/);
});
test('scroll and cross-window requirements are derived from the recorded calls', () => {
  const calls = [{ name: 'js', arguments: { code: 'await app.scroll({direction:"down"})' } },
    ...Array.from({ length: 9 }, () => ({ name: 'js', arguments: { code: 'await app.getScreenshot()' } })),
    { name: 'drag', arguments: { windowId: 1, toWindowId: 2 } }];
  assert.deepEqual(recordedCoverage({ calls }), { scrollIndex: 0, scrollInFirstFifthByCalls: true, crossWindowDrag: true });
  assert.equal(recordedCoverage({ calls: [] }).scrollInFirstFifthByCalls, false);
});

test('even an allowed task recording cannot acquire Word or Excel', { skip: parserSkip }, () => {
  for (const app of ['Word', 'Microsoft Excel', 'com.microsoft.Word', 'com.microsoft.Excel'])
    assert.throws(() => prepareCheck4Replay({ task: { id: 'textedit-drag' }, kind: 'native', calls: [
      { name: 'js', arguments: { code: `var app = await cua.getApp(${JSON.stringify(app)})` } }] }, '/fixture/new'), /Word and Excel/);
});

test('saved Calculator fixture uses a fresh baseline and refuses an already-open owner app', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-calc-')));
  const recording = { task: { id: 'calculator-click' }, kind: 'native', calls: [] };
  const saved = { nonce: '1234abcd', sourceDir: join(tmpdir(), 'old-fixture'), files: {}, windows: [{ app: 'Calculator', mode: 'inherit' }],
    context: { expectedCalculator: '391', calculatorBefore: 'stale' } };
  const reads = [], pids = [];
  const prepared = prepareCheck4Replay(recording, dir, saved, { open: async () => ({ pid: 42 }), onPid: pid => pids.push(pid),
    run: async (command, args) => { reads.push([command, args]); return command.endsWith('pgrep') ? { groupClean: true, exit: { code: 1 } } :
      { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({ pid: 42, start: 123, value: '0' }) }; } });
  await prepared.native.definition.setup(prepared.native.ctx);
  assert.equal(prepared.native.ctx.calculatorBefore, '0');
  assert.deepEqual(pids, [42]); assert.equal(reads.length, 2);
  let opened = false;
  const refused = prepareCheck4Replay(recording, dir, saved, { open: async () => { opened = true; },
    run: async () => ({ groupClean: true, exit: { code: 0 } }) });
  await assert.rejects(refused.native.definition.setup(refused.native.ctx), /requires Calculator to be closed/);
  assert.equal(opened, false);
});
