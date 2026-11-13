// Offline counterfactual for CHRET1's saved inputs. Never starts an application or decoder.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditStageTrace } from '../../tests/fixtures/stage-stateful-fuzz.mjs';

export function liveFixtureWorld(source) {
  const from = 'above: windows[..<i].filter { $0.visible }.map { $0.rect }';
  if (source.split(from).length !== 2) throw Error('expected one legacy stage-dump world');
  // The live fixture's windows share the renderer PID. perchWorld excludes that PID.
  // Only this private diagnostic copy uses the live fixture's empty above list.
  return source.replace(from, 'above: []');
}
export function savedSampleCounts(rows, sampleTimes) {
  const counts = {}, stats = rows.filter(r => r.effect === 'stage-stats');
  let i = 0, current;
  for (const t of sampleTimes) {
    while (i < stats.length && stats[i].time <= t + 1e-9) current = stats[i++];
    if (!current) throw Error('saved sample precedes replay');
    const rung = current.shown ? current.presented?.rung : 'hidden';
    // Legacy stats have no draw. Find the most recent plan at that timestamp.
    const key = rung ?? [...rows].reverse().find(r => r.effect === 'stage' && r.time <= current.time + 1e-9)?.rung;
    if (!key) throw Error('visible legacy sample lacks a plan');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
export function legacyStageWorldCheck({ sourceFile, study, receipts, output }) {
  const source = readFileSync(sourceFile, 'utf8');
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw Error('oversized source');
  mkdirSync(output, { recursive: true });
  const results = [], sourceSHA256 = createHash('sha256').update(source).digest('hex');
  for (const [name, text] of [['original-world', source], ['live-fixture-world', liveFixtureWorld(source)]]) {
    const file = join(output, `${name}.swift`), binary = join(output, name);
    writeFileSync(file, text);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(output, 'modules'), file, '-o', binary],
      { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
    if (built.status !== 0) throw Error(`compile ${name}: ${built.status} ${built.stderr}`);
    for (const arm of ['lifecycle', 'stress']) {
      const saved = readFileSync(join(study, `${arm}-input.jsonl`), 'utf8');
      const lines = saved.trim().split('\n');
      lines.splice(1, 0, JSON.stringify({ dumpTrace: true })); lines.push(JSON.stringify({ dumpTraceRead: true }));
      const input = lines.join('\n') + '\n';
      if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw Error('oversized replay input');
      const run = spawnSync(binary, ['--stage-dump', '--through-ring'], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        timeout: 90000, killSignal: 'SIGKILL' });
      if (run.status !== 0) throw Error(`replay ${name}/${arm}: ${run.status} ${run.stderr}`);
      const rows = run.stdout.trim().split('\n').map(JSON.parse);
      const live = JSON.parse(readFileSync(join(receipts, arm, 'stage-cost.json'))).runs[0].sizes.stage;
      const marks = live.marks.quiet;
      const samples = live.samples.quiet.filter(s => s.t >= marks.start && s.t <= marks.activeEnd);
      const times = samples.map(s => (s.t - marks.start) / 1000);
      const counts = savedSampleCounts(rows, times);
      const trace = rows.find(r => r.effect === 'stage-trace');
      if (!trace?.complete) throw Error('incomplete visibility audit trace');
      const audit = auditStageTrace(trace);
      if (audit.errors.length) throw Error('visibility audit: ' + JSON.stringify(audit));
      results.push({ world: name, arm, samples: times.length, counts, hidden: counts.hidden ?? 0,
        liveHidden: samples.filter(s => !s.status.shown).length, audit, sourceSHA256, windowsCreated: 0 });
    }
  }
  const result = { sourceSHA256, changedInputs: 'headless above list only', results, liveRun: false };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceFile, study, receipts, output] = process.argv.slice(2);
  if (!sourceFile || !study || !receipts || !output) throw Error('need source file, study bank, saved receipt bank and output directory');
  console.log(JSON.stringify(legacyStageWorldCheck({ sourceFile, study, receipts, output }), null, 2));
}
