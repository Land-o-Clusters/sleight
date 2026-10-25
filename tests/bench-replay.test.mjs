// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createSession } from '../bench/turbo/v3-session.mjs';
import { serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { parseRecording, loadRecording } = await import('../bench/replay/recording.mjs');
const { TargetMapper, elementMapping, divergence, refreshCode, resultText } = await import('../bench/replay/mapping.mjs');
const { replayCalls, parseEnv, schedule, summarize } = await import('../bench/replay/engine.mjs');
const { options, loadCheck, main } = await import('../bench/replay/run.mjs');
const runner = await import('../bench/replay/run.mjs');
const { checkEvidence } = await import('../bench/replay/checks.mjs');
const { replayApprovalStorage } = await import('../bench/replay/server.mjs');
const { nativePlan } = await import('../bench/replay/fixtures.mjs');
const { workerSwitches } = await import('../bench/replay/switches.mjs');

const fixture = name => readFileSync(new URL(`./fixtures/replay/${name}.jsonl`, import.meta.url), 'utf8');
const nativeHeader = 'Window: "Fixture", App: TextEdit.\n';
const observeNative = (mapper, before, after) => mapper.observe(nativeHeader + before, nativeHeader + after, { code: 'await app.getAXState()' }, { server: 'plugin:sleight:computer', name: 'js' });

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError });
const call = (name, args, result, id = '1') => ({ id, name, server: 'plugin:sleight:computer', arguments: args, result });

for (const format of ['claude', 'codex', 'turbo', 'native']) test(`parse recorded ${format} pairs in request order`, () => {
  const calls = parseRecording(fixture(format));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.arguments && c.result.content.length));
  if (format === 'claude') assert.equal(calls[1].result.isError, true);
  if (format === 'codex') { assert.equal(calls[0].result.isError, true); assert.equal(calls[1].result.isError, false); }
  if (format === 'turbo') assert.equal(calls[1].server, 'sleight-turbo');
});

test('reject invalid, duplicate, missing and unsupported events', () => {
  const lines = fixture('codex').trim().split('\n');
  assert.throws(() => parseRecording('{'), /line 1/);
  assert.throws(() => parseRecording(lines[0]), /Missing recorded result/);
  assert.throws(() => parseRecording(lines[1]), /Missing item.started/);
  assert.throws(() => parseRecording([lines[0], lines[0]].join('\n')), /Duplicate/);
  assert.throws(() => parseRecording(fixture('codex').replaceAll('plugin_sleight_computer', 'shell')), /Unsupported server/);
  assert.throws(() => parseRecording('{"type":"system"}'), /No replayable/);
});

test('serialize overlapping tool uses in emission order', () => {
  const rows = fixture('codex').trim().split('\n');
  const calls = parseRecording([rows[0], rows[2], rows[3], rows[1]].join('\n'));
  assert.deepEqual(calls.map(c => c.id), ['item_1', 'item_2']);
  assert.equal(calls[0].result.isError, true);
});

test('map changed AX numbers by unique ancestor and label, keeping typed values exact', () => {
  const mapper = new TargetMapper();
  observeNative(mapper, '1 window Checkout\n\t2 text field Name, Value: empty\n\t3 button Save',
    '20 window Checkout\n\t21 text field Name, Value: filled\n\t22 button Save');
  assert.equal(mapper.code('await app.setValue(2, "2"); await app.click(3);'), 'await app.setValue(21, "2"); await app.click(22);');
  assert.throws(() => mapper.arguments({ code: 'await app.click([2, 3]);', title: 'keep 2' }), /frame/);
  assert.throws(() => mapper.arguments({ elementIndex: 2 }), /receiver/);
  assert.equal(mapper.code('await app.click({ elementIndex: 2 })'), 'await app.click({ elementIndex: 21 })');
  assert.throws(() => mapper.code('await app.click({ id: 2 })'), /Unmapped numeric selector/);
});

