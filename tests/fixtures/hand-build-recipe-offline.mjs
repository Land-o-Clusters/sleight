// CP1A local offline qualification. No app, window, capture or installed-settings access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { runOwned } from '../../bench/preapproved-process.mjs';
import { swiftModuleCache } from '../../bench/swift-cache.mjs';
import { prepareStageCharacter } from '../../bench/hand/stage-live.mjs';
import { loadCharacter } from '../../plugins/sleight/lib/hand/character.mjs';
import { helperCompileArgs } from '../../plugins/sleight/lib/direct-browser/host-cache.mjs';

const work = process.argv[2] ?? process.env.CP1A_PROOF_ROOT, source = 'plugins/sleight/lib/direct-browser/native/consent-host.swift';
assert.ok(work, 'provide the temporary proof root containing a private mabel fixture');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const evidence = { builds: [], decodes: [], refusals: [], firstStrips: [], windows: 0, captures: 0 };
const save = () => writeFileSync(join(work, 'offline.json'), JSON.stringify(evidence, null, 2) + '\n');
async function run(command, args, { bytes, env, binary = false, timeoutMs = 30000 } = {}) {
  const hash = createHash('sha256'); let byteCount = 0;
  const r = await runOwned(command, args, { timeoutMs, signal: controller.signal,
    env: { ...process.env, ...env }, input: bytes === undefined ? undefined : Readable.from([bytes]),
    onStdout: chunk => { byteCount += chunk.length; hash.update(chunk); } });
  assert.equal(r.groupClean, true, 'owned child group collected');
  assert.equal(r.timedOut || r.cancelled || !!r.spawnError, false);
  return { code: r.exit.code, signal: r.exit.signal, bytes: byteCount, sha256: hash.digest('hex'),
    ...binary ? {} : { stdout: r.stdout, stderr: r.stderr } };
}
try {
  const character = prepareStageCharacter(work, join(work, 'mabel')), pack = loadCharacter(character.folder);
  const files = Object.values(pack.sheets).map(s => ({ name: s.name, width: s.width, height: s.height }));
  for (const state of ['stage-lie', 'stage-lie-reach', 'stage-lie-peek', 'stage-sleep']) {
    const entry = character.frame.stage.table[state];
    files.push({ name: relative(pack.folder, entry.file), width: entry.cell[0] * entry.frames, height: entry.cell[1] });
  }
  assert.equal(files.length, 7);
  const binaries = {};
  for (const mode of ['default', 'optimized']) {
    const binary = binaries[mode] = join(work, 'consent-' + mode);
    const args = helperCompileArgs('consent-host', { sources: [source], binary, moduleCache: swiftModuleCache() })
      .filter(arg => mode === 'optimized' || arg !== '-O');
    const r = await run('/usr/bin/xcrun', args, { timeoutMs: 600000 });
    evidence.builds.push({ mode, args, code: r.code, bytes: r.code === 0 ? statSync(binary).size : null, stderr: r.stderr }); save();
    assert.equal(r.code, 0, r.stderr);
    for (const file of files) {
      const bytes = readFileSync(join(pack.folder, file.name));
      const result = await run(binary, ['--decode-sheet', String(file.width), String(file.height), file.name.endsWith('.png') ? 'png' : 'webp'], { bytes, binary: true });
      evidence.decodes.push({ mode, file, ...result }); save();
      assert.equal(result.code, 0); assert.equal(result.bytes, file.width * file.height * 4);
    }
    for (const [args, bytes, expected] of [
      [['--decode-sheet', '0', '1', 'png'], Buffer.alloc(0), 64],
      [['--decode-sheet', '1536', '2288', 'webp'], Buffer.from('invalid'), 65],
      [['--decode-sheet', '1', '1', 'webp'], readFileSync(join(pack.folder, 'extra.webp')), 66],
      [['--stage-cache-dump'], Buffer.from('{}\n'), 65],
      [['--stage-cache-dump'], Buffer.from('not-json\n'), 65],
    ]) {
      const result = await run(binary, args, { bytes });
      evidence.refusals.push({ mode, args, expected, ...result }); save(); assert.equal(result.code, expected);
    }
  }
  for (const file of files) {
    const rows = evidence.decodes.filter(row => row.file.name === file.name);
    assert.equal(rows[0].sha256, rows[1].sha256, file.name);
  }
  const input = [character.frame, { stageState: 'stage-lie' }, { stageAwait: true }].map(x => JSON.stringify(x) + '\n').join('');
  for (let trial = 1; trial <= 5; trial++) {
    const r = await run(binaries.optimized, ['--stage-cache-dump'], { bytes: Buffer.from(input), env: {
      SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: character.root,
      SLEIGHT_CURSOR_STAGE_ROOT: join(work, 'stage-cache'),
    } });
    const rows = r.stdout.trim().split('\n').map(JSON.parse);
    const last = rows.at(-1);
    evidence.firstStrips.push({ trial, code: r.code, rows, firstDecodeMs: last.firstDecodeMs, below40: last.firstDecodeMs < 40 }); save();
    assert.equal(r.code, 0, r.stderr); assert.equal(rows[0].loaded, true);
    assert.equal(last.decodes, 1);
  }
  evidence.summary = { matchingFiles: files.length, refusalChecks: evidence.refusals.length,
    firstStripMs: evidence.firstStrips.map(r => r.firstDecodeMs),
    below40: evidence.firstStrips.filter(r => r.below40).length,
    maxFirstStripMs: Math.max(...evidence.firstStrips.map(r => r.firstDecodeMs)) };
  save(); console.log(JSON.stringify(evidence.summary));
  assert.equal(evidence.summary.below40, 5, 'retain timings even when the 40 ms bar fails');
} finally { save(); }
