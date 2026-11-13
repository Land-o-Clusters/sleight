import test from 'node:test';
import assert from 'node:assert/strict';
import { createCursorEvents, cursorRecord } from '../plugins/sleight/lib/hand/events.mjs';
import { createRetryMarks, handTargets, transferMark } from '../plugins/sleight/lib/hand/planner.mjs';
import { createEdgeChips } from '../plugins/sleight/lib/hand/edge-chips.mjs';
import { handWireFrame } from '../plugins/sleight/lib/hand/client.mjs';
import { replayFrame, buildRunHTML } from '../plugins/sleight/lib/runs/viewer.mjs';
import { createBrowserHand } from '../plugins/sleight/lib/hand/browser-hand.mjs';

const call = 'a'.repeat(32);
test('optional moods have closed sets and preserve v1 parsing without content', () => {
  const rows = [];
  const events = createCursorEvents({ setting: () => ({ stream: true }), onEvent: e => rows.push(e), sink: { write() {}, close() {} } });
  for (const detail of ['approval', 'payment', 'page', 'handoff', 'SECRET', 1, null]) events.status('waiting', { detail });
  for (const retry of [true, false, 'true', 1]) for (const transfer of ['take', 'give', 'SECRET', true]) events.action({ call, index: 0, phase: 'aim', kind: 'key', source: 'native', retry, transfer });
  events.close();
  assert.deepEqual(rows.filter(e => e.type === 'status' && e.detail).map(e => e.detail), ['approval', 'payment', 'page', 'handoff']);
  for (const row of rows.filter(e => e.type === 'action')) {
    assert.equal(row.v, 'sleight.cursor/1');
    if ('retry' in row) assert.equal(typeof row.retry, 'boolean');
    if ('transfer' in row) assert.ok(['take', 'give'].includes(row.transfer));
    const { retry, transfer, detail, ...old } = JSON.parse(JSON.stringify(row));
    assert.equal(replayFrame([old], 0).event.kind, 'key');
  }
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
  assert.equal(cursorRecord({ action: { kind: 'type', transfer: 'give' } }).transfer, undefined);
});
test('planner marks exact copy, cut and paste chords without exporting the key', () => {
  for (const key of ['super+c', 'cmd-x', 'Command+C', 'meta+v']) assert.ok(transferMark(key));
  for (const key of ['c', 'ctrl+c', 'super+shift+v', 'super+c SECRET']) assert.equal(transferMark(key), undefined);
  const plan = handTargets({ code: 'await app.pressKey("super+c"); await app.pressKey("super+v")' });
  assert.deepEqual(plan.actions.map(a => a.transfer), ['take', 'give']);
  assert.ok(!JSON.stringify(plan).includes('super'));
});
test('retries expire after 10 seconds, separate windows and kinds, and reset on clock reversal', () => {
  let clock = 0; const marks = createRetryMarks({ now: () => clock });
  assert.equal(marks.mark('click', 1, { point: [1, 2] }), false);
  clock = 10000; assert.equal(marks.mark('click', 1, { point: [1, 2] }), true);
  assert.equal(marks.mark('click', 2, { point: [1, 2] }), false);
  assert.equal(marks.mark('type', 1, { point: [1, 2] }), false);
  clock = 20001; assert.equal(marks.mark('click', 1, { point: [1, 2] }), false);
  clock = 1; assert.equal(marks.mark('click', 1, { point: [1, 2] }), false);
});
test('chips count confirmed actions once and permit only their recorded session and first event', () => {
  const rows = []; const chips = createEdgeChips({ send: x => rows.push(x), now: () => 1000 });
  chips.receive({ type: 'session', state: 'start', session: call, ts: 1793016000000 });
  const action = { type: 'action', phase: 'done', call, index: 0, seq: 3, kind: 'click', window: { pid: 42, id: 7 } };
  chips.receive({ ...action, phase: 'aim' }, true); assert.equal(rows.length, 1);
  chips.receive(action, false); assert.equal(rows.at(-1).run, null); assert.equal(rows.at(-1).count, 1);
  chips.receive(action, true); assert.equal(rows.at(-1).count, 1);
  chips.recording(false); assert.equal(rows.at(-1).run, null);
  chips.recording(true); assert.equal(rows.at(-1).run, null);
  chips.receive({ ...action, index: 1, seq: 4 }, true);
  assert.equal(rows.at(-1).count, 2); assert.equal(rows.at(-1).first, 4);
  assert.equal(chips.permits(rows.at(-1).run, 4), true);
  assert.equal(chips.permits('bad', 3), false); assert.equal(chips.permits(rows.at(-1).run, 3), false);
  chips.receive({ type: 'status', state: 'paused' }); chips.receive({ type: 'status', state: 'idle' });
  assert.equal(rows.at(-1).op, 'put');
  chips.receive({ type: 'status', state: 'done', call }); assert.equal(rows.at(-1).op, 'put');
  chips.receive({ type: 'status', state: 'done' }); assert.equal(rows.at(-1).op, 'put');
  chips.receive({ type: 'status', state: 'idle' }); assert.equal(rows.at(-1).op, 'end');
  chips.receive({ ...action, index: 2, seq: 8 }, true); assert.equal(rows.at(-1).count, 1);
  chips.receive({ type: 'session', state: 'end' }); assert.equal(rows.at(-1).op, 'clear');
});
test('host frames retain the optional enums and the viewer selects an exact event sequence', () => {
  const target = { pid: 42, windowId: 7, at: [20, 30] };
  assert.equal(handWireFrame({ hand: 'status', state: 'waiting', ...target, detail: 'payment' }).detail, 'payment');
  assert.equal(handWireFrame({ hand: 'status', state: 'waiting', ...target, detail: 'secret' }).detail, undefined);
  assert.equal(handWireFrame({ hand: 'aim', kind: 'key', ...target, retry: true, transfer: 'give' }).transfer, 'give');
  assert.equal(handWireFrame({ hand: 'aim', kind: 'click', ...target, transfer: 'give' }).transfer, undefined);
  assert.match(buildRunHTML([], { atSeq: 17 }), /data-seq="17"/);
  assert.match(buildRunHTML([], { atSeq: '<script>' }), /data-seq="0"/);
});
test('a page cue starts after 2 seconds and stops when the wait finishes or the hand closes', async () => {
  const rows = [];
  const hand = createBrowserHand({ setting: () => ({ stream: true }), locate() {}, client: { enabled: false }, events: { enabled: true, status: (...args) => rows.push(args) } });
  const short = hand.pageWait(); short();
  const long = hand.pageWait(); await new Promise(resolve => setTimeout(resolve, 2050));
  assert.deepEqual(rows, [['thinking', { detail: 'page' }]]);
  long(); assert.deepEqual(rows.at(-1), ['thinking', { detail: undefined }]);
  const closed = hand.pageWait(); hand.close(); closed();
});
