import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { approvalButton, callBlockedApp, isSettingsTitle, loadBlockedAppsFlag, matchBlockedApp,
  refusedApp, SETTINGS_TITLE, terminalSend } from '../plugins/sleight/lib/blocked-apps.mjs';

// ---- The opt-in flag file ------------------------------------------------

const user = { uid: 501 };
const file = (io, content, mode = 0o600) => {
  io.lstatSync = () => ({ isSymbolicLink: () => false, isFile: () => true, uid: 501, mode });
  io.readFileSync = () => content;
  io.statSync = () => ({ isFile: () => true });
};

test('the flag file opts the feature in only when it is a trusted {"version": 1}', () => {
  const missing = {};
  missing.lstatSync = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  assert.equal(loadBlockedAppsFlag(missing), false, 'missing file is off');
  const valid = {};
  file(valid, '{"version": 1}');
  assert.equal(loadBlockedAppsFlag(valid), true);
});

test('the flag file refuses anything short of a user-owned, private, regular file', () => {
  const checks = [
    ['symlink', io => { io.lstatSync = () => ({ isSymbolicLink: () => true }); }],
    ['not a regular file', io => { io.lstatSync = () => ({ isSymbolicLink: () => false, isFile: () => false }); }],
    ['other owner', io => { io.lstatSync = () => ({ isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: 0o600 }); }],
    ['group-writable', io => file(io, '{"version": 1}', 0o660)],
  ];
  for (const [label, setup] of checks) {
    const io = {};
    setup(io);
    assert.throws(() => loadBlockedAppsFlag(io), /Blocked apps:/, label);
  }
});

test('the flag file content is exactly {"version": 1}', () => {
  for (const content of ['{}', '{"version": 2}', '{"version": 1, "apps": []}', 'not json', '[]']) {
    const io = {};
    file(io, content);
    assert.throws(() => loadBlockedAppsFlag(io), /Blocked apps:/, content);
  }
  const io = {};
  file(io, '{"version": 1}');
  io.statSync = () => { throw new Error('gone'); };
  assert.throws(() => loadBlockedAppsFlag(io), /changed while reading/);
});

// ---- What the engine refuses, and what sleight does about it -------------

test('the refused list matches terminals and OpenAI apps by bundle, name or path', () => {
  assert.deepEqual(matchBlockedApp('Terminal'), { name: 'Terminal', terminal: true });
  assert.deepEqual(matchBlockedApp('iTerm'), { name: 'iTerm2', terminal: true });
  assert.deepEqual(matchBlockedApp('/Applications/iTerm.app'), { name: 'iTerm2', terminal: true });
  assert.deepEqual(matchBlockedApp('chatgpt'), { name: 'ChatGPT', openai: true });
  assert.deepEqual(matchBlockedApp('ChatGPT Beta'), { name: 'ChatGPT', openai: true });
  assert.deepEqual(matchBlockedApp('whatever', 'com.openai.codex'), { name: 'com.openai.codex', openai: true });
  assert.equal(matchBlockedApp('whatever', 'com.openai.chat.beta').openai, true);
  assert.equal(matchBlockedApp('Mail', 'com.apple.mail'), undefined);
  assert.equal(matchBlockedApp('Calculator', 'com.apple.calculator'), undefined);
});

test('the engine refusal is recognized verbatim, with the refused identifier', () => {
  assert.equal(refusedApp("Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons."), 'com.apple.Terminal');
  assert.equal(refusedApp('some other failure'), undefined);
});

test('settings and preferences windows are recognized for refusal', () => {
  assert.equal(isSettingsTitle('Settings'), true);
  assert.equal(isSettingsTitle('Preferences…'), true);
  assert.equal(isSettingsTitle('settings'), true);
  assert.equal(isSettingsTitle('Réglages'), true);
  assert.equal(isSettingsTitle('Codex — chat'), false);
  assert.equal(SETTINGS_TITLE.source.length > 10, true);
});

test('only approval-like buttons are named in results', () => {
  assert.equal(approvalButton('Approve'), 'approve');
  assert.equal(approvalButton('Allow Once'), 'allow');
  assert.equal(approvalButton('Run command'), 'run');
  assert.equal(approvalButton('Accept all'), 'accept');
  assert.equal(approvalButton('Cancel'), undefined);
  assert.equal(approvalButton(''), undefined);
});

