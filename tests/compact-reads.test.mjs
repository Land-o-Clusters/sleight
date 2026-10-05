import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD_MARK, createReadCompactor, lineDiff } from '../plugins/sleight/lib/compact-reads.mjs';

const tree = (rows, title = 'a.txt') => [`Window: "${title}", App: TextEdit.`,
  `0 standard window ${title}, URL: file:///tmp/${title}, Secondary Actions: Raise`, ...rows].join('\n');
const sidebar = Array.from({ length: 50 }, (_, i) => `\t${i + 2} row (selectable) Value: Chat ${i}`);
const text = item => ({ type: 'text', text: item });
const apply = (c, ...items) => c.process(items.map(text)).map(i => i.text);

test('the line diff lists removed and added lines in order', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), ['- b', '+ x', '+ e']);
  assert.deepEqual(lineDiff(['a'], ['a']), []);
});

test('a guard read after a full tree Claude saw becomes the changed lines', () => {
  const c = createReadCompactor();
  const before = tree([...sidebar, '\t1 text entry area Value: alpha']);
  assert.deepEqual(apply(c, before), [before], 'a full tree Claude reads passes through');
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t1 text entry area Value: alpha beta']));
  assert.match(out, /^Window: "a\.txt", App: TextEdit\.\n0 standard window a\.txt, URL: file:\/\/\/tmp\/a\.txt/);
  assert.match(out, /- \ttext entry area Value: alpha\n\+ \t1 text entry area Value: alpha beta$/, 'a removed line shows no number');
  assert.doesNotMatch(out, /Chat 7/, 'the unchanged sidebar is left out');
});

test('an unchanged window says so, and the next diff starts from the guard read', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  assert.match(apply(c, GUARD_MARK + tree(sidebar))[0], /no change since the last full tree/);
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t60 button OK']));
  assert.match(out, /\+ \t60 button OK$/);
});

test('the first read of a window, another window, or a large change is sent whole without the mark', () => {
  const c = createReadCompactor();
  const first = tree(sidebar);
  assert.deepEqual(apply(c, GUARD_MARK + first), [first]);
  const other = tree(sidebar, 'b.txt');
  assert.deepEqual(apply(c, GUARD_MARK + other), [other]);
  const rerendered = tree(sidebar.map(l => l.replace('row', 'cell')), 'b.txt');
  assert.deepEqual(apply(c, GUARD_MARK + rerendered), [rerendered], 'a re-render is shorter whole');
});

test('engine diffs and other output never replace the copy', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  apply(c, 'The following is a diff from the previous accessibility tree for Window: "a.txt"\n+ \t99 button X', 'note');
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t99 button X']));
  assert.match(out, /\+ \t99 button X$/, 'changes Claude saw in an engine diff are shown again, never lost');
});

test("a guard read after Claude's own output in the same item is compacted, and that output counts as seen", () => {
  const c = createReadCompactor();
  const [first] = apply(c, '<notes>\n' + tree(sidebar));
  assert.match(first, /<notes>/, 'a full tree mid-item passes through');
  const [out] = apply(c, 'RAW 123' + GUARD_MARK + tree([...sidebar, '\t70 text 1']));
  assert.match(out, /^RAW 123\nWindow: "a\.txt"/);
  assert.match(out, /\+ \t70 text 1$/);
  assert.doesNotMatch(out, /sleight:guard-read|Chat 7/);
  const own = tree([...sidebar, '\t70 text 2']);
  const [next] = apply(c, own + '\n' + GUARD_MARK + own);
  assert.match(next, /no change since the last full tree/, "Claude's own full read in the same call is the baseline");
});

const page = n => tree(Array.from({ length: n }, (_, i) => `\t${i + 2} link Story ${i}`), 'news');

