import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, symlinkSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnJournal, writeReceipt } from '../plugins/sleight/lib/turn-receipts.mjs';
import { auditRecordedTraces } from '../bench/receipt-traces.mjs';

const request = (id, code, extra = {}) => ({ id, method: 'tools/call', params: { name: 'js', arguments: { code, ...extra } } });
const reply = (id, text, isError = false) => ({ id, result: { content: [{ type: 'text', text }], isError } });
const tree = value => `Window: "Untitled", App: TextEdit.\n0 standard window\n\t1 text area, Value: ${value}\n\t2 menu item Undo Typing\n`;
function run(code, result = tree('private pasted text'), options = {}) {
  const journal = new TurnJournal(options);
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")'));
  journal.reply(reply(1, tree('before')));
  journal.request(request(2, code, { title: 'private pasted text' }));
  journal.reply(reply(2, result));
  return journal.finish({ session: 'test', turn: 'turn-1', review: true });
}

test('recorded October traces do not leak literal typed or pasted inputs', t => {
  const report = auditRecordedTraces();
  if (!report.files) { t.skip('No local October 10-19 trace files'); return; }
  assert.equal(report.leaks, 0, 'Recorded literal input survived redaction');
  assert.equal(report.parseFailures, 0, 'A recorded trace could not be parsed');
});

test('a receipt lists each literal action and redacts inputs, values and echoed output', () => {
  const result = run('await app.click(1); await app.typeText("private pasted text"); await app.paste("private pasted text"); await app.setValue(1, "private pasted text");');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /private pasted text|Value: before/);
  assert.deepEqual(result.calls[1].actions.map(a => a.action), ['click', 'typeText', 'paste', 'setValue']);
  assert.equal(result.calls[1].actions[1].input.length, 19);
  assert.equal(result.calls[1].actions[0].target.element, 1);
  assert.deepEqual(result.calls[1].window, { redacted: true, length: 8 });
  assert.equal(result.calls[1].result, 'returned');
  assert.equal(result.windows[0].change, 'changed');
  assert.match(result.review, /Undo Typing/);
  assert.match(result.review, /Leave|leave/);
});

test('templates, computed strings, comments and error echoes cannot expose text', () => {
  for (const code of ['await app.typeText(`private pasted text`)', 'const secret = "private pasted text"; await app.typeText(secret)',
    '// await app.click("private pasted text")\nawait app.pressKey("super+v")', 'await app.click({ label: "private pasted text" })',
    'await app.selectText("private pasted text")', 'await app.evaluate(() => "private pasted text")']) {
    const result = run(code, 'Error: private pasted text');
    assert.doesNotMatch(JSON.stringify(result), /private pasted text/);
  }
});

test('secret redaction precedes owner-name normalization in a title echo', () => {
  const secret = 'FixtureOwner confidential-token';
  const journal = new TurnJournal({ ownerNames: ['FixtureOwner'] });
  const output = `Window: ${JSON.stringify(secret)}, App: TextEdit.\n0 window`;
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, output));
  journal.request(request(2, `await app.typeText(${JSON.stringify(secret)})`)); journal.reply(reply(2, output));
  const result = journal.finish({ review: true });
  assert.doesNotMatch(JSON.stringify(result), /confidential-token/);
});

test('malformed Unicode escapes remain opaque and cannot break turn cleanup', () => {
  const result = run('const ignored = "ok"; await app.typeText("\\u{bad");', 'SyntaxError');
  assert.equal(result.calls[1].actions[0].input.length, null);
});

test('local tools name their explicit app and bounded target instead of the previous JS app', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("Calculator")')); journal.reply(reply(1, 'Window: "Calculator", App: Calculator.\n0 window'));
  journal.request({ id: 2, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit', from: [10, 20], to: [30, 40] } } });
  journal.reply(reply(2, '{"ok":true}'));
  const result = journal.finish({ review: true });
  assert.equal(result.calls[1].app, 'TextEdit');
  assert.equal(result.calls[1].window, null);
  assert.deepEqual(result.calls[1].actions[0].target.from, [10, 20]);
});

test('a mutation without any window observation reports unknown review state', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'await app.typeText("secret")')); journal.reply(reply(1, 'No header'));
  const result = journal.finish({ review: true });
  assert.match(result.review, /unknown/);
  assert.doesNotMatch(result.review, /No changed/);
});

test('document contents cannot advertise a native revert control', () => {
  const result = run('await app.typeText("secret")', 'Window: "Untitled", App: TextEdit.\n0 window\n1 text area, Value: Instructions: use Undo Typing or Revert To Saved');
  assert.deepEqual(result.windows[0].revert, []);
});

