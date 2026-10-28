import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { packageSkip } from './requirements.mjs';
import { fixtureDocumentation } from './helpers/canonical-docs.mjs';
import { readReplayEngine, engineDifference, engineIteration, campaignEngine } from '../bench/replay/engine-identity.mjs';

const engine = (build = '50603', version = '26.1023') => ({ version, build, at: '2026-10-28T05:30:00.000Z' });
const passed = () => ({ verdict: 'pass', calls: [], totalToolMs: 0, cleanupConfirmed: true });

test('engine identity reads the app version and build from the two plist keys', () => {
  const keys = [];
  const identity = readReplayEngine({ read: key => { keys.push(key); return key === 'CFBundleVersion' ? '50603' : '26.1023'; },
    now: () => new Date('2026-10-28T05:30:00Z') });
  assert.deepEqual(keys, ['CFBundleShortVersionString', 'CFBundleVersion']);
  assert.equal(identity.version, '26.1023');
  assert.equal(identity.build, '50603');
  assert.equal(identity.at, '2026-10-28T05:30:00.000Z');
  assert.ok(identity.source.endsWith('/ChatGPT.app/Contents/Info.plist'));
});

test('an unreadable plist cannot verify an engine build', () => {
  const identity = readReplayEngine({ read: () => { throw Error('fixture read failure'); } });
  assert.match(engineDifference([identity]), /unverified/);
  assert.match(engineDifference([engine(), { ...engine(), build: '' }]), /unverified/);
});

test('iteration engine reads bracket the operation and survive result JSON serialization', async () => {
  const order = [];
  const result = await engineIteration(async () => { order.push('iteration'); return passed(); }, {
    read: () => { order.push('read'); return engine(); },
  });
  assert.deepEqual(order, ['read', 'iteration', 'read']);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.engine.changed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).engine, { start: engine(), end: engine(), changed: false });
  assert.deepEqual(campaignEngine([result]), { verdict: 'pass', version: '26.1023', build: '50603' });
});

test('an engine build change between iterations refuses the next operation', async () => {
  const a = await engineIteration(passed, { read: () => engine() });
  let launched = 0;
  const b = await engineIteration(() => { launched++; return passed(); }, { previous: [a.engine], read: () => engine('50604') });
  assert.equal(launched, 0);
  assert.equal(b.cleanupConfirmed, true);
  assert.equal(b.verdict, 'diverge');
  assert.match(b.reason, /engine build changed/);
  assert.equal(b.engine.start.build, '50604');
  assert.equal(campaignEngine([a, b]).verdict, 'refuse');
});

