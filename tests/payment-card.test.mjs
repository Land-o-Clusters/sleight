import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentCard } from '../plugins/sleight/lib/payment-card.mjs';
import { idleClock } from './fixtures/socket-clock.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('shell cards carry the shared ask presentation and keep identical requests separate', async () => {
  const shown = [], events = [];
  const answers = [];
  const card = createPaymentCard({ onStatus: s => events.push(s), open: async () => ({
    present: (id, data, choices, deliver) => { shown.push({ id, data, choices }); answers.push(deliver); },
    authenticate: e => e.person === true,
  }) });
  const request = { session: 'Grok Bot', app: 'Calculator', request: 'Allow Calculator?', scoped: true,
    presentation: { style: 'ask', question: 'Allow Grok Bot to use Calculator?', detail: 'Allow lasts until this Grok Bot session ends.',
      host: 'Grok Bot', icon: '/plugin/assets/icon.png', kind: 'app' } };
  const first = card.ask(request), second = card.ask({ ...request });
  assert.notEqual(first, second);
  await flush();
  assert.equal(shown.length, 2);
  assert.deepEqual(shown[0].data.presentation, request.presentation);
  answers[0]({ choice: 'once' }); await flush();
  assert.equal(events.length, 2);
  answers[0]({ choice: 'once', person: true });
  assert.equal(await first, 'once');
  assert.deepEqual(events.map(e => e.state), ['waiting', 'waiting', 'answered']);
  answers[1]({ choice: 'cancel', person: true });
  assert.equal(await second, 'cancel');
  assert.deepEqual(events.map(e => e.state), ['waiting', 'waiting', 'answered', 'answered']);
  await card.close();
});

test('equal payment terms and distinct IDs never share an authenticated acceptance', async () => {
  const shown = [];
  const card = createPaymentCard({ open: async () => ({
    present: (id, _data, _choices, answer) => shown.push({ id, answer }), authenticate: event => event.person === true,
  }) });
  const terms = { session: 'same-session', app: 'Firefox', site: 'example.test', shown: '$364', control: 'Pay' };
  const first = card.ask({ ...terms, id: 'payment-A' }), second = card.ask({ ...terms, id: 'payment-B' });
  await flush();
  assert.equal(shown.length, 2);
  assert.notEqual(shown[0].id, shown[1].id);
  shown[0].answer({ choice: 'once', person: true });
  assert.equal(await first, 'once');
  let settled = false;
  second.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  shown[1].answer({ choice: 'cancel', person: true });
  assert.equal(await second, 'cancel');
  await card.close();
});

test('shell payment stops get a styled protected action with bounded terms', async () => {
  let shown;
  const card = createPaymentCard({ presentation: { icon: '/plugin/assets/icon.png' }, open: async () => ({
    present: (_id, data, choices, answer) => { shown = { data, choices }; answer({ choice: 'once' }); },
    authenticate: () => true,
  }) });
  assert.equal(await card.ask({ session: 'Grok Bot', site: 'example.test', shown: '$364', control: 'Pay\u202e' + 'x'.repeat(4096) }), 'once');
  assert.equal(shown.data.presentation.kind, 'action');
  assert.equal(shown.data.presentation.style, 'ask');
  assert.equal(shown.data.presentation.question, 'Allow this payment at example.test?');
  assert.match(shown.data.presentation.detail, /Amount: \$364\nControl: Pay\\u202e/);
  assert.ok(Buffer.byteLength(shown.data.presentation.detail) <= 2048);
  assert.match(shown.data.presentation.detail, /\[request truncated\]$/);
  await card.close();
});

