import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay, imageSize, screenshotOf } from '../plugins/sleight/lib/relay.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { readCode, guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-relay-review-')));
const fixturePath = join(fixtureRoot, 'a.txt');
const fixtureURL = pathToFileURL(fixturePath).href;
writeFileSync(fixturePath, 'before\n');
const relays = [];
after(() => { for (const relay of relays) relay.dispose(); rmSync(fixtureRoot, { recursive: true, force: true }); });

// Wires a relay to in-memory streams and records what each side receives.
function harness(options = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toServer = [];
  const toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', changeReview: true, ...options });
  relays.push(relay);
  return {
    relay,
    toServer,
    toClient,
    fromClient: msg => clientIn.write(JSON.stringify(msg) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
  };
}

const tick = () => new Promise(r => setImmediate(r));

const helperRead = (h, id, code = 'let app = await cua.getApp("Calculator")') => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
const helperReply = (h, id, text = 'Error: -10005 timeoutReached', isError = true) => h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });

test('two timeouts from one app do not advise restarting ChatGPT without independent evidence', () => {
  const h = harness();
  for (const id of [1, 2]) { helperRead(h, id); helperReply(h, id); }
  const advice = h.toClient.at(-1).result.content.at(-1).text;
  assert.doesNotMatch(advice, /restart ChatGPT/);
  assert.match(advice, /could not distinguish/);
});

test('an app hang is diagnosed before its second failed reply and uses a fresh guarded control read', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async key => ({ status: key === 'textedit' ? 'timeout' : 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3);
  await tick();
  const probe = h.toServer.at(-1);
  assert.match(probe.id, /^sleight-diagnosis-/);
  assert.match(probe.params.arguments.code, /cua.getApp\("Calculator"\)/);
  assert.ok(!h.toClient.some(msg => msg.id === 3), 'fault reply waits for independent evidence');
  helperReply(h, probe.id, 'Window: "Calculator", App: Calculator', false);
  await tick();
  const advice = h.toClient.find(msg => msg.id === 3).result.content.at(-1).text;
  assert.match(advice, /quit and reopen textedit/); assert.doesNotMatch(advice, /restart ChatGPT/);
  assert.ok(!h.toClient.some(msg => msg.id === probe.id));
  helperRead(h, 4, 'await app.click(1)');
  assert.equal(h.toServer.at(-1).id, probe.id, 'hidden control read requires a visible full read before actions');
});

test('a diagnostic read declines an ungranted or riskier control approval without prompting', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  let asked = 0;
  const h = harness({ ask: async () => { asked++; return 'accept'; },
    diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
      probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
    }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  const probe = h.toServer.at(-1);
  h.fromServer(appApproval('diagnostic-approval', ['session'], 'Calculator', 'high')); await tick();
  assert.equal(asked, 0);
  assert.equal(h.toServer.at(-1).result.action, 'decline');
  helperReply(h, probe.id, 'not approved'); await tick();
  assert.doesNotMatch(h.toClient.find(msg => msg.id === 3).result.content.at(-1).text, /restart ChatGPT/);
});

test('responsive AX processes plus a real engine control timeout permit helper recovery advice', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  helperReply(h, h.toServer.at(-1).id); await tick();
  const advice = h.toClient.find(msg => msg.id === 3).result.content.at(-1).text;
  assert.match(advice, /textedit and calculator answer Accessibility/);
  assert.match(advice, /restart ChatGPT/);
});

test('an expired control deadline stays unknown and its late success cannot permit actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  const probe = h.toServer.at(-1);
  t.mock.timers.tick(5500); await tick();
  assert.doesNotMatch(h.toClient.find(msg => msg.id === 3).result.content.at(-1).text, /restart ChatGPT/);
  helperReply(h, probe.id, 'Window: "Calculator", App: Calculator', false);
  assert.ok(!h.toClient.some(msg => msg.id === probe.id));
  helperRead(h, 4, 'await app.click(1)');
  assert.equal(h.toServer.at(-1).id, probe.id);
});

test('hidden diagnosis does not consume the visible tree and its required refresh is full', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async key => ({ status: key === 'textedit' ? 'timeout' : 'responding', windows: 1 }), readControl,
  }) });
  const tree = label => 'Window: "Calculator", App: Calculator\n0 window Calculator\n' +
    Array.from({ length: 30 }, (_, i) => `${i + 1} button ${i === 0 ? label : 'Button ' + i}`).join('\n');
  helperRead(h, 1); helperReply(h, 1, tree('before'), false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  helperReply(h, h.toServer.at(-1).id, tree('hidden change'), false); await tick();
  helperRead(h, 4, 'await app.getAXState()');
  helperReply(h, 4, `${GUARD_MARK}${tree('hidden change')}${GUARD_END}`, false);
  const visible = h.toClient.find(msg => msg.id === 4).result.content[0].text;
  assert.match(visible, /1 button hidden change/); assert.match(visible, /30 button Button 29/);
  assert.doesNotMatch(visible, /no change since/);
});

test('a visible refresh before diagnostic expiry cannot approve input after its late read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  const probe = h.toServer.at(-1);
  helperRead(h, 4, 'await app.getAXState()'); helperReply(h, 4, 'Window: "Calculator", App: Calculator', false);
  t.mock.timers.tick(5500); await tick();
  helperReply(h, probe.id, 'Window: "Calculator", App: Calculator', false);
  const sent = h.toServer.length;
  helperRead(h, 5, 'await app.click(1)'); assert.equal(h.toServer.length, sent);
});

test('expired diagnostics decline new approval without prompting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  let asked = 0;
  const h = harness({ ask: async () => { asked++; return 'accept'; },
    diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
      probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
    }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  t.mock.timers.tick(5500); await tick();
  h.fromServer(appApproval('expired-approval', ['session'], 'Calculator', 'high')); await tick();
  assert.equal(asked, 0);
  assert.equal(h.toServer.at(-1).result.action, 'decline');
});

test('reset settles diagnostics and old deadlines or replies cannot restore their state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  const old = h.toServer.at(-1);
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js_reset', arguments: {} } });
  helperReply(h, 4, 'reset', false); await tick();
  assert.ok(h.toClient.some(msg => msg.id === 3), 'diagnosis settles on reset');
  helperRead(h, 5); helperReply(h, 5, 'Window: "Calculator", App: Calculator', false);
  t.mock.timers.tick(5500); await tick();
  helperReply(h, old.id, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 6, 'await app.click(1)');
  assert.equal(h.toServer.at(-1).id, 6);
  assert.ok(!h.toClient.some(msg => msg.id === old.id));
});

test('successful headerless diagnostic output mentioning timeoutReached is unknown', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  helperReply(h, h.toServer.at(-1).id, 'The displayed text is timeoutReached', false); await tick();
  assert.doesNotMatch(h.toClient.find(msg => msg.id === 3).result.content.at(-1).text, /restart ChatGPT/);
});

test('a hidden diagnostic engine restart cannot expose its RPC or consume the visible baseline', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 0, 'await cua.rewriteDocumentation()'); helperReply(h, 0, '## Computer Use\ndocs', false);
  helperRead(h, 1); helperReply(h, 1, 'Window: "Calculator", App: Calculator\n0 window Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  const probe = h.toServer.at(-1);
  helperReply(h, probe.id, '## Computer Use\ndocs\n' + GUARD_MARK + 'Window: "Calculator", App: Calculator\n0 window Hidden' + GUARD_END, false); await tick();
  assert.ok(!h.toClient.some(msg => msg.id === probe.id));
  helperRead(h, 4); helperReply(h, 4, 'Window: "Calculator", App: Calculator\n0 window Calculator', false);
  assert.doesNotMatch(h.toClient.find(msg => msg.id === 4).result.content[0].text, /Hidden/);
});

test('reset permits matching cached approval for a fresh read before an old diagnostic replies', async () => {
  const { diagnoseReadFailure } = await import('../plugins/sleight/lib/read-failure.mjs');
  const h = harness({ diagnoseRead: (app, control, readControl) => diagnoseReadFailure(app, control, {
    probeApp: async () => ({ status: 'responding', windows: 1 }), readControl,
  }) });
  helperRead(h, 1);
  h.fromServer(appApproval('original', ['session'], 'Calculator'));
  h.fromClient({ jsonrpc: '2.0', id: 'original', result: { action: 'accept' } });
  helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 2, 'var te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  helperRead(h, 3, 'await te.getAXState()'); helperReply(h, 3); await tick();
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js_reset', arguments: {} } });
  helperReply(h, 4, 'reset', false); await tick();
  helperRead(h, 5);
  const approval = appApproval('fresh', ['session'], 'Calculator'); approval.params._meta.progressToken = 987;
  h.fromServer(approval);
  assert.equal(h.toServer.at(-1).result.action, 'accept');
});

test('two failed helper reads stop that app and promise automatic recovery reads', () => {
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  assert.doesNotMatch(h.toClient.at(-1).result.content.at(-1).text, /restart ChatGPT/);
  helperRead(h, 2, 'await app.getAXState({ disableDiffing: true })'); helperReply(h, 2);
  assert.equal(h.toClient.at(-1).result.isError, true);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish.*Stop retrying.*sleight will retry by itself/s);
  const sent = h.toServer.length;
  helperRead(h, 3);
  helperRead(h, 4, 'await app.click(1)');
  assert.equal(h.toServer.length, sent, 'no engine retry or action after the stuck diagnosis');
  assert.ok(h.toClient.slice(-2).every(m => m.result.isError));
});

