import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwned } from '../bench/preapproved-process.mjs';
import { gradeControl, makeReport, parseEvidence, traceCalls, runControl, probePlan, probeInitProblems } from '../bench/sf6-focus-probe.mjs';

const event = (index, type, field, phase = 'before-refusal') => ({ index, type, field, phase });
const initial = () => ({ documentId: 'fixture-document', phase: 'before-refusal', memo: '', reference: 'reference stays', focus: 'memo',
  events: [event(0, 'focusin', 'memo')] });
function proof(control = 'moved') {
  const before = initial();
  const boundary = control === 'moved' ? { ...before, phase: 'after-refusal', focus: 'reference',
    events: [...before.events, event(1, 'focusin', 'reference', 'after-refusal')] } : structuredClone(before);
  const events = [...boundary.events];
  if (control === 'moved') events.push(event(events.length, 'focusin', 'memo', 'after-refusal'));
  events.push(event(events.length, 'beforeinput', 'memo', boundary.phase), event(events.length + 1, 'input', 'memo', boundary.phase));
  return { control, initial: before, afterRefusal: structuredClone(before), boundary,
    final: { ...boundary, memo: 'cobalt heron 47', focus: 'memo', events },
    refusal: { observed: true, numericTarget: true, nothingSent: true, stopped: true, order: 2 },
    stopped: { observed: true, order: 3 }, boundaryOrder: 4, resumeOrder: 5,
    recovery: { traceComplete: true, unknown: [], actions: [
      ...(control === 'moved' ? [{ method: 'click', target: 'memo', valid: true, sent: true }] : []),
      { method: 'typeText', valid: true, sent: true, text: 'cobalt heron 47' }] },
    trace: ['trace-model.jsonl'], transcripts: ['transcript.jsonl'],
    modelIds: ['claude-haiku-5-5'], sessionIds: ['session-one'], engineVersion: '26.1023.50603',
    cleanup: { browserClosed: true, profileDeleted: true, noWindows: true, driverCollected: true, modelCollected: true, serverClosed: true } };
}
for (const control of ['moved', 'unchanged']) test(`${control} control passes only with complete ordered proof`, () => {
  const result = gradeControl(proof(control));
  assert.equal(result.status, 'pass');
  assert.ok(Object.values(result.checks).every(check => check.status === 'pass'));
});
for (const [name, mutate] of [
  ['missing trace', p => p.trace = []],
  ['missing transcript', p => p.transcripts = []],
  ['trace incomplete', p => p.recovery.traceComplete = false],
  ['unknown target', p => p.recovery.unknown.push('computed click target')],
  ['unobserved focus', p => p.boundary.focus = ''],
  ['focus before refusal', p => p.boundaryOrder = 1],
  ['model not stopped', p => p.stopped.observed = false],
  ['missing engine', p => p.engineVersion = null],
  ['missing actual model', p => p.modelIds = []],
  ['different session', p => p.sessionIds.push('session-two')],
  ['unknown event target', p => p.final.events.push(event(p.final.events.length, 'input', 'unknown'))],
  ['missing refusal evidence', p => p.refusal = null],
  ['cleanup unknown', p => p.cleanup.noWindows = null],
]) test(`${name} is inconclusive`, () => {
  const p = proof(); mutate(p); assert.equal(gradeControl(p).status, 'inconclusive');
});
for (const [name, mutate] of [
  ['repeated numeric input', p => p.recovery.actions[1].valid = false],
  ['Reference input', p => p.final.events.push(event(p.final.events.length, 'input', 'reference', 'after-refusal'))],
  ['wrong Memo value', p => p.final.memo = 'wrong'],
  ['Reference changed', p => p.final.reference = 'wrong'],
  ['no repair click', p => p.recovery.actions.shift()],
  ['extra repair click', p => p.recovery.actions.unshift({ method: 'click', target: 'memo', valid: true, sent: true })],
  ['click wrong field', p => p.recovery.actions[0].target = 'reference'],
  ['refusal input', p => p.afterRefusal.memo = 'already typed'],
]) test(`${name} fails`, () => {
  const p = proof(); mutate(p); assert.equal(gradeControl(p).status, 'fail');
});
test('unchanged control accepts one Memo click and reports its speed cost', () => {
  const p = proof('unchanged'); p.recovery.actions.unshift({ method: 'click', target: 'memo', valid: true, sent: true });
  const report = makeReport([proof(), p], {});
  assert.equal(report.status, 'pass');
  const row = report.controls[1];
  assert.equal(row.checks.repairClicks.status, 'pass');
  assert.equal(row.repairClickCount, 1);
  assert.deepEqual(row.speedNotes, ['1 redundant Memo click']);
});
test('unchanged control records zero clicks without a redundant-click note', () => {
  const row = gradeControl(proof('unchanged'));
  assert.equal(row.repairClickCount, 0);
  assert.deepEqual(row.speedNotes, []);
});
for (const targets of [['reference'], ['memo', 'memo'], ['reference', 'memo'], ['memo', 'reference']])
  test(`unchanged control rejects repair clicks on ${targets.join(', ')}`, () => {
    const p = proof('unchanged');
    p.recovery.actions.unshift(...targets.map(target => ({ method: 'click', target, valid: true, sent: true })));
    const row = gradeControl(p);
    assert.equal(row.status, 'fail');
    assert.equal(row.checks.repairClicks.status, 'fail');
    assert.equal(row.repairClickCount, targets.length);
    assert.deepEqual(row.speedNotes, []);
  });