test('refuse duplicate labels even when the old number is still present', () => {
  const mapper = new TargetMapper();
  observeNative(mapper, '1 window\n  2 button Delete', '1 window\n  2 button Delete\n  3 button Delete');
  assert.throws(() => mapper.code('await app.click(2)'), /Ambiguous/);
  assert.equal(elementMapping('1 window\n  2 button Delete', '1 window\n  2 button Delete\n  3 button Delete').has(2), false);
});

test('scope equal labels by ancestor and refuse computed targets', () => {
  const mapper = new TargetMapper();
  observeNative(mapper, '1 group A\n  2 button Save\n3 group B\n  4 button Save', '10 group B\n  11 button Save\n12 group A\n  13 button Save');
  assert.equal(mapper.code('await app.click(2)'), 'await app.click(13)');
  assert.throws(() => mapper.code('await app.click(index)'), /Computed/);
  assert.throws(() => mapper.code('await app.click('), /parsed/);
});

test('map real turbo tab handle and refs from a recorded snapshot', () => {
  const first = parseRecording(fixture('turbo'))[0];
  const before = resultText(first.result), oldTab = /^(t\w+)/.exec(before)[1], nextTab = 't' + 'f'.repeat(31);
  const after = before.replaceAll(oldTab, nextTab).replaceAll('ref=e15', 'ref=e915');
  const mapper = new TargetMapper(); mapper.observe(before, after);
  assert.deepEqual(mapper.arguments({ tab: oldTab, fields: [{ ref: 'e15', value: 'e15' }] }), { tab: nextTab, fields: [{ ref: 'e915', value: 'e15' }] });
  assert.equal(divergence(first.result, text(after), mapper), null);
  assert.throws(() => mapper.arguments({ tab: 't' + 'b'.repeat(31) }), /Unmapped tab/);
  assert.throws(() => mapper.arguments({ tab: oldTab, ref: 'e999' }), /missing ref/);
  assert.throws(() => mapper.arguments({ ref: 'e15' }), /tab/);
});

test('refuse ambiguous tab identity and map window receipts', () => {
  const mapper = new TargetMapper(), head = 't' + 'a'.repeat(31) + ' http://127.0.0.1:5413\nTitle: Checkout';
  assert.throws(() => mapper.observe(head, head + '\n' + head), /Ambiguous tab/);
  const receipt = n => text(JSON.stringify({ target: { appId: 'com.apple.TextEdit', title: 'Source.txt' }, identity: { pid: n, windowNumber: n } }));
  mapper.observe(resultText(receipt(1)), resultText(receipt(2)), {}, { server: 'plugin:sleight:computer', name: 'select_window' });
  assert.equal(mapper.arguments({ windowNumber: 1 }).windowNumber, 2);
  assert.deepEqual(mapper.arguments({ windowId: 1, toWindowId: 1 }), { windowId: 2, toWindowId: 2 });
  assert.equal(divergence(text('{"windowId":1}'), text('{"windowId":2}'), mapper), null);
  assert.throws(() => mapper.arguments({ windowNumber: 3 }), /Unmapped/);
});

test('native compact diffs preserve unchanged targets and require a full read for new IDs', () => {
  const mapper = new TargetMapper();
  observeNative(mapper, '0 window\n  1 text field Name\n  2 button Save', '10 window\n  11 text field Name\n  12 button Save');
  observeNative(mapper, '0 window\nsleight: lines changed since the last full tree\n+   3 text field Name, Value: Sam',
    '10 window\nsleight: lines changed since the last full tree\n+   13 text field Name, Value: Sam');
  assert.equal(mapper.code('await app.click(2)'), 'await app.click(12)');
  assert.throws(() => mapper.code('await app.setValue(3, "42")'), /refresh required/);
  observeNative(mapper, '0 window\n  3 text field Name, Value: Sam\n  2 button Save', '10 window\n  13 text field Name, Value: Sam\n  12 button Save');
  assert.equal(mapper.code('await app.setValue(3, "42"); await app.click(2)'), 'await app.setValue(13, "42"); await app.click(12)');
});

