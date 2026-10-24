import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { replayCalls } = await import('../bench/replay/engine.mjs');
const { TargetMapper, divergence } = await import('../bench/replay/mapping.mjs');
const { campaignEvidence, checkEvidence } = await import('../bench/replay/checks.mjs');
const { loadCheck, main } = await import('../bench/replay/run.mjs');
const { loadRecording } = await import('../bench/replay/recording.mjs');
const { prepareReplay } = await import('../bench/replay/fixtures.mjs');

const text = value => ({ content: [{ type: 'text', text: value }] });
const tree = id => `Window: "fixture.txt", App: TextEdit.\n0 window fixture.txt\n  ${id} button Save`;
const call = (name, args, value) => ({ server: 'plugin:sleight:computer', name, arguments: args, result: text(value) });
const recording = () => [
  call('open_file', { app: 'TextEdit', path: '/tmp/fixture.txt' }, 'Opened fixture.txt'),
  call('js', { code: 'let app = await cua.getApp("TextEdit")' }, tree(2)),
  call('js', { code: 'await app.click(2)' }, tree(2)),
  call('js', { code: 'await app.click(2)' }, tree(2)),
  call('js', { code: 'await app.click(2)' }, tree(2)),
  call('js', { code: 'await app.pressKey("super+w")' }, 'sleight: the app has no windows left. Nothing more to read.'),
];
const acquired = (handle, id = 2) => `${tree(id)}\nWindow handle: \`${handle}\`, already acquired.`;

test('acquired handle mapping preserves identifier boundaries, fresh element mappings and A/B identity', async () => {
  const mapper = new TargetMapper(), sent = [];
  const calls = [call('open_file', { app: 'TextEdit', path: '/tmp/fixture.txt' }, acquired('__oldApp')),
    call('js', { code: 'await __oldApp.getAXState()' }, tree(2)),
    call('js', { code: 'await __oldApp.click(2)' }, 'saved')];
  const results = [text(acquired('__freshApp', 12)), text(tree(12)), text('saved')];
  const replay = await replayCalls(calls, { comparison: 'switches', mapper, call: async (_server, _name, args) => {
    sent.push(args); return results.shift();
  } });
  assert.equal(replay.verdict, 'pass', replay.reason);
  assert.equal(sent[1].code, 'await __freshApp.getAXState()');
  assert.equal(sent[2].code, 'await __freshApp.click(12)');
  assert.equal(mapper.replaceStrings('__oldApp __oldAppOther'), '__freshApp __oldAppOther');
  assert.equal(mapper.code('await __oldApp.typeText("__oldApp")'), 'await __freshApp.typeText("__oldApp")');
  assert.match(replay.calls[0].comparisonResult.content[0].text, /`__oldApp`/);
});

test('an acquired handle needs matching window identity and a unique notice', async () => {
  for (const changed of [acquired('__freshApp').replace('App: TextEdit.', 'App: Safari.'),
    acquired('__freshApp').replace('Window: "fixture.txt"', 'Window: "other.txt"'),
    acquired('__freshApp') + '\nWindow handle: `__anotherApp`, already acquired.']) {
    const replay = await replayCalls([call('open_file', { app: 'TextEdit', path: '/tmp/fixture.txt' }, acquired('__oldApp'))], {
      comparison: 'switches', call: async () => text(changed),
    });
    assert.equal(replay.verdict, 'diverge');
    assert.match(replay.reason, /handle|window|app/i);
  }
});