test('an update during one iteration refuses its campaign even after successful cleanup', async () => {
  const reads = [engine(), engine('50604')];
  const result = await engineIteration(passed, { read: () => reads.shift() });
  assert.equal(result.verdict, 'diverge');
  assert.equal(result.engine.changed, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(campaignEngine([result]).verdict, 'refuse');
});

test('version changes and missing reads also refuse mixed or unverifiable campaigns', async () => {
  assert.match(engineDifference([engine(), engine('50603', '26.1024')]), /changed/);
  const result = await engineIteration(() => assert.fail('unverified engine launched'), { read: () => ({ version: null, build: null }) });
  assert.equal(result.verdict, 'diverge');
  assert.match(result.reason, /unverified/);
  assert.equal(campaignEngine([result, { engine: { start: engine(), end: engine() } }]).verdict, 'refuse');
});

test('transport exceptions retain both engine observations', async () => {
  await assert.rejects(engineIteration(() => { throw Error('fixture transport failed'); }, { read: () => engine() }), error => {
    assert.equal(error.message, 'fixture transport failed');
    assert.deepEqual(error.engine, { start: engine(), end: engine(), changed: false });
    return true;
  });
});

describe('worktree replay fixtures', { skip: packageSkip('typescript') }, async () => {
  const { replayCalls } = await import('../bench/replay/engine.mjs');
  const { campaignEvidence } = await import('../bench/replay/checks.mjs');
  const { parseRecording } = await import('../bench/replay/recording.mjs');
  const { replayResultStop, comparisonResult, TargetMapper } = await import('../bench/replay/mapping.mjs');
  const text = text => ({ type: 'text', text });
  const result = (...items) => ({ content: items.map(text) });
  const reference = '## Computer Use\nEngine reference v2\nError: example only\npermission denied\n';
  const policy = '# Computer Use Confirmations Policy\nExample: waiting for a payment card\n';
  const changedReference = reference.replace('v2', 'v3');
  const documentation = () => fixtureDocumentation(reference, policy, changedReference);
  const tree = (id, value = 'new', window = 'Fixture', app = 'TextEdit') => `Window: "${window}", App: ${app}.\n0 window Fixture\n  ${id} button Save, Value: ${value}`;
  const roles = { candidate: 'B', baseline: 'A' };
  function recording() {
    const requests = [
      { code: 'let app = await cua.getApp("TextEdit")' },
      { code: 'await app.click(2)' },
    ];
    const results = [result('## Computer Use\nOld engine reference', '# Computer Use Confirmations Policy\nOld policy', tree(2, 'old')), result('old saved')];
    return parseRecording(requests.flatMap((input, i) => [
      { message: { content: [{ type: 'tool_use', id: String(i), name: 'mcp__plugin_sleight_computer__js', input }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: String(i), content: results[i].content }] } },
    ]).map(JSON.stringify).join('\n'));
  }
  async function arm(variant, { docs = reference, value = 'new', structured = 8, joined = false, tail = result('new saved'), calls = recording(), responses } = {}) {
    const fresh = responses ?? [joined ? result(`${docs}\n${tree(22, value)}`, policy) : result(docs, policy, tree(22, value)), tail];
    fresh[0].structuredContent = { value: structured };
    const sent = [];
    const replay = await replayCalls(calls, { comparison: 'worktrees', documentation: documentation(),
      call: async (_server, _name, args) => { sent.push(args); return fresh.shift(); } });
    return { ...replay, variant, iteration: 1, cleanupConfirmed: true, sent };
  }

  test('both live arms can match after text, docs and structured output change from the recording', async () => {
    const a = await arm('A'), b = await arm('B');
    assert.equal(a.verdict, 'pass', a.reason);
    assert.equal(b.verdict, 'pass', b.reason);
    assert.equal(a.calls.length, 2);
    assert.equal(a.sent[1].code, 'await app.click(22)');
    assert.ok(a.calls[0].recordingTextDifference);
    const evidence = campaignEvidence([a, b], undefined, roles);
    assert.equal(evidence.verdict, 'pass');
    assert.ok(evidence.comparisons[0].calls.every(row => row.verdict === 'equal'));
    assert.equal(evidence.comparisons[0].calls[0].documentation.verdict, 'equal');
    assert.equal(a.calls[0].comparisonResult.content[0].text, reference);
  });

  test('single-variant replay still compares against recorded text', async () => {
    const replay = await replayCalls(recording(), { documentation: documentation(), call: async () => result('New engine wording') });
    assert.equal(replay.reason, 'observable text changed');
    assert.equal(replay.calls.length, 1);
  });

  test('recognized reference and policy examples do not trigger refusal barriers', () => {
    assert.equal(replayResultStop(result(reference, policy), documentation()), null);
    assert.equal(replayResultStop({ ...result(reference), isError: true }, documentation()), 'recording or replay error');
    assert.equal(replayResultStop(result('## Computer Use\nError: unrecognized task payload'), documentation()), 'recording or replay refusal or error');
  });

  test('joined documentation leaves task text outside its exemption', async () => {
    const a = await arm('A', { joined: true }), b = await arm('B', { joined: true });
    assert.equal(campaignEvidence([a, b], undefined, roles).verdict, 'pass');
    const refused = await arm('A', { joined: true, tail: result('Input refused: fixture barrier') });
    assert.equal(refused.verdict, 'diverge');
    assert.match(refused.reason, /refusal/);
  });

  test('splitting a joined reference does not change its A/B task or docs comparison', async () => {
    const a = await arm('A', { joined: true }), b = await arm('B');
    assert.equal(campaignEvidence([a, b], undefined, roles).verdict, 'pass');
  });

  test('missing A/B docs are a docs difference while the task tree still compares', async () => {
    const a = await arm('A'), b = await arm('B', { responses: [result(tree(22)), result('new saved')] });
    const evidence = campaignEvidence([a, b], undefined, roles);
    assert.equal(evidence.verdict, 'docs-differ');
    assert.deepEqual(evidence.comparisons[0].calls[0].changes, []);
  });

  test('incoming text metadata cannot claim the canonical documentation marker', () => {
    const raw = { content: [{ type: 'text', text: 'fixture task value', documentation: true }] };
    const compared = comparisonResult(raw, new TargetMapper(), documentation());
    assert.equal(compared.content[0].documentation, undefined);
    assert.equal(compared.content[0].text, 'fixture task value');
  });

  for (const docs of [changedReference, '## Computer Use\nUnrecognized version\n']) test(`A/B docs difference has its own verdict (${docs.length} chars)`, async () => {
    const a = await arm('A'), b = await arm('B', { docs });
    const evidence = campaignEvidence([a, b], undefined, roles);
    assert.equal(evidence.verdict, 'docs-differ');
    assert.equal(evidence.reason, 'engine documentation text changed');
    const row = evidence.comparisons[0].calls[0];
    assert.equal(row.verdict, 'docs-differ');
    assert.deepEqual(row.changes, []);
    assert.ok(row.documentation.changes.length);
  });

  test('docs differences cannot use the selected check target exemption', async () => {
    const a = await arm('A'), b = await arm('B', { docs: changedReference });
    a.check = b.check = { verdict: 'pass' };
    assert.equal(campaignEvidence([a, b], { tool: 'js' }, roles).verdict, 'docs-differ');
  });

  test('task value and structured output differences still fail A/B', async () => {
    const a = await arm('A');
    for (const b of [await arm('B', { value: 'different' }), await arm('B', { structured: 9 })])
      assert.equal(campaignEvidence([a, b], undefined, roles).verdict, 'diverge');
  });

  for (const bad of [{ ...result('fixture failure'), isError: true }, { error: { message: 'fixture RPC error' } },
    result('Replay approval declined'), result('Input refused: fixture barrier')]) test(`matching live stop results never pass (${JSON.stringify(bad)})`, async () => {
    const a = await arm('A', { tail: bad }), b = await arm('B', { tail: bad });
    assert.equal(a.verdict, 'diverge');
    assert.equal(campaignEvidence([a, b], { tool: 'js' }, roles).verdict, 'diverge');
  });

  test('window/app identity is compared between live arms even at an exempted check target', async () => {
    const calls = [{ server: 'plugin:sleight:computer', name: 'js', arguments: { code: 'nodeRepl.write("fixture")' }, result: result('old recording') }];
    const a = await arm('A', { calls, responses: [result(tree(22))] });
    for (const fresh of [tree(22, 'new', 'Other'), tree(22, 'new', 'Fixture', 'Safari'), 'no window']) {
      const b = await arm('B', { calls, responses: [result(fresh)] });
      a.check = b.check = { verdict: 'pass' };
      const evidence = campaignEvidence([a, b], { tool: 'js' }, roles);
      assert.equal(evidence.verdict, 'diverge');
      assert.equal(evidence.comparisons[0].calls[0].reason, 'native window or app changed');
    }
  });

  test('mixed engine builds refuse an otherwise equal A/B campaign and summary', async () => {
    const a = await arm('A'), b = await arm('B');
    a.engine = { start: engine(), end: engine(), changed: false };
    b.engine = { start: engine('50604'), end: engine('50604'), changed: false };
    const evidence = JSON.parse(JSON.stringify(campaignEvidence([a, b], undefined, roles)));
    assert.equal(evidence.verdict, 'diverge');
    assert.equal(evidence.engine.verdict, 'refuse');
    assert.match(evidence.reason, /engine build changed/);
    assert.equal(evidence.engine.build, null);
  });

  test('missing fresh element identity still stops before the recorded action', async () => {
    const sent = [];
    const replay = await replayCalls(recording(), { comparison: 'worktrees', documentation: documentation(),
      call: async (_server, _name, args) => { sent.push(args); return result('Window: "Fixture", App: TextEdit.\n0 window Fixture'); } });
    assert.equal(replay.verdict, 'diverge');
    assert.match(replay.reason, /missing element/);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].code, 'await app.getAXState({ disableDiffing: true });');
  });

  test('live image shapes compare across arms while old recorded dimensions do not constrain them', async () => {
    // Synthetic image headers exercise metadata checks without decoding or capture.
    const image = width => {
      const bytes = Buffer.alloc(24);
      Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
      bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(1, 20);
      return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
    };
    const shot = width => ({ content: [text(tree(22)), image(width)] });
    const calls = [{ server: 'plugin:sleight:computer', name: 'js', arguments: { code: 'nodeRepl.write("fixture")' }, result: shot(1) }];
    const a = await arm('A', { calls, responses: [shot(2)] }), b = await arm('B', { calls, responses: [shot(2)] });
    assert.equal(a.verdict, 'pass', a.reason);
    assert.equal(campaignEvidence([a, b], undefined, roles).verdict, 'pass');
    const other = await arm('B', { calls, responses: [shot(3)] });
    assert.equal(campaignEvidence([a, other], undefined, roles).verdict, 'diverge');
    for (const invalid of [{ content: [image(2)] }, { content: [text(tree(22)), { type: 'image', mimeType: 'image/png', data: 'invalid' }] }]) {
      const refused = await arm('A', { calls, responses: [invalid] });
      assert.equal(refused.verdict, 'diverge');
      assert.match(refused.reason, /visual interpretation/);
    }
  });
});
