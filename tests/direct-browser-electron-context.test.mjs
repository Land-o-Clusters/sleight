// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { writeDataExport, EXPORT_LIMITS } from '../plugins/sleight/lib/direct-browser/export-file.mjs';
import { check } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { api as identity, instance, recipe } from './fixtures/electron-app.mjs';
// The v3 context, payment, upload and dialog adversarial cases of direct-browser-v3-context.test.mjs, run on an
// Electron app document. Against the old web-only join every case fails: it has no app binding and refuses a file: frame.
const api = await import('../plugins/sleight/lib/direct-browser/v3-context.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });
const consentApi = await import('../plugins/sleight/lib/direct-browser/electron-consent.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });
const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card', currency: 'USD' };
const payText = value => 'Pay ' + JSON.stringify(value);
const root = 'file:///Applications/Fixture.app/Contents/Resources/app/';

function fixture(text = payText(terms), options = {}) {
  assert.equal(typeof api.createV3Context, 'function');
  assert.equal(typeof identity.createAppBinding, 'function', 'typed app-document binding is required');
  const gate = { alive: true, closed: 0 };
  let document = {}, url = options.url ?? root + 'checkout.html', observed = options.observed ?? 'null', parent = options.parent ?? null, payment = true, inputName = 'Resume', ended = false;
  const app = options.app ?? identity.createAppBinding({ instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe,
    authority: { id: 'grant1', session: 'session', turn: options.grantTurn ?? null, current: () => gate.alive } });
  const frame = { url: () => url, parentFrame: () => parent }, state = { snapshotNo: 0, submitUnconfirmed: false };
  const element = { tag: 'button', kind: 'button', connected: true, visible: true, enabled: true, hit: true, submit: true, payment: true, form: true, formPayment: true };
  const handle = { ownerFrame: async () => frame, dispose: async () => {},
    async evaluate(fn, arg) {
      if (fn.name === 'focusCheckedNode') return f.focusOk;
      if (fn.name === 'samePageDocument') return arg === document;
      if (fn.name === 'ownDocument') return document;
      if (fn.name === 'inspectTarget') return { ...element, name: 'Continue', payment, formPayment: payment };
      if (fn.name === 'inspectElement') return { ...element, payment, formPayment: payment };
      if (fn.name === 'forwardInfo') return { label: false, areas: [] };
      if (fn.name === 'readPaymentPage') { const page = Object.fromEntries(Object.entries({ ...terms, ...f.pageTerms }).filter(([, v]) => v !== undefined)); return { origin: observed, page, name: inputName, ...(arg === true ? { unchecked: { ...page, ...f.uncheckedTerms } } : {}) }; }
      throw Error('unsupported page reader: ' + fn.name);
    },
    evaluateHandle: async fn => { assert.equal(fn.name, 'ownDocument'); return document; } };
  const read = handle.evaluate;
  handle._connection = { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'utility',
    evaluateExpression: async (source, unused, args) => read({ name: /function (\w+)/.exec(source)[1] }, args[1]),
    evaluateExpressionHandle: async source => { assert.match(source, /function ownDocument/); return document; } }) } }) };
  handle.evaluate = () => assert.fail('context authority must never read MAIN world');
  const locator = { elementHandle: async () => handle };
  const binding = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text }, () => !ended);
  const ctx = api.createV3Context({ binding, app, ...options.context });
  const f = { ctx, app, gate, binding, handle, state, pageTerms: {}, uncheckedTerms: {}, focusOk: true,
    target: extra => ({ page: new EventEmitter(), state, locator, ref: 'e1', element: { ...element }, ...extra }),
    navigate() { document = {}; }, goto(next, origin = 'null') { url = next; observed = origin; document = {}; }, swap(next) { url = next; },
    end() { ended = true; }, ordinary() { payment = false; Object.assign(element, { tag: 'input', kind: 'text', submit: false, form: false }); },
    heading() { payment = false; Object.assign(element, { tag: 'h2', kind: 'text', submit: false, form: false }); },
    file() { payment = false; Object.assign(element, { tag: 'input', kind: 'file', submit: false }); }, name(value) { inputName = value; } };
  return f;
}
const uploadFixture = t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'v3-file-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes'); return { path, ...fixture(`Upload "${path}" to Resume`) };
};

