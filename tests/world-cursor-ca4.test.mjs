import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
const realTmp = realpathSync(tmpdir());
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { armPaths, composerPlan, CURSOR_PIN } from '../bench/world/arms/cursor-cu/contract.mjs';
import { nativeMain } from '../bench/world/arms/cursor-cu/suite.mjs';
import { runDesktop } from '../bench/world/arms/cursor-cu/run.mjs';
import { DesktopDriver } from '../bench/world/arms/cursor-cu/desktop.mjs';
import { makeCalibration, calibrate } from '../bench/world/arms/cursor-cu/calibrate.mjs';
import * as state from '../bench/world/arms/cursor-cu/state.mjs';
import { AgentClock } from '../bench/agent-time.mjs';
import * as timing from '../bench/agent-time.mjs';
import { excluded, score } from '../bench/claim-score.mjs';
import { admitRealGate, runGateAgent } from '../bench/fowl/real-gate.mjs';
import { browserEvidence } from '../bench/fowl/real-gate-grade.mjs';
import { scoreRounds } from '../bench/fowl/race-score.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { publicPrivateMailRow } from '../bench/private-mail.mjs';
import { scrubCursor } from '../bench/world/arms/cursor-cu/scrub.mjs';

const paths = armPaths({ home: join(realTmp, 'ca4-fixture-home') });
const own = { pid: 42, bundleId: CURSOR_PIN.bundleId, executable: paths.app + '/Contents/MacOS/Cursor', launchAt: 1000 };
const config = { selectedModels: [{ modelId: 'grok-4.7-high', parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] }] };
const composer = () => ({ composerId: 'chat', status: 'completed', latestChatGenerationUUID: 'turn', generatingBubbleIds: [], modelConfig: config,
  contextAttachments: [{ type: 'computer-use' }], target: { type: 'local' }, fullConversationHeadersOnly: [{ bubbleId: 'human' }, { bubbleId: 'answer' }] });
const snapshot = (ended = true, tools = []) => ({ composers: [{ ...composer(), status: ended ? 'completed' : 'generating',
  fullConversationHeadersOnly: [{ bubbleId: 'human' }, ...tools.map((_, i) => ({ bubbleId: 'tool-' + i })), { bubbleId: 'answer' }] }], bubbles: { chat: [
  { bubbleId: 'human', type: 1, text: 'Edit.' }, ...tools.map((toolFormerData, i) => ({ bubbleId: 'tool-' + i, type: 2, toolFormerData })),
  { bubbleId: 'answer', type: 2, text: 'done', timingInfo: { clientStartTime: 1100, ...(ended && { clientSettleTime: 1500 }) } },
] } });
const request = { name: 'TextEdit', bundleId: 'com.apple.TextEdit', toolCallId: 'request', generationId: 'turn' };
const pending = () => {
  const s = snapshot(false, [{ toolCallId: 'request', status: 'needs_user_approval', additionalData: { computerUseApp: { name: request.name, bundleId: request.bundleId } } }]);
  return s;
};
const card = { owner: own, title: 'Allow Cursor to use TextEdit?', name: request.name, bundleId: request.bundleId, source: 'Computer Use', button: 'Allow in this chat', id: 'card' };
const plan = () => composerPlan({ prompt: 'Edit.', paths, ownerSaysCursorFree: true, allowedApps: [request.bundleId], timeoutMs: 5000 });
const temp = () => trackTemp(mkdtempSync(join(realTmp, 'sleight-ca4-test-')));

test('nativeMain grades the raw Cursor answer and saves a scrubbed copy', async () => {
  const dir = temp(), exit = process.exitCode, answer = 'Done. password: hunter2';
  let graded;
  try {
    const out = await nativeMain(['--tasks', 'textedit-edit', '--runs', '1', '--owner-away', '--out', join(dir, 'results.json')], {
      guard: () => {}, held: () => false, preflight: async () => {}, inspect: () => {}, readiness: async () => ({ authStored: true }), lock: async () => () => {},
      run: async () => ({ is_error: false, duration_ms: 2000, agentSeconds: 2, groupClean: true, result: answer }),
      execute: async (_task, _ctx, { drive }) => { const d = await drive('Edit.'); graded = d.out.result; return { ...d, seconds: 9, passed: true }; },
    });
    assert.equal(graded, answer);
    const saved = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).results[0];
    assert.doesNotMatch(JSON.stringify(saved), /hunter2/);
    assert.doesNotMatch(JSON.stringify(out.results[0]), /hunter2/);
  } finally { process.exitCode = exit; rmSync(dir, { recursive: true, force: true }); }
});

