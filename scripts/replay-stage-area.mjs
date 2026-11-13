// Offline CA-1 to CA-4 comparison. Each native child uses the geometry-only dump, never NSApplication.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installStageCharacter, replayStageSequence } from '../bench/hand/stage-live.mjs';
import { liveFixtureWorld, savedSampleCounts } from '../bench/hand/legacy-stage-world-check.mjs';
import { stageTraceFigures, stageReplayReceipt, stageReplayLines, compareStageReplay } from '../bench/hand/stage-trace.mjs';
import { auditStageTrace } from '../tests/fixtures/stage-stateful-fuzz.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
export function areaReplaySamples(rows, times) {
  return times.map(t => rows.findLast(r => r.time <= t + 1e-9)?.shown ?? false);
}
export async function replayStageArea({ baseline, study, receipts, output }) {
  mkdirSync(output, { recursive: true });
  const current = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const sources = { before: readFileSync(baseline, 'utf8'), after: current };
  const result = { windowsCreated: 0, captures: 0, liveRun: false, sources: {}, basic: [], recorded: [] };
  const build = (name, source) => {
    const file = join(output, name + '.swift'), binary = join(output, name);
    writeFileSync(file, source); result.sources[name] = hash(source);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(output, 'modules'), file, '-o', binary],
      { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
    assert.equal(built.status, 0, built.stderr); return binary;
  };
  const dump = (binary, lines, ring = true) => {
    const r = spawnSync(binary, ['--stage-dump', ...ring ? ['--through-ring'] : []], {
      input: lines.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr || r.stdout.slice(-2000));
    return r.stdout.trim().split('\n').map(JSON.parse);
  };
  const character = installStageCharacter(output).frame;
  for (const [side, source] of Object.entries(sources)) {
    const binaries = { original: build(side, source), fixture: build(side + '-fixture', liveFixtureWorld(source)) };
    for (const stress of [false, true]) {
      const replay = await replayStageSequence(binaries.original, character, { root: output, stress });
      const samples = areaReplaySamples(replay.samples, Array.from({ length: 62 }, (_, i) => i));
      result.basic.push({ side, stress, visible: samples.filter(Boolean).length, samples: samples.length,
        visibleShare: samples.filter(Boolean).length / samples.length });
    }
    for (const name of ['headless-lifecycle', 'headless-stress', 'check3-original-world-lifecycle', 'check3-original-world-stress',
      'check3-live-fixture-world-lifecycle', 'check3-live-fixture-world-stress']) {
      const raw = readFileSync(join(study, name + '-input.jsonl'), 'utf8');
      const lines = raw.trim().split('\n').map(JSON.parse), frame = lines[0];
      const binary = name.includes('live-fixture') ? binaries.fixture : binaries.original;
      const rows = dump(binary, lines), trace = rows.find(r => r.effect === 'stage-trace');
      assert.equal(trace?.complete, true, 'complete geometry journal');
      const audit = auditStageTrace(trace);
      assert.deepEqual(audit.errors, [], name + ' protected intersections');
      const times = name.startsWith('check3') ? (() => {
        const arm = name.endsWith('stress') ? 'stress' : 'lifecycle';
        const data = JSON.parse(readFileSync(join(receipts, arm, 'stage-cost.json'))).runs[0].sizes.stage;
        const m = data.marks.quiet;
        return data.samples.quiet.filter(s => s.t >= m.start && s.t <= m.activeEnd).map(s => (s.t - m.start) / 1000);
      })() : Array.from({ length: 62 }, (_, i) => i);
      const figures = stageTraceFigures(trace, { start: 0, end: 61, sampleTimes: times });
      const counts = name.startsWith('check3') ? savedSampleCounts(rows, times) : figures.samples;
      const scenario = name.endsWith('stress') ? 'full-window-scroll-stress' : 'small-target-turn-lifecycle';
      const receipt = stageReplayReceipt({ frame, trace, scenario });
      const replay = dump(binary, stageReplayLines(receipt), false).find(r => r.effect === 'stage-trace');
      assert.deepEqual(compareStageReplay(trace, replay).mismatches, [], 'exact transaction replay');
      const row = { name, side, inputSha256: hash(raw), figures, samples: times.length, counts,
        visible: times.length - (counts.hidden ?? 0), visibleShare: 1 - (counts.hidden ?? 0) / times.length,
        audit, transactions: trace.records.length, journalBytes: trace.bytes, exactReplay: true,
        staleHides: trace.records.filter(r => r.output.hiddenReason === 'stale-window').length };
      result.recorded.push(row);
      writeFileSync(join(output, side + '-' + name + '.json'), JSON.stringify(trace));
    }
  }
  writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baseline, study, receipts, output] = process.argv.slice(2);
  assert.ok(baseline && study && receipts && output, 'need baseline source, saved study, check-3 receipts and private output');
  console.log(JSON.stringify(await replayStageArea({ baseline, study, receipts, output })));
}
