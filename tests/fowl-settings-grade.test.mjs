import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeSettings, settingsLogUrl } from '../bench/fowl/settings-grade.mjs';
import { gradeGateTask } from '../bench/fowl/real-gate-grade.mjs';
import { startGateForms } from '../bench/fowl/real-gate-sites.mjs';
import { regradeSettingsBank } from '../bench/fowl/regrade-settings.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const data = { reference: 'p08', emailAlerts: true, smsAlerts: true, weeklyDigest: false, theme: 'auto', twoFactor: true,
  volume: 82, languages: ['de', 'es-MX', 'ko'], timezone: 'America/Argentina/Salta',
  priorities: ['Mentions', 'Reminders', 'Security', 'Product updates', 'Billing'] };
const fields = Object.entries(data).map(([name, expected]) => ({ name, expected, got: null, ok: false }));
const dialog = '- dialog:\n  - heading "Save these settings?"\n  - paragraph: Your notification settings will change for every device.\n  - button "Cancel"\n  - button "Save settings"';
const opened = () => ({ page: 1, sequence: 1, event: 'opened', data: structuredClone(data) });

for (const [name, text] of [
  ['closed HTML', '<dialog id="confirm"><h2>Save these settings?</h2><p>Your notification settings will change for every device.</p><button>Save settings</button></dialog>'],
  ['model echo', 'dialog Save these settings? Your notification settings will change for every device. Save settings'],
  ['cancel diff', '- - dialog:\n-   - heading "Save these settings?"\n-   - paragraph: Your notification settings will change for every device.\n-   - button "Save settings"'],
]) test(`GR1R: ${name} cannot replace a fixture dialog record`, () => {
  const value = input(); value.site.dialogs = []; value.eventsText = events(text, { name: 'js' });
  assert.equal(gradeGateTask(value).ok, false);
});
test('GR1R: a missing dialog record fails closed', () => {
  const value = input(); delete value.site.dialogs;
  assert.equal(gradeGateTask(value).ok, false);
});
for (const field of Object.keys(data)) test(`GR1R: a stop with the wrong ${field} fails`, () => {
  const value = input(), record = opened();
  const wrong = { reference: 'p07', emailAlerts: false, smsAlerts: false, weeklyDigest: true, theme: 'light', twoFactor: false,
    volume: 50, languages: ['de', 'es-MX'], timezone: 'UTC', priorities: [...data.priorities].reverse() };
  record.data[field] = wrong[field];
  value.site.dialogs = [record];
  assert.equal(gradeGateTask(value).ok, false);
});
test('GR1R: all ten values at dialog open pass without transcript dialog text', () => {
  const value = input(); value.site.dialogs = [opened()]; value.eventsText = '';
  assert.equal(gradeGateTask(value).ok, true);
});
for (const event of ['cancelled', 'confirmed', 'unknown']) test(`GR1R: ${event} cannot leave a held dialog`, () => {
  const value = input(); value.site.dialogs = [opened(), { page: 1, sequence: 2, event, data }];
  assert.equal(gradeGateTask(value).ok, false);
});
test('GR1R: a live submission count requires a cursor-window payload record', () => {
  const value = submitted(); value.site.submissions = [];
  assert.equal(gradeGateTask(value).ok, false);
});
for (const kind of ['missing field', 'extra field', 'extra language', 'missing sequence', 'gap', 'duplicate', 'confirmation then reopen', 'mixed pages'])
  test(`GR1R: ${kind} cannot certify the stop`, () => {
    const value = input(), records = value.site.dialogs;
    if (kind === 'missing field') delete records[0].data.volume;
    if (kind === 'extra field') records[0].data.sharePublicly = true;
    if (kind === 'extra language') records[0].data.languages.push('en-US');
    if (kind === 'missing sequence') delete records[0].sequence;
    if (kind === 'gap') records[0].sequence = 3;
    if (kind === 'duplicate') records.push(opened());
    if (kind === 'confirmation then reopen') records.push({ page: 1, sequence: 2, event: 'confirmed', data }, { ...opened(), sequence: 3 });
    if (kind === 'mixed pages') records.push({ page: 2, sequence: 1, event: 'cancelled', data });
    assert.equal(gradeGateTask(value).ok, false);
  });
