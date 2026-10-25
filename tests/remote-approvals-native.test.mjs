import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRemoteApprovals } from '../plugins/sleight/lib/remote-approvals.mjs';
const source = () => readFileSync(new URL('../plugins/sleight/lib/remote-approvals.js', import.meta.url), 'utf8');

test('native presence reads HID and session dictionary only, unknown data is away', () => {
  const context = {};
  runInNewContext(source(), context);
  for (const [session, idle, expected] of [
    [{ kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }, 10, { idleSeconds: 10, locked: false }],
    [{ kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true }, 0, { idleSeconds: 0, locked: true }],
    [null, 0, { idleSeconds: 0, locked: true }],
    [{ kCGSSessionOnConsoleKey: false, kCGSessionLoginDoneKey: true }, 0, { idleSeconds: 0, locked: true }],
  ]) assert.deepEqual(JSON.parse(JSON.stringify(context.readPresence({ idle: () => idle, session: () => session }))), expected);
});

test('native catalog resolves display, bundle and filename aliases, all six defaults and duplicate installs', () => {
  const context = {}; runInNewContext(source(), context);
  const entries = [
    { id: 'com.apple.TextEdit', name: 'TextEdit', names: ['TextEdit'], path: '/fixture/TextEdit.app' },
    { id: 'com.apple.mail', name: 'Mail', names: ['Mail'], path: '/fixture/Mail.app' },
    { id: 'com.apple.mail', name: 'Mail', names: ['Mail'], path: '/fixture/Copy/Mail.app' },
  ];
  const calls = [];
  const result = context.readCatalog({ applications: () => entries, defaultApp: key => { calls.push(key); return 'com.apple.mail'; } });
  assert.equal(result.apps.length, 3, 'two installed bundles with one name remain ambiguous');
  assert.deepEqual(calls, ['mailto:', '.docx', '.xlsx', '.pptx', '.ics', 'https:']);
  assert.equal(result.defaults['.docx'], 'com.apple.mail');
  assert.doesNotMatch(source(), /Application\(|CGEventTapCreate|CGRequest|AXIsProcessTrusted|openURL|activate\(/);
});

test('launcher facade invokes only fixed metadata operations', async () => {
  const calls = [], remote = createRemoteApprovals({ run: async (...args) => { calls.push(args); return {}; } });
  await remote.presence(); await remote.catalog();
  assert.deepEqual(calls, [['remote-approvals.js', { operation: 'presence' }], ['remote-approvals.js', { operation: 'catalog' }]]);
});
