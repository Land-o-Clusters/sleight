import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { preparePdfHelper, extractPdf } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { textPdf } from '../bench/pdf-fixture.mjs';

// Instrument the PDFDocument construction boundary, leaving the helper's real
// startup restrictions in place. No production test switches or host privileges.
async function probeHelper(t, probe, { lowMemoryLimit = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sleight-pdf-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'pdf-host.swift');
  let source = await readFile(new URL('../plugins/sleight/lib/direct-browser/native/pdf-host.swift', import.meta.url), 'utf8');
  source = source.replace('PDFDocument(data: try Data(contentsOf: URL(fileURLWithPath: path)))', 'probe(path)') + '\n' + probe;
  if (lowMemoryLimit) source = source.replace('1024 * 1024 * 1024', '64 * 1024 * 1024');
  await writeFile(filename, source, { mode: 0o600 });
  const built = await preparePdfHelper({ sourceRoot: root, cacheRoot: join(root, 'cache'), inventory: { accepted: true, protocol: 1,
    helperMode: 'source', node: process.version, files: [{ path: 'native/pdf-host.swift', sha256: createHash('sha256').update(source).digest('hex') }] } });
  assert.equal(built.status, 'ready', JSON.stringify(built));
  const path = join(root, 'staged.pdf'); await writeFile(path, textPdf(['staged fixture']), { mode: 0o600 });
  return { root, path, receipt: built.receipt, binary: join(built.directory, 'pdf-host') };
}
test('PDF sandbox permits staged bytes and denies other reads, writes, networking and subprocesses', {
  skip: process.platform !== 'darwin', timeout: 360000,
}, async t => {
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const helper = await probeHelper(t, `
func probe(_ path: String) -> PDFDocument? {
    let readable = (try? Data(contentsOf: URL(fileURLWithPath: path))) != nil
    let otherReadable = (try? Data(contentsOf: URL(fileURLWithPath: path + ".other"))) != nil
    let writable = (try? Data("changed".utf8).write(to: URL(fileURLWithPath: path))) != nil
    let network = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(${server.address().port}).bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(network, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if network >= 0 { close(network) }
    let child = Process(); child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    var spawned = false
    do { try child.run(); child.waitUntilExit(); spawned = true } catch {}
    try! reply(["readable": readable, "otherReadable": otherReadable, "writable": writable, "network": connected >= 0, "spawned": spawned])
    exit(0)
}`);
  await writeFile(helper.path + '.other', 'private other file');
  assert.deepEqual(await extractPdf(helper.receipt, helper.path), {
    readable: true, otherReadable: false, writable: false, network: false, spawned: false,
  });
});
test('PDF memory watchdog exits when the physical footprint crosses its bound', {
  skip: process.platform !== 'darwin', timeout: 360000,
}, async t => {
  const helper = await probeHelper(t, `
func probe(_ path: String) -> PDFDocument? {
    try! reply(["entered": true])
    let size = path.hasSuffix("small.pdf") ? 1024 : 128 * 1024 * 1024
    let bytes = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 4096)
    memset(bytes, 1, size)
    Thread.sleep(forTimeInterval: 2)
    try! reply(["survived": true]); bytes.deallocate(); exit(0)
}`, { lowMemoryLimit: true });
  const run = path => new Promise(resolve => {
    let output = '';
    const child = execFile(helper.binary, [], { timeout: 5000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin' } }, (_error, stdout) => { output = stdout; });
    child.once('close', (code, signal) => resolve({ code, signal, output }));
    child.stdin.end(JSON.stringify({ path, page: 0, offset: 0 }));
  });
  const small = join(helper.root, 'small.pdf'); await writeFile(small, textPdf(['small fixture']));
  const baseline = await run(small);
  assert.deepEqual(baseline, { code: 0, signal: null, output: '{"entered":true}{"survived":true}' });
  const result = await run(helper.path);
  assert.equal(result.code, 70); assert.equal(result.signal, null);
  assert.equal(result.output, '{"entered":true}');
});
