import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const api = await import('../bench/battery-report.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const report = (rows, options) => {
  assert.equal(typeof api.buildReport, 'function', 'battery report is implemented');
  return api.buildReport(rows, options);
};
const row = (arm, app, run = 1, extra = {}) => ({ arm, app, task: 'fixture-read', run,
  pass: true, seconds: 10, turns: 4, timing: { modelMs: 6000 }, ownCpuSeconds: 2,
  focusSteals: 0, windowsOverOwner: 0, startedAt: '2026-10-01T00:00:00Z',
  setup: 'fixture-clean', load: 'fixture-normal', model: 'fixture-model', ...extra });
const apps = ['org.example.Lark', 'org.example.Pebble', 'org.example.Reed', 'org.example.Moss'];
const at = ms => new Date(Date.UTC(2026, 9, 1) + ms).toISOString();
const user = text => ({ type: 'user', timestamp: at(0), message: { content: text } });
const call = (id, code, ms = 1000) => ({ type: 'assistant', timestamp: at(ms), message: {
  content: [{ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__js', input: { code } }] } });
const result = (id, text, ms = 2000) => ({ type: 'user', timestamp: at(ms), message: {
  content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

test('per-app pass parity cannot be hidden by an overall win or uneven run counts', () => {
  const r = report([row('sleight', apps[0], 1, { pass: false }), row('codex', apps[0]),
    ...[1, 2, 3].map(n => row('sleight', apps[1], n)), row('codex', apps[1], 1, { pass: false })]);
  assert.equal(r.parity.overall.sleight.passRate, 0.75);
  assert.equal(r.parity.overall.codex.passRate, 0.5);
  assert.equal(r.parity.status, 'fails');
  assert.deepEqual(r.parity.failures, [apps[0]]);
  assert.equal(r.parity.apps[0].sleight.runs, 1);
});

test('medians include failed runs and model seconds per turn use measured model time', () => {
  const r = report([row('sleight', apps[0], 1, { seconds: 4 }),
    row('sleight', apps[0], 2, { seconds: 20, pass: false, turns: 2, timing: { modelMs: 8000 } }),
    row('codex', apps[0])]);
  assert.equal(r.parity.overall.sleight.totalSeconds.median, 12);
  assert.equal(r.parity.overall.sleight.modelSecondsPerTurn.median, 2.75);
  assert.equal(r.parity.overall.sleight.turns.median, 3);
  assert.equal(r.parity.overall.sleight.ownCpuSeconds.n, 2);
});

test('unknown measurements remain null with coverage counts and missing arms block parity', () => {
  const r = report([row('sleight', apps[0], 1, { seconds: undefined, timing: {},
    ownCpuSeconds: null, focusSteals: undefined, windowsOverOwner: undefined })]);
  assert.equal(r.parity.status, 'incomplete');
  assert.deepEqual(r.parity.overall.sleight.totalSeconds, { median: null, n: 0 });
  assert.equal(r.parity.overall.sleight.focusSteals.sum, null);
  assert.equal(r.parity.overall.codex.passRate, null);
});

test('window-order events count only explicit focus steals and windows over owner', () => {
  const r = report([row('sleight', apps[0], 1, { focusSteals: undefined, windowsOverOwner: undefined,
    windowOrder: { events: [{ type: 'focus-steal' }, { type: 'window-over-owner' }, { type: 'window-over-owner' }] } })]);
  assert.equal(r.parity.overall.sleight.focusSteals.sum, 1);
  assert.equal(r.parity.overall.sleight.windowsOverOwner.sum, 2);
});

test('invalid pass values, duplicate coordinates and negative durations fail closed', () => {
  assert.throws(() => report([row('sleight', apps[0], 1, { pass: 'yes' })]), /Invalid/);
  assert.throws(() => report([row('sleight', apps[0]), row('sleight', apps[0])]), /Duplicate/);
  assert.throws(() => report([row('sleight', apps[0], 1, { seconds: -1 })]), /Invalid/);
});

test('same-task call ranking requires both transcripts and reports calls, seconds and mechanism files', () => {
  const rows = [row('sleight', apps[0]), row('codex', apps[0]), row('sleight', apps[1])];
  const studyRuns = [{ ...rows[0], calls: [
    { classes: ['spilled-result'], attributableMs: 3000 },
    { classes: ['spill-filter-followup'], attributableMs: 2000 },
    { classes: [], attributableMs: 1000 }] }, { ...rows[1], calls: [{ classes: [], attributableMs: 1000 }] }];
  const r = report(rows, { studyRuns });
  assert.equal(r.callRanking[0].pairedRuns, 1);
  assert.equal(r.callRanking[0].sleightCalls, 3);
  assert.equal(r.callRanking[0].codexCalls, 1);
  assert.equal(r.callRanking[0].savedCalls, 2);
  assert.equal(r.callRanking[0].sleightSeconds, 6);
  assert.equal(r.callRanking[0].codexSeconds, 1);
  assert.ok(r.callRanking[0].mechanisms.some(m => m.file === 'plugins/sleight/lib/relay.mjs'));
  assert.equal(r.coverage.unpairedTranscripts, 1);
});

test('fixed bundle hash keeps app splits stable and candidates cannot learn held-out classes', () => {
  assert.equal(typeof api.splitApp, 'function');
  assert.equal(api.splitApp('org.example.Lark'), 'test');
  assert.equal(api.splitApp('org.example.Moss'), 'learn');
  const groups = Object.groupBy(apps, api.splitApp);
  assert.ok(groups.learn?.length && groups.test?.length);
  const learn = groups.learn[0], held = groups.test[0];
  const r = report([row('sleight', learn, 1, { wasteCalls: [{ classes: ['spilled-result'], attributableMs: 3000 }] }),
    row('sleight', held, 1, { wasteCalls: [{ classes: ['list-did-not-scroll'], attributableMs: 9000 }] })]);
  assert.deepEqual(r.ruleMining.candidates.map(c => c.rule), ['spilled-result']);
  assert.equal(r.ruleMining.candidates[0].status, 'candidate');
  assert.equal(JSON.stringify(r.ruleMining.candidates).includes(learn), false);
  assert.deepEqual(report([...r.inputRows].reverse()).ruleMining.split, r.ruleMining.split);
});

test('later flag A/B needs improvement on learn and test apps, with paired task coverage', () => {
  assert.equal(typeof api.splitApp, 'function');
  const learn = apps.find(a => api.splitApp(a) === 'learn');
  const held = apps.find(a => api.splitApp(a) === 'test');
  const discovery = [learn, held].map(a => row('sleight', a, 1, {
    wasteCalls: [{ classes: ['spilled-result'], attributableMs: 3000 }] }));
  const abRows = [learn, held].flatMap(a => [row('off', a, 2, { startedAt: at(86400000), seconds: 12,
    flags: { SLEIGHT_RESULT_TRIM: '0' }, experiment: 'trim-ab' }),
  row('on', a, 2, { startedAt: at(86400000), seconds: 8, flags: { SLEIGHT_RESULT_TRIM: '1' }, experiment: 'trim-ab' })]);
  const ab = { rule: 'spilled-result', flag: 'SLEIGHT_RESULT_TRIM', controlArm: 'off', treatmentArm: 'on',
    controlValue: '0', treatmentValue: '1', experiment: 'trim-ab' };
  ab.privateNote = 'invented-private-owner';
  const proven = report([...discovery, ...abRows], { ab });
  assert.equal(proven.ruleMining.validation.status, 'proven-in-sample');
  assert.equal(JSON.stringify(proven).includes('invented-private-owner'), false);
  abRows[3].seconds = 13;
  assert.equal(report([...discovery, ...abRows], { ab }).ruleMining.validation.status, 'not-proven');
  abRows[3].seconds = 8; abRows[3].pass = false;
  assert.equal(report([...discovery, ...abRows], { ab }).ruleMining.validation.status, 'not-proven');
});

test('early A/B rows, unmatched test tasks and extra flag differences cannot prove a rule', () => {
  assert.equal(typeof api.splitApp, 'function');
  const learn = apps.find(a => api.splitApp(a) === 'learn'), held = apps.find(a => api.splitApp(a) === 'test');
  const discovery = [row('sleight', learn, 1, { wasteCalls: [{ classes: ['spilled-result'] }] })];
  const ab = { rule: 'spilled-result', flag: 'SLEIGHT_RESULT_TRIM', controlArm: 'off', treatmentArm: 'on',
    controlValue: '0', treatmentValue: '1', experiment: 'trim-ab' };
  const pairs = [learn, held].flatMap(a => [row('off', a, 2, { flags: { SLEIGHT_RESULT_TRIM: '0' }, experiment: 'trim-ab' }),
    row('on', a, 2, { seconds: 8, flags: { SLEIGHT_RESULT_TRIM: '1' }, experiment: 'trim-ab' })]);
  assert.equal(report([...discovery, ...pairs], { ab }).ruleMining.validation.status, 'not-proven');
  pairs.forEach(p => { p.startedAt = at(86400000); });
  pairs[3].task = 'different-task';
  assert.equal(report([...discovery, ...pairs], { ab }).ruleMining.validation.status, 'not-proven');
  pairs[3].task = 'fixture-read'; pairs[3].flags.OTHER_FLAG = '1';
  assert.equal(report([...discovery, ...pairs], { ab }).ruleMining.validation.status, 'not-proven');
});

test('publication allowlists omit transcript text, owner strings and source paths', () => {
  const secret = 'invented-person-private';
  const r = report([row('sleight', apps[0], 1, { answer: secret, transcript: '/Users/invented-person/private.jsonl',
    windowOrder: { events: [{ type: 'focus-steal', title: secret }] },
    wasteCalls: [{ classes: [secret, 'spilled-result'], code: secret }] })]);
  assert.equal(typeof api.renderMarkdown, 'function');
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(api.renderMarkdown(r).includes(secret), false);
  assert.equal(api.renderMarkdown(r).includes('/Users/'), false);
  assert.throws(() => report([row('sleight', apps[0], 1, { task: secret + '\nprivate text' })]), /Invalid/);
});

test('Codex response items pair by call ID and reuse turn-study classifications without text', () => {
  assert.equal(typeof api.analyzeCodex, 'function');
  const rows = [{ type: 'event_msg', timestamp: at(0), payload: { type: 'user_message', message: 'invented private' } },
    { type: 'response_item', timestamp: at(1000), payload: { type: 'function_call', call_id: 'x',
      name: 'mcp__cua__js', arguments: JSON.stringify({ code: 'await cua.getState()' }) } },
    { type: 'response_item', timestamp: at(2000), payload: { type: 'function_call_output', call_id: 'x', output: 'invented owner' } },
    { type: 'response_item', timestamp: at(3000), payload: { type: 'function_call', call_id: 'y',
      name: 'mcp__cua__js', arguments: JSON.stringify({ code: 'await cua.getApp("Lark")' }) } }];
  const r = api.analyzeCodex(rows);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].attributableMs, 2000);
  assert.ok(r.calls[0].classes.includes('preliminary-inventory'));
  assert.equal(r.calls[1].wallMs, null);
  assert.equal(JSON.stringify(r).includes('invented'), false);
});

test('CLI reads only linked benchmark transcripts, imports turn-study and publishes coverage', t => {
  // Removing exact session matching would attach the unrelated private transcript.
  assert.equal(typeof api.buildReport, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'battery-report-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'codex')); mkdirSync(join(dir, 'projects/p'), { recursive: true });
  const s = row('sleight', apps[3], 1, { session: 's-one' }), c = row('codex', apps[3], 1, { threadId: 'c-one' });
  const other = row('sleight', 'org.example.Elm', 1, { session: 's-two', task: 'fixture-second' });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ results: [s, c, other] }));
  writeFileSync(join(dir, 'projects/p/s-one.jsonl'), [user('invented private text'), call('a', 'await cua.getState()'),
    result('a', 'invented owner'), call('b', 'await cua.getApp("Lark")', 3000), result('b', 'ok', 4000)].map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'codex/c-one.jsonl'), [{ type: 'session_meta', payload: { id: 'c-one' } },
    { type: 'event_msg', timestamp: at(0), payload: { type: 'user_message', message: 'private' } },
    { type: 'response_item', timestamp: at(1000), payload: { type: 'function_call', call_id: 'c', name: 'mcp__cua__js', arguments: '{"code":"app"}' } },
    { type: 'response_item', timestamp: at(2000), payload: { type: 'function_call_output', call_id: 'c', output: 'ok' } }].map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'projects/p/unrelated.jsonl'), 'private invalid json');
  writeFileSync(join(dir, 'projects/p/s-two.jsonl'), [user('private'), call('z', 'await sleep(1)'), result('z', 'private')]
    .map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'study.json'), JSON.stringify({ runs: [{ arm: 'sleight', task: s.task, run: 1,
    calls: [{ classes: ['spilled-result'], attributableMs: 2000 }] }] }));
  const out = spawnSync(process.execPath, ['bench/battery-report.mjs', '--results', join(dir, 'results.json'),
    '--codex-sessions', join(dir, 'codex'), '--projects', join(dir, 'projects'), '--turn-study', join(dir, 'study.json'),
    '--json', join(dir, 'out.json'), '--table', join(dir, 'out.md')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(readFileSync(join(dir, 'out.json')));
  assert.equal(r.coverage.matchedTranscripts, 3);
  assert.equal(r.coverage.studyRuns, 1);
  assert.equal(r.callRanking[0].savedCalls, 1);
  assert.deepEqual(r.ruleMining.candidates.map(c => c.rule).sort(), ['explicit-delay', 'spilled-result']);
  assert.equal(readFileSync(join(dir, 'out.md'), 'utf8').includes('invented private'), false);
});

test('an A/B without explicit setup, load or model metadata cannot prove a rule', () => {
  const discovery = [apps[3], apps[0]].map(app => row('sleight', app, 1, {
    wasteCalls: [{ classes: ['spilled-result'], attributableMs: 1000 }] }));
  const pairs = [apps[3], apps[0]].flatMap(app => [row('off', app, 2, { startedAt: at(86400000), seconds: 12,
    flags: { SLEIGHT_RESULT_TRIM: '0' }, experiment: 'trim-ab' }),
  row('on', app, 2, { startedAt: at(86400000), seconds: 8, flags: { SLEIGHT_RESULT_TRIM: '1' }, experiment: 'trim-ab' })]);
  const ab = { rule: 'spilled-result', flag: 'SLEIGHT_RESULT_TRIM', controlArm: 'off', treatmentArm: 'on',
    controlValue: '0', treatmentValue: '1', experiment: 'trim-ab' };
  for (const r of [...discovery, ...pairs]) { delete r.setup; delete r.load; delete r.model; }
  assert.equal(report([...discovery, ...pairs], { ab }).ruleMining.validation.status, 'not-proven');
});

test('battery harness fields preserve CPU split, call metrics and sampled transition counts', () => {
  const r = report(['sleight', 'codex'].map(arm => ({ arm, bundle: apps[0], app: 'Lark', task: 'fixture-read', run: 1,
    passed: true, seconds: 12, turns: 4, modelMs: 8000,
    footprint: { split: { sleight: 1, engine: 2, client: 3, other: 4 } },
    calls: [{ classes: ['preliminary-inventory'], attributableMs: 1000 }],
    windows: { samples: [{ focusChanged: false, targetOverOwner: false },
      { focusChanged: true, targetOverOwner: true }, { focusChanged: true, targetOverOwner: true },
      { focusChanged: false, targetOverOwner: false }, { focusChanged: true, targetOverOwner: false }] } })));
  assert.equal(r.parity.apps[0].app, apps[0]);
  assert.equal(r.parity.overall.sleight.modelSecondsPerTurn.median, 2);
  assert.equal(r.parity.overall.sleight.ownCpuSeconds.median, 10);
  assert.equal(r.parity.overall.sleight.focusSteals.sum, 2);
  assert.equal(r.parity.overall.sleight.windowsOverOwner.sum, 1);
  assert.equal(r.callRanking[0].sleightCalls, 1);
});

test('task catalog resolves harness rows with no bundle ID and preserves setup separation', t => {
  assert.equal(typeof api.main, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'battery-catalog-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ armSetup: 'clean', results: [{ arm: 'sleight',
    task: 'fixture-read', run: 1, passed: true, seconds: 1, calls: [] }] }));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ runs: [{ task: 'fixture-read', bundle: apps[0] }] }));
  const out = spawnSync(process.execPath, ['bench/battery-report.mjs', '--results', join(dir, 'results.json'),
    '--catalog', join(dir, 'catalog.json'), '--projects', join(dir, 'absent'), '--codex-sessions', join(dir, 'absent'),
    '--json', join(dir, 'out.json')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(readFileSync(join(dir, 'out.json')));
  assert.equal(r.inputRows[0].app, apps[0]);
  assert.equal(r.inputRows[0].setup, 'clean');
});

