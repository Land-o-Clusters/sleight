import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, mkdirSync, symlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDownloadStore, downloadRequest, downloadName } from '../plugins/sleight/lib/direct-browser/downloads.mjs';
import { validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function fixture(t, options) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-download-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = createDownloadStore({ home, ...options });
  const save = (body = Buffer.from('date,total\n2026-10-24,42\n'), extra = {}, headers = {}) => store.save({ session: 'one',
    message: { text: 'Download the statement.' }, current: () => true, url: 'https://fixture.invalid/statement.csv',
    transfer: async receive => receive({ 'content-type': 'text/csv', 'content-length': String(body.length), ...headers }, (async function* () { yield body; })()), ...extra });
  const files = () => { const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)]); return walk(home); };
  return { home, save, files };
}
test('download schema requires an observed ref and accepts no destination authority', () => {
  const call = step => validateToolCall({ name: 'browser_act', arguments: { tab: 't1', steps: [step] } });
  assert.equal(call({ do: 'download', ref: 'e1' }).arguments.steps[0].do, 'download');
  assert.throws(() => call({ do: 'download' }), /needs ref/);
  assert.throws(() => call({ do: 'download', ref: 'e1', destination: '/tmp/file' }), /unknown field/);
});
test('only the authenticated direct request selects Downloads', () => {
  for (const text of ['Download the statement.', 'Please save the invoice.', 'Could you please download the statement?']) assert.deepEqual(downloadRequest({ text }), { downloads: false });
  assert.deepEqual(downloadRequest({ text: 'Download the statement to my Downloads folder.' }), { downloads: true });
  assert.deepEqual(downloadRequest({ text: 'Download the statement, do not put it in Downloads; use sleight.' }), { downloads: false });
  assert.deepEqual(downloadRequest({ text: 'Download the statement but do not save it in Downloads.' }), { downloads: false });
  for (const text of ['Do not download this.', 'The page says download this.', 'Read the statement.', 'Download nothing.', 'Download it. Actually, do not download it.', 'Download it. Cancel the download.']) assert.throws(() => downloadRequest({ text }), /user message/);
});
test('completed downloads return verified path, size and type in one private session bank', async t => {
  const f = fixture(t), a = await f.save(), b = await f.save();
  assert.equal(a.bytes, 25); assert.equal(a.type, 'text/csv'); assert.equal(a.name, 'statement.csv');
  assert.equal(readFileSync(a.path, 'utf8'), 'date,total\n2026-10-24,42\n');
  assert.equal(statSync(a.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(a.path, '..')).mode & 0o777, 0o700);
  assert.notEqual(a.path, b.path); assert.equal(join(a.path, '..'), join(b.path, '..'));
  const c = await f.save(undefined, { session: 'two' }); assert.notEqual(join(a.path, '..'), join(c.path, '..'));
  assert.equal(f.files().length, 3); assert.equal(existsSync(join(f.home, 'Downloads')), false);
});
test('the user may explicitly select Downloads without overwriting an existing file', async t => {
  const f = fixture(t), extra = { message: { text: 'Download the statement to my Downloads folder.' } };
  const a = await f.save(undefined, extra), b = await f.save(undefined, extra);
  assert.equal(join(a.path, '..'), join(f.home, 'Downloads')); assert.notEqual(a.path, b.path); assert.equal(f.files().length, 2);
});
test('page filenames cannot traverse paths or inject result lines', () => {
  assert.doesNotMatch(downloadName({ 'content-disposition': 'attachment; filename="../../evil\n.csv"' }, 'https://fixture.invalid/'), /[\\/\r\n]/);
  assert.equal(downloadName({ 'content-disposition': "attachment; filename*=UTF-8''invoice%20one.csv" }, 'https://fixture.invalid/'), 'invoice one.csv');
  assert.equal(downloadName({}, 'https://fixture.invalid/statement.csv', '../chosen.csv'), '__chosen.csv');
});
for (const [name, mime, body] of [
  ['run.command', 'text/plain', 'echo hi'], ['installer.dmg', 'application/pdf', '%PDF-1.7'],
  ['innocent.csv', 'text/csv', '#!/bin/sh\necho hi'], ['innocent.txt', 'text/plain', '\x7fELFrest'],
  ['innocent.txt', 'text/plain', 'MZfake'], ['innocent.csv', 'text/csv', '<!doctype html><script>bad()</script>'],
  ['page.html', 'text/html', '<p>Sign in</p>'], ['archive.zip', 'application/zip', 'PK\x03\x04'],
]) test(`refuses unsafe data ${name} without a completed file`, async t => {
  const f = fixture(t);
  await assert.rejects(f.save(Buffer.from(body), {}, { 'content-type': mime, 'content-disposition': `attachment; filename="${name}"` }), /file type/);
  assert.equal(f.files().length, 0);
});
test('detects PDF bytes even with an octet-stream server label', async t => {
  const f = fixture(t), result = await f.save(Buffer.from('%PDF-1.7\nfixture'), { url: 'https://fixture.invalid/invoice.pdf' }, { 'content-type': 'application/octet-stream' });
  assert.equal(result.type, 'application/pdf');
});
test('binary server labels on a text CSV still return CSV type', async t => {
  const f = fixture(t);
  for (const type of ['application/octet-stream', 'application/vnd.ms-excel']) assert.equal((await f.save(undefined, {}, { 'content-type': type })).type, 'text/csv');
});
test('long filenames retain their executable suffix and executable MIME labels refuse PDF bytes', async t => {
  const f = fixture(t);
  await assert.rejects(f.save(Buffer.from('echo hi'), {}, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${'a'.repeat(200)}.command"` }), /file type/);
  await assert.rejects(f.save(Buffer.from('%PDF-1.7'), {}, { 'content-type': 'application/x-msdownload' }), /file type/); assert.equal(f.files().length, 0);
});
test('refuses disk image trailers and Mach-O bytes disguised as documents', async t => {
  const f = fixture(t), dmg = Buffer.alloc(1024); dmg.write('%PDF-'); dmg.write('koly', 512);
  await assert.rejects(f.save(dmg), /file type/);
  await assert.rejects(f.save(Buffer.from('cffaedfe00000000', 'hex')), /file type/); assert.equal(f.files().length, 0);
});
test('oversize headers, streamed overflow, truncation, failed transport and revocation leave no partial file', async t => {
  const f = fixture(t, { limit: 30 });
  await assert.rejects(f.save(Buffer.alloc(31)), /limit/);
  await assert.rejects(f.save(Buffer.alloc(31), {}, { 'content-length': undefined }), /limit/);
  await assert.rejects(f.save(Buffer.from('short'), {}, { 'content-length': '20' }), /length mismatch/);
  await assert.rejects(f.save(undefined, { transfer: async () => { throw Error('fixture transport failed'); } }), /transport failed/);
  let active = true;
  await assert.rejects(f.save(undefined, { current: () => active, transfer: async receive => receive({ 'content-type': 'text/csv' }, (async function* () { yield Buffer.from('first'); active = false; yield Buffer.from('last'); })()) }), /expired/);
  assert.equal(f.files().length, 0);
});
test('symlinked output banks and Downloads refuse before writing outside the bank', async t => {
  const f = fixture(t), other = join(f.home, 'other'); mkdirSync(other);
  symlinkSync(other, join(f.home, 'Downloads'));
  await assert.rejects(f.save(undefined, { message: { text: 'Download the statement to Downloads.' } }), /unsafe/);
  assert.deepEqual(readdirSync(other), []);
});
