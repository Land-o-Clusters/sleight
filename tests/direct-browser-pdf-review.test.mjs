import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import childProcess, { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPdfReader } from '../plugins/sleight/lib/direct-browser/pdf.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { textPdf } from '../bench/pdf-fixture.mjs';
import { preparePdfHelper, extractPdf } from '../plugins/sleight/lib/direct-browser/host.mjs';

const extracted = { pageCount: 1, pages: [{ page: 1, offset: 0, text: 'fixture' }], next: null };
async function fixture(t) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'sleight-pdf-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, 'document.pdf'); await fs.writeFile(path, textPdf(['fixture']), { mode: 0o600 });
  return { root, path };
}
function reader() { return createPdfReader({ authorizeFile: () => true, extract: async () => extracted }); }

test('local PDF policy refuses hidden paths and writable files or ancestors before parsing', async t => {
  const { root, path } = await fixture(t), pdf = reader();
  const hidden = join(root, '.statement.pdf'); await fs.copyFile(path, hidden);
  await assert.rejects(pdf.file(hidden), /hidden/i);
  await fs.chmod(path, 0o666); await assert.rejects(pdf.file(path), /another account/i);
  await fs.chmod(path, 0o600); await fs.chmod(root, 0o777);
  await assert.rejects(pdf.file(path), /another account/i);
  await fs.chmod(root, 0o700); assert.match((await pdf.file(path)).text, /fixture/);
});
test('local PDF location policy refuses Library and system paths before touching the file', async () => {
  const { userInfo } = await import('node:os'), pdf = reader();
  await assert.rejects(pdf.file(userInfo().homedir + '/Library/missing.pdf'), /Library/);
  await assert.rejects(pdf.file('/etc/missing.pdf'), /system files/i);
});
test('local PDF checks the opened descriptor ownership even after the path audit', async t => {
  const { path } = await fixture(t), original = fs.open;
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  fs.open = async (...args) => {
    const handle = await original(...args), stat = handle.stat.bind(handle);
    handle.stat = async options => { const value = await stat(options); value.uid = BigInt(process.getuid() + 1); return value; };
    return handle;
  };
  syncBuiltinESMExports();
  await assert.rejects(reader().file(path), /another account/i);
});
test('local PDF refuses Finder-hidden files and write-granting ACLs', { skip: process.platform !== 'darwin' }, async t => {
  const { path } = await fixture(t), pdf = reader();
  execFileSync('/usr/bin/chflags', ['hidden', path]);
  await assert.rejects(pdf.file(path), /hidden/i);
  execFileSync('/usr/bin/chflags', ['nohidden', path]);
  execFileSync('/bin/chmod', ['+a', 'everyone allow write', path]);
  await assert.rejects(pdf.file(path), /another account/i);
  execFileSync('/bin/chmod', ['-N', path]);
  assert.match((await pdf.file(path)).text, /fixture/);
});
test('PDF metadata size refuses before any resource content fetch', async () => {
  const frame = { id: 'f', loaderId: 'l', url: 'https://example.test/invoice', mimeType: 'application/pdf' };
  let fetched = false;
  const entry = { page: { url: () => frame.url }, cdp: { async send(method) {
    if (method === 'Page.getResourceTree') return { frameTree: { frame, resources: [{ url: frame.url, mimeType: 'application/pdf', contentSize: 33554433 }] } };
    if (method === 'Page.getResourceContent') fetched = true;
    return {};
  } } };
  await assert.rejects(reader().tab(entry), /32 MiB/); assert.equal(fetched, false);
});
test('PDF sizes come from resources, ignoring non-CDP frame sizes, with a post-fetch byte limit', async () => {
  const frame = { id: 'f', loaderId: 'l', url: 'https://example.test/invoice', mimeType: 'application/pdf', contentSize: 33554433 };
  let bytes = textPdf(['fixture']), fetched = 0, parsed = 0;
  const pdf = createPdfReader({ extract: async () => { parsed++; return extracted; } });
  const entry = { page: { url: () => frame.url }, cdp: { async send(method) {
    if (method === 'Page.getResourceTree') return { frameTree: { frame, resources: [] } };
    if (method === 'Page.getResourceContent') { fetched++; return { content: bytes.toString('base64'), base64Encoded: true }; }
    return {};
  } } };
  try {
    assert.match((await pdf.tab(entry)).text, /fixture/);
    assert.equal(fetched, 1); assert.equal(parsed, 1);
    bytes = Buffer.alloc(33554433); bytes.write('%PDF-1.7\n');
    await assert.rejects(pdf.tab(entry), /32 MiB/);
    assert.equal(fetched, 2); assert.equal(parsed, 1, 'oversized loaded bytes never reach the parser');
  } finally { await pdf.dispose(); }
});
test('an unavailable PDF metadata probe falls through to ordinary snapshots but preserves PDF continuation refusal', async () => {
  const entry = { page: { url: () => 'https://example.test/html' }, cdp: { async send() { throw Error('not supported'); } } };
  assert.equal(await reader().tab(entry), null);
  await assert.rejects(reader().tab(entry, { ref: 'pdf_' + 'a'.repeat(24) }), /PDF|continuation/);
  entry.cdp.send = async () => ({});
  assert.equal(await reader().tab(entry), null);
});
test('a timed-out ordinary metadata probe falls through without fetching bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = { page: { url: () => 'https://example.test/html' }, cdp: { send: () => new Promise(() => {}) } };
  const reading = reader().tab(entry);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(10000);
  assert.equal(await reading, null);
});
test('turn end aborts a cold PDF compile and waits for its cleanup without returning text', { timeout: 5000 }, async t => {
  const { path } = await fixture(t);
  const binding = createV3TurnBinding({ source: 'user', session: 's', turn: 't', id: 'm', text: `Read PDF "${path}".` }, () => true);
  let entered, finish, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: { endTurn: async () => ({ cleanedUp: true }) },
    snapshot() {}, dependencies: { pdfInventory: {}, preparePdfHelper: async options => {
      signal = options.signal; entered();
      await new Promise(resolve => { finish = resolve; signal?.addEventListener('abort', resolve, { once: true }); });
      return { status: 'unavailable' };
    } } });
  const reading = runtime.call({ name: 'browser_read', arguments: { file: path } }); await started;
  const ending = runtime.end();
  try { assert.equal(signal?.aborted, true, 'turn end must signal the compile'); }
  finally { finish(); }
  assert.equal((await reading).isError, true); assert.deepEqual(await ending, { revoked: true, cleanup: [] });
});
test('PDF helper launch uses a hard deadline kill and carries the turn abort signal', { skip: process.platform !== 'darwin' }, async t => {
  const { root, path } = await fixture(t);
  const source = await fs.readFile(new URL('../plugins/sleight/lib/direct-browser/native/pdf-host.swift', import.meta.url));
  const built = await preparePdfHelper({ cacheRoot: join(root, 'cache'), inventory: { accepted: true, protocol: 1,
    node: process.version, helperMode: 'source', files: [{ path: 'native/pdf-host.swift', sha256: createHash('sha256').update(source).digest('hex') }] },
    compile: async ({ binary }) => fs.writeFile(binary, 'fixture executable', { mode: 0o700 }) });
  assert.equal(built.status, 'ready');
  const original = childProcess.execFile, controller = new AbortController(); let launch;
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  childProcess.execFile = (_command, _args, options, callback) => {
    launch = options;
    const child = new EventEmitter(); child.stdin = { on() {}, end() {} };
    queueMicrotask(() => { callback(null, JSON.stringify(extracted)); child.emit('close', 0); });
    return child;
  };
  syncBuiltinESMExports();
  await extractPdf(built.receipt, path, {}, { signal: controller.signal });
  assert.equal(launch.killSignal, 'SIGKILL'); assert.equal(launch.signal, controller.signal);
});