for (const passed of [false, true]) test(`nativeMain retains ${passed ? 'passing' : 'failed'} rows in cursor-cu score`, async () => {
  const dir = temp(), exit = process.exitCode;
  try {
    const out = await nativeMain(['--tasks', 'textedit-edit', '--runs', '1', '--owner-away', '--out', join(dir, 'results.json')], {
      guard: () => {}, held: () => false, preflight: async () => {}, inspect: () => {}, readiness: async () => ({ authStored: true }), lock: async () => () => {},
      run: async () => ({ is_error: !passed, duration_ms: passed ? 2000 : null, agentSeconds: passed ? 2 : null, groupClean: true }),
      execute: async (_task, _ctx, { drive }) => ({ ...await drive('Edit.'), seconds: 9, passed }),
    });
    const row = out.results[0], rules = { tasks: ['textedit-edit'], reasons: [], files: [], windows: [] };
    assert.equal(row.seconds, passed ? 2 : 9);
    assert.equal(excluded(row, 'results.json', rules), undefined);
    assert.equal(row.arm, 'cursor-cu');
    assert.equal(row.secondsTiming.startupIncluded, !passed);
    const table = score([row]);
    assert.deepEqual(table['cursor-cu']['textedit-edit'].runs, [passed ? 2 : 9]);
    assert.equal(table['cursor-cu']['textedit-edit'].passes.length, passed ? 1 : 0);
    if (!passed) assert.equal(score([row, { ...row, passed: true, seconds: 1 }])['cursor-cu']['textedit-edit'].expected, 10);
    assert.equal(JSON.parse(readFileSync(join(dir, 'results.json'))).results[0].arm, 'cursor-cu');
  } finally { process.exitCode = exit; rmSync(dir, { recursive: true, force: true }); }
});

function guardFixture({ visible = () => false, readState = async () => snapshot(false), cards = () => [], press = () => {} } = {}) {
  let time = 0, scans = 0, presses = 0;
  const d = new DesktopDriver({ readState, exists: () => false, processes: async () => [own], now: () => time,
    pause: async ms => { time += ms; }, ax: { read: async (_owners, executable) => { assert.equal(executable, own.executable); scans++; return cards(time); },
      press: async (c, _owners, executable) => { assert.equal(executable, own.executable); presses++; await press(c); } } });
  Object.assign(d, { paths, identity: own, launchedAt: 1000, composerId: 'chat', submitted: true,
    ui: { cardsVisible: async () => visible(time) } });
  return { d, time: () => time, scans: () => scans, presses: () => presses };
}
test('idle guard avoids native AX scans', async () => {
  const f = guardFixture(); await f.d.guard(plan()); assert.equal(f.scans(), 0);
});
test('visible card waits for its DB row, then allows slow dismissal without pressing twice', async () => {
  let f, pressedAt;
  f = guardFixture({ visible: time => pressedAt === undefined || time < pressedAt + 700,
    readState: async () => f.time() >= 500 ? pending() : snapshot(false),
    cards: time => pressedAt === undefined || time < pressedAt + 700 ? [card] : [], press: () => { pressedAt = f.time(); } });
  await f.d.guard(plan()); assert.equal(f.presses(), 1); assert.ok(f.time() >= 1200);
});
test('missing binding stops after bounded grace and never presses', async () => {
  const f = guardFixture({ visible: () => true, cards: () => [card] });
  await assert.rejects(f.d.guard(plan()), /approval stop/);
  assert.ok(f.time() >= 1900 && f.time() <= 2200); assert.equal(f.presses(), 0);
});
test('changed generation at the press still refuses', async () => {
  let reads = 0;
  const f = guardFixture({ cards: () => [card], readState: async () => { const s = pending(); if (++reads > 1) s.composers[0].latestChatGenerationUUID = 'other'; return s; } });
  await assert.rejects(f.d.guard(plan()), /pending request changed/); assert.equal(f.presses(), 0);
});
test('native-only unbound cards retry without losing any binding checks', async () => {
  let f;
  f = guardFixture({ cards: () => [{ ...card, name: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'Allow Cursor to use Google Chrome?' }],
    readState: async () => pending() });
  await assert.rejects(f.d.guard({ ...plan(), allowedApps: [request.bundleId, 'com.google.Chrome'] }), /unbound/);
  assert.ok(f.time() >= 1900); assert.equal(f.presses(), 0);
});
test('a card that never dismisses stops after grace, with one press', async () => {
  const f = guardFixture({ visible: () => true, cards: () => [card], readState: async () => pending() });
  await assert.rejects(f.d.guard(plan()), /approval stop/);
  assert.ok(f.time() >= 1900 && f.time() <= 2200); assert.equal(f.presses(), 1);
});