test('turbo diffs keep unchanged refs and remove deleted refs', () => {
  const mapper = new TargetMapper();
  const tab = 't' + 'a'.repeat(31), fresh = 't' + 'b'.repeat(31);
  mapper.addString(tab, fresh);
  mapper.observe('# Snapshot 1\n- button "Save" [ref=e1]\n- button "Delete" [ref=e2]',
    '# Snapshot 1\n- button "Save" [ref=e10]\n- button "Delete" [ref=e20]', { tab });
  mapper.observe('# Changes\n- - button "Delete" [ref=e2]', '# Changes\n- - button "Delete" [ref=e20]', { tab });
  assert.equal(mapper.arguments({ tab, ref: 'e1' }).ref, 'e10');
  assert.throws(() => mapper.arguments({ tab, ref: 'e2' }), /missing/);
});

test('fixture string substitutions are simultaneous and preserve literal metacharacters', () => {
  const mapper = new TargetMapper(); mapper.addString('old.txt', 'middle.txt'); mapper.addString('middle.txt', 'new.txt');
  assert.equal(mapper.replaceStrings('old.txt middle.txt oldXtxt'), 'middle.txt new.txt oldXtxt');
});

test('diverge on values, error-to-success, images and confirmation gates', () => {
  assert.equal(divergence(text('1 text field, Value: 37'), text('9 text field, Value: 37')), null);
  assert.equal(divergence(text('1 text field, Value: 37'), text('9 text field, Value: 38')), 'observable text changed');
  assert.equal(divergence(text('partial input possible', true), text('done')), 'success/error changed');
  assert.equal(divergence(text('payment confirmation blocked', true), text('payment confirmation blocked', true)), 'confirmation or approval gate');
  assert.equal(divergence({ content: [{ type: 'image', data: 'a' }] }, { content: [{ type: 'image', data: 'a' }] }), 'non-text evidence changed; visual interpretation required');
  assert.equal(divergence({ content: [{ type: 'image', data: 'a' }] }, { content: [{ type: 'image', data: 'b' }] }), 'non-text evidence changed; visual interpretation required');
  assert.equal(divergence(text('wait 150 ms'), text('wait 300 ms')), 'observable text changed');
  assert.equal(divergence(text('API example: payment confirmation requires user approval'), text('API example: payment confirmation requires user approval')), null);
  assert.equal(divergence(text('1 click: not run: confirmation required through the trusted consent UI'), text('1 click: not run: confirmation required through the trusted consent UI')), 'confirmation or approval gate');
});

test('turbo refresh uses its mapped tab and never retries an uncertain action', async () => {
  const mapper = new TargetMapper();
  const oldTab = 't' + 'a'.repeat(31), tab = 't' + 'b'.repeat(31);
  mapper.addString(oldTab, tab);
  mapper.observe('# Snapshot 1\n- button "Save" [ref=e1]', '# Snapshot 1', { tab: oldTab });
  const calls = [], original = { ...call('browser_act', { tab: oldTab, steps: [{ do: 'click', ref: 'e1' }] }, text('done')), server: 'sleight-turbo' };
  const out = await replayCalls([original], { mapper, call: async (server, name, args) => {
    calls.push({ name, args }); return name === 'browser_read' ? text('# Snapshot 2\n- button "Save" [ref=e10]') : text('done');
  } });
  assert.equal(out.verdict, 'pass'); assert.equal(calls[0].name, 'browser_read'); assert.equal(calls[0].args.tab, tab);
  assert.equal(calls[1].args.steps[0].ref, 'e10'); assert.equal(calls.length, 2);
});

test('replay refreshes unresolved targets before input, then stops at first divergent result', async () => {
  const mapper = new TargetMapper(); observeNative(mapper, '1 window\n  2 button Save', '1 window');
  const submitted = [];
  const rows = [call('js', { code: 'await app.click(2)' }, text('saved')), call('js', { code: 'await app.pressKey("x")' }, text('no'), '2')];
  const out = await replayCalls(rows, { mapper, call: async (server, name, args) => {
    submitted.push(args.code); return args.code.includes('getAXState') ? text(nativeHeader + '10 window\n  20 button Save') : text('failed', true);
  } });
  assert.deepEqual(submitted, ['await app.getAXState({ disableDiffing: true });', 'await app.click(20)']);
  assert.equal(out.verdict, 'diverge'); assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].reason, 'success/error changed');
  assert.ok(out.totalToolMs >= 0 && out.totalMappingMs >= 0);
});

