import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createUiChannel } from '../plugins/sleight/lib/direct-browser/host.mjs';

function channel() {
  const read = new PassThrough(), write = new PassThrough(), outbound = [], delivered = [];
  let losses = 0;
  write.on('data', bytes => outbound.push(JSON.parse(bytes)));
  const ui = createUiChannel({ read, write, onLoss: () => losses++ });
  const present = id => ui.present(id, { operation: { secret: 'private fixture' } }, ['once', 'cancel'], event => delivered.push(event));
  const respond = (id, extra = {}) => read.write(JSON.stringify({ id, choice: 'once', nonce: outbound.at(-1).nonce, ...extra }) + '\n');
  return { ui, read, write, outbound, delivered, present, respond, losses: () => losses };
}
test('UI authentication is an unforgeable one-use object from a private channel', () => {
  const f = channel(); f.present('s1-op1');
  assert.equal(f.ui.authenticate({ id: 's1-op1', approved: true }), false);
  f.respond('s1-op1'); const event = f.delivered[0];
  assert.equal(f.ui.authenticate({ ...event }), false);
  assert.equal(f.ui.authenticate(event), true); assert.equal(f.ui.authenticate(event), false);
  assert.doesNotMatch(JSON.stringify(event), /private fixture|nonce/); f.ui.close();
});
for (const [label, extra] of Object.entries({ nonce: { nonce: 'b'.repeat(64) }, choice: { choice: 'always' }, session: { id: 's2-op1' }, extra: { approved: true } }))
  test('forged UI response refuses ' + label, () => {
    const f = channel(); f.present('s1-op1'); f.respond('s1-op1', extra);
    assert.equal(f.delivered.length, 0); assert.equal(f.losses(), 1); f.ui.close();
  });
test('revoked and replayed UI responses never grant another operation', () => {
  for (const revoke of [false, true]) {
    const f = channel(); f.present('op1');
    if (revoke) f.ui.revoke();
    f.respond('op1'); f.respond('op1');
    assert.equal(f.delivered.length, revoke ? 0 : 1);
    assert.equal(f.losses(), 1); f.ui.close();
  }
});
test('UI expiry and malformed frames fail closed without reflecting private errors', () => {
  const f = channel();
  assert.throws(() => f.ui.present('bad', {}, ['once'], () => {}, { deadline: 0 }), /TRUSTED_UI_UNAVAILABLE/);
  f.present('op'); f.read.write('{invalid private fixture\n');
  assert.equal(f.delivered.length, 0); assert.equal(f.losses(), 1); f.ui.close();
});

test('dismiss sends a nonce-bound host frame and a racing answer cannot authorize', () => {
  const f = channel(); f.present('op1');
  const nonce = f.outbound[0].nonce;
  f.ui.dismiss('op1');
  assert.deepEqual(f.outbound.at(-1), { id: 'op1', nonce, dismiss: true });
  f.respond('op1');
  assert.equal(f.delivered.length, 0);
  assert.equal(f.losses(), 0, 'an in-flight answer to a dismissed card is ignored');
  f.ui.close();
});
