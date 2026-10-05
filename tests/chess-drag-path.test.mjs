import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('native Chess fixture accepts the owned private temporary path before Foundation normalizes it', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync('/private/tmp/sleight-chess-path-test-');
  try {
    const helper = join(dir, 'fixture');
    execFileSync('swiftc', ['-module-cache-path', join(dir, 'cache'), '-o', helper, 'bench/chess-drag-fixture.swift'], { timeout: 60000 });
    const request = args => JSON.parse(execFileSync(helper, [JSON.stringify(args)], { encoding: 'utf8' }));
    const check = path => request({ op: 'path-check', path });
    const owned = '/private/tmp/sleight-chess-stacked-test/target.game';
    assert.equal(check(owned).ok, true);
    assert.equal(check(owned).reported, owned, 'snapshot ownership must match the opened path despite the /tmp alias');
    for (const document of [`file://${owned}`, `file://${owned.replace('/private/tmp/', '/tmp/')}`]) {
      assert.equal(request({ op: 'path-check', path: owned, document }).sameDocument, true);
    }
    assert.equal(request({ op: 'path-check', path: owned, document: 'file:///tmp/another-session.game' }).sameDocument, false);
    assert.deepEqual(request({ op: 'close-check' }), { ok: true, actions: 1,
      absentAppClose: { ok: false, error: 'Chess exited; document cleanup unconfirmed; restored games may reopen' },
      publishedTitles: ['sleight-stacked-1-target.game', '', '[unowned Chess window]'] });
    for (const path of ['/private/tmp/another-project/target.game', '/private/tmp/sleight-chess-stacked-test/../owner.game', '/private/tmp/sleight-chess-stacked-test/target.txt']) {
      assert.equal(check(path).ok, false, path);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