test('ambiguous reread never sends input; multiple handles never refresh', async () => {
  const mapper = new TargetMapper(); observeNative(mapper, '1 window\n  2 button Save', '1 window');
  let count = 0;
  const out = await replayCalls([call('js', { code: 'await app.click(2)' }, text('saved'))], { mapper,
    call: async () => { count++; return text(nativeHeader + '1 window\n  2 button Save\n  3 button Save'); } });
  assert.equal(count, 1); assert.match(out.reason, /Ambiguous/);
  assert.throws(() => refreshCode({ code: 'await app.click(2); await other.click(3)' }), /exactly one/);
});

test('transport errors and live guard checks stop before subsequent calls', async () => {
  let count = 0;
  const rows = [call('js', { code: 'await app.getAXState()' }, text('ok')), call('js_reset', {}, text('ok'), '2')];
  const out = await replayCalls(rows, { beforeCall: () => { throw Error('hold'); }, call: async () => { count++; } });
  assert.equal(count, 0); assert.equal(out.calls.length, 1); assert.equal(out.reason, 'hold');
  const transport = await replayCalls(rows, { call: async () => { throw Error('MCP closed'); } });
  assert.equal(transport.reason, 'MCP closed'); assert.equal(transport.calls.length, 1);
});

test('switch validation, alternating order and medians exclude divergent totals', () => {
  assert.deepEqual(parseEnv('SLEIGHT_DP1=1,SLEIGHT_CK2=0'), { SLEIGHT_DP1: '1', SLEIGHT_CK2: '0' });
  for (const value of ['NODE_OPTIONS=1', 'SLEIGHT_APPROVAL_PROMPT=1', 'SLEIGHT_CONFIRM_PAYMENTS=0', 'SLEIGHT_DP1=yes', 'SLEIGHT_DP1=1,SLEIGHT_DP1=0']) assert.throws(() => parseEnv(value));
  assert.deepEqual(schedule(3, [{ variant: 'A' }, { variant: 'B' }]).map(x => x.variant), ['A', 'B', 'A', 'B', 'A', 'B']);
  assert.throws(() => schedule(0, [])); assert.throws(() => schedule(1.5, []));
  const row = ms => ({ toolMs: ms, mappingMs: 0, verdict: 'pass' });
  const report = summarize([{ variant: 'A', verdict: 'pass', totalToolMs: 10, calls: [row(10)] },
    { variant: 'A', verdict: 'pass', totalToolMs: 20, calls: [row(20)] }, { variant: 'A', verdict: 'diverge', totalToolMs: 1, calls: [row(1)] }])[0];
  assert.equal(report.totalToolMedianMs, 15); assert.equal(report.calls[0].toolMedianMs, 10);
});

test('benchmark store grants nothing and rejects persistence', () => {
  const store = replayApprovalStorage.live(replayApprovalStorage.load());
  assert.deepEqual(store.list(), []); assert.equal(store.allows('TextEdit', 'low'), false);
  assert.throws(() => replayApprovalStorage.add('TextEdit', 'low'), /cannot persist/);
});

