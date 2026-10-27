import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURSOR_PIN, armPaths, assertBundlePin, resolveModel, composerPlan, approvalDecision, assertDesktopReady } from '../bench/world/arms/cursor-cu/contract.mjs';
import { detectRun, readCursorState } from '../bench/world/arms/cursor-cu/state.mjs';
import { runDesktop } from '../bench/world/arms/cursor-cu/run.mjs';
import { setupPlan, loginReadiness, inspectBundle } from '../bench/world/arms/cursor-cu/setup.mjs';
import { probePlan, guardLive, runProbe } from '../bench/world/arms/cursor-cu/probe.mjs';
import { DesktopDriver } from '../bench/world/arms/cursor-cu/desktop.mjs';

const model = { modelId: 'grok-4.7', parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] };
const config = { selectedModels: [model], maxMode: false };
const home = ['', 'Users', 'bench'].join('/');
const paths = () => armPaths({ home });
const plan = () => composerPlan({ prompt: 'Edit the fixture.', paths: paths(), ownerSaysCursorFree: true });
// Source-derived schema samples, not recordings. Cursor was never launched by this lane.
const start = (extra = {}) => ({ composerId: 'chat-1', text: '', status: 'generating', latestChatGenerationUUID: 'turn-1',
  modelConfig: config, fullConversationHeadersOnly: [{ bubbleId: 'human', type: 1 }, { bubbleId: 'answer', type: 2 }], ...extra });
const bubbles = end => [{ bubbleId: 'human', type: 1, text: 'Edit the fixture.' }, { bubbleId: 'answer', type: 2,
  text: 'RESULT: edited', timingInfo: { clientStartTime: 1100, ...(end && { clientSettleTime: end }) } }];
const state = (done = false) => ({ composers: [start(done ? { status: 'completed', generatingBubbleIds: [] } : {})], bubbles: { 'chat-1': bubbles(done ? 1600 : undefined) } });

test('bundle pin requires version, commit, identifier, team, verified seal and cdhash', () => {
  const found = { ...CURSOR_PIN, signatureVerified: true };
  assert.equal(assertBundlePin(found).version, '3.27.12');
  for (const key of ['version', 'commit', 'bundleId', 'teamId', 'cdhash']) assert.throws(() => assertBundlePin({ ...found, [key]: 'other' }), /pin/);
  assert.throws(() => assertBundlePin({ ...found, signatureVerified: false }), /identifier|signature/);
});