test('Codex MCP result objects contribute numeric call timing without publishing content', () => {
  assert.equal(typeof api.analyzeCodex, 'function');
  const r = api.analyzeCodex([{ type: 'event_msg', timestamp: at(0), payload: { type: 'user_message' } },
    { type: 'response_item', timestamp: at(1000), payload: { type: 'function_call', call_id: 'x',
      name: 'mcp__cua__js', arguments: '{"code":"await app.getAXState()"}' } },
    { type: 'response_item', timestamp: at(2000), payload: { type: 'function_call_output', call_id: 'x',
      output: { content: [{ type: 'text', text: 'invented secret' }], isError: false } } }]);
  assert.equal(r.calls[0].resultTextBytes, 15);
  assert.equal(JSON.stringify(r).includes('invented secret'), false);
});

test('a faster A/B on a subset of the held-out apps cannot prove a rule', () => {
  const discovery = [apps[3], apps[0], apps[1]].map(app => row('sleight', app, 1, {
    wasteCalls: [{ classes: ['spilled-result'], attributableMs: 1000 }] }));
  const pairs = [apps[3], apps[0]].flatMap(app => [row('off', app, 2, { startedAt: at(86400000), seconds: 12,
    flags: { SLEIGHT_RESULT_TRIM: '0' }, experiment: 'trim-ab' }),
  row('on', app, 2, { startedAt: at(86400000), seconds: 8, flags: { SLEIGHT_RESULT_TRIM: '1' }, experiment: 'trim-ab' })]);
  const ab = { rule: 'spilled-result', flag: 'SLEIGHT_RESULT_TRIM', controlArm: 'off', treatmentArm: 'on',
    controlValue: '0', treatmentValue: '1', experiment: 'trim-ab' };
  assert.equal(report([...discovery, ...pairs], { ab }).ruleMining.validation.status, 'not-proven');
});