test('replay feature switches reach the isolated turbo worker without credentials', async t => {
  for (const [key, value] of Object.entries({ SLEIGHT_REPLAY_ENV: JSON.stringify({ SLEIGHT_MC1: '0', SLEIGHT_DP7: '1' }), SLEIGHT_LB12: '0', ANTHROPIC_API_KEY: 'offline-sentinel' })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const session = await createSession({ origins: ['http://127.0.0.1:5413'], taskMessage: 'Read the benchmark fixture',
    forkWorker(path, args, options) {
      assert.equal(options.env.SLEIGHT_MC1, '0'); assert.equal(options.env.SLEIGHT_DP7, '1'); assert.equal(options.env.SLEIGHT_LB12, '0');
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      const child = new EventEmitter(), endpoint = new EventEmitter(); child.connected = endpoint.connected = true;
      child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
      endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
      child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
      child.unref = () => {};
      const worker = serveV3Worker({ channel: endpoint, browser: 'bbench', begin: async () => ({
        call: async () => ({ text: 'fixture', isError: false }), end: async () => ({ revoked: true, cleanup: [] }),
      }), close: async () => ({ revoked: true, cleanup: [] }) });
      queueMicrotask(() => worker.ready()); return child;
    } });
  assert.equal((await session.call({ name: 'browser_read', arguments: { tab: 't1' } })).text, 'fixture');
  await session.close();
});

test('worker switch envelope rejects loader, approval and malformed data', () => {
  for (const value of ['null', '[]', '{"NODE_OPTIONS":"1"}', '{"SLEIGHT_CONFIRM_PAYMENTS":"0"}', '{"SLEIGHT_TRACE":"1"}', '{"SLEIGHT_MC1":"yes"}'])
    assert.throws(() => workerSwitches({ SLEIGHT_REPLAY_ENV: value }));
  assert.deepEqual(workerSwitches({}), {});
});

test('load results selects one row and requires retained transcript evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr2-offline-'));
  try {
    const evidence = join(dir, 'evidence'); mkdirSync(evidence);
    writeFileSync(join(evidence, 'transcript.jsonl'), fixture('claude'));
    const file = join(dir, 'results.json');
    writeFileSync(file, JSON.stringify({ stamp: 'one', suite: 'world', results: [{ arm: 'sleight', task: 'textedit-window-drag', run: 1 }, { arm: 'sleight', task: 'textedit-window-drag', run: 2 }] }));
    assert.throws(() => loadRecording(file, { task: 'textedit-window-drag', evidence }), /exactly one/);
    assert.equal(loadRecording(file, { task: 'textedit-window-drag', run: 1, evidence }).calls.length, 2);
    assert.throws(() => loadRecording(file, { task: 'textedit-window-drag', run: 1, evidence: dir }), /Transcript missing/);
  } finally { rmSync(dir, { recursive: true }); }
});

for (const override of [false, true]) test(`native recordings prefer durable evidence, then legacy temp evidence (arm home override: ${override})`, t => {
  const root = mkdtempSync(join(tmpdir(), 'replay-evidence-'));
  const previous = Object.fromEntries(['HOME', 'TMPDIR', 'BENCH_ARM_HOME'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home'), temp = join(root, 'temp'), alias = join(root, 'temp-alias');
  mkdirSync(temp); symlinkSync(temp, alias);
  process.env.HOME = home; process.env.TMPDIR = alias;
  const armHome = override ? join(root, 'custom-arms') : join(home, 'Library', 'Caches', 'sleight-bench');
  if (override) process.env.BENCH_ARM_HOME = armHome; else delete process.env.BENCH_ARM_HOME;
  const stamp = '2026-10-25T12-00-00-000Z', task = 'textedit-window-drag', leaf = `sleight-${task}-1`;
  const durable = join(armHome, 'evidence', stamp, leaf), legacy = join(alias, 'sleight-real-evidence', stamp, leaf);
  for (const dir of [durable, legacy]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'transcript.jsonl'), fixture('claude')); }
  const file = join(root, 'results.json');
  writeFileSync(file, JSON.stringify({ stamp, results: [{ arm: 'sleight', task, run: 1 }] }));
  assert.equal(loadRecording(file).folder, durable);
  // A partial durable folder must not hide an old recording.
  rmSync(join(durable, 'transcript.jsonl'));
  assert.equal(loadRecording(file).folder, legacy);
  assert.equal(loadRecording(file, { evidence: realpathSync(legacy) }).calls.length, 2);
  rmSync(join(legacy, 'transcript.jsonl'));
  assert.throws(() => loadRecording(file), error => {
    assert.match(error.message, /^Transcript missing in /);
    for (const dir of [durable, legacy, join(realpathSync(temp), 'sleight-real-evidence', stamp, leaf)]) assert.ok(error.message.includes(dir), error.message);
    return true;
  });
});

