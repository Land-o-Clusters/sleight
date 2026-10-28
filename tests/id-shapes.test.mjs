// FT1c: { id } written as an element number or a label. form-travel (race-1017): Haiku sent { id: "18" } for element 18 in
// 2 of 3 Safari runs (r3, and failed-safari-pid-1816 r1 with "18", "20" and "22") and { id: "Reference code" } in r2, which
// reached the field's text label and the engine refused it (-10005, not settable). Each cost a call. The trees are the trace's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { guardedCode, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

// Safari's URL sits on the HTML content row, not the root, so the header carries none.
const window = { title: 'sleight benchmark — Book a trip · Skyway', app: 'Safari', url: null };
const form = (extra = []) => [`Window: ${JSON.stringify(window.title)}, App: Safari.`,
  `0 standard window ${window.title}, ID: SafariWindow`, '\t1 split group', '\t\t3 tab group', '\t\t\t4 scroll area',
  '\t\t\t\t5 HTML content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel', '\t\t\t\t\t8 container',
  '\t\t\t\t\t\t17 text Reference code', '\t\t\t\t\t\t18 text field (settable) Reference code', '\t\t\t\t\t\t19 text Full name',
  '\t\t\t\t\t\t20 text field (settable) Full name', '\t\t\t\t\t\t21 text Email', '\t\t\t\t\t\t22 email field (settable) Email',
  '\t\t\t\t\t\t23 text Dates', '\t\t\t\t\t\t24 text field Dates, Placeholder: Check-in – check-out', ...extra,
  '\t\t\t\t\t\t38 button Next', '\t40 toolbar', '\t\t52 button Description: New Tab, ID: NewTabButton'].join('\n');
// A date picker's day buttons carry plain numbers: { id: "18" } could then mean element 18 or the day labeled 18.
const withDay = form(['\t\t\t\t\t\t\t47 button 18']);

function relayFixture(t, text) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-id-shapes-'));
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory, holder: 'id-shapes' }) });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); removeTemp(directory); });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  call(1, 'let app = await cua.getApp("Safari")');
  serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text }], _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.Safari' } } } } }) + '\n');
  let id = 1;
  return code => {
    call(++id, code);
    const forwarded = sent.find(m => m.id === id)?.params.arguments.code ?? '';
    const update = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(forwarded)?.[1] ?? '{}');
    // The relay sends one call at a time: answer this one before the next.
    serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text: GUARD_MARK + text + GUARD_END }] } }) + '\n');
    const result = (received.find(m => m.id === id)?.result?.content ?? []).map(item => item.text ?? '').join('\n');
    return { forwarded, update, result };
  };
}

// CA2 compares dispatch with the source inspected before selector rewrites.
// Resolving an object selector to a number changes its literal arguments.
test('CA2 refuses a numeric-id substitution before any input is dispatched', t => {
  const act = relayFixture(t, form());
  const { forwarded, result } = act('await app.setValue({ id: "18" }, "p01"); await app.setValue({ id: "20" }, "Mira"); await app.click({ id: "NewTabButton" });');
  assert.equal(forwarded, '');
  assert.match(result, /cannot inspect JavaScript/);
});

test('FT1c: a numeric { id } with two readings, an unseen number or other keys is left for the guard', t => {
  const act = relayFixture(t, withDay);
  for (const code of ['await app.click({ id: "18" });', 'await app.click({ id: "99" });', 'await app.click({ id: "22", label: "Email" });']) {
    const { forwarded } = act(code);
    assert.ok(forwarded.includes(code), code);
  }
});

function guardFixture(current = form()) {
  const calls = [], output = [];
  const raw = { getAXState: async () => current };
  for (const name of ['click', 'setValue', 'pressKey', 'typeText']) raw[name] = async (...args) => { calls.push([name, ...args]); };
  const context = { app: raw, setTimeout, nodeRepl: { write: value => output.push(value) },
    cua: { getApp: async () => raw, listApps: async () => [] } };
  const run = code => runInNewContext(`(async () => { ${guardedCode(code, window, 'changed window', undefined, { focused: true })} })()`, context);
  return { run, calls, output };
}