test('a stuck Calculator does not disable TextEdit reads or actions on its known handle', () => {
  const h = harness();
  helperRead(h, 1, 'const te = await cua.getApp("TextEdit")');
  helperReply(h, 1, 'Window: "Untitled", App: TextEdit', false);
  helperRead(h, 2); helperReply(h, 2);
  helperRead(h, 3); helperReply(h, 3);
  const sent = h.toServer.length;
  helperRead(h, 4, 'await te.getAXState()');
  helperReply(h, 4, 'Window: "Untitled", App: TextEdit', false);
  helperRead(h, 5, 'await te.pressKey("super+a")');
  assert.equal(h.toServer.length, sent + 2);
  helperRead(h, 6, 'await app.click(1)');
  assert.equal(h.toServer.length, sent + 2, 'the Calculator handle remains blocked');
  helperRead(h, 7, 'await cua.getState()');
  helperReply(h, 7, 'inventory', false);
  helperRead(h, 8);
  assert.equal(h.toServer.length, sent + 3, 'inventory success does not clear Calculator');
});

test('timeout counts stay separate across apps and a reset cannot erase them', () => {
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2, 'let te = await cua.getApp("TextEdit")'); helperReply(h, 2);
  assert.doesNotMatch(JSON.stringify(h.toClient), /restart ChatGPT/);
  helperRead(h, 3); helperReply(h, 3);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish/);
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js_reset', arguments: {} } });
  assert.equal(h.toServer.at(-1).params.name, 'js_reset');
  helperRead(h, 5);
  assert.equal(h.toServer.at(-1).id, 4, 'reset is available but does not clear the app fault');
  helperRead(h, 6, 'let te = await cua.getApp("TextEdit")'); helperReply(h, 6);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish/);
});

test('automatic recovery reads run every 20 s and a successful read clears the app fault', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  const sent = h.toServer.length;
  t.mock.timers.tick(19999);
  assert.equal(h.toServer.length, sent);
  t.mock.timers.tick(1);
  const first = h.toServer.at(-1);
  assert.equal(h.toServer.length, sent + 1);
  assert.equal(first.params.name, 'js');
  assert.match(first.params.arguments.code, /await cua.getApp\("Calculator"\)/);
  assert.ok(first.params.arguments.timeout_ms <= 5000);
  helperRead(h, 3);
  assert.equal(h.toServer.length, sent + 1, 'no parallel recovery read');
  helperReply(h, first.id);
  t.mock.timers.tick(19999);
  assert.equal(h.toServer.length, sent + 1);
  t.mock.timers.tick(1);
  const second = h.toServer.at(-1);
  assert.equal(h.toServer.length, sent + 2);
  helperReply(h, second.id, 'Window: "Calculator", App: Calculator', false);
  assert.ok(!h.toClient.some(m => m.id === second.id), 'internal probes do not leak RPC responses');
  helperRead(h, 4);
  helperReply(h, 4, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 5, 'await app.click(1)');
  assert.equal(h.toServer.at(-1).id, 5, 'actions can resume without a new relay');
  helperReply(h, 5, 'Window: "Calculator", App: Calculator', false);
  const recovered = h.toServer.length;
  t.mock.timers.tick(60000);
  assert.equal(h.toServer.length, recovered, 'success cancels future probes');
  h.relay.dispose();
});

test('a failed recovery read cannot clear the fault and disposal cancels future probes', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  t.mock.timers.tick(20000);
  const probe = h.toServer.at(-1);
  assert.notEqual(probe.id, 2);
  helperReply(h, probe.id, 'permission denied');
  helperRead(h, 3, 'await app.click(1)');
  assert.equal(h.toServer.at(-1).id, probe.id);
  h.relay.dispose();
  const sent = h.toServer.length;
  t.mock.timers.tick(60000);
  assert.equal(h.toServer.length, sent);
});

test('a stalled automatic read is bounded, does not leak late replies and can retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  t.mock.timers.tick(20000);
  const probe = h.toServer.at(-1);
  assert.notEqual(probe.id, 2);
  t.mock.timers.tick(5500);
  helperReply(h, probe.id);
  assert.ok(!h.toClient.some(m => m.id === probe.id));
  t.mock.timers.tick(14500);
  assert.notEqual(h.toServer.at(-1).id, probe.id);
  h.relay.dispose();
});

test('recovery reads wait while another engine call is pending', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  helperRead(h, 3, 'let te = await cua.getApp("TextEdit")');
  const sent = h.toServer.length;
  t.mock.timers.tick(20000);
  assert.equal(h.toServer.length, sent);
  helperReply(h, 3, 'Window: "Untitled", App: TextEdit', false);
  t.mock.timers.tick(1000);
  assert.equal(h.toServer.length, sent + 1);
  h.relay.dispose();
});

test('parallel replies for one app remain valid after another read succeeds', () => {
  const h = harness();
  helperRead(h, 1); helperRead(h, 2);
  helperReply(h, 1, 'Window: "Calculator", App: Calculator', false);
  assert.doesNotThrow(() => helperReply(h, 2));
  helperRead(h, 3); helperReply(h, 3);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish/);
  const other = harness();
  helperRead(other, 1); helperRead(other, 2);
  helperReply(other, 1, 'Window: "Calculator", App: Calculator', false);
  assert.doesNotThrow(() => helperReply(other, 2, 'Window: "Calculator", App: Calculator', false));
});

test('an eligible foreground read takes the recovery slot without a second automatic probe', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  helperRead(h, 3, 'let chess = await cua.getApp("Chess")');
  t.mock.timers.tick(20000);
  helperRead(h, 4);
  assert.equal(h.toServer.at(-1).id, 4);
  helperRead(h, 5);
  assert.equal(h.toServer.at(-1).id, 4);
  helperReply(h, 4);
  helperReply(h, 3, 'Window: "Chess", App: Chess', false);
  const sent = h.toServer.length;
  t.mock.timers.tick(19999);
  assert.equal(h.toServer.length, sent);
  t.mock.timers.tick(1);
  assert.equal(h.toServer.length, sent + 1);
  h.relay.dispose();
});

test('learned bundle aliases and screenshot reads share the same app fault', () => {
  const h = harness();
  helperRead(h, 1, "const calc = await cua.getApp('Calculator')");
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator' }], _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.calculator' } } } } });
  helperRead(h, 2, 'await calc.getScreenshot()'); helperReply(h, 2);
  helperRead(h, 3, 'await cua.getApp("com.apple.calculator")'); helperReply(h, 3);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish/);
  const sent = h.toServer.length;
  helperRead(h, 4, 'await calc.getAXStateAndScreenshot()');
  assert.equal(h.toServer.length, sent);
});

test('surrounding whitespace cannot combine timeout counts for different apps', () => {
  const h = harness();
  helperRead(h, 1, '  let app = await cua.getApp("Calculator")  '); helperReply(h, 1);
  helperRead(h, 2, '\n const te = await cua.getApp("TextEdit")\n'); helperReply(h, 2);
  assert.doesNotMatch(JSON.stringify(h.toClient), /restart ChatGPT/);
  helperRead(h, 3, ' await app.getAXState() '); helperReply(h, 3);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish/);
  const sent = h.toServer.length;
  helperRead(h, 4, '  await cua.getApp("Chess")  ');
  assert.equal(h.toServer.length, sent + 1);
});

test('hidden recovery forces a visible full AX read before actions can resume', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  t.mock.timers.tick(20000);
  helperReply(h, h.toServer.at(-1).id, 'Window: "Calculator", App: Calculator', false);
  const sent = h.toServer.length;
  helperRead(h, 3, 'await app.click(1)');
  assert.equal(h.toServer.length, sent);
  assert.match(h.toClient.at(-1).result.content[0].text, /full.*read/i);
  helperRead(h, 4, 'await app.getAXState({disableDiffing:false,emit:false})');
  const expression = h.toServer.at(-1).params.arguments.code.split('\n').at(-1);
  assert.match(expression, /getAXState\(\{\s*disableDiffing:\s*true/);
  assert.doesNotMatch(expression, /disableDiffing:\s*false/);
  helperReply(h, 4, 'Window: "Calculator", App: Calculator\n1 button 1', false);
  helperRead(h, 5, 'await app.click(1)');
  assert.equal(h.toServer.at(-1).id, 5);
  helperReply(h, 5, 'Window: "Calculator", App: Calculator', false);
  h.relay.dispose();
});

test('hidden helper recovery cannot create a later copy or erase another app dialog state', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const path = join(fixtureRoot, 'helper-late-copy.txt');
  writeFileSync(path, 'before\n');
  const header = `Window: "helper-late-copy.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}\n63 button Cancel, ID: CancelButton`;
  const h = harness();
  helperRead(h, 1, 'let app = await cua.getApp("TextEdit")');
  helperReply(h, 1, 'Window: "Untitled", App: TextEdit', false);
  helperRead(h, 2, 'let calc = await cua.getApp("Calculator")'); helperReply(h, 2);
  helperRead(h, 3, 'await calc.getAXState()'); helperReply(h, 3);
  helperRead(h, 4, 'await app.click(64)'); helperReply(h, 4, header, false);
  assert.equal(h.relay.snapshotDirectory, undefined, 'late document is still uncaptured');
  t.mock.timers.tick(20000);
  helperReply(h, h.toServer.at(-1).id, 'Window: "Calculator", App: Calculator', false);
  assert.equal(h.relay.snapshotDirectory, undefined, 'a hidden Calculator read cannot capture TextEdit');
  helperRead(h, 5, 'await app.typeText("edit")');
  assert.equal(h.toServer.some(m => m.id === 5), false, 'editing still needs a visible late-document read');
  helperRead(h, 6, 'await app.click(63)');
  assert.equal(h.toServer.at(-1).id, 6, 'the cached Cancel button remains usable');
  helperReply(h, 6, header, false);
  helperRead(h, 7, 'await app.getAXState({disableDiffing:true})'); helperReply(h, 7, header, false);
  assert.ok(h.relay.snapshotDirectory, 'the visible TextEdit read takes its later copy');
  helperRead(h, 8, 'await app.typeText("edit")');
  assert.equal(h.toServer.at(-1).id, 8);
  helperReply(h, 8, header, false);
  h.relay.dispose();
});