for (const target of ['memo', 'reference']) test(`unchanged control rejects an extra ${target} click after text`, () => {
  const p = proof('unchanged');
  p.recovery.actions.unshift({ method: 'click', target: 'memo', valid: true, sent: true });
  p.recovery.actions.push({ method: 'click', target, valid: true, sent: true });
  assert.equal(gradeControl(p).checks.repairClicks.status, 'fail');
});
test('unchanged control rejects a sole Reference click after text', () => {
  const p = proof('unchanged');
  p.recovery.actions.push({ method: 'click', target: 'reference', valid: true, sent: true });
  assert.equal(gradeControl(p).checks.repairClicks.status, 'fail');
});
test('moved control rejects a Memo click after text', () => {
  const p = proof(); p.recovery.actions.push(p.recovery.actions.shift());
  assert.equal(gradeControl(p).checks.repairClicks.status, 'fail');
});
test('moved control records its required click without a redundant-click note', () => {
  const row = gradeControl(proof());
  assert.equal(row.repairClickCount, 1);
  assert.deepEqual(row.speedNotes, []);
});
test('lost event history is inconclusive', () => {
  const p = proof(); p.final.events.shift(); assert.equal(gradeControl(p).status, 'inconclusive');
});
test('AX evidence parser extracts the fixture snapshot and rejects ambiguity', () => {
  const json = JSON.stringify(initial());
  assert.deepEqual(parseEvidence(`Window: "SF6R focus probe", App: Firefox.\n10 text ${json}`), initial());
  assert.deepEqual(parseEvidence(`10 text ${JSON.stringify(json)}`), initial());
  assert.throws(() => parseEvidence(json + '\n' + JSON.stringify({ ...initial(), memo: 'other' })), /ambiguous/i);
  assert.throws(() => parseEvidence('Memo empty'), /snapshot/i);
});
const trace = (direction, msg) => ({ direction, msg });
test('trace audit pairs refusals with their exact call and reads fresh element mappings', () => {
  const entries = [trace('call-received', { id: 1, params: { name: 'js', code: 'var app = await cua.getApp("Firefox");' } }),
    trace('to-client', { id: 1, result: { content: [{ type: 'text', text: '11 text field Memo\n12 text field Reference' }] } }),
    trace('call-received', { id: 2, params: { name: 'js', code: 'await app.typeText(11, "cobalt heron 47");' } }),
    trace('to-client', { id: 2, result: { isError: true, content: [{ type: 'text', text: 'typeText(text: string). no target; click field first if focus wrong; nothing was sent' }] } }),
    trace('call-received', { id: 3, params: { name: 'js', code: 'await app.click(11); await app.typeText("cobalt heron 47");' } }),
    trace('to-client', { id: 3, result: { content: [{ type: 'text', text: 'done' }] } }),
  ];
  const audit = traceCalls(entries);
  assert.equal(audit.refusals.length, 1);
  assert.equal(audit.refusals[0].numericTarget, true);
  assert.equal(audit.actions.at(-2).target, 'memo');
  assert.equal(audit.actions.at(-1).valid, true);
  assert.equal(audit.complete, true);
  assert.equal(traceCalls(entries.slice(0, -1)).complete, false);
});
test('trace audit keeps computed targets and truncated code unknown', () => {
  for (const code of ['await app.click(target);', 'await app.typeText(text);', 'await app[method](value);', 'x'.repeat(4000)]) {
    const audit = traceCalls([trace('call-received', { id: 1, params: { name: 'js', code } }), trace('to-client', { id: 1, result: {} })]);
    assert.ok(audit.unknown.length > 0, code.slice(0, 80));
  }
});
test('report preserves both controls, provenance, artifacts and cleanup', () => {
  const report = makeReport([proof(), proof('unchanged')], { commit: 'a'.repeat(40), startedAt: 'start', endedAt: 'end' });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.counts, { pass: 2, fail: 0, inconclusive: 0 });
  assert.equal(report.controls.length, 2);
  assert.deepEqual(report.controls[0].trace, ['trace-model.jsonl']);
  assert.equal(report.controls[0].cleanup.noWindows, true);
  assert.deepEqual(report.controls[0].modelIds, ['claude-haiku-5-5']);
  assert.equal(report.requestedModel, 'claude-haiku-5-5');
  assert.equal(report.auth, 'login');
  assert.equal(makeReport([proof()], {}).status, 'inconclusive');
  assert.equal(makeReport([proof()], {}).controls.length, 2);
  assert.equal(makeReport([proof(), proof('unchanged')], { lockReleased: false }).status, 'inconclusive');
  assert.equal(makeReport([proof(), proof('unchanged')], { error: 'lock replaced' }).status, 'inconclusive');
});
test('orchestration stops before mutation and sends only the exact continuation', async () => {
  for (const control of ['moved', 'unchanged']) {
    const p = proof(control), calls = [];
    const snapshots = [p.initial, p.afterRefusal, p.boundary, p.final];
    const io = { snapshot: async () => { calls.push('snapshot'); return snapshots.shift(); },
      turn: async message => { calls.push(message); return { stopped: true }; },
      refusal: async () => p.refusal,
      move: async () => calls.push('move'),
      finish: async () => ({ ...p, cleanup: p.cleanup }),
      cleanup: async () => { calls.push('cleanup'); return p.cleanup; } };
    const row = await runControl(control, io);
    assert.equal(row.status, 'pass');
    assert.equal(calls.filter(call => call === 'Continue the original memo task.').length, 1);
    assert.equal(calls.includes('move'), control === 'moved');
    assert.equal(calls.filter(call => call.includes('The task is to enter')).length, 0);
    if (control === 'moved') assert.ok(calls.indexOf('move') < calls.indexOf('Continue the original memo task.'));
    assert.equal(calls.at(-1), 'cleanup');
  }
});
test('failed refusal admission cleans up and does not mutate or continue', async () => {
  const calls = [];
  const row = await runControl('moved', { snapshot: async () => initial(), turn: async () => ({ stopped: true }),
    refusal: async () => null, move: async () => calls.push('move'), finish: async () => ({}), cleanup: async () => calls.push('cleanup') });
  assert.equal(row.status, 'inconclusive'); assert.deepEqual(calls, ['cleanup']);
});
test('dry plan selects both controls and no live actions', () => {
  const plan = probePlan(); assert.deepEqual(plan.controls, ['moved', 'unchanged']);
  assert.equal(plan.model, 'claude-haiku-5-5'); assert.equal(plan.effort, 'high'); assert.equal(plan.auth, 'login');
  assert.equal(plan.drives, false); assert.equal(plan.lock, false);
  for (const output of [plan, makeReport([], {})]) {
    assert.match(output.refusalDelivery, /driver-sent.*transcript excerpt.*user message/);
    assert.match(output.refusalDelivery, /code and sleight reply only.*without the driver call title/);
    assert.match(output.refusalDelivery, /recovery after a refusal the model reads, not after its own mistake/);
  }
});
test('owned process stdin keeps the same child alive across two turns', async () => {
  const input = new PassThrough(); let received = '';
  const done = runOwned(process.execPath, ['-e', `let n=0; process.stdin.on('data', b=>{process.stdout.write(String(++n)+':'+b); if(n===2)process.stdin.pause();});`],
    { input, timeoutMs: 3000, onStdout: chunk => { received += chunk; if (received.includes('1:first') && !received.includes('2:')) input.end('second\n'); } });
  input.write('first\n');
  const result = await done;
  assert.equal(result.exit.code, 0); assert.equal(result.groupClean, true); assert.equal(result.timedOut, false);
  assert.equal(result.stdout, '1:first\n2:second\n');
});

