import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOldRuns } from '../bench/run-archive.mjs';
import * as archiveTools from '../bench/run-archive.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { loadRecording } from '../bench/replay/recording.mjs';

test('old run folders move to the archive with their traces; recent runs and other files stay', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-archive-')));
  const bench = join(root, 'sleight-bench'), archive = join(root, 'archive');
  const old = join(bench, '2026-10-09T01-38-31-540Z'), recent = join(bench, '2026-10-10T11-17-52-572Z');
  for (const dir of [old, recent]) { mkdirSync(join(dir, 'run-1'), { recursive: true }); writeFileSync(join(dir, 'run-1', 'trace.jsonl'), '{}\n'); }
  writeFileSync(join(bench, 'notes.txt'), 'x');
  const now = Date.now();
  utimesSync(old, new Date(now - 7 * 3600 * 1000), new Date(now - 7 * 3600 * 1000));
  assert.deepEqual(archiveOldRuns(bench, archive, { now }), ['2026-10-09T01-38-31-540Z']);
  assert.ok(existsSync(join(archive, '2026-10-09T01-38-31-540Z', 'run-1', 'trace.jsonl')));
  assert.ok(existsSync(recent) && existsSync(join(bench, 'notes.txt')));
  assert.deepEqual(archiveOldRuns(join(root, 'missing'), archive, { now }), []);
});

test('retention removes only old unreferenced images, keeping traces, results, links and recent runs', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-')));
  const docs = join(root, 'docs'), bank = join(root, 'archive'), evidence = join(root, 'home/Library/Caches/sleight-bench/evidence');
  const legacy = join(root, 'sleight-real-evidence');
  mkdirSync(docs); writeFileSync(join(docs, 'study.md'), 'bench/results/2026-09-01T10-00-00-000Z.json');
  const exclusions = join(root, 'exclusions.json'); writeFileSync(exclusions, '{"files":[{"prefix":"2026-09-02T10-00"}]}');
  const add = (base, stamp) => {
    const dir = join(base, stamp, 'arm'); mkdirSync(dir, { recursive: true });
    for (const name of ['screen.png', 'other.JPG', 'trace.jsonl', 'transcript.jsonl', 'result.json', 'saved.txt']) writeFileSync(join(dir, name), name);
    return dir;
  };
  const old = add(bank, '2026-09-03T10-00-00-000Z');
  const held = add(bank, '2026-09-04T10-00-00-000Z');
  const cited = add(bank, '2026-09-01T10-00-00-000Z'), excluded = add(bank, '2026-09-02T10-00-00-000Z');
  const recent = add(bank, '2026-10-17T10-00-00-000Z'), real = add(evidence, '2026-09-03T10-00-00-000Z');
  const oldLegacy = add(legacy, '2026-09-03T10-00-00-000Z');
  const recentEvidence = add(evidence, '2026-10-17T10-00-00-000Z');
  const citedEvidence = add(evidence, '2026-09-01T10-00-00-000Z');
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'screen.png'), 'keep');
  symlinkSync(outside, join(old, 'linked')); symlinkSync(outside, join(bank, '2026-08-01T10-00-00-000Z'));
  const options = { roots: [bank, evidence, legacy], docsDir: docs, exclusionsFile: exclusions, now: Date.parse('2026-10-17T12:00:00Z'), held: new Set([join(held, 'trace.jsonl')]), log() {} };
  assert.equal(typeof archiveTools.pruneRunImages, 'function', 'image retention is missing');
  const dry = archiveTools.pruneRunImages({ ...options, dryRun: true });
  assert.equal(dry.planned.length, 6); assert.equal(existsSync(join(old, 'screen.png')), true);
  const result = archiveTools.pruneRunImages(options);
  assert.equal(result.removed.length, 6); assert.equal(result.freedBytes, 3 * Buffer.byteLength('screen.pngother.JPG'));
  for (const dir of [old, real, oldLegacy]) {
    assert.equal(existsSync(join(dir, 'screen.png')), false); assert.equal(existsSync(join(dir, 'other.JPG')), false);
    for (const name of ['trace.jsonl', 'transcript.jsonl', 'result.json', 'saved.txt']) assert.equal(existsSync(join(dir, name)), true);
  }
  for (const dir of [held, cited, excluded, recent, recentEvidence, citedEvidence, outside]) assert.equal(existsSync(join(dir, 'screen.png')), true);
});