async function fakeRun(snapshots, onEvent) {
  let i = 0;
  return runDesktop(plan(), { now: () => 1000, pause: async () => {}, onEvent, driver: {
    open: async () => {}, setup: async () => ({ baselineIds: [] }), submit: async (_p, { onSubmit }) => onSubmit(),
    readState: async () => snapshots[Math.min(i++, snapshots.length - 1)], close: async () => true,
  } });
}
test('state events omit repeated polls, raw usage, credentials and image payloads', async () => {
  const tool = { toolCallId: 'ok', tool: 'computer_use', status: 'completed', params: { app: 'com.google.Chrome', url: 'https://developer.mozilla.org/' },
    result: { success: true, accessToken: 'secret-access', cookie: 'secret-cookie', accountId: 'secret-account', screenshot: 'huge-image',
      content: [{ type: 'image', data: 'huge-data' }, { type: 'text', text: 'Authorization: Bearer secret-bearer' }], nested: { credential: 'secret-credential' } } };
  const s = snapshot(false, [tool]); s.composers[0].usageData = { token: 'secret-usage' };
  const events = [], out = await fakeRun([s, s, s, snapshot(true, [tool])], e => events.push(e));
  assert.equal(events.length, 2);
  assert.equal(events.reduce((n, e) => n + e.tools.length, 0), 1);
  const text = JSON.stringify({ out, events });
  for (const value of ['secret-access', 'secret-cookie', 'secret-account', 'huge-image', 'huge-data', 'secret-bearer', 'secret-credential', 'secret-usage']) assert.ok(!text.includes(value), value);
  assert.equal(browserEvidence(events.map(JSON.stringify).join('\n')).successfulCalls, 1);
});
test('tool completion at the same tool count still emits changed evidence', async () => {
  const tool = { toolCallId: 'ok', tool: 'computer_use', status: 'running', params: { app: 'com.google.Chrome' } };
  const events = [];
  await fakeRun([snapshot(false, [tool]), snapshot(true, [{ ...tool, status: 'completed', result: { success: true } }])], e => events.push(e));
  assert.equal(browserEvidence(events.map(JSON.stringify).join('\n')).successfulCalls, 1);
});
test('growing tool history persists each unchanged row once rather than every prefix', async () => {
  const tools = Array.from({ length: 30 }, (_, i) => ({ toolCallId: 'call-' + i, tool: 'computer_use', status: 'completed', params: { app: 'com.google.Chrome' }, result: { success: true } }));
  const events = [];
  await fakeRun(tools.map((_, i) => snapshot(i === tools.length - 1, tools.slice(0, i + 1))), e => events.push(e));
  assert.equal(events.length, 30); assert.equal(events.reduce((n, e) => n + e.tools.length, 0), 30);
  assert.equal(browserEvidence(events.map(JSON.stringify).join('\n')).successfulCalls, 30);
});
test('scrubbing covers nested JSON strings, binary MIME payloads and credential text', () => {
  const out = scrubCursor({ result: JSON.stringify({ accessToken: 'private-token', accountId: 'private-account', nested: { cookie: 'private-cookie' } }),
    metadata: { account: { id: 'private-nested-account' }, user: { id: 'private-nested-user' } },
    content: [{ mimeType: 'image/png', data: 'private-image' }, { mimeType: 'application/octet-stream', data: 'private-binary' },
      { type: 'text', text: 'Authorization: Basic private-basic\nAPI_KEY="private-key"\nCookie: private-cookie-text\nCookie: one=private-cookie-one; two=private-cookie-two\naccount_id: private-id' }],
    safe: { app: 'com.google.Chrome', url: 'https://example.com/?access_token=private-query', success: true } });
  const text = JSON.stringify(out);
  for (const secret of ['private-token', 'private-account', 'private-nested-account', 'private-nested-user', 'private-cookie', 'private-image', 'private-binary', 'private-basic', 'private-key', 'private-cookie-text', 'private-cookie-one', 'private-cookie-two', 'private-id', 'private-query']) assert.ok(!text.includes(secret), secret);
  assert.equal(out.safe.app, 'com.google.Chrome'); assert.equal(out.safe.success, true);
});