async function arm(variant, { opened = 'Opened fixture.txt\nEngine app API: click, getAXState.', value, skipRead = true } = {}) {
  const calls = recording(), sent = [], events = [];
  const responses = [text(opened), text(tree(22)), text(tree(32)), text(tree(42)), text(tree(52)), text('sleight: the app has no windows left. Nothing more to read.')];
  if (value) responses[1].content[0].text += value;
  const replay = await replayCalls(calls, { comparison: 'switches', record: event => events.push(event),
    call: async (_server, _name, args) => { sent.push(args); return responses.shift(); } });
  const target = replay.calls.at(-1);
  const trace = [{ t: target.startedAt, direction: 'dp1-decision', msg: { decision: skipRead ? 'skipped-read' : 'kept-read' } }];
  if (!skipRead) trace.push({ t: target.startedAt, direction: 'guard-read', msg: { phase: 'after-call' } });
  const check = checkEvidence(loadCheck('DP1'), replay, trace);
  return { ...replay, variant, iteration: 1, cleanupConfirmed: true, check, sent, events };
}

test('switch replay records changed open_file text and maps every later numeric call through fresh trees', async () => {
  const run = await arm('A');
  assert.equal(run.verdict, 'pass', run.reason);
  assert.equal(run.calls.length, 6);
  assert.deepEqual(run.sent.slice(2, 5).map(args => args.code), ['await app.click(22)', 'await app.click(32)', 'await app.click(42)']);
  assert.equal(run.calls[0].recordingTextDifference.recorded, 'Opened fixture.txt');
  assert.match(run.calls[0].recordingTextDifference.replay, /Engine app API/);
  assert.deepEqual(run.events.find(event => event.event === 'call').recordingTextDifference, run.calls[0].recordingTextDifference);
  assert.equal(run.check.verdict, 'pass');
  const strict = await replayCalls(recording(), { call: async () => text('Opened fixture.txt\nEngine app API: click') });
  assert.equal(strict.calls.length, 1);
  assert.equal(strict.reason, 'observable text changed');
});

test('campaign compares arms per call and checks DP1 on each arm trace', async () => {
  const a = await arm('A'), b = await arm('B', { skipRead: false });
  assert.equal(b.check.verdict, 'fail');
  const evidence = campaignEvidence([a, b], loadCheck('DP1'), { candidate: 'A', baseline: 'B' });
  assert.equal(evidence.verdict, 'pass');
  assert.equal(evidence.comparisons[0].calls.length, 6);
  assert.ok(evidence.comparisons[0].calls.every(row => row.verdict === 'equal'));
  assert.equal(campaignEvidence([a, { ...b, check: a.check }, { ...a, iteration: 2 }, { ...b, iteration: 2 }], loadCheck('DP1'),
    { candidate: 'A', baseline: 'B' }).verdict, 'pass');
  assert.equal(campaignEvidence([{ ...a, check: b.check }, b], loadCheck('DP1'), { candidate: 'A', baseline: 'B' }).verdict, 'check-incomplete');
});

test('an A/B difference outside the check target fails even when both DP1 assertions passed', async () => {
  const a = await arm('A'), b = await arm('B', { opened: 'Opened another value' });
  const evidence = campaignEvidence([a, b], loadCheck('DP1'), { candidate: 'A', baseline: 'B' });
  assert.equal(evidence.verdict, 'diverge');
  assert.equal(evidence.comparisons[0].calls[0].verdict, 'changed');
  assert.ok(evidence.comparisons[0].calls[0].changes.length);
});

test('matching arm values may both differ from the recording, but differing arm values fail', async () => {
  const a = await arm('A', { value: '\nValue: 8' }), b = await arm('B', { value: '\nValue: 8' });
  const roles = { candidate: 'A', baseline: 'B' }, spec = loadCheck('DP1');
  assert.equal(campaignEvidence([a, b], spec, roles).verdict, 'pass');
  const changed = await arm('B', { value: '\nValue: 9' });
  assert.equal(campaignEvidence([a, changed], spec, roles).verdict, 'diverge');
});

test('the selected target may differ when the candidate assertion passes on its own trace', async () => {
  const a = await arm('A'), b = await arm('B', { skipRead: false });
  b.calls.at(-1).comparisonResult = text('Window closed with an after-call read');
  const report = campaignEvidence([a, b], loadCheck('DP1'), { candidate: 'A', baseline: 'B' });
  assert.equal(report.verdict, 'pass');
  assert.equal(report.comparisons[0].calls.at(-1).verdict, 'changed');
  b.check.verdict = 'inconclusive';
  assert.equal(campaignEvidence([a, b], loadCheck('DP1'), { candidate: 'A', baseline: 'B' }).verdict, 'check-incomplete');
});