test('archiving fixture runs after six hours leaves durable transcripts discoverable', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-evidence-archive-')));
  const previous = process.env.BENCH_ARM_HOME; process.env.BENCH_ARM_HOME = join(root, 'home/Library/Caches/sleight-bench');
  t.after(() => { if (previous === undefined) delete process.env.BENCH_ARM_HOME; else process.env.BENCH_ARM_HOME = previous; });
  const stamp = '2026-10-25T01-00-00-000Z', leaf = 'sleight-textedit-window-drag-1';
  const bench = join(root, 'temp/sleight-bench'), run = join(bench, stamp), archive = join(process.env.BENCH_ARM_HOME, 'runs-archive');
  mkdirSync(join(run, leaf), { recursive: true }); writeFileSync(join(run, leaf, 'Source.txt'), 'fixture');
  const evidence = join(process.env.BENCH_ARM_HOME, 'evidence', stamp, leaf); mkdirSync(evidence, { recursive: true });
  const transcript = readFileSync(new URL('./fixtures/replay/claude.jsonl', import.meta.url), 'utf8');
  writeFileSync(join(evidence, 'transcript.jsonl'), transcript);
  const file = join(root, 'results.json'); writeFileSync(file, JSON.stringify({ stamp, results: [{ arm: 'sleight', task: 'textedit-window-drag', run: 1 }] }));
  const now = Date.now(); utimesSync(run, new Date(now - 6 * 3600 * 1000 - 1), new Date(now - 6 * 3600 * 1000 - 1));
  assert.deepEqual(archiveOldRuns(bench, archive, { now }), [stamp]);
  assert.ok(existsSync(join(archive, stamp, leaf, 'Source.txt')));
  assert.equal(loadRecording(file).folder, evidence);
  assert.equal(readFileSync(loadRecording(file).transcript, 'utf8'), transcript);
});

test('retention refuses deletion when reference files cannot be read', t => {
  assert.equal(typeof archiveTools.pruneRunImages, 'function', 'image retention is missing');
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-')));
  const result = archiveTools.pruneRunImages({ roots: [root], docsDir: join(root, 'missing'), exclusionsFile: join(root, 'missing.json'), held: new Set(), log() {} });
  assert.deepEqual(result.removed, []); assert.match(result.warning, /reference/);
});


test('retention scans all publication references and protects post-baseline result JSON for 30 days', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-'))), docs = join(root, 'docs'), bank = join(root, 'archive'), results = join(root, 'bench', 'results');
  mkdirSync(results, { recursive: true });
  for (const file of ['docs/benchmarks/nested/study.md', 'docs/design/nested/plan.md', 'docs/status/report.md', 'docs/benchmark.md', 'README.md', 'CHANGELOG.md']) {
    mkdirSync(join(root, file.split('/').slice(0, -1).join('/')), { recursive: true });
  }
  const stamps = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-10-02', '2026-09-07', '2026-10-03'];
  const files = ['docs/benchmarks/nested/study.md', 'docs/design/nested/plan.md', 'docs/status/report.md', 'docs/benchmark.md', 'README.md', 'CHANGELOG.md'];
  for (const [i, day] of stamps.entries()) {
    const stamp = day + 'T10-00-00-000Z', dir = join(bank, stamp); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'screen.png'), 'image');
    if (i < files.length) writeFileSync(join(root, files[i]), stamp);
    else writeFileSync(join(results, stamp + '.json'), JSON.stringify({ results: [] }));
  }
  const exclusions = join(root, 'bench', 'claim-exclusions.json'); writeFileSync(exclusions, JSON.stringify({ since: '2026-09-01T00-00' }));
  const result = archiveTools.pruneRunImages({ roots: [bank, bank], docsDir: join(docs, 'benchmarks'), exclusionsFile: exclusions,
    now: Date.parse('2026-10-17T12:00:00Z'), held: new Set(), log() {} });
  assert.deepEqual(result.removed.map(path => path.split('/').at(-2)), ['2026-09-07T10-00-00-000Z']);
  assert.equal(existsSync(join(bank, '2026-10-02T10-00-00-000Z', 'screen.png')), true);
});


test('nested non-Markdown publication references also retain run images', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-')));
  const docs = join(root, 'docs/benchmarks/nested'), bank = join(root, 'archive'), stamp = '2026-09-08T10-00-00-000Z';
  mkdirSync(docs, { recursive: true }); mkdirSync(join(root, 'bench'));
  writeFileSync(join(docs, 'references.json'), JSON.stringify({ result: stamp }));
  const exclusions = join(root, 'bench/claim-exclusions.json'); writeFileSync(exclusions, '{}');
  mkdirSync(join(bank, stamp), { recursive: true }); writeFileSync(join(bank, stamp, 'screen.png'), 'image');
  const result = archiveTools.pruneRunImages({ roots: [bank], docsDir: join(root, 'docs/benchmarks'), exclusionsFile: exclusions,
    now: Date.parse('2026-10-17T12:00:00Z'), held: new Set(), log() {} });
  assert.deepEqual(result.removed, []);
});


test('keep-temp prevents image pruning and even inventory or reference reads', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-'))), stamp = '2026-09-08T10-00-00-000Z';
  const dir = join(root, stamp); mkdirSync(dir); const image = join(dir, 'screen.png'); writeFileSync(image, 'image');
  const previous = process.env.SLEIGHT_KEEP_TEMP;
  try {
    process.env.SLEIGHT_KEEP_TEMP = '1';
    const result = archiveTools.pruneRunImages({ roots: [root], inventory: () => assert.fail('keep-temp must not inventory'), log() {} });
    assert.deepEqual(result, { planned: [], removed: [], freedBytes: 0 });
    assert.equal(existsSync(image), true);
  } finally { if (previous === undefined) delete process.env.SLEIGHT_KEEP_TEMP; else process.env.SLEIGHT_KEEP_TEMP = previous; }
});
