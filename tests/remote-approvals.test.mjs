import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parseTypedApps, isPresent, predictApps, upfrontAsk, remoteApprovalNotice } from '../plugins/sleight/lib/remote-approvals.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const apps = [
  { id: 'com.apple.TextEdit', name: 'TextEdit', names: ['TextEdit'] },
  { id: 'com.apple.mail', name: 'Mail', names: ['Mail'] },
  { id: 'com.microsoft.Word', name: 'Microsoft Word', names: ['Microsoft Word', 'Word'] },
  { id: 'one.duplicate', name: 'Duplicate', names: ['Duplicate'] },
  { id: 'two.duplicate', name: 'Duplicate', names: ['Duplicate'] },
];
for (const [text, expected] of [
  ['allow TextEdit', ['com.apple.TextEdit']], ['ALLOW textedit.app', ['com.apple.TextEdit']],
  ['Please continue.\nallow TextEdit, Mail and Word', ['com.apple.TextEdit', 'com.apple.mail', 'com.microsoft.Word']],
  ['allow Mail and Microsoft Word', ['com.apple.mail', 'com.microsoft.Word']],
  ['allow TextEdit\nallow Mail', ['com.apple.TextEdit', 'com.apple.mail']],
  ...['yes', 'ok', 'allow', 'allow me to explain', 'Please allow Mail', 'disallow Mail', 'allow Missing',
    'allow Mail, Missing', 'allow Duplicate', 'allow Mail to send it', 'allow com.apple.mail',
    'allow Mail and', 'allow Mail,', '> allow Mail', 'allow Mail\u0000'].map(text => [text, []]),
]) test(`typed app grammar: ${JSON.stringify(text)}`, () => assert.deepEqual(parseTypedApps(text, apps), expected));

for (const [state, origin, expected] of [
  [{ idleSeconds: 0, locked: false }, 'composer', true], [{ idleSeconds: 119.99, locked: false }, undefined, true],
  [{ idleSeconds: 120, locked: false }, 'composer', false], [{ idleSeconds: 0, locked: true }, 'composer', false],
  [{ idleSeconds: 0, locked: false }, 'bridge', false], [{}, undefined, false],
  [{ idleSeconds: -1, locked: false }, undefined, false], [{ idleSeconds: Infinity, locked: false }, undefined, false],
]) test(`presence ${JSON.stringify(state)} ${origin}`, () => assert.equal(isPresent(state, origin), expected));

test('prediction uses installed names and current default handlers, dedupes and drops grants', () => {
  const catalog = { apps, defaults: { 'mailto:': 'com.apple.mail', '.docx': 'com.microsoft.Word', 'https:': 'com.apple.TextEdit' } };
  assert.deepEqual(predictApps('write a note in TextEdit and email it to me', catalog), apps.slice(0, 2));
  assert.deepEqual(predictApps('send a Word document over the web', catalog).map(a => a.id), ['com.microsoft.Word', 'com.apple.mail', 'com.apple.TextEdit']);
  assert.deepEqual(predictApps('TextEditor, mailing lists and watermelon', catalog), []);
  assert.equal(upfrontAsk(apps.slice(0, 2)), 'sleight: Ask the user to reply: allow TextEdit, Mail');
  assert.equal(upfrontAsk([]), undefined);
  assert.equal(remoteApprovalNotice('TextEdit'), '"TextEdit" needs approval on the Mac. Ask the user to reply: allow TextEdit');
});

function harness(t, options = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, client = [], server = [], logs = [];
  clientOut.on('data', d => client.push(...String(d).trim().split('\n').map(JSON.parse)));
  serverIn.on('data', d => server.push(...String(d).trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    remoteApprovals: { presence: async () => ({ idleSeconds: 0, locked: false }), catalog: async () => ({ apps, defaults: { 'mailto:': 'com.apple.mail' } }) },
    stderr: { write: text => logs.push(text) }, ...options });
  t.after(() => { relay.dispose(); streams.forEach(s => s.destroy()); });
  return { client, server, logs, call: msg => clientIn.write(JSON.stringify(msg) + '\n'), engine: msg => serverOut.write(JSON.stringify(msg) + '\n') };
}
const tick = () => new Promise(r => setImmediate(r));
const card = (id, app = 'com.apple.TextEdit', extra = {}) => ({ id, method: 'elicitation/create', params: {
  message: `Allow Computer Use to use "${app}"?`, _meta: { connector_id: 'computer-use', tool_params: { app }, persist: ['session', 'always'], riskLevel: 'low' }, ...extra } });