test('loaded content renumbers later elements: they are left out and counted, and their numbers become stale', () => {
  const c = createReadCompactor();
  const window = { title: 'news', app: 'TextEdit', url: 'file:///tmp/news' };
  apply(c, page(60));
  const grown = tree(['\t2 link Story 0', '\t3 link Breaking story', ...Array.from({ length: 59 }, (_, i) => `\t${i + 4} link Story ${i + 1}`)], 'news');
  const [out] = apply(c, GUARD_MARK + grown);
  assert.match(out, /\+ \t3 link Breaking story/);
  assert.match(out, /59 other elements kept their text but have new numbers/);
  assert.doesNotMatch(out, /Story 30/);
  assert.equal(c.staleIndex(window, 'await app.click(2)'), undefined, 'a number before the insert is unchanged');
  assert.equal(c.staleIndex(window, 'await app.click(3)'), undefined, 'a number from a + line is current');
  assert.deepEqual(c.staleIndex(window, 'await app.click(10)'), { number: 10 }, 'a shifted number is refused');
  assert.deepEqual(c.staleIndex(window, 'await app.click(i)'), { computed: 'i' });
  assert.equal(c.staleIndex(window, 'await app.click([10, 20])'), undefined, 'coordinates are not element numbers');
  apply(c, grown);
  assert.equal(c.staleIndex(window, 'await app.click(10)'), undefined, 'a full read makes every number current');
});

test('a number Claude saw on an identical line in the same result counts as current', () => {
  const c = createReadCompactor();
  const window = { title: 'news', app: 'TextEdit', url: 'file:///tmp/news' };
  apply(c, page(60));
  const grown = tree(['\t2 link Breaking story', ...Array.from({ length: 60 }, (_, i) => `\t${i + 3} link Story ${i}`)], 'news');
  apply(c, '+\t42 link Story 39\n~\t7 link Wrong text' + GUARD_MARK + grown);
  assert.equal(c.staleIndex(window, 'app.click(42)'), undefined);
  assert.deepEqual(c.staleIndex(window, 'app.click(7)'), { number: 7 }, 'a line that differs from the current tree proves nothing');
});

test('windows that never renumber are never restricted', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  apply(c, GUARD_MARK + tree([...sidebar, '\t70 text 1']));
  assert.equal(c.staleIndex({ title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' }, 'app.click(n)'), undefined);
});

test('the relay refuses an action on a stale number and forwards one Claude saw', async t => {
  const { PassThrough } = await import('node:stream');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
  const { InputLease } = await import('../plugins/sleight/lib/input-lease.mjs');
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-stale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', changeReview: false, inputLease: new InputLease({ directory, holder: 'A' }) });
  t.after(() => relay.close());
  const js = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, text) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } }) + '\n');
  const grown = tree(['\t2 link Story 0', '\t3 link Breaking story', ...Array.from({ length: 59 }, (_, i) => `\t${i + 4} link Story ${i + 1}`)], 'news');
  js(1, 'let app = await cua.getApp("com.apple.TextEdit")'); await settle(); reply(1, page(60)); await settle();
  js(2, 'await app.click(5)'); await settle(); reply(2, GUARD_MARK + grown); await settle();
  assert.match(toClient.find(m => m.id === 2).result.content[0].text, /59 other elements kept their text/);
  js(3, 'await app.click(10)'); await settle();
  assert.match(toClient.find(m => m.id === 3).result.content[0].text, /Input lease: element 10 may be stale/);
  assert.ok(!toServer.some(m => m.id === 3), 'the stale click never reached the engine');
  js(4, 'await app.click(3)'); await settle();
  assert.ok(toServer.some(m => m.id === 4), 'a number from a + line goes through');
});

test('a helper startup failure tells Claude nothing reached an app and how to recover', async t => {
  const { PassThrough } = await import('node:stream');
  const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toClient = [];
  serverIn.resume();
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', changeReview: false });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } }) + '\n');
  await new Promise(r => setTimeout(r, 20));
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] } }) + '\n');
  await new Promise(r => setTimeout(r, 20));
  const text = toClient.find(m => m.id === 1).result.content.map(c => c.text).join('\n');
  assert.match(text, /never reached an app.*Retry the same call once.*js_reset/s);
});
