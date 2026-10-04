import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugins/sleight/lib/clipboard.js', import.meta.url), 'utf8');
function fixture() {
  const data = bytes => ({ length: bytes.length, isNil: () => false, base64EncodedStringWithOptions: () => bytes.toString('base64') });
  const array = values => ({ get count() { return values.length; }, objectAtIndex: i => values[i], addObject: v => values.push(v), isNil: () => false });
  const board = { changeCount: 20, writes: 0, pasteboardItems: array([]), writeObjects: objects => { board.writes++; board.pasteboardItems = objects; return true; } };
  Object.defineProperty(board, 'clearContents', { get() { board.changeCount++; board.pasteboardItems = array([]); return board.changeCount; } });
  const native = {
    NSMutableArray: { alloc: { get init() { return array([]); } } },
    NSPasteboardItem: { alloc: { get init() {
      const types = [], reps = new Map();
      return { types: array(types), dataForType: t => reps.get(t), setDataForType: (d, t) => { types.push(t); reps.set(t, d); return true; } };
    } } },
    NSData: { alloc: { initWithBase64EncodedStringOptions: value => data(Buffer.from(value, 'base64')) } },
  };
  const context = vm.createContext({ ObjC: { import: () => {}, unwrap: value => value }, $: native });
  vm.runInContext(source, context);
  return { board, read: () => JSON.parse(JSON.stringify(context.read(board))), write: r => context.write(board, r), array, data };
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