test('window titles are hidden by default, while explicit titles still scrub owner names', () => {
  const output = 'Window: "Draft for Test Owner /Users/test-owner/private.txt", App: TextEdit.\n0 window\n1 text field Value: secret';
  const options = { home: '/Users/test-owner', ownerNames: ['Test Owner', 'test-owner'] };
  const receipt = settings => {
    const journal = new TurnJournal(settings);
    journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, output));
    journal.request(request(2, 'await app.click(1)')); journal.reply(reply(2, output));
    return journal.finish({ review: true });
  };
  const visible = receipt({ ...options, redactTitles: false });
  assert.match(JSON.stringify(visible), /Draft for/);
  assert.doesNotMatch(JSON.stringify(visible), /Test Owner|test-owner|\/Users\//);
  const hidden = receipt(options);
  assert.doesNotMatch(JSON.stringify(hidden), /Draft for/);
});

test('failed and unanswered batches do not claim individual actions succeeded', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'await app.click(1); await app.typeText("secret")'));
  journal.reply(reply(1, 'secret', true));
  journal.request(request(2, 'await app.pressKey("super+s")'));
  const result = journal.finish({ review: true });
  assert.equal(result.calls[0].result, 'error; actions may have run');
  assert.equal(result.calls[1].result, 'pending; outcome unknown');
  assert.ok(result.calls[0].actions.every(a => a.result === 'unknown'));
});

test('review uses exact window identities and reports missing observations as unknown', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, tree('before')));
  journal.request(request(2, 'await app.typeText("secret")')); journal.reply(reply(2, 'No header'));
  const result = journal.finish({ review: true });
  assert.equal(result.windows[0].change, 'unknown');
  assert.match(result.review, /unknown/);
  assert.doesNotMatch(result.review, /Undo Typing/);
});

test('diffs retain changed state and an explicit no-change reply does not invent success', () => {
  const result = run('await app.click(1)', 'Window: "Untitled", App: TextEdit.\n- 1 text area, Value: before\n+ 1 text area, Value: private pasted text');
  assert.equal(result.windows[0].change, 'changed');
  assert.doesNotMatch(JSON.stringify(result), /private pasted text/);
  const same = run('await app.click(1)', tree('before'));
  assert.equal(same.windows[0].change, 'unchanged');
});

test('a final read updates the turn review and the first read stays its baseline', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, tree('first')));
  journal.request(request(2, 'await app.getAXState()')); journal.reply(reply(2, tree('second')));
  journal.request(request(3, 'await app.click(1)')); journal.reply(reply(3, tree('second')));
  assert.equal(journal.finish({ review: true }).windows[0].change, 'changed');
  journal.request(request(4, 'await app.click(1)')); journal.reply(reply(4, tree('changed')));
  journal.request(request(5, 'await app.getAXState()')); journal.reply(reply(5, tree('second')));
  assert.equal(journal.finish({ review: true }).windows[0].change, 'unchanged');
});

test('opaque JavaScript that mentions a read can still mutate the observed window', () => {
  const result = run('const x = await cua.getApp("TextEdit"); const type = x.typeText.bind(x); await type("secret")');
  assert.notEqual(result.calls[1].actions[0].action, 'read');
  assert.ok(result.windows.length > 0);
});

test('an acquisition plus action never inherits the previous app window', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("Calculator")')); journal.reply(reply(1, 'Window: "Calculator", App: Calculator.\n0 window'));
  journal.request(request(2, 'app = await cua.getApp("TextEdit"); await app.typeText("secret")')); journal.reply(reply(2, tree('secret')));
  const result = journal.finish({ review: true });
  assert.notEqual(result.calls[1].app, 'Calculator');
  assert.ok(result.windows.every(window => window.app !== 'Calculator'));
});

test('a caller-supplied pane title cannot hide a mutation', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, tree('before')));
  journal.request(request(2, 'await app.click(1)')); journal.reply(reply(2, tree('after')));
  journal.request(request(3, 'await app.typeText("private")', { title: 'sleight pane snapshot' })); journal.reply(reply(3, tree('pane')));
  const first = journal.finish({ review: true });
  assert.equal(first.calls.length, 3);
  assert.equal(first.calls[2].actions[0].action, 'typeText');
  journal.request(request(4, 'await app.click(1)')); journal.reply(reply(4, tree('pane')));
  const next = journal.finish({ review: true });
  assert.equal(next.windows[0].change, 'unchanged');
});

