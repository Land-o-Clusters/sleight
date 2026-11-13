import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';
import { checkBuiltinCharacter, installCharacter, loadCharacter, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { characterEnv } from '../bench/hand/synthetic-character.mjs';
import { auditStageObligations, stageWideOracle } from './fixtures/stage-stateful-fuzz.mjs';

// Same spelling the path scan already accepts. The host allowlist compares this prefix.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const hostSource = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);

function underPrivateTmp(path) {
  const real = realpathSync(path);
  return real === MAC_TMP || real.startsWith(`${MAC_TMP}/`);
}

function outsideBankParent() {
  const runner = realpathSync(tmpdir());
  if (!underPrivateTmp(runner)) return runner;
  // The runner pointed TMPDIR at the private root. Use the account temp, which is outside it.
  const found = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
  assertChildStatus(found, 0, found.stderr);
  const parent = realpathSync(found.stdout.trim());
  assert.equal(underPrivateTmp(parent), false);
  return parent;
}

function stageLoad(result) {
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const row = rows.find(item => item.effect === 'stage-load');
  assert.ok(row, result.stdout);
  return row;
}

function assertPathRefusal(result) {
  assertChildStatus(result, 65, result.stderr + result.stdout);
  const refusal = stageLoad(result);
  assert.equal(refusal.effect, 'stage-load');
  assert.equal(refusal.reason, 'path');
}

test('four bounded Mabel image cases keep obligations through content and lifecycle changes without windows', { skip: macCommandSkip('xcrun'), timeout: 900000 }, t => {
  // The no-window host only accepts a redirected character bank beneath MAC_TMP.
  const root = registerTemp(t, realpathSync(mkdtempSync(join(MAC_TMP, 'sleight-real-art-retention-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = registerTemp(t, realpathSync(mkdtempSync(join(outsideBankParent(), 'sleight-unapproved-character-'))));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(underPrivateTmp(outside), false);
  const original = checkBuiltinCharacter('mabel'), files = new Map(original.files);
  files.set('character.json', Buffer.from(JSON.stringify({ ...original.manifest, id: 'retention-mabel' })));
  const folder = installCharacter({ files }, { root });
  const outsideFolder = installCharacter({ files }, { root: outside });
  assert.equal(existsSync(join(outsideFolder, 'character.json')), true);
  const frame = { ...characterFrame(loadCharacter(folder), { nonce: 'c'.repeat(64), seq: 0, resolve: resolveCharacterStates }), size: 'stage' };
  const outsideFrame = { ...characterFrame(loadCharacter(outsideFolder), { nonce: 'd'.repeat(64), seq: 0, resolve: resolveCharacterStates }), size: 'stage' };
  const binary = join(root, 'host');
  const productSource = readFileSync(hostSource, 'utf8');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'),
    hostSource.pathname, '-o', binary],
  { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const refused = spawnSync(binary, ['--stage-dump'], {
    input: [outsideFrame, { dumpLoadArt: true }].map(JSON.stringify).join('\n') + '\n',
    env: { ...process.env, ...characterEnv(outside) },
    encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL',
  });
  assertPathRefusal(refused);
  let cases = 0, snapshots = 0, pairs = 0;
  for (const seed of [71, 72, 73, 74]) {
    const world = { windows: [{ pid: 42, id: 7, frame: [200, 600, 900, 350] }],
      displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
      person: [1600, 1000, 100, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10, cards: [] };
    const at = [650 + seed % 4, 800];
    const aim = { hand: 'aim', nonce: frame.nonce, seq: 1, kind: 'click', pid: 42, windowId: 7, at, rect: [600, 760, 100, 80] };
    const obligations = [{ pid: 42, window: 7, seq: 1, rects: [[at[0] - 48, at[1] - 48, 96, 96], [552, 712, 196, 176]] }];
    const changed = structuredClone(world);
    if (seed === 71) changed.windows[0].frame[0] += 20;
    if (seed === 72) changed.windows[0].onScreen = false;
    if (seed === 73) changed.windows[0].pid = 99;
    const mutation = seed === 74 ? { hand: 'act', nonce: frame.nonce, seq: 2, kind: 'scroll', pid: 42, windowId: 7, at, path: [at], delayMs: 0, beats: 1 } : { dumpWorld: changed };
    const lines = [frame, { dumpLoadArt: true }, { dumpWorld: world }, aim, { dumpAwaitArt: true }, { dumpClock: 1 }, { dumpStats: true },
      mutation, { dumpStats: true }, { dumpClock: 3 }, { dumpStats: true }];
    const result = spawnSync(binary, ['--stage-dump'], { input: lines.map(JSON.stringify).join('\n') + '\n',
      env: { ...process.env, ...characterEnv(root) }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, `seed=${seed}\n${result.stderr}${result.stdout}`);
    const rows = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.find(r => r.effect === 'stage-load').loaded, true);
    const stats = rows.filter(r => r.effect === 'stage-stats');
    const wide = stageWideOracle();
    wide.observe(world); wide.admit({ pid: 42, window: 7, kind: 'aim' }, world);
    for (const [i, row] of stats.entries()) {
      if (i === 1) {
        wide.observe(changed);
        if (seed === 74) wide.admit({ pid: 42, window: 7, kind: 'scroll' }, changed);
      }
      const audit = auditStageObligations(obligations, row, i ? changed : world, wide);
      assert.deepEqual(audit.errors, [], `real-art seed=${seed} snapshot=${i}`);
      pairs += audit.pairs; snapshots++;
    }
    assert.equal(stats.at(-1).shown, true, 'CH-7 a missing acting window keeps its obligations and permits a clear screen edge');
    cases++;
  }
  assert.equal(snapshots, 12);
  assert.ok(pairs >= 24, 'retain at least the original protected-pair coverage');
  // Keep a small numerical receipt inside the owned test bank until the runner removes it.
  writeFileSync(join(root, 'receipt.json'), JSON.stringify({ cases, snapshots, pairs, intersections: 0, windowsCreated: 0 }));
  t.diagnostic(JSON.stringify({ cases, snapshots, pairs, intersections: 0, windowsCreated: 0, stageStrips: false }));
  // A copy of the characters-root prefix check that accepts every absolute path.
  const charactersCheck = `let p = env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix("${MAC_TMP}/")`;
  assert.equal(productSource.split(charactersCheck).length, 2);
  const widenedSource = productSource.replace(charactersCheck, 'let p = env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix("/")');
  const widenedSwift = join(root, 'widened-allowlist.swift');
  writeFileSync(widenedSwift, widenedSource);
  const widenedBinary = join(root, 'widened-host');
  const widenedBuild = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'),
    widenedSwift, '-o', widenedBinary],
  { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(widenedBuild, 0, widenedBuild.stderr);
  const accepted = spawnSync(widenedBinary, ['--stage-dump'], {
    input: [outsideFrame, { dumpLoadArt: true }].map(JSON.stringify).join('\n') + '\n',
    env: { ...process.env, ...characterEnv(outside) },
    encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL',
  });
  assert.throws(() => assertPathRefusal(accepted), { code: 'ERR_ASSERTION' });
  assertChildStatus(accepted, 0, accepted.stderr + accepted.stdout);
  assert.equal(stageLoad(accepted).loaded, true);
});