test('a native helper fault and hidden recovery do not block browser calls or their saved handles', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2);
  helperRead(h, 3, 'let tab = await cua.getTab("1")');
  assert.equal(h.toServer.at(-1).id, 3);
  h.fromServer({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Browser tab: 1' }], _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } });
  helperRead(h, 4, 'await tab.playwright.getByRole("link").click()');
  assert.equal(h.toServer.at(-1).id, 4);
  helperReply(h, 4, 'Browser tab: 1', false);
  t.mock.timers.tick(20000);
  helperReply(h, h.toServer.at(-1).id, 'Window: "Calculator", App: Calculator', false);
  helperRead(h, 5, 'await tab.getAXState()');
  assert.equal(h.toServer.at(-1).id, 5);
  assert.ok(h.toServer.at(-1).params.arguments.code.includes('await tab.getAXState()'));
  assert.match(h.toServer.at(-1).params.arguments.code, /Native access stopped/);
  helperReply(h, 5, 'Browser tab: 1', false);
  helperRead(h, 6, 'await app.click(1)');
  assert.equal(h.toServer.some(m => m.id === 6), false);
  h.relay.dispose();
});

test('a successful helper read resets consecutive timeouts, but documentation does not', () => {
  const h = harness();
  helperRead(h, 1); helperReply(h, 1);
  helperRead(h, 2); helperReply(h, 2, 'Window: Calculator', false);
  helperRead(h, 3); helperReply(h, 3);
  assert.doesNotMatch(h.toClient.at(-1).result.content.at(-1).text, /restart ChatGPT/);
  helperRead(h, 4, 'await cua.rewriteDocumentation()'); helperReply(h, 4, '# API', false);
  helperRead(h, 5); helperReply(h, 5);
  assert.match(h.toClient.at(-1).result.content.at(-1).text, /could not distinguish/);
});

test('action timeouts, unrelated failures, UI text and server requests cannot diagnose a stuck helper', () => {
  const h = harness();
  for (const id of [1, 2]) { helperRead(h, id, 'await app.click(1)'); helperReply(h, id); }
  for (const id of [3, 4]) { helperRead(h, id); helperReply(h, id, 'app not found'); }
  for (const id of [5, 6]) { helperRead(h, id); helperReply(h, id, 'a document mentioning timeoutReached', false); }
  helperRead(h, 7); helperReply(h, 7);
  h.fromServer({ jsonrpc: '2.0', id: 7, method: 'notifications/progress', params: { text: 'timeoutReached' } });
  helperRead(h, 8); helperReply(h, 8, 'permission denied');
  helperRead(h, 9); helperReply(h, 9);
  assert.ok(h.toClient.every(m => !JSON.stringify(m).includes('restart ChatGPT')));
});

test('RPC timeout errors are diagnosed and turn cleanup stays available', () => {
  const h = harness();
  for (const id of [1, 2]) {
    helperRead(h, id);
    h.fromServer({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Sky error -10005: timeoutReached' } });
  }
  assert.match(h.toClient.at(-1).error.message, /could not distinguish/);
  h.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } });
  assert.equal(h.toServer.at(-1).params.name, 'turn_ended');
  const fresh = harness(); helperRead(fresh, 1); helperReply(fresh, 1);
  assert.doesNotMatch(JSON.stringify(fresh.toClient), /restart ChatGPT/);
});

test('stuck-helper guidance in document mode does not ask Claude for another read', () => {
  const h = harness({ approvalScope: 'document' });
  for (const id of [1, 2]) { helperRead(h, id); helperReply(h, id); }
  const blocks = h.toClient.at(-1).result.content;
  assert.match(blocks.at(-1).text, /could not distinguish/);
  assert.ok(blocks.every(c => !c.text.includes('then ask the user with document_scope')));
});
const meta = msg => JSON.parse(msg.params._meta['x-codex-turn-metadata']);

const flowFixture = () => new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
const flowCall = (h, id, code = 'await app.typeText("SECRET")', name = 'js', args) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args ?? { code } } });
const flowAnswer = (h, id, text = 'Window: "Test", App: TextEdit\n0 standard window Test\n1 text entry area Value: safe') => h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

test('flow rules refuse before engine forwarding and local tool effects', async () => {
  let effects = 0;
  const h = harness({ flowRules: flowFixture(), localTools: { tools: [{ name: 'drag' }], call: async () => { effects++; return { content: [] }; } } });
  flowCall(h, 1); flowCall(h, 2, '', 'drag', { app: 'TextEdit', note: 'SECRET' }); await tick();
  assert.equal(h.toServer.length, 0); assert.equal(effects, 0);
  assert.match(h.toClient[0].result.content[0].text, /private.*flow_exception/s);
  assert.equal(h.toClient[0].result.isError, true);
});

test('flow exception is a user decision for one identical retry, never a session grant', async () => {
  const prompts = [];
  const h = harness({ flowRules: flowFixture(), ask: async (...args) => { prompts.push(args); return 'accept'; } });
  flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', { action: 'accept' }); await tick();
  assert.equal(prompts.length, 0);
  flowCall(h, 3, '', 'flow_exception', {}); await tick(); await tick();
  assert.equal(prompts.length, 1); assert.equal(prompts[0][1], false);
  assert.equal(prompts[0][2].kind, 'flow'); assert.match(prompts[0][2].detail, /SECRET/);
  flowCall(h, 4); await tick(); assert.equal(h.toServer.length, 1);
  flowAnswer(h, 4); await tick();
  flowCall(h, 5); await tick(); assert.equal(h.toServer.length, 1);
  assert.equal(h.toClient.find(m => m.id === 5).result.isError, true);
});

test('flow exception elicitation declines and cancels without forwarding or permission', async () => {
  for (const action of ['decline', 'cancel']) {
    const h = harness({ flowRules: flowFixture() }); flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', {}); await tick();
    const prompt = h.toClient.find(m => m.method === 'elicitation/create');
    assert.match(prompt.params.message, /SECRET/);
    h.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action } }); await tick(); await tick();
    flowCall(h, 3); await tick(); assert.equal(h.toServer.length, 0);
  }
});

test('different calls invalidate an exception and calls wait while its prompt is open', async () => {
  let answer;
  const h = harness({ flowRules: flowFixture(), ask: () => new Promise(r => { answer = r; }) });
  flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', {}); await tick();
  flowCall(h, 3, 'await app.typeText("safe")'); await tick(); assert.equal(h.toServer.length, 0);
  answer('accept'); await tick(); await tick();
  flowCall(h, 4, 'await app.typeText("safe")'); await tick(); flowAnswer(h, 4); await tick();
  flowCall(h, 5); await tick(); assert.equal(h.toServer.length, 1);
});

test('flow rules serialize reads and record protected values before the next call', async () => {
  const h = harness({ flowRules: new FlowRules({ version: 1, rules: [{ id: 'source', kind: 'source', sources: ['TextEdit'], destinations: ['TextEdit'] }] }) });
  flowCall(h, 1, 'let app=await cua.getApp("TextEdit")'); flowCall(h, 2, 'await app.typeText("safe")'); await tick();
  assert.equal(h.toServer.length, 1);
  flowAnswer(h, 1, 'Window: "Source", App: TextEdit\n0 standard window Source\n1 text entry area Value: private value'); await tick();
  flowCall(h, 3, 'await app.typeText("private value")'); await tick();
  assert.equal(h.toServer.length, 1); assert.match(h.toClient.find(m => m.id === 3).result.content[0].text, /source/);
});

test('enabled flow tools are advertised and engine failure consumes a user exception', async () => {
  const h = harness({ flowRules: flowFixture(), ask: async () => 'accept' });
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }] } }); await tick();
  assert.ok(h.toClient.find(m => m.id === 'list').result.tools.some(t => t.name === 'flow_exception'));
  flowCall(h, 1); flowCall(h, 2, '', 'flow_exception', {}); await tick(); await tick();
  flowCall(h, 3); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'failed action' }] } }); await tick();
  flowCall(h, 4); await tick();
  assert.equal(h.toServer.filter(m => m.method === 'tools/call').length, 1);
  assert.equal(h.toClient.find(m => m.id === 4).result.isError, true);
});

test('adds session and turn metadata to tool calls, keeping existing _meta', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1' }, _meta: { progressToken: 7 } } });
  await tick();
  assert.equal(h.toServer[0].params._meta.progressToken, 7);
  assert.deepEqual(meta(h.toServer[0]), { session_id: 'session-1', turn_id: h.relay.turnId });
});

test('keeps one turn id until turn_ended, then starts a new one', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: {} } });
  h.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } });
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  const [first, second, ended, next] = h.toServer;
  assert.equal(meta(first).turn_id, meta(second).turn_id);
  assert.deepEqual(ended.params.arguments, { hook_event_name: 'Interrupt', session_id: 'session-1', turn_id: meta(first).turn_id });
  assert.notEqual(meta(next).turn_id, meta(first).turn_id);
  assert.equal(meta(next).session_id, 'session-1');
});

test('hides js_add_node_module_dir and marks turn_ended internal in tools/list', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }, { name: 'js_reset' }, { name: 'turn_ended', _meta: { ui: { visibility: [] } } }, { name: 'js_add_node_module_dir' }] } });
  await tick();
  const tools = h.toClient[0].result.tools;
  assert.deepEqual(tools.map(t => t.name), ['js', 'js_reset', 'turn_ended', 'review_changes']);
  assert.match(tools[2].description, /Internal to sleight/);
  assert.equal(tools[2]._meta, undefined);
});

test('passes other messages through unchanged', async () => {
  const h = harness();
  const elicit = { jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: { message: 'Allow?' } };
  h.fromServer(elicit);
  h.fromClient({ jsonrpc: '2.0', id: 9, result: { action: 'accept' } });
  await tick();
  assert.deepEqual(h.toClient[0], elicit);
  assert.deepEqual(h.toServer[0], { jsonrpc: '2.0', id: 9, result: { action: 'accept' } });
});

