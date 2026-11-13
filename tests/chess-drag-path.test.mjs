import { tmpdir } from 'node:os';
// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';

test('native Chess fixture accepts the owned private temporary path before Foundation normalizes it', { skip: macCommandSkip('swiftc') }, () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-chess-path-test-')));
  try {
    const helper = join(dir, 'fixture');
    // Parallel native tests can spend over 60 s in cold module compilation.
    execFileSync('swiftc', ['-module-cache-path', swiftModuleCache(), '-o', helper, 'bench/chess-drag-fixture.swift'], { timeout: 180000 });
    const request = args => JSON.parse(execFileSync(helper, [JSON.stringify(args)], { encoding: 'utf8' }));
    const check = path => request({ op: 'path-check', path });
    const owned = `${MAC_TMP}/sleight-chess-stacked-test/target.game`;
    assert.equal(check(owned).ok, true);
    assert.equal(check(owned).reported, owned, 'snapshot ownership must match the opened path despite the /tmp alias');
    for (const document of [`file://${owned}`, `file://${owned.replace(`${MAC_TMP}/`, '/tmp/')}`]) {
      assert.equal(request({ op: 'path-check', path: owned, document }).sameDocument, true);
    }
    assert.equal(request({ op: 'path-check', path: owned, document: 'file:///tmp/another-session.game' }).sameDocument, false);
    assert.deepEqual(request({ op: 'close-check' }), { ok: true, actions: 1,
      absentAppClose: { ok: false, error: 'Chess exited; document cleanup unconfirmed; restored games may reopen' },
      publishedTitles: ['sleight-stacked-1-target.game', '', '[unowned Chess window]'] });
    for (const path of [`${MAC_TMP}/another-project/target.game`, `${MAC_TMP}/sleight-chess-stacked-test/../owner.game`, `${MAC_TMP}/sleight-chess-stacked-test/target.txt`]) {
      assert.equal(check(path).ok, false, path);
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 }); }
});
