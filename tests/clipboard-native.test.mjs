import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugins/sleight/lib/clipboard.js', import.meta.url), 'utf8');
function fixture(chunks = []) {
  const data = bytes => ({ length: bytes.length, isNil: () => false, base64EncodedStringWithOptions: () => bytes.toString('base64') });
  const array = values => ({ get count() { return values.length; }, objectAtIndex: i => values[i], addObject: v => values.push(v), isNil: () => false });
  const board = { changeCount: 20, writes: 0, pasteboardItems: array([]), writeObjects: objects => { board.writes++; board.pasteboardItems = objects; return true; } };
  Object.defineProperty(board, 'clearContents', { get() { board.changeCount++; board.pasteboardItems = array([]); return board.changeCount; } });
  const written = [];
  const native = Object.assign(value => ({ dataUsingEncoding: () => value }), {
    NSMutableArray: { alloc: { get init() { return array([]); } } },
    NSPasteboardItem: { alloc: { get init() {
      const types = [], reps = new Map();
      return { types: array(types), dataForType: t => reps.get(t), setDataForType: (d, t) => { types.push(t); reps.set(t, d); return true; } };
    } } },
    NSData: { alloc: { initWithBase64EncodedStringOptions: value => data(Buffer.from(value, 'base64')) } },
    NSPasteboard: { generalPasteboard: board },
    NSString: { alloc: { initWithDataEncoding: input => input.text } },
    NSUTF8StringEncoding: 4,
    NSFileHandle: {
      fileHandleWithStandardInput: {
        get availableData() { const text = chunks.shift() ?? ''; return { length: text.length, text }; },
        get readDataToEndOfFile() { const text = chunks.join(''); return { length: text.length, text }; },
      },
      fileHandleWithStandardOutput: { writeData: line => written.push(JSON.parse(line)) },
    },
  });
  const context = vm.createContext({ ObjC: { import: () => {}, unwrap: value => value }, $: native });
  vm.runInContext(source, context);
  return { board, read: () => JSON.parse(JSON.stringify(context.read(board))), write: r => context.write(board, r), array, data,
    serve: () => context.run(['--serve']), once: () => context.run([]), written };
}
const items = [[{ type: 'public.rtf', data: 'AAEC' }, { type: 'public.png', data: 'AwQF' }], [{ type: 'public.file-url', data: 'BgcI' }]];
test('native helper prepares and restores every item and binary representation, including an empty board', () => {
  const h = fixture(); h.write({ expectedCount: 20, items });
  assert.deepEqual(h.read().items, items); assert.equal(h.board.writes, 1);
  h.write({ expectedCount: 21, items: [] }); assert.deepEqual(h.read().items, []);
});
test('malformed, duplicate or promised bytes refuse before clearing', () => {
  for (const reps of [
    [{ type: 'public.png', data: '?' }],
    [{ type: 'x', data: '' }, { type: 'x', data: '' }],
    [{ type: 'com.apple.filepromise', data: '' }],
  ]) {
    const h = fixture(); assert.throws(() => h.write({ expectedCount: 20, items: [reps] }), /Invalid/);
    assert.equal(h.board.changeCount, 20); assert.equal(h.board.writes, 0);
  }
});
test('a failed write after clear reports its owned generation for recovery', () => {
  const h = fixture(); h.board.writeObjects = () => false;
  assert.throws(() => h.write({ expectedCount: 20, items }), error => error.clipboardMutation === true && error.clipboardCount === 21);
  assert.equal(h.board.changeCount, 21);
});
test('native restore refuses a changed generation before clearing', () => {
  const h = fixture(); assert.throws(() => h.write({ expectedCount: 19, items }), /ownership changed/);
  assert.equal(h.board.changeCount, 20); assert.equal(h.board.writes, 0);
});
test('snapshot refuses missing data, a file promise and the 64 MiB bound', () => {
  for (const [type, data, error] of [
    ['public.png', { isNil: () => true }, /Unreadable/],
    ['com.apple.pasteboard.promised-file-url', undefined, /promises/],
    ['public.png', { isNil: () => false, length: 64 * 1024 * 1024 + 1 }, /64 MiB/],
  ]) {
    const h = fixture(); h.board.pasteboardItems = h.array([{ types: h.array([type]), dataForType: () => data }]);
    assert.throws(() => h.read(), error); assert.equal(h.board.changeCount, 20);
  }
});
test('snapshot refuses an owner change while a promised representation is materialized', () => {
  const h = fixture(); h.board.pasteboardItems = h.array([{ types: h.array(['public.png']), dataForType: () => { h.board.changeCount++; return h.data(Buffer.from('a')); } }]);
  assert.throws(() => h.read(), /ownership changed during snapshot/);
});