test('FT1c: the guard never takes a numeric { id } for a label, and says how to name the element', async () => {
  const g = guardFixture(withDay);
  await assert.rejects(g.run('await app.click({ id: "18" });'), /no element with ID "18" in this window\.[^\n]*An element number goes bare: click\(18\)\./);
  assert.deepEqual(g.calls, []);
});

test('FT1c: setValue on a label-shaped { id } or { label } goes to the one settable element with that label', async () => {
  const g = guardFixture();
  await g.run('await app.setValue({ id: "Reference code" }, "p01"); await app.setValue({ label: "Full name" }, "Mira"); await app.setValue({ label: "Email" }, "m@x");');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['setValue', 18], ['setValue', 20], ['setValue', 22]]);
});

test('FT1c: a label-shaped { id } that a field and its text carry goes to the field for a click (lp1), and IDs still win', async () => {
  const g = guardFixture();
  await g.run('await app.click({ id: "Reference code" });');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['click', 18]]);
  g.calls.length = 0;
  await g.run('await app.click({ id: "NewTabButton" }); await app.click({ id: "Next" });');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['click', 52], ['click', 38]]);
  // Two settable fields with one label: no guess.
  const two = guardFixture(form(['\t\t\t\t\t\t30 text field (settable) Email']));
  await assert.rejects(two.run('await app.setValue({ label: "Email" }, "m@x");'), /3 elements with label "Email"/);
  assert.deepEqual(two.calls, []);
});

// Review F2: an earlier action in the call can open a window whose element has ID "18" (a date picker), so the tree
// Claude saw no longer settles what { id: "18" } means. A rewrite is reported with the element it went to.
test('CA2 leaves unchanged selectors alone and refuses a literal-changing substitution', t => {
  const act = relayFixture(t, form());
  for (const code of ['await app.click(24); await app.click({ id: "18" });', 'await app.pressKey("Tab"); await app.setValue({ id: "18" }, "x");',
    'for (const n of [1, 2]) await app.click({ id: "18" });']) {
    const { forwarded } = act(code);
    assert.ok(forwarded.includes(code), code);
  }
  const { forwarded, result } = act('await app.setValue({ id: "18" }, "p01"); await app.click(38);');
  assert.equal(forwarded, '');
  assert.match(result, /cannot inspect JavaScript/);
});

// Review F3: a leading zero would reach the engine as an octal literal (010 is 8 in sloppy mode).
test('CA2 refuses a leading-zero id substitution and keeps an unchanged label selector', t => {
  const { forwarded, result } = relayFixture(t, form())('await app.setValue({ id: "018" }, "p01");');
  assert.equal(forwarded, '');
  assert.match(result, /cannot inspect JavaScript/);
  const labeled = relayFixture(t, form(['\t\t\t\t\t\t\t47 button 18']))('await app.click({ id: "018" });');
  assert.ok(labeled.forwarded.includes('await app.click({ id: "018" });'));
});

// Re-review: an action of any spelling before the { id }, or an { id } that can run more than once or later (a callback,
// a function or arrow body, recursion), leaves Claude's tree unable to settle it. Only a top-level statement with nothing
// but reads before it is rewritten.
test('CA2 refuses computed native methods and literal-changing id rewrites', t => {
  const act = relayFixture(t, form());
  for (const code of [
    'await app["click"](24); await app.click({ id: "18" });',
    'await app[`click`](24); await app.click({ id: "18" });',
    'const m = "click"; await app[m](24); await app.click({ id: "18" });',
    'await helper(); await app.click({ id: "18" });',
    'await Array.from([1, 2], () => app.click({ id: "18" }));',
    'await Promise.all([1].flatMap(() => [app.click({ id: "18" })]));',
    '[1].filter(() => app.click({ id: "18" }));',
    '[1].find(n => app.click({ id: "18" }));',
    '[1].some(n => app.click({ id: "18" }));',
    '[1].reduce(async (p) => { await p; await app.click({ id: "18" }); }, null);',
    'const go = () => app.click({ id: "18" }); await go(); await go();',
    'async function go(n) { await app.click({ id: "18" }); if (n) await go(n - 1); } await go(2);',
    '(async () => { await app.click({ id: "18" }); })();',
    'await app.click(24).then(() => app.click({ id: "18" }));',
  ]) {
    const { forwarded, result } = act(code);
    // CA2 refuses an unknown computed native method before runtime dispatch.
    if (code.includes('app[m]')) {
      assert.equal(forwarded, '');
      assert.match(result, /cannot inspect JavaScript/);
    } else assert.ok(forwarded.includes(code), code);
  }
  for (const code of ['const s = await app.getAXState(); await app.setValue({ id: "18" }, "p01");',
    'if (true) await app.setValue({ id: "18" }, "p01");']) {
    const { forwarded, result } = act(code);
    assert.equal(forwarded, '', code);
    assert.match(result, /cannot inspect JavaScript/);
  }
});

