import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, FLAGS, LEGACY_ARMS, LEGACY_FLAGS, format, loadRows, plan, readManifest, scoreFlag } from '../bench/flag-ab.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const reasons = JSON.parse(readFileSync(new URL('../bench/claim-exclusions.json', import.meta.url), 'utf8')).reasons;
const claimTasks = readFileSync(new URL('../bench/claim-tasks.txt', import.meta.url), 'utf8').trim().split(',');
const row = (task, seconds, passed = true, extra = {}) => ({ arm: 'sleight', task, seconds, passed, models: ['claude-haiku-5-5'],
  sleightCommit: 'abc12345', sleightDirty: false, engineVersion: '26.1013.40934', ...extra });
// rows for one flag: every task of its arms, `rounds` runs a side, seconds from on(task, i) and off(task, i).
const flagRows = (flag, { rounds = 5, off = () => 20, on = () => 20, offPass = () => true, onPass = () => true } = {}) =>
  ARMS.filter(arm => arm.flags.includes(flag)).flatMap(arm => arm.tasks.flatMap(task => Array.from({ length: rounds }, (_, i) => [
    { arm: arm.id, side: 'off', round: i + 1, task, seconds: off(task, i), passed: offPass(task, i), commit: 'abc12345', dirty: false },
    { arm: arm.id, side: flag, round: i + 1, task, seconds: on(task, i), passed: onPass(task, i), commit: 'abc12345', dirty: false }]).flat()));
const jitter = (base, i) => base + [0, 2, -2, 1, -1][i % 5];

test('the plan alternates which side runs first, runs every native arm before Office, and sets one flag a side', () => {
  const lines = plan({ rounds: 2 });
  assert.equal(lines.length, 2 * (2 * 3 + 3));
  const firstOffice = lines.findIndex(l => l.arm === 'office');
  assert.ok(lines.slice(firstOffice).every(l => l.arm === 'office'), 'Office comes last');
  const sides = (round, arm) => lines.filter(l => l.round === round && l.arm === arm).map(l => l.side);
  assert.deepEqual(sides(1, 'open-shot'), ['off', 'open-shot']);
  assert.deepEqual(sides(2, 'open-shot'), ['open-shot', 'off']);
  assert.deepEqual(sides(1, 'office'), ['off', 'compact-toolbars', 'skill-screenshot']);
  assert.deepEqual(sides(2, 'office'), ['skill-screenshot', 'compact-toolbars', 'off']);
  const env = (arm, side) => lines.find(l => l.round === 1 && l.arm === arm && l.side === side).env;
  assert.equal(env('open-shot', 'off'), 'SLEIGHT_OPEN_SHOT=0');
  assert.equal(env('open-shot', 'open-shot'), 'SLEIGHT_OPEN_SHOT=1');
  assert.equal(env('office', 'off'), 'SLEIGHT_COMPACT_TOOLBARS=0 SLEIGHT_SCREENSHOT_READS=0');
  assert.equal(env('office', 'compact-toolbars'), 'SLEIGHT_COMPACT_TOOLBARS=1 SLEIGHT_SCREENSHOT_READS=0');
  assert.equal(env('office', 'skill-screenshot'), 'SLEIGHT_COMPACT_TOOLBARS=0 SLEIGHT_SCREENSHOT_READS=1');
  assert.equal(env('toolbars-text', 'off'), 'SLEIGHT_COMPACT_TOOLBARS=0');
  assert.equal(env('toolbars-text', 'compact-toolbars'), 'SLEIGHT_COMPACT_TOOLBARS=1');
  assert.equal(lines.find(l => l.arm === 'preview-read').runs, 2);
});

test('the plan takes a start round and an arm subset for top-ups, and refuses an unknown arm', () => {
  const lines = plan({ rounds: 2, start: 6, arms: ['office'] });
  assert.deepEqual(lines.map(l => `${l.round} ${l.side}`), ['6 skill-screenshot', '6 compact-toolbars', '6 off', '7 off', '7 compact-toolbars', '7 skill-screenshot']);
  assert.throws(() => plan({ arms: ['nope'] }), /unknown arm: nope/);
});

test('arms run held-out tasks, except preview-read, the native claim task sleight loses', () => {
  for (const arm of ARMS) for (const task of arm.tasks) assert.ok(!claimTasks.includes(task) || task === 'preview-read', task);
  assert.ok(ARMS.every(arm => !arm.tasks.includes('textedit-window-drag')), 'the drag harness cell fails both sides');
  for (const flag of Object.keys(FLAGS)) assert.ok(ARMS.some(arm => arm.flags.includes(flag)), flag);
});

