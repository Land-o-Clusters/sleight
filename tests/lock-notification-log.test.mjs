import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { lockNotificationSource, parseArguments, runLogger } from '../bench/lock-notification-log.mjs';

// These tests never compile or start the notification listener.
test('logger requires explicit listening, an output file and a bounded duration', () => {
  assert.deepEqual(parseArguments([]), { listen: false });
  assert.deepEqual(parseArguments(['--help']), { listen: false });
  assert.deepEqual(parseArguments(['--listen', '--output', 'trace.jsonl']), { listen: true, output: 'trace.jsonl', seconds: 600 });
  assert.deepEqual(parseArguments(['--listen', '--output', 'trace.jsonl', '--seconds', '300']), { listen: true, output: 'trace.jsonl', seconds: 300 });
  for (const args of [['--listen'], ['--output', 'trace.jsonl'], ['--listen', '--output', 'x', '--seconds', '0'],
    ['--listen', '--output', 'x', '--seconds', '1801'], ['--listen', '--output', 'x', '--seconds', '1.5'],
    ['--listen', '--output', 'x', '--seconds', 'NaN'], ['--unknown']]) assert.throws(() => parseArguments(args));
});

test('logger source only observes names and samples lock metadata', () => {
  assert.match(lockNotificationSource, /com\.apple\.screenIsLocked/);
  assert.match(lockNotificationSource, /com\.apple\.screenIsUnlocked/);
  assert.match(lockNotificationSource, /CGSessionCopyCurrentDictionary/);
  for (const field of ['timestamp', 'uptimeSeconds', 'notification', 'lockKeyPresent']) assert.ok(lockNotificationSource.includes(field));
  assert.match(lockNotificationSource, /removeObserver/);
  assert.doesNotMatch(lockNotificationSource, /NSApplication|NSPanel|CGEvent|CGWindow|ScreenCapture|AXUIElement|NSWorkspace|\.post\(|AppleScript|osascript/);
});

test('logger writes only to a new output and cleans its private compiler staging', async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-lock-log-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'log.jsonl'), calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args });
    if (args[0] === 'swiftc') {
      assert.equal(await readFile(args[args.indexOf('-o') - 1], 'utf8'), lockNotificationSource);
    } else await options.stdout.write('{"notification":"com.apple.screenIsLocked","timestamp":"fake"}\n');
    return 0;
  };
  const result = await runLogger({ output, seconds: 1 }, { execute, tempRoot: root });
  assert.equal(result, 0); assert.equal(calls.length, 2);
  assert.match(await readFile(output, 'utf8'), /screenIsLocked/);
  assert.equal(calls[0].command, '/usr/bin/xcrun');
  assert.deepEqual(calls[1].args, ['1']);
  const { readdir, stat } = await import('node:fs/promises');
  assert.deepEqual(await readdir(root), ['log.jsonl']);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(runLogger({ output, seconds: 1 }, { execute, tempRoot: root }), { code: 'EEXIST' });
  assert.equal(calls.length, 2);
});

test('logger compiler failures keep the output and clean the owned staging', async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-lock-log-fail-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'log.jsonl');
  await assert.rejects(runLogger({ output, seconds: 1 }, { execute: async () => 7, tempRoot: root }), /compile.*7/i);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(root), ['log.jsonl']);
});

test('logger Swift typechecks without starting a listener', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-lock-log-compile-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'listener.swift');
  await writeFile(source, lockNotificationSource);
  const result = await new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/xcrun', ['swiftc', '-typecheck', '-module-cache-path', join(root, 'modules'), source],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', bytes => { stderr += bytes; });
    proc.once('error', reject);
    proc.once('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
});