test('endOpenTurn ends a used turn and swallows the reply', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  const usedTurn = meta(h.toServer[0]).turn_id;
  const done = h.relay.endOpenTurn();
  await tick();
  const call = h.toServer[1];
  assert.equal(call.params.name, 'turn_ended');
  assert.deepEqual(call.params.arguments, { hook_event_name: 'Stop', session_id: 'session-1', turn_id: usedTurn });
  h.fromServer({ jsonrpc: '2.0', id: call.id, result: { content: [] } });
  await done;
  assert.equal(h.toClient.length, 0);
});

test('endOpenTurn does nothing when no call used the turn', async () => {
  const h = harness();
  await h.relay.endOpenTurn();
  await tick();
  assert.equal(h.toServer.length, 0);
});

const appApproval = (id, persist = ['session', 'always'], app = 'com.apple.calculator', riskLevel = 'low') => ({
  jsonrpc: '2.0', id, method: 'elicitation/create',
  params: { message: `Allow Computer Use to use "${app}"?`, mode: 'form', requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', persist, riskLevel, tool_params: { app } } },
});

const preapproved = () => new PreapprovedApps({ version: 1, apps: [
  { app: 'com.apple.calculator', riskLevel: 'medium' }, { app: 'Calculator', riskLevel: 'high' },
] });
for (const approvalScope of ['session', 'once']) {
  test(`user list approves engine calls in ${approvalScope} mode and reports each grant`, async () => {
    const traces = [], logs = [], prompts = [];
    const h = harness({ approvalScope, preapproved: preapproved(),
      ask: async message => { prompts.push(message); return 'decline'; },
      trace: (event, data) => traces.push([event, data]), stderr: { write: text => logs.push(text) } });
    flowCall(h, 1, 'let app = await cua.getApp("com.apple.calculator")'); await tick();
    h.fromServer(appApproval(11)); h.fromServer(appApproval(12, [])); await tick();
    assert.equal(prompts.length, 0);
    assert.equal(h.toServer.filter(m => m.result?.action === 'accept').length, 2);
    assert.ok(h.toServer.filter(m => m.result).every(m => m.result._meta?.persist !== 'always'));
    flowAnswer(h, 1, 'Calculator state'); await tick();
    assert.match(h.toClient.find(m => m.id === 1).result.content.at(-1).text, /pre-approved.*user.*list/i);
    assert.equal(traces.filter(([event]) => event === 'preapproved-app').length, 2);
    assert.equal(logs.length, 2); assert.match(logs[0], /com.apple.calculator.*low/);
    flowCall(h, 2); await tick(); flowAnswer(h, 2); await tick();
    assert.doesNotMatch(h.toClient.find(m => m.id === 2).result.content.at(-1).text, /pre-approved/);
  });
}
test('unlisted and higher or unknown engine risk still prompt, including without session persistence', async () => {
  const h = harness({ preapproved: preapproved() });
  h.fromServer(appApproval(1, undefined, 'Mail'));
  h.fromServer(appApproval(2, [], 'com.apple.calculator', 'high'));
  h.fromServer(appApproval(3, [], 'com.apple.calculator', 'unknown'));
  await tick(); assert.deepEqual(h.toClient.map(m => m.id), [1, 2, 3]);
  assert.equal(h.toServer.length, 0);
});
for (const name of ['drag', 'menu_bar']) {
  test(`user list covers ${name} at high risk, reports even failures, and prompts below that ceiling`, async () => {
    const prompts = [], logs = [];
    const h = harness({ preapproved: preapproved(), stderr: { write: text => logs.push(text) },
      ask: async message => { prompts.push(message); return 'decline'; },
      localTools: { tools: [{ name }], call: async (_name, args, approve) => {
        const allowed = await approve([name, args.app], 'Allow local action?');
        return { isError: true, content: [{ type: 'text', text: allowed ? 'action failed' : 'refused' }] };
      } } });
    for (let id = 1; id <= 2; id++) { flowCall(h, id, '', name, { app: 'Calculator' }); await tick(); await tick(); }
    assert.equal(prompts.length, 0); assert.equal(logs.length, 2);
    for (const msg of h.toClient) assert.match(msg.result.content.at(-1).text, /pre-approved.*user.*list/i);
    flowCall(h, 3, '', name, { app: 'com.apple.calculator' }); await tick(); await tick();
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(h.toClient.find(m => m.id === 3).result.content.at(-1).text, /pre-approved/);
  });
}
test('unmerged hover approval still asks despite the user list', async () => {
  const prompts = [];
  const h = harness({ preapproved: preapproved(), ask: async text => { prompts.push(text); return 'decline'; },
    localTools: { tools: [{ name: 'hover' }], call: async (_name, _args, approve) => ({ content: [
      { type: 'text', text: String(await approve(['hover', 'Calculator'], 'Allow hover?')) },
    ] }) } });
  flowCall(h, 1, '', 'hover', {}); await tick(); await tick();
  assert.equal(prompts.length, 1);
  assert.equal(h.toClient[0].result.content[0].text, 'false');
});
for (const failure of ['audit', 'trace', 'all-traces', 'stderr']) {
  for (const prompt of ['dialog', 'client']) {
    test(`${failure} write failure falls back to ${prompt} approval without a list grant`, async () => {
      const prompts = [];
      const h = harness({ preapproved: preapproved(),
        grantAudit: () => { if (failure === 'audit') throw new Error('disk full'); },
        trace: event => { if (failure === 'all-traces' || (failure === 'trace' && event === 'preapproved-app')) throw new Error('disk full'); },
        stderr: { write() { if (failure === 'stderr') throw new Error('closed'); } },
        ...(prompt === 'dialog' ? { ask: async text => { prompts.push(text); return 'decline'; } } : {}),
      });
      assert.doesNotThrow(() => flowCall(h, 1, 'let app = await cua.getApp("com.apple.calculator")')); await tick();
      assert.doesNotThrow(() => h.fromServer(appApproval(11)));
      await tick(); await tick();
      if (prompt === 'dialog') {
        assert.equal(prompts.length, 1); assert.equal(h.toServer.at(-1).result.action, 'decline');
      } else {
        assert.equal(h.toClient.at(-1).method, 'elicitation/create');
        h.fromClient({ jsonrpc: '2.0', id: 11, result: { action: 'cancel' } }); await tick();
        assert.equal(h.toServer.at(-1).result.action, 'cancel');
      }
      flowAnswer(h, 1); await tick();
      assert.doesNotMatch(h.toClient.at(-1).result.content.at(-1).text, /pre-approved/);
    });
  }
}
test('failed list audit asks again even after a remembered engine approval', async () => {
  let audits = 0;
  const prompts = [];
  const h = harness({ preapproved: preapproved(), grantAudit: () => { audits++; throw new Error('disk full'); },
    ask: async text => { prompts.push(text); return prompts.length === 1 ? 'accept' : 'decline'; } });
  h.fromServer(appApproval(1)); await tick(); await tick();
  h.fromServer(appApproval(2)); await tick(); await tick();
  assert.equal(audits, 2); assert.equal(prompts.length, 2);
  assert.deepEqual(h.toServer.map(msg => msg.result.action), ['accept', 'decline']);
});
test('audit fallback in once mode forwards the user accept without session persistence', async () => {
  const h = harness({ approvalScope: 'once', preapproved: preapproved(), grantAudit: () => { throw new Error('disk full'); } });
  h.fromServer(appApproval(1)); await tick();
  const answer = { action: 'accept', content: {} };
  h.fromClient({ jsonrpc: '2.0', id: 1, result: answer }); await tick();
  assert.deepEqual(h.toServer.at(-1).result, answer);
  h.fromServer(appApproval(2)); await tick();
  assert.equal(h.toClient.at(-1).id, 2);
  assert.equal(h.toClient.at(-1).method, 'elicitation/create');
});
test('failed local grant audit falls back to asking and reports no list grant', async () => {
  const prompts = [];
  const h = harness({ preapproved: preapproved(), grantAudit: () => { throw new Error('disk full'); },
    ask: async text => { prompts.push(text); return 'decline'; }, localTools: { tools: [{ name: 'drag' }],
      call: async (_name, _args, approve) => ({ content: [{ type: 'text', text: String(await approve(['drag', 'Calculator'], 'Allow drag?')) }] }) } });
  flowCall(h, 1, '', 'drag', {}); await tick(); await tick();
  assert.equal(prompts.length, 1);
  assert.equal(h.toClient.at(-1).result.content[0].text, 'false');
  assert.doesNotMatch(JSON.stringify(h.toClient.at(-1)), /pre-approved/);
});
test('the user list does not approve notifications, document grants, or unrelated elicitations', async () => {
  const h = harness({ preapproved: preapproved(), localTools: { tools: [{ name: 'notifications' }],
    call: async (_name, _args, approve) => ({ content: [{ type: 'text', text: String(await approve(['notifications'], 'Allow notifications?')) }] }) } });
  flowCall(h, 1, '', 'notifications', {}); await tick();
  assert.equal(h.toClient[0].method, 'elicitation/create');
  const other = { jsonrpc: '2.0', id: 22, method: 'elicitation/create', params: { message: 'Other', _meta: { connector_id: 'other', tool_params: { app: 'Calculator' }, riskLevel: 'low' } } };
  h.fromServer(other); await tick(); assert.deepEqual(h.toClient.at(-1), other);
  const d = harness({ approvalScope: 'document', preapproved: preapproved(), ask: async () => 'decline' });
  flowCall(d, 2); await tick(); assert.equal(d.toServer.length, 0);
});

test('scopes an accepted app approval to the session', async () => {
  const h = harness();
  h.fromServer(appApproval(5));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 5, result: { action: 'accept', content: {} } });
  await tick();
  assert.deepEqual(h.toServer[0].result, { action: 'accept', content: {}, _meta: { persist: 'session' } });
});

