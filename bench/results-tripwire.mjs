// Offline publication of partial tripwire banks. This module never launches a runner or writes evidence.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadRound } from './fowl/race-score.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const unique = values => [...new Set(values.filter(Boolean))].sort();
const lowerMedian = values => values.sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
const native = kind => ['native-haiku', 'cc-haiku'].includes(kind);
// First-cycle limits, from release-ab/smoke/policy.mjs. Later rounds have different limits.
const smokeLimits = { 'chrome-haiku': .08, 'native-haiku': .425, 'cc-haiku': .347, 'as3-safari': .227 };
const armOf = side => `build-${side}`;
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export function collectTripwire(bank, { scrub, dateRange, cellsFor }) {
  const { dir, id, schedule, identity } = bank;
  const savedFile = join(dir, 'verdict.json'), saved = existsSync(savedFile) ? read(savedFile) : null;
  if (saved && !isDeepStrictEqual(saved.identity, identity)) throw Error(`${id}: gate identity disagrees`);
  const exclusionsFile = join(dir, 'exclusions.json');
  const exclusions = existsSync(exclusionsFile) ? read(exclusionsFile).entries : [];
  const isExcluded = (kind, task, side) => exclusions.some(e => e.kinds.includes(kind) && e.task === task && e.sides.includes(side));
  const runs = [], excludedRuns = [], steps = [], engines = [], modelRows = [], files = [], stamps = [];
  for (const step of schedule) {
    const file = join(dir, `${step.id}.receipt.json`);
    if (!existsSync(file)) { steps.push({ ...step, status: 'not run', reason: 'Bank stopped before this step.' }); continue; }
    const r = read(file);
    if (['id', 'side', 'kind'].some(key => r[key] !== step[key]) || r.build !== identity.builds[step.side]) throw Error(`${id}/${step.id}: receipt identity mismatch`);
    files.push({ file: basename(file), sha256: digest(file) });
    stamps.push(r.endedAt ?? r.startedAt);
    for (const e of [r.engine, r.engineEnd].filter(Boolean)) engines.push(`${e.version} build ${e.build}`);
    const excluded = r.outcome === 'excluded';
    steps.push({ ...step, status: excluded ? 'excluded' : r.rc === 0 ? 'completed' : 'stopped', rc: r.rc,
      reason: scrub(r.reason ?? (excluded ? 'Task excluded on both sides.' : '')), attempt: r.attempt ?? 1 });
    if (excluded) continue;
    let path = r.result ? join(dir, basename(r.result)) : null;
    // A stopped native runner logs its retained result before the queue can copy it into the bank.
    if ((!path || !existsSync(path)) && native(step.kind)) {
      const log = join(dir, `${step.id}.log`);
      const match = existsSync(log) && /^results: (.+\.json)$/m.exec(readFileSync(log, 'utf8'));
      if (match && r.root && resolve(match[1]) === resolve(r.root, 'bench/results', basename(match[1])) && existsSync(match[1])) path = match[1];
    }
    if (!path || !existsSync(path)) {
      if (r.rc === 0) throw Error(`${id}/${step.id}: completed result missing`);
      continue;
    }
    let rows, raw;
    if (native(step.kind)) {
      raw = read(path);
      if (raw.sleight?.commit && raw.sleight.commit !== r.build) throw Error(`${id}/${step.id}: result build mismatch`);
      rows = raw.results.filter(row => row.arm === 'sleight').map(row => ({ ...row, passed: !!(row.passed || row.cleanupContained && row.taskPassed) }));
    } else {
      raw = read(join(path, 'results.json'));
      rows = loadRound(path).rows;
    }
    const expected = step.tasks.split(',');
    if (rows.some(row => !expected.includes(row.task)) || expected.some(task => rows.filter(row => row.task === task).length > 1) ||
        r.rc === 0 && expected.filter(task => !isExcluded(step.kind, task, step.side)).some(task => !rows.some(row => row.task === task)))
      throw Error(`${id}/${step.id}: missing or duplicate scheduled task`);
    const dataFile = native(step.kind) ? path : join(path, 'results.json');
    files.push({ file: `${step.id}/${basename(dataFile)}`, sha256: digest(dataFile) });
    const flag = (r.command ?? []).indexOf('--effort');
    for (const row of rows) {
      if (!Number.isFinite(row.seconds) || row.seconds < 0) throw Error(`${id}/${step.id}: invalid seconds`);
      const original = native(step.kind) ? row : raw.find(r => r.task.name === row.task);
      const models = native(step.kind) ? row.models ?? [] : Object.keys(original.run?.result?.modelUsage ?? {});
      const effort = flag >= 0 ? r.command[flag + 1] : raw.effort;
      modelRows.push({ kind: step.kind, arm: armOf(step.side), models, effort });
      const result = { task: row.task, arm: armOf(step.side), kind: step.kind, round: step.id, run: row.run ?? null,
        seconds: row.seconds, passed: row.passed, models, effort: effort ?? null,
        problem: row.passed ? null : scrub(row.reason ?? row.problems?.join('; ') ?? 'failed'),
        file: basename(dataFile), receiptStatus: r.rc === 0 ? 'completed' : 'stopped' };
      (isExcluded(step.kind, row.task, step.side) ? excludedRuns : runs).push(result);
    }
  }
  const archived = join(dir, 'aborted');
  const aborted = existsSync(archived) ? readdirSync(archived, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
    const folder = join(archived, e.name);
    return readdirSync(folder).filter(name => name.endsWith('.receipt.json')).map(name => {
      const r = read(join(folder, name));
      return { step: r.id, side: r.side, kind: r.kind, rc: r.rc, reason: scrub(r.reason ?? 'Aborted attempt.'), file: `${e.name}/${name}` };
    });
  }) : [];
  const date = dateRange(identity.startedAt, stamps.filter(Boolean).sort().at(-1));
  const engine = unique(engines).join(', '), arms = ['build-B', 'build-A'], studies = [], groups = [];
  for (const kind of unique(schedule.map(s => s.kind))) {
    const own = runs.filter(r => r.kind === kind), tasks = unique(own.map(r => r.task));
    const comparable = tasks.filter(task => arms.every(arm => own.some(r => r.task === task && r.arm === arm && r.passed)));
    const total = (arm, passing) => comparable.reduce((sum, task) => {
      const selected = own.filter(r => r.task === task && r.arm === arm && (!passing || r.passed)).map(r => r.seconds);
      return sum + (passing ? lowerMedian(selected) : selected.reduce((a, b) => a + b, 0) / selected.length);
    }, 0);
    const gate = saved?.verdicts.find(v => v.kind === kind);
    const pass = arm => own.filter(r => r.arm === arm && r.passed).length;
    if (gate && (Math.abs(gate.aTotal - total('build-A', false)) > 1e-6 || Math.abs(gate.bTotal - total('build-B', false)) > 1e-6 ||
        gate.passA !== pass('build-A') || gate.passB !== pass('build-B'))) throw Error(`${id}/${kind}: gate totals disagree with receipts`);
    groups.push({ kind, status: gate ? gate.reasons.length ? 'miss' : 'pass' : own.length ? 'incomplete' : 'not run',
      passA: pass('build-A'), passB: pass('build-B'), runsA: own.filter(r => r.arm === 'build-A').length, runsB: own.filter(r => r.arm === 'build-B').length,
      comparable: comparable.length, aPassingTotal: comparable.length ? total('build-A', true) : null, bPassingTotal: comparable.length ? total('build-B', true) : null,
      aTotal: gate?.aTotal ?? null, bTotal: gate?.bTotal ?? null, slowdown: gate?.slowdown ?? null, limit: gate?.limit ?? smokeLimits[kind] ?? null, reasons: gate?.reasons ?? [] });
    if (!own.length) continue;
    const facts = modelRows.filter(r => r.kind === kind);
    studies.push({ id: `${id}-${kind}`, bank: id, kind: 'tripwire', group: kind, family: 'validation', title: `1.6.0 tripwire: ${id}, ${kind}`,
      date, engine, browser: kind.startsWith('chrome') ? 'chrome' : kind.includes('safari') ? 'safari' : kind.includes('firefox') ? 'firefox' : null,
      me: 'build-B', arms, tasks, models: Object.fromEntries(arms.map(arm => [arm, unique(facts.filter(r => r.arm === arm).flatMap(r => r.models))])),
      effortBySide: Object.fromEntries(arms.map(arm => [arm, unique(facts.filter(r => r.arm === arm).map(r => r.effort))])), effort: unique(facts.map(r => r.effort)),
      builds: Object.fromEntries(arms.map(arm => [arm, [identity.builds[arm.at(-1)].slice(0, 8)]])),
      runs: own, cells: cellsFor(own, tasks, arms, 'build-B').cells });
  }
  return { record: { id, kind: 'tripwire', source: `<private-evidence>/${id}`, complete: false, date, engine,
    aBuild: identity.builds.A.slice(0, 8), bBuild: identity.builds.B.slice(0, 8), groups: studies.length, incomplete: [],
    tripwire: { identity, groups, steps, exclusions: exclusions.map(e => ({ task: e.task, kinds: e.kinds, sides: e.sides, reason: scrub(e.reason) })),
      excludedRuns, aborted, files, savedGate: saved ? { verdicts: saved.verdicts, errors: saved.errors } : null } }, studies };
}