test('both arms must reach the target and provide all call results', async () => {
  const a = await arm('A'), b = await arm('B');
  for (const missing of [{ ...b, calls: b.calls.slice(0, 5), check: { verdict: 'inconclusive' } },
    { ...b, calls: b.calls.slice(0, 5) }, { ...b, calls: b.calls.map((row, i) => i === 1 ? { ...row, comparisonResult: undefined } : row) }]) {
    assert.notEqual(campaignEvidence([a, missing], loadCheck('DP1'), { candidate: 'A', baseline: 'B' }).verdict, 'pass');
  }
});

for (const [label, bad] of [
  ['MCP error', { ...text('failed'), isError: true }],
  ['JSON-RPC error', { error: { message: 'failed' } }],
  ['text error', text('TypeError: app is undefined')],
  ['approval', text('Replay approval declined')],
  ['refusal', text("Computer Use is not allowed to use the app 'TextEdit' for safety reasons.")],
  ['lease refusal', text('sleight stopped this call before it ran: another session holds the lease')],
]) for (const side of ['recording', 'replay']) test(`switch replay stops for ${side} ${label}`, async () => {
  const calls = [call('js', { code: 'await app.getAXState()' }, 'ok'), ...recording()];
  if (side === 'recording') calls[0].result = bad;
  let sent = 0;
  const run = await replayCalls(calls, { comparison: 'switches', call: async () => { sent++; return side === 'replay' ? bad : text('ok'); } });
  assert.equal(run.verdict, 'diverge');
  assert.equal(run.calls.length, 1);
  assert.equal(sent, side === 'recording' ? 0 : 1);
});

for (const header of ['Window: "other.txt", App: TextEdit.', 'Window: "fixture.txt", App: Safari.', '',
  'Window: "fixture.txt", App: TextEdit.\nWindow: "other.txt", App: TextEdit.']) test(`text-only window identity stop: ${header}`, async () => {
  const run = await replayCalls([call('js', { code: 'await app.getAXState()' }, tree(2)), ...recording()], {
    comparison: 'switches', call: async () => text(`${header}\n0 window fixture.txt\n  22 button Save`) });
  assert.equal(run.verdict, 'diverge');
  assert.equal(run.calls.length, 1);
  assert.match(run.reason, /window|app/i);
});

test('a missing element after changed text still stops before input after one refresh', async () => {
  const calls = recording(), sent = [];
  const run = await replayCalls(calls, { comparison: 'switches', call: async (_server, name, args) => {
    sent.push(args);
    return text(name === 'open_file' ? 'New API wording' : 'Window: "fixture.txt", App: TextEdit.\n0 window fixture.txt');
  } });
  assert.equal(run.verdict, 'diverge');
  assert.match(run.reason, /missing element/);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(args => !args.code?.includes('.click(')));
});

test('a refusal during a mapping refresh stops before input', async () => {
  let sent = 0;
  const run = await replayCalls(recording(), { comparison: 'switches', call: async () => {
    sent++;
    return text(sent === 1 ? 'New API wording' : sent === 2 ? 'Window: "fixture.txt", App: TextEdit.\n0 window fixture.txt' : 'Replay approval declined');
  } });
  assert.equal(sent, 3);
  assert.equal(run.reason, 'Target refresh failed');
});

test('matching error results never continue in a switch comparison', async () => {
  const row = call('js', { code: 'await app.getAXState()' }, 'failed'); row.result.isError = true;
  const run = await replayCalls([row], { comparison: 'switches', call: async () => row.result });
  assert.equal(run.verdict, 'diverge');
});