test('never changes a decline, a cancel, or a scope the client chose', async () => {
  const h = harness();
  for (const id of [1, 2, 3]) h.fromServer(appApproval(id));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'decline' } });
  h.fromClient({ jsonrpc: '2.0', id: 2, result: { action: 'cancel' } });
  h.fromClient({ jsonrpc: '2.0', id: 3, result: { action: 'accept', _meta: { persist: 'always' } } });
  await tick();
  assert.deepEqual(h.toServer.map(m => m.result), [
    { action: 'decline' }, { action: 'cancel' }, { action: 'accept', _meta: { persist: 'always' } },
  ]);
});

test('does not treat a server request as the answer to a pending tools/list', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await tick();
  h.fromServer(appApproval(1));
  await tick();
  assert.equal(h.toClient[0].method, 'elicitation/create');
});

test('leaves approvals alone that do not offer a session scope or are not computer use', async () => {
  const h = harness();
  h.fromServer(appApproval(1, []));
  h.fromServer({ jsonrpc: '2.0', id: 2, method: 'elicitation/create', params: { message: 'Other?', _meta: { connector_id: 'other', persist: ['session'] } } });
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  h.fromClient({ jsonrpc: '2.0', id: 2, result: { action: 'accept' } });
  await tick();
  assert.deepEqual(h.toServer.map(m => m.result), [{ action: 'accept' }, { action: 'accept' }]);
});

test('approvalScope once passes accepts through unchanged', async () => {
  const h = harness({ approvalScope: 'once' });
  h.fromServer(appApproval(5));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 5, result: { action: 'accept', content: {} } });
  await tick();
  assert.deepEqual(h.toServer[0].result, { action: 'accept', content: {} });
});

test('answers repeat approvals for an app the user accepted this session', async () => {
  const h = harness();
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept', content: {} } });
  await tick();
  h.fromServer(appApproval(2));
  h.fromServer(appApproval(3));
  await tick();
  // Only the first prompt reached the user; the relay answered the others.
  assert.equal(h.toClient.length, 1);
  assert.deepEqual(h.toServer.slice(1).map(m => [m.id, m.result.action]), [[2, 'accept'], [3, 'accept']]);
});

test('still asks for a different app or a riskier request', async () => {
  const h = harness();
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  await tick();
  h.fromServer(appApproval(2, undefined, 'com.apple.TextEdit'));
  h.fromServer(appApproval(3, undefined, 'com.apple.calculator', 'high'));
  await tick();
  assert.deepEqual(h.toClient.map(m => m.id), [1, 2, 3]);
});

test('never remembers a decline', async () => {
  const h = harness();
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'decline' } });
  await tick();
  h.fromServer(appApproval(2));
  await tick();
  assert.deepEqual(h.toClient.map(m => m.id), [1, 2]);
});

test('approvalScope once asks every time', async () => {
  const h = harness({ approvalScope: 'once' });
  h.fromServer(appApproval(1));
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  await tick();
  h.fromServer(appApproval(2));
  await tick();
  assert.deepEqual(h.toClient.map(m => m.id), [1, 2]);
});

test('a new relay (a new session) asks again', async () => {
  const first = harness();
  first.fromServer(appApproval(1));
  await tick();
  first.fromClient({ jsonrpc: '2.0', id: 1, result: { action: 'accept' } });
  await tick();
  const second = harness();
  second.fromServer(appApproval(1));
  await tick();
  assert.equal(second.toClient.length, 1);
});

test('answers a server/discover probe itself instead of forwarding it', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} });
  await tick();
  assert.equal(h.toServer.length, 0);
  assert.deepEqual(h.toClient[0], { jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found' } });
});

// An `ask` stand-in that records each prompt and answers from a list.
function asker(...answers) {
  const asked = [];
  const ask = async (message, sessionScoped) => {
    asked.push({ message, sessionScoped });
    return answers.shift();
  };
  return { ask, asked };
}

test('with ask, answers app approvals itself and never forwards them', async () => {
  const a = asker('accept');
  const h = harness({ ask: a.ask });
  h.fromServer(appApproval(1));
  await tick();
  await tick();
  assert.equal(h.toClient.length, 0);
  assert.deepEqual(a.asked, [{ message: 'Allow Computer Use to use "com.apple.calculator"?', sessionScoped: true }]);
  assert.deepEqual(h.toServer[0], { jsonrpc: '2.0', id: 1, result: { action: 'accept', content: {}, _meta: { persist: 'session' } } });
});

test('with ask, an accepted app is not asked again, a declined one is', async () => {
  const a = asker('accept', 'decline', 'cancel');
  const h = harness({ ask: a.ask });
  h.fromServer(appApproval(1));
  h.fromServer(appApproval(2));
  await tick(); await tick(); await tick();
  h.fromServer(appApproval(3, undefined, 'com.apple.TextEdit'));
  await tick(); await tick();
  h.fromServer(appApproval(4, undefined, 'com.apple.TextEdit'));
  await tick(); await tick();
  assert.equal(a.asked.length, 3);
  assert.deepEqual(h.toServer.map(m => [m.id, m.result.action]), [[1, 'accept'], [2, 'accept'], [3, 'decline'], [4, 'cancel']]);
});

test('with ask and approvalScope once, asks every time and never adds a scope', async () => {
  const a = asker('accept', 'accept');
  const h = harness({ ask: a.ask, approvalScope: 'once' });
  h.fromServer(appApproval(1));
  await tick(); await tick();
  h.fromServer(appApproval(2));
  await tick(); await tick();
  assert.deepEqual(a.asked.map(q => q.sessionScoped), [false, false]);
  assert.deepEqual(h.toServer.map(m => m.result), [{ action: 'accept', content: {} }, { action: 'accept', content: {} }]);
});

test('with ask, other elicitations still go to the client', async () => {
  const a = asker();
  const h = harness({ ask: a.ask });
  h.fromServer({ jsonrpc: '2.0', id: 2, method: 'elicitation/create', params: { message: 'Other?', _meta: { connector_id: 'other' } } });
  await tick();
  assert.equal(a.asked.length, 0);
  assert.equal(h.toClient[0].id, 2);
});

// Local tools: sleight's own tools, answered by the relay.
function localTools(calls = []) {
  return {
    tools: [{ name: 'menu_bar', description: 'local', inputSchema: { type: 'object' } }],
    call: async (name, args, approve) => {
      calls.push({ name, args });
      if (args.app) {
        const ok = await approve(['menu_bar', args.app], `Allow Claude to use ${args.app}'s menu bar item?`);
        if (!ok) return { content: [{ type: 'text', text: 'declined' }], isError: true };
      }
      return { content: [{ type: 'text', text: `did ${args.op}` }] };
    },
  };
}
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

test('lists local tools after the server tools', async () => {
  const h = harness({ localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js' }] } });
  await tick();
  assert.deepEqual(h.toClient[0].result.tools.map(t => t.name), ['js', 'menu_bar', 'review_changes']);
});

test('answers a local tool call itself and never forwards it', async () => {
  const calls = [];
  const h = harness({ localTools: localTools(calls) });
  h.fromClient({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'apps' } } });
  await settle();
  assert.equal(h.toServer.length, 0);
  assert.deepEqual(calls, [{ name: 'menu_bar', args: { op: 'apps' } }]);
  assert.deepEqual(h.toClient[0], { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'did apps' }] } });
});

test('local approvals go through ask, are remembered when accepted, never when declined', async () => {
  const a = asker('accept', 'decline', 'accept');
  const h = harness({ ask: a.ask, localTools: localTools() });
  const call = (id, app) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app } } });
  call(1, 'Magnet'); await settle();
  call(2, 'Magnet'); await settle();
  call(3, 'LogiJuice'); await settle();
  call(4, 'LogiJuice'); await settle();
  assert.deepEqual(a.asked.map(q => q.message), [
    "Allow Claude to use Magnet's menu bar item?",
    "Allow Claude to use LogiJuice's menu bar item?",
    "Allow Claude to use LogiJuice's menu bar item?",
  ]);
  assert.deepEqual(h.toClient.map(m => m.result.isError ?? false), [false, false, true, false]);
});

test('without ask, local approvals ask the client with an elicitation', async () => {
  const h = harness({ localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'Magnet' } } });
  await settle();
  const elicit = h.toClient[0];
  assert.equal(elicit.method, 'elicitation/create');
  assert.equal(elicit.params.message, "Allow Claude to use Magnet's menu bar item?");
  h.fromClient({ jsonrpc: '2.0', id: elicit.id, result: { action: 'accept', content: {} } });
  await settle();
  assert.equal(h.toClient[1].id, 1);
  assert.equal(h.toClient[1].result.isError, undefined);
  // Remembered for the session: no second elicitation.
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'Magnet' } } });
  await settle();
  assert.deepEqual(h.toClient.slice(2).map(m => m.id), [2]);
  assert.equal(h.toServer.length, 0);
});

test('a declined client elicitation refuses the local call', async () => {
  const h = harness({ localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'Magnet' } } });
  await settle();
  h.fromClient({ jsonrpc: '2.0', id: h.toClient[0].id, result: { action: 'decline' } });
  await settle();
  assert.equal(h.toClient[1].result.isError, true);
  assert.equal(h.toServer.length, 0);
});

const wait = ms => new Promise(r => setTimeout(r, ms));

test('ends a used turn after the session goes idle', async () => {
  const h = harness({ idleTurnEndMs: 30 });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  await wait(60);
  const ended = h.toServer.find(m => m.params?.name === 'turn_ended');
  assert.ok(ended, 'turn_ended was sent');
  assert.equal(ended.params.arguments.session_id, 'session-1');
});

test('does not end the turn while a call is still running, or before the idle time', async () => {
  const h = harness({ idleTurnEndMs: 40 });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await wait(70);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'not while the call runs');
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  await wait(10);
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: {} } });
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [] } });
  await wait(20);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0, 'a new call restarts the wait');
  await wait(50);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 1);
});

test('without idleTurnEndMs, an idle turn stays open', async () => {
  const h = harness();
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  await wait(40);
  assert.equal(h.toServer.filter(m => m.params?.name === 'turn_ended').length, 0);
});

