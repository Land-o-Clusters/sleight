import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const load = async () => {
  const mod = await import('../bench/turbo/census.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  });
  assert.ok(mod, 'v3 per-task census is missing'); return mod;
};
const use = (id, name, input = {}) => ({ type: 'assistant', message: {
  content: [{ type: 'tool_use', id, name: 'mcp__sleight-turbo__' + name, input }] } });
const result = (id, text, is_error = false) => ({ type: 'user', message: {
  content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error }] } });

test('census counts standalone reads per action call, batches, fills and delivered text once', async () => {
  const { censusEvents } = await load();
  const events = [use('o', 'browser_open'), result('o', 'open'),
    use('r', 'browser_read'), result('r', 'read🙂'), result('r', 'read🙂'),
    use('a', 'browser_act', { steps: [{ do: 'click', ref: 'e1' }, { do: 'press', key: 'Enter' }] }),
    result('a', 'no visible change'),
    use('f', 'browser_fill', { fields: [{ ref: 'e2', value: 'private' }, { ref: 'e3', value: true }], submit: 'e4' }),
    result('f', 'failed', true), use('p', 'browser_act', { steps: [{ do: 'click', ref: 'e5' }] }),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search', name: 'ToolSearch', input: {} }] } },
    result('unknown', 'orphan private text')];
  events.push(events[2]);
  const row = censusEvents(events);
  assert.equal(row.calls, 6); assert.equal(row.reads, 1); assert.equal(row.actionCalls, 3);
  assert.equal(row.readsPerAction, 1 / 3); assert.equal(row.stepsRequested, 3);
  assert.equal(row.fieldsRequested, 2); assert.equal(row.submitsRequested, 1);
  assert.equal(row.errors, 1); assert.equal(row.unresolved, 2); assert.equal(row.toolSearch, 1);
  assert.equal(row.characters, 32); // 4 + 5 Unicode characters + 17 + 6.
  assert.equal(row.tools.browser_read.characters, 5);
  assert.equal(row.duplicateResults, 1); assert.equal(row.orphanResults, 1);
  assert.doesNotMatch(JSON.stringify(row), /private|e[1-5]|visible change/);
});

test('census keeps other paths separate and does not invent ratios or zero coverage', async () => {
  const { censusEvents, observations } = await load();
  const row = censusEvents([{ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'engine', name: 'mcp__plugin_sleight_computer__js', input: { code: 'private' } }] } },
  result('engine', 'engine')]);
  assert.equal(row.actionCalls, 0); assert.equal(row.readsPerAction, null); assert.equal(row.otherCalls, 1);
  assert.deepEqual(observations(), { focusEvents: null, observedFocusEvents: null, turboTabsLeft: null,
    tabsAfterBrowserClose: null, tabsLeft: null, cleanupProved: false, startupFailures: 0, startupUnrecovered: false,
    startupFailureClasses: [] });
  const recovered = observations(undefined, [{ version: 3, phase: 'startup-failed', attempt: 1, retrying: true }]);
  assert.deepEqual([recovered.startupFailures, recovered.startupUnrecovered], [1, false]);
  const final = observations(undefined, [{ version: 3, phase: 'startup-failed', attempt: 1, retrying: true },
    { version: 3, phase: 'startup-failed', attempt: 2, retrying: false }]);
  assert.deepEqual([final.startupFailures, final.startupUnrecovered], [2, true]);
  const unknown = observations({ focusGrade: { cell: 'unqualified', events: [{ kind: 'host-front' }] } });
  assert.equal(unknown.focusEvents, null); assert.equal(unknown.observedFocusEvents, 1);
  const measured = observations({ focusGrade: { cell: 'ok', events: [] } }, [
    { version: 3, phase: 'cleanup', turboTabsLeft: 2, tabsAfterBrowserClose: 0,
      browserClosed: true, profileDeleted: true, socketsClosed: true }]);
  assert.equal(measured.focusEvents, 0); assert.equal(measured.turboTabsLeft, 2);
  assert.equal(measured.tabsLeft, null, 'combined engine tabs are not covered by turbo closure');
  assert.equal(measured.cleanupProved, true);
});