test('receipt writes are private, unique and never follow an output symlink', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-receipts-test-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'receipts');
  const a = writeReceipt({ calls: [] }, { directory });
  const b = writeReceipt({ calls: [] }, { directory });
  assert.notEqual(a, b);
  assert.equal(lstatSync(a).mode & 0o777, 0o600);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')), { calls: [] });
  symlinkSync(directory, join(root, 'redirect'));
  assert.throws(() => writeReceipt({}, { directory: join(root, 'redirect') }), /symlink|directory/i);
  assert.equal(readdirSync(directory).length, 2);
});

test('unfinished first-call mutations retain uncertainty without a prior read', () => {
  for (const message of [request(1, 'let app = await cua.getApp("TextEdit"); await app.typeText("secret")'),
    { id: 1, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit', from: [1, 2], to: [3, 4] } } }]) {
    const journal = new TurnJournal(); journal.request(message);
    const receipt = journal.finish({ review: true });
    assert.equal(receipt.windows[0].change, 'unknown');
    assert.match(receipt.review, /unknown/);
  }
});

test('omitted calls invalidate the final state and say the review is partial', () => {
  const journal = new TurnJournal({ limit: 2 });
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, tree('before')));
  journal.request(request(2, 'await app.click(1)')); journal.reply(reply(2, tree('before')));
  journal.request(request(3, 'await app.typeText("secret")')); journal.reply(reply(3, tree('secret')));
  const receipt = journal.finish({ review: true });
  assert.equal(receipt.omitted, 1);
  assert.ok(receipt.windows.every(window => window.change === 'unknown'));
  assert.match(receipt.review, /partial/i);
  assert.equal(journal.last, undefined);
});

test('reused request IDs cannot bypass the retained-call limit or overwrite earlier replies', () => {
  const journal = new TurnJournal({ limit: 2 });
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.reply(reply(1, tree('before')));
  journal.request(request(1, 'await app.typeText("first")')); journal.reply(reply(1, tree('first')));
  journal.request(request(1, 'await app.typeText("omitted")')); journal.reply(reply(1, tree('omitted')));
  const receipt = journal.finish({ review: true });
  assert.equal(receipt.calls.length, 2);
  assert.equal(receipt.omitted, 1);
  assert.equal(receipt.calls[1].result, 'returned');
  assert.equal(receipt.calls[1].actions[0].input.length, 5);
  assert.ok(receipt.windows.every(window => window.change === 'unknown'));
});

test('duplicate replies do not retain additional events', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")'));
  journal.reply(reply(1, tree('before')));
  journal.reply(reply(1, tree('duplicate')));
  assert.equal(journal.events.length, 2);
});

test('default receipts keep only title length and a scrubbed file URL basename', () => {
  const journal = new TurnJournal({ ownerNames: ['Test Owner', 'test-owner'] });
  const output = 'Window: "Test Owner playing chess", App: Chess.\nURL: file:///Users/test-owner/private/Test%20Owner%20notes.txt\n0 window';
  journal.request(request(1, 'let app = await cua.getApp("Chess")')); journal.reply(reply(1, output));
  journal.request(request(2, 'await app.click(1)')); journal.reply(reply(2, output));
  const receipt = journal.finish({ review: true });
  assert.deepEqual(receipt.calls[1].window, { redacted: true, length: 24 });
  assert.equal(receipt.calls[1].document, '[owner] notes.txt');
  assert.equal(receipt.windows[0].document, '[owner] notes.txt');
  assert.doesNotMatch(JSON.stringify(receipt), /Test Owner|test-owner|playing chess|private/);
});

test('typed characters are length markers; named keys and command shortcuts stay', () => {
  // Shift or Option with a printable key types a character (a capital, "(", an accent).
  const keys = ['a', '9', ' ', '!', 'é', '😀', 'shift+h', 'shift+9', 'option+e', 'shift+option+2',
    'Return', 'Tab', 'Escape', 'left', 'shift+Return', 'super+a', 'super+[', 'super+shift+z', 'ctrl+option+t'];
  const receipt = run(keys.map(key => `await app.pressKey(${JSON.stringify(key)})`).join(';'));
  assert.deepEqual(receipt.calls[1].actions.map(action => action.key),
    [...keys.slice(0, 10).map(key => ({ redacted: true, length: key.length })), ...keys.slice(10)]);
});

test('completed entries release code and read text even when their call objects remain referenced', () => {
  const journal = new TurnJournal();
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")')); journal.observe(1, tree('private raw value'));
  journal.reply(reply(1, tree('private raw value')));
  const call = journal.events[0].call;
  journal.finish();
  for (const field of ['text', 'content', 'code', 'args', 'before']) assert.equal(call[field], undefined, field);
  assert.doesNotMatch(JSON.stringify(journal.last), /private raw value/);
});

