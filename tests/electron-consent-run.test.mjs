import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConsentRun } from '../bench/electron-consent-run.mjs';

// The owner-operated run, driven here by a scripted fake channel. No host is compiled, no card is shown.
function fake(clicks) {
  const events = new WeakSet(), seen = [], queue = [...clicks];
  return { seen, authenticate: event => events.delete(event), revoke() {},
    present(id, data, choices, deliver) {
      const choice = queue.shift(); seen.push({ kind: data.kind ?? 'payment', choices });
      setImmediate(() => { const event = { id, choice }; events.add(event); deliver(event); });
    } };
}
const run = async (t, clicks) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'epv3-run-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ui = fake(clicks), lines = [];
  return { ui, lines, result: await runConsentRun({ ui, directory, say: line => lines.push(line), wait: 60000 }) };
};

test('the consent run shows eight cards, checks every step, and writes a receipt with no secrets', async t => {
  const { ui, result, lines } = await run(t, ['once', 'session', 'always', 'cancel', 'relaunch', 'cancel', 'once', 'cancel']);
  assert.equal(result.passed, true, JSON.stringify(result.steps.filter(step => !step.ok)));
  assert.equal(result.cards, 8); assert.deepEqual(ui.seen.map(card => card.kind), ['debugger', 'debugger', 'debugger', 'debugger', 'relaunch', 'relaunch', 'payment', 'debugger']);
  assert.deepEqual(result.steps.map(step => step.id), ['debugger-once', 'debugger-session', 'debugger-session-next-turn', 'debugger-always', 'grant-file-mode', 'always-new-process',
    'changed-build-cancel', 'engine-refused', 'relaunch', 'relaunch-ticket-spends-once', 'relaunch-cancel', 'app-document-payment-sheet', 'revoke-removes-always', 'after-revoke-asks-again']);
  assert.doesNotMatch(JSON.stringify(result), /nonce|secret|password|token/i); assert.ok(lines.some(line => /Click "Always allow"/.test(line)));
});
test('a different click is recorded as a mismatch, never as success', async t => {
  const { result } = await run(t, ['session', 'session', 'always', 'cancel', 'relaunch', 'cancel', 'once', 'cancel']);
  assert.equal(result.passed, false); assert.equal(result.steps[0].id, 'debugger-once'); assert.equal(result.steps[0].ok, false); assert.equal(result.steps[0].result.scope, 'session');
});
test('a cancelled Always step fails the run and stops it short of the payment sheet', async t => {
  const { result } = await run(t, ['once', 'session', 'cancel', 'cancel', 'relaunch', 'cancel', 'once', 'cancel']);
  assert.equal(result.passed, false); assert.equal(result.steps.find(step => step.id === 'debugger-always').ok, false);
  assert.equal(result.steps.some(step => step.id === 'app-document-payment-sheet'), false, 'no Always grant, so no app binding and no payment step');
});
