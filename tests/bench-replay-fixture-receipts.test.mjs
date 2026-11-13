import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePlan, prepareReplay, withNative } from '../bench/replay/fixtures.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const dir = '/fixture/sleight-bench/stamp/task';
const receipt = (title, windowNumber) => ({ target: { appId: 'com.apple.TextEdit', title, url: `file://${dir}/${title}` },
  identity: { pid: 42, windowNumber } });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const selection = (title, id) => ({ server: 'plugin:sleight:computer', name: 'select_window', arguments: { app: 'TextEdit', title },
  result: text(receipt(title, id)) });
const recording = () => ({ kind: 'native', task: { id: 'textedit-window-drag' }, metadata: { suite: 'world' },
  calls: [selection('Source-1234abcd.txt', 7), selection('Target-1234abcd.txt', 8)] });

test('title-only recordings discover their fixture directory from native selection receipts', () => {
  const plan = nativePlan(recording(), '/fixture/replay');
  assert.equal(plan.oldDir, dir);
  assert.equal(plan.ctx.nonce, '1234abcd');
  assert.equal(plan.suite, 'world');
});

test('JavaScript output, failed selections and other app receipts cannot supply a fixture path', () => {
  for (const change of [c => { c.name = 'js'; }, c => { c.server = 'sleight-turbo'; }, c => { c.result.isError = true; },
    c => { const row = JSON.parse(c.result.content[0].text); row.target.appId = 'other.app'; c.result = text(row); }]) {
    const data = recording(); data.calls.forEach(change);
    assert.throws(() => nativePlan(data, '/fixture/replay'), /exactly one owned fixture directory/);
  }
});

test('receipt titles, local file URLs and canonical fixture paths must agree', () => {
  for (const url of [`https://example.test${dir}/Source-1234abcd.txt`, `file://remote${dir}/Source-1234abcd.txt`,
    `file://${dir}/Other-1234abcd.txt`, `file://${dir}/Source-1234abcd.txt?query=1`,
    `file://${dir}/Source-1234abcd.txt#fragment`, 'file:///owner/Source-1234abcd.txt']) {
    const data = recording(); data.calls = [data.calls[0]];
    const row = receipt('Source-1234abcd.txt', 7); row.target.url = url; data.calls[0].result = text(row);
    assert.throws(() => nativePlan(data, '/fixture/replay'), /exactly one owned fixture directory/);
  }
});

test('two receipt fixture directories or nonces remain ambiguous', () => {
  for (const change of [row => { row.target.url = row.target.url.replace('/stamp/', '/other/'); },
    row => { row.target.title = 'Target-5678abcd.txt'; row.target.url = `file://${dir}/${row.target.title}`; }]) {
    const data = recording(), row = receipt('Target-1234abcd.txt', 8); change(row); data.calls[1].result = text(row);
    assert.throws(() => nativePlan(data, '/fixture/replay'), /exactly one owned fixture directory|nonce is ambiguous/);
  }
});

test('frame recordings keep replay files inside the private bank and the native observer fixture namespace', () => {
  const data = recording();
  for (const call of data.calls) {
    const row = JSON.parse(call.result.content[0].text);
    row.frame = { x: 16, y: 49, width: 720, height: 560 };
    call.result = text(row);
  }
  const bank = join(tmpdir(), 'replay-campaign/1-A/fixture'), prepared = prepareReplay(data, bank);
  assert.ok(prepared.native.ctx.dir.startsWith(bank + '/'));
  assert.ok(prepared.native.ctx.dir.includes('/sleight-bench/'));
  assert.equal(prepared.mapper.arguments({ path: `${dir}/Source-1234abcd.txt` }).path, `${prepared.native.ctx.dir}/Source-1234abcd.txt`);
});

for (const isError of [undefined, true]) test(`fixture grading ${isError ? 'rejects a failed' : 'recognizes a successful'} local drag with an omitted success flag`, { skip: parserSkip }, async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-replay-method-'))), ctx = { dir };
  const definition = { setup() {}, prompt: () => 'fixture', cleanup() {},
    capture(c, result) { c.audit = result.methodAudit; },
    check: c => c.audit?.complete === true && c.audit.drag === true && c.audit.replacement === false };
  const result = await withNative({ task: { id: 'textedit-window-drag' }, metadata: { suite: 'world' } }, {
    dir, prepared: { native: { definition, ctx } }, beforeCall: async () => {}, permissionCheck: async () => false,
    drive: async () => ({ verdict: 'pass', calls: [{ id: 'drag', server: 'plugin:sleight:computer', name: 'drag', arguments: { app: 'TextEdit' },
      result: { ...text('moved'), ...(isError ? { isError } : {}) } }] }),
  });
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.lifecycle.taskPassed, !isError);
});
