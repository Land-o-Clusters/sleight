import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { sourceModule, replaceSite } from './fixtures/browser-geometry.mjs';
const { createRelay } = await sourceModule('relay.mjs', source => {
  if (process.env.CHV2A_BROKEN === 'late-wide') return replaceSite(source,
    'if (appTool) hand?.protect?.({ app: args.app }, () => !localDeclined);', '');
  return source;
});

for (const allowed of [true, false]) test(`CH-4 relay local failure with approval ${allowed} withdraws only a declined preview`, async t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const previews = [], replies = []; let clears = 0, hides = 0, options;
  clientOut.setEncoding('utf8').on('data', data => { for (const line of data.split('\n').filter(Boolean)) replies.push(JSON.parse(line)); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    ask: async () => allowed ? 'accept' : 'decline',
    hand: { placementEnabled: true, turnEpoch: 0, pointer() {}, protect: (target, valid) => previews.push({ target, valid }),
      placeLocal: async () => true, hide: () => hides++, result() {}, close() {}, endTurn() {} },
    pauseHost: { activity() {}, clearForAction: async () => { clears++; return true; }, hide() {} },
    localTools: { tools: [{ name: 'drag', inputSchema: { type: 'object' } }], target: async () => ({ app: 'Fixture', appId: 'org.fixture.Editor', title: null }),
      call: async (_name, _args, approve, _run, _resolved, _prepared, control) => {
        options = control; await approve(['drag', 'Fixture'], 'Fixture approval');
        return { content: [{ type: 'text', text: 'Fixture failure' }], isError: true };
      } } });
  t.after(() => relay.dispose());
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'drag', arguments: { app: 'Fixture', from: [1,2], to: [3,4] } } }) + '\n');
  for (let i = 0; i < 30 && !replies.some(row => row.id === 1); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(replies.some(row => row.id === 1));
  assert.ok(options?.placeHand); assert.equal(clears, 0, 'placement replaces both old clear waits');
  assert.equal(hides, allowed ? 0 : 1);
  assert.equal(typeof previews[0]?.valid, 'function'); assert.equal(previews[0].valid(), allowed);
});

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function localFixture(t, { name = 'open_file', blocked = false, resolvedBlocked = false, allowed = true } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const events = [], replies = []; let resolveTarget;
  const resolved = { app: 'Fixture', appId: 'org.fixture.Editor', pid: 42, title: null };
  clientOut.setEncoding('utf8').on('data', data => { for (const line of data.split('\n').filter(Boolean)) replies.push(JSON.parse(line)); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    ask: async () => allowed ? 'accept' : 'decline',
    permissions: { app: ({ bundleId }) => (blocked || resolvedBlocked && bundleId === resolved.appId) ? 'Fixture blocked' : undefined },
    hand: { placementEnabled: true, turnEpoch: 0, pointer() {}, protect: (target, valid) => events.push({ type: 'wide', target, valid }),
      hide: () => events.push({ type: 'hide' }), result() {}, close() {}, endTurn() {} },
    localTools: { tools: [{ name, inputSchema: { type: 'object' } }], target: () => { events.push({ type: 'target' }); return new Promise(resolve => { resolveTarget = () => resolve(resolved); }); },
      call: async (_name, _args, approve) => {
        const accepted = await approve([name, 'Fixture'], 'Fixture approval');
        events.push({ type: 'call', accepted });
        return { isError: !accepted, content: [{ type: 'text', text: 'Fixture result' }] };
      } } });
  t.after(() => relay.dispose());
  clientIn.write(JSON.stringify({ id: 80, method: 'tools/call', params: { name,
    arguments: { app: 'Fixture', from: [1,2], to: [3,4], at: [1,2] } } }) + '\n');
  return { events, replies, resolve: () => resolveTarget?.(), resolved };
}
for (const name of ['open_file', 'select_window', 'drag', 'hover']) test(`CHV2-A ${name} widens before its unresolved target probe and retains resolved protection`, async t => {
  const h = localFixture(t, { name }); await settle();
  assert.equal(h.events[0]?.type, 'wide', 'admission must precede the target probe');
  assert.deepEqual(h.events[0].target, { app: 'Fixture' });
  assert.equal(h.events[1]?.type, 'target');
  assert.equal(h.replies.length, 0, 'target probe is still pending');
  h.resolve(); await settle();
  assert.ok(h.events.some(event => event.type === 'wide' && event.target === h.resolved), 'keep the later resolved protection');
  assert.ok(h.replies.some(reply => reply.id === 80));
});
test('CHV2-A a declined open_file withdraws the frame already sent at admission', async t => {
  const h = localFixture(t, { allowed: false }); await settle();
  assert.equal(h.events[0]?.type, 'wide'); h.resolve(); await settle();
  assert.equal(h.events.at(-1)?.type, 'hide');
  assert.equal(h.events[0].valid(), false, 'a loading host must not replay the declined preview');
});
test('CHV2-A a blocked app hides without sending a wide frame or probing the target', async t => {
  const h = localFixture(t, { blocked: true }); await settle();
  assert.deepEqual(h.events.map(event => event.type), ['hide']);
  assert.equal(h.replies[0]?.result.isError, true);
});
test('CHV2-A a block discovered by resolved bundle hides the earlier named preview', async t => {
  const h = localFixture(t, { resolvedBlocked: true }); await settle();
  assert.equal(h.events[0]?.type, 'wide'); h.resolve(); await settle();
  assert.equal(h.events.at(-1)?.type, 'hide');
  assert.equal(h.events.filter(event => event.type === 'wide').length, 1);
  assert.equal(h.events[0].valid(), false);
  assert.equal(h.replies[0]?.result.isError, true);
});
