import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageSkip } from './requirements.mjs';
import { fixtureDocumentation } from './helpers/canonical-docs.mjs';
import { readReplayEngine, engineDifference, engineIteration, campaignEngine, replayEngineEnvironment } from '../bench/replay/engine-identity.mjs';

const resolved = { version: '26.1023.50603', command: '/fixture/engine/node', configPath: '/fixture/engine/.mcp.json' };
const engine = (build = '50603', version = '26.1023') => ({ version, build, resolved: { ...resolved }, at: '2026-10-28T05:30:00.000Z' });
const passed = () => ({ verdict: 'pass', calls: [], totalToolMs: 0, cleanupConfirmed: true });

test('engine identity reads the app version and build from the two plist keys', () => {
  const keys = [];
  const identity = readReplayEngine({ read: key => { keys.push(key); return key === 'CFBundleVersion' ? '50603' : '26.1023'; },
    resolve: () => resolved,
    now: () => new Date('2026-10-28T05:30:00Z') });
  assert.deepEqual(keys, ['CFBundleShortVersionString', 'CFBundleVersion']);
  assert.equal(identity.version, '26.1023');
  assert.equal(identity.build, '50603');
  assert.equal(identity.at, '2026-10-28T05:30:00.000Z');
  assert.ok(identity.source.endsWith('/ChatGPT.app/Contents/Info.plist'));
});

test('an unreadable plist cannot verify an engine build', () => {
  const identity = readReplayEngine({ read: () => { throw Error('fixture read failure'); }, resolve: () => resolved });
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
  assert.deepEqual(campaignEngine([result]), { verdict: 'pass', version: '26.1023', build: '50603', resolved });
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

test('identity uses the newest launcher cache version and reads the overridden app plist', t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-rp1-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'plugins/cache/openai-bundled/unified-computer-use');
  for (const version of ['26.9.1', '26.10.1']) {
    const dir = join(cache, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
      command: join(dir, 'node'), args: ['--import', join(dir, 'hook.mjs'), join(dir, 'repl.mjs')],
    } } }));
  }
  const app = join(root, 'Alternate ChatGPT.app'), paths = [];
  const identity = readReplayEngine({ env: { CODEX_HOME: root, SLEIGHT_CHATGPT_APP: app },
    read: (key, path) => { paths.push(path); return key === 'CFBundleVersion' ? '50603' : '26.1023'; } });
  assert.deepEqual(identity.resolved, { version: '26.10.1', command: join(cache, '26.10.1/node'), configPath: join(cache, '26.10.1/.mcp.json') });
  assert.deepEqual(paths, [join(app, 'Contents/Info.plist'), join(app, 'Contents/Info.plist')]);
  assert.equal(identity.source, paths[0]);
  assert.equal(engineDifference([identity]), null);
});

test('a resolver failure or incomplete resolved identity refuses the engine', () => {
  const identity = readReplayEngine({ read: () => 'fixture', resolve: () => ({ error: 'fixture resolver failure' }) });
  assert.match(engineDifference([identity]), /unverified/);
  for (const partial of [undefined, {}, { ...resolved, version: 'bundle' }, { ...resolved, command: '' }])
    assert.match(engineDifference([{ ...engine(), resolved: partial }]), /unverified/);
});

test('launcher resolution inputs preserve runtime overrides and exclude unrelated environment values', () => {
  assert.deepEqual(replayEngineEnvironment({ CODEX_HOME: '/fixture/codex', SLEIGHT_CHATGPT_APP: '/fixture/ChatGPT.app', OTHER: 'ignored' }),
    { CODEX_HOME: '/fixture/codex', SLEIGHT_CHATGPT_APP: '/fixture/ChatGPT.app' });
  assert.ok(replayEngineEnvironment({}).CODEX_HOME.endsWith('/.codex'));
  assert.equal(replayEngineEnvironment({}).SLEIGHT_CHATGPT_APP, '/Applications/ChatGPT.app');
});

for (const field of ['version', 'command']) test(`resolved ${field} changes refuse despite an unchanged app plist`, async () => {
  const first = await engineIteration(passed, { read: () => engine() });
  const changed = { ...engine(), resolved: { ...resolved, [field]: `${resolved[field]}-changed` } };
  const next = await engineIteration(() => assert.fail('mixed engine launched'), { previous: [first.engine], read: () => changed });
  assert.match(next.engine.reason, /resolved engine version or command changed/);
  assert.equal(next.verdict, 'diverge');
  assert.equal(next.cleanupConfirmed, true);
  assert.equal(campaignEngine([first, next]).verdict, 'refuse');
});

