import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';

// Compile only. This test never starts the consent host or any app/window.
// Match the production helper's 300-second budget for a cold AppKit module cache.
test('the consent host with the protected handoff card typechecks', { skip: macCommandSkip('xcrun'), timeout: 360000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-handoff-typecheck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-typecheck', '-module-cache-path', join(root, 'cache'),
    resolve('plugins/sleight/lib/direct-browser/native/consent-host.swift')], { encoding: 'utf8', timeout: 300000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
