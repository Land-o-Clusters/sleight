import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainedBank } from './helpers/retained-bank.mjs';
import { fileURLToPath } from 'node:url';
import { currentTimeline, dayRange, engineForRun, engineNote, refreshTimeline, engineMix, engineSpan, engineText, inferEngine, loadTimeline, passRowEngine, readEngine,
  stampMs, summarizeEngines, usesEngine } from '../bench/engine-version.mjs';
import { loadRound } from '../bench/fowl/race-score.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const timeline = loadTimeline();
const at = '2026-10-19T05:00:00.000Z', now = () => new Date(at);
const cache = version => ({ version, configPath: `/x/${version}/.mcp.json`, command: 'node', args: [], env: {} });

test('a read takes the doctor\'s engine folder and the app\'s Info.plist, and never throws', () => {
  const plist = app => (app === '/Applications/ChatGPT.app' ? { version: '26.1013.40934', build: '20770' } : null);
  assert.deepEqual(readEngine({ env: {}, resolve: () => cache('26.1013.40934'), plist, now }),
    { version: '26.1013.40934', source: 'codex-plugin-cache', at, chatgptApp: '26.1013.40934', chatgptBuild: '20770' });
  // The doctor's fallback to the engine inside the app reports the app's version, or 'bundle' when the plist can't be read.
  assert.equal(readEngine({ env: {}, resolve: () => ({ ...cache('26.1013.40934'), fromChatGPTApp: true }), plist, now }).source, 'chatgpt-app');
  assert.equal(readEngine({ env: {}, resolve: () => ({ ...cache('bundle'), fromChatGPTApp: true }), plist, now }).version, null);
  const missing = readEngine({ env: { SLEIGHT_CHATGPT_APP: '/nowhere' }, resolve: () => ({ error: 'no Codex computer-use plugin' }), plist, now });
  assert.deepEqual(missing, { version: null, source: null, at, error: 'no Codex computer-use plugin', chatgptApp: null, chatgptBuild: null });
  assert.equal(readEngine({ resolve: () => { throw Error('unreadable'); }, plist, now }).error, 'unreadable');
  assert.equal('chatgptApp' in readEngine({ resolve: () => cache('1.2.3'), app: false, now }), false);
});

test('the real read on this Mac is pure and quick', t => {
  const started = Date.now(), read = readEngine();
  assert.ok(Date.now() - started < 2000);
  if (!read.version) { t.skip(`no engine on this Mac (${read.error})`); return; }
  assert.match(read.version, /^\d+(\.\d+)+$/);
  // Since Codex's 2026-11-10 update the cache can hold a disabled stub, and the engine comes from the ChatGPT app.
  assert.ok(['codex-plugin-cache', 'chatgpt-app'].includes(read.source), read.source);
});

test('a span flags a change between the start and end reads, dated by both reads', () => {
  const a = { version: '26.1007.71326', chatgptApp: '26.1007.71326', chatgptBuild: '1', at: '2026-10-18T21:40:00Z' };
  const b = { version: '26.1013.40934', chatgptApp: '26.1013.40934', chatgptBuild: '2', at: '2026-10-18T21:50:00Z' };
  assert.deepEqual(engineSpan(a), { version: a.version, startedAt: a.at, start: a, changed: null });
  assert.deepEqual(engineSpan(a, { ...a, at: b.at }), { version: a.version, startedAt: a.at, endedAt: b.at, start: a, end: { ...a, at: b.at }, changed: false });
  assert.deepEqual(engineSpan(a, b), { version: null, startedAt: a.at, endedAt: b.at, start: a, end: b, changed: true });
  assert.equal(engineSpan(a, { ...a, chatgptBuild: '3' }).changed, true);
});

test('the timeline is ordered, each switch window is open before its first sighting, and every version has evidence', () => {
  const v = timeline.versions;
  assert.ok(v.length >= 7);
  assert.equal(v[0].switchedAfterUTC, null);
  for (let i = 0; i < v.length; i++) {
    assert.match(v[i].version, /^26\.\d+\.\d+$/);
    assert.ok(v[i].evidence.length >= 2, v[i].version);
    assert.ok(!Number.isNaN(Date.parse(v[i].firstSeenUTC)));
    if (i === 0) continue;
    assert.ok(Date.parse(v[i].switchedAfterUTC) < Date.parse(v[i].firstSeenUTC), v[i].version);
    assert.ok(Date.parse(v[i - 1].firstSeenUTC) <= Date.parse(v[i].switchedAfterUTC), v[i].version);
  }
  assert.ok(Date.parse(v.at(-1).firstSeenUTC) < Date.parse(timeline.checkedUTC));
  assert.equal(v.at(-1).version, '26.1013.40934');
  assert.equal(v.find(x => x.version === '26.1013.40934').firstSeenUTC, '2026-10-18T21:47:50Z');
});