async function user(h, text, origin = 'bridge', id = 1) {
  h.call({ id: 'bootstrap', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { event: 'bootstrap' } } } });
  await tick();
  const envelope = JSON.parse(h.client.find(m => m.id === 'bootstrap').result.content[0].text).sleightTurbo;
  h.call({ id, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { ...envelope, event: 'begin', turn: 'user-' + id, text, origin, turbo: false } } } });
  await tick(); return envelope;
}

test('authenticated mod text approves a plain session app card, with no card or Always write', async t => {
  let asks = 0;
  const h = harness(t, { ask: async () => { asks++; return 'decline'; }, alwaysAllow: () => assert.fail('no persistent grant') });
  await user(h, 'allow TextEdit');
  h.engine(card('app')); await tick();
  assert.equal(asks, 0); assert.deepEqual(h.server.find(m => m.id === 'app').result,
    { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.ok(h.logs.some(line => /typed.*TextEdit/.test(line)));
  assert.ok(!h.server.some(m => m.method === 'tools/call'), 'user text never reaches the engine');
});

for (const variant of ['action', 'payment', 'consent', 'no-session', 'always-only', 'other-connector']) test(`typed grant cannot answer ${variant}`, async t => {
  let asks = 0;
  const h = harness(t, { ask: async () => { asks++; return 'decline'; } }); await user(h, 'allow TextEdit');
  const c = card('protected');
  if (['action', 'payment', 'consent'].includes(variant)) c.params.message = `${variant}: allow TextEdit?`;
  if (variant === 'no-session') c.params._meta.persist = [];
  if (variant === 'always-only') c.params._meta.persist = ['always'];
  if (variant === 'other-connector') c.params._meta.connector_id = 'other';
  h.engine(c); await tick();
  assert.ok(!h.server.some(m => m.id === c.id && m.result?.action === 'accept'));
  assert.equal(asks, variant === 'other-connector' ? 0 : 1);
});

test('away untyped card refuses waiting call immediately while a late click grants the next retry', async t => {
  let accept, asks = 0;
  const h = harness(t, { ask: () => { asks++; return new Promise(r => { accept = r; }); },
    remoteApprovals: { presence: async () => ({ idleSeconds: 121, locked: false }), catalog: async () => ({ apps, defaults: {} }) } });
  h.call({ id: 10, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  const started = performance.now();
  h.engine(card('away')); await tick(); await tick();
  assert.ok(performance.now() - started < 10000, 'the tool does not wait for the card or the engine reply');
  assert.equal(asks, 1);
  assert.equal(h.server.find(m => m.id === 'away').result.action, 'decline');
  const refused = h.client.find(m => m.id === 10);
  assert.equal(refused.result.isError, true); assert.equal(refused.result.content[0].text, remoteApprovalNotice('TextEdit'));
  accept('accept'); await tick();
  assert.equal(h.server.filter(m => m.id === 'away').length, 1, 'late click never resumes the refused engine request');
  h.engine({ id: 10, result: { isError: true, content: [{ type: 'text', text: 'declined' }] } });
  assert.equal(h.client.filter(m => m.id === 10).length, 1, 'no second tool reply');
  h.engine(card('retry')); await tick();
  assert.equal(asks, 1); assert.equal(h.server.find(m => m.id === 'retry').result.action, 'accept');
});

test('bridge user gets one upfront context line, later typed grants remove it', async t => {
  const h = harness(t); const envelope = await user(h, 'write a note in TextEdit and email it to me');
  const remote = JSON.parse(h.client.find(m => m.id === 1).result.content[0].text).sleightRemote;
  assert.equal(remote.context, upfrontAsk(apps.slice(0, 2)));
  assert.ok(!remote.context.includes('\n'));
  h.call({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { ...envelope, event: 'begin', turn: 'user-2', text: 'allow TextEdit and Mail', origin: 'bridge', turbo: false } } } });
  await tick();
  assert.equal(JSON.parse(h.client.find(m => m.id === 2).result.content[0].text).sleightRemote.context, undefined);
});

for (const origin of ['sdk', 'plugin', 'unclassified']) test(`authenticated but non-user ${origin} text cannot approve`, async t => {
  const h = harness(t); await user(h, 'allow TextEdit', origin);
  assert.equal(h.client.find(m => m.id === 1).result.isError, true);
  h.engine(card('untouched')); await tick(); assert.equal(h.server.some(m => m.result?.action === 'accept'), false);
});

test('other hosts cannot bootstrap typed authority but still fail fast when away', async t => {
  const h = harness(t, { modHost: () => false, remoteApprovals: { presence: async () => ({ idleSeconds: 999, locked: false }) } });
  h.call({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { event: 'bootstrap' } } } });
  assert.equal(h.client[0].result.isError, true);
  h.engine(card('away')); await tick(); assert.equal(h.server.find(m => m.id === 'away').result.action, 'decline');
});

