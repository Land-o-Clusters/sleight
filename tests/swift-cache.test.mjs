import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as cache from '../bench/swift-cache.mjs';
import { prepareFirefoxQuit } from '../bench/fowl/firefox-browser.mjs';

function fixture(t) {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'sf6x-swift-')));
  const source = join(home, 'firefox-quit.swift');
  writeFileSync(source, 'first source');
  return { home, source, helpers: join(home, 'Library/Caches/sleight-bench/helpers') };
}

test('shared helper reuses source hashes across callers and rebuilds changed source', async t => {
  assert.equal(typeof cache.compileSwiftHelper, 'function');
  const f = fixture(t), calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    writeFileSync(args.at(-1), readFileSync(f.source));
    return { exit: { code: 0, signal: null }, groupClean: true, stdout: '', stderr: '' };
  };
  const first = await cache.compileSwiftHelper(f.source, { home: f.home, run });
  assert.equal(await cache.compileSwiftHelper(f.source, { home: f.home, run }), first);
  assert.equal(calls.length, 1);
  assert.match(first, /\/helpers\/firefox-quit-[a-f0-9]{64}$/);
  assert.equal(readFileSync(first, 'utf8'), 'first source');
  assert.equal(calls[0].command, '/usr/bin/xcrun');
  assert.deepEqual(calls[0].args.slice(0, 4), ['swiftc', '-module-cache-path',
    join(f.home, 'Library/Caches/sleight-bench/swift-module-cache'), f.source]);
  assert.equal(calls[0].options.timeoutMs, 310000, 'cold compile gets the Cursor admission allowance');
  assert.notEqual(calls[0].args.at(-1), first, 'publish after successful compilation');
  writeFileSync(f.source, 'second source');
  const second = await cache.compileSwiftHelper(f.source, { home: f.home, run });
  assert.notEqual(second, first);
  assert.equal(readFileSync(second, 'utf8'), 'second source');
  assert.equal(calls.length, 2);
  assert.equal(readdirSync(f.helpers).length, 2, 'private build directories removed');
});

test('failed compilation never publishes a partial helper and can retry', async t => {
  assert.equal(typeof cache.compileSwiftHelper, 'function');
  const f = fixture(t);
  let fail = true;
  const run = async (_command, args) => {
    writeFileSync(args.at(-1), fail ? 'partial' : 'complete');
    return { exit: { code: fail ? 1 : 0, signal: null }, groupClean: true, stderr: 'stub compiler' };
  };
  await assert.rejects(cache.compileSwiftHelper(f.source, { home: f.home, run }), /stub compiler/);
  assert.deepEqual(readdirSync(f.helpers), []);
  fail = false;
  assert.equal(readFileSync(await cache.compileSwiftHelper(f.source, { home: f.home, run }), 'utf8'), 'complete');
});

test('timed out stub compiler collects its resistant frontend process group before returning', async t => {
  assert.equal(typeof cache.compileSwiftHelper, 'function');
  const f = fixture(t), pidFile = join(f.home, 'frontend-pid');
  const compiler = join(f.home, 'compiler.mjs');
  writeFileSync(compiler, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    const frontend = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 100);",
      process.argv[2]], { stdio: 'inherit' });
    writeFileSync(process.argv.at(-1), 'partial');
    setInterval(() => {}, 100);
  `);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, '/usr/bin/xcrun');
    assert.equal(options.detached, true, 'compiler must own a process group');
    return spawn(process.execPath, [compiler, pidFile, args.at(-1)], options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(cache.compileSwiftHelper(f.source, { home: f.home, timeoutMs: 1500 }), /timed out after 1500 ms/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'frontend is gone');
  assert.deepEqual(readdirSync(f.helpers), [], 'no binary or staging directory survives timeout');
});

test('unconfirmed compiler collection preserves staging and refuses publication', async t => {
  assert.equal(typeof cache.compileSwiftHelper, 'function');
  const f = fixture(t);
  await assert.rejects(cache.compileSwiftHelper(f.source, { home: f.home, run: async (_command, args) => {
    writeFileSync(args.at(-1), 'partial');
    return { exit: { code: 0, signal: null }, groupClean: false, stderr: '' };
  } }), error => error.uncollected === true && /cleanup unconfirmed/.test(error.message));
  const entries = readdirSync(f.helpers);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\.build-/);
});

test('Firefox quit preparation shares the helper across controls and retains exact quit arguments', async t => {
  const f = fixture(t);
  let compiles = 0;
  const run = async (_command, args, options) => {
    compiles++;
    assert.match(args[3], /bench\/fowl\/firefox-quit\.swift$/);
    assert.equal(options.timeoutMs, 310000);
    writeFileSync(args.at(-1), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
    return { exit: { code: 0, signal: null }, groupClean: true, stderr: '' };
  };
  const moved = await prepareFirefoxQuit({ home: f.home, run });
  const unchanged = await prepareFirefoxQuit({ home: f.home, run });
  assert.equal(compiles, 1);
  for (const quit of [moved, unchanged]) {
    const reply = await quit({ pid: 4000, executable: '/fixture/Firefox', profileRoot: '/fixture/owned profile', startedMs: 1792266481999 });
    assert.deepEqual(JSON.parse(reply.stdout), ['4000', '/fixture/Firefox', '/fixture/owned profile', '1792266481']);
  }
});

test('a source edited during compilation cannot publish under its previous hash', async t => {
  assert.equal(typeof cache.compileSwiftHelper, 'function');
  const f = fixture(t);
  await assert.rejects(cache.compileSwiftHelper(f.source, { home: f.home, run: async (_command, args) => {
    writeFileSync(f.source, 'changed during compile');
    writeFileSync(args.at(-1), 'different helper');
    return { exit: { code: 0, signal: null }, groupClean: true, stderr: '' };
  } }), /source changed/);
  assert.deepEqual(readdirSync(f.helpers), []);
});
