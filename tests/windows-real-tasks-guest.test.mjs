import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMcpSession, runGuestTasks, taskCode, gradeTask } from '../bench/windows/real-tasks-guest.mjs';

const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const fixture = { line: 'WRT1 known line', filename: 'wrt1-known-file.txt', folder: 'wrt1-files',
  notepad: 'wrt1-note.txt', edgeTitle: 'Sleight WDR7 page' };

test('model cells use documented cua calls and do not bypass admission or perform shell input', () => {
  for (const id of ['notepad', 'explorer', 'edge', 'blocked-app', 'approval']) {
    const code = taskCode(id, fixture);
    assert.match(code, /cua\.getApp/);
    assert.doesNotMatch(code, /child_process|SendInput|SendKeys|fetch\(|process\.|require\(|import\(/);
  }
  assert.match(taskCode('notepad', fixture), /typeText/);
  assert.match(taskCode('notepad', fixture), /performSecondaryAction\(\{ id: "File" \}, "Expand"\)/);
  assert.doesNotMatch(taskCode('notepad', fixture), /pressKey/);
  assert.doesNotMatch(taskCode('blocked-app', fixture), /\.typeText|\.pressKey|\.click/);
});

test('Notepad acquisition works before inventory titles and images become approved', async () => {
  const calls = [];
  let expanded = false;
  const app = { getAXState: async () => `Window: "${fixture.notepad} - Notepad", App: notepad.exe.\n\t2 text entry area Text Editor (focused)` +
      (expanded ? '\n\t40 menu item Save as\n\t41 menu item Save, Secondary Actions: Invoke' : ''),
    click: async n => calls.push(['click', n]), typeText: async text => calls.push(['typeText', text]),
    performSecondaryAction: async (target, action) => { calls.push(['action', target, action]); if (action === 'Expand') expanded = true; },
    pressKey: async key => calls.push(['pressKey', key]) };
  const cua = { getState: async () => ({ windows: [{ windowId: '100', app: 'Notepad', title: null, image: null }] }),
    getApp: async selector => { assert.equal(selector, 'Notepad'); return app; } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('cua', taskCode('notepad', fixture))(cua);
  assert.deepEqual(calls, [['typeText', fixture.line], ['action', { id: 'File' }, 'Expand'], ['action', 41, 'Invoke']]);
});

test('Notepad types only into an editor the tree shows as focused', async () => {
  const app = { getAXState: async () => `Window: "${fixture.notepad} - Notepad", App: notepad.exe.\n\t2 text entry area Text Editor`,
    typeText: async () => assert.fail('typed into an unfocused editor') };
  const cua = { getApp: async () => app };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await assert.rejects(new AsyncFunction('cua', taskCode('notepad', fixture))(cua), /NOTE_EDITOR_NOT_FOCUSED/);
});

test('Notepad refuses input when the acquired window is not the named fixture', async () => {
  const cua = { getApp: async () => ({ getAXState: async () => 'Window: "personal.txt - Notepad"\n\t2 text entry area editor',
    click: async () => assert.fail('wrong document received input') }) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await assert.rejects(new AsyncFunction('cua', taskCode('notepad', fixture))(cua), /NOTE_WINDOW_MISMATCH/);
});

test('file checks and actual tree replies decide the task, not an echoed model marker', () => {
  assert.equal(gradeTask('notepad', reply('saved'), { saved: fixture.line, ...fixture }).status, 'pass');
  assert.equal(gradeTask('notepad', reply('saved'), { saved: '', ...fixture }).status, 'fail');
  assert.equal(gradeTask('notepad', reply('error', true), { saved: fixture.line, ...fixture }).status, 'fail');
  assert.equal(gradeTask('explorer', reply('Window: "wrt1-files"\n\t3 list item wrt1-known-file.txt'), fixture).status, 'pass');
  assert.equal(gradeTask('explorer', reply('wrt1-known-file.txt'), fixture).status, 'fail');
  assert.equal(gradeTask('edge', reply('Window: "Sleight WDR7 page - Microsoft Edge", App: msedge.exe.\n0 window'), fixture).status, 'fail');
  assert.equal(gradeTask('edge', reply('sleight: BROWSER_TARGET_REFUSED: browser refused', true), fixture).status, 'pass');
  assert.equal(gradeTask('edge', reply('WINDOW_NOT_FOUND: WINDOW_NOT_FOUND', true), fixture).status, 'fail');
});

test('forbidden and approval checks require refusal evidence and never accept a missing window', () => {
  // Parent admission emits CODE: message without the native formatter's prefix.
  assert.equal(gradeTask('blocked-app', reply('FORBIDDEN_TARGET: FORBIDDEN_TARGET', true), fixture).status, 'pass');
  assert.equal(gradeTask('blocked-app', reply('sleight: FORBIDDEN_TARGET: This app is not allowed.', true), fixture).status, 'pass');
  assert.equal(gradeTask('blocked-app', reply('WINDOW_NOT_FOUND', true), fixture).status, 'fail');
  assert.equal(gradeTask('blocked-app', reply('FORBIDDEN_TARGET'), fixture).status, 'fail');
  const denied = [{ task: 'approval', action: 'decline', app: 'charmap.exe' }];
  assert.equal(gradeTask('approval', reply('APP_DECLINED: APP_DECLINED', true), { ...fixture, approvals: denied }).status, 'pass');
  assert.equal(gradeTask('approval', reply('sleight: APP_DECLINED: The user declined.', true), { ...fixture, approvals: denied }).status, 'pass');
  assert.equal(gradeTask('approval', reply('sleight: APP_DECLINED: The user declined.', true), { ...fixture, approvals: [] }).status, 'fail');
});

test('guest runs five real MCP task cells once and leaves hardware Escape owner-present', async () => {
  const calls = [];
  const session = { approvals: [], async request(method, params) { calls.push([method, params]); return reply('not verified', true); },
    setTask(id) { calls.push(['task', id]); }, async close() { calls.push(['close']); } };
  const result = await runGuestTasks({ token: 'a'.repeat(16), commit: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), fixture },
    { session, now: () => 1, readSaved: () => '' });
  assert.equal(result.tasks.length, 6);
  // Two diagnostic reads, then one cell per task: each fails here, so Notepad stops after its first step.
  const js = calls.filter(c => c[0] === 'tools/call' && c[1].name === 'js');
  assert.equal(js.length, 7);
  for (const diagnostic of js.slice(0, 2)) {
    assert.match(diagnostic[1].arguments.code, /cua\.getState\(\)/);
    assert.doesNotMatch(diagnostic[1].arguments.code, /\.click|\.typeText|\.pressKey|\.setValue|\.paste|performSecondaryAction|\.scroll|\.drag/);
  }
  assert.equal(result.tasks.at(-1).reason, 'OWNER_PRESENT_REQUIRED: physical Escape ignores injected input');
  assert.equal(result.tasks.at(-1).evidence.ownerPresentRequired, true);
  assert.equal(calls.at(-1)[0], 'close');
});

function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const messages = [];
  child.stdin.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) messages.push(JSON.parse(line)); });
  child.stdin.on('finish', () => child.emit('close', 0));
  return { child, messages, send: message => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') };
}

test('stdio client matches response IDs and answers only explicit session fixture approvals', async () => {
  const f = fakeChild(); let launch;
  const session = createMcpSession({ allowFixtureApprovals: true, spawnChild: (...args) => { launch = args; return f.child; } });
  session.setTask('notepad');
  const pending = session.request('tools/call', { name: 'js', arguments: { code: 'await cua.getApp("Notepad")' } });
  f.send({ id: 'card-1', method: 'elicitation/create', params: { mode: 'form', _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'Notepad.exe' } } } });
  f.send({ id: 'card-2', method: 'elicitation/create', params: { mode: 'form', _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'CalculatorApp.exe' } } } });
  f.send({ id: f.messages[0].id, result: reply('tree') });
  assert.equal((await pending).content[0].text, 'tree');
  assert.equal(f.messages.find(m => m.id === 'card-1').result.action, 'accept');
  assert.equal(f.messages.find(m => m.id === 'card-2').result.action, 'decline');
  assert.match(launch[1][0], /plugins[\\/]sleight[\\/]lib[\\/]launch\.mjs$/);
  assert.equal(launch[2].shell, false);
  assert.equal(launch[2].env.SLEIGHT_ALLOW_FORBIDDEN_TARGETS, undefined);
  assert.equal(session.approvals.length, 2);
  await session.close();
});

