// Compile once. Only --validate and --selftest run; neither initializes AppKit.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
let binary;
const options = { skip: process.platform !== 'darwin' };
before(() => {
  if (options.skip) return;
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-uc2c-unit-')));
  binary = join(root, 'witness');
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'),
    'bench/runtime-renderer-host.swift', '-o', binary], { timeout: 180000, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  console.log(`UC2C witnessBytes=${statSync(binary).size}`);
});
test('renderer witness selftest creates zero windows and generates zero input', options, () => {
  const result = spawnSync(binary, ['--selftest'], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cases: 3, windowsCreated: 0, inputGenerated: false });
});
test('renderer witness validates only the closed fixture and observation operations without drawing', options, () => {
  // The Swift witness requires this private temporary prefix for renderer-launch wire data.
  const root = ['', 'private', 'tmp', 'sleight-uc2c-fixture'].join('/');
  const valid = [{ op: 'renderer-launch', app: 'vscode', root }, { op: 'renderer-launch', app: 'discord', root },
    { op: 'renderer-watch-begin' }, { op: 'renderer-watch-end' }, { op: 'renderer-close' },
    { op: 'renderer-cover', window: { pid: 321, windowId: '42', bundleId: 'com.microsoft.VSCode' } }];
  const invalid = [{ op: 'click' }, { op: 'renderer-launch', app: 'Terminal', root },
    { op: 'renderer-launch', app: 'vscode', root: root + '/../other' },
    { op: 'renderer-launch', app: 'vscode', root: '/tmp/owner-profile' },
    { op: 'renderer-launch', app: 'vscode', root, args: ['--remote-debugging-port=9222'] },
    { op: 'renderer-cover', window: { pid: true, windowId: '42', bundleId: 'com.microsoft.VSCode' } },
    { op: 'renderer-cover', window: { pid: 321, windowId: '042', bundleId: 'com.microsoft.VSCode' } },
    { op: 'renderer-cover', window: { pid: 321, windowId: '42', bundleId: 'com.apple.Terminal' } }];
  for (const [rows, expected] of [[valid, 0], [invalid, 65]]) for (const row of rows) {
    const result = spawnSync(binary, ['--validate'], { input: JSON.stringify(row), timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' });
    assert.equal(result.status, expected, JSON.stringify(row));
    assert.equal(JSON.parse(result.stdout).windowsCreated, 0);
  }
});