test('race results files resolve their task folder and Codex JSON argument strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr2-race-results-'));
  try {
    mkdirSync(join(dir, 'checkout')); writeFileSync(join(dir, 'checkout', 'events.jsonl'), fixture('codex'));
    const file = join(dir, 'results.json'); writeFileSync(file, JSON.stringify([{ task: { name: 'checkout', browser: 'safari' }, surface: 'sleight' }]));
    const rec = loadRecording(file, { task: 'checkout' });
    assert.equal(rec.kind, 'race'); assert.equal(rec.calls.length, 2);
    const events = fixture('codex').trim().split('\n').map(JSON.parse);
    events[0].item.arguments = JSON.stringify(events[0].item.arguments);
    assert.equal(parseRecording(events.map(JSON.stringify).join('\n'))[0].arguments.app, 'com.apple.Safari');
  } finally { rmSync(dir, { recursive: true }); }
});

test('native fixture restores recorded nonce and refuses random or mixed fixtures', () => {
  const rec = { task: { id: 'textedit-window-drag' }, metadata: { suite: 'world' }, calls: [call('open_file', {
    path: `${MAC_TMP}/sleight-bench/stamp/sleight-textedit-window-drag-1/Source-1234abcd.txt` }, text(''))] };
  const plan = nativePlan(rec, `${MAC_TMP}/sr2-fixture`);
  assert.equal(plan.ctx.nonce, '1234abcd'); assert.equal(plan.suite, 'world'); assert.equal(typeof plan.definition.setup, 'function');
  assert.throws(() => nativePlan({ ...rec, task: { id: 'calculator-click' } }, `${MAC_TMP}/x`), /not reproducible/);
  assert.throws(() => nativePlan({ ...rec, calls: [] }, `${MAC_TMP}/x`), /exactly one/);
  const alias = structuredClone(rec.calls[0]); alias.arguments.path = alias.arguments.path.replace(`${MAC_TMP}/`, '/tmp/');
  assert.equal(nativePlan({ ...rec, calls: [...rec.calls, alias] }, `${MAC_TMP}/x`).ctx.nonce, '1234abcd');
});

test('check evidence never passes absent targets, missing traces or one selected language', () => {
  const row = { index: 1, name: 'browser_fill', recordedArguments: { value: ['Japanese', 'Portuguese'] }, result: text('option Japanese [selected]'), toolMs: 10 };
  const ms = loadCheck('MS1');
  assert.equal(checkEvidence(ms, { calls: [] }).verdict, 'inconclusive');
  assert.equal(checkEvidence(ms, { calls: [row] }).verdict, 'fail');
  row.result = text('option Japanese [selected]\noption Portuguese [selected]');
  assert.equal(checkEvidence(ms, { calls: [row] }).verdict, 'pass');
  const dp = loadCheck('DP2'); row.name = 'drag'; row.result = text('{"path":"accessibility"}');
  assert.equal(checkEvidence(dp, { calls: [row] }).verdict, 'skip');
});