test('engine payment cards escape directional controls in the site, amount and button', async () => {
  let shown;
  const card = createPaymentCard({ open: async () => ({
    present: (_id, data, _choices, answer) => { shown = data; answer({ choice: 'once' }); },
    authenticate: () => true,
  }) });
  assert.equal(await card.ask({ session: 'Claude Code', site: 'shop\u2066.test', shown: '$1\u202d0', control: 'Pay\u202e' + 'x'.repeat(4096) }), 'once');
  assert.equal(shown.operation.site, 'shop\\u2066.test');
  assert.equal(shown.operation.amount, '$1\\u202d0');
  assert.match(shown.operation.button, /^Pay\\u202e/);
  assert.ok(Buffer.byteLength(shown.operation.button) <= 2048);
  assert.doesNotMatch(JSON.stringify(shown.operation), /[\u202a-\u202e\u2066-\u2069]/);
  await card.close();
});

test('different apps or sessions never share a pending payment decision', async () => {
  const shown = [];
  const card = createPaymentCard({ open: async () => ({
    present: (_id, _data, _choices, answer) => { shown.push(answer); }, authenticate: () => true,
  }) });
  const first = card.ask({ session: 'one', app: 'Calculator', request: 'Allow?' });
  const second = card.ask({ session: 'one', app: 'TextEdit', request: 'Allow?' });
  const third = card.ask({ session: 'two', app: 'Calculator', request: 'Allow?' });
  await flush();
  assert.equal(shown.length, 3);
  for (const answer of shown) answer({ choice: 'cancel' });
  assert.deepEqual(await Promise.all([first, second, third]), ['cancel', 'cancel', 'cancel']);
  await card.close();
});

test('card status names the app and deadline while only authenticated input answers it', async () => {
  const clock = idleClock(), events = [];
  let answer;
  const card = createPaymentCard({ clock, now: () => 1000, timeoutMs: 120000,
    onStatus: status => events.push(status), open: async () => ({
      present: (_id, _data, _choices, deliver) => { answer = deliver; },
      authenticate: event => event.physical === true,
    }) });
  const result = card.ask({ app: 'TextEdit', request: 'Allow TextEdit?' });
  await flush();
  assert.deepEqual(events.map(({ state, app, deadline }) => ({ state, app, deadline })),
    [{ state: 'waiting', app: 'TextEdit', deadline: 121000 }]);
  answer({ choice: 'once' });
  assert.equal(events.length, 1);
  answer({ choice: 'once', physical: true });
  assert.equal(await result, 'once');
  clock.advance(120000);
  assert.deepEqual(events.map(e => e.state), ['waiting', 'answered']);
});

test('an unanswered card cancels at its deadline and ignores late answers', async () => {
  const clock = idleClock(), events = [];
  let answer;
  const card = createPaymentCard({ clock, timeoutMs: 120000, onStatus: s => events.push(s),
    open: async () => ({ present: (_id, _data, _choices, deliver) => { answer = deliver; }, authenticate: () => true }) });
  const result = card.ask({ site: 'example.test', shown: '$12', control: 'Pay' });
  await flush();
  clock.advance(119999);
  assert.deepEqual(events.map(e => e.state), ['waiting']);
  clock.advance(1);
  assert.equal(await result, 'cancel');
  answer({ choice: 'once' });
  assert.deepEqual(events.map(e => e.state), ['waiting', 'unanswered']);
  assert.equal(events[0].app, 'example.test');
});

test('an unavailable panel never claims to be waiting and status failures grant nothing', async () => {
  const events = [];
  const card = createPaymentCard({ onStatus: s => events.push(s), open: async () => ({
    present() { throw new Error('offline'); }, authenticate: () => true,
  }) });
  assert.equal(await card.ask({ request: 'Allow?' }), undefined);
  assert.deepEqual(events.map(e => e.state), ['unavailable']);
  const clock = idleClock();
  const brokenObserver = createPaymentCard({ clock, timeoutMs: 1, onStatus() { throw new Error('observer'); },
    open: async () => ({ present() {}, authenticate: () => true }) });
  const result = brokenObserver.ask({ request: 'Allow?' });
  await flush(); clock.advance(1);
  assert.equal(await result, 'cancel');
});