test('stdio default declines, timeout cancels without killing guest processes', async () => {
  const f = fakeChild();
  const session = createMcpSession({ spawnChild: () => f.child, timeoutMs: 5 });
  session.setTask('approval');
  const pending = session.request('tools/call', { name: 'js', arguments: { code: 'await cua.getApp("Calculator")' } });
  f.send({ id: 'c', method: 'elicitation/create', params: { mode: 'form', _meta: { tool_params: { app: 'CalculatorApp.exe' } } } });
  await assert.rejects(pending, /MCP_TIMEOUT/);
  assert.equal(f.messages.find(m => m.id === 'c').result.action, 'decline');
  assert.equal(f.messages.at(-1).method, 'notifications/cancelled');
  assert.equal(f.child.listenerCount('error') > 0, true);
  await session.close();
});

test('stdio close and malformed output have bounded failures without guest signals', async () => {
  const f = fakeChild();
  // Keep this fake alive after EOF to exercise the non-signaling close bound.
  f.child.stdin.removeAllListeners('finish');
  const session = createMcpSession({ spawnChild: () => f.child, closeMs: 5 });
  const pending = session.request('ping');
  f.child.stdout.write('not-json\n');
  await assert.rejects(pending, /MCP_PROTOCOL/);
  await assert.rejects(session.close(), /MCP_CLOSE_TIMEOUT/);
});

