import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as live from '../bench/remote-approval-live.mjs';
import { SessionTranscript } from '../bench/world/arms/claude-cu/interactive.mjs';
import * as evidence from '../bench/remote-approval-evidence.mjs';

const notice = '"TextEdit" needs approval on the Mac. Ask the user to reply: allow TextEdit';
const tool = (t, input = { code: 'var app = await cua.getApp("TextEdit")' }) => ({ type: 'assistant', t,
  message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__plugin_sleight_computer__js', input }] } });
const result = (t, text) => ({ type: 'user', t, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } });

test('evidence selects transcript fields, scrubs before byte limits, and writes private files', t => {
  const base = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ra1-evidence-'))));
  const rows = [tool(101, { code: 'read /Users/fixture/private', token: 'opaque-secret', nested: { password: 'password-secret' } }),
    result(102, '🙂'.repeat(2000) + ' sk-ant-test-secret'),
    { type: 'assistant', t: 103, message: { content: [{ type: 'text', text: 'Read ~/fixture Bearer opaque-bearer' }] } }];
  const dir = evidence.writeRemoteEvidence({ started: '2026-10-26T01:02:03.004Z', sessions: [{ rows, turns: [{ submitAt: 100,
    presence: { idleSeconds: 150, locked: false }, firstToolAt: 101, firstResultAt: 102 }],
    server: { stderr: 'HOME=/Users/fixture sk-ant-log-secret', trace: [] },
    env: { ANTHROPIC_API_KEY: 'env-secret' }, credentials: 'credential-secret' }],
    report: { error: 'failed sk-ant-error-secret' } }, { root: base, home: '/Users/fixture' });
  assert.match(dir, /ra1-2026-10-26T01-02-03-004Z$/);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  let all = '';
  for (const file of readdirSync(dir)) {
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    all += readFileSync(join(dir, file), 'utf8');
  }
  assert.doesNotMatch(all, /opaque-secret|password-secret|opaque-bearer|env-secret|credential-secret|sk-ant-|\/Users\/fixture/);
  const saved = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
  assert.equal(saved[0].rows[0].input.code, 'read ~/private');
  assert.equal(saved[0].rows[0].name, 'mcp__plugin_sleight_computer__js');
  assert.ok(Buffer.byteLength(saved[0].rows[1].text) <= 4096);
  assert.equal(saved[0].turns[0].presence.idleSeconds, 150);
  assert.throws(() => evidence.writeRemoteEvidence({ started: '2026-10-26T01:02:03.004Z' }, { root: base }), /EEXIST/);
});

test('keychain and credential payloads are omitted whole, including split stderr chunks', () => {
  const logger = evidence.createServerEvidence();
  logger.stderr('harmless /Users/fixture/path\nAuthorization: Bea');
  logger.stderr('rer split-secret\nsecurity find-generic-password -w\nkeychain-payload\n');
  logger.stderr('{"accessToken":"arbitrary-secret","refreshToken":"refresh-secret"}\n');
  logger.trace('from-server', { method: 'elicitation/create', params: { password: 'trace-secret' } });
  const saved = JSON.stringify(logger.snapshot());
  assert.doesNotMatch(saved, /split-secret|keychain-payload|arbitrary-secret|refresh-secret|trace-secret/);
  assert.match(saved, /elicitation\/create/);
  assert.ok(Object.values(evidence.scrubRemoteValue({ '.credentials.json': 'file-secret', keychain: { value: 'nested-secret' } })).every(value => value === '<redacted>'));
});

test('prewarm failure saves evidence and fails before fixture or session', async () => {
  const order = [];
  const io = { now: () => new Date('2026-10-26T00:00:00Z'), hold: async () => {},
    lock: async () => async () => order.push('unlock'), login: async () => {},
    prewarm: async () => ({ status: 'unavailable', code: 'HOST_BUILD_BUSY' }),
    prepare: async () => { order.push('prepare'); return {}; },
    fixture: async () => assert.fail('prewarm failure opened fixture'),
    session: async () => assert.fail('prewarm failure launched Claude'),
    evidence: async ({ report }) => { order.push('evidence'); assert.match(report.error, /prewarm.*HOST_BUILD_BUSY/i); return '/fixture/evidence'; },
    write: () => order.push('report') };
  const saved = await live.runRemoteApproval({ ownerAway: true }, io);
  assert.equal(saved.passed, false);
  assert.equal(saved.output, '/fixture/evidence/report.json');
  assert.ok(order.indexOf('evidence') < order.indexOf('unlock'));
});

test('trace attribution reports measured phases and leaves missing phases unknown', () => {
  const trace = [
    { t: 0, direction: 'engine-started' }, { t: 5, direction: 'to-server', method: 'initialize', id: 0 },
    { t: 8000, direction: 'from-server', id: 0 },
    { t: 9000, direction: 'to-server', method: 'tools/call', id: 1 },
    { t: 21000, direction: 'from-server', method: 'elicitation/create', id: 'approval' },
    { t: 21500, direction: 'remote-approval-required' },
  ];
  const timing = evidence.noticeTiming([tool(9000), result(22000, notice)], trace, 8500);
  assert.equal(timing.noticeMs, 13000);
  assert.deepEqual(timing.slowNotice.components, [
    { component: 'cold engine start', ms: 8000, from: 0, to: 8000 },
    { component: 'approval elicitation', ms: 12000, from: 9000, to: 21000 },
    { component: 'approval notice delivery', ms: 1000, from: 21000, to: 22000 },
  ]);
  assert.ok(timing.slowNotice.unverified.includes('consent host compile'));
  assert.equal(evidence.noticeTiming([tool(0), result(44000, notice)], [], 0).noticeMs, 44000);
});

// This runs the real polling/receipt code with a synthetic PTY and transcript, never Claude or an app.
for (const [firstAt, noticeAt, pass] of [[0, 44000, true], [0, 46000, false], [100000, 144000, true]]) test(`first notice at ${noticeAt} ms: ${pass ? 'accepted' : 'deadline'}`, async t => {
  const home = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ra1-poll-'))));
  const login = live.remoteLoginPlan({ home, env: { PATH: '/usr/bin' } });
  let now = 0, finish, plan, transcript, turn, nonce, submitted = false;
  const closed = new Promise(r => { finish = r; });
  const session = await live.realSession({ bank: join(home, 'bank'), token: 'owned-fixture' }, {
    login, hold: async () => {}, signal: new AbortController().signal, now: () => now,
    wait: async ms => {
      if (submitted) now += ms;
      if (submitted && now >= noticeAt && !turn) {
        writeFileSync(transcript, JSON.stringify({ ...result(noticeAt, notice), timestamp: new Date(noticeAt).toISOString() }) + '\n', { flag: 'a' });
        turn = plan.env.BENCH_CU_TURN_RECEIPT;
        writeFileSync(turn, JSON.stringify({ sessionId: plan.env.BENCH_CU_SESSION, nonce }));
      }
    }, presence: async () => ({ idleSeconds: 160, locked: false }),
    launch: (p, output) => {
      plan = p; nonce = p.env.BENCH_CU_NONCE;
      const folder = join(p.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture'); mkdirSync(folder, { recursive: true });
      transcript = join(folder, p.env.BENCH_CU_SESSION + '.jsonl');
      output('❯\n');
      return { closed, write() {
        submitted = true; now = firstAt;
        writeFileSync(transcript, JSON.stringify({ ...tool(firstAt), timestamp: new Date(firstAt).toISOString() }) + '\n');
      }, async stop() { finish({ clean: true }); } };
    },
  });
  t.after(() => session.close());
  if (pass) {
    const answer = await session.submit(live.remotePlan().first);
    assert.equal(answer.noticeMs, 44000);
    assert.deepEqual(answer.presence, { idleSeconds: 160, locked: false });
    assert.equal(answer.firstResultAt, noticeAt);
  } else {
    await assert.rejects(session.submit(live.remotePlan().first), /deadline/);
    const snapshot = session.diagnostics();
    const output = evidence.writeRemoteEvidence({ started: '2026-10-26T03:00:00Z', sessions: [snapshot] }, { root: home });
    const saved = JSON.parse(readFileSync(join(output, 'sessions.json'), 'utf8'))[0];
    assert.equal(saved.rows[0].name, 'mcp__plugin_sleight_computer__js');
    assert.equal(saved.turns[0].submitAt, 0);
    assert.equal(saved.turns[0].firstToolAt, 0);
    assert.deepEqual(saved.turns[0].presence, { idleSeconds: 160, locked: false });
    assert.equal(saved.server.stderr, null);
    assert.equal(saved.turns[0].noticeAt, null);
    assert.equal(saved.turns[0].noticeWaitMs, 45000);
    assert.equal(saved.turns[0].slowNotice.components.length, 0);
  }
  await session.close();
});


test('assistant text has a separate evidence callback without changing existing tool callbacks', () => {
  const transcript = new SessionTranscript('fixture'), rows = [], texts = [];
  transcript.onEvent = row => rows.push(row); transcript.onText = row => texts.push(row);
  transcript.append(JSON.stringify({ ...tool(100), sessionId: 'fixture', timestamp: '2026-10-26T01:00:00Z' }) + '\n');
  transcript.append(JSON.stringify({ type: 'assistant', sessionId: 'fixture', timestamp: '2026-10-26T01:00:01Z',
    message: { id: 'm2', content: [{ type: 'text', text: 'Waiting for approval.' }] } }) + '\n');
  assert.equal(rows.length, 1);
  assert.equal(texts[0].message.content[0].text, 'Waiting for approval.');
});

test('evidence failure retains the bank and lock instead of cleaning away the diagnostic source', async () => {
  let cleanup = false, unlock = false;
  const io = { now: () => new Date('2026-10-26T00:00:00Z'), hold: async () => {},
    lock: async () => async () => { unlock = true; }, login: async () => {},
    prewarm: async () => ({ status: 'ready' }), prepare: async () => ({ bank: '/fixture/bank' }), fixture: async () => {},
    session: async () => ({ submit: async () => { throw Error('notice timeout'); }, close: async () => ({ clean: true }) }),
    evidence: async () => { throw Error('EACCES'); }, cleanup: async () => { cleanup = true; return true; },
    write: () => assert.fail('missing evidence directory cannot receive report') };
  const saved = await live.runRemoteApproval({ ownerAway: true }, io);
  assert.equal(saved.passed, false); assert.equal(saved.evidenceError, 'EACCES');
  assert.equal(saved.lockRetained, true); assert.equal(saved.bank, '/fixture/bank');
  assert.equal(cleanup, false); assert.equal(unlock, false);
});

test('stderr keeps the latest 16 KiB and redacts opaque authentication values without reading credential files', () => {
  const logger = evidence.createServerEvidence();
  logger.stderr('old-line\n' + 'x'.repeat(20000) + '\nlatest-line\n');
  const tail = logger.snapshot().stderr;
  assert.ok(Buffer.byteLength(tail) <= 16384); assert.ok(tail.endsWith('latest-line\n')); assert.ok(!tail.includes('old-line'));
  for (const raw of ['{"accessToken":"opaque-value"}', 'refresh_token=opaque-value', 'Authorization: Bearer opaque-value',
    'ANTHROPIC_API_KEY=opaque-value', 'sk-proj-opaque-value', 'ghp_opaque-value', 'eyJhbGciOiJIUzI1NiJ9.payload.signature']) {
    assert.doesNotMatch(evidence.scrubRemoteValue(raw), /opaque-value|eyJhbGci/);
  }
});

test('prewarm uses helper defaults, records compile progress, and never launches the prepared host', async () => {
  let clock = 100;
  const result = await live.prewarmConsentHost({ now: () => clock, prepare: async options => {
    assert.equal(options.cacheRoot, undefined); assert.equal(options.sourceRoot, undefined);
    options.onProgress({ stage: 'compile', helper: 'consent-host' }); clock = 250;
    return { status: 'ready', spawn: () => assert.fail('prewarm launched a window-capable host') };
  } });
  assert.equal(result.status, 'ready'); assert.equal(result.ms, 150);
  assert.equal(result.progress[0].helper, 'consent-host');
});


test('an unfinished notice wait attributes an open trace interval without inventing a result', () => {
  const timing = evidence.noticeTiming([tool(1000)], [
    { t: 1100, direction: 'to-server', method: 'tools/call', id: 1 },
  ], 900, 46000);
  assert.equal(timing.firstResultAt, null); assert.equal(timing.noticeAt, null); assert.equal(timing.noticeMs, null);
  assert.deepEqual(timing.slowNotice.pending, [{ component: 'approval elicitation', from: 1100, observedAt: 46000, ms: 44900 }]);
  assert.equal(live.gradeRemote({ notice: { firstToolAt: null, noticeAt: null, text: notice } }).checks.notice, false);
});