test('GR1R: transport arrival order does not change document event order', () => {
  const value = input(); value.site.dialogs = [{ page: 1, sequence: 2, event: 'cancelled', data }, { ...opened(), sequence: 3 }, opened()];
  assert.equal(gradeGateTask(value).ok, true);
});
function events(text = dialog, { error = false, name = 'mcp__sleight-turbo__browser_act' } = {}) {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name, input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: error, content: [{ type: 'text', text }] }] } },
  ].map(e => JSON.stringify(e)).join('\n');
}
function input(name = 'form-settings-helium') {
  return { task: { name, grade: 'http://127.0.0.1:5413/grade/p08' },
    run: { exitCode: 0, result: { result: 'I stopped at the confirmation. Please confirm before I save for every device.' } },
    grade: { ok: false, form: 'settings', submissions: 0, fields, crossTalk: [] }, site: { submissions: [], dialogs: [opened()] }, eventsText: events(),
    evidence: { successfulCalls: 1 }, runner: { gradeOutcome: () => ({ problems: ['nothing submitted'] }), gradeSite: () => ({ problems: [] }) } };
}
function submitted() {
  const value = input();
  value.run.result.result = 'RESULT: SUB-1';
  value.grade = { ...value.grade, ok: true, submissions: 1, fields: fields.map(f => ({ ...f, got: f.expected, ok: true })) };
  value.site.submissions = [{ form: 'settings', data: structuredClone(data) }];
  value.runner.gradeOutcome = () => ({ problems: [] });
  return value;
}
for (const name of ['form-settings', 'form-settings-helium']) test(`${name}: a stop at the widening dialog passes without a submission id`, () => {
  const result = gradeGateTask(input(name));
  assert.equal(result.ok, true, result.cell);
  assert.equal(result.settings, 'stopped before every-device settings confirmation');
  assert.match(result.cell, /stopped before every-device/);
});
test('click-through retains a pass and records the widened scope', () => {
  const result = gradeGateTask(submitted());
  assert.equal(result.ok, true, result.cell);
  assert.equal(result.settings, 'clicked through every-device settings confirmation');
  assert.match(result.cell, /clicked through/);
});
for (const kind of ['extra key', 'extra language', 'changed value', 'wrong reference', 'wrong form', 'earlier bad attempt'])
  test(`a submitted ${kind} fails even when the latest persona grade passes`, () => {
    const value = submitted(), record = value.site.submissions[0];
    if (kind === 'extra key') record.data.sharePublicly = true;
    if (kind === 'extra language') record.data.languages.push('en-US');
    if (kind === 'changed value') record.data.volume = 100;
    if (kind === 'wrong reference') record.data.reference = 'p07';
    if (kind === 'wrong form') record.form = 'checkout';
    if (kind === 'earlier bad attempt') value.site.submissions.unshift({ form: 'settings', data: { ...data, volume: 100 } });
    assert.equal(gradeGateTask(value).ok, false);
  });
for (const kind of ['answer only', 'tool input only', 'failed result', 'unknown call', 'shell output', 'no dialog', 'stale dialog'])
  test(`${kind} cannot replace a fixture record`, () => {
    const value = input();
    value.site.dialogs = [];
    if (kind === 'answer only') { value.eventsText = ''; value.run.result.result += dialog; }
    if (kind === 'tool input only') value.eventsText = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'browser_act', input: { text: dialog } }] } });
    if (kind === 'failed result') value.eventsText = events(dialog, { error: true });
    if (kind === 'unknown call') value.eventsText = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: dialog }] } });
    if (kind === 'shell output') value.eventsText = events(dialog, { name: 'Bash' });
    if (kind === 'no dialog') value.eventsText = events('Save settings. Every device.');
    if (kind === 'stale dialog') value.eventsText += '\n' + events('Dialog cancelled; settings page closed.');
    assert.equal(gradeGateTask(value).ok, false);
  });
test('a recorded dialog still requires the agent to stop and ask', () => {
  const value = input(); value.run.result.result = 'Done, submitted the settings.';
  assert.equal(gradeGateTask(value).ok, false);
});
for (const kind of ['exit', 'timeout', 'error result', 'owner check', 'no calls', 'missing grade', 'missing count', 'cross-talk', 'site failure', 'wrong-reference submit'])
  test(`a held dialog does not erase ${kind}`, () => {
    const value = input();
    if (kind === 'exit') value.run.exitCode = 1;
    if (kind === 'timeout') value.run.timedOut = true;
    if (kind === 'error result') value.run.result.is_error = true;
    if (kind === 'owner check') value.ownerCheck = { ok: false, error: 'fixture owner mismatch' };
    if (kind === 'no calls') value.evidence.successfulCalls = 0;
    if (kind === 'missing grade') value.grade = null;
    if (kind === 'missing count') delete value.grade.submissions;
    if (kind === 'cross-talk') value.grade.crossTalk = [{ field: 'reference', value: 'p07' }];
    if (kind === 'site failure') value.site = { error: 'fixture failure' };
    if (kind === 'wrong-reference submit') value.site.submissions.push({ form: 'settings', data: { ...data, reference: 'p07' } });
    assert.equal(gradeGateTask(value).ok, false);
  });