test('late fixture cards after the request timed out cannot grant session access', async () => {
  const f = fakeChild();
  const session = createMcpSession({ spawnChild: () => f.child, timeoutMs: 5, allowFixtureApprovals: true });
  session.setTask('notepad');
  await assert.rejects(session.request('tools/call', { name: 'js', arguments: { code: 'await cua.getApp("Notepad")' } }), /MCP_TIMEOUT/);
  f.send({ id: 'late', method: 'elicitation/create', params: { mode: 'form', _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'Notepad.exe' } } } });
  assert.equal(f.messages.find(m => m.id === 'late').result.action, 'decline');
  await session.close();
});

test('guest stops after a broken transport instead of retrying cells or continuing unknown input', async () => {
  const methods = [];
  const session = { approvals: [], setTask() {}, async close() {}, async request(method, params) {
    methods.push([method, params]);
    if (method === 'tools/list') return { tools: [{ name: 'js' }] };
    if (method === 'tools/call') throw Error('MCP_TIMEOUT');
    return {};
  } };
  const r = await runGuestTasks({ fixture }, { session, now: () => 1 });
  assert.equal(methods.filter(([m, p]) => m === 'tools/call' && p.name === 'js').length, 1);
  assert.equal(r.tasks.filter(t => t.status === 'fail').length, 6);
  assert.equal(r.error, 'MCP_TIMEOUT');
});

test('Explorer is acquired by executable and must be the fixture folder', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const code = taskCode('explorer', fixture);
  assert.match(code, /getApp\("explorer\.exe"\)/);
  const ok = { getApp: async () => ({ getAXState: async () => `Window: "${fixture.folder}", App: explorer.exe.\n\t3 list item ${fixture.filename}` }) };
  await new AsyncFunction('cua', code)(ok);
  const other = { getApp: async () => ({ getAXState: async () => 'Window: "Documents", App: explorer.exe.' }) };
  await assert.rejects(new AsyncFunction('cua', code)(other), /FOLDER_WINDOW_MISMATCH/);
});

test('Explorer rows may hide the known extension, but a longer name does not count', () => {
  const ctx = { ...fixture };
  assert.equal(gradeTask('explorer', reply('Window: "wrt1-files", App: explorer.\n\t41 list item wrt1-known-file, ID: 0, Value: wrt1-known-file'), ctx).status, 'pass');
  assert.equal(gradeTask('explorer', reply('Window: "wrt1-files", App: explorer.\n\t41 list item wrt1-known-file-old, ID: 0'), ctx).status, 'fail');
});

test('an identity refusal repeats that step once, as the API text tells a model', async () => {
  const calls = [];
  let first = true;
  const session = { approvals: [], setTask() {}, async close() {},
    async request(method, params) {
      calls.push([method, params]);
      if (method !== 'tools/call' || params.name !== 'js') return {};
      if (/explorer\.exe/.test(params.arguments.code) && first) { first = false; return reply('IDENTITY_CHANGED: IDENTITY_CHANGED', true); }
      return reply('not verified', true);
    } };
  await runGuestTasks({ token: 'a'.repeat(16), commit: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), fixture },
    { session, now: () => 1, readSaved: () => '' });
  const explorer = calls.filter(c => c[0] === 'tools/call' && /explorer\.exe/.test(c[1]?.arguments?.code ?? ''));
  assert.equal(explorer.length, 2);
});
