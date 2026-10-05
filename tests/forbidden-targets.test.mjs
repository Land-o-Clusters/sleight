import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { forbiddenTargetsAllowed, forbiddenTargetWarning, isForbiddenSettingsWindow } from '../plugins/sleight/lib/blocked-apps.mjs';

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function harness(t, options = {}) {
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-forbidden-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's',
    inputLease: new InputLease({ directory, holder: 'A' }), ...options });
  t.after(() => relay.close());
  return {
    toServer, toClient,
    js: (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
  };
}

const approval = app => ({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: `Allow Computer Use to use "${app}"?`,
  _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'high', tool_params: { app } } } });

test('the setting is read only from the user default', () => {
  assert.equal(forbiddenTargetsAllowed(() => '1\n'), true);
  assert.equal(forbiddenTargetsAllowed(() => '0\n'), false);
  assert.equal(forbiddenTargetsAllowed(() => { throw new Error('missing key'); }), false);
});

test('with the setting on, a terminal approval says it covers running commands', async t => {
  const asked = [];
  const h = harness(t, { engineForbiddenTargets: true, ask: async message => { asked.push(message); return 'accept'; } });
  h.fromServer(approval('com.apple.Terminal'));
  await settle();
  assert.match(asked[0], /^Allow Computer Use to use "com\.apple\.Terminal"\? Terminal is a terminal\. A yes lets Claude type and run commands/);
  assert.equal(h.toServer.find(m => m.id === 'e1').result.action, 'accept');
});

test('with the setting on, an OpenAI app approval names its approval buttons', () => {
  assert.match(forbiddenTargetWarning('com.openai.codex'), /approval buttons included/);
  assert.equal(forbiddenTargetWarning('com.apple.TextEdit'), undefined);
});

test('without the setting, approvals pass through unchanged', async t => {
  const asked = [];
  const h = harness(t, { ask: async message => { asked.push(message); return 'accept'; } });
  h.fromServer(approval('com.apple.Terminal'));
  await settle();
  assert.equal(asked[0], 'Allow Computer Use to use "com.apple.Terminal"?');
});

test('settings windows of these apps are recognized, by title or Terminal pane name', () => {
  assert.equal(isForbiddenSettingsWindow({ app: 'Terminal', appId: 'com.apple.Terminal', title: 'Profiles' }), true);
  assert.equal(isForbiddenSettingsWindow({ app: 'ChatGPT', appId: 'com.openai.codex', title: 'Settings' }), true);
  assert.equal(isForbiddenSettingsWindow({ app: 'Terminal', appId: 'com.apple.Terminal', title: 'me — -zsh — 80×24' }), false);
  assert.equal(isForbiddenSettingsWindow({ app: 'TextEdit', appId: 'com.apple.TextEdit', title: 'Settings' }), false);
});

for (const [title, refused] of [['General', true], ['me — -zsh — 80×24', false]]) {
  test(`with the setting on, actions in Terminal's "${title}" window are ${refused ? 'refused' : 'allowed'}`, async t => {
    const h = harness(t, { engineForbiddenTargets: true });
    h.js(1, 'app = await cua.getApp("com.apple.Terminal")');
    await settle();
    h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: Terminal.\n0 standard window ${title}` }],
      _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.Terminal' } } } } });
    await settle();
    h.js(2, 'await app.typeText("ls")');
    await settle();
    const stopped = h.toClient.find(m => m.id === 2);
    if (refused) assert.match(stopped.result.content[0].text, /Input lease: Terminal's settings window is refused/);
    else {
      assert.equal(stopped, undefined);
      assert.ok(h.toServer.some(m => m.id === 2), 'the action reached the engine');
    }
  });
}