test('a run is inferred inside one version, ambiguous across or inside a switch, unknown outside the timeline', () => {
  assert.deepEqual(inferEngine('2026-10-18T21:31:10Z', '2026-10-18T21:41:39Z', timeline), { version: '26.1007.71326', provenance: 'inferred' });
  assert.deepEqual(inferEngine('2026-10-18T21:53:32Z', '2026-10-18T22:16:48Z', timeline), { version: '26.1013.40934', provenance: 'inferred' });
  const across = inferEngine('2026-10-18T21:42:06Z', '2026-10-18T21:53:01Z', timeline);
  assert.equal(across.provenance, 'ambiguous');
  assert.deepEqual(across.candidates, ['26.1007.71326', '26.1013.40934']);
  assert.match(across.reason, /to 26\.1013\.40934 between 2026-10-18T21:47:29Z and 2026-10-18T21:47:50Z/);
  // Inside the 2026-10-11 window: the folder says 16:45Z, the last read of the old version was 15:29Z.
  assert.deepEqual(inferEngine('2026-10-11T16:00:00Z', undefined, timeline).candidates, ['26.1007.21159', '26.1007.30912']);
  assert.deepEqual(inferEngine('2026-10-10T06:00:00Z', '2026-10-11T17:00:00Z', timeline).candidates, ['26.1002.52244', '26.1007.21159', '26.1007.30912']);
  // The edges of a window belong to the version on their side.
  assert.equal(inferEngine('2026-10-18T21:47:29Z', undefined, timeline).version, '26.1007.71326');
  assert.equal(inferEngine('2026-10-18T21:47:50Z', undefined, timeline).version, '26.1013.40934');
  assert.equal(inferEngine('2026-10-02T12:00:00Z', undefined, timeline).provenance, 'unknown');
  assert.match(inferEngine('2026-11-01T00:00:00Z', undefined, timeline).reason, /after the timeline's last check/);
  assert.equal(inferEngine(Date.parse('2026-10-15T00:00:00Z'), undefined, timeline).version, '26.1007.71326');
});

test('the timeline agrees with every engine version a benchmark file recorded with its start time', () => {
  const dir = join(repo, 'docs/benchmarks'), checked = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    let raw; try { raw = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    const version = [raw.engineVersion, raw.engine, raw.meta?.engineVersion].find(v => typeof v === 'string' && /^26\./.test(v));
    const started = [raw.started, raw.date, raw.at].find(v => typeof v === 'string' && /T\d\d:/.test(v));
    if (!version || !started) continue;
    const inferred = inferEngine(started, undefined, timeline);
    checked.push(name);
    if (inferred.provenance === 'inferred') assert.equal(inferred.version, version, name);
    else assert.ok(inferred.candidates?.includes(version), `${name}: ${version} at ${started} gives ${JSON.stringify(inferred)}`);
  }
  assert.ok(checked.length >= 60, `only ${checked.length} files checked`);
});

test('a run\'s own read wins, a changed span falls back to the timeline, and every result carries its UTC dates', () => {
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  assert.deepEqual(engineForRun({ recorded: '26.1013.40934', startMs: t0, endMs: t0 + 60000 }, timeline),
    { version: '26.1013.40934', provenance: 'recorded', startedAt: '2026-10-05T00:00:00.000Z', endedAt: '2026-10-05T00:01:00.000Z', dated: 'recorded' });
  assert.deepEqual(engineForRun({ recorded: '26.1013.40934' }, timeline), { version: '26.1013.40934', provenance: 'recorded' });
  const start = { version: '26.1007.71326', at: '2026-10-18T21:40:00.000Z' }, end = { version: '26.1013.40934', at: '2026-10-18T21:55:00.000Z' };
  // A span alone dates the run by its two reads.
  assert.deepEqual(engineForRun({ recorded: engineSpan(start, { ...start, at: end.at }) }, timeline),
    { version: start.version, provenance: 'recorded', startedAt: start.at, endedAt: end.at, dated: 'recorded' });
  assert.equal(engineForRun({ recorded: engineSpan(start) }, timeline).endedAt, start.at);
  const span = engineSpan(start, end);
  assert.deepEqual(engineForRun({ recorded: span, startMs: Date.parse('2026-10-18T21:50:00Z') }, timeline),
    { version: '26.1013.40934', provenance: 'inferred', changedMidRun: true, startedAt: '2026-10-18T21:50:00.000Z', endedAt: '2026-10-18T21:50:00.000Z', dated: 'recorded' });
  assert.deepEqual(engineForRun({ recorded: span, startMs: Date.parse('2026-10-18T21:47:05Z'), endMs: Date.parse('2026-10-18T21:48:01Z') }, timeline).candidates,
    ['26.1007.71326', '26.1013.40934']);
  // A span with no version read (no engine on that Mac) says nothing about the version, so the timeline decides.
  assert.equal(engineForRun({ recorded: engineSpan({ version: null }), startMs: Date.parse('2026-10-15T00:00:00Z') }, timeline).provenance, 'inferred');
  assert.equal(engineForRun({ startMs: Date.parse('2026-10-15T00:00:00Z'), dated: 'inferred' }, timeline).dated, 'inferred');
  assert.deepEqual(engineForRun({}, timeline), { version: null, provenance: 'unknown', reason: 'no read and no start time' });
});

test('a pass row is dated by its finishedAt, and an older row by its pass\'s stamp and last save, marked inferred', () => {
  assert.equal(stampMs('2026-10-18T21-31-10-853Z.json'), Date.parse('2026-10-18T21:31:10.853Z'));
  const raw = { stamp: '2026-10-18T21-40-00-000Z', results: [{ seconds: 60 }, { seconds: 60 }] };
  const old = passRowEngine(raw, raw.results[0], { timeline });
  assert.deepEqual([old.version, old.startedAt, old.endedAt, old.dated], ['26.1007.71326', '2026-10-18T21:40:00.000Z', '2026-10-18T21:42:00.000Z', 'inferred']);
  assert.equal(passRowEngine(raw, raw.results[0], { timeline, mtimeMs: Date.parse('2026-10-18T22:00:00Z') }).provenance, 'ambiguous');
  assert.equal(passRowEngine({ ...raw, engine: engineSpan({ version: '9.9.9' }) }, raw.results[0], { timeline }).version, '9.9.9');
  const row = passRowEngine(raw, { engineVersion: '9.9.8', seconds: 30, finishedAt: '2026-10-19T06:00:30.000Z' }, { timeline });
  assert.deepEqual(row, { version: '9.9.8', provenance: 'recorded', startedAt: '2026-10-19T06:00:00.000Z', endedAt: '2026-10-19T06:00:30.000Z', dated: 'recorded' });
});

test('summaries give each arm its versions with UTC dates, read "not used" off the engine, and flag mixed versions among engine arms', () => {
  const run = (version, provenance, day, dated = 'recorded') => ({ version, provenance, startedAt: `${day}T10:00:00.000Z`, endedAt: `${day}T10:01:00.000Z`, dated });
  const byArm = summarizeEngines([{ arm: 'sleight', engine: run('26.1007.71326', 'inferred', '2026-10-18', 'inferred') },
    { arm: 'sleight', engine: run('26.1013.40934', 'recorded', '2026-10-19') }, { arm: 'sleight', engine: run('26.1013.40934', 'recorded', '2026-10-20') },
    { arm: 'sleight', engine: { ...run(null, 'ambiguous', '2026-10-18'), candidates: [] } }, { arm: 'lcu', engine: run('26.1013.40934', 'inferred', '2026-10-19') },
    { arm: 'codex', engine: run('26.1007.71326', 'inferred', '2026-10-18') }, { arm: 'codex', engine: { version: null, provenance: 'unknown' } }]);
  assert.equal(engineText(byArm.sleight, 'sleight'), 'engine 26.1007.71326 (1 inferred), 2026-10-18 (dates inferred) plus ' +
    'engine 26.1013.40934 (2 recorded), 2026-10-19 to 2026-10-20 plus 1 ambiguous, 2026-10-18');
  assert.equal(engineText(byArm.codex, 'codex'), 'engine 26.1007.71326 (1 inferred), 2026-10-18 plus 1 unknown, no date');
  assert.equal(engineText(byArm.lcu, 'lcu'), 'not used, 2026-10-19');
  assert.equal(engineText(undefined, 'sleight'), 'not recorded');
  assert.deepEqual(engineMix(byArm), { versions: ['26.1007.71326', '26.1013.40934'], arms: { sleight: ['26.1007.71326', '26.1013.40934'], codex: ['26.1007.71326'] } });
  assert.equal(engineMix(summarizeEngines([{ arm: 'sleight', engine: run('a', 'recorded', '2026-10-19') }, { arm: 'lcu', engine: run('b', 'recorded', '2026-10-19') }])), null);
  assert.equal(usesEngine('codex-sleight-sol') && usesEngine('sleight-turbo') && !usesEngine('claude-cu') && !usesEngine('fowlbrowser'), true);
  assert.equal(dayRange('2026-10-18T23:59:00Z', '2026-10-19T00:01:00Z'), '2026-10-18 to 2026-10-19');
});

test('the timeline runs through now while this Mac still has its last version', () => {
  const last = timeline.versions.at(-1).version;
  assert.equal(currentTimeline({ timeline, read: () => ({ version: last, chatgptApp: last, at }) }).checkedUTC, at);
  assert.equal(currentTimeline({ timeline, read: () => ({ version: '27.1.1', chatgptApp: '27.1.1', at }) }).checkedUTC, timeline.checkedUTC);
  assert.equal(currentTimeline({ timeline, read: () => ({ version: last, chatgptApp: '27.1.1', at }) }).checkedUTC, timeline.checkedUTC);
});

test('the CLI records a span into a round folder from a fixture engine folder', t => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-version-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'codex/plugins/cache/openai-bundled/unified-computer-use/26.1013.40934');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: '/bin/true', args: [] } } }));
  const env = { ...process.env, CODEX_HOME: join(dir, 'codex'), SLEIGHT_CHATGPT_APP: join(dir, 'no-app') };
  const cli = (...args) => spawnSync(process.execPath, [join(repo, 'bench/engine-version.mjs'), ...args], { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  const read = JSON.parse(cli().stdout);
  assert.deepEqual([read.version, read.chatgptApp], ['26.1013.40934', null]);
  // The start read creates the folder; the end read completes the span from the saved start.
  assertChildStatus(cli('record', join(dir, 'out')), 0);
  const started = JSON.parse(readFileSync(join(dir, 'out/engine.json'), 'utf8'));
  assert.deepEqual([started.version, started.changed, 'end' in started], ['26.1013.40934', null, false]);
  writeFileSync(join(dir, 'out/engine.json'), JSON.stringify({ ...started, start: { ...started.start, version: '26.1007.71326' } }));
  assertChildStatus(cli('record', join(dir, 'out'), '--end'), 0);
  const span = JSON.parse(readFileSync(join(dir, 'out/engine.json'), 'utf8'));
  assert.equal(span.changed, true);
  assert.deepEqual([span.start.version, span.end.version, span.startedAt], ['26.1007.71326', '26.1013.40934', started.startedAt]);
  // An end read with no start read never claims the version held for the whole run.
  mkdirSync(join(dir, 'late'));
  assertChildStatus(cli('record', join(dir, 'late'), '--end'), 0);
  const late = JSON.parse(readFileSync(join(dir, 'late/engine.json'), 'utf8'));
  assert.deepEqual([late.version, late.startedAt, late.startMissing, late.end.version], [null, null, true, '26.1013.40934']);
  assert.equal(engineForRun({ recorded: late, startMs: Date.parse('2026-10-15T00:00:00Z') }, timeline).provenance, 'inferred');
  assertChildStatus(cli('record', join(dir, 'missing'), '--end'), 2);
  assert.equal(JSON.parse(cli('at', '2026-10-18T21:42:06Z', '2026-10-18T21:53:01Z').stdout).provenance, 'ambiguous');
});