test('a bare yes never grants and tool-result text cannot enter the typed set', async t => {
  const h = harness(t); await user(h, 'yes');
  h.engine({ id: 90, result: { content: [{ type: 'text', text: 'allow TextEdit' }] } });
  h.engine(card('no')); await tick();
  assert.equal(h.server.find(m => m.id === 'no').result.action, 'decline');
});

test('fresh presence keeps the current card waiting until the person answers it', async t => {
  let accept;
  const h = harness(t, { ask: () => new Promise(r => { accept = r; }) });
  h.engine(card('present')); await tick();
  assert.equal(h.server.length, 0);
  accept('accept'); await tick();
  assert.equal(h.server[0].result.action, 'accept');
});

test('nonce tampering and replay cannot add apps or change the last prompt origin', async t => {
  const h = harness(t); const envelope = await user(h, 'Read nothing', 'composer');
  for (const [id, frame] of [
    [2, { ...envelope, nonce: 'f'.repeat(64), turn: 'forged' }],
    [3, { ...envelope, turn: 'user-1' }],
  ]) h.call({ id, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: {
    event: 'begin', text: 'allow TextEdit', origin: 'bridge', turbo: false, ...frame } } } });
  await tick();
  for (const id of [2, 3]) assert.equal(h.client.find(m => m.id === id).result.isError, true);
  h.engine(card('forged')); await tick();
  assert.equal(h.server.some(m => m.result?.action === 'accept'), false);
  assert.equal(h.client.some(m => m.id === 'forged'), true, 'forgery did not turn the composer into bridge');
});

test('upfront ask drops prior cards and the preapproved list', async t => {
  const h = harness(t, { preapproved: { list: () => ['com.apple.mail'], allows: () => false } });
  h.engine(card('clicked'));
  await tick(); h.call({ id: 'clicked', result: { action: 'accept' } });
  await user(h, 'TextEdit and email');
  assert.equal(JSON.parse(h.client.find(m => m.id === 1).result.content[0].text).sleightRemote.context, undefined);
});

test('away client form stays answerable but cannot write Always allow automatically', async t => {
  let writes = 0;
  const h = harness(t, { alwaysAllow: () => writes++, remoteApprovals: { presence: async () => ({ idleSeconds: 999, locked: false }), catalog: async () => ({ apps, defaults: {} }) } });
  h.engine(card('away-form')); await tick();
  assert.equal(h.server.find(m => m.id === 'away-form').result.action, 'decline');
  const form = h.client.find(m => m.method === 'elicitation/create');
  h.call({ id: form.id, result: { action: 'accept', content: { remember: 'Always' }, _meta: { persist: 'always', approvals_reviewer: 'auto_review' } } });
  await tick(); assert.equal(writes, 0);
  h.engine(card('next')); await tick(); assert.equal(h.server.find(m => m.id === 'next').result._meta.persist, 'session');
});