const inputUnknown = 'Input outcome is unconfirmed. Read state before retrying; use the engine browser path if needed.';
const turnUnavailable = 'Turbo is unavailable for this turn. Use the engine browser path.';
const workerLoss = () => [use('open', 'browser_open'), result('open', inputUnknown),
  use('tabs', 'browser_tabs'), result('tabs', turnUnavailable, true)];

test('first-call worker loss counts once beside startup attempt metrics and keeps diagnostic codes', async t => {
  const { censusRound, renderCensus } = await load();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-census-')));
  mkdirSync(join(dir, 'demoid'));
  writeFileSync(join(dir, 'demoid/events.jsonl'), [...workerLoss(), result('tabs', turnUnavailable, true),
    use('again', 'browser_read'), result('again', turnUnavailable, true)].map(JSON.stringify).join('\n'));
  const metricFile = join(dir, 'demoid/turbo-metrics.jsonl');
  const cleanup = { version: 3, phase: 'cleanup', browserClosed: false };
  writeFileSync(metricFile, JSON.stringify(cleanup) + '\n');
  let row = censusRound(dir).tasks.demoid;
  assert.equal(row.firstCallWorkerLosses, 1);
  assert.equal(row.startupFailures, 1); assert.equal(row.startupUnrecovered, true);
  assert.deepEqual(row.startupFailureClasses, [{ class: 'first-call-worker-loss', stage: 'first-call',
    code: 'UNKNOWN', reason: 'UNKNOWN', source: 'transcript', count: 1 }]);
  assert.equal(row.softFailures, 1); assert.equal(row.errors, 2);
  const start = { version: 3, phase: 'startup-failed', stage: 'connection-select', code: 'V3_RUNTIME_UNAVAILABLE',
    reason: 'STALE_INSTANCE', retrying: true };
  writeFileSync(metricFile, [start, start, cleanup].map(JSON.stringify).join('\n'));
  row = censusRound(dir).tasks.demoid;
  assert.equal(row.startupFailures, 3, 'two rejected starts, then one lost first call');
  assert.deepEqual(row.startupFailureClasses[0], { class: 'session-start', stage: 'connection-select',
    code: 'V3_RUNTIME_UNAVAILABLE', reason: 'STALE_INSTANCE', source: 'metrics', count: 2 });
  const table = renderCensus([censusRound(dir)]);
  assert.match(table, /first-call-worker-loss \| first-call \| UNKNOWN \| UNKNOWN \| transcript \| 1/);
  assert.match(table, /session-start \| connection-select \| V3_RUNTIME_UNAVAILABLE \| STALE_INSTANCE \| metrics \| 2/);
  assert.match(table, /First-call worker losses/);
  writeFileSync(metricFile, JSON.stringify({ ...start, stage: '/private/path', code: 'secret text', reason: 'https://private.invalid' }));
  assert.doesNotMatch(JSON.stringify(censusRound(dir)), /private|secret/);
});

test('worker loss requires the exact first two matched turbo outcomes, never page text or a later call', async () => {
  const { censusEvents, observations, renderCensus } = await load();
  for (const events of [
    workerLoss(),
    [use('search', 'ToolSearch'), result('search', 'tools'), ...workerLoss(), result('orphan', inputUnknown)],
  ]) assert.equal(censusEvents(events).firstCallWorkerLosses, 1);
  for (const events of [
    [use('good', 'browser_open'), result('good', 'opened'), ...workerLoss()],
    [use('open', 'browser_open'), result('open', 'snapshot: 1\n' + inputUnknown), ...workerLoss().slice(2)],
    [use('open', 'browser_open'), result('open', inputUnknown + '\nsnapshot: 1'), ...workerLoss().slice(2)],
    [use('open', 'browser_read'), result('open', inputUnknown), ...workerLoss().slice(2)],
    [use('open', 'browser_open'), result('open', inputUnknown, true), ...workerLoss().slice(2)],
    [...workerLoss().slice(0, 2), use('tabs', 'browser_tabs'), result('tabs', turnUnavailable)],
    [result('orphan', inputUnknown), ...workerLoss().slice(2)],
    workerLoss().slice(0, 2),
  ]) {
    const row = censusEvents(events);
    assert.equal(row.firstCallWorkerLosses, 0);
    assert.equal(observations(undefined, [], row).startupFailures, 0);
  }
  const row = { ...censusEvents([]), ...observations() };
  assert.match(renderCensus([{ round: 'zero', tasks: { demoid: row } }]), /demoid \| 0 \| 0 \| no/);
});