test('the saved race rounds get per-task versions, with the round that spans the 2026-10-18 switch split three ways', t => {
  const bank = retainedBank('race-1017', ['safari-lcu-r1/results.json']);
  if (bank.skip) { t.skip(bank.skip); return; }
  const race = bank.path;
  const round = loadRound(join(race, 'safari-lcu-r1'));
  const by = Object.fromEntries(round.rows.map(row => [row.task, row.engine]));
  assert.equal(by['form-travel'].version, '26.1007.71326');
  assert.equal(by['form-settings'].version, '26.1007.71326');
  assert.equal(by['form-checkout'].provenance, 'ambiguous');
  assert.equal(by.mdn.version, '26.1013.40934');
  assert.equal(round.engine.provenance, 'ambiguous');
  const before = loadRound(join(race, 'safari-sleight-r1'));
  assert.ok(before.rows.every(row => row.engine.version === '26.1007.71326' && row.engine.provenance === 'inferred'));
});

test('rounds.sh records the engine into --out around a FowlBrowser runner round and keeps the runner\'s exit code', t => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-rounds-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'codex/plugins/cache/openai-bundled/unified-computer-use/26.1013.40934');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: '/bin/true', args: [] } } }));
  // The runner stands in for FowlBrowser's tools/rounds.mjs: it makes the --out folder and fails.
  mkdirSync(join(dir, 'tools'));
  writeFileSync(join(dir, 'tools/rounds.mjs'), "import { mkdirSync } from 'node:fs'; mkdirSync(process.argv[process.argv.indexOf('--out') + 1], { recursive: true }); process.exit(3);\n");
  const script = readFileSync(join(repo, 'bench/fowl/rounds.sh'), 'utf8');
  const tail = script.slice(script.indexOf('[ -z "$OUT" ] || node "$REPO/bench/engine-version.mjs" record'));
  const run = spawnSync('/bin/sh', ['-eu', '-c', `cd "${dir}"\n${tail}`, 'rounds-fixture', '--out', 'out', '--model', 'x'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, USER: 'fixture', REPO: repo, OUT: 'out', MODEL: 'x', CODEX_HOME: join(dir, 'codex'), SLEIGHT_CHATGPT_APP: join(dir, 'no-app') }, timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 3, run.stderr);
  const span = JSON.parse(readFileSync(join(dir, 'out/engine.json'), 'utf8'));
  assert.deepEqual([span.version, span.changed, span.start.version, span.end.version], ['26.1013.40934', false, '26.1013.40934', '26.1013.40934']);
  assert.ok(span.startedAt <= span.endedAt);
});