test('terminal sends that can run a command ask; reads, scrolls and inert keys do not', () => {
  assert.equal(terminalSend({ op: 'type', text: 'echo sleight\n' }), 'echo sleight\n');
  assert.equal(terminalSend({ op: 'key', key: 'Return' }), 'key Return');
  assert.equal(terminalSend({ op: 'key', key: 'Enter' }), 'key Enter');
  assert.equal(terminalSend({ op: 'key', key: 'super+v' }), 'key super+v');
  assert.equal(terminalSend({ op: 'key', key: 'Tab' }), undefined);
  assert.equal(terminalSend({ op: 'key', key: 'super+c' }), undefined);
  assert.equal(terminalSend({ op: 'read' }), undefined);
  assert.equal(terminalSend({ op: 'scroll', amount: 3 }), undefined);
  assert.equal(terminalSend({ op: 'type' }), undefined);
});

// ---- callBlockedApp: consent, per-send prompts, result notes -------------

const base = (over = {}) => ({
  target: { appId: 'com.apple.Terminal', app: 'Terminal', title: null, url: null },
  shot: '/tmp/shot.png',
  ...over,
});

test('a non-refused app is refused before anything is asked or run', async () => {
  let asked = 0;
  const result = await callBlockedApp({ op: 'read', app: 'Calculator' }, base({
    target: { appId: 'com.apple.calculator', app: 'Calculator', title: null, url: null },
    approve: async () => { asked++; return true; },
    run: async () => { throw new Error('must not run'); },
  }));
  assert.equal(asked, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /only drives the apps the engine refuses/);
});

test('consent asks plainly, and a decline stops everything', async () => {
  const approvals = [];
  const run = async () => { throw new Error('must not run'); };
  const declined = await callBlockedApp({ op: 'read', app: 'Codex' }, base({
    target: { appId: 'com.openai.codex', app: 'ChatGPT', title: null, url: null },
    approve: async (parts, message, options) => { approvals.push([parts, message, options]); return false; },
    run,
  }));
  assert.equal(declined.isError, true);
  assert.match(declined.content[0].text, /didn't allow Claude to drive ChatGPT/);
  assert.deepEqual(approvals[0][0], ['blocked_app', 'com.openai.codex']);
  assert.match(approvals[0][1], /^Allow Claude to drive ChatGPT through Accessibility\?$/);
  assert.equal(approvals[0][2].kind, 'blocked');
  assert.equal(approvals[0][2].detail, 'Claude will be able to click in ChatGPT, including approval buttons, for the rest of this session.');
  assert.equal(approvals[0][2].once, undefined, 'the app consent is remembered by the relay like other app approvals');
});

test('terminal consent says what it allows and every send asks again with the exact text', async () => {
  const approvals = [];
  const ok = async (parts, message, options) => { approvals.push([parts, message, options]); return true; };
  const runs = [];
  const first = await callBlockedApp({ op: 'read', app: 'Terminal' }, base({ approve: ok, run: async req => { runs.push(req); return { ok: true, app: 'Terminal' }; } }));
  assert.equal(first.isError, undefined);
  assert.equal(approvals.length, 1, 'a read needs only the app consent');
  assert.match(approvals[0][2].detail, /read, click and type in Terminal, including running commands/);
  assert.match(approvals[0][2].detail, /Every command send is shown to you first\./);

  await callBlockedApp({ op: 'type', app: 'Terminal', text: 'echo sleight\n' }, base({ approve: ok, run: async req => { runs.push(req); return { ok: true, app: 'Terminal', typed: 13 }; } }));
  assert.equal(approvals.length, 3);
  assert.equal(approvals[1][2].once, undefined, 'the consent for the second call is remembered by the relay, not here');
  assert.deepEqual(approvals[2][0], ['blocked_app_send', 'com.apple.Terminal']);
  assert.equal(approvals[2][2].once, true, 'sends are never remembered');
  assert.equal(approvals[2][2].kind, 'flow');
  assert.match(approvals[2][2].detail, /"echo sleight\\n"/);
  assert.deepEqual(runs[1].settings, SETTINGS_TITLE.source);
});

test('a declined send stops before the driver, and inert keys send without asking', async () => {
  const approvals = [];
  const runs = [];
  const okThenNo = async (parts, message, options) => {
    approvals.push([parts, options]);
    return approvals.length < 2;
  };
  const stopped = await callBlockedApp({ op: 'key', app: 'Terminal', key: 'Return' }, base({
    approve: okThenNo, run: async () => { throw new Error('must not run'); } }));
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /didn't allow this send to Terminal/);
  assert.equal(approvals.length, 2);

  approvals.length = 0;
  const tabs = [];
  await callBlockedApp({ op: 'key', app: 'Terminal', key: 'Tab' }, base({
    approve: async (parts, message, options) => { tabs.push([parts, options]); return true; },
    run: async req => { runs.push(req); return { ok: true }; } }));
  assert.equal(tabs.length, 1, 'Tab cannot run a command, so no send prompt');
  assert.equal(tabs[0][1].once, undefined);
});

test('results carry the foreground note, the screenshot path and the approval-button name', async () => {
  const result = await callBlockedApp({ op: 'click', app: 'Codex', element: 12 }, base({
    target: { appId: 'com.openai.codex', app: 'ChatGPT', title: null, url: null },
    approve: async () => true,
    run: async () => ({ ok: true, app: 'ChatGPT', clicked: 12, via: 'AXPress', fronted: true, putBack: 'iTerm2',
      clickedLabel: 'Approve all', clickedRole: 'Button', shot: '/tmp/shot.png' }),
  }));
  const text = result.content[0].text;
  assert.match(text, /Clicked.*"approve"/i);
  assert.match(text, /ChatGPT came to the front for this action and iTerm2 went back\./);
  assert.match(text, /screenshot saved at \/tmp\/shot\.png/i);
  assert.match(text, /"clicked": 12/);
});

test('driver failures and settings refusals come back as errors', async () => {
  const failed = await callBlockedApp({ op: 'read', app: 'Terminal' }, base({
    approve: async () => true,
    run: async () => ({ ok: false, error: 'Terminal has no open window' }),
  }));
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /no open window/);
  const settings = await callBlockedApp({ op: 'read', app: 'Terminal' }, base({
    approve: async () => true,
    run: async () => ({ ok: false, error: 'refused: "Settings" is a settings or preferences window', settings: true }),
  }));
  assert.match(settings.content[0].text, /never drives these apps' settings windows/);
});

// ---- Relay: opt-in gating, refusal notes, flow rules, leases --------------

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const refusalText = "Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.";

function harness(options = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toServer = [];
  const toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', ...options });
  return {
    relay, toServer, toClient,
    fromClient: msg => clientIn.write(JSON.stringify(msg) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
  };
}

const blockedTool = (calls, answers = ['accept']) => ({
  tools: [{ name: 'blocked_app', description: 'local', inputSchema: { type: 'object' } }],
  call: async (name, args, approve) => {
    calls.push({ name, args });
    const ok = await approve(['blocked_app', 'com.apple.Terminal'], 'Allow Claude to drive Terminal through Accessibility?', { kind: 'blocked', detail: 'consent' });
    if (!ok) return { content: [{ type: 'text', text: 'declined' }], isError: true };
    return { content: [{ type: 'text', text: `did ${args.op}` }] };
  },
});

test('an engine refusal offers blocked_app only when the user opted in', async () => {
  for (const enabled of [true, false]) {
    const h = harness({ blockedApps: enabled, ask: async () => 'accept', localTools: blockedTool([]) });
    h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("Terminal")' } } });
    h.fromServer({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: refusalText }] } });
    await tick();
    const texts = h.toClient[0].result.content.map(c => c.text).join('\n');
    if (enabled) {
      assert.match(texts, /refuses com\.apple\.Terminal before any approval/);
      assert.match(texts, /blocked_app/);
      assert.match(texts, /Ask the user, then use blocked_app/);
    } else {
      assert.doesNotMatch(texts, /blocked_app tool/);
    }
  }
});