test('round census and CLI emit aggregate task data, retain missing coverage and reject malformed or linked inputs', async t => {
  const { censusRound, renderCensus } = await load();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-census-')));
  mkdirSync(join(dir, 'fixture'));
  const file = join(dir, 'fixture/events.jsonl');
  writeFileSync(file, [use('r', 'browser_read'), result('r', 'SECRET https://private.invalid')].map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([{ task: { name: 'fixture', prompt: 'SECRET' },
    focusGrade: { cell: 'FAIL: 1', events: [{ kind: 'host-front', app: 'PRIVATE-APP' }] } }]));
  writeFileSync(join(dir, 'fixture/turbo-metrics.jsonl'), JSON.stringify({ version: 3, phase: 'cleanup',
    turboTabsLeft: 0, tabsAfterBrowserClose: 0, browserClosed: true, profileDeleted: true, socketsClosed: true }) + '\n');
  const round = censusRound(dir);
  assert.equal(round.tasks.fixture.characters, 30);
  assert.equal(round.tasks.fixture.focusEvents, 1); assert.equal(round.tasks.fixture.turboTabsLeft, 0);
  assert.doesNotMatch(JSON.stringify(round), /SECRET|private.invalid|PRIVATE-APP/);
  assert.match(renderCensus([round]), /fixture/); assert.match(renderCensus([round]), /unavailable/);
  const cli = spawnSync(process.execPath, ['bench/turbo/census.mjs', '--json', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).rounds[0].tasks.fixture.reads, 1);
  writeFileSync(file, '{bad json\n'); assert.throws(() => censusRound(dir), /events.jsonl:1/);
  writeFileSync(file, ''); symlinkSync(file, join(dir, 'linked'));
  assert.throws(() => censusRound(dir), /symbolic link/);
});

test('a results-only task remains visible with unavailable transcript counts, including prototype-like task names', async t => {
  const { censusRound, renderCensus } = await load();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-census-')));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([{ task: { name: '__proto__' },
    focusGrade: { cell: 'ok', events: [] } }]));
  const round = censusRound(dir);
  assert.equal(Object.hasOwn(round.tasks, '__proto__'), true);
  assert.equal(round.tasks.__proto__.transcriptAvailable, false);
  assert.equal(round.tasks.__proto__.reads, null); assert.equal(round.tasks.__proto__.characters, null);
  assert.equal(round.tasks.__proto__.firstCallWorkerLosses, null);
  assert.equal(round.tasks.__proto__.focusEvents, 0);
  assert.match(renderCensus([round]), /__proto__ \| unavailable/);
});

test('soft outcomes count once per result while is_error stays comparable between arms', async () => {
  const { censusEvents } = await load();
  const row = censusEvents([
    use('a', 'browser_act'), result('a', 'Input outcome is unconfirmed. Read state before retrying.'),
    result('a', 'Input outcome is unconfirmed. Read state before retrying.'),
    use('f', 'browser_fill'), result('f', 'e1: done\ne2: failed: field stopped\nsubmit: not reached'),
    use('e', 'browser_act'), result('e', 'Input outcome is unconfirmed.', true),
    result('orphan', 'Operation outcome is unconfirmed.'),
  ]);
  assert.equal(row.errors, 1);
  assert.equal(row.softFailures, 2);
  assert.equal(row.gateFailures, 3);
  assert.equal(row.tools.browser_act.errors, 1);
  assert.equal(row.tools.browser_act.softFailures, 1);
  assert.equal(row.tools.browser_fill.softFailures, 1);
  assert.equal(row.duplicateResults, 1);
  assert.equal(row.orphanResults, 1);
});

