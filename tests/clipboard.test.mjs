import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installClipboardGuard, clipboardCode, clipboardPlan, installClipboardPermit } from '../plugins/sleight/lib/clipboard.mjs';

const old = [
  [{ type: 'public.png', data: 'AAEC' }, { type: 'public.rtf', data: 'e1xydGYxfQ==' }],
  [{ type: 'public.file-url', data: 'ZmlsZTovLy90bXAvYQ==' }],
];
const copied = [[{ type: 'public.utf8-plain-text', data: 'Y29waWVk' }]];
function fixture({ rawError = false, outside = false, restoreOutside = false, unreadable = false, shared, copyItems = copied } = {}) {
  const scope = shared ?? { board: { count: 10, items: structuredClone(old) }, held: false };
  let calls = [], writes = [], failRead = unreadable;
  const raw = { pressKey: async key => {
    calls.push({ key, items: structuredClone(scope.board.items) });
    if (key.endsWith('+c') || key.endsWith('+x')) scope.board = { count: scope.board.count + 1, items: copyItems };
    if (outside) scope.board = { count: scope.board.count + 1, items: [[{ type: 'external', data: 'bmV3' }]] };
    if (rawError) throw new Error('engine failed');
    return 'done';
  }, paste: async () => 'native paste', typeText: async () => 'native type' };
  const cua = { getApp: async () => raw };
  const io = async request => {
    if (request.op === 'acquire') { if (scope.held) throw new Error('Clipboard busy'); scope.held = true; return; }
    if (request.op === 'release') { scope.held = false; return; }
    if (request.op === 'read') { if (failRead) throw Object.assign(new Error('Unreadable representation'), { clipboardCount: scope.board.count }); return structuredClone(scope.board); }
    if (restoreOutside) { scope.board = { count: scope.board.count + 1, items: [[{ type: 'external', data: 'bmV3' }]] }; }
    if (scope.board.count !== request.expectedCount) throw new Error('Clipboard ownership changed');
    scope.board = { count: scope.board.count + 1, items: structuredClone(request.items) }; writes.push(structuredClone(request.items));
    return structuredClone(scope.board);
  };
  installClipboardGuard(cua, io);
  return { cua, io, raw, calls, writes, board: () => scope.board, unreadable: value => { failRead = value; } };
}
for (const key of ['super+c', 'super+x', 'cmd+c', 'meta+x', 'command+shift+c']) {
  test(`restores every clipboard item and binary format after ${key}`, async () => {
    const h = fixture(); const app = await h.cua.getApp('TextEdit');
    assert.equal(await app.pressKey(key), 'done');
    assert.deepEqual(h.board().items, old); assert.equal(h.writes.length, 1);
  });
}
test('Paste uses the session copy and then restores the current user clipboard', async () => {
  const h = fixture(), app = await h.cua.getApp('TextEdit');
  await app.pressKey('super+c'); await app.pressKey('super+v');
  assert.deepEqual(h.calls.at(-1).items, copied);
  assert.deepEqual(h.board().items, old);
  assert.equal(h.writes.length, 3);
});
test('a session without a copy passes Paste through, and sessions do not share copied data', async () => {
  const a = fixture(), b = fixture();
  await (await a.cua.getApp('TextEdit')).pressKey('super+c');
  await (await b.cua.getApp('TextEdit')).pressKey('super+v');
  assert.equal(b.writes.length, 0); assert.deepEqual(b.calls[0].items, old);
});
test('an unreadable or oversized snapshot refuses Copy before input', async () => {
  const h = fixture({ unreadable: true });
  await assert.rejects((await h.cua.getApp('TextEdit')).pressKey('super+c'), /Unreadable/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.board().items, old);
});
test('a newer clipboard generation during Copy or before restore is never overwritten', async () => {
  for (const options of [{ outside: true }, { restoreOutside: true }]) {
    const h = fixture(options);
    await assert.rejects((await h.cua.getApp('TextEdit')).pressKey('super+c'), /ownership changed/i);
    assert.equal(h.writes.length, 0); assert.equal(h.board().items[0][0].type, 'external');
  }
});
test('a failed Copy reports the error and leaves an unattributable write alone', async () => {
  const h = fixture({ rawError: true });
  await assert.rejects((await h.cua.getApp('TextEdit')).pressKey('super+c'), /engine failed/);
  assert.equal(h.writes.length, 0);
});
test('private Paste restores the user clipboard even if engine delivery fails', async () => {
  const h = fixture(), app = await h.cua.getApp('TextEdit');
  await app.pressKey('super+c'); h.raw.pressKey = async () => { throw new Error('paste failed'); };
  await assert.rejects(app.pressKey('super+v'), /paste failed/);
  assert.deepEqual(h.board().items, old);
});
test('ordinary keys, text entry and native paste are untouched', async () => {
  const h = fixture(), app = await h.cua.getApp('TextEdit');
  await app.pressKey('Right'); assert.equal(await app.paste('x'), 'native paste'); assert.equal(await app.typeText('x'), 'native type');
  assert.equal(h.writes.length, 0);
});
test('installation is idempotent and all acquired handles share the session copy', async () => {
  const h = fixture(); installClipboardGuard(h.cua, h.io);
  const a = await h.cua.getApp('TextEdit'), b = await h.cua.getApp('Calculator');
  await a.pressKey('super+c'); await b.pressKey('super+v');
  assert.equal(h.writes.length, 3); assert.deepEqual(h.calls.at(-1).items, copied);
});
test('generated setup leaves user declarations at top level and needs no sandbox IO', () => {
  const code = clipboardCode('const app = await cua.getApp("TextEdit")', 'c');
  assert.ok(!/node:sqlite|osascript|fetch\(/.test(code)); assert.ok(code.endsWith('const app = await cua.getApp("TextEdit")'));
});

test('independent sessions refuse overlapping clipboard transactions before Paste input', async () => {
  const shared = { board: { count: 10, items: structuredClone(old) }, held: false };
  const a = fixture({ shared }), b = fixture({ shared, copyItems: [[{ type: 'b', data: 'Yg==' }]] });
  const first = await a.cua.getApp('TextEdit'), second = await b.cua.getApp('Calculator');
  await first.pressKey('super+c'); await second.pressKey('super+c');
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  a.raw.pressKey = async () => { entered(); await new Promise(resolve => { resume = resolve; }); };
  const running = first.pressKey('super+v').catch(e => e);
  await ready;
  try {
    await assert.rejects(second.pressKey('super+v'), /Clipboard busy/);
    await assert.rejects(second.paste('native paste'), /Clipboard busy/);
  }
  finally { resume(); await running; }
  assert.deepEqual(shared.board.items, old);
  assert.equal(b.calls.length, 1);
});
test('a successful Copy whose result cannot be read still restores the original clipboard', async () => {
  const h = fixture(), app = await h.cua.getApp('TextEdit');
  const action = h.raw.pressKey;
  h.raw.pressKey = async key => { const result = await action(key); h.unreadable(true); return result; };
  await assert.rejects(app.pressKey('super+c'), /Unreadable/);
  assert.deepEqual(h.board().items, old);
  assert.equal(h.writes.length, 1);
});

test('a private Paste write failure after clearing restores the original before input', async () => {
  const h = fixture();
  let failWrite = false;
  const io = async request => {
    if (request.op === 'write' && failWrite) {
      failWrite = false;
      const empty = await h.io({ ...request, items: [] });
      throw Object.assign(new Error('Clipboard write failed after clearing'), { clipboardMutation: true, clipboardCount: empty.count });
    }
    return h.io(request);
  };
  const cua = { getApp: async () => h.raw }; installClipboardGuard(cua, io);
  const app = await cua.getApp('TextEdit'); await app.pressKey('super+c');
  failWrite = true;
  await assert.rejects(app.pressKey('super+v'), /write failed/);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.board().items, old);
});


