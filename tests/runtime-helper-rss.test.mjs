import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

test('RSS witness compiles and validates only bounded process identities without observing the host',
  { skip: process.platform !== 'darwin', timeout: 240000 }, t => {
    const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-helper-rss-test-')));
    const binary = join(bank, 'process-witness');
    execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'),
      'bench/runtime-process-host.swift', '-o', binary], { encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL' });
    const validate = row => {
      try { return { status: 0, result: JSON.parse(execFileSync(binary, ['--validate'], {
        input: JSON.stringify(row), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      })) }; }
      catch (error) { return { status: error.status, result: JSON.parse(String(error.stdout)) }; }
    };
    const rss = { op: 'rss', pid: 123, started: '1.2', path: '/cache/mac-driver/build/consent-host' };
    for (const row of [{ op: 'inventory' }, rss]) assert.deepEqual(validate(row), { status: 0, result: { valid: true, windowsCreated: 0 } });
    for (const row of [{ ...rss, pid: 0 }, { ...rss, pid: -1 }, { ...rss, pid: 1.5 }, { ...rss, pid: true },
      { ...rss, pid: 2147483648 }, { ...rss, path: 'relative' }, { ...rss, started: '' },
      { ...rss, extra: true }, { ...rss, op: 'other' }])
      assert.deepEqual(validate(row), { status: 65, result: { valid: false, windowsCreated: 0 } }, JSON.stringify(row));
    const selftest = JSON.parse(execFileSync(binary, ['--selftest'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }));
    assert.equal(selftest.windowsCreated, 0); assert.equal(selftest.inputGenerated, false); assert.equal(selftest.checks, 9);
  });