test('tab-chain check requires both metadata probes and rejects intermediate tree reads', () => {
  const spec = loadCheck('CK3'), row = { index: 0, name: 'js', recordedArguments: { code: 'await app.pressKey("super+t")' },
    result: text('checkout'), startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:00:01.000Z' };
  const event = (direction, msg) => ({ t: '2026-10-19T00:00:00.500Z', direction, msg });
  const trace = [event('tab-probe', { decision: 'probe', transition: true }), event('tab-probe', { decision: 'probe', transition: false })];
  assert.equal(checkEvidence(spec, { calls: [row] }, trace).verdict, 'pass');
  assert.equal(checkEvidence(spec, { calls: [row] }, []).verdict, 'fail');
  trace.push(event('guard-read', { phase: 'before-action' }), event('guard-read', { phase: 'before-action' }));
  assert.equal(checkEvidence(spec, { calls: [row] }, trace).verdict, 'fail');
});

test('CLI parsing never interprets unknown flags as a live opt-in', () => {
  assert.deepEqual(options(['--plan', '--repeat', '3', 'folder']).repeat, 3);
  assert.throws(() => options(['--owner-present']), /Unexpected/);
  assert.throws(() => options(['--env']), /Missing value/);
  assert.throws(() => loadCheck('../x'), /Invalid/);
});

test('MS1 requires a worktree comparison instead of an invented switch', async () => {
  await assert.rejects(main(['--check', 'MS1', '--plan']), /MS1 requires --old-worktree OLD --new-worktree NEW/);
});

test('read-only plan does not call live setup or create output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr2-plan-'));
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ task: { name: 'settings', browser: 'chrome' } }));
    writeFileSync(join(dir, 'events.jsonl'), fixture('turbo'));
    const log = console.log; console.log = () => {};
    try {
      const plan = await main([dir, '--plan']); assert.equal(plan.calls, 2); assert.equal(plan.model, false); assert.deepEqual(plan.windowFrames, []);
      const receipt = { target: { appId: 'com.apple.TextEdit', title: 'Fixture' }, identity: { windowNumber: 7 }, frame: { x: 100, y: 200, width: 600, height: 400 } };
      writeFileSync(join(dir, 'events.jsonl'), [
        { message: { content: [{ type: 'tool_use', id: 'frame', name: 'mcp__plugin_sleight_computer__select_window', input: { app: 'com.apple.TextEdit', title: 'Fixture' } }] } },
        { message: { content: [{ type: 'tool_result', tool_use_id: 'frame', content: JSON.stringify(receipt) }] } },
      ].map(JSON.stringify).join('\n'));
      assert.deepEqual((await main([dir, '--plan'])).windowFrames, [{ index: 0, ...receipt }]);
    }
    finally { console.log = log; }
    assert.deepEqual((await import('node:fs')).readdirSync(dir), ['events.jsonl', 'run.json']);
    await assert.rejects(main([dir]), /requires --owner-away/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('worktree comparison plans alternate the same recording across two identified builds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr2-build-plan-'));
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ task: { name: 'settings', browser: 'chrome' } }));
    writeFileSync(join(dir, 'events.jsonl'), fixture('turbo'));
    const builds = ['old', 'new'].map(label => {
      const path = join(dir, label); mkdirSync(join(path, 'plugins/sleight/lib'), { recursive: true });
      mkdirSync(join(path, 'bench/turbo'), { recursive: true });
      writeFileSync(join(path, 'plugins/sleight/lib/launch.mjs'), 'export async function run({ approvalStorage, paymentCardFactory } = {}) {}');
      writeFileSync(join(path, 'bench/turbo/v3-server.mjs'), '// offline fixture');
      const git = args => execFileSync('/usr/bin/git', ['-C', path, ...args], { stdio: 'pipe' });
      git(['init']); git(['add', '--', 'plugins/sleight/lib/launch.mjs', 'bench/turbo/v3-server.mjs']);
      git(['-c', 'user.name=Offline test', '-c', 'user.email=offline@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Offline build fixture', '--', 'plugins/sleight/lib/launch.mjs', 'bench/turbo/v3-server.mjs']);
      return path;
    });
    const log = console.log; console.log = () => {};
    try {
      const plan = await main([dir, '--plan', '--old-worktree', builds[0], '--new-worktree', builds[1], '--repeat', '2']);
      assert.equal(plan.mode, 'worktrees');
      assert.deepEqual(plan.schedule.map(s => [s.variant, s.build.label]), [['A', 'old'], ['B', 'new'], ['A', 'old'], ['B', 'new']]);
      assert.ok(plan.schedule.every(s => /^[a-f0-9]{40}$/.test(s.build.commit)));
      assert.deepEqual(plan.schedule.slice(0, 2).map(s => s.build.worktree), builds.map(p => realpathSync(p)));
      assert.equal(plan.calls, 2);
      await assert.rejects(main([dir, '--plan', '--old-worktree', '.']), /both --old-worktree and --new-worktree/);
      await assert.rejects(main([dir, '--plan', '--old-worktree', '.', '--new-worktree', '.', '--compare', 'SLEIGHT_DP2=0']), /cannot combine/);
      await assert.rejects(main([dir, '--plan', '--old-worktree', dir, '--new-worktree', '.']), /Git worktree/);
      await assert.rejects(main([dir, '--plan', '--old-worktree', '.', '--new-worktree', '.']), /distinct worktrees/);
    } finally { console.log = log; }
  } finally { rmSync(dir, { recursive: true }); }
});