test('bundle inspection verifies the resource seal and captures cdhash from codesign stderr', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ca2-pin-'));
  try {
    mkdirSync(join(dir, 'Contents/Resources/app'), { recursive: true });
    writeFileSync(join(dir, 'Contents/Resources/app/product.json'), JSON.stringify({ ...CURSOR_PIN, darwinBundleIdentifier: CURSOR_PIN.bundleId }));
    const calls = [];
    const pin = inspectBundle(dir, (cmd, args) => { calls.push([cmd, args]); return { status: 0,
      stdout: CURSOR_PIN.bundleId + '\n', stderr: `TeamIdentifier=${CURSOR_PIN.teamId}\nCDHash=${CURSOR_PIN.cdhash}\n` }; });
    assert.equal(pin.cdhash, CURSOR_PIN.cdhash); assert.deepEqual(calls[0][1], ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(dir, 'Contents/Info.plist')]);
    assert.throws(() => inspectBundle(dir, () => ({ status: 1 })), /identifier|signature/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owner profile and installed app are fixed, symlinks refuse', () => {
  const p = paths();
  assert.equal(p.app, '/Applications/Cursor.app');
  assert.equal(p.userData, `${home}/Library/Application Support/Cursor`);
  assert.equal(p.home, undefined); assert.equal(p.extensions, undefined);
  assert.throws(() => armPaths({ home, root: '/tmp/cursor' }), /fixed/);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ca2-path-'));
  try {
    const root = join(dir, 'Library/Application Support');
    mkdirSync(root, { recursive: true }); symlinkSync('/tmp', join(root, 'Cursor'));
    assert.throws(() => armPaths({ home: dir }), /symlink refused/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('Grok 4.7 High resolves exact high and normal speed, without inventing server aliases', () => {
  assert.deepEqual(resolveModel(config), { label: 'Grok 4.7 High', model: 'grok-4.7', effort: 'high', speed: 'normal', parameters: model.parameters });
  for (const replacement of [{ ...model, modelId: 'grok-4.6' }, { ...model, parameters: [] },
    { ...model, parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'true' }] }])
    assert.throws(() => resolveModel({ selectedModels: [replacement] }), /Grok 4.7 High/);
  assert.throws(() => resolveModel({ selectedModels: [model, model] }), /single/);
  assert.equal(resolveModel({ selectedModels: [{ ...model, modelId: 'cursor-grok-4.7-high', parameters: model.parameters }] }).model, 'cursor-grok-4.7-high');
});

test('composer plan excludes setup from timing, uses desktop UI, and never selects a worker or CLI', () => {
  const p = plan();
  assert.equal(p.route, 'desktop'); assert.equal(p.target, 'This Mac'); assert.equal(p.attachment, 'Computer Use');
  assert.equal(p.modelLabel, 'Grok 4.7 High'); assert.equal(p.effort, 'high'); assert.equal(p.speed, 'normal');
  assert.equal(p.timing.start, 'harness-submit'); assert.equal(p.timing.end, 'recorded-clientSettleTime');
  assert.ok(!JSON.stringify(p).includes('cursor-agent'));
  assert.throws(() => composerPlan({ prompt: '', paths: paths() }), /prompt/);
});

test('setup uses the installed logged-in session without a launch or login flow', () => {
  const p = setupPlan({ paths: paths() });
  assert.equal(p.launch, undefined); assert.equal(p.mutates, false);
  assert.ok(p.ownerSteps.some(s => s.includes('--owner-says-cursor-free')));
});

test('approval gate defaults to refuse, requires bundle and exact supported prompt, never Always Allow', () => {
  const prompt = { title: 'Allow Cursor to use TextEdit?', bundleId: 'com.apple.TextEdit', name: 'TextEdit', button: 'Allow in this chat', source: 'Computer Use' };
  assert.equal(approvalDecision(prompt, {}).allow, false);
  assert.equal(approvalDecision(prompt, { ownerApproved: true, allowedApps: ['com.apple.TextEdit'] }).allow, true);
  for (const change of [{ button: 'Always Allow' }, { bundleId: 'com.apple.Terminal' }, { source: 'MCP' }, { title: 'Allow shell?' }])
    assert.equal(approvalDecision({ ...prompt, ...change }, { ownerApproved: true, allowedApps: ['com.apple.TextEdit'] }).allow, false);
});

test('source-derived state detection binds prompt, composer, generation, model and persisted end', () => {
  const binding = { prompt: 'Edit the fixture.', submittedAt: 1000, baselineIds: [] };
  const running = detectRun(state(), binding);
  assert.equal(running.started, true); assert.equal(running.ended, false);
  const ended = detectRun(state(true), { ...binding, composerId: running.composerId, generationId: running.generationId });
  assert.equal(ended.endedAt, 1600); assert.equal(ended.answer, 'RESULT: edited'); assert.equal(ended.model.model, 'grok-4.7');
  assert.equal(detectRun(state(true), { ...binding, baselineIds: ['chat-1'] }).started, false);
  assert.throws(() => detectRun({ ...state(), composers: [start(), start({ composerId: 'chat-2' })], bubbles: { 'chat-1': bubbles(), 'chat-2': bubbles() } }, binding), /ambiguous/);
  assert.throws(() => detectRun(state(), { ...binding, composerId: 'chat-1', generationId: 'stale' }), /generation/);
  const noEnd = state(true); delete noEnd.bubbles['chat-1'][1].timingInfo.clientSettleTime;
  assert.equal(detectRun(noEnd, binding).ended, false);
  assert.equal(detectRun(state(true), { ...binding, submittedAt: 1700 }).started, false);
});

test('state reader queries only selected composer and bubble keys with a readonly connection', () => {
  const calls = [];
  const db = { prepare(sql) { calls.push(sql); return { all() {
    return sql.includes('composerData:') ? [{ key: 'composerData:chat-1', value: JSON.stringify(start()) }]
      : [{ key: 'bubbleId:chat-1:human', value: JSON.stringify(bubbles()[0]) }];
  } }; }, close() { calls.push('closed'); } };
  const result = readCursorState(paths(), { exists: () => true, open(file, opts) { assert.equal(opts.readOnly, true); assert.equal(file, paths().database); return db; } });
  assert.equal(result.composers[0].composerId, 'chat-1'); assert.ok(calls.includes('closed'));
  assert.ok(calls.every(sql => !/select \*|cursorAuth|update |insert /i.test(sql)));
});

test('readiness is metadata only and does not claim a token presence proves helper grants', () => {
  const r = loginReadiness({ paths: paths(), authPresent: () => true, ownerSaysCursorFree: true });
  assert.equal(r.loggedIn, 'unverified'); assert.equal(r.authStored, true); assert.equal(r.ready, false);
  assert.ok(r.missing.includes('live helper permissions'));
});

test('default readiness detects a stored auth row without exposing its value', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ca2-auth-'));
  try {
    const p = armPaths({ home: dir }); mkdirSync(join(p.userData, 'User/globalStorage'), { recursive: true });
    const db = new DatabaseSync(p.database);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key,value) VALUES (?,?)').run('cursorAuth/accessToken', 'fixture-value-only');
    db.close();
    const r = loginReadiness({ paths: p, ownerSaysCursorFree: true }); assert.equal(r.authStored, true); assert.equal(r.loggedIn, 'unverified');
    assert.ok(!JSON.stringify(r).includes('fixture-value-only'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live guards refuse owner-present, hold and lock; dry probe does not even inspect them', async () => {
  const calls = [];
  assert.throws(() => guardLive({ ownerSaysCursorFree: true }, { exists: () => { throw Error('must refuse owner first'); } }), /owner-away/);
  assert.throws(() => guardLive({ ownerAway: true, ownerSaysCursorFree: true }, { exists: path => path.endsWith('sleight-hold') }), /hold/);
  assert.throws(() => guardLive({ ownerAway: true, ownerSaysCursorFree: true }, { exists: path => path.endsWith('sleight-live.lock') }), /lock/);
  const dry = await runProbe({ dryRun: true }, { exists: () => assert.fail('dry plan inspected live paths'), run: () => calls.push('run') });
  assert.equal(dry.runs.length, 2); assert.deepEqual(dry.runs.map(r => r.task), ['textedit-edit', 'mdn']); assert.deepEqual(calls, []);
  assert.deepEqual(probePlan().runs.map(r => r.runs), [1, 1]);
});

test('missing calibration blocks before inspection, profile writes or desktop launch', async () => {
  assert.throws(() => assertDesktopReady(paths()), /calibration missing/i);
  const own = { pid: 42, bundleId: CURSOR_PIN.bundleId, executable: paths().app + '/Contents/MacOS/Cursor', launchAt: 1 };
  const driver = new DesktopDriver({ processes: async () => [own], inspect: () => CURSOR_PIN, readiness: async () => ({ authStored: true }),
    ui: { bind: async () => {}, readiness: async () => ({ loggedIn: true, busy: false }) } });
  await assert.rejects(driver.open(plan()), /calibration missing/i);
  assert.equal(probePlan().liveReady, false);
});

function fakeDriver({ cleanup = true, failSetup = false, states = [state(), state(true)] } = {}) {
  let index = 0; const calls = [];
  return { calls, async open() { calls.push('open'); }, async setup() { calls.push('setup'); if (failSetup) throw Error('setup refused'); return { baselineIds: [] }; },
    async submit(p, { onSubmit }) { calls.push('submit'); onSubmit(); }, async readState() { return states[Math.min(index++, states.length - 1)]; },
    async cancel() { calls.push('cancel'); return true; }, async close() { calls.push('close'); return cleanup; } };
}
test('desktop results record exact provenance and timing and preserve owner Cursor', async () => {
  const driver = fakeDriver();
  const r = await runDesktop(plan(), { driver, now: () => 1000, pause: async () => {} });
  assert.equal(r.duration_ms, 600); assert.equal(r.route, 'desktop'); assert.equal(r.cursorVersion, '3.27.12');
  assert.equal(r.agentSeconds, 0.6);
  assert.equal(r.model, 'grok-4.7'); assert.equal(r.effort, 'high'); assert.equal(r.speed, 'normal'); assert.equal(r.groupClean, true);
  assert.equal(r.startDetection, 'persisted human prompt and generation'); assert.equal(r.endDetection, 'persisted clientSettleTime');
  assert.equal(r.usage, null); assert.equal(r.total_cost_usd, null);
  assert.deepEqual(driver.calls, ['open', 'setup', 'submit', 'close']);
});
test('setup failure and cancellation clean up; uncertain cleanup remains failed', async () => {
  const driver = fakeDriver({ failSetup: true }); const failed = await runDesktop(plan(), { driver });
  assert.equal(failed.is_error, true); assert.equal(failed.safetyStop, 'setup refused'); assert.deepEqual(driver.calls, ['open', 'setup', 'close']);
  const cancelled = fakeDriver(); const ctl = new AbortController(); ctl.abort();
  const c = await runDesktop(plan(), { driver: cancelled, signal: ctl.signal }); assert.equal(c.is_error, true); assert.deepEqual(cancelled.calls, []);
  const dirty = await runDesktop(plan(), { driver: fakeDriver({ cleanup: false }), now: () => 1000, pause: async () => {} });
  assert.equal(dirty.is_error, true); assert.equal(dirty.groupClean, false);
});

test('a missing poll cannot discard an established generation binding', async () => {
  const changed = state(true); changed.composers[0].latestChatGenerationUUID = 'turn-2';
  const d = fakeDriver({ states: [state(), { composers: [], bubbles: {} }, changed] });
  const r = await runDesktop(plan(), { driver: d, now: () => 1000, pause: async () => {} });
  assert.equal(r.is_error, true); assert.match(r.reason, /generation/); assert.ok(d.calls.includes('cancel'));
});

test('timing starts at the driver submit callback, after composer checks', async () => {
  let time = 500; const d = fakeDriver();
  d.submit = async (p, { onSubmit }) => { time = 1000; onSubmit(); };
  const r = await runDesktop(plan(), { driver: d, now: () => time, pause: async () => {} });
  assert.equal(r.submittedAt, 1000); assert.equal(r.duration_ms, 600);
});