describe('worktree replay fixtures', { skip: packageSkip('typescript') }, async () => {
  const { replayCalls } = await import('../bench/replay/engine.mjs');
  const { main } = await import('../bench/replay/run.mjs');
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

  test('a text result without a Window header passes when A and B agree', async () => {
    const calls = [{ server: 'plugin:sleight:computer', name: 'js', arguments: { code: 'nodeRepl.write("fixture")' }, result: result('old recording') }];
    const listing = 'Windows:\n[17] Fixture (com.apple.TextEdit)';
    const a = await arm('A', { calls, responses: [result(listing)] });
    const b = await arm('B', { calls, responses: [result(listing)] });
    assert.equal(a.verdict, 'pass', a.reason);
    assert.equal(campaignEvidence([a, b], undefined, roles).verdict, 'pass');
    const changed = await arm('B', { calls, responses: [result(listing.replace('Fixture', 'Other'))] });
    assert.equal(campaignEvidence([a, changed], undefined, roles).verdict, 'diverge');
  });

  test('an iteration does not compare ambiguous window receipts against itself', async () => {
    const calls = [{ server: 'plugin:sleight:computer', name: 'js', arguments: { code: 'nodeRepl.write("fixture")' }, result: result('old recording') }];
    const listing = ['Fixture', 'Second'].map((title, i) => JSON.stringify({ target: { appId: 'com.apple.TextEdit', title },
      identity: { windowNumber: i + 17 } })).join('\n');
    const a = await arm('A', { calls, responses: [result(listing)] });
    const b = await arm('B', { calls, responses: [result(listing)] });
    assert.equal(a.verdict, 'pass', a.reason);
    assert.equal(b.verdict, 'pass', b.reason);
  });

  test('worktree replay continues when a recorded failure now succeeds', async () => {
    const calls = [{ server: 'plugin:sleight:computer', name: 'js', arguments: { code: 'nodeRepl.write("fixture")' },
      result: { ...result('Error: old fixture failure'), isError: true } }];
    const a = await arm('A', { calls, responses: [result('fixture succeeded')] });
    const b = await arm('B', { calls, responses: [result('fixture succeeded')] });
    assert.equal(campaignEvidence([a, b], undefined, roles).verdict, 'pass');
    const strict = await replayCalls(calls, { comparison: 'switches', call: () => assert.fail('recorded stop launched') });
    assert.equal(strict.verdict, 'diverge');
  });

  // The CLI campaign runs its real plan, schedule, engine checks and evidence writes.
  // All host operations below are replaced with fixtures, including the lock and observer.
  async function campaign(t, overrides = {}) {
    const root = mkdtempSync(join(tmpdir(), 'sleight-rp1-main-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'recording'); mkdirSync(source);
    const path = join(root, 'sleight-bench/recorded/fixture/1234abcd.txt');
    writeFileSync(join(source, 'run.json'), JSON.stringify({ task: 'textedit-save' }));
    writeFileSync(join(source, 'transcript.jsonl'), [
      { message: { content: [{ type: 'tool_use', id: '1', name: 'mcp__plugin_sleight_computer__open_file', input: { app: 'TextEdit', path } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: '1', content: [text('old opened')] }] } },
    ].map(JSON.stringify).join('\n'));
    let unlocks = 0, launches = 0;
    const out = join(root, 'out'), exitCode = process.exitCode;
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
    const dependencies = { identifyBuild: (worktree, label) => ({ worktree, label, commit: 'fixture', trackedDirty: false, trackedDiffSHA256: 'fixture' }),
      hold: () => false, permissionCheck: async () => false, acquireLock: async () => async () => { unlocks++; }, readEngine: () => engine(),
      iteration: async (recording, { comparison, prepared }) => ({ ...await replayCalls(recording.calls, {
        comparison, mapper: prepared.mapper, documentation: documentation(), call: async () => result('fresh opened'),
      }), cleanupConfirmed: true }), ...overrides };
    const iterate = dependencies.iteration;
    dependencies.iteration = (...args) => { launches++; assert.equal(args[1].comparison, 'worktrees'); return iterate(...args); };
    let runs;
    try {
      runs = await main([source, '--old-worktree', join(root, 'old'), '--new-worktree', join(root, 'new'),
        '--owner-away', '--repeat', '2', '--out', out], dependencies);
      return { runs, launches, unlocks, exitCode: process.exitCode,
        summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')),
        rows: runs.map((row, i) => JSON.parse(readFileSync(join(out, `${i + 1}-${row.variant}/result.json`), 'utf8'))) };
    } finally { process.exitCode = exitCode; }
  }

  test('main refuses differing resolved engines, writes both rows and stops before later arms', async t => {
    let reads = 0;
    const outcome = await campaign(t, { readEngine: () => {
      const identity = engine();
      if (++reads > 2) identity.resolved.version = '26.1024.1';
      return identity;
    } });
    assert.equal(outcome.launches, 1);
    assert.equal(outcome.runs.length, 2);
    assert.deepEqual(outcome.runs.map(row => row.variant), ['A', 'B']);
    assert.match(outcome.rows[1].engine.reason, /resolved engine version or command changed/);
    assert.equal(outcome.summary.engine.verdict, 'refuse');
    assert.equal(outcome.summary.cleanupConfirmed, true);
    assert.equal(outcome.summary.verdict, 'diverge');
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.unlocks, 1);
  });

  test('main stops on an engine reason after cleanup within the first iteration', async t => {
    let reads = 0;
    const outcome = await campaign(t, { readEngine: () => engine(++reads === 1 ? '50603' : '50604') });
    assert.equal(outcome.launches, 1);
    assert.equal(outcome.rows.length, 1);
    assert.match(outcome.rows[0].engine.reason, /engine build changed/);
    assert.equal(outcome.summary.engine.verdict, 'refuse');
    assert.equal(outcome.unlocks, 1);
  });

  for (const flags of [{}, { cleanupConfirmed: true }, { cleanupConfirmed: true, cleanupUnconfirmed: true }])
    test(`main retains the lock and error row on an iteration exception (${JSON.stringify(flags)})`, async t => {
      const outcome = await campaign(t, { iteration: async () => { throw Object.assign(Error('fixture iteration failed'), flags); } });
      assert.equal(outcome.launches, 1);
      assert.equal(outcome.rows.length, 1);
      assert.equal(outcome.rows[0].reason, 'fixture iteration failed');
      assert.equal(outcome.rows[0].cleanupConfirmed, false);
      assert.deepEqual(outcome.rows[0].engine, { start: engine(), end: engine(), changed: false });
      assert.equal(outcome.summary.cleanupConfirmed, false);
      assert.equal(outcome.summary.failure, 'fixture iteration failed');
      assert.equal(outcome.summary.verdict, 'diverge');
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.unlocks, 0);
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