test('clipboard plans ignore comments and data, accept brackets and escaped literals, and refuse compound actions', () => {
  assert.equal(clipboardPlan('/* app.paste("x") */ const s = "app.pressKey(\\"super+c\\")"'), undefined);
  assert.equal(clipboardPlan('await app["pressKey"]("super+\\u0063")'), 'c');
  assert.equal(clipboardPlan('await app.paste(value)'), 'paste');
  assert.equal(clipboardPlan('await app.pressKey(key)'), undefined);
  assert.throws(() => clipboardPlan('app.pressKey("super+x"); app.pressKey("super+v")'), /one clipboard/);
});
test('runtime permits stop computed shortcuts, repeated calls, and mismatched plans before input', async () => {
  const raw = { pressKey: async () => 'ok', paste: async () => 'ok' };
  const cua = { getApp: async () => raw };
  const state = installClipboardPermit(cua);
  const app = await cua.getApp('TextEdit');
  state.action = undefined;
  await assert.rejects(app.pressKey('super+c'), /literal/);
  state.action = 'x'; state.used = false;
  await assert.rejects(app.pressKey('super+c'), /literal/);
  assert.equal(await app.pressKey('super+x'), 'ok');
  await assert.rejects(app.pressKey('super+x'), /one clipboard/);
  state.action = 'paste'; state.used = false;
  assert.equal(await app.paste('x'), 'ok');
  await assert.rejects(app.paste('x'), /one clipboard/);
  assert.equal(await app.pressKey('Right'), 'ok');
});