for (const [name, text, want] of [
  ['browser_tabs', 'Operation outcome is unconfirmed. Read current state before deciding what remains.', 1],
  ['browser_fill', 'f2e3: not reached\nsubmit: unconfirmed', 1],
  ['browser_fill', 's1: failed: unavailable\nsubmit: failed', 1],
  ['browser_act', '1 click e1: not run: rule refused\n2 type e2: not reached', 1],
  ['browser_act', '1 click e1: effect unconfirmed; read before retrying.', 1],
  ['browser_act', '1 click e1: submit unconfirmed after 5 s; read before resubmitting', 1],
  ['browser_act', '1 click e1: failed: input stopped', 1],
  ['browser_act', '1 click e1: no visible change', 0],
  ['browser_act', '1 click e1: dialog opened', 0],
  ['browser_fill', 'e1: done\nsubmit: not requested', 0],
  ['browser_read', 'Input outcome is unconfirmed.\ne1: failed: page text', 0],
  ['browser_act', '1 click e1: done\nsnapshot: 2\n2 type e2: not run: page text', 0],
  ['browser_fill', 'e1: done\nsnapshot: 2\ne2: failed: page text\nsubmit: not reached', 0],
]) test(`census distinguishes ${name} outcome markers from page text: ${text}`, async () => {
  const { censusEvents } = await load();
  const row = censusEvents([use('a', name), result('a', text)]);
  assert.equal(row.errors, 0);
  assert.equal(row.softFailures, want);
  assert.equal(row.tools[name].softFailures, want);
});

test('the gate table exposes all calls, ToolSearch, unresolved calls and both failure counts', async () => {
  const { censusEvents, renderCensus } = await load();
  const row = censusEvents([
    use('a', 'browser_act'), result('a', 'Operation outcome is unconfirmed.'),
    use('e', 'browser_read'), result('e', 'refused', true),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'ToolSearch', input: {} }] } },
  ]);
  const table = renderCensus([{ round: 'fixture', tasks: { task: { ...row, focusEvents: 0,
    turboTabsLeft: null, cleanupProved: false } } }]).split('\n').filter(line => line.startsWith('|'));
  const cells = line => line.split('|').slice(1, -1).map(cell => cell.trim());
  const columns = cells(table[0]), values = cells(table[2]);
  for (const [name, want] of [['Calls', '3'], ['ToolSearch', '1'], ['Unresolved', '1'],
    ['Errors', '1'], ['Soft failures', '1'], ['Gate failures', '2']]) {
    assert.notEqual(columns.indexOf(name), -1, name);
    assert.equal(values[columns.indexOf(name)], want, name);
  }
});

test('soft failures push the nine-error gate over its limit and missing coverage is unavailable', async t => {
  const { censusEvents, censusRound, renderCensus } = await load();
  const events = Array.from({ length: 9 }, (_, i) => [use('e' + i, 'browser_act'), result('e' + i, 'refused', true)]).flat();
  events.push(use('soft', 'browser_fill'), result('soft', 'e1: failed: stopped\nsubmit: not reached'));
  const row = censusEvents(events);
  assert.equal(row.errors, 9);
  assert.equal(row.softFailures, 1);
  assert.equal(row.gateFailures, 10);
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-census-')));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([{ task: { name: 'missing' } }]));
  const round = censusRound(dir);
  assert.equal(round.tasks.missing.softFailures, null);
  assert.equal(round.tasks.missing.gateFailures, null);
  assert.doesNotMatch(renderCensus([round]), /undefined/);
});