// lp1 (fix 5), race-1017 b7: { label: "Country" } and { label: "City" } (Safari r2 calls 10 and 13) and { label: "Dates" } (r3
// call 3) each matched the static text above the control and the control, and the guard stopped: 2.2 to 3.8 s a run.
test('lp1: a click on a label shared by static text and one control goes to the control; two controls still stop', async () => {
  const destination = form(['\t\t\t\t\t\t25 text Country', '\t\t\t\t\t\t26 pop up button (collapsed) Country, Value: Choose a country, Secondary Actions: Expand',
    '\t\t\t\t\t\t27 text City', '\t\t\t\t\t\t28 pop up button (collapsed) City, Value: Choose a city, Secondary Actions: Expand']);
  const g = guardFixture(destination);
  await g.run('await app.click({ label: "Country" }); await app.click({ label: "City" }); await app.click({ label: "Dates" }); await app.click("Dates");');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['click', 26], ['click', 28], ['click', 24], ['click', 24]]);
  // Two controls stop, and so do two static texts with no control.
  const two = guardFixture(form(['\t\t\t\t\t\t25 text Country', '\t\t\t\t\t\t26 pop up button Country', '\t\t\t\t\t\t27 button Country']));
  await assert.rejects(two.run('await app.click({ label: "Country" });'), /3 elements with label "Country"/);
  assert.deepEqual(two.calls, []);
  const textOnly = guardFixture(form(['\t\t\t\t\t\t25 text Country, Help: x', '\t\t\t\t\t\t26 text Country']));
  await assert.rejects(textOnly.run('await app.click({ label: "Country" });'), /2 elements with label "Country"/);
});

// lp1 review: the control the shared label names is the one clicked, whatever its role, and a disabled control is still the
// control (before, the enabled filter left only the static text, and the click went to text that does nothing).
test('lp1 review: checkbox, link, submit and disabled controls that share a label with static text get the click', async () => {
  const rows = ['\t\t\t\t\t\t25 text Subscribe', '\t\t\t\t\t\t26 checkbox Subscribe, Value: 0', '\t\t\t\t\t\t27 text Terms', '\t\t\t\t\t\t28 link Terms',
    '\t\t\t\t\t\t29 text Submit', '\t\t\t\t\t\t30 button Submit', '\t\t\t\t\t\t31 text Pay', '\t\t\t\t\t\t32 button (disabled) Pay'];
  const g = guardFixture(form(rows));
  await g.run('await app.click({ label: "Subscribe" }); await app.click({ label: "Terms" }); await app.click("Submit"); await app.click({ label: "Pay" });');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['click', 26], ['click', 28], ['click', 30], ['click', 32]]);
  // A disabled control beside an enabled one with the label: two controls, no guess about the text.
  const two = guardFixture(form(['\t\t\t\t\t\t31 text Pay', '\t\t\t\t\t\t32 button (disabled) Pay', '\t\t\t\t\t\t33 link Pay']));
  await two.run('await app.click({ label: "Pay" });');
  assert.deepEqual(two.calls.map(c => c.slice(0, 2)), [['click', 33]], 'the enabled preference still picks among controls');
});
