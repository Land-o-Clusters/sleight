import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { GUARD_MARK } from '../plugins/sleight/lib/document-scope.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

const tree = (app, line) => `Window: "${app}", App: ${app}.\n0 standard window\n\t2 ${line}`;
const a = tree('First', 'splitter -1'), b = tree('Second', 'button Target, ID: target');
function fixture(t, slow = false) {
  if (slow) t.mock.timers.enable({ apis: ['Date'] });
  const directory = mkdtempSync(join(tmpdir(), 'sleight-number-window-'));
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, messages] of [[serverIn, sent], [clientOut, received]]) {
    stream.on('data', bytes => messages.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  }
  const inputLease = new InputLease({ directory, holder: 'number-window' });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); removeTemp(directory); });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, text, appId) => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }],
    _meta: { 'codex/toolSurface': { app: { appId } } } } }) + '\n');
  call('b', 'let second = await cua.getApp("fixture.second")'); reply('b', b, 'fixture.second');
  call('a', 'let first = await cua.getApp("fixture.first")');
  if (slow) t.mock.timers.tick(3000);
  reply('a', a, 'fixture.first');
  const act = code => {
    call('act', code);
    const forwarded = sent.find(m => m.id === 'act');
    const update = forwarded && JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(forwarded.params.arguments.code)[1]);
    return { forwarded, update, stopped: received.find(m => m.id === 'act') };
  };
  return { act, call, reply, inputLease };
}

// CC13 review: a list number passed to pickFromList is a literal too, so the guard checks it against the line Claude saw.
for (const method of ['click', 'setValue', 'selectText', 'performSecondaryAction', 'scroll', 'pickFromList']) {
  test(`${method} uses the numbered handle's seen window and keeps the lease target`, t => {
    const f = fixture(t);
    // PK1 checks native click options. The string value belongs only to the other methods in this fixture.
    const { update, stopped } = f.act(`await second.${method}(${method === 'click' ? '2' : '2, "value"'})`);
    assert.ok(update, stopped?.result?.content?.[0]?.text);
    assert.deepEqual(update.seenLines, { 2: 'button Target, ID: target' });
    // The parent from the same tree, so a batch remap can't follow a line to another parent (review of X5).
    assert.deepEqual(update.seenParents, { 2: 'standard window' });
    assert.deepEqual(update.uniqueSeen, [2]);
    assert.equal(update.window.app, 'First');
    assert.deepEqual([...f.inputLease.owned.keys()], [leaseKey(update.window)]);
  });
}

async function runNumberCheck(update, current) {
  const { guardedCode } = await import('../plugins/sleight/lib/document-scope.mjs');
  const { lease: _lease, ...checks } = update;
  const context = { cua: { getApp: async () => ({ getAXState: async () => current, click: async () => {} }) }, nodeRepl: { write() {} } };
  await runInNewContext(`(async () => { ${guardedCode('globalThis.second = await cua.getApp("fixture.second");', undefined)} })()`, context);
  return runInNewContext(`(async () => { ${guardedCode('await second.click(2);', update.window, update.reason, undefined, checks)} })()`, context);
}

test('unchanged second-window number passes the number check while the window lease still stops it', async t => {
  const { update } = fixture(t).act('await second.click(2)');
  await assert.rejects(runNumberCheck(update, b), /Input lease stopped this action: app changed\. 0 earlier actions in this call ran/);
});

test('a changed second-window element stops against its own seen line', async t => {
  const { update } = fixture(t).act('await second.click(2)');
  // LW2: the guard reports the window change (the lease holds First) ahead of the element check; both stop before input.
  await assert.rejects(runNumberCheck(update, a.replaceAll('First', 'Second')), /Input lease stopped this action: app changed\. 0 earlier actions/);
});

test('an unknown numbered handle keeps the existing seen-line check', t => {
  const { update } = fixture(t).act('await app.click(2)');
  assert.deepEqual(update.seenLines, { 2: 'splitter -1' });
  assert.equal(update.window.app, 'First');
});

test('a known handle whose read showed no element lines keeps the existing check', t => {
  const f = fixture(t);
  f.call('empty', 'let empty = await cua.getApp("fixture.empty")');
  f.reply('empty', 'Window: "Empty", App: Empty.', 'fixture.empty');
  f.call('again', 'await first.getAXState()'); f.reply('again', a, 'fixture.first');
  const { update } = f.act('await empty.click(2)');
  assert.deepEqual(update.seenLines, { 2: 'splitter -1' });
});

test('a slow prior read from another handle cannot supply the numbered action tree', t => {
  const { update } = fixture(t, true).act('await second.click(2)');
  assert.equal(update.prior, undefined);
  assert.deepEqual(update.seenLines, { 2: 'button Target, ID: target' });
});

function renumberFirst(f) {
  const rows = (app, count) => Array.from({ length: count }, (_, i) => `\t${i + 2} link ${app} ${i}`).join('\n');
  const header = app => `Window: "${app}", App: ${app}.\n0 standard window\n`;
  f.call('long-b', 'await second.getAXState()'); f.reply('long-b', header('Second') + rows('Second', 120), 'fixture.second');
  f.call('long-a', 'await first.getAXState()'); f.reply('long-a', header('First') + rows('First', 60), 'fixture.first');
  f.call('grow', 'await first.click(2)');
  f.reply('grow', GUARD_MARK + header('First') + '\t2 link First 0\n\t3 link Inserted\n' +
    Array.from({ length: 59 }, (_, i) => `\t${i + 4} link First ${i + 1}`).join('\n'), 'fixture.first');
}

test('renumbering the lease window cannot remap another handle to the lease window line', t => {
  const f = fixture(t); renumberFirst(f);
  const { forwarded, update } = f.act('await second.click(10)');
  assert.ok(forwarded);
  assert.match(forwarded.params.arguments.code, /await second\.click\(10\)/);
  assert.deepEqual(update.seenLines, { 10: 'link Second 8' });
});

test('renumbering the lease window cannot reject a number seen only on the other handle', t => {
  const f = fixture(t); renumberFirst(f);
  const { forwarded, update } = f.act('await second.click(99)');
  assert.ok(forwarded);
  assert.deepEqual(update.seenLines, { 99: 'link Second 97' });
});

for (const code of ['await second.click(2); await first.click(2)', 'await first.click(2); await second.setValue(2, "value")']) {
  test(`numbered actions on two handles stop before forwarding: ${code}`, t => {
    const { forwarded, stopped } = fixture(t).act(code);
    assert.equal(!!forwarded, false);
    assert.equal(stopped.result.isError, true);
    assert.match(stopped.result.content[0].text, /numbered actions.*one handle/);
  });
}

test('after an action retitles the same app\'s window, the number check uses the current window, not the handle\'s old read', t => {
  const f = fixture(t);
  f.call('open', 'await first.click(2)');
  f.reply('open', GUARD_MARK + 'Window: "First sheet", App: First.\n0 standard window\n\t2 button Sheet OK', 'fixture.first');
  const { update } = f.act('await first.click(2)');
  assert.deepEqual(update.seenLines, { 2: 'button Sheet OK' });
});
