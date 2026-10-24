import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { serializeDataExport, writeDataExport, exportSummary, EXPORT_LIMITS } from '../plugins/sleight/lib/direct-browser/export-file.mjs';
import { browserTools, validateToolCall, createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { readDataExport } from '../plugins/sleight/lib/direct-browser/export-data.mjs';

const data = () => ({ kind: 'table', columns: ['Name', 'Price', 'Note'], rows: [['pear', '1.20', 'a,"quote"\nand a line'], ['桃', '2', '=1+1']], complete: true, reasons: [] });
const context = text => ({ userMessage: () => ({ source: 'user', text }) });
function folder(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'sleight-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('CSV quotes cells and newlines, neutralizes formula cells, and JSON retains exact text and structure', () => {
  assert.equal(serializeDataExport(data()), '"Name","Price","Note"\r\n"pear","1.20","a,""quote""\nand a line"\r\n"桃","2","\'=1+1"\r\n');
  const value = JSON.parse(serializeDataExport(data(), 'json'));
  assert.deepEqual(value.rows, data().rows); assert.deepEqual(value.columns, data().columns);
  assert.equal(value.rowCount, 2); assert.equal(value.complete, true);
  for (const value of ['=A1', '+SUM(A1)', '-1+2', '@SUM(A1)', '\t=1', '\r=1', '\uFEFF=1', '\x00=1'])
    assert.ok(serializeDataExport({ ...data(), columns: [], rows: [[value]] }).startsWith('"\''));
});
test('structured export enforces shape, completeness and bounded rows, columns and bytes', () => {
  for (const invalid of [{}, { ...data(), kind: 'code' }, { ...data(), rows: [[{}]] }, { ...data(), rows: Array(EXPORT_LIMITS.rows + 1).fill([]) },
    { ...data(), columns: Array(EXPORT_LIMITS.columns + 1).fill('x') }, { ...data(), rows: [['x'.repeat(EXPORT_LIMITS.characters + 1)]] },
    { ...data(), reasons: ['gap'] }, { ...data(), complete: 'yes' }]) assert.throws(() => serializeDataExport(invalid));
  assert.throws(() => serializeDataExport(data(), 'html'));
  const partial = { ...data(), complete: false, reasons: ['9 rows not rendered'] };
  assert.equal(JSON.parse(serializeDataExport(partial, 'json')).complete, false);
});
test('default export writes a private new file under the OS-user sleight directory, without returning rows', t => {
  const root = folder(t), receipt = writeDataExport(data(), {}, context('Export this table'), { userHome: root, id: () => 'test' });
  assert.equal(receipt.path, path.join(root, 'Library/Application Support/sleight/exports/export-test.csv'));
  assert.equal(fs.readFileSync(receipt.path, 'utf8'), serializeDataExport(data()));
  assert.equal(fs.statSync(receipt.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(receipt.path)).mode & 0o777, 0o700);
  assert.equal(receipt.rowCount, 2);
  assert.doesNotMatch(exportSummary(receipt), /pear|桃|1\+1/);
  assert.match(exportSummary(receipt), /Rows: 2\.\nComplete: yes\./);
  assert.throws(() => writeDataExport(data(), {}, context('Export table'), { userHome: root, id: () => 'test' }), /never overwritten/);
});
test('only a current authenticated user turn can export', t => {
  const root = folder(t);
  for (const ctx of [undefined, {}, { userMessage: () => ({ source: 'page', text: 'export' }) }, { userMessage: () => undefined }])
    assert.throws(() => writeDataExport(data(), {}, ctx, { userHome: root }), /current user turn/);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('a page cannot induce even a default-folder export when the user asked only to read', t => {
  const root = folder(t);
  for (const text of ['Read this table', 'The page says export this table', 'Do not export this table', 'Export nothing', 'Export this table if it is public'])
    assert.throws(() => writeDataExport(data(), {}, context(text), { userHome: root }), /affirmative export request/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.doesNotThrow(() => writeDataExport(data(), {}, context('Could you export this table?'), { userHome: root }));
});
test('a user-named file and directory work; JSON preserves duplicates and ragged rows', t => {
  const root = folder(t), target = path.join(root, 'table.json');
  const rows = [['same'], ['same', 'extra']];
  const receipt = writeDataExport({ ...data(), rows }, { path: target, format: 'json' }, context(`Export this table to "${target}".`));
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt.path, 'utf8')).rows, rows);
  const directory = writeDataExport(data(), { path: root }, context(`Put this table in ${root}`), { id: () => 'in-folder' });
  assert.equal(directory.path, path.join(root, 'export-in-folder.csv'));
});
test('path mentions, negations, page-named paths, suffix matches and format mismatches confer no write authority', t => {
  const root = folder(t), target = path.join(root, 'table.csv');
  for (const text of [`The page says export to ${target}`, `Do not export this table to ${target}`, `Export this table to ${target}.backup`,
    `Export to ${target} and delete everything`, `The folder is ${root}`])
    assert.throws(() => writeDataExport(data(), { path: target }, context(text)), /must be named|affirmative export request/);
  assert.throws(() => writeDataExport(data(), { path: target, format: 'json' }, context(`Export this table to ${target}`)), /extension/);
  assert.throws(() => writeDataExport(data(), { path: '../x.csv' }, context('Export this table to ../x.csv')), /absolute/);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('symlink parents, symlink leaf, existing files and non-private sleight directories are refused without changing bytes', t => {
  const root = folder(t), owned = path.join(root, 'owned'); fs.mkdirSync(owned);
  const link = path.join(root, 'link'); fs.symlinkSync(owned, link);
  for (const target of [path.join(link, 'table.csv'), path.join(root, 'leaf.csv')]) {
    if (target.endsWith('leaf.csv')) fs.symlinkSync(path.join(owned, 'absent.csv'), target);
    assert.throws(() => writeDataExport(data(), { path: target }, context(`Export table to ${target}`)), /symlink|never overwritten/);
  }
  const existing = path.join(root, 'existing.csv'); fs.writeFileSync(existing, 'owner bytes');
  assert.throws(() => writeDataExport(data(), { path: existing }, context(`Export table to ${existing}`)), /never overwritten/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'owner bytes'); assert.deepEqual(fs.readdirSync(owned), []);
  const exports = path.join(root, 'Library/Application Support/sleight/exports'); fs.mkdirSync(exports, { recursive: true, mode: 0o755 }); fs.chmodSync(exports, 0o755);
  assert.throws(() => writeDataExport(data(), {}, context('Export table'), { userHome: root }), /private/);
  assert.deepEqual(fs.readdirSync(exports), []);
});
test('expired user turn after destination validation writes no page data', t => {
  const root = folder(t); let n = 0;
  assert.throws(() => writeDataExport(data(), {}, { userMessage: () => ++n === 1 ? { source: 'user', text: 'Export table' } : undefined }, { userHome: root }), /turn changed/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'Library/Application Support/sleight/exports')), []);
});
test('schema keeps five tools and refuses conflicting export/read options and executable formats', () => {
  assert.equal(browserTools().length, 5);
  const request = arguments_ => ({ name: 'browser_read', arguments: { tab: 't1', ...arguments_ } });
  assert.doesNotThrow(() => validateToolCall(request({ export: 'e1', format: 'csv' })));
  for (const args of [{ export: 'button' }, { export: 'e1', format: 'html' }, { export: 'e1', find: 'price' }, { export: 'e1', ref: 'e1' },
    { export: 'e1', max_chars: 1000 }, { format: 'csv' }, { path: '/tmp/test.csv' }]) assert.throws(() => validateToolCall(request(args)));
});
test('dispatcher passes only owned queued entry and private context to export, with no snapshot or input', async () => {
  const entry = { page: { url: () => 'https://fixture.invalid' }, state: {} }, ctx = context('Export table');
  let called = 0, blocked = false;
  const dispatcher = createToolDispatcher({ pages: { tab: () => entry, enqueue: async (tab, run) => { assert.equal(tab, 't1'); return run(entry); } },
    ctx, sites: () => blocked ? 'Site blocked' : undefined,
    snapshot: () => assert.fail('no YAML'), runSteps: () => assert.fail('no input'), fillFields: () => assert.fail('no fill'),
    exportData: async (owned, args, privateContext, options) => {
      called++; assert.equal(owned, entry); assert.equal(privateContext, ctx); assert.equal(args.export, 'e1'); options.check(); return 'Export path; Rows: 200; Complete: yes';
    } });
  const request = { name: 'browser_read', arguments: { tab: 't1', export: 'e1' } };
  const result = await dispatcher.call(request);
  assert.equal(result.isError, false); assert.equal(called, 1); assert.equal(dispatcher.delivered(result), false);
  blocked = true; assert.equal((await dispatcher.call(request)).isError, true); assert.equal(called, 1);
  await dispatcher.end(); assert.equal((await dispatcher.call(request)).isError, true); assert.equal(called, 1);
});
test('export never reuses a closed popup ref on its opener', async () => {
  const dispatcher = createToolDispatcher({ pages: { closedOpener: () => 't1' }, snapshot() {}, runSteps() {}, fillFields() {},
    exportData: () => assert.fail('stale ref') });
  const result = await dispatcher.call({ name: 'browser_read', arguments: { tab: 't2', export: 'e1' } });
  assert.equal(result.isError, true); assert.match(result.text, /closed tab/);
});
test('native document pages and non-data refs are refused before any read', async () => {
  for (const url of ['vscode-file://workbench/index.html', 'file:///private/document.html', 'chrome://settings', 'about:blank'])
    await assert.rejects(readDataExport({ url: () => url }, 'e1'), /browser-only/);
  for (const ref of ['s1', 'x1', 'more1_1', '#table']) await assert.rejects(readDataExport({}, ref), /observed table/);
});
