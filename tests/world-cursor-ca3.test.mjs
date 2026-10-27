import test from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_PIN, armPaths, composerPlan, approvalDecision } from '../bench/world/arms/cursor-cu/contract.mjs';
import { assertNoForeignCursor, sameLaunch, answerCards } from '../bench/world/arms/cursor-cu/host.mjs';
import { makeCalibration, verifySelection, validateCalibration, calibrationPlan, calibrate } from '../bench/world/arms/cursor-cu/calibrate.mjs';
import { browserEvidence, evidenceProblems } from '../bench/fowl/real-gate-grade.mjs';
import { pendingAppApprovals } from '../bench/world/arms/cursor-cu/state.mjs';

const paths = armPaths({ home: ['', 'Users', 'bench'].join('/') });
const own = { pid: 42, bundleId: CURSOR_PIN.bundleId, executable: paths.app + '/Contents/MacOS/Cursor', launchAt: 1000 };
const config = { selectedModels: [{ modelId: 'account-grok-47', parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] }] };
const composer = () => ({ composerId: 'chat', modelConfig: structuredClone(config), contextAttachments: [{ type: 'computer-use' }], target: { type: 'local' },
  text: 'secret prompt', accessToken: 'SECRET', accountId: 'PRIVATE', unrelated: { password: 'SECRET' } });
const calibration = () => makeCalibration(composer(), { ownerModelLabel: 'Grok 4.7 High', settled: true });

test('installed Cursor must already be running with its exact executable and identity', () => {
  assert.throws(() => assertNoForeignCursor([], paths), /already running/);
  assert.doesNotThrow(() => assertNoForeignCursor([own], paths, own));
  assert.throws(() => assertNoForeignCursor([{ ...own, executable: '/scratch/Cursor.app/Contents/MacOS/Cursor' }], paths), /installed/);
  assert.throws(() => assertNoForeignCursor([{ ...own, pid: 43 }], paths, own), /changed/);
  assert.equal(sameLaunch({}, {}), false);
});

test('calibration saves shapes and exact selection without private values', () => {
  const c = calibration(), text = JSON.stringify(c);
  validateCalibration(c);
  assert.equal(c.selection.model.model, 'account-grok-47');
  for (const secret of ['SECRET', 'PRIVATE', 'secret prompt', 'chat']) assert.ok(!text.includes('"' + secret + '"'), secret);
  assert.equal(c.selection.attachment.value, 'computer-use');
  assert.equal(c.selection.target.value, 'local');
  assert.throws(() => makeCalibration(composer(), { settled: false }), /settled/);
  assert.throws(() => validateCalibration({ ...c, pin: { ...c.pin, version: 'other' } }), /pin/);
  assert.throws(() => validateCalibration({ ...c, accessToken: 'SECRET' }), /shape/);
  assert.throws(() => validateCalibration({ ...c, selection: { ...c.selection, target: { path: ['text'], value: 'local' } } }), /marker/);
});

test('selection check compares calibrated id, high effort, fast off, attachment and local target', () => {
  const c = calibration();
  assert.equal(verifySelection(composer(), c).model, 'account-grok-47');
  for (const [field, mutate] of [
    ['model', x => x.modelConfig.selectedModels[0].modelId = 'auto'],
    ['effort', x => x.modelConfig.selectedModels[0].parameters[0].value = 'low'],
    ['fast', x => x.modelConfig.selectedModels[0].parameters[1].value = 'true'],
    ['attachment', x => x.contextAttachments = []], ['target', x => x.target.type = 'cloud'],
  ]) { const x = composer(); mutate(x); assert.throws(() => verifySelection(x, c), new RegExp(field)); }
});

test('calibration dry run is print-only, including no host discovery or lock reads', async () => {
  const p = await calibrate({ dryRun: true }, { driver: new Proxy({}, { get() { assert.fail('driver accessed'); } }) });
  assert.deepEqual(p, calibrationPlan());
  assert.ok(p.ownerSteps.some(s => s.includes('Say ready.')));
});

test('supervised calibration binds the harmless settled turn, scrubs, restores and saves after clean collection', async () => {
  for (const clean of [true, false]) {
    const calls = [], c = { ...composer(), status: 'completed', latestChatGenerationUUID: 'turn', generatingBubbleIds: [],
      fullConversationHeadersOnly: [{ bubbleId: 'human' }, { bubbleId: 'answer' }] };
    const d = { preflight: async () => calls.push('preflight'), open: async () => calls.push('open'), foreignGuard: async () => {},
      readState: async () => ({ composers: [c], bubbles: { chat: [{ bubbleId: 'human', type: 1, text: 'Say ready.' },
        { bubbleId: 'answer', type: 2, text: 'ready', timingInfo: { clientStartTime: 1100, clientSettleTime: 1600 } }] } }),
      setupCalibration: async () => ({ baselineIds: [] }), verifyCalibrationUI: async () => {}, close: async () => { calls.push('close'); return clean; } };
    const options = { driver: d, exists: () => false, now: () => 1000, guard: () => {}, print: () => {},
      lock: async () => { calls.push('lock'); return () => calls.push('release'); },
      save: (file, text) => { calls.push('save'); assert.ok(file.endsWith('/calibration.json')); assert.ok(!text.includes('SECRET')); } };
    if (clean) { const out = await calibrate({ ownerSaysCursorFree: true }, options); assert.equal(out.selection.model.model, 'account-grok-47'); }
    else await assert.rejects(calibrate({ ownerSaysCursorFree: true }, options), /cleanup unverified/);
    assert.deepEqual(calls, ['preflight', 'lock', 'open', 'close', ...(clean ? ['release', 'save'] : [])]);
  }
});