test('cleanup failure overrides an otherwise passing control', async () => {
  const p = proof(); const snapshots = [p.initial, p.afterRefusal, p.boundary, p.final];
  const row = await runControl('moved', { snapshot: async () => snapshots.shift(), turn: async () => ({ stopped: true }),
    refusal: async () => p.refusal, move: async () => {}, finish: async () => ({ ...p, cleanup: { ...p.cleanup, browserClosed: false } }),
    cleanup: async () => { throw Error('Firefox quit not confirmed'); } });
  assert.notEqual(row.status, 'pass'); assert.match(row.error, /Firefox/);
});

test('runtime accepts one matching init per turn in the same model session', async t => {
  const { streamSession, modelPlan } = await import('../bench/sf6-focus-runtime.mjs');
  const messages = []; let runs = 0, complete;
  const plan = { ...modelPlan({ command: 'fake', cwd: join(tmpdir(), 'fake'), config: join(tmpdir(), 'lane-claude-fake'), dir: join(tmpdir(), 'fake'), url: 'http://127.0.0.1:1234/owned/' }), dir: join(tmpdir(), 'fake') };
  const session = streamSession(plan, { run: async (_command, _args, options) => {
    runs++;
    const done = new Promise(resolve => { complete = resolve; });
    let buffer = '';
    options.input.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1);
        options.onStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'same', mcp_servers: [{ name: 'plugin:sleight:computer', status: 'connected' }] }) + '\n');
        const frame = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'same' }) + '\n';
        options.onStdout(frame.slice(0, 8)); options.onStdout(frame.slice(8));
      }
    });
    options.input.on('end', () => complete({ groupClean: true, code: 0 }));
    return done;
  } });
  t.after(() => session.close());
  await session.turn((await import('../bench/sf6-focus-probe.mjs')).INSTRUCTION);
  assert.equal(messages.length, 1);
  await session.turn('Continue the original memo task.');
  assert.equal(messages[1].message.content, 'Continue the original memo task.');
  assert.match(messages[0].message.content, /current numeric element number/);
  assert.equal(runs, 1);
  assert.equal((await session.close()).groupClean, true);
});