test('each write prunes receipts older than seven days and retains at most 200 writer files', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-retention-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.now(), week = 7 * 86400000;
  const files = Array.from({ length: 205 }, (_, i) => writeReceipt({}, { directory, now: now - 1000 + i }));
  const expired = join(directory, `turn-${now - week - 1}-${randomUUID()}.json`);
  writeFileSync(expired, '{}');
  const unrelated = join(directory, 'notes.json'); writeFileSync(unrelated, '{}');
  const link = join(directory, `turn-${now - week - 2}-${randomUUID()}.json`); symlinkSync(unrelated, link);
  const folder = join(directory, `turn-${now - week - 3}-${randomUUID()}.json`); mkdirSync(folder);
  writeReceipt({}, { directory, now });
  const ordinary = readdirSync(directory).filter(name => /^turn-\d+-[\da-f-]+\.json$/.test(name) && lstatSync(join(directory, name)).isFile());
  assert.equal(ordinary.length, 200);
  assert.equal(readdirSync(directory).includes(expired.split('/').at(-1)), false);
  assert.equal(readdirSync(directory).includes(files[0].split('/').at(-1)), false);
  assert.equal(readFileSync(unrelated, 'utf8'), '{}');
  assert.ok(lstatSync(link).isSymbolicLink()); assert.ok(lstatSync(folder).isDirectory());
});

test('retention leaves files with a different owner untouched', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-retention-owner-')));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });
  const now = Date.now(), foreign = writeReceipt({}, { directory, now: now - 8 * 86400000 });
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const stat = original(path, ...args);
    if (path === foreign) stat.uid = process.getuid() + 1;
    return stat;
  });
  syncBuiltinESMExports();
  writeReceipt({}, { directory, now });
  assert.equal(readFileSync(foreign, 'utf8'), '{}\n');
});

test('concurrent receipt writers tolerate pruning the same expired or excess files', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-retention-concurrent-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let i = 0; i < 200; i++) writeReceipt({}, { directory, now: Date.now() - 10000 + i });
  const source = new URL('../plugins/sleight/lib/turn-receipts.mjs', import.meta.url).href;
  const code = `const {writeReceipt} = await import(process.argv[1]); for(let i=0;i<30;i++) writeReceipt({}, {directory:process.argv[2]});`;
  const worker = () => new Promise((resolve, reject) => {
    childProcess.execFile(process.execPath, ['--input-type=module', '-e', code, source, directory], { timeout: 20000 }, error => error ? reject(error) : resolve());
  });
  const results = await Promise.allSettled(Array.from({ length: 4 }, worker));
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
  assert.ok(readdirSync(directory).length <= 200);
});

test('concurrent first writers validate a directory created between stat and mkdir', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-retention-mkdir-'))), directory = join(root, 'receipts');
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });
  const original = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (path, options) => {
    original(path, options);
    if (path === directory) throw Object.assign(new Error('Concurrent directory creation'), { code: 'EEXIST' });
  });
  syncBuiltinESMExports();
  const path = writeReceipt({}, { directory });
  assert.equal(readFileSync(path, 'utf8'), '{}\n');
});

test('the default owner scrubber reads id -F once and scrubs retained fields', t => {
  let count = 0;
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, '/usr/bin/id'); assert.deepEqual(args, ['-F']); count++; return 'Test Full Name\n';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const journal = new TurnJournal({ redactTitles: false });
  journal.request(request(1, 'let app = await cua.getApp("TextEdit")'));
  journal.reply(reply(1, 'Window: "Test Full Name draft", App: TextEdit.\n0 window'));
  const receipt = journal.finish({ session: 'Test Full Name', review: true });
  assert.equal(count, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /Test Full Name/);
  assert.equal(receipt.calls[0].window, '[owner] draft');
});

test('short inputs and action-like text are redacted without changing action names', () => {
  const receipt = run('await app.typeText("typeText"); await app.typeText("hi")',
    'Window: "typeText hi", App: TextEdit.\n0 window\n1 text area, Value: typeText hi');
  assert.equal(receipt.calls[1].actions[0].action, 'typeText');
  assert.deepEqual(receipt.windows[0].window, { redacted: true, length: 8 });
  assert.doesNotMatch(receipt.review, /typeText|hi/);
});

test('regular expression contents cannot invent receipt actions', () => {
  const receipt = run('const pattern = /app.click(123)/; await app.getAXState()');
  assert.ok(receipt.calls[1].actions.every(action => action.action !== 'click'));
});