const documentRead = (h, id, title = 'a.txt', url = fixtureURL) => {
  h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Window: "${title}", App: TextEdit\nURL: ${url}\n1 text area` }] } });
};
const documentCall = (h, id) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("hello")' } } });
const documentApprove = (h, id) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'document_scope', arguments: {} } });

test('document mode blocks action code until the observed document is approved', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  documentCall(h, 1);
  await settle();
  assert.equal(h.toServer.length, 0);
  assert.match(h.toClient[0].result.content[0].text, /document_scope/);
  documentRead(h, 2);
  documentApprove(h, 3);
  await settle();
  documentCall(h, 4);
  await settle();
  assert.ok(h.toServer.find(m => m.id === 4));
  assert.match(h.toServer.find(m => m.id === 4).params.arguments.code, /getAXState/);
});

test('document approval names the observed window and URL, through client elicitation', async () => {
  const h = harness({ approvalScope: 'document' });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  const prompt = h.toClient.find(m => m.method === 'elicitation/create');
  assert.match(prompt.params.message, /a.txt/);
  assert.ok(prompt.params.message.includes(fixtureURL));
  h.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept' } });
  await settle();
  documentCall(h, 3);
  assert.ok(h.toServer.find(m => m.id === 3));
});

test('another document stops further actions before forwarding them', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  documentRead(h, 3, 'b.txt', 'file:///tmp/b.txt');
  documentCall(h, 4);
  await settle();
  assert.equal(h.toServer.some(m => m.id === 4), false);
  assert.equal(h.toClient.find(m => m.id === 4).result.isError, true);
  assert.match(h.toClient.find(m => m.id === 4).result.content[0].text, /b.txt.*document_scope/s);
});

test('equal titles with different URLs do not share a grant', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  documentRead(h, 3, 'a.txt', 'file:///other/a.txt');
  documentCall(h, 4);
  assert.equal(h.toServer.some(m => m.id === 4), false);
});

test('mismatched or missing action-result headers close the relay gate', async () => {
  for (const text of ['Window: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt', 'no window header']) {
    const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
    documentRead(h, 1);
    documentApprove(h, 2);
    await settle();
    documentCall(h, 3);
    h.fromServer({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text }] } });
    documentCall(h, 4);
    assert.equal(h.toClient.find(m => m.id === 3).result.isError, true);
    assert.equal(h.toServer.some(m => m.id === 4), false);
  }
});

test('decline and cancel do not approve the document', async () => {
  for (const answer of ['decline', 'cancel']) {
    const h = harness({ approvalScope: 'document', ask: async () => answer });
    documentRead(h, 1);
    documentApprove(h, 2);
    await settle();
    documentCall(h, 3);
    assert.equal(h.toServer.some(m => m.id === 3), false);
  }
});

test('document mode refuses concurrent calls and local tools outside the scope', async () => {
  const calls = [];
  const h = harness({ approvalScope: 'document', ask: async () => 'accept', localTools: localTools(calls) });
  documentRead(h, 1);
  documentApprove(h, 2);
  await settle();
  documentCall(h, 3);
  documentCall(h, 4);
  h.fromClient({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open', app: 'TextEdit' } } });
  assert.equal(h.toServer.some(m => m.id === 4), false);
  assert.equal(calls.length, 0);
  assert.equal(h.toClient.find(m => m.id === 5).result.isError, true);
});

test('document engine approvals stay tied to the observed app and risk without persistence', async () => {
  const a = asker('accept', 'accept', 'decline');
  const h = harness({ approvalScope: 'document', ask: a.ask });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  h.fromServer(appApproval('read', undefined, 'com.apple.TextEdit'));
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `Window: "a.txt", App: TextEdit\nURL: ${fixtureURL}` }] } });
  documentApprove(h, 2);
  await settle();
  documentCall(h, 3);
  h.fromServer(appApproval('action', undefined, 'com.apple.TextEdit'));
  await settle();
  assert.deepEqual(h.toServer.find(m => m.id === 'action').result, { action: 'accept', content: {} });
  assert.equal(a.asked.length, 2);
  h.fromServer(appApproval('higher', undefined, 'com.apple.TextEdit', 'high'));
  await settle();
  assert.equal(h.toServer.find(m => m.id === 'higher').result.action, 'decline');
  assert.match(a.asked.at(-1).message, /a.txt.*high/);
  h.fromServer(appApproval('wrong-app', undefined, 'com.apple.calculator'));
  await settle();
  assert.equal(h.toServer.find(m => m.id === 'wrong-app').result.action, 'decline');
});

test('discovery allows no trailing action, and grants do not cross relay sessions', async () => {
  const h = harness({ approvalScope: 'document', ask: async () => 'accept' });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit"); await app.typeText("oops")' } } });
  assert.equal(h.toServer.length, 0);
  documentRead(h, 2);
  documentApprove(h, 3);
  await settle();
  const fresh = harness({ approvalScope: 'document' });
  documentRead(fresh, 1);
  documentCall(fresh, 2);
  assert.equal(fresh.toServer.some(m => m.id === 2), false);
});

test('document tools/list advertises only tools supported in this mode', () => {
  const h = harness({ approvalScope: 'document', localTools: localTools() });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js' }, { name: 'js_reset' }, { name: 'turn_ended' }] } });
  assert.deepEqual(h.toClient[0].result.tools.map(t => t.name), ['js', 'turn_ended', 'document_scope', 'review_changes']);
});

function savedEdit(h, id, path, before, afterText) {
  writeFileSync(path, before);
  documentRead(h, id, path.split('/').pop(), pathToFileURL(path).href);
  documentCall(h, id + 1);
  assert.ok(h.toServer.some(m => m.id === id + 1), 'action forwarded after snapshot');
  writeFileSync(path, afterText);
  h.fromServer({ jsonrpc: '2.0', id: id + 1, result: { content: [{ type: 'text', text: `Window: "${path.split('/').pop()}", App: TextEdit\nURL: ${pathToFileURL(path).href}` }] } });
}
const reviewCall = (h, id, args = { op: 'review' }) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'review_changes', arguments: args } });

test('change review can be disabled: no snapshot, no window guard, no review tool', async () => {
  const path = join(fixtureRoot, 'off.txt');
  writeFileSync(path, 'before\n');
  const h = harness({ changeReview: false, trace: (direction, msg) => { if (direction === 'snapshot-before-call') throw new Error('snapshot taken'); } });
  documentRead(h, 1, 'off.txt', pathToFileURL(path).href);
  documentCall(h, 2);
  assert.equal(h.toServer.find(m => m.id === 2).params.arguments.code, 'await app.typeText("hello")');
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Window: "Open", App: TextEdit' }] } });
  documentCall(h, 3);
  assert.ok(h.toServer.some(m => m.id === 3), 'a changed window does not stop the next action');
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 4, result: { tools: [{ name: 'js' }] } });
  assert.deepEqual(h.toClient.find(m => m.id === 4).result.tools.map(t => t.name), ['js']);
  assert.equal(h.relay.snapshotDirectory, undefined);
});

test('textedit-drag: cached guards allow Open, Go to Folder, reads and Cancel across calls', async () => {
  const path = join(fixtureRoot, 'drag-transcript.txt'); writeFileSync(path, 'alpha beta gamma\n');
  const header = `Window: "drag-transcript.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  let ui = header;
  const actions = [];
  const raw = {
    getAXState: async () => ui,
    pressKey: async key => { actions.push(key); if (key === 'super+o') ui = 'Window: "Open", App: TextEdit\n0 standard window Open\n63 button Cancel, ID: CancelButton';
      if (key === 'super+shift+g') ui = 'Window: "", App: TextEdit\n0 sheet ID: GoToWindow'; },
    typeText: async text => actions.push(text),
    click: async id => { actions.push(id); ui = header; },
  };
  const context = createContext({ app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} } });
  const h = harness(); documentRead(h, 1, 'drag-transcript.txt', pathToFileURL(path).href);
  const run = async (id, code) => {
    flowCall(h, id, code);
    const forwarded = h.toServer.find(m => m.id === id);
    assert.ok(forwarded, 'reads and dialog actions reach the engine');
    await runInContext(`(async () => { ${forwarded.params.arguments.code} })()`, context);
    flowAnswer(h, id, ui);
  };
  await run(2, 'await app.pressKey("super+o"); await app.getAXState();');
  await run(3, 'await app.pressKey("super+shift+g"); await app.typeText("/tmp/other.txt"); await app.pressKey("Return"); await app.getAXState();');
  await run(4, 'await app.getAXState({disableDiffing:true});');
  ui = 'Window: "Open", App: TextEdit\n0 standard window Open\n63 button Cancel, ID: CancelButton';
  await run(5, 'app = await cua.getApp("TextEdit");');
  await run(6, 'await app.click(63);');
  assert.deepEqual(actions, ['super+o', 'super+shift+g', '/tmp/other.txt', 'Return', 63]);
  await run(7, 'await app.pressKey("super+o");'); // Returning to the original file stays usable.
});

test('textedit-edit: a standalone read recovers a late document with a later undo copy', async () => {
  const path = join(fixtureRoot, 'late-transcript.txt'); writeFileSync(path, 'alpha beta gamma\n');
  const header = `Window: "late-transcript.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  const h = harness({ ask: async () => 'undo' });
  flowCall(h, 1, 'await app.click(64);'); flowAnswer(h, 1, header);
  flowCall(h, 2, 'await app.setValue(2,"alpha delta gamma\\n");');
  assert.equal(h.toServer.some(m => m.id === 2), false, 'needs a fresh read before a late snapshot');
  flowCall(h, 3, 'let app = await cua.getApp("TextEdit")'); flowAnswer(h, 3, header);
  assert.ok(h.relay.snapshotDirectory, 'fresh read takes the later copy immediately');
  flowCall(h, 4, 'await app.setValue(2,"alpha delta gamma\\n"); await app.pressKey("super+s");');
  assert.ok(h.toServer.some(m => m.id === 4), 'editing resumes after the read');
  writeFileSync(path, 'alpha delta gamma\n'); flowAnswer(h, 4, header);
  reviewCall(h, 5, { op: 'list' });
  assert.match(h.toClient.at(-1).result.content[0].text, /Undo starts at the later copy/);
  reviewCall(h, 6); await settle();
  assert.equal(readFileSync(path, 'utf8'), 'alpha beta gamma\n');
});

test('change review never snapshots or refuses read-only and cancel-only calls after a conflict', () => {
  const path = join(fixtureRoot, 'conflict-read.txt'); const h = harness();
  savedEdit(h, 1, path, 'before\n', 'agent\n'); writeFileSync(path, 'user\n');
  const header = `Window: "conflict-read.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}\n63 button Cancel, ID: CancelButton`;
  for (const [id, code] of [[3, 'await app.getAXState({disableDiffing:true});'], [4, 'await app.pressKey("Escape");'], [5, 'await app.click(63);']]) {
    flowCall(h, id, code); assert.ok(h.toServer.some(m => m.id === id)); flowAnswer(h, id, header);
  }
  documentCall(h, 6); assert.equal(h.toServer.some(m => m.id === 6), false, 'reads do not adopt outside edits');
});