test('the note under a table counts engine runs with no settled version, and never claims one version for them', () => {
  const run = (version, provenance = 'inferred') => ({ version, provenance, startedAt: '2026-10-18T10:00:00.000Z', endedAt: '2026-10-18T10:01:00.000Z', dated: 'recorded' });
  const one = summarizeEngines([{ arm: 'sleight', engine: run('26.1013.40934') }, { arm: 'codex', engine: run('26.1013.40934') }, { arm: 'lcu', engine: run('26.1007.71326') }]);
  assert.equal(engineNote(one), 'The arms that use the engine ran on one engine version, 26.1013.40934.');
  const open = summarizeEngines([{ arm: 'sleight', engine: run('26.1013.40934') }, { arm: 'codex', engine: run(null, 'ambiguous') }]);
  assert.equal(engineNote(open), 'The arms that use the engine ran on one engine version, 26.1013.40934. 1 of their runs have no settled version (ambiguous or unknown).');
  assert.equal(engineNote(summarizeEngines([{ arm: 'lcu', engine: run('x') }])), 'No arm here uses the engine with a known version.');
});

test('a copied file\'s mtime is ignored, an end before the start is clamped, and refresh extends or grows the timeline', () => {
  const raw = { stamp: '2026-10-14T20-00-00-000Z', results: [{ seconds: 600 }] };
  // Copied four days later: the mtime would span the 2026-10-18 switch, so the pass ends at its start plus its seconds.
  assert.deepEqual(passRowEngine(raw, raw.results[0], { timeline, mtimeMs: Date.parse('2026-10-18T23:00:00Z') }).endedAt, '2026-10-14T20:10:00.000Z');
  assert.equal(passRowEngine(raw, raw.results[0], { timeline, mtimeMs: Date.parse('2026-10-14T20:25:00Z') }).endedAt, '2026-10-14T20:25:00.000Z');
  assert.deepEqual(passRowEngine({ results: [{}] }, {}, { file: '2026-10-15-release-1.2.6.json', timeline }),
    { version: '26.1007.71326', provenance: 'inferred', startedAt: '2026-10-15T00:00:00.000Z', endedAt: '2026-10-15T23:59:59.999Z', dated: 'inferred' });
  assert.deepEqual(inferEngine('2026-10-12T00:00:00Z', '2026-10-10T00:00:00Z', timeline), { version: '26.1007.30912', provenance: 'inferred' });
  const read = version => ({ version, chatgptApp: version, at: '2026-10-20T00:00:00.000Z' });
  const same = refreshTimeline(timeline, { read: read('26.1013.40934') });
  assert.deepEqual([same.changed, same.timeline.checkedUTC, same.timeline.versions.length], [true, '2026-10-20T00:00:00.000Z', timeline.versions.length]);
  const grown = refreshTimeline(timeline, { read: read('26.1020.1'), folderBirth: '2026-10-19T12:00:00.000Z' }).timeline;
  assert.deepEqual(grown.versions.at(-1).switchedAfterUTC, timeline.checkedUTC);
  assert.equal(inferEngine('2026-10-19T13:00:00Z', undefined, grown).version, '26.1020.1');
  assert.equal(inferEngine('2026-10-19T11:00:00Z', undefined, grown).provenance, 'ambiguous');
  assert.equal(refreshTimeline(timeline, { read: read('26.1020.1') }).changed, false);
  assert.equal(refreshTimeline(timeline, { read: { version: null, error: 'none' } }).changed, false);
});