test('same-task Codex comparison permits different driver models but never crosses load contexts', () => {
  const s = row('sleight', apps[0], 1, { model: 'fixture-model-a', load: 'normal',
    calls: [{ classes: [], attributableMs: 1000 }, { classes: [], attributableMs: 1000 }] });
  const c = row('codex', apps[0], 1, { model: 'fixture-model-b', load: 'normal',
    calls: [{ classes: [], attributableMs: 1000 }] });
  assert.equal(report([s, c]).callRanking[0].savedCalls, 1);
  assert.equal(report([s, c, { ...s, model: 'fixture-model-c' }]).callRanking.length, 0);
  c.load = 'added';
  assert.throws(() => report([s, c]), /Invalid mixed/);
});

test('classified study calls supplement unclassified harness calls for mining', () => {
  const s = row('sleight', apps[3], 1, { calls: [{ attributableMs: 1000 }] });
  const r = report([s], { studyRuns: [{ ...s, calls: [{ classes: ['spilled-result'], attributableMs: 1000 }] }] });
  assert.equal(r.ruleMining.candidates[0].rule, 'spilled-result');
});

test('flag runs beginning before discovery completes cannot prove a rule', () => {
  const discovery = [apps[3], apps[0]].map(app => row('sleight', app, 1, {
    seconds: 3600, wasteCalls: [{ classes: ['spilled-result'], attributableMs: 1000 }] }));
  const pairs = [apps[3], apps[0]].flatMap(app => [row('off', app, 2, { startedAt: at(1000), seconds: 12,
    flags: { SLEIGHT_RESULT_TRIM: '0' }, experiment: 'trim-ab' }),
  row('on', app, 2, { startedAt: at(1000), seconds: 8, flags: { SLEIGHT_RESULT_TRIM: '1' }, experiment: 'trim-ab' })]);
  const ab = { rule: 'spilled-result', flag: 'SLEIGHT_RESULT_TRIM', controlArm: 'off', treatmentArm: 'on',
    controlValue: '0', treatmentValue: '1', experiment: 'trim-ab' };
  assert.equal(report([...discovery, ...pairs], { ab }).ruleMining.validation.status, 'not-proven');
});