test('Swift enables web accessibility only after process identity validation and validates expected executable', () => {
  const source = readFileSync(new URL('../bench/world/arms/cursor-cu/macos.swift', import.meta.url), 'utf8');
  assert.match(source, /AXManualAccessibility/);
  assert.match(source, /expectedExecutable/);
  assert.ok(source.indexOf('try owned(owner') < source.indexOf('"AXManualAccessibility"'));
  assert.match(source, /app\.executableURL\?\.path == expectedExecutable/);
});
test('stalled profile and AX reads stop within their explicit timeouts', async () => {
  const never = () => new Promise(() => {}), d = new DesktopDriver({ readState: never, operationTimeoutMs: 10 });
  await assert.rejects(d.readState(), /profile read timeout/);
  const f = guardFixture({ readState: async () => pending() });
  f.d.operationTimeoutMs = 10; f.d.ax.read = never;
  await assert.rejects(f.d.guard(plan()), /AX card read timeout/);
});
test('calibration checks existing file before attachment and passes caller ownerAway', async () => {
  const seen = [], options = { exists: () => true, guard: x => seen.push(x), driver: { preflight: () => assert.fail('preflight before existing calibration check') } };
  await assert.rejects(calibrate({ ownerAway: false, ownerSaysCursorFree: true }, options), /already exists/);
  assert.deepEqual(seen, []);
  options.exists = () => false; options.driver.preflight = () => { throw Error('stop before lock'); };
  await assert.rejects(calibrate({ ownerAway: false, ownerSaysCursorFree: true }, options), /stop before lock/);
  assert.equal(seen[0].ownerAway, false);
});
test('calibration shapes accept known fields only and discard dynamic ids', () => {
  const c = composer(); c.innocentLookingKey = 'computer-use'; c.contextAttachments[0].abcd1234 = 'value'; c.contextAttachments[0].userId = 'private';
  const out = makeCalibration(c, { settled: true, ownerModelLabel: 'Grok 4.7 High', bubbles: snapshot().bubbles.chat });
  const text = JSON.stringify(out.shapes);
  for (const key of ['innocentLookingKey', 'abcd1234', 'userId', 'composerId', 'bubbleId']) assert.ok(!text.includes('"' + key + '"'), key);
  assert.ok(text.includes('modelConfig'));
});
test('direct Cursor gate admission enforces owner-free flag before other side effects', async () => {
  await assert.rejects(admitRealGate({ surface: 'cursor-cu', ownerAway: false, out: join(realTmp, 'ca4-not-created'), arms: [] }), /owner-says-cursor-free/);
});
test('SQLite WAL busy retry is bounded, closes each connection and never retries unrelated errors', async () => {
  assert.equal(typeof state.retryBusy, 'function');
  let attempts = 0, time = 0;
  const opts = { now: () => time, pause: async ms => { time += ms; }, timeoutMs: 200 };
  const result = await state.retryBusy(() => { if (++attempts < 3) throw Error('database is locked'); return 'ok'; }, opts);
  assert.equal(result, 'ok'); assert.equal(attempts, 3);
  await assert.rejects(state.retryBusy(() => { throw Error('database is locked'); }, opts), /locked/);
  attempts = 0;
  await assert.rejects(state.retryBusy(() => { attempts++; throw Error('bad schema'); }, opts), /bad schema/); assert.equal(attempts, 1);
  let closed = 0;
  await state.retryBusy(() => state.readCursorState(paths, { exists: () => true, open: (_file, options) => {
    assert.equal(options.readOnly, true); assert.ok(options.timeout <= 100);
    return { close: () => closed++, prepare: () => ({ all: () => { if (closed < 2) throw Error('database is locked'); return []; } }) };
  } }), { ...opts, timeoutMs: 1000 });
  assert.equal(closed, 3);
});
test('receipt timestamps ignore arbitrary CLI result overrides and explicitly retain Cursor interval', async () => {
  const source = readFileSync(new URL('../bench/fowl/real-gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /const receipt = \{ \.\.\.result, started, finished/);
  const dir = temp();
  try {
    const base = { task: { name: 'mdn' }, dir: join(dir, 'cli'), surface: 'sleight-turbo', metadata: {}, command: 'fake', args: [], env: {}, mcpConfig: {}, settingsOverrides: {} };
    const run = await runGateAgent(base, { runClaude: async () => ({ exit: { code: 0 }, groupClean: true, stdout: '{"type":"result"}\n', stderr: '', started: -1, finished: -2 }) });
    assert.ok(run.started > 0 && run.finished >= run.started);
    const cursor = await runGateAgent({ ...base, dir: join(dir, 'cursor'), surface: 'cursor-cu', cursorPlan: plan() }, {
      runCursor: async () => ({ groupClean: true, calls: 0, duration_ms: 500, submittedAt: 1000, recordedEndAt: 1500 }),
    });
    assert.equal(cursor.started, 1000); assert.equal(cursor.finished, 1500); assert.ok(cursor.outerStarted > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('interactive race fallback uses the outer clock metadata when the inner interval is missing', async () => {
  const dir = temp();
  try {
    const timing = { start: 'spawn', end: 'final-result-event', startupIncluded: true };
    const receipt = await runGateAgent({ dir: join(dir, 'run'), surface: 'claude-cu', metadata: { interactive: true }, task: { name: 'mdn' }, mcpConfig: {}, settingsOverrides: {} }, {
      runClaude: async () => ({ exit: { code: 0 }, groupClean: true, stderr: '', agentSeconds: 4, agentTiming: timing,
        stdout: JSON.stringify({ type: 'result', agentSeconds: null, agentTiming: { start: 'ready-prompt-and-mcp-submit', end: 'result-and-idle', startupIncluded: false } }) + '\n' }),
    });
    assert.equal(receipt.agentSeconds, 4); assert.deepEqual(receipt.agentTiming, timing);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agent clock starts at first observable init, retains spawn fallback, and caps malformed input', () => {
  let time = 1200; const c = new AgentClock(1000, () => time);
  c.append('{"type":"system","subtype":"init"}\n'); time = 2200; c.append('{"type":"result"}\n');
  assert.equal(c.seconds(), 1); assert.equal(c.timing().startupIncluded, false);
  const fallback = new AgentClock(1000, () => 2200); fallback.append('{"type":"result"}\n');
  assert.equal(fallback.timing().startupIncluded, true);
  const huge = new AgentClock(1000); huge.append('x'.repeat(2 * 1024 * 1024));
  assert.ok(huge.pending.length <= 1024 * 1024);
  huge.append('\n{"type":"result"}\n'); assert.ok(huge.seconds() >= 0);
  const object = new AgentClock(1000, () => 2000);
  object.append('{"unfinished":"' + 'x'.repeat(2 * 1024 * 1024)); assert.equal(object.pending.length, 0);
  object.append('\n{"type":"system","subtype":"init"}\n{"type":"result"}\n'); assert.equal(object.seconds(), 0);
  for (const text of ['{"type":"result","text":"escaped \\\" } \\\\"}', '{\n"type":"result","nested":[{"x":"é"}]}']) {
    const c = new AgentClock(1000, () => 2000);
    for (const byte of Buffer.from(text)) c.append(Buffer.from([byte]));
    assert.equal(c.seconds(), 1);
  }
});
test('timing summary reports per-arm selection, fallback and startup inclusion including invalid durations', () => {
  assert.equal(typeof timing.timingSummary, 'function');
  const rows = [{ arm: 'cursor-cu', agentSeconds: 1, agentTiming: { startupIncluded: false, start: 'submit' } },
    { arm: 'cursor-cu', seconds: 5 }, { arm: 'codex', agentSeconds: 2, agentTiming: { startupIncluded: true, start: 'spawn' } },
    { arm: 'codex', agentSeconds: -1, seconds: 3 }];
  const s = timing.timingSummary(rows);
  assert.deepEqual(s['cursor-cu'], { agentSeconds: 1, secondsFallback: 1, startupIncluded: { yes: 0, no: 1, unknown: 1 }, starts: { submit: 1, seconds: 1 } });
  assert.equal(s.codex.agentSeconds, 1); assert.equal(s.codex.secondsFallback, 1); assert.equal(s.codex.startupIncluded.yes, 1);
  const fallback = timing.timingSummary([{ arm: 'cursor-cu', agentSeconds: null, seconds: 7, agentTiming: { startupIncluded: false }, secondsTiming: { start: 'outer-drive', startupIncluded: true } }]);
  assert.equal(fallback['cursor-cu'].startupIncluded.yes, 1); assert.equal(fallback['cursor-cu'].starts['outer-drive'], 1);
});

test('claim and race scorer JSON and text expose per-arm timing counts for scored rows', () => {
  const dir = temp();
  try {
    const rows = [{ arm: 'cursor-cu', task: 'mdn', run: 1, passed: true, seconds: 10, agentSeconds: 2, agentTiming: { start: 'submit', end: 'persisted-clientSettleTime', startupIncluded: false } },
      { arm: 'cursor-cu', task: 'mdn', run: 2, passed: false, seconds: 12, agentSeconds: null }];
    const results = join(dir, 'native'), round = join(dir, 'round'); mkdirSync(results); mkdirSync(round);
    const rules = join(dir, 'rules.json'); writeFileSync(rules, JSON.stringify({ since: '', tasks: ['mdn'], arms: ['cursor-cu'], reasons: [], files: [], windows: [] }));
    writeFileSync(join(results, 'run.json'), JSON.stringify({ results: rows }));
    writeFileSync(join(round, 'browser.json'), '{"browser":"chrome"}');
    writeFileSync(join(round, 'results.json'), JSON.stringify(rows.map(r => ({ task: { name: 'mdn' }, surface: r.arm, wallMs: r.seconds * 1000,
      agentSeconds: r.agentSeconds, agentTiming: r.agentTiming, successfulBrowserCalls: 1, outcome: { ok: r.passed } }))));
    for (const [script, args] of [['bench/claim-score.mjs', ['--results', results, '--rules', rules]], ['bench/fowl/race-score.mjs', [round]]]) {
      const run = format => spawnSync(process.execPath, [script, ...args, '--agent-seconds', ...format], { encoding: 'utf8' });
      const json = run(['--json']); assert.equal(json.status, 0, json.stderr);
      const out = JSON.parse(json.stdout), summary = out.timingByArm['cursor-cu'];
      assert.equal(summary.agentSeconds, 1); assert.equal(summary.secondsFallback, 1); assert.equal(summary.startupIncluded.no, 1); assert.equal(summary.startupIncluded.unknown, 1);
      const text = run([]); assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /"cursor-cu":\{"agentSeconds":1,"secondsFallback":1/);
    }
    const rounds = [{ browser: 'chrome', rows: [{ ...rows[0], harnessCover: true }, rows[1]], coverMarked: true }];
    const scored = scoreRounds(rounds, { agentSeconds: true, excludeCovered: true });
    assert.equal(scored.chrome.timingByArm['cursor-cu'].agentSeconds, 0); assert.equal(scored.chrome.timingByArm['cursor-cu'].secondsFallback, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('private rows preserve only known timing enums', () => {
  const row = { arm: 'sleight', task: 'mimestream-label', run: 1, agentSeconds: 1, agentTiming: { start: 'system/init', end: 'final-result-event', startupIncluded: false, token: 'secret' } };
  assert.deepEqual(publicPrivateMailRow(row).agentTiming, { start: 'system/init', end: 'final-result-event', startupIncluded: false });
  row.agentTiming.start = 'secret'; assert.equal(publicPrivateMailRow(row).agentTiming, undefined);
});