test('world arm setup removes host credentials and keeps native trace isolation', async () => {
  const { runtimeEnvironment, modelPlan } = await import('../bench/sf6-focus-runtime.mjs');
  const env = runtimeEnvironment(join(tmpdir(), 'lane-claude-fixture'), join(tmpdir(), 'trace'), {
    PATH: '/bin', HOME: '/home/fake', USER: 'fixture', CLAUDE_CODE_OAUTH_TOKEN: 'discard', ANTHROPIC_API_KEY: 'discard',
    SLEIGHT_SURFACES: 'browser,computer', CLAUDE_CONFIG_DIR: '/owner/config', NODE_OPTIONS: '--bad', SLEIGHT_CONFIRM_PAYMENTS: 'never' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.SLEIGHT_CONFIRM_PAYMENTS, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(tmpdir(), 'lane-claude-fixture'));
  assert.equal(env.SLEIGHT_SURFACES, 'computer'); assert.equal(env.SLEIGHT_TRACE_CODE, '1');
  const plan = modelPlan({ command: 'fake', cwd: join(tmpdir(), 'fake'), config: join(tmpdir(), 'lane-claude-fixture'), dir: join(tmpdir(), 'fake'), url: 'http://127.0.0.1:1234/owned/' });
  assert.ok(plan.args.includes('--plugin-dir')); assert.ok(plan.args.includes('--input-format'));
  assert.equal(plan.args[plan.args.indexOf('--setting-sources') + 1], '');
  assert.equal(plan.args.includes('--strict-mcp-config'), false);
  assert.equal(plan.settings.autoMemoryEnabled, false);
  assert.deepEqual(Object.keys(plan.mcp.mcpServers), ['plugin:sleight:computer']);
});

test('fixture host serves only its exact loopback nonce and closes', async t => {
  const { serveWorldFixture } = await import('../bench/world/browser-fixtures.mjs');
  const { fixtureHandler } = await import('../bench/sf6-focus-runtime.mjs');
  const ctx = { nonce: 'owned' };
  await serveWorldFixture(ctx, origin => fixtureHandler('<title>owned</title>', ctx.nonce, origin));
  t.after(() => ctx.closeServer());
  const response = await fetch(ctx.url); assert.equal(response.status, 200); assert.equal(await response.text(), '<title>owned</title>');
  assert.equal((await fetch(ctx.url + 'wrong')).status, 404);
  assert.equal((await fetch(ctx.url, { method: 'POST' })).status, 404);
  assert.equal((await fetch(ctx.url, { headers: { Origin: 'http://unrelated' } })).status, 404);
});

test('standalone dry-run prints JSON without starting a CLI or app', async () => {
  const result = await runOwned(process.execPath, ['bench/sf6-focus-probe.mjs', '--dry-run'], { env: process.env, timeoutMs: 10000 });
  const plan = JSON.parse(result.stdout);
  assert.equal(result.exit.code, plan.admission.ready ? 0 : 1, result.stderr);
  assert.equal(plan.drives, false); assert.equal(plan.lock, false);
  assert.equal(plan.admission.config.accountLogin.includes('deferred'), true);
  assert.equal(plan.admission.fixtureSHA256.length, 64);
});

test('numeric refusal must target the freshly observed Memo number and exact probe text', () => {
  const make = code => traceCalls([
    trace('call-received', { id: 1, params: { name: 'js', code: 'var app = await cua.getApp("Firefox");' } }),
    trace('to-client', { id: 1, result: { content: [{ type: 'text', text: '11 text field Memo\n12 text field Reference' }] } }),
    trace('call-received', { id: 2, params: { name: 'js', code } }),
    trace('to-client', { id: 2, result: { isError: true, content: [{ type: 'text', text: 'typeText(text: string); nothing was sent' }] } }),
  ]);
  assert.equal(make('await app.typeText(12, "cobalt heron 47");').refusals[0].numericTarget, false);
  assert.equal(make('await app.typeText(11, "wrong");').refusals[0].numericTarget, false);
  assert.equal(make('await app.typeText(11, "cobalt heron 47");').refusals[0].numericTarget, true);
});

test('unknown receiver and stale numeric mapping never certify an input target', () => {
  const entries = [trace('call-received', { id: 1, params: { name: 'js', code: 'var app = await cua.getApp("Firefox");' } }),
    trace('to-client', { id: 1, result: { content: [{ type: 'text', text: 'Window: "SF6R focus probe", App: Firefox.\n11 text field Memo' }] } }),
    trace('call-received', { id: 2, params: { name: 'js', code: 'await app.getAXState();' } }),
    trace('to-client', { id: 2, result: { content: [{ type: 'text', text: 'Window: "SF6R focus probe", App: Firefox.\n21 text field Memo' }] } }),
    trace('call-received', { id: 3, params: { name: 'js', code: 'await other.click(21); await other.typeText("cobalt heron 47");' } }),
    trace('to-client', { id: 3, result: {} }),
    trace('call-received', { id: 4, params: { name: 'js', code: 'await app.click(11);' } }),
    trace('to-client', { id: 4, result: {} }),
  ];
  const result = traceCalls(entries);
  assert.ok(result.unknown.some(value => /receiver/.test(value)));
  assert.equal(result.actions.at(-1).target, null);
});

test('runtime refuses a result without the arm init catalog', async t => {
  const { streamSession } = await import('../bench/sf6-focus-runtime.mjs');
  const plan = { command: 'fake', args: [], env: {}, mcp: { mcpServers: { 'plugin:sleight:computer': {} } } };
  const session = streamSession(plan, { run: (_command, _args, options) => new Promise(resolve => {
    options.input.on('data', () => options.onStdout(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'same' }) + '\n'));
    options.input.on('end', () => resolve({ code: 0, groupClean: true }));
  }) });
  t.after(() => session.close());
  await assert.rejects(session.turn((await import('../bench/sf6-focus-probe.mjs')).INSTRUCTION), /catalog|init/i);
  await session.close();
});