test('native replay shim loads the selected build with empty approvals and no payment card', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr2-offline-server-'));
  try {
    mkdirSync(join(dir, 'plugins/sleight/lib'), { recursive: true });
    writeFileSync(join(dir, 'plugins/sleight/lib/launch.mjs'), `export async function run({ approvalStorage, paymentCardFactory, directBrowser } = {}) {
      console.log(JSON.stringify({ build: 'old fixture', grants: approvalStorage.load().list(),
        cardSuppressed: paymentCardFactory() === undefined, directBrowser, turbo: process.env.SLEIGHT_TURBO }));
    }`);
    const output = execFileSync(process.execPath, ['bench/replay/server.mjs', '--worktree', dir], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { build: 'old fixture', grants: [], cardSuppressed: true, turbo: '0' });
    writeFileSync(join(dir, 'plugins/sleight/lib/launch.mjs'), 'export async function run() { console.log("unsafe launcher ran"); }');
    assert.throws(() => execFileSync(process.execPath, ['bench/replay/server.mjs', '--worktree', dir], { encoding: 'utf8', stdio: 'pipe' }), error => {
      assert.equal(error.stdout, ''); assert.match(error.stderr, /requires SR2 launcher injection/); return true;
    });
  } finally { rmSync(dir, { recursive: true }); }
});

test('DP2 validates helper phase order and skips only when phase tracing is absent', () => {
  const spec = loadCheck('DP2');
  const replay = { calls: [{ index: 0, name: 'drag', result: text('{"path":"accessibility"}'), toolMs: 10,
    startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:00:01.000Z' }] };
  const trace = ['ax-move:start', 'settle:start', 'settle:end', 'ax-move:end'].map((s, i) => {
    const [phase, edge] = s.split(':');
    return { t: '2026-10-19T00:00:00.500Z', direction: 'drag-phase', msg: { phase, edge, monoMs: 100 + i, helperPid: 123 } };
  });
  assert.equal(checkEvidence(spec, replay, trace).verdict, 'pass');
  const skipped = checkEvidence(spec, replay, []);
  assert.equal(skipped.verdict, 'skip'); assert.match(skipped.reason, /build lacks.*drag-phase/i);
  for (const bad of [trace.slice(0, -1), trace.map(e => ({ ...e, t: '2026-10-19T00:00:02.000Z' }))])
    assert.notEqual(checkEvidence(spec, replay, bad).verdict, 'pass');
  const earlyRaise = ['raise', 'settle'].flatMap((phase, i) => ['start', 'end'].map((edge, n) =>
    ({ ...trace[0], msg: { phase, edge, monoMs: 90 + i * 2 + n, helperPid: 123 } })));
  assert.equal(checkEvidence(spec, replay, [...earlyRaise, ...trace]).verdict, 'fail');
  const posted = ['start', 'end'].map((edge, i) => ({ ...trace[0], msg: { phase: 'posted-press', edge, monoMs: 104 + i, helperPid: 123 } }));
  assert.equal(checkEvidence(spec, replay, [...trace, ...posted]).verdict, 'fail');
  const backwards = structuredClone(trace); backwards[2].msg.monoMs = 1;
  assert.equal(checkEvidence(spec, replay, backwards).verdict, 'fail');
  const mixed = structuredClone(trace); mixed[3].msg.helperPid = 999;
  assert.equal(checkEvidence(spec, replay, mixed).verdict, 'fail');
});

test('comparison routes the native companion and turbo worker entry to the selected build', () => {
  const specs = runner.replayServers({ 'sleight-turbo': { command: process.execPath, args: ['/harness/bench/turbo/v3-server.mjs'], env: { SLEIGHT_TURBO_TASK: 'fixed task' } } }, '/build/old');
  assert.equal(specs['sleight-turbo'].args[0], '/build/old/bench/turbo/v3-server.mjs');
  assert.equal(specs['sleight-turbo'].env.SLEIGHT_TURBO_TASK, 'fixed task');
  assert.deepEqual(specs['plugin:sleight:computer'].args.slice(-2), ['--worktree', '/build/old']);
});
});
