import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';

// Compile only. This test never starts the consent host or any app/window.
test('the consent host with the protected handoff card typechecks', { skip: macCommandSkip('xcrun'), timeout: 120000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-handoff-typecheck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-typecheck', '-module-cache-path', join(root, 'cache'),
    resolve('plugins/sleight/lib/direct-browser/native/consent-host.swift')], { encoding: 'utf8', timeout: 110000 });
  assert.equal(result.status, 0, result.stderr);
});