test('an opt-in refusal note does not change results without the refusal', async () => {
  const h = harness({ blockedApps: true, ask: async () => 'accept', localTools: blockedTool([]) });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Window: "a.txt", App: TextEdit' }] } });
  await tick();
  assert.equal(h.toClient[0].result.content.length, 1);
});

test('blocked_app consent is remembered when accepted, and a decline is never remembered', async () => {
  const asked = [];
  const calls = [];
  const h = harness({ ask: async (message, scoped, options) => { asked.push([message, scoped, options]); return asked.length === 1 ? 'decline' : 'accept'; },
    localTools: blockedTool(calls) });
  const call = id => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'blocked_app', arguments: { op: 'read', app: 'Terminal' } } });
  call(1); await settle();
  assert.equal(h.toClient.find(m => m.id === 1).result.isError, true, 'a decline refuses the call');
  call(2); await settle();
  assert.equal(asked.length, 2, 'a decline is asked again');
  assert.equal(h.toClient.find(m => m.id === 2).result.isError, undefined);
  call(3); await settle();
  assert.equal(asked.length, 2, 'the accept is remembered for the session');
  assert.equal(asked[0][2].kind, 'blocked');

  const once = harness({ ask: async (message, scoped, options) => { asked.push([message, scoped, options]); return true; },
    localTools: { tools: [{ name: 'blocked_app' }], call: async (name, args, approve) => {
      for (let i = 0; i < 3; i++) await approve(['blocked_app_send', 'com.apple.Terminal'], 'Allow Claude to send this to Terminal once?', { once: true, kind: 'flow', detail: 'x' });
      return { content: [{ type: 'text', text: 'sent' }] };
    } } });
  once.fromClient({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'blocked_app', arguments: { op: 'type', app: 'Terminal', text: 'echo hi' } } });
  await settle();
  const sends = asked.filter(a => /send this to Terminal once\?/.test(a[0]));
  assert.equal(sends.length, 3, 'a per-send ask is never remembered');
  assert.deepEqual(sends.map(s => s[1]), [false, false, false], 'no send ask is ever session-scoped');
});