test('mixed clean and normal setups cannot hide a per-app parity failure', () => {
  const rows = [row('sleight', apps[0], 1, { setup: 'clean', pass: false }), row('codex', apps[0], 1, { setup: 'clean' }),
    ...[2, 3].flatMap(run => [row('sleight', apps[0], run, { setup: 'normal' }), row('codex', apps[0], run, { setup: 'normal', pass: false })])];
  assert.throws(() => report(rows), /Invalid mixed/);
});

test('truncated transcript counts cannot replace the measured harness call count', () => {
  const s = row('sleight', apps[3], 1, { calls: [1, 2, 3].map(() => ({ classes: [], attributableMs: 1000 })) });
  const c = row('codex', apps[3], 1, { calls: [{ classes: [], attributableMs: 1000 }] });
  const r = report([s, c], { studyRuns: [{ ...s, calls: [] }] });
  assert.equal(r.callRanking[0].savedCalls, 2);
  assert.equal(r.coverage.transcriptCallMismatches, 1);
});

test('waste-only call lists cannot stand in for full driver call counts', () => {
  const rows = ['sleight', 'codex'].map(arm => row(arm, apps[3], 1, {
    wasteCalls: [{ classes: ['spilled-result'], attributableMs: 1000 }] }));
  assert.equal(report(rows).callRanking.length, 0);
});