test('change review is advertised by default', () => {
  const h = harness({ changeReview: undefined });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js' }] } });
  assert.ok(h.toClient[0].result.tools.some(t => t.name === 'review_changes'));
});

test('a stale Cancel ID cannot bypass the runtime guard or mutate an outside edit', async () => {
  const path = join(fixtureRoot, 'stale-cancel.txt'); const h = harness();
  savedEdit(h, 1, path, 'before\n', 'agent\n');
  const header = `Window: "stale-cancel.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  flowCall(h, 3, 'await app.getAXState();'); flowAnswer(h, 3, header + '\n63 button Cancel, ID: CancelButton');
  writeFileSync(path, 'user\n');
  flowCall(h, 4, 'await app.click(63);');
  const code = h.toServer.find(m => m.id === 4).params.arguments.code;
  const context = { app: { getAXState: async () => header + '\n63 button Delete', click: async () => writeFileSync(path, 'deleted\n') },
    cua: { getApp() {} }, nodeRepl: { write() {} } };
  await assert.rejects(runInContext(`(async () => { ${code} })()`, createContext(context)), /Cancel.*changed/);
  assert.equal(readFileSync(path, 'utf8'), 'user\n');
});

test('without a lease, document scope or change review, actions on a handle a read proxied go through', async () => {
  // The read installs the guard's proxy; the action goes out unguarded, so the
  // guard has no expected window to compare.
  let ui = 'Window: "x.txt", App: TextEdit\n0 standard window x.txt';
  const keys = [];
  const relaunched = () => ({ getAXState: async () => ui, pressKey: async key => keys.push(key) });
  let raw = relaunched();
  const context = createContext({ app: undefined, cua: { getApp: async () => raw }, nodeRepl: { write() {} } });
  const h = harness({ changeReview: false });
  const run = async (id, code) => {
    flowCall(h, id, code);
    const result = await runInContext(`(async () => { ${h.toServer.find(m => m.id === id).params.arguments.code} })()`, context);
    flowAnswer(h, id, ui);
    return result;
  };
  await run(1, 'app = await cua.getApp("TextEdit")');
  raw = relaunched(); // TextEdit quit and relaunched: a new engine handle.
  await run(2, 'app = await cua.getApp("TextEdit")');
  await run(3, 'await app.pressKey("super+s"); return "saved"');
  assert.deepEqual(keys, ['super+s']);
});

test('a guarded call with no expected window still stops before acting', async () => {
  const keys = [];
  const raw = { getAXState: async () => 'Window: "x.txt", App: TextEdit\n0 standard window x.txt', pressKey: async key => keys.push(key) };
  const context = createContext({ app: undefined, cua: { getApp: async () => raw }, nodeRepl: { write() {} } });
  const run = code => runInContext(`(async () => { ${code} })()`, context);
  await run(readCode('app = await cua.getApp("TextEdit")'));
  await assert.rejects(run(guardedCode('await app.pressKey("super+s")', undefined, 'Stopped: no window.')), /Stopped: no window/);
  assert.deepEqual(keys, []);
});

test('a concurrent read cannot disable the guard of an in-flight mutation', async () => {
  const path = join(fixtureRoot, 'concurrent-read.txt'); writeFileSync(path, 'before\n');
  const header = `Window: "concurrent-read.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  let ui = header, resume;
  const writes = [];
  const raw = { getAXState: async () => ui, typeText: async value => {
    writes.push(value); if (value === 'first') await new Promise(resolve => { resume = resolve; });
  } };
  const context = createContext({ app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} } });
  const h = harness(); documentRead(h, 1, 'concurrent-read.txt', pathToFileURL(path).href);
  flowCall(h, 2, 'await app.typeText("first"); await app.typeText("second");');
  const action = runInContext(`(async () => { ${h.toServer.find(m => m.id === 2).params.arguments.code} })()`, context);
  await tick();
  flowCall(h, 3, 'let app = await cua.getApp("TextEdit");');
  await runInContext(`(async () => { ${h.toServer.find(m => m.id === 3).params.arguments.code} })()`, context);
  ui = 'Window: "other.txt", App: TextEdit\nURL: file:///tmp/other.txt'; resume();
  await assert.rejects(action, /Change review stopped/);
  assert.deepEqual(writes, ['first']);
});

test('review lists two saved documents, asks for each user decision and never forwards undo', async () => {
  const a = join(fixtureRoot, 'review-a.txt'), b = join(fixtureRoot, 'review-b.txt');
  const h = harness();
  savedEdit(h, 1, a, 'before a\n', 'after a\n'); savedEdit(h, 3, b, 'before b\n', 'after b\n');
  reviewCall(h, 5, { op: 'list' });
  assert.match(h.toClient.at(-1).result.content[0].text, /-before a\n\+after a[\s\S]*-before b\n\+after b/);
  assert.equal(h.toClient.some(m => m.method === 'elicitation/create'), false);
  reviewCall(h, 6); await settle();
  const first = h.toClient.find(m => m.method === 'elicitation/create');
  assert.deepEqual(first.params.requestedSchema.properties.decision.enum, ['keep', 'undo', 'later']);
  h.fromClient({ jsonrpc: '2.0', id: first.id, result: { action: 'accept', content: { decision: 'undo' } } }); await settle();
  const second = h.toClient.filter(m => m.method === 'elicitation/create').at(-1);
  h.fromClient({ jsonrpc: '2.0', id: second.id, result: { action: 'accept', content: { decision: 'keep' } } }); await settle();
  assert.equal(readFileSync(a, 'utf8'), 'before a\n'); assert.equal(readFileSync(b, 'utf8'), 'after b\n');
  assert.match(h.toClient.find(m => m.id === 6).result.content[0].text, /undone[\s\S]*kept/);
  assert.equal(h.toServer.some(m => m.params?.name === 'review_changes'), false);
});

test('model decisions and a bare accept cannot undo or keep, and actions wait during review', async () => {
  const path = join(fixtureRoot, 'review-decision.txt');
  const h = harness(); savedEdit(h, 1, path, 'before\n', 'after\n');
  reviewCall(h, 3, { op: 'review', decision: 'undo' });
  assert.equal(h.toClient.at(-1).result.isError, true);
  reviewCall(h, 4); await settle();
  documentCall(h, 5);
  assert.equal(h.toServer.some(m => m.id === 5), false);
  const prompt = h.toClient.find(m => m.method === 'elicitation/create');
  h.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: {} } }); await settle();
  assert.equal(readFileSync(path, 'utf8'), 'after\n');
  assert.match(h.toClient.find(m => m.id === 4).result.content[0].text, /pending/);
});

test('desktop review uses ask with the before/after preview and rechecks edits during the prompt', async () => {
  const path = join(fixtureRoot, 'review-prompt.txt');
  const asked = [];
  const h = harness({ ask: async (message, scoped, options) => {
    asked.push({ message, scoped, options }); writeFileSync(path, 'user edit\n'); return 'undo';
  } });
  savedEdit(h, 1, path, 'before\n', 'agent edit\n'); reviewCall(h, 3); await settle();
  assert.equal(asked[0].options.kind, 'review');
  assert.match(asked[0].options.detail, /-before\n\+agent edit/);
  assert.equal(h.toClient.find(m => m.id === 3).result.isError, true);
  assert.equal(readFileSync(path, 'utf8'), 'user edit\n');
});

test('snapshot failures refuse forwarding and session disposal removes private backups', () => {
  const h = harness(); documentRead(h, 1, 'missing.txt', pathToFileURL(join(fixtureRoot, 'missing.txt')).href);
  documentCall(h, 2);
  assert.equal(h.toServer.some(m => m.id === 2), false);
  assert.match(h.toClient.at(-1).result.content[0].text, /cannot snapshot/);
  const path = join(fixtureRoot, 'review-cleanup.txt');
  savedEdit(h, 3, path, 'before\n', 'after\n');
  const bank = h.relay.snapshotDirectory;
  assert.ok(bank && existsSync(bank));
  h.relay.dispose(); assert.equal(existsSync(bank), false);
});

test('ambiguous action results list newly observed files without inventing before copies', () => {
  const a = join(fixtureRoot, 'ambiguous-a.txt'), b = join(fixtureRoot, 'ambiguous-b.txt');
  writeFileSync(a, 'a before\n'); writeFileSync(b, 'b before\n');
  const h = harness(); documentRead(h, 1, 'a.txt', pathToFileURL(a).href); documentCall(h, 2);
  writeFileSync(a, 'a after\n'); writeFileSync(b, 'b after\n');
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text:
    `Window: "a.txt", App: TextEdit\nURL: ${pathToFileURL(a).href}\nWindow: "b.txt", App: TextEdit\nURL: ${pathToFileURL(b).href}` }] } });
  reviewCall(h, 3, { op: 'list' });
  const listing = h.toClient.at(-1).result.content[0].text;
  assert.ok(listing.includes(a) && listing.includes(b));
  assert.match(listing, /Undo refused.*action was not confirmed/s);
  assert.match(listing, /No snapshot before the action/);
});