test('the manifest reader skips the header and keeps a run that wrote no results', () => {
  const entries = readManifest('round\tarm\tside\texit\tstops\tresults\tlog\tcommit\n' +
    '1\toffice\toff\t1\t0\t/r/a.json\t/o/a.log\tabc\n2\toffice\tskill-screenshot\t1\t1\t\t/o/b.log\tabc\n');
  assert.deepEqual(entries.map(e => [e.round, e.arm, e.side, e.stops, e.results]), [[1, 'office', 'off', 0, '/r/a.json'], [2, 'office', 'skill-screenshot', 1, undefined]]);
});

test('loading drops other models, skipped rows and harness failures, and counts a cleanup-contained pass', () => {
  const files = {
    '/r/a.json': { results: [row('word-memo', 70), row('word-brief', 90, false, { cleanupContained: true, taskPassed: true }),
      row('word-memo', 60, true, { models: ['claude-haiku-4-5'] }), row('word-brief', null, false, { skipped: true }),
      row('word-memo', 1, false, { reason: 'Fixture setup failed: Word did not open' }), row('preview-read', 5), { ...row('word-memo', 9), arm: 'lcu' }] },
  };
  const entries = [{ round: 1, arm: 'office', side: 'off', results: '/r/a.json' }, { round: 1, arm: 'office', side: 'skill-screenshot' },
    { round: 1, arm: 'office', side: 'open-shot', results: '/r/a.json' }, { round: 2, arm: 'office', side: 'off', results: '/r/gone.json' }];
  const { rows, dropped, missing } = loadRows(entries, { reasons, read: path => { if (!files[path]) throw Error(`ENOENT ${path}`); return files[path]; } });
  assert.deepEqual(rows.map(r => [r.task, r.seconds, r.passed]), [['word-memo', 70, true], ['word-brief', 90, true]]);
  assert.equal(dropped['model claude-haiku-4-5'], 1);
  assert.equal(dropped.skipped, 1);
  assert.equal(dropped['task not in the arm'], 1);
  assert.match(Object.keys(dropped).join(), /fixture setup failed/);
  assert.deepEqual(missing.map(m => m.why), ['no results file', 'unknown arm or side', 'ENOENT /r/gone.json']);
});

test('expected time divides the mean attempt by the pass rate, and a clear win beyond the noise goes default on', () => {
  const rows = flagRows('skill-screenshot', { off: (t, i) => jitter(t === 'word-memo' ? 80 : 100, i), on: (t, i) => jitter(t === 'word-memo' ? 60 : 80, i),
    offPass: (t, i) => !(t === 'word-brief' && i === 0) });
  const s = scoreFlag('skill-screenshot', rows);
  const brief = s.tasks.find(t => t.task === 'word-brief');
  assert.equal(brief.off.passes, 4);
  assert.equal(brief.off.expected, 125);
  assert.equal(s.total.off, 205);
  assert.equal(s.total.on, 140);
  assert.equal(s.verdict, 'default on');
  assert.match(s.reasons[0], /faster by 65\.0 s/);
});

test('the shared Office "off" rows count for both flags, and other flags\' rows stay out', () => {
  const rows = [...flagRows('skill-screenshot', { on: () => 10 }), ...flagRows('compact-toolbars', { on: () => 30 }).filter(r => r.side !== 'off' || r.arm !== 'office')];
  const toolbars = scoreFlag('compact-toolbars', rows), skill = scoreFlag('skill-screenshot', rows);
  assert.equal(toolbars.tasks.find(t => t.task === 'word-memo').off.runs, 5);
  assert.equal(toolbars.tasks.find(t => t.task === 'word-memo').on.expected, 30);
  assert.equal(skill.tasks.find(t => t.task === 'word-memo').on.expected, 10);
  assert.equal(toolbars.verdict, 'remove');
  assert.equal(skill.verdict, 'default on');
});

test('no win at all removes the flag, even inside the noise', () => {
  const s = scoreFlag('open-shot', flagRows('open-shot', { off: (t, i) => jitter(20, i), on: (t, i) => jitter(20, i + 1) }));
  assert.equal(s.total.diff, 0);
  assert.equal(s.verdict, 'remove');
  assert.match(s.reasons[0], /^no win/);
});