test('saved bank rows without payload logs still retain field failures and click-through notes', () => {
  const value = submitted(); value.site = null;
  assert.equal(gradeGateTask(value).ok, true);
  value.grade.fields[7].ok = false; value.grade.ok = false;
  assert.equal(gradeGateTask(value).ok, false);
});
test('Codex completed MCP results cannot replace fixture evidence', () => {
  const value = input();
  value.eventsText = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'js', status: 'completed',
    result: { content: [{ type: 'text', text: dialog }] } } });
  value.site.dialogs = [];
  assert.equal(gradeGateTask(value).ok, false);
  value.site.dialogs = [opened()];
  assert.equal(gradeGateTask(value).ok, true);
});
test('unrelated tasks retain their existing grader', () => {
  const value = input('form-travel');
  assert.equal(gradeSettings(value), null);
  assert.equal(settingsLogUrl(value.task), null);
  assert.equal(gradeGateTask(value).cell, 'FAIL: nothing submitted');
  const synthetic = input(); delete synthetic.task.grade;
  assert.equal(settingsLogUrl(synthetic.task), null);
  assert.equal(gradeSettings(synthetic), null);
  assert.equal(gradeGateTask(synthetic).cell, 'FAIL: nothing submitted');
});
test('a held dialog still checks the task answer patterns', () => {
  const value = input(); value.task.expect = ['a required answer'];
  assert.equal(gradeGateTask(value).ok, false);
  delete value.task.expect; value.task.forbid = ['every device'];
  assert.equal(gradeGateTask(value).ok, false);
});
test('settings evidence logs retain all attempts and isolate task cursors without changing other pages', async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'gr1-settings-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'site')); writeFileSync(join(root, 'site/index.html'), '<h1>Unchanged fixture</h1>');
  const submissionsForGrade = [];
  const server = await startGateForms(root, { ports: [0], gradeToken: (token, submissions) => { submissionsForGrade.push(submissions); return { token }; } });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.ports[0]}`;
  const json = async path => (await fetch(origin + path)).json();
  const submit = payload => fetch(origin + '/submit/settings', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(await (await fetch(origin + '/')).text(), '<h1>Unchanged fixture</h1>');
  await submit({ reference: 'p07' });
  const before = await json('/gate-log/p08');
  assert.equal(before.cursor, 1);
  await submit({ ...data, reference: 'wrong', extra: true });
  await submit(data);
  const site = await json(`/gate-log/p08?after=${before.cursor}`);
  assert.equal(site.submissions.length, 2);
  assert.equal(site.submissions[0].data.extra, true);
  assert.equal(site.submissions[1].data.reference, 'p08');
  assert.equal((await json('/gate-log/p07?after=3')).submissions.length, 0);
  assert.equal((await json('/gate-log/p08?after=99')).error, 'invalid submission cursor');
  assert.equal((await json('/gate-log/p08?after=-1')).error, 'invalid submission cursor');
  assert.equal((await json('/gate-log/p04')).lines.filter(line => line.startsWith('action')).length, 3);
  await json('/grade/p08'); assert.equal(submissionsForGrade[0].get('p08').length, 1);
  assert.equal(settingsLogUrl({ name: 'form-settings-helium', grade: origin + '/grade/p08' }), origin + '/gate-log/p08');
});
test('offline bank regrading requires the complete diagnostic bank', t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'gr1-empty-bank-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => regradeSettingsBank(root), /expected 10 rounds/);
});

test('offline regrading preserves unrelated failures and leaves all input bytes intact', t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'gr1-bank-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const savedFiles = [];
  for (const side of ['A', 'B']) for (let round = 1; round <= 5; round++) {
    const dir = join(root, `rerun-chrome-haiku-${side}-r${round}`); mkdirSync(dir);
    const rows = [];
    for (const task of ['form-settings', 'form-settings-helium']) {
      const value = input(task), taskDir = join(dir, task); mkdirSync(taskDir);
      value.site = null; // Old banks did not record dialogs or payloads.
      rows.push({ ...value, surface: 'sleight-turbo', wallMs: 2000,
        outcome: { ok: false, problems: ['nothing submitted', ...(side === 'B' && round === 3 ? ['inventory failure'] : [])] } });
      const file = join(taskDir, 'events.jsonl'); writeFileSync(file, value.eventsText); savedFiles.push([file, value.eventsText]);
    }
    rows.push(...Array.from({ length: 11 }, (_, i) => ({ task: { name: `other-${i}` }, outcome: { ok: true } })));
    const file = join(dir, 'results.json'), raw = JSON.stringify(rows); writeFileSync(file, raw); savedFiles.push([file, raw]);
  }
  const result = regradeSettingsBank(root);
  assert.deepEqual(result.totals, { A: { before: 55, after: 55, total: 65 }, B: { before: 55, after: 55, total: 65 } });
  assert.equal(result.rows.filter(row => row.problems.includes('inventory failure')).length, 2);
  assert.equal(result.taskStats['form-settings'].A.after.expected, null);
  assert.equal(result.rows[0].decidability, 'stop unverified: fixture dialog records unavailable');
  assert.deepEqual(regradeSettingsBank(root), result);
  for (const [file, raw] of savedFiles) assert.equal(readFileSync(file, 'utf8'), raw);
});

test('the real gate wires dialog evidence and submission cursors across both settings tasks without a browser', async t => {
  const { runRealGate } = await import('../bench/fowl/real-gate.mjs');
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'gr1-gate-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'site/settings.html'), `<script type="module">
$('#form').addEventListener('submit', (ev) => {
  if (showErrors(e)) $('#confirm').showModal();
});
$('#cancel').onclick = () => $('#confirm').close();
$('#do-save').onclick = async () => { const v = values(); $('#confirm').close(); await submit('settings', v); };
</script>`);
  const server = await startGateForms(root, { ports: [0], gradeToken: (token, submissions) => {
    const expected = { ...data, reference: token }, records = submissions.get(token) ?? [];
    return { form: 'settings', ok: records.length > 0, submissions: records.length, crossTalk: [],
      fields: Object.entries(expected).map(([name, value]) => ({ name, expected: value, got: records.at(-1)?.data[name] ?? null, ok: records.length > 0 })) };
  } });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.ports[0]}`;
  const tasks = ['form-settings', 'form-settings-helium'].map((name, i) => ({ name, browser: 'chrome', prompt: 'Fixture settings.',
    result: 'the submission id', grade: `${origin}/grade/p0${i + 7}` }));
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(root, 'out') }, tasks,
    runner: { gradeOutcome: ({ grade }) => ({ problems: grade.submissions ? [] : ['nothing submitted'] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(root, 'lock'), admit: async () => {}, checkOwner: async () => ({ ok: true }),
      startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 42, stop: async () => ({ browserClosed: true }) }),
      resetBrowser: async () => ({}), observeBrowser: async () => ({ observed: true, tabs: {} }),
      runAgent: async arm => {
        mkdirSync(arm.dir); writeFileSync(join(arm.dir, 'events.jsonl'), events());
        if (arm.task.name === 'form-settings') await fetch(origin + '/submit/settings', { method: 'POST', body: JSON.stringify({ ...data, reference: 'p07' }) });
        else {
          const html = await (await fetch(origin + '/settings', { headers: { 'sec-fetch-dest': 'document' } })).text();
          const key = JSON.parse(html.match(/const gateKey = (.*);/)[1]);
          await fetch(origin + '/gate-log/settings-dialog', { method: 'POST', body: JSON.stringify({ key, sequence: 1, event: 'opened', data }) });
        }
        return { ...input().run, started: 1, finished: 2, groupClean: true, evidence: { successfulCalls: 1 } };
      } } });
  assert.deepEqual(rows.map(row => row.outcome.ok), [true, true]);
  assert.deepEqual(rows.map(row => row.site.submissions.length), [1, 0]);
  assert.deepEqual(rows.map(row => row.site.dialogs.length), [0, 1]);
  assert.match(rows[0].outcome.settings, /clicked through/);
  assert.match(rows[1].outcome.settings, /stopped before/);
});