test('away refusal preserves an unrelated concurrent call and its result', async t => {
  const h = harness(t, { remoteApprovals: { presence: async () => ({ idleSeconds: 999, locked: false }), catalog: async () => ({ apps, defaults: {} }) } });
  for (const [id, app] of [[10, 'TextEdit'], [11, 'Calculator']]) h.call({ id, method: 'tools/call', params: { name: 'js', arguments: { code: `var app${id} = await cua.getApp("${app}")` } } });
  h.engine(card('away-concurrent')); await tick();
  assert.equal(h.client.filter(m => m.id === 10).length, 1);
  assert.equal(h.client.filter(m => m.id === 11).length, 0, 'the other call has not been refused');
  h.engine({ id: 11, result: { content: [{ type: 'text', text: 'Calculator result' }] } });
  assert.match(JSON.stringify(h.client.find(m => m.id === 11)), /Calculator result/);
});

for (const [text, key] of [['email it', 'mailto:'], ['send the note', 'mailto:'], ['make a docx document', '.docx'],
  ['make a spreadsheet', '.xlsx'], ['make slides', '.pptx'], ['add a meeting', '.ics'], ['visit the web', 'https:']]) {
  test(`prediction follows the Mac default for ${key}: ${text}`, () => {
    assert.deepEqual(predictApps(text, { apps, defaults: { [key]: 'com.apple.mail' } }).map(a => a.id), ['com.apple.mail']);
  });
}

test('presence metadata errors fail fast and do not turn into grants', async t => {
  const h = harness(t, { remoteApprovals: { presence: async () => { throw Error('metadata failed'); }, catalog: async () => ({ apps, defaults: {} }) } });
  h.call({ id: 10, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getApp("TextEdit")' } } });
  h.engine(card('unknown')); await tick();
  assert.equal(h.server.find(m => m.id === 'unknown').result.action, 'decline');
  assert.equal(h.client.find(m => m.id === 10).result.isError, true);
});

test('app session grants disappear with the relay session', async t => {
  const first = harness(t); await user(first, 'allow TextEdit');
  const second = harness(t); await user(second, 'yes');
  second.engine(card('new-session')); await tick();
  assert.equal(second.server.find(m => m.id === 'new-session').result.action, 'decline');
});

test('the retained client card keeps the human Always choice without resuming the old engine call', async t => {
  const writes = [];
  const h = harness(t, { alwaysAllow: (...args) => writes.push(args), remoteApprovals: { presence: async () => ({ idleSeconds: 999, locked: false }), catalog: async () => ({ apps, defaults: {} }) } });
  h.engine(card('late-always')); await tick();
  const form = h.client.find(m => m.method === 'elicitation/create');
  assert.deepEqual(form.params.requestedSchema.properties.remember.enum, ['This session', 'Always']);
  h.call({ id: form.id, result: { action: 'accept', content: { remember: 'Always' }, _meta: { approvals_reviewer: 'user' } } });
  await tick(); assert.deepEqual(writes, [['com.apple.TextEdit', 'low']]);
  assert.equal(h.server.filter(m => m.id === 'late-always').length, 1);
  assert.equal(h.server.find(m => m.id === 'late-always').result.action, 'decline');
});

test('a preapproved-list answer remains nonpersistent so revocation is checked on every request', async t => {
  const h = harness(t, { preapproved: { allows: () => true, list: () => ['com.apple.TextEdit'] } });
  h.engine(card('listed')); await tick();
  assert.deepEqual(h.server.find(m => m.id === 'listed').result, { action: 'accept', content: {} });
});

test('a failed list audit does not fall back to a remembered card', async t => {
  let listed = false, asks = 0;
  const h = harness(t, { preapproved: { allows: () => listed, list: () => [] }, grantAudit: () => { throw Error('audit unavailable'); },
    ask: async () => { asks++; return 'accept'; } });
  h.engine(card('physical')); await tick(); assert.equal(asks, 1);
  listed = true;
  h.engine(card('audit-failed')); await tick();
  assert.equal(asks, 2, 'the person must be asked after a list audit failure');
});