test('a nominally successful write that drops an item fails verification with its owned generation', () => {
  const h = fixture();
  h.board.writeObjects = objects => { h.board.pasteboardItems = h.array([objects.objectAtIndex(0)]); return true; };
  assert.throws(() => h.write({ expectedCount: 20, items }), error => /verification/.test(error.message) && error.clipboardMutation === true && error.clipboardCount === 21);
});

test('line helper handles fragmented requests and multiple operations before EOF', () => {
  const text = JSON.stringify({ id: 1, op: 'write', expectedCount: 20, items }) + '\n' + JSON.stringify({ id: 2, op: 'read' }) + '\n';
  const h = fixture([text.slice(0, 17), text.slice(17, -2), text.slice(-2)]);
  h.serve();
  assert.deepEqual(h.written.map(r => [r.id, r.ok, r.count]), [[1, true, 21], [2, true, 21]]);
  assert.deepEqual(h.written[1].items, items);
});

test('line helper preserves write-failure metadata and continues with the next request', () => {
  const h = fixture([JSON.stringify({ id: 1, op: 'write', expectedCount: 20, items }) + '\n' + JSON.stringify({ id: 2, op: 'read' }) + '\n']);
  h.board.writeObjects = () => false;
  h.serve();
  assert.equal(h.written[0].ok, false); assert.equal(h.written[0].mutated, true); assert.equal(h.written[0].count, 21);
  assert.equal(h.written[1].ok, true); assert.equal(h.written[1].count, 21);
});

test('one-shot helper returns a structured failure for malformed input without touching the clipboard', () => {
  const h = fixture(['{']);
  assert.equal(JSON.parse(h.once()).ok, false);
  assert.equal(h.board.changeCount, 20); assert.equal(h.board.writes, 0);
});

test('a 40 MiB request in 64 KiB chunks stays near the native one-shot path time', t => {
  const payloadBytes = 40 * 1024 * 1024;
  // Read ignores the synthetic bytes, isolating framing from AppKit byte IO.
  const text = JSON.stringify({ padding: Buffer.alloc(payloadBytes, 0xa5).toString('base64'), op: 'read', id: 7 }) + '\n';
  const chunks = [];
  for (let at = 0; at < text.length; at += 64 * 1024) chunks.push(text.slice(at, at + 64 * 1024));
  const once = fixture([...chunks]), streamed = fixture([...chunks]);
  const startOnce = performance.now();
  assert.equal(JSON.parse(once.once()).ok, true);
  const oneShotMs = performance.now() - startOnce;
  const start = performance.now();
  streamed.serve();
  const streamedMs = performance.now() - start;
  assert.deepEqual(streamed.written.map(r => [r.id, r.ok, r.count]), [[7, true, 20]]);
  assert.equal(streamed.board.writes, 0);
  t.diagnostic(JSON.stringify({ payloadBytes, wireBytes: text.length, chunkBytes: 65536, oneShotMs, streamedMs }));
  assert.ok(streamedMs < 10000, 'request assembly must fit the helper deadline');
  assert.ok(streamedMs < Math.max(1000, oneShotMs * 6), `streamed ${streamedMs} ms vs one-shot ${oneShotMs} ms`);
});

test('an unterminated request still refuses above the 96 MiB transport limit', () => {
  const h = fixture(Array(33).fill('A'.repeat(3 * 1024 * 1024)));
  h.serve();
  assert.deepEqual(h.written, []);
  assert.equal(h.board.changeCount, 20); assert.equal(h.board.writes, 0);
});

function paddedRequest(id, bytes) {
  const head = `{"id":${id},"op":"read","padding":"`;
  return head + 'A'.repeat(bytes - head.length - 3) + '"}\n';
}

test('request size includes the delimiter and accepts exactly 96 MiB', () => {
  for (const extra of [0, 1]) {
    const h = fixture([paddedRequest(7, 96 * 1024 * 1024 + extra)]);
    h.serve();
    assert.deepEqual(h.written.map(reply => reply.id), extra ? [] : [7]);
    assert.equal(h.board.writes, 0);
  }
});

test('coalesced requests reset the bound for each frame even when the chunk exceeds it', () => {
  const h = fixture([paddedRequest(7, 49 * 1024 * 1024) + paddedRequest(8, 49 * 1024 * 1024)]);
  h.serve();
  assert.deepEqual(h.written.map(reply => reply.id), [7, 8]);
});

test('a complete request is handled before an oversized partial frame closes the helper', () => {
  const h = fixture([paddedRequest(7, 80) + 'A'.repeat(96 * 1024 * 1024 + 1)]);
  h.serve();
  assert.deepEqual(h.written.map(reply => reply.id), [7]);
  assert.equal(h.board.writes, 0);
});
