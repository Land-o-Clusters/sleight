import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { preparePdfHelper } from '../plugins/sleight/lib/direct-browser/host.mjs';

const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const delay = ms => new Promise(resolve => realSetTimeout(resolve, ms));

for (const reason of ['abort', 'deadline', 'stdout', 'stderr']) test(`compiler ${reason} collects its process group, including a child holding pipes, before releasing the bank`, {
  skip: process.platform !== 'darwin', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sleight-pdf-compiler-'));
  let ready;
  t.after(async () => {
    // A failing regression must also let the fake child's bounded lifetime end.
    const deadline = Date.now() + 5000;
    while (ready && Date.now() < deadline) {
      try { process.kill(ready.pid, 0); await delay(20); } catch (error) { if (error.code !== 'ESRCH') throw error; break; }
    }
    await rm(root, { recursive: true, force: true });
  });
  const originalExecFile = childProcess.execFile, originalSpawn = childProcess.spawn;
  const fake = fileURLToPath(new URL('./fixtures/fake-pdf-compiler.mjs', import.meta.url));
  childProcess.execFile = (command, args, options, callback) => command === '/usr/bin/xcrun'
    ? originalExecFile(process.execPath, [fake, root, 'compiler', reason], options, callback) : originalExecFile(command, args, options, callback);
  childProcess.spawn = (command, args, options) => command === '/usr/bin/xcrun'
    ? originalSpawn(process.execPath, [fake, root, 'compiler', reason], options) : originalSpawn(command, args, options);
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = originalExecFile; childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  const source = await readFile(new URL('../plugins/sleight/lib/direct-browser/native/pdf-host.swift', import.meta.url));
  const controller = new AbortController(), cacheRoot = join(root, 'cache');
  if (reason === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
  const building = preparePdfHelper({ cacheRoot, signal: controller.signal, inventory: { accepted: true, protocol: 1,
    helperMode: 'source', node: process.version, files: [{ path: 'native/pdf-host.swift', sha256: createHash('sha256').update(source).digest('hex') }] } });
  const watchdog = realSetTimeout(() => controller.abort(), 7000);
  try {
    const deadline = Date.now() + 5000;
    while (!ready && Date.now() < deadline) {
      try { ready = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')); } catch { await delay(20); }
    }
    assert.ok(ready, 'fake compiler child entered');
    const started = Date.now();
    if (reason === 'abort') controller.abort();
    else if (reason === 'deadline') t.mock.timers.tick(300000);
    const result = await building;
    assert.equal(result.status, 'unavailable');
    if (reason === 'abort') assert.equal(result.detail.errorCode, 'ABORT_ERR');
    else {
      assert.equal(result.detail.killed, true);
      assert.equal(result.detail.errorCode, reason === 'deadline' ? undefined : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    }
    assert.ok(Date.now() - started < 1500, 'child pipes must close before the child exits on its own after four seconds');
    const deadlineGone = Date.now() + 1000;
    let alive = true;
    while (alive && Date.now() < deadlineGone) {
      try { process.kill(ready.pid, 0); await delay(20); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    }
    assert.equal(alive, false, 'compiler descendant is gone');
    assert.deepEqual(await readdir(cacheRoot), [], 'bank and build lock are released only after pipe cleanup');
    await assert.rejects(readFile(join(root, 'survived')), { code: 'ENOENT' });
  } finally { realClearTimeout(watchdog); controller.abort(); await building; }
});

for (const reason of ['exit', 'spawn-error']) test(`compiler ${reason} returns a diagnostic and releases the bank without a launch receipt`, {
  skip: process.platform !== 'darwin', timeout: 5000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sleight-pdf-compiler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = childProcess.spawn, fake = fileURLToPath(new URL('./fixtures/fake-pdf-compiler.mjs', import.meta.url));
  childProcess.spawn = (command, args, options) => command === '/usr/bin/xcrun'
    ? reason === 'exit' ? original(process.execPath, [fake, root, 'exit'], options) : original(join(root, 'missing-compiler'), [], options)
    : original(command, args, options);
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  const source = await readFile(new URL('../plugins/sleight/lib/direct-browser/native/pdf-host.swift', import.meta.url));
  const cacheRoot = join(root, 'cache');
  const result = await preparePdfHelper({ cacheRoot, inventory: { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: [{ path: 'native/pdf-host.swift', sha256: createHash('sha256').update(source).digest('hex') }] } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.receipt, undefined);
  if (reason === 'exit') {
    assert.equal(result.detail.exitCode, 3); assert.equal(result.detail.stderr, 'fixture compiler diagnostic\n');
  } else assert.equal(result.detail.errorCode, 'ENOENT');
  assert.deepEqual(await readdir(cacheRoot), []);
});
