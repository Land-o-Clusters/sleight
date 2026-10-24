import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { serializeDataExport, writeDataExport, exportSummary, EXPORT_LIMITS } from '../plugins/sleight/lib/direct-browser/export-file.mjs';
import { browserTools, validateToolCall, createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { readDataExport } from '../plugins/sleight/lib/direct-browser/export-data.mjs';

const data = () => ({ kind: 'table', columns: ['Name', 'Price', 'Note'], rows: [['pear', '1.20', 'a,"quote"\nand a line'], ['桃', '2', '=1+1']], declaredTotal: 2, complete: true, reasons: [] });
const context = text => ({ userMessage: () => ({ source: 'user', text }) });
test('G3E the writer retains an unbound nearby count observation alongside a proved total', () => {
  const result = JSON.parse(serializeDataExport({ ...data(), reasons: ['nearby count label is not tied to the collection'] }, 'json'));
  assert.equal(result.complete, true);
  assert.deepEqual(result.reasons, ['nearby count label is not tied to the collection']);
});
function folder(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'sleight-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('CSV quotes cells and newlines, neutralizes formula cells, and JSON retains exact text and structure', () => {
  assert.equal(serializeDataExport(data(), 'csv', { bom: false }), '"Name","Price","Note"\r\n"pear","1.20","a,""quote""\nand a line"\r\n"桃","2","\'=1+1"\r\n');
  const value = JSON.parse(serializeDataExport(data(), 'json'));
  assert.deepEqual(value.rows, data().rows); assert.deepEqual(value.columns, data().columns);
  assert.equal(value.rowCount, 2); assert.equal(value.complete, true);
  for (const value of ['=A1', '+SUM(A1)', '-1+2', '@SUM(A1)', '\t=1', '\r=1', '\uFEFF=1', '\x00=1'])
    assert.ok(serializeDataExport({ ...data(), columns: [], rows: [[value]] }, 'csv', { bom: false }).startsWith('"\''));
});
test('structured export enforces shape, completeness and bounded rows, columns and bytes', () => {
  for (const invalid of [{}, { ...data(), kind: 'code' }, { ...data(), rows: [[{}]] }, { ...data(), rows: Array(EXPORT_LIMITS.rows + 1).fill([]) },
    { ...data(), columns: Array(EXPORT_LIMITS.columns + 1).fill('x') }, { ...data(), rows: [['x'.repeat(EXPORT_LIMITS.characters + 1)]] },
    ...[-1, NaN, '2', 1.5].map(declaredTotal => ({ ...data(), declaredTotal })), { ...data(), reasons: ['gap'] }, { ...data(), complete: 'yes' }]) assert.throws(() => serializeDataExport(invalid));
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
  assert.match(exportSummary(receipt), /Rows: 2\.\nComplete: yes \(declared total matches rows read\)\./);
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

test('export authorization is scoped to its sentence, including a user-named dotted path', t => {
  const root = folder(t), target = path.join(root, 'prices.v2.csv');
  const receipt = writeDataExport(data(), { path: target }, context(`Export the table to "${target}". Don't include the footer.`));
  assert.equal(receipt.path, target);
  assert.doesNotThrow(() => writeDataExport(data(), {}, context("Export the table. Don't include the footer"), { userHome: root }));
  for (const text of ["Don't export the table. Export the footer", 'Export the table if public. Read the footer', 'If approved. Export the table'])
    assert.throws(() => writeDataExport(data(), {}, context(text), { userHome: root }), /affirmative/);
});
test('user-named hidden and Library destinations refuse before any folder or file is created', t => {
  const root = folder(t);
  for (const suffix of ['.ssh/keys.csv', '.aws/config.csv', '.gnupg/keys.csv', 'Documents/.private/data.csv', '.hidden.csv',
    'Library/LaunchAgents/export.csv', 'Library/LaunchDaemons/export.csv', 'library/Preferences/data.csv',
    'Library/Application Support/sleight/exports/named.csv', 'Library/Mobile Documents/com~apple~CloudDocs/data.csv']) {
    const target = path.join(root, suffix);
    assert.throws(() => writeDataExport(data(), { path: target }, context(`Export table to "${target}"`), { userHome: root }), /hidden|Library|sensitive/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  assert.doesNotThrow(() => writeDataExport(data(), {}, context('Export table'), { userHome: root }));
});
test('existing sensitive folders, tilde paths and Finder-hidden folders refuse', t => {
  const root = folder(t);
  for (const name of ['.ssh', '.aws', '.gnupg', 'Library', 'Library/LaunchAgents', 'Library/LaunchDaemons']) {
    const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
    for (const target of [directory, directory + '/', '~/' + name + '/'])
      assert.throws(() => writeDataExport(data(), { path: target }, context(`Export table to "${target}"`), { userHome: root }), /hidden|Library/);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('export-')), []);
  }
  if (process.platform === 'darwin') {
    const directory = path.join(root, 'FinderHidden'); fs.mkdirSync(directory);
    execFileSync('/usr/bin/chflags', ['hidden', directory]);
    for (const target of [directory, path.join(directory, 'table.csv')])
      assert.throws(() => writeDataExport(data(), { path: target }, context(`Export table to "${target}"`)), /hidden/);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});
test('CSV BOM defaults off, can be enabled, and adds exactly three bytes to a Unicode fixture', t => {
  const root = folder(t), plain = serializeDataExport(data(), 'csv', { bom: false });
  const receipt = writeDataExport(data(), {}, context('Export table'), { userHome: root });
  assert.equal(fs.readFileSync(receipt.path, 'utf8'), plain);
  assert.equal(receipt.bom, false);
  const withBOM = writeDataExport(data(), { bom: true }, context('Export table'), { userHome: root });
  const bytes = fs.readFileSync(withBOM.path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.length, Buffer.byteLength(plain) + 3);
  assert.equal(new TextDecoder('utf-8').decode(bytes), plain);
  assert.ok(plain.includes('桃')); assert.ok(!plain.startsWith('\uFEFF'));
  const without = writeDataExport(data(), { bom: false }, context('Export table'), { userHome: root });
  assert.equal(fs.readFileSync(without.path, 'utf8'), plain);
  assert.ok(!serializeDataExport(data(), 'json').startsWith('\uFEFF'));
  assert.throws(() => serializeDataExport(data(), 'csv', { bom: 'yes' }), /bom/);
  assert.throws(() => validateToolCall({ name: 'browser_read', arguments: { tab: 't1', bom: false } }));
  assert.doesNotThrow(() => validateToolCall({ name: 'browser_read', arguments: { tab: 't1', export: 'e1', bom: false } }));
});
test('complete receipts require a declared total that matches rows read', t => {
  const receipt = writeDataExport(data(), {}, context('Export table'), { userHome: folder(t) });
  assert.match(exportSummary(receipt), /Complete: yes \(declared total matches rows read\)\./);
});
test('ragged rows preserve cells and explain incomplete output through the public writer', t => {
  const value = { ...data(), rows: [['a'], ['b', 'c']] };
  const receipt = writeDataExport(value, { format: 'json' }, context('Export table'), { userHome: folder(t) });
  const output = JSON.parse(fs.readFileSync(receipt.path, 'utf8'));
  assert.deepEqual(output.rows, value.rows); assert.equal(output.complete, false);
  assert.match(output.reasons.join(), /ragged/); assert.match(exportSummary(receipt), /ragged/);
  assert.equal(value.complete, true, 'caller data stays unchanged');
});
test('one turn caps export count across destinations and resets for a new authenticated request', t => {
  assert.ok(Number.isInteger(EXPORT_LIMITS.turnFiles));
  const root = folder(t), ctx = context('Export table');
  for (let i = 0; i < EXPORT_LIMITS.turnFiles; i++) writeDataExport(data(), {}, ctx, { userHome: root });
  assert.throws(() => writeDataExport(data(), {}, ctx, { userHome: root }), /turn.*count/);
  const directory = path.join(root, 'Library/Application Support/sleight/exports');
  assert.equal(fs.readdirSync(directory).length, EXPORT_LIMITS.turnFiles);
  assert.doesNotThrow(() => writeDataExport(data(), {}, context('Export table'), { userHome: root }));
});
test('one turn caps actual UTF-8 bytes and failed destinations do not spend a file slot', t => {
  assert.ok(Number.isInteger(EXPORT_LIMITS.turnBytes));
  const root = folder(t), ctx = context('Export table');
  const large = { ...data(), columns: [], rows: [['桃'.repeat(3900000)]] };
  const size = Buffer.byteLength(serializeDataExport(large));
  let count = 0;
  while ((count + 1) * size <= EXPORT_LIMITS.turnBytes && count < EXPORT_LIMITS.turnFiles) {
    writeDataExport(large, {}, ctx, { userHome: root }); count++;
  }
  assert.ok(count > 0 && count < EXPORT_LIMITS.turnFiles);
  assert.throws(() => writeDataExport(large, {}, ctx, { userHome: root }), /turn.*byte/);
  const fresh = context('Export table');
  writeDataExport(data(), {}, context('Export table'), { userHome: root, id: () => 'occupied' });
  for (let i = 0; i < EXPORT_LIMITS.turnFiles + 1; i++)
    assert.throws(() => writeDataExport(data(), {}, fresh, { userHome: root, id: () => 'occupied' }));
  assert.doesNotThrow(() => writeDataExport(data(), {}, fresh, { userHome: root }));
});
test('budget reservations survive a post-open turn expiry, and a new turn resets the same provider', t => {
  const root = folder(t); let reads = 0, expire = false, turn = 'one';
  const message = () => ({ source: 'user', session: 'fixture', turn, id: 'request', text: 'Export table' });
  const ctx = { userMessage: () => expire && ++reads === 3 ? undefined : message() };
  for (let i = 0; i < EXPORT_LIMITS.turnFiles; i++) {
    reads = 0; expire = true;
    assert.throws(() => writeDataExport(data(), {}, ctx, { userHome: root }), /new file retained/);
  }
  expire = false;
  assert.throws(() => writeDataExport(data(), {}, ctx, { userHome: root }), /turn.*count/);
  const directory = path.join(root, 'Library/Application Support/sleight/exports');
  assert.ok(fs.readdirSync(directory).every(file => fs.statSync(path.join(directory, file)).size === 0));
  turn = 'two';
  assert.doesNotThrow(() => writeDataExport(data(), {}, ctx, { userHome: root }));
});

test('G3C saving a date or writing prose is not a request to export page data', t => {
  const root = folder(t);
  for (const text of ['Save the date', 'Write a poem', 'Put this aside', 'Make a cabinet'])
    assert.throws(() => writeDataExport(data(), {}, context(text), { userHome: root }), /affirmative export request/);
  assert.deepEqual(fs.readdirSync(root), []);
  for (const text of ['Save the table', 'Write the rows as CSV', 'Put the list in a file', 'Create a JSON file'])
    assert.doesNotThrow(() => writeDataExport(data(), {}, context(text), { userHome: root }));
});

test('G3D writer cannot claim completeness without a matching declared row total', t => {
  const root = folder(t);
  for (const [declaredTotal, complete, summary] of [[undefined, false, /unknown \(rendered rows only\)/], [2, true, /yes/],
    [243, false, /no \(243 declared, 2 read\)/], [1, false, /unknown \(rendered rows only\)/]]) {
    const value = { ...data(), declaredTotal };
    const receipt = writeDataExport(value, { format: 'json' }, context('Export table'), { userHome: root });
    assert.equal(receipt.complete, complete); assert.match(exportSummary(receipt), summary);
    const saved = JSON.parse(fs.readFileSync(receipt.path, 'utf8'));
    assert.equal(saved.complete, complete); assert.equal(saved.declaredTotal, declaredTotal);
  }
});