test('flow rules inspect blocked_app text before any consent, prompt or effect', async () => {
  const calls = [];
  const prompts = [];
  const h = harness({
    flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async (...args) => { prompts.push(args); return 'accept'; },
    localTools: blockedTool(calls),
  });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'blocked_app', arguments: { op: 'type', app: 'Terminal', text: 'echo SECRET' } } });
  await settle();
  assert.equal(calls.length, 0, 'nothing ran');
  assert.equal(h.toServer.length, 0);
  assert.match(h.toClient[0].result.content[0].text, /rule 'private' stopped a transfer/);
  assert.match(h.toClient[0].result.content[0].text, /flow_exception/);
  assert.equal(prompts.length, 0, 'no consent was asked either');

  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flow_exception', arguments: {} } });
  await settle();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][2].kind, 'flow');
  assert.match(prompts[0][2].detail, /echo SECRET/);
  h.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'blocked_app', arguments: { op: 'type', app: 'Terminal', text: 'echo SECRET' } } });
  await settle();
  assert.deepEqual(calls.map(c => c.args.text), ['echo SECRET'], 'one identical retry is allowed');
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'blocked_app', arguments: { op: 'type', app: 'Terminal', text: 'echo SECRET' } } });
  await settle();
  assert.equal(calls.length, 1, 'a third identical call cancels the exception');
});

function leaseSetup(t, options = {}, directory = mkdtempSync(join(tmpdir(), 'sleight-blocked-lease-'))) {
  const calls = [];
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toServer = [];
  const toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const inputLease = new InputLease({ directory, holder: options.holder ?? 'session A' });
  const relay = createRelay({
    clientIn, clientOut, serverIn, serverOut, sessionId: options.holder ?? 'A', inputLease,
    blockedApps: true, ask: async () => 'accept',
    localTools: {
      tools: [{ name: 'blocked_app' }],
      target: async () => ({ appId: 'com.apple.Terminal', app: 'Terminal', title: null, url: null }),
      call: async (name, args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: `did ${args.op}` }] };
      },
    },
  });
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  const call = (id, args) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'blocked_app', arguments: { app: 'Terminal', ...args } } });
  return { relay, call, calls, toClient, send, clientIn, clientOut, serverIn, serverOut, inputLease };
}

test('blocked_app actions take an app-scope lease; a second session waits', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-blocked-lease-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const a = leaseSetup(t, { holder: 'A' }, directory);
  const b = leaseSetup(t, { holder: 'B' }, directory);
  a.call(1, { op: 'type', text: 'echo hi' });
  await settle();
  assert.equal(a.calls.length, 1);
  assert.ok(a.inputLease.owned.size, 'A holds a lease');
  b.call(2, { op: 'type', text: 'echo hi' });
  await settle();
  assert.equal(b.calls.length, 0, 'B is refused while A acts');
  assert.match(b.toClient.find(m => m.id === 2).result.content[0].text, /Input lease.*A/);
  a.relay.close(); b.relay.close();
});

test('a blocked_app read takes no lease and works while another session acts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-blocked-lease-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const a = leaseSetup(t, { holder: 'A' }, directory);
  const b = leaseSetup(t, { holder: 'B' }, directory);
  a.call(1, { op: 'type', text: 'echo hi' });
  b.call(2, { op: 'read' });
  await settle();
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1, 'reads remain available');
  assert.ok(!b.inputLease.owned.size, 'a read holds no lease');
  a.relay.close(); b.relay.close();
});

test('the lease ends when the tool result is in and the turn goes idle', async t => {
  const a = leaseSetup.call(null, t, { holder: 'A' });
  a.call(1, { op: 'type', text: 'echo hi' });
  await settle();
  assert.ok(a.inputLease.owned.size);
  a.relay.close();
  await settle();
  assert.equal(a.inputLease.owned.size, 0, 'close releases the lease');
});