const catalogConfig = { mcpServers: { 'plugin:sleight:computer': {} } };
const initFrame = () => ({ type: 'system', subtype: 'init', session_id: 'same',
  mcp_servers: [{ name: 'plugin:sleight:computer', status: 'connected', source: 'dynamic' }] });
const resultFrame = () => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'same' });
for (const [name, frames, starts, problem] of [
  ['one start', [initFrame(), resultFrame()], 1, null],
  ['two starts', [initFrame(), resultFrame(), initFrame(), resultFrame()], 2, null],
  ['missing second init', [initFrame(), resultFrame(), resultFrame()], 2, /Start 2:.*received 0/],
  ['duplicate first init', [initFrame(), initFrame(), resultFrame(), resultFrame()], 2, /Start 1:.*received 2/],
  ['duplicate second init', [initFrame(), resultFrame(), initFrame(), initFrame(), resultFrame()], 2, /Start 2:.*received 2/],
  ['extra unfinished start', [initFrame(), resultFrame(), initFrame()], 1, /after the last/],
  ['missing second result', [initFrame(), resultFrame(), initFrame()], 2, /completed starts/],
]) test(`probe catalog validates ${name}`, () => {
  const errors = probeInitProblems(frames, catalogConfig, starts);
  if (problem) assert.match(errors.join('; '), problem);
  else assert.deepEqual(errors, []);
});
for (const [name, mutate, problem] of [
  ['missing catalog', init => delete init.mcp_servers, /missing or malformed/],
  ['disconnected server', init => init.mcp_servers[0].status = 'failed', /is failed/],
  ['extra server', init => init.mcp_servers.push({ name: 'other', status: 'connected' }), /also loads other/],
  ['changed catalog', init => init.mcp_servers[0].source = 'plugin', /catalog changed/],
  ['changed session', init => init.session_id = 'other', /session identity/],
]) test(`probe continuation refuses ${name}`, () => {
  const second = initFrame(); mutate(second);
  assert.match(probeInitProblems([initFrame(), resultFrame(), second, resultFrame()], catalogConfig, 2).join('; '), problem);
});