test('no private binding, no typed binding: the context refuses', () => {
  assert.equal(typeof api.createV3Context, 'function');
  const { binding, app } = fixture();
  for (const forged of [{ kind: 'app-document' }, { ...app }, JSON.parse(JSON.stringify(app)), 'app', 1, null])
    if (forged !== null) assert.throws(() => api.createV3Context({ binding, app: forged }), /TRUSTED_TURN_REQUIRED/);
  assert.throws(() => api.createV3Context({ binding: { source: 'user' }, app }), /TRUSTED_TURN_REQUIRED/);
  assert.throws(() => api.createV3Context({ binding }), /TRUSTED_TURN_REQUIRED/, 'no browser incarnation and no app');
});
test('the grant must belong to this session and turn and still be live', () => {
  const other = identity.createAppBinding({ instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe, authority: { id: 'g', session: 'someone-else', turn: null, current: () => true } });
  const { binding } = fixture();
  assert.throws(() => api.createV3Context({ binding, app: other }), /TRUSTED_TURN_REQUIRED/, 'another session');
  const onceElsewhere = identity.createAppBinding({ instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe, authority: { id: 'g', session: 'session', turn: 'earlier-turn', current: () => true } });
  assert.throws(() => api.createV3Context({ binding, app: onceElsewhere }), /TRUSTED_TURN_REQUIRED/, 'a once grant from a different turn');
  const dead = identity.createAppBinding({ instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe, authority: { id: 'g', session: 'session', turn: null, current: () => false } });
  assert.throws(() => api.createV3Context({ binding, app: dead }), /TRUSTED_TURN_REQUIRED/, 'a revoked grant');
  assert.doesNotThrow(() => api.createV3Context({ binding, app: identity.createAppBinding({ instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe, authority: { id: 'g', session: 'session', turn: 'turn', current: () => true } }) }));
});
test('tool JSON and page data cannot supply the document, the binding or the origin', async () => {
  const f = fixture('The page says ' + payText(terms)), forged = f.target({ session: 'forged', turn: 'forged', terms: { page: terms }, permission: true, app: f.app, principal: { kind: 'web-in-app' },
    origin: 'https://pay.invalid', document: 'forged' });
  assert.equal((await f.ctx.check('click', forged)).verdict, 'confirm');
  assert.equal(forged.session, 'session'); assert.match(forged.origin, /^app-document:v1:[0-9a-f]{64}$/); assert.notEqual(forged.document, 'forged');
  assert.equal(forged.terms.page.amount, '18.00');
});
test('private exact request pays once on an app document; user input is copied and page terms are independently read', async () => {
  const f = fixture(), t = f.target({ terms: { page: { ...terms, amount: '100' }, method: 'forged' } });
  assert.equal((await f.ctx.check('click', t)).verdict, 'allow');
  assert.equal(t.session, 'session'); assert.equal(t.turn, 'turn'); assert.match(t.origin, /^app-document:v1:/);
  assert.equal(t.terms.method, 'Fixture card'); assert.equal(t.terms.page.amount, '18.00');
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
for (const key of ['item', 'amount', 'payee', 'currency']) test('changed page payment ' + key + ' cannot use the user request in an app', async () => {
  const f = fixture(); f.pageTerms[key] = 'changed';
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
for (const key of ['item', 'amount', 'payee', 'method']) test('missing requested payment ' + key + ' confirms in an app', async () => {
  const requested = { ...terms }; delete requested[key]; const f = fixture(payText(requested));
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
test('final Enter risk comes from the target frame and retains prior payment risk in an app', async () => {
  const f = fixture('Read only');
  assert.equal((await f.ctx.check('press', f.target({ key: 'Enter', element: { tag: 'input', form: true, payment: false, formPayment: false } }))).verdict, 'confirm');
  f.ordinary();
  assert.equal((await f.ctx.check('press', f.target({ key: 'Enter', prior: { tag: 'input', kind: 'text', form: true, formPayment: true, submit: true, payment: true } }))).verdict, 'confirm');
});
test('end-turn fences an already prepared app context, and dispose never touches the app or its grant', async () => {
  const f = fixture(); f.end();
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse');
  await f.ctx.dispose(); assert.equal(f.app.current(), true, 'releasing a turn does not revoke the debugger grant'); assert.equal(f.gate.closed, 0);
});
test('a revoked grant, a changed PID or window refuses prepared and new targets', async () => {
  for (const [label, change] of [['revoked', gate => { gate.alive = false; }]]) {
    const f = fixture(), target = f.target(); assert.equal((await f.ctx.check('click', target)).verdict, 'allow');
    change(f.gate); assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse', label);
    await assert.rejects(f.ctx.pressTarget(target, 'Enter'), /CHECKED_FOCUS_REQUIRED/, label);
  }
  const f = fixture('Read only'); f.ordinary(); const target = f.target(); assert.equal((await f.ctx.check('click', target)).verdict, 'allow');
  f.gate.alive = false; assert.equal(f.ctx.userMessage(), undefined, 'the user message is withheld once the grant is gone'); assert.equal((await f.ctx.check('wait', f.target())).verdict, 'refuse');
});
test('an app document that is not an app document is refused: scheme, root, parent and reported origin', async () => {
  for (const options of [{ url: 'data:text/html,hi' }, { url: 'blob:https://pay.invalid/1', observed: 'https://pay.invalid' }, { url: `file://${MAC_USERS}fixture/secret.html` },
    { url: 'http://pay.invalid/', observed: 'http://pay.invalid' }, { url: root + 'a.html', observed: 'https://pay.invalid' }, { url: 'other://main/x' },
    { url: 'fixture://main/x', parent: { url: () => 'https://pay.invalid/', parentFrame: () => null } }]) {
    const f = fixture(payText(terms), options);
    assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse', JSON.stringify(options));
  }
});
test('the web-only join still refuses file: and custom-scheme frames and keeps real HTTPS', async () => {
  for (const [url, origin, verdict] of [[root + 'a.html', 'null', 'refuse'], ['fixture://main/x', 'null', 'refuse'], ['https://fixture.invalid/c', 'https://fixture.invalid', 'allow']]) {
    // The same page fixture, with the typed binding left out of the context.
    const f = fixture(payText(terms), { url, observed: origin }), binding = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'r', text: payText(terms) }, () => true);
    const web = api.createV3Context({ binding, browser: 'bfixture' });
    assert.equal((await web.check('click', f.target())).verdict, verdict, url);
  }
});
test('a child HTTPS frame keeps its real origin and the same consent ticket rules', async () => {
  const events = new WeakSet(), presentations = [], parent = { url: () => root + 'index.html', parentFrame: () => null };
  const ui = { authenticate: e => events.delete(e), present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
  const f = fixture(payText({ ...terms, amount: '99.00' }), { url: 'https://pay.invalid/checkout', observed: 'https://pay.invalid', parent, context: { ui } });
  const t = f.target(); assert.equal((await f.ctx.check('click', t)).verdict, 'confirm');
  assert.equal(t.origin, 'https://pay.invalid'); assert.equal(presentations[0].data.operation.principal.kind, 'web-in-app');
  assert.equal(presentations[0].data.operation.origin, 'https://pay.invalid'); assert.equal(presentations[0].data.view.documentKind, 'web');
  assert.equal(presentations[0].data.operation.browserIncarnation, f.app.incarnation, 'the app instance rides in the incarnation field');
});
test('native consent stays one-use, exact-operation and authenticated, and names an app document', async () => {
  const events = new WeakSet(), presentations = [];
  const ui = { authenticate: e => events.delete(e), present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
  const f = fixture(payText({ ...terms, amount: '99.00' }), { context: { ui } });
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  assert.equal(presentations.length, 1); const { operation, view } = presentations[0].data;
  assert.equal(operation.payment.amount, '18.00'); assert.equal(operation.principal.kind, 'app-document'); assert.equal(operation.destination, operation.origin + '/');
  assert.equal(view.documentKind, 'app-document'); assert.match(view.origin, /^file:\/\/\/Applications\/Fixture\.app\//); assert.deepEqual(presentations[0].choices, ['once', 'cancel']);
  await presentations[0].deliver({ id: presentations[0].id, choice: 'once' });
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm', 'a reply the UI channel did not authenticate grants nothing');
  const last = presentations.at(-1), event = { id: last.id, choice: 'once' }; events.add(event); await last.deliver(event);
  const before = presentations.length;
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'allow');
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm'); assert.equal(presentations.length, before + 1); await f.ctx.dispose();
});
test('a ticket for one file cannot pay on another file that reports the same null origin', async () => {
  const events = new WeakSet(), presentations = [];
  const ui = { authenticate: e => events.delete(e), present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
  const f = fixture(payText({ ...terms, amount: '99.00' }), { context: { ui } });
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  const event = { id: presentations[0].id, choice: 'once' }; events.add(event); await presentations[0].deliver(event);
  f.swap(root + 'other.html'); f.navigate();
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm', 'the other document asks for its own consent'); assert.equal(presentations.length, 2);
  assert.notEqual(presentations[0].data.operation.origin, presentations[1].data.operation.origin);
});
test('a revoked grant voids a ticket the person already gave', async () => {
  const events = new WeakSet(), presentations = [];
  const ui = { authenticate: e => events.delete(e), present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
  const f = fixture(payText({ ...terms, amount: '99.00' }), { context: { ui } });
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  const event = { id: presentations[0].id, choice: 'once' }; events.add(event); await presentations[0].deliver(event);
  f.gate.alive = false; assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse');
});
test('upload stages only exact user-named bytes bound to this event, app document and input', async t => {
  const f = uploadFixture(t); f.file(); const target = f.target({ paths: [f.path] });
  assert.equal((await f.ctx.check('upload', target)).verdict, 'allow');
  const stage = await f.ctx.stageUploads(target, [f.path]);
  assert.equal(stage.payloads[0].buffer.toString(), 'fixture bytes'); stage.cleanup();
  await assert.rejects(f.ctx.stageUploads(target, [f.path]), /USER_NAMED_FILE_REQUIRED/);
  await f.ctx.dispose();
});
for (const change of ['different-path', 'different-input', 'changed-document', 'ended', 'swapped-file-same-null-origin', 'revoked', 'swapped-to-remote']) test('app upload refuses ' + change, async t => {
  const f = uploadFixture(t); f.file(); const target = f.target({ paths: [f.path] });
  assert.equal((await f.ctx.check('upload', target)).verdict, 'allow');
  if (change === 'different-input') f.name('Other'); if (change === 'changed-document') f.navigate(); if (change === 'ended') f.end();
  if (change === 'swapped-file-same-null-origin') f.swap(root + 'other.html');
  if (change === 'swapped-to-remote') f.goto('https://pay.invalid/', 'https://pay.invalid');
  if (change === 'revoked') f.gate.alive = false;
  await assert.rejects(f.ctx.stageUploads(target, change === 'different-path' ? [f.path + '.other'] : [f.path]), /USER_NAMED_FILE_REQUIRED/);
  await f.ctx.dispose();
});
for (const change of ['same-document', 'changed-document-and-origin']) test('upload request cannot be offered again after transfer in an app: ' + change, async t => {
  const f = uploadFixture(t); f.file(); const first = f.target({ paths: [f.path] });
  assert.equal((await f.ctx.check('upload', first)).verdict, 'allow'); (await f.ctx.stageUploads(first, [f.path])).cleanup();
  if (change !== 'same-document') f.goto(root + 'other.html');
  assert.equal((await f.ctx.check('upload', f.target({ paths: [f.path] }))).verdict, 'refuse'); await f.ctx.dispose();
});
for (const mode of ['own', 'other-dialog', 'long-lived', 'strict']) test('only the initiating input can allow its exact dialog once in an app: ' + mode, async () => {
  let clock = 100; const events = new WeakSet(), presentations = [];
  const ui = { authenticate: e => events.delete(e), present(id, data, choices, deliver) { presentations.push({ id, deliver }); } };
  const f = fixture(payText(terms), { context: { now: () => clock, ...(mode === 'strict' ? { confirmPayments: 'always', ui } : {}) } });
  const page = new EventEmitter(), target = f.target({ page });
  if (mode === 'strict') {
    assert.equal((await f.ctx.check('click', target)).verdict, 'confirm');
    const e = { id: presentations[0].id, choice: 'once' }; events.add(e); await presentations[0].deliver(e);
  }
  assert.equal((await f.ctx.check('click', target)).verdict, 'allow');
  f.ctx.beginInput(target); const dialog = {}; f.state.dialog = dialog; page.emit('dialog', dialog); f.ctx.finishInput(target);
  if (mode === 'other-dialog') f.state.dialog = {}; if (mode === 'long-lived' || mode === 'strict') clock += 60000;
  const d = { page, state: f.state, type: 'confirm', accept: true, message: payText({ item: terms.item, amount: terms.amount, payee: terms.payee, currency: 'USD' }) };
  assert.equal((await f.ctx.check('dialog', d)).verdict, mode !== 'other-dialog' ? 'allow' : 'refuse');
  if (mode !== 'other-dialog') assert.equal((await f.ctx.check('dialog', d)).verdict, 'refuse');
  await f.ctx.dispose();
});
test('a dialog opened by one app document cannot be accepted after the frame moved to another', async () => {
  const f = fixture(), page = new EventEmitter(), target = f.target({ page });
  assert.equal((await f.ctx.check('click', target)).verdict, 'allow');
  f.ctx.beginInput(target); const dialog = {}; f.state.dialog = dialog; page.emit('dialog', dialog); f.ctx.finishInput(target);
  f.swap(root + 'other.html');
  const d = { page, state: f.state, type: 'confirm', accept: true, message: payText({ item: terms.item, amount: terms.amount, payee: terms.payee, currency: 'USD' }) };
  assert.equal((await f.ctx.check('dialog', d)).verdict, 'refuse');
});
test('a real debugger grant drives the same fence: revoke the session and the context refuses at once', async () => {
  assert.equal(typeof consentApi.createElectronConsent, 'function');
  const events = new WeakSet(), cards = [];
  const ui = { authenticate: e => events.delete(e), present: (id, data, choices, deliver) => cards.push({ id, deliver }), revoke() {} };
  const consent = consentApi.createElectronConsent({ ui, store: consentApi.createGrantStore(), engineApproval: () => 'approved' });
  const pending = consent.requestDebugger(instance, { session: 'session', turn: 'turn' });
  const e = { id: cards[0].id, choice: 'once' }; events.add(e); cards[0].deliver(e); const { grant } = await pending;
  const app = consent.bindApp({ grant, instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe });
  const f = fixture(payText(terms), { app }); assert.equal((await f.ctx.check('click', f.target())).verdict, 'allow');
  consent.revokeSession('session'); assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse');
});

// Focus, history, dialog and activation cases from the web context suite, on an app document.
for (const key of ['Enter', 'Space']) test('refuses ' + key + ' in an app when the pinned ref cannot retain focus', async () => {
  const f = fixture('Read only'); f.heading(); f.focusOk = false;
  assert.equal((await f.ctx.check('press', f.target({ key, ref: 'e9' }))).verdict, 'refuse'); await f.ctx.dispose();
});
test('app dispatch never calls ElementHandle.press after checking focus', async () => {
  const f = fixture('Read only'); f.ordinary(); const keys = [], page = new EventEmitter();
  Object.assign(f.handle, { press: async () => { throw Error('unsafe refocusing press'); } });
  page.getByRef = () => ({ elementHandle: async () => f.handle, evaluate: async () => ({ submit: false, form: false }) });
  page.keyboard = { press: async key => keys.push(key) };
  let clock = 0;
  const run = createActionRunner({ check, snapshot: async () => ({ text: 'fixture', number: 1 }), now: () => clock, sleep: async ms => { clock += ms; } });
  const result = await run({ page, state: f.state }, [{ do: 'press', ref: 'e1', key: 'Enter' }], f.ctx);
  assert.deepEqual(keys, ['Enter']); assert.doesNotMatch(result.lines[0], /not run|unconfirmed/); await f.ctx.dispose();
});
for (const kind of ['reload', 'back', 'forward']) test(kind + ' cannot retry an unknown payment in an app, and an explicit request permits exactly one retry', async () => {
  const f = fixture(), target = f.target();
  assert.equal((await f.ctx.check('click', target)).verdict, 'allow');
  for (const pending of [true, false]) {
    f.state.submitUnconfirmed = pending ? { startedAt: 1, snapshotNo: 0 } : false;
    assert.equal((await f.ctx.check(kind, { page: target.page, state: f.state })).verdict, 'refuse', kind + ' pending=' + pending);
  }
  await f.ctx.dispose();
  const commands = { reload: 'Reload this page', back: 'Go back', forward: 'Go forward' }, g = fixture(commands[kind]);
  g.state.submitUnconfirmed = { startedAt: 1, snapshotNo: 0 };
  assert.equal((await g.ctx.check(kind, { state: g.state })).verdict, 'allow'); assert.equal((await g.ctx.check(kind, { state: g.state })).verdict, 'refuse'); await g.ctx.dispose();
});
test('a checked click in an app cannot preapprove an unrelated later dialog', async () => {
  const f = fixture(), target = f.target();
  assert.equal((await f.ctx.check('click', target)).verdict, 'allow'); assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  const result = await f.ctx.check('dialog', { page: target.page, state: f.state, type: 'confirm', accept: true, message: payText({ item: terms.item, amount: terms.amount, payee: terms.payee, currency: 'USD' }) });
  assert.equal(result.verdict, 'refuse'); await f.ctx.dispose();
});
test('dismissing a page dialog in an app before an allowed click remains available', async () => {
  const f = fixture('Read only'), page = new EventEmitter();
  assert.equal((await f.ctx.check('dialog', { page, state: f.state, type: 'alert', message: 'Pay now', accept: false })).verdict, 'allow'); await f.ctx.dispose();
});
for (const end of ['answer', 'dialogclosed', 'navigation', 'page-close', 'document-change']) test('an ordinary dialog in an app lives until its own end: ' + end, async () => {
  let clock = 0; const f = fixture('Continue', { context: { now: () => clock } }); f.ordinary();
  const page = new EventEmitter(), target = f.target({ page }), dialog = {};
  assert.equal((await f.ctx.check('click', target)).verdict, 'allow');
  f.ctx.beginInput(target); f.state.dialog = dialog; page.emit('dialog', dialog); f.ctx.finishInput(target);
  if (end === 'answer') clock += 120000;
  const answer = { page, state: f.state, type: 'confirm', accept: true, message: 'Continue with the fixture?' };
  if (end === 'dialogclosed') page.emit('dialogclosed', dialog);
  if (end === 'navigation') page.emit('framenavigated', await f.handle.ownerFrame());
  if (end === 'page-close') page.emit('close');
  if (end === 'document-change') { f.navigate(); page.emit('framenavigated', await f.handle.ownerFrame()); }
  if (end === 'answer') assert.equal((await f.ctx.check('dialog', answer)).verdict, 'allow');
  assert.equal((await f.ctx.check('dialog', answer)).verdict, 'refuse');
  await f.ctx.dispose();
  for (const event of ['dialog', 'dialogclosed', 'framenavigated', 'close']) assert.equal(page.listenerCount(event), 0);
});


test('G3C one authenticated turn caps exports across Electron windows and window recreation', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'g3c-electron-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'export-turn', id: 'request', text: 'Export table' }, () => true);
  const windowContext = (id, turnBinding = binding) => {
    const app = identity.createAppBinding({ instance, window: { id, epoch: 1 }, brokerEpoch: 1, recipe,
      authority: { id: 'grant', session: 'session', turn: null, current: () => true } });
    const ctx = api.createV3Context({ binding: turnBinding, app });
    t.after(() => ctx.dispose()); return ctx;
  };
  const first = windowContext(7), second = windowContext(8);
  const data = { kind: 'list', columns: [], rows: [['row']], complete: true, reasons: [] };
  for (let i = 0; i < EXPORT_LIMITS.turnFiles; i++) writeDataExport(data, {}, i % 2 ? first : second, { userHome: root });
  assert.throws(() => writeDataExport(data, {}, first, { userHome: root }), /turn.*count/);
  await first.dispose();
  assert.throws(() => writeDataExport(data, {}, windowContext(9), { userHome: root }), /turn.*count/);
  assert.equal(readdirSync(join(root, 'Library/Application Support/sleight/exports')).length, 8);
  const next = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'next-turn', id: 'request', text: 'Export table' }, () => true);
  assert.doesNotThrow(() => writeDataExport(data, {}, windowContext(10, next), { userHome: root }));
});

test('G3C authenticated turn byte cap is shared across Electron windows', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'g3c-electron-bytes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'bytes-turn', id: 'request', text: 'Export table' }, () => true);
  const windows = [7, 8].map(id => {
    const app = identity.createAppBinding({ instance, window: { id, epoch: 1 }, brokerEpoch: 1, recipe,
      authority: { id: 'grant', session: 'session', turn: null, current: () => true } });
    const ctx = api.createV3Context({ binding, app }); t.after(() => ctx.dispose()); return ctx;
  });
  const data = { kind: 'list', columns: [], rows: [['桃'.repeat(3900000)]], complete: true, reasons: [] };
  writeDataExport(data, {}, windows[0], { userHome: root }); writeDataExport(data, {}, windows[1], { userHome: root });
  assert.throws(() => writeDataExport(data, {}, windows[0], { userHome: root }), /turn.*byte/);
  assert.equal(readdirSync(join(root, 'Library/Application Support/sleight/exports')).length, 2);
});