const card = () => ({ owner: own, title: 'Allow Cursor to use TextEdit?', name: 'TextEdit', bundleId: 'com.apple.TextEdit',
  source: 'Computer Use', button: 'Allow in this chat', id: 'card-1' });
const requests = [{ name: 'TextEdit', bundleId: 'com.apple.TextEdit', toolCallId: 'request', generationId: 'turn' }];
test('cards default on and press only exact session button on task and benchmark app list', async () => {
  const plan = composerPlan({ prompt: 'Edit.', paths, allowedApps: ['com.apple.TextEdit'] });
  assert.equal(plan.allowBenchmarkAppPrompts, true);
  const calls = [], ax = { read: async () => [card()], press: async c => calls.push(c) };
  await answerCards(plan, [own], ax, requests);
  assert.equal(calls.length, 1); assert.equal(calls[0].button, 'Allow in this chat');
  for (const change of [{ bundleId: 'com.apple.Terminal' }, { button: 'Always Allow' }, { button: 'Allow once' }, { owner: { ...own, launchAt: 2 } }, { title: 'Allow shell?' }]) {
    const fake = { read: async () => [{ ...card(), ...change }], press: async () => assert.fail('unsafe press') };
    await assert.rejects(answerCards(plan, [own], fake, requests), /approval stop/);
  }
  await assert.rejects(answerCards({ ...plan, allowBenchmarkAppPrompts: false }, [own], ax, requests), /approval stop/);
  await assert.rejects(answerCards({ ...plan, allowedApps: [] }, [own], ax, requests), /approval stop/);
  await assert.rejects(answerCards(plan, [own], ax), /approval stop/);
  await assert.rejects(answerCards(plan, [own], ax, [{ ...requests[0], bundleId: 'impostor.TextEdit' }]), /approval stop/);
  assert.equal(approvalDecision(card(), { ownerApproved: true, allowedApps: plan.allowedApps }).allow, true);
});

test('pending approval metadata binds the target bundle to the latest turn and excludes completed rows', () => {
  const pending = { toolCallId: 'request', status: 'needs_user_approval', additionalData: { computerUseApp: { name: 'TextEdit', bundleId: 'com.apple.TextEdit' } } };
  const bubbles = [{ bubbleId: 'old', type: 2, toolFormerData: pending }, { bubbleId: 'human', type: 1 }, { bubbleId: 'new', type: 2, toolFormerData: pending }];
  const snapshot = { composers: [{ composerId: 'chat', latestChatGenerationUUID: 'turn', fullConversationHeadersOnly: bubbles.map(b => ({ bubbleId: b.bubbleId })) }], bubbles: { chat: bubbles } };
  assert.deepEqual(pendingAppApprovals(snapshot, 'chat'), requests);
  snapshot.bubbles.chat[2].toolFormerData = { ...pending, status: 'completed' };
  assert.deepEqual(pendingAppApprovals(snapshot, 'chat'), []);
  assert.deepEqual(pendingAppApprovals(snapshot, 'other'), []);
});

test('Cursor transcript evidence counts completed browser computer calls once across polls', () => {
  const event = { type: 'cursor_state', composerId: 'chat', generationId: 'turn', tools: [
    { toolCallId: 'ok', tool: 'computer_use', status: 'completed', params: { actions: [{ app: 'com.google.Chrome', url: 'https://developer.mozilla.org/en-US/' }] }, result: { success: true } },
    { toolCallId: 'bad', tool: 'computer_use', status: 'error', params: { app: 'com.google.Chrome' } },
    { toolCallId: 'shell', tool: 'shell', status: 'completed', result: { text: 'https://wikipedia.org/' } },
  ] };
  const text = [event, event].map(JSON.stringify).join('\n'), e = browserEvidence(text);
  assert.equal(e.successfulCalls, 1); assert.deepEqual(e.urls, ['https://developer.mozilla.org/en-US/']);
  assert.deepEqual(evidenceProblems({ task: { name: 'mdn' }, evidence: e, visits: null }), []);
  const unknown = structuredClone(event); delete unknown.tools[0].result;
  assert.equal(browserEvidence(JSON.stringify(unknown)).successfulCalls, 0);
});

test('Cursor MCP provider and wire computer-use results require success and explicit browser binding', () => {
  const event = tools => JSON.stringify({ type: 'cursor_state', composerId: 'chat', generationId: 'turn', tools });
  const tool = { toolCallId: 'mcp-1', status: 'completed', params: { providerIdentifier: 'cursor-computer-use', toolName: 'get_app_state', app: 'com.google.Chrome' },
    result: { content: [{ type: 'text', text: 'https://wikipedia.org/wiki/Kilimanjaro' }], isError: false } };
  assert.equal(browserEvidence(event([tool])).successfulCalls, 1);
  for (const result of [{ isError: true }, { success: false }, null]) assert.equal(browserEvidence(event([{ ...tool, result }])).successfulCalls, 0);
  assert.equal(browserEvidence(event([{ ...tool, params: { ...tool.params, app: 'com.apple.TextEdit' } }])).successfulCalls, 0);
  assert.equal(browserEvidence(event([{ ...tool, params: { ...tool.params, app: 'com.apple.TextEdit', url: 'https://example.com/com.google.Chrome' }, result: { text: 'Google Chrome com.google.Chrome' } }])).successfulCalls, 0);
  const wire = { toolCallId: 'wire', toolCall: { tool: { case: 'computerUseToolCall', value: {
    args: { actions: [{ app: 'com.google.Chrome' }] }, result: { result: { case: 'success', value: {} } },
  } } } };
  assert.equal(browserEvidence(event([wire])).successfulCalls, 1);
});
