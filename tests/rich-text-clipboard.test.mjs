import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../plugins/sleight/lib/rich-text-drag.mjs').catch(() => ({}));
const original = [[{ type: 'public.rtf', data: 'b3JpZ2luYWw=' }, { type: 'public.png', data: 'cGl4ZWxz' }], [{ type: 'public.utf8-plain-text', data: 'dHdv' }]];
const plan = { rtf: 'cnRm', sourceRTF: 'c291cmNl', text: 'alpha beta\n', selected: 'alpha', windowId: 11, pid: 22 };
test('a collected Paste receipt is exact, survives framing and does not trust truncated absence', () => {
  assert.equal(module.richPasteChildState('warning\nsleight:rich-paste-posted\n'), 'pending');
  assert.equal(module.richPasteChildState('sleight:rich-paste-posted\r\n'), 'pending');
  assert.equal(module.richPasteChildState('sleight:rich-paste-post'), 'not-posted');
  assert.equal(module.richPasteChildState('sleight:rich-paste-post', true), 'unknown');
  assert.equal(module.richPasteChildState('sleight:rich-paste-posted\n', true), 'pending');
});
function board({ readFails = false, busy = false } = {}) {
  let count = 10, items = structuredClone(original), held = false, closed = false;
  const io = async request => {
    if (request.op === 'acquire') { if (busy || held) throw new Error('Clipboard busy'); held = true; return; }
    if (request.op === 'release') { held = false; return; }
    if (request.op === 'read') { if (readFails) throw new Error('File promises cannot be snapshotted'); return { count, items: structuredClone(items) }; }
    assert.equal(held, true);
    if (request.expectedCount !== count) throw Object.assign(new Error('Clipboard ownership changed; current contents were left alone'), { clipboardMutation: false, clipboardCount: count });
    items = structuredClone(request.items); return { count: ++count };
  };
  io.close = async () => { held = false; closed = true; };
  return { io, current: () => ({ count, items, held, closed }), wipe: () => { items = []; return ++count; }, takeover: () => { items = [[{ type: 'public.utf8-plain-text', data: 'dXNlcg==' }]]; count++; } };
}
function clock() {
  const tasks = new Set();
  return { timers: {
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; tasks.add(timer); return timer; },
    clearTimeout: timer => tasks.delete(timer),
  }, fire(ms) {
    const timer = [...tasks].find(t => t.ms === ms);
    assert.ok(timer, `missing ${ms} ms timer`); tasks.delete(timer); return timer.fn();
  }, pending: () => [...tasks].map(t => t.ms) };
}
test('unconfirmed Paste restores only the exact staged generation and bytes, then releases within ten seconds', async () => {
  for (const change of ['none', 'new-copy', 'same-generation-other-bytes', 'new-generation-same-bytes']) {
    const b = board(), c = clock(), notices = [];
    let currentOverride;
    const io = request => request.op === 'read' && currentOverride ? Promise.resolve(currentOverride) : b.io(request);
    io.close = b.io.close;
    await module.runRichTextMove({}, plan, async () => ({ ok: false, richPasteState: 'pending' }), io,
      { timers: c.timers, notice: message => notices.push(message) });
    if (change === 'new-copy') b.takeover();
    if (change === 'same-generation-other-bytes') currentOverride = { count: 11, items: [] };
    if (change === 'new-generation-same-bytes') currentOverride = { count: 12, items: b.current().items };
    assert.ok(c.pending().includes(9000));
    await c.fire(9000);
    assert.equal(b.current().held, false); assert.equal(b.current().closed, true);
    assert.equal(b.current().count, change === 'none' || change === 'new-copy' ? 12 : 11);
    assert.deepEqual(b.current().items, change === 'none' ? original : change === 'new-copy'
      ? [[{ type: 'public.utf8-plain-text', data: 'dXNlcg==' }]] : [[{ type: 'public.rtf', data: 'cnRm' }]]);
    assert.match(notices.join('\n'), change === 'none' ? /restored/ : /left/);
    assert.equal(await module.recoverPendingRichTextMove(), true);
    assert.equal(c.pending().length, 0);
  }
});
test('the lock deadline bounds a stuck status/read and ignores their late replies', async () => {
  const b = board(), c = clock(), notices = [];
  let finishStatus, finishRead, stuckRead = false;
  const io = request => request.op === 'read' && stuckRead ? new Promise(resolve => { finishRead = resolve; }) : b.io(request);
  io.close = async options => { assert.equal(options.timeoutMs, 250); await b.io.close(); };
  await module.runRichTextMove({}, plan, async (_script, request) => request.op === 'rich-paste-status'
    ? new Promise(resolve => { finishStatus = resolve; }) : { ok: false, richPasteState: 'pending' }, io,
  { timers: c.timers, notice: message => notices.push(message) });
  const recovering = c.fire(5000);
  const waiting = module.recoverPendingRichTextMove();
  stuckRead = true;
  const expiring = c.fire(9000);
  await new Promise(resolve => setImmediate(resolve));
  c.fire(250);
  await expiring;
  assert.equal(b.current().held, false); assert.match(notices.join('\n'), /left/);
  assert.equal(await waiting, true); // deadline also releases callers awaiting a stuck status
  finishRead({ count: 11, items: [[{ type: 'public.rtf', data: 'cnRm' }]] });
  finishStatus({ ok: true, terminated: true });
  await recovering;
  assert.equal(b.current().count, 11); assert.equal(await module.recoverPendingRichTextMove(), true);
});
test('rich paste restores every original clipboard item and flavor after collected input', async () => {
  assert.equal(typeof module.runRichTextMove, 'function');
  const b = board();
  const result = await module.runRichTextMove({ app: 'TextEdit' }, plan, async (script, args) => {
    assert.equal(script, 'drag.js'); assert.equal(args.richTextMove.clipboardCount, 11);
    assert.deepEqual(b.current().items, [[{ type: 'public.rtf', data: 'cnRm' }]]);
    return { ok: true, path: 'accessibility', richTextPreserved: true, richPasteState: 'consumed' };
  }, b.io);
  assert.equal(result.clipboardRestored, true);
  assert.deepEqual(b.current(), { count: 12, items: original, held: false, closed: true });
});
test('an unknown paste retains the snapshot and reservation until the old target exits', async () => {
  assert.equal(typeof module.runRichTextMove, 'function');
  const b = board(); let terminated = false;
  const result = await module.runRichTextMove({}, plan, async (_script, request) => {
    if (request.op === 'rich-paste-status') return { ok: true, terminated };
    throw new Error('child timed out and was collected');
  }, b.io);
  assert.equal(result.ok, false); assert.match(result.error, /timed out/);
  assert.equal(result.clipboardRecoveryRequired, true);
  assert.equal(b.current().held, true); assert.equal(b.current().closed, false);
  assert.deepEqual(b.current().items, [[{ type: 'public.rtf', data: 'cnRm' }]]);
  assert.equal(await module.recoverPendingRichTextMove(), false);
  terminated = true;
  assert.equal(await module.recoverPendingRichTextMove(), true);
  assert.deepEqual(b.current().items, original); assert.equal(b.current().closed, true);
});
test('new clipboard contents during rich paste are left alone and success is refused', async () => {
  assert.equal(typeof module.runRichTextMove, 'function');
  const b = board();
  const result = await module.runRichTextMove({}, plan, async () => { b.takeover(); return { ok: true, path: 'accessibility', richPasteState: 'consumed' }; }, b.io);
  assert.equal(result.ok, false); assert.equal(result.clipboardRestored, false);
  assert.match(result.error, /ownership changed/);
  assert.deepEqual(b.current().items, [[{ type: 'public.utf8-plain-text', data: 'dXNlcg==' }]]);
});
test('a refusal before posting restores immediately', async () => {
  const b = board();
  const result = await module.runRichTextMove({}, plan, async () => ({ ok: false, error: 'Selection changed', richPasteState: 'not-posted' }), b.io);
  assert.equal(result.clipboardRestored, true); assert.deepEqual(b.current().items, original);
});
test('a collected pre-Paste timeout restores and releases without waiting for TextEdit to quit', async () => {
  const b = board();
  const result = await module.runRichTextMove({}, plan, async () => ({ ok: false, timedOut: true, error: 'Child stopped', richPasteState: 'not-posted' }), b.io);
  assert.equal(result.clipboardRestored, true);
  assert.equal(result.clipboardRecoveryRequired, undefined);
  assert.deepEqual(b.current().items, original); assert.equal(b.current().held, false);
});
test('an unconfirmed posted paste cannot install original clipboard data beneath the queued input', async () => {
  const b = board(); let terminated = false;
  const result = await module.runRichTextMove({}, plan, async (_script, request) => request.op === 'rich-paste-status'
    ? { ok: true, terminated } : { ok: false, richPasteState: 'pending', error: 'Insertion unconfirmed' }, b.io);
  assert.equal(result.clipboardRecoveryRequired, true); assert.equal(b.current().count, 11);
  b.takeover(); terminated = true;
  await module.recoverPendingRichTextMove();
  assert.deepEqual(b.current().items, [[{ type: 'public.utf8-plain-text', data: 'dXNlcg==' }]]);
  assert.equal(b.current().held, false); assert.equal(b.current().closed, true);
});
test('busy and unreadable clipboards prevent the rich paste before any input', async () => {
  assert.equal(typeof module.runRichTextMove, 'function');
  for (const options of [{ busy: true }, { readFails: true }]) {
    const b = board(options);
    const result = await module.runRichTextMove({}, plan, () => assert.fail('no input permitted'), b.io);
    assert.equal(result.ok, false); assert.deepEqual(b.current().items, original); assert.equal(b.current().closed, true);
  }
});
test('graceful shutdown waits for pending clipboard recovery', async () => {
  const b = board(); let terminated = false, waits = 0;
  await module.runRichTextMove({}, plan, async (_script, request, options) => {
    if (request.op === 'rich-paste-status') { assert.equal(options.cleanup, true); return { ok: true, terminated }; }
    return { ok: false, richPasteState: 'pending' };
  }, b.io);
  await module.drainRichTextMoves({ notice() {}, wait: async () => { waits++; assert.equal(b.current().held, true); terminated = true; } });
  assert.equal(waits, 1); assert.deepEqual(b.current().items, original);
});
test('shutdown bounds a stuck recovery, reports clipboard left and never restores after its deadline', async () => {
  const b = board(); let finishStatus;
  await module.runRichTextMove({}, plan, async (_script, request) => request.op === 'rich-paste-status'
    ? new Promise(resolve => { finishStatus = resolve; }) : { ok: false, richPasteState: 'pending' }, b.io);
  const notices = [];
  const drained = module.drainRichTextMoves({ timeoutMs: 20, notice: message => notices.push(message) });
  const first = await Promise.race([drained, new Promise(resolve => setTimeout(() => resolve('late'), 150))]);
  finishStatus({ ok: true, terminated: true });
  const result = await drained;
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(first, 'late');
  assert.equal(result.clipboardLeft, true);
  assert.match(notices.join('\n'), /clipboard.*left/i);
  assert.equal(b.current().held, false); assert.equal(b.current().closed, true);
  assert.deepEqual(b.current().items, [[{ type: 'public.rtf', data: 'cnRm' }]]);
});
test('an unreceipted restoration failure retains the snapshot despite a changed generation', async () => {
  const b = board(); let writes = 0;
  const io = async request => {
    if (request.op === 'write' && ++writes === 2) { b.wipe(); throw new Error('Helper died after clearing without a reply'); }
    return b.io(request);
  };
  io.close = b.io.close;
  const result = await module.runRichTextMove({}, plan, async () => ({ ok: true, richPasteState: 'consumed' }), io);
  assert.equal(result.clipboardRecoveryRequired, true);
  assert.equal(await module.recoverPendingRichTextMove(), false);
  assert.equal(b.current().held, true); assert.deepEqual(b.current().items, []);
  b.takeover(); // a later owner explicitly replaces the uncertain clipboard
  assert.equal(await module.recoverPendingRichTextMove(), true);
  assert.equal(b.current().closed, true);
});
test('receipted restoration failure retries without requiring TextEdit to quit', async () => {
  const b = board(); let writes = 0;
  const io = async request => {
    if (request.op === 'write' && ++writes === 2) throw Object.assign(new Error('Write failed after clearing'), { clipboardMutation: true, clipboardCount: b.wipe() });
    return b.io(request);
  };
  io.close = b.io.close;
  const result = await module.runRichTextMove({}, plan, () => ({ ok: true, richPasteState: 'consumed' }), io);
  assert.equal(result.clipboardRecoveryRequired, true);
  assert.equal(await module.recoverPendingRichTextMove(), true);
  assert.deepEqual(b.current().items, original);
});
test('an unreceipted staging failure retains the original snapshot without starting input', async () => {
  const b = board(); let firstWrite = true;
  const io = async request => {
    if (request.op === 'write' && firstWrite) { firstWrite = false; b.wipe(); throw new Error('Stage helper died after clearing'); }
    return b.io(request);
  };
  io.close = b.io.close;
  const result = await module.runRichTextMove({}, plan, () => assert.fail('input must not start'), io);
  assert.equal(result.clipboardRecoveryRequired, true); assert.equal(b.current().held, true);
  assert.equal(await module.recoverPendingRichTextMove(), false);
  b.takeover(); assert.equal(await module.recoverPendingRichTextMove(), true);
  assert.equal(b.current().closed, true);
});