test('a win inside the noise, a lost pass or one much slower task keeps the flag opt-in', () => {
  const noisy = scoreFlag('open-shot', flagRows('open-shot', { off: (t, i) => [10, 40, 15, 35, 25][i], on: (t, i) => [12, 36, 14, 33, 24][i] }));
  assert.equal(noisy.verdict, 'stay opt-in');
  assert.match(noisy.reasons[0], /inside the noise/);
  const lost = scoreFlag('open-shot', flagRows('open-shot', { on: () => 10, onPass: (t, i) => !(t === 'preview-pdf' && i === 2) }));
  assert.equal(lost.verdict, 'stay opt-in');
  assert.match(lost.reasons.join(), /preview-pdf passed 4\/5 with the flag against 5\/5/);
  const slower = scoreFlag('open-shot', flagRows('open-shot', {
    off: (t, i) => jitter(t === 'textedit-edit' ? 20 : 60, i), on: (t, i) => jitter(t === 'textedit-edit' ? 30 : 40, i) }));
  assert.equal(slower.verdict, 'stay opt-in');
  assert.match(slower.reasons.join(), /textedit-edit 30\.0 s against 20\.0 s \(\+50%/);
});

test('a flag that never passes a task the build passes is removed', () => {
  const s = scoreFlag('open-shot', flagRows('open-shot', { on: () => 5, onPass: t => t !== 'preview-pdf' }));
  assert.equal(s.total.on, null);
  assert.equal(s.verdict, 'remove');
  assert.match(s.reasons[0], /never passed preview-pdf with the flag/);
});

test('short runs, mixed commits or a dirty tree give no verdict', () => {
  const short = scoreFlag('skill-screenshot', flagRows('skill-screenshot', { rounds: 5 }).filter(r => !(r.side === 'skill-screenshot' && r.task === 'word-brief' && r.round > 2)));
  assert.equal(short.verdict, 'no verdict');
  assert.match(short.reasons[0], /short of 3 runs a side: word-brief \(off 5, on 2\)/);
  const mixed = flagRows('skill-screenshot', { on: () => 5 }); mixed[0].commit = 'def67890';
  assert.match(scoreFlag('skill-screenshot', mixed).reasons.join(), /2 commits/);
  const dirty = flagRows('skill-screenshot', { on: () => 5 }); dirty[1].dirty = true;
  assert.match(scoreFlag('skill-screenshot', dirty).reasons.join(), /dirty tree/);
});

test('the score command reads a manifest and prints each flag with its verdict', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-flag-ab-')));
  const lines = ['round\tarm\tside\texit\tstops\tresults\tlog\tcommit'];
  for (let r = 1; r <= 3; r++) for (const side of ['off', 'compact-toolbars', 'skill-screenshot']) {
    const file = join(dir, `${r}-${side}.json`), s = side === 'skill-screenshot' ? 50 : 90;
    writeFileSync(file, JSON.stringify({ results: [row('word-memo', s + r), row('word-brief', s + 2 * r)] }));
    lines.push([r, 'office', side, 0, 0, file, join(dir, 'x.log'), 'abc12345'].join('\t'));
  }
  writeFileSync(join(dir, 'manifest.tsv'), lines.join('\n') + '\n');
  const script = fileURLToPath(new URL('../bench/flag-ab.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [script, 'score', '--manifest', join(dir, 'manifest.tsv')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /9 invocations/);
  assert.match(out.stdout, /skill-screenshot \(SLEIGHT_SCREENSHOT_READS=1\), commit abc12345[\s\S]*verdict: default on\./);
  assert.match(out.stdout, /compact-toolbars[\s\S]*verdict: no verdict\. short of 3 runs a side: textedit-replace-all \(off 0, on 0\)/);
  const json = JSON.parse(spawnSync(process.execPath, [script, 'score', '--manifest', join(dir, 'manifest.tsv'), '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(json.scores.find(s => s.flag === 'skill-screenshot').total.on, 106);
});


test('the legacy fixture manifest reproduces all four historical score blocks and verdicts', () => {
  const entries = readManifest(readFileSync(new URL('fixtures/flag-ab-legacy.tsv', import.meta.url), 'utf8'));
  const read = path => {
    const [flag, round, side, arm] = path.split('/');
    const study = JSON.parse(readFileSync(new URL(`../docs/benchmarks/2026-10-19-flag-ab-${flag}.json`, import.meta.url), 'utf8'));
    const attempt = study.rounds.find(row => row.round === Number(round) && row.arm === side);
    return { results: attempt.results.filter(row => LEGACY_ARMS.find(a => a.id === arm).tasks.includes(row.task))
      .map(row => ({ ...row, arm: 'sleight' })) };
  };
  const { rows, dropped, missing } = loadRows(entries, { read, reasons, legacy: true });
  assert.deepEqual(dropped, {});
  assert.deepEqual(missing, []);
  const scores = Object.keys(LEGACY_FLAGS).map(flag => scoreFlag(flag, rows, { legacy: true }));
  assert.deepEqual(scores.map(s => s.verdict), ['default on', 'remove', 'stay opt-in', 'default on']);
  const page = readFileSync(new URL('../docs/benchmarks/2026-10-19-flag-ab.md', import.meta.url), 'utf8');
  const blocks = [...page.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]);
  assert.equal(blocks.length, 4);
  const printed = format(scores, { manifest: 'fixture.tsv', entries: entries.length, dropped, missing });
  assert.equal(printed.slice(printed.indexOf('\n\n') + 2), blocks.join('\n\n'));
});