test('live adapter with fake apps retains refusal and cleanup evidence for both controls', async t => {
  const { mkdtempSync, mkdirSync, appendFileSync, rmSync, readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { liveControl } = await import('../bench/sf6-focus-runtime.mjs');
  const bank = mkdtempSync(join(tmpdir(), 'sf6-runtime-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  for (const [control, silentMove, refusalProblem] of [['moved', false], ['unchanged', false], ['unchanged', true],
    ...['forwarded', 'missing-reply', 'successful-reply', 'mismatched-reply', 'missing-memo', 'ambiguous-memo'].map(problem => ['unchanged', false, problem])]) await t.test(`${control}: ${refusalProblem ?? (silentMove ? 'silent-move' : 'recovery')}`, async () => {
    const blocked = silentMove || !!refusalProblem;
    const memoProblem = ['missing-memo', 'ambiguous-memo'].includes(refusalProblem);
    const p = proof(control), calls = []; let state = initial(), ownedURL, reads = 0, driverInputs = 0;
    const row = await liveControl(control, { dir: join(bank, refusalProblem ?? (silentMove ? 'silent-move' : control)), config: join(tmpdir(), 'lane-claude-fake'),
      command: 'fake-claude', signal: new AbortController().signal, gate: async () => {} }, {
      engineRead: () => ({ version: '26.1023.50603', at: new Date().toISOString() }),
      launchBrowser: async (plan, options) => {
        ownedURL = options.initialPage.url;
        calls.push('launch'); assert.equal(plan.browser, 'firefox'); assert.equal(plan.profileOwned, undefined);
        assert.equal(options.initialPage.title, 'SF6R focus probe');
        return { ...plan, pid: 123, version: '157', stop: async () => { calls.push('quit'); return { browserClosed: true, profileDeleted: true }; } };
      },
      connect: async options => {
        let id = 0;
        mkdirSync(options.env.SLEIGHT_TRACE, { recursive: true });
        const driverTrace = join(options.env.SLEIGHT_TRACE, 'trace-99.jsonl');
        const record = e => appendFileSync(driverTrace, JSON.stringify(e) + '\n');
        return { call: async (name, args) => {
          const callId = ++id;
          record(trace('call-received', { id: callId, params: { name, ...args } }));
          if (args.code.includes('.typeText(')) {
            driverInputs++;
            const result = { isError: true, content: [{ type: 'text', text: 'typeText(text: string); nothing was sent' }] };
            if (refusalProblem === 'successful-reply') result.isError = false;
            if (refusalProblem === 'forwarded') record(trace('to-server', { id: callId, method: 'tools/call' }));
            if (refusalProblem !== 'missing-reply') record(trace('to-client', { id: callId, result: refusalProblem === 'mismatched-reply' ? { ...result, extra: true } : result }));
            return result;
          }
          assert.equal(name, 'js');
          if (args.code === 'await app.getAXState({disableDiffing:true});') reads++;
          if (args.code.includes('Move focus to Reference after refusal')) {
            calls.push('move'); assert.match(args.code, /\.performSecondaryAction\(\{label:.*\},\s*"Press"\)/);
            assert.doesNotMatch(args.code, /pressKey|typeText|\[\s*\d+\s*,/);
            state = structuredClone(p.boundary);
          }
          const memoRows = options.env.SLEIGHT_TRACE.endsWith('driver-2') && memoProblem ?
            (refusalProblem === 'missing-memo' ? '' : '\n\t11 text field Memo\n\t15 text field Memo') : '\n\t11 text field Memo';
          const result = { content: [{ type: 'text', text: 'Window: "SF6R focus probe", App: Firefox.\n10 HTML Content URL: ' + ownedURL.replace('http://', '') + memoRows + '\n\t12 text field Reference\n\t13 button Move focus to Reference after refusal\n\t14 text ' + JSON.stringify(state) +
            (state.focus === 'memo' && !(silentMove && reads === 4) ? '\nThe focused UI element is 11 text field Memo' : '\nThe focused UI element is 12 text field Reference') }] };
          record(trace('to-client', { id: callId, result }));
          return result;
        }, close: async () => true, cleanupReceipt: () => ({ groupCollected: true }) };
      },
      startSession: plan => {
        assert.match(plan.handoff, /typeText\(11/);
        assert.equal(plan.handoff.includes('Refuse numeric-target Memo input'), false);
        mkdirSync(plan.modelTrace);
        appendFileSync(join(dirname(plan.modelTrace), 'transcript.jsonl'), JSON.stringify({ type: 'result', session_id: 'same' }) + '\n');
        const file = join(plan.modelTrace, 'trace-100.jsonl');
        const write = records => records.forEach(e => {
          appendFileSync(file, JSON.stringify(e) + '\n');
          if (e.direction === 'call-received') events.push({ type: 'assistant', session_id: 'same', message: {
            model: 'claude-haiku-5-5', content: [{ type: 'tool_use', name: 'mcp__plugin_sleight_computer__js', input: { code: e.msg.params.code } }] } });
        });
        const events = [{ type: 'system', subtype: 'init', session_id: 'same' }, { type: 'assistant', session_id: 'same', message: { model: 'claude-haiku-5-5' } }];
        return { events, turn: async message => {
          calls.push(message);
          assert.equal(message, 'Continue the original memo task.');
          write([trace('call-received', { id: 1, params: { name: 'js', code: 'var app = await cua.getApp("Firefox");' } }),
            trace('to-client', { id: 1, result: { content: [{ type: 'text', text: 'Window: "SF6R focus probe", App: Firefox.\n11 text field Memo\n12 text field Reference' }] } }),
            trace('call-received', { id: 3, params: { name: 'js', code: (control === 'moved' ? 'await app.click(11); ' : '') + 'await app.typeText("cobalt heron 47");' } }),
            trace('to-client', { id: 3, result: { content: [{ type: 'text', text: 'done' }] } })]);
          state = structuredClone(p.final);
          return { stopped: true, event: { session_id: 'same', subtype: 'success' } };
        }, close: async () => { calls.push('model-close'); return { groupClean: true, code: 0 }; } };
      },
      inspectWindows: async pid => { assert.equal(pid, 123); calls.push('windows'); return []; },
    });
    assert.equal(row.status, blocked ? 'inconclusive' : 'pass', JSON.stringify(row.checks));
    if (refusalProblem) {
      assert.match(row.error, memoProblem ? /Unique current Memo element unproved/ : /One numeric-target refusal unproved/);
      assert.equal(calls.includes('Continue the original memo task.'), false);
    }
    if (silentMove) {
      assert.match(row.error, /AX and page focus disagree/);
      assert.equal(calls.includes('Continue the original memo task.'), false);
      assert.equal(row.boundary, undefined);
      assert.equal(row.afterRefusal.axFocus.field, 'memo');
    }
    assert.equal(calls.filter(c => c === 'launch').length, 1);
    assert.equal(calls.includes('move'), control === 'moved');
    if (!blocked) assert.ok(calls.indexOf('model-close') >= 0 && calls.indexOf('model-close') < calls.indexOf('quit'));
    else assert.equal(calls.includes('model-close'), false);
    assert.equal(row.engineVersion, '26.1023.50603');
    assert.equal(row.transcripts.length, blocked ? 0 : 1);
    assert.equal(row.refusalSource, 'driver');
    assert.equal(driverInputs, memoProblem ? 0 : 1);
    if (memoProblem) assert.equal(row.refusalTranscript, undefined);
    else {
      const seed = JSON.parse(readFileSync(row.refusalTranscript, 'utf8'));
      assert.equal(seed.request.code, 'await app.typeText(11, "cobalt heron 47");');
    }
    // The driver trace includes its numeric typeText, while recovery contains only model actions.
    assert.equal(row.recovery.actions.some(action => action.numericTarget), false);
    if (!blocked) {
      assert.deepEqual(row.recovery.actions.map(action => action.method), control === 'moved' ? ['click', 'typeText'] : ['typeText']);
      assert.ok(row.recovery.actions.every(action => action.sent === true));
      assert.equal(row.refusalTrace.actions.filter(action => action.method === 'typeText' && action.numericTarget && !action.sent).length, 1);
    } else assert.deepEqual(row.recovery.actions, []);
    const journal = readFileSync(row.journal, 'utf8');
    if (!blocked) {
      assert.ok(journal.indexOf('refusal-audit') < journal.indexOf('model-start'));
      assert.ok(journal.indexOf('driver-stopped') < journal.indexOf('model-start'));
    } else assert.equal(journal.includes('model-start'), false);
  });
});

test('a focus-changing key leaves later input targeting inconclusive', () => {
  const p = proof('unchanged');
  p.recovery.actions.unshift({ method: 'pressKey', key: 'super+l', valid: true, sent: true });
  assert.equal(gradeControl(p).status, 'inconclusive');
});

test('failed driver startup retains uncertain process ownership', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { liveControl } = await import('../bench/sf6-focus-runtime.mjs');
  const bank = mkdtempSync(join(tmpdir(), 'sf6-startup-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const row = await liveControl('moved', { dir: join(bank, 'control'), config: join(tmpdir(), 'lane-claude-fake'), command: 'fake',
    signal: new AbortController().signal, gate: async () => {} }, {
    engineRead: () => ({ version: '26.1023.50603', at: new Date().toISOString() }),
    launchBrowser: async plan => ({ ...plan, pid: 123, stop: async () => ({ browserClosed: true, profileDeleted: true }) }),
    connect: async () => { throw Object.assign(Error('failed initialize'), { cleanupReceipt: { childCollected: false, groupCollected: false } }); },
    inspectWindows: async () => [],
  });
  assert.equal(row.cleanup.driverCollected, false);
  assert.equal(row.status, 'inconclusive');
});

test('a control stopped before continuation has no recovery verdict', () => {
  const p = proof(); delete p.resumeOrder; delete p.final;
  p.recovery.actions = []; p.error = 'Focus boundary unavailable';
  assert.equal(gradeControl(p).status, 'inconclusive');
});

test('trace audit cannot certify an unawaited native action', () => {
  const audit = traceCalls([
    trace('call-received', { id: 1, params: { name: 'js', code: 'var app = await cua.getApp("Firefox");' } }),
    trace('to-client', { id: 1, result: { content: [{ type: 'text', text: '11 text field Memo' }] } }),
    trace('call-received', { id: 2, params: { name: 'js', code: 'app.typeText("cobalt heron 47");' } }),
    trace('to-client', { id: 2, result: {} }),
  ]);
  assert.ok(audit.unknown.some(reason => /await/.test(reason)));
});

test('a focus property without its observed focus event cannot resume the model', async () => {
  const p = proof(), calls = [];
  const snapshots = [p.initial, p.afterRefusal, { ...p.boundary, events: p.initial.events }];
  const row = await runControl('moved', { snapshot: async () => snapshots.shift(),
    turn: async message => { calls.push(message); return { stopped: true }; }, refusal: async () => p.refusal,
    move: async () => {}, cleanup: async () => p.cleanup, finish: async () => ({ trace: p.trace, transcripts: p.transcripts,
      modelIds: p.modelIds, sessionIds: p.sessionIds, engineVersion: p.engineVersion, recovery: p.recovery }) });
  assert.equal(calls.length, 0);
  assert.equal(row.status, 'inconclusive');
});

test('driver observations bind the exact fixture window and loopback URL', async () => {
  const { ownedFixtureObservation } = await import('../bench/sf6-focus-runtime.mjs');
  const url = 'http://127.0.0.1:1234/owned/';
  const text = 'Window: "SF6R focus probe", App: Firefox.\n25 HTML Content URL: 127.0.0.1:1234/owned/';
  assert.equal(ownedFixtureObservation(text, url), true);
  assert.equal(ownedFixtureObservation(text.replace('SF6R focus probe', 'Owner window') + '\nSF6R focus probe', url), false);
  assert.equal(ownedFixtureObservation(text.replace('/owned/', '/other/'), url), false);
  assert.equal(ownedFixtureObservation(text.replace('App: Firefox', 'App: Safari'), url), false);
});

test('every transcript tool call needs its matching relay trace entry', async () => {
  const { traceMatchesTranscript } = await import('../bench/sf6-focus-runtime.mjs');
  const use = code => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__plugin_sleight_computer__js', input: { code } }] } });
  const call = code => trace('call-received', { id: code, params: { name: 'js', code } });
  const events = [use('await app.click(11);'), use('await app.typeText("cobalt heron 47");')];
  const entries = [call('await app.click(11);'), call('await app.typeText("cobalt heron 47");')];
  assert.equal(traceMatchesTranscript(events, entries), true);
  assert.equal(traceMatchesTranscript(events, entries.slice(1)), false);
  assert.equal(traceMatchesTranscript(events.slice(1), entries), false);
  assert.equal(traceMatchesTranscript(events, entries.toReversed()), false);
  assert.equal(traceMatchesTranscript([], []), false);
});