test('cancelled review leaves changes pending and an engine failure cannot authorize undo', async () => {
  const path = join(fixtureRoot, 'failed-action.txt'); writeFileSync(path, 'before\n');
  const h = harness({ ask: async () => 'cancel' });
  documentRead(h, 1, 'failed.txt', pathToFileURL(path).href); documentCall(h, 2);
  writeFileSync(path, 'partial change\n');
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text:
    `Window: "failed.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}` }] } });
  reviewCall(h, 3); await settle();
  assert.match(h.toClient.find(m => m.id === 3).result.content[0].text, /pending/);
  reviewCall(h, 4, { op: 'list' });
  assert.match(h.toClient.at(-1).result.content[0].text, /Undo refused/);
  assert.equal(readFileSync(path, 'utf8'), 'partial change\n');
});

test('a js call sent with Bash\'s command parameter reaches the engine as code', async () => {
  const h = harness({ changeReview: false });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { command: 'await cua.getState()', title: 't' } } });
  await tick();
  const sent = h.toServer.find(m => m.id === 1);
  assert.equal(sent.params.arguments.command, undefined);
  assert.match(sent.params.arguments.code, /await cua\.getState\(\)/);
});

test('noWindowsAvailable after a close shortcut is reported as the closed last window, not an error', async () => {
  const h = harness({ changeReview: false });
  const call = (id, code) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
  const failed = id => ({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Computer Use server error -10005: noWindowsAvailable' }] } });
  call(1, 'await app.pressKey("super+w"); await app.getAXState()'); await tick();
  h.fromServer(failed(1)); await tick();
  const closed = h.toClient.find(m => m.id === 1);
  assert.equal(closed.result.isError, false);
  assert.match(closed.result.content[0].text, /no windows left/);
  call(2, 'await app.getAXState()'); await tick();
  h.fromServer(failed(2)); await tick();
  const other = h.toClient.find(m => m.id === 2).result;
  assert.equal(other.isError, true, 'without a close it stays an error');
  assert.match(other.content.at(-1).text, /another Space.*full screen or Split View/);
  assert.equal(closed.result.content.some(c => /another Space/.test(c.text)), false);
});

test('sleight\'s rules follow the engine\'s first-call docs once per session, so Claude needs no skill turn', async () => {
  const h = harness({ changeReview: false, firstCallRules: '# Driving Mac apps with sleight\nRULES' });
  const docs = '## Computer Use\n\nControl native apps.\n';
  const call = (id, code) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
  const reply = (id, text) => h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  call(1, 'let app = await cua.getApp("Calculator")'); await tick();
  reply(1, docs + 'Window: "Calculator", App: Calculator'); await tick();
  const first = h.toClient.find(m => m.id === 1).result.content;
  assert.match(first.at(-1).text, /RULES/);
  assert.equal(first.filter(c => /RULES/.test(c.text ?? '')).length, 1);
  call(2, 'await app.getAXState()'); await tick();
  reply(2, 'Window: "Calculator", App: Calculator'); await tick();
  assert.doesNotMatch(JSON.stringify(h.toClient.find(m => m.id === 2)), /RULES/);
  h.fromClient({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js_reset', arguments: {} } }); await tick();
  reply(4, 'reset'); await tick();
  call(5, 'let app = await cua.getApp("Calculator")'); await tick();
  reply(5, docs + 'Window: "Calculator", App: Calculator'); await tick();
  assert.doesNotMatch(JSON.stringify(h.toClient.find(m => m.id === 5)), /RULES/, 'Claude already has them');
});

test('without rules configured, the first-call docs pass unchanged', async () => {
  const h = harness({ changeReview: false });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("Calculator")' } } }); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '## Computer Use\n\nx\nWindow: "Calculator", App: Calculator' }] } }); await tick();
  assert.equal(h.toClient.find(m => m.id === 1).result.content.length, 1);
});

test('sleight\'s tools load up front, so Claude needs no tool-search turn; turn_ended stays internal', async () => {
  const h = harness({ changeReview: false, localTools: { tools: [{ name: 'drag', description: 'Drag.', inputSchema: {} }], call: async () => ({}) } });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [
    { name: 'js', description: 'Control native apps.', inputSchema: {}, _meta: { other: 1 } },
    { name: 'js_reset', description: 'Reset.', inputSchema: {} },
    { name: 'turn_ended', description: 'End.', inputSchema: {} }] } }); await tick();
  const tools = h.toClient.find(m => m.id === 1).result.tools;
  assert.deepEqual(tools.find(t => t.name === 'js')._meta, { other: 1, 'anthropic/alwaysLoad': true });
  assert.equal(tools.find(t => t.name === 'js_reset')._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(tools.find(t => t.name === 'drag')._meta?.['anthropic/alwaysLoad'], true, 'local tools too: Claude searched before its first drag');
  assert.equal(tools.find(t => t.name === 'turn_ended')?._meta?.['anthropic/alwaysLoad'], undefined);
});

test('a result names each pre-approval grant once, however many actions it covered', async () => {
  const h = harness({ preapproved: preapproved(), stderr: { write: () => {} } });
  flowCall(h, 1, 'for (const id of ["One", "Two", "Three"]) await app.click({ id })'); await tick();
  h.fromServer(appApproval(11)); h.fromServer(appApproval(12)); h.fromServer(appApproval(13)); await tick();
  flowAnswer(h, 1, 'Calculator state'); await tick();
  const text = h.toClient.find(m => m.id === 1).result.content.map(c => c.text).join('\n');
  assert.equal(text.match(/pre-approved by the user's list/g)?.length, 1, text);
});

test('getAXState({ disableDiffing: true }) in Claude\'s code returns the whole tree, as sleight\'s advice promises', async () => {
  const h = harness({ changeReview: false });
  const rows = Array.from({ length: 40 }, (_, i) => `\t${i + 1} button Key ${i}`).join('\n');
  const call = (id, code) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
  const { GUARD_MARK } = await import('../plugins/sleight/lib/compact-reads.mjs');
  const tree = `Window: "Calculator", App: Calculator.\n0 standard window Calculator, ID: main\n${rows}`;
  call(1, 'await app.getAXState()'); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: GUARD_MARK + tree }] } }); await tick();
  call(2, 'await app.getAXState()'); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: GUARD_MARK + tree }] } }); await tick();
  assert.match(h.toClient.find(m => m.id === 2).result.content[0].text, /no change/);
  call(3, 'await app.getAXState({ disableDiffing: true })'); await tick();
  h.fromServer({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: GUARD_MARK + tree }] } }); await tick();
  assert.match(h.toClient.find(m => m.id === 3).result.content[0].text, /Key 39/);
});

test('an action written as a statement without await is refused before it reaches the engine', async () => {
  // A failed un-awaited action can end the engine's session and every handle (3/3, 2026-10-07).
  const h = harness({ changeReview: false });
  const call = (id, code) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
  call(1, 'app.click(3); await app.getAXState()'); await tick();
  call(2, 'app.typeText("x")\nawait app.click(1)'); await tick();
  for (const id of [1, 2]) {
    const reply = h.toClient.find(m => m.id === id);
    assert.equal(reply?.result?.isError, true, `call ${id}`);
    assert.match(reply.result.content[0].text, /await/);
    assert.ok(!h.toServer.some(m => m.id === id), `call ${id} never reached the engine`);
  }
  call(3, 'await app.click(3); for (const k of ["a"]) await app.pressKey(k); const t = await app.getAXState(); t'); await tick();
  call(4, 'await Promise.all([app.click(1)]); await app.click(2).then(() => 1)'); await tick();
  call(5, 'await app.typeText("app.click(9); done")'); await tick();
  call(6, 'await app.click(1); app.pressKey("super+c")'); await tick();
  for (const id of [3, 4, 5, 6]) assert.ok(h.toServer.some(m => m.id === id), `call ${id} is forwarded`);
});

// A PNG and a JPEG header with only the size fields that imageSize reads.
const pngOf = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b.toString('base64'); };
const jpegOf = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');

test('imageSize reads PNG and JPEG sizes and screenshotOf names the one app in the result', () => {
  assert.deepEqual(imageSize(pngOf(1312, 844)), { width: 1312, height: 844 });
  assert.deepEqual(imageSize(jpegOf(1312, 844)), { width: 1312, height: 844 });
  assert.equal(imageSize('bm90IGFuIGltYWdl'), undefined);
  const content = [{ type: 'text', text: 'Window: "a.txt", App: TextEdit.' }, { type: 'image', data: jpegOf(1312, 844), mimeType: 'image/jpeg' }];
  assert.deepEqual(screenshotOf(content), ['TextEdit', { width: 1312, height: 844 }]);
  assert.equal(screenshotOf([content[1]]), undefined, 'no app named');
  assert.equal(screenshotOf([...content, { type: 'text', text: 'Window: "b", App: Chess.' }]), undefined, 'two apps');
});

test('drag gets the size of the app\'s latest engine screenshot, so it can convert pixels to points', async () => {
  const calls = [];
  const h = harness({ changeReview: false, localTools: { tools: [{ name: 'drag', description: 'Drag.', inputSchema: {} }],
    call: async (name, args) => { calls.push(args); return { content: [{ type: 'text', text: 'ok' }] }; } } });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.getScreenshot()' } } });
  await tick();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Window: "a.txt", App: TextEdit.' }, { type: 'image', data: jpegOf(1312, 844), mimeType: 'image/jpeg' }] } });
  await tick();
  h.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit', from: [90, 77], to: [476, 77], screenshot: [1, 1] } } });
  h.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drag', arguments: { app: 'Chess', from: [1, 2], to: [3, 4] } } });
  await settle();
  assert.deepEqual(calls[0].screenshot, [1312, 844]);
  assert.equal(calls[1].screenshot, undefined, 'no screenshot of Chess, and Claude can\'t supply one');
});