test('an error at the check target cannot use the old campaign exemption', async () => {
  const a = await arm('A'), b = await arm('B');
  b.verdict = 'diverge'; b.reason = 'success/error changed';
  b.calls.at(-1).result.isError = true;
  assert.equal(campaignEvidence([a, b], loadCheck('DP1'), { candidate: 'A', baseline: 'B' }).verdict, 'diverge');
});

const evidence = join(homedir(), 'Projects/sleight-wt/race-1017/evidence-replay-dp1c');
test('the CLI wires switch comparisons to continuation and leaves single-arm plans strict', {
  skip: !existsSync(loadCheck('DP1').source.replace(/^~/, homedir())) && 'Retained DP1 recording is not installed',
}, async t => {
  t.mock.method(console, 'log', () => {});
  const single = await main(['--check', 'DP1', '--plan']);
  const paired = await main(['--check', 'DP1', '--env', 'SLEIGHT_DP1=1', '--compare', 'SLEIGHT_DP1=0', '--plan']);
  assert.equal(single.comparison, 'recording');
  assert.equal(paired.comparison, 'switches');
  assert.deepEqual(paired.roles, { candidate: 'A', baseline: 'B' });
});

test('all ten retained DP1c open_file results continue offline while retaining their text differences', {
  skip: !existsSync(join(evidence, '1-A/trace.jsonl')) && 'Retained DP1c evidence is not installed',
}, async () => {
  for (let n = 1; n <= 10; n++) {
    const variant = n % 2 ? 'A' : 'B';
    const row = readFileSync(join(evidence, `${n}-${variant}/trace.jsonl`), 'utf8').trim().split('\n').map(JSON.parse).find(r => r.event === 'call');
    const mapper = new TargetMapper();
    const oldDir = row.recordedArguments.path.replace(/\/[^/]+$/, ''), freshDir = row.arguments.path.replace(/\/[^/]+$/, '');
    mapper.addString(oldDir, freshDir); mapper.addString('/private' + oldDir, freshDir);
    assert.equal(divergence(row.expected, row.result, mapper), 'observable text changed');
    const replay = await replayCalls([{ ...row, arguments: row.recordedArguments, result: row.expected },
      call('js', { code: 'await cua.getState()' }, 'state')], {
      comparison: 'switches', mapper, call: async (_server, name) => name === 'open_file' ? row.result : text('state'),
    });
    assert.equal(replay.verdict, 'pass', `${n}-${variant}: ${replay.reason}`);
    assert.equal(replay.calls.length, 2);
    assert.ok(replay.calls[0].recordingTextDifference);
  }
});

test('the retained six-call DP1 stream uses the fresh acquired handle after changed open_file wording', {
  skip: (!existsSync(join(evidence, '1-A/trace.jsonl')) || !existsSync(loadCheck('DP1').source.replace(/^~/, homedir())))
    && 'Retained DP1c evidence is not installed',
}, async () => {
  const spec = loadCheck('DP1'), rec = loadRecording(spec.source.replace(/^~/, homedir()), spec);
  const first = readFileSync(join(evidence, '1-A/trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(r => r.event === 'call');
  const prepared = prepareReplay(rec, first.arguments.path.replace(/\/[^/]+$/, ''));
  let fed = 0;
  const replay = await replayCalls(rec.calls, { comparison: 'switches', mapper: prepared.mapper, call: async (_server, _name, args) => {
    const original = rec.calls[fed++];
    if (fed === 1) return first.result;
    assert.ok(!args.code?.includes('__sleightOpenedApp2'), 'recorded handle must not reach transport');
    if (args.code) assert.match(args.code, /__sleightOpenedApp1/);
    const result = structuredClone(original.result);
    for (const block of result.content ?? []) if (block.type === 'text') block.text = prepared.mapper.replaceStrings(block.text);
    return result;
  } });
  assert.equal(replay.verdict, 'pass', replay.reason);
  assert.equal(fed, 6);
});
});
