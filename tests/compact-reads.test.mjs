import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD_MARK, GUARD_END, GUARD_OMIT_MARK, createReadCompactor, lineDiff, dropAcquisitionTree, hasFullTree } from '../plugins/sleight/lib/compact-reads.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

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

test('a call that acted and ended on the window Claude last saw gets the whole tree, not "no change"', () => {
  // calculator-click, 2026-10-10: Calculator still showed 17 × 23 = 391 from the run before, so the
  // batch that computed it ended on an identical tree, and "no change" sent Claude to read again.
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  const after = tree(sidebar);
  const [out] = c.process([text(GUARD_MARK + after)], { action: c.beginAction('await app.click({ id: "Equals" })') }).map(i => i.text);
  assert.doesNotMatch(out, /no change since/);
  assert.match(out, /Chat 49/);
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
  assert.match(out, /59 other elements have new numbers/);
  assert.match(out, /getAXState\(\)/);
  assert.doesNotMatch(out, /disableDiffing/);
  assert.doesNotMatch(out, /Story 30/);
  assert.equal(c.staleIndex(window, 'await app.click(2)'), undefined, 'a number before the insert is unchanged');
  assert.equal(c.staleIndex(window, 'await app.click(3)'), undefined, 'a number from a + line is current');
  assert.deepEqual(c.staleIndex(window, 'await app.click(10)'), { number: 10 }, 'a shifted number is refused');
  assert.deepEqual(c.staleIndex(window, 'await app.click(i)'), { computed: 'i' });
  assert.equal(c.staleIndex(window, 'await app.click([10, 20])'), undefined, 'coordinates are not element numbers');
  assert.equal(c.staleIndex(window, 'await app.click({ id: "Seven" })'), undefined, 'an ID resolves fresh inside the call');
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

test('the relay remaps a stale number Claude saw, refuses one it never saw, and forwards a current one', async t => {
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
  // SLEIGHT_WORKFLOW_DOCS=0: by default an action result shows renumbered lines with current numbers (workflow-docs.test.mjs),
  // so the remap below only comes up with the A/B baseline or a number the result didn't show.
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', changeReview: false, workflowDocs: false, inputLease: new InputLease({ directory, holder: 'A' }) });
  t.after(() => { relay.close(); removeTemp(directory); });
  const js = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, text) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } }) + '\n');
  const grown = tree(['\t2 link Story 0', '\t3 link Breaking story', ...Array.from({ length: 59 }, (_, i) => `\t${i + 4} link Story ${i + 1}`)], 'news');
  js(1, 'let app = await cua.getApp("com.apple.TextEdit")'); await settle(); reply(1, page(60)); await settle();
  js(2, 'await app.click(5)'); await settle(); reply(2, GUARD_MARK + grown); await settle();
  assert.match(toClient.find(m => m.id === 2).result.content[0].text, /59 other elements have new numbers/);
  // Claude saw Story 8 as 10; it is 11 now. The click goes out naming Story 8 by its line.
  js(3, 'await app.click(10)'); await settle();
  assert.match(toServer.find(m => m.id === 3).params.arguments.code, /app\.click\(\{"line":"link Story 8"\}\)/);
  reply(3, GUARD_MARK + grown); await settle();
  assert.match(JSON.stringify(toClient.find(m => m.id === 3)), /10 was found by its line \\"link Story 8\\"/);
  // A number Claude never saw for an element is still refused.
  js(5, 'await app.click(99)'); await settle();
  assert.match(toClient.find(m => m.id === 5).result.content[0].text, /Input lease: element 99 may be stale/);
  assert.ok(!toServer.some(m => m.id === 5), 'the stale click never reached the engine');
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
  // The relay sends a call that met a restarting helper once more on its own; this failure persists.
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Sky Computer Use service startup request failed' }] } }) + '\n');
  await new Promise(r => setTimeout(r, 20));
  const text = toClient.find(m => m.id === 1).result.content.map(c => c.text).join('\n');
  assert.match(text, /never reached an app.*js_reset/s);
});

test('a read Claude asked to see whole comes back whole, and later diffs start from it', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  const [whole] = c.process([text(GUARD_MARK + tree(sidebar))], { forceFull: true }).map(i => i.text);
  assert.equal(whole, tree(sidebar));
  const [next] = apply(c, GUARD_MARK + tree([...sidebar, '\t60 button OK']));
  assert.match(next, /\+ \t60 button OK$/);
});

test('a write without a tree preserves the visible baseline for the next diff', () => {
  const c = createReadCompactor();
  apply(c, tree(sidebar));
  const [out] = c.process(
    [text('total 1247.50' + GUARD_OMIT_MARK + tree([...sidebar, '\t60 button OK']) + GUARD_END)],
    { forceFull: true },
  ).map(i => i.text);
  assert.equal(out, 'total 1247.50');
  const [next] = apply(c, GUARD_MARK + tree([...sidebar, '\t60 button OK', '\t61 button Done']));
  assert.match(next, /\+ \t60 button OK/);
  assert.match(next, /\+ \t61 button Done$/);
});

test('a stale number names the element Claude saw by its line, when that line is unique now', () => {
  const c = createReadCompactor();
  const window = { title: 'news', app: 'TextEdit', url: 'file:///tmp/news' };
  apply(c, page(60));
  const grown = tree(['\t2 link Story 0', '\t3 link Breaking story', ...Array.from({ length: 59 }, (_, i) => `\t${i + 4} link Story ${i + 1}`)], 'news');
  apply(c, GUARD_MARK + grown);
  // Claude saw Story 8 as 10; it is 11 now.
  assert.deepEqual(c.remapStale(window, 'await app.click(3); await app.click(10, { clickCount: 2 })'), {
    code: 'await app.click(3); await app.click({"line":"link Story 8"}, { clickCount: 2 })',
    remapped: [{ number: 10, line: 'link Story 8' }] });
  assert.equal(c.remapStale(window, 'await app.click(3)'), undefined, 'nothing stale, nothing to rewrite');
  assert.equal(c.remapStale(window, 'await app.click(i)'), undefined);
  apply(c, grown);
  assert.equal(c.remapStale(window, 'await app.click(10)'), undefined, 'after a full read the number is current');
});

test('a stale number is never remapped to a removed element or to one of several alike', () => {
  const c = createReadCompactor();
  const window = { title: 'news', app: 'TextEdit', url: 'file:///tmp/news' };
  apply(c, tree(['\t2 link Story 0', '\t3 link Same', '\t4 link Gone', ...Array.from({ length: 120 }, (_, i) => `\t${i + 5} link Story ${i + 1}`)], 'news'));
  apply(c, GUARD_MARK + tree(['\t2 link New', '\t3 link Story 0', '\t4 link Same', '\t5 link Same', ...Array.from({ length: 120 }, (_, i) => `\t${i + 6} link Story ${i + 1}`)], 'news'));
  assert.equal(c.remapStale(window, 'await app.click(4)'), undefined, 'Gone was removed');
  assert.equal(c.remapStale(window, 'await app.click(3)'), undefined, 'two lines read "link Same" now');
  assert.deepEqual(c.remapStale(window, 'await app.click(6)').remapped, [{ number: 6, line: 'link Story 2' }]);
  assert.equal(c.remapStale(window, 'await app.click(6); await app.click(4)'), undefined, 'one unresolved number keeps the refusal');
});

const fullButtons = Array.from({ length: 40 }, (_, i) => `\t${i + 1} button Description: ${i}, ID: Button${i}`);
const bareButtons = offset => Array.from({ length: 40 }, (_, i) => `\t${i + 1 + offset} button Button${i}`);
const buttonWindow = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
test('degraded button attributes produce a short notice without invalidating unchanged numbers', () => {
  const c = createReadCompactor(); apply(c, tree(fullButtons));
  const [out] = apply(c, GUARD_MARK + tree(bareButtons(0)));
  assert.ok(out.length < tree(bareButtons(0)).length / 2);
  assert.match(out, /40 button lines returned fewer attributes/);
  assert.equal(c.staleIndex(buttonWindow, 'app.click(20)'), undefined);
  // Fresh attributes are shown again; no old description is silently treated as current.
  assert.match(apply(c, GUARD_MARK + tree(fullButtons.map(l => l.replace('Description: 19,', 'Description: Changed,'))))[0], /Description: Changed/);
});
test('degradation with renumbering stays stale and remaps only to a unique current line', () => {
  const unchanged = Array.from({length:40}, (_, i) => `\t${i + 100} link Sidebar ${i}`);
  const c = createReadCompactor(); apply(c, tree([...fullButtons, ...unchanged]));
  apply(c, GUARD_MARK + tree(['\t1 button New', ...bareButtons(1), ...unchanged]));
  assert.deepEqual(c.staleIndex(buttonWindow, 'app.click(20)'), { number: 20 });
  assert.deepEqual(c.remapStale(buttonWindow, 'app.click(20)').remapped, [{number:20, line:'button Button19'}]);
});
test('ambiguous bare names and lost values never count as a harmless attribute degradation', () => {
  const c = createReadCompactor();
  apply(c, tree([...sidebar, '\t90 button Description: Left, ID: Same', '\t91 button Description: Right, ID: Same', '\t92 button Value: On, ID: Toggle']));
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t90 button Same', '\t91 button Same', '\t92 button Toggle']));
  assert.doesNotMatch(out, /button lines returned fewer attributes/);
  assert.match(out, /\+ \t92 button Toggle/);
});

test('a richer line with the same ID prevents folding and stale remapping to a bare button', () => {
  const c = createReadCompactor();
  apply(c, tree([...sidebar, '\t90 button Description: Save, ID: Action']));
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t91 button Action',
    '\t92 button Description: Save, ID: Action, Help: new']));
  assert.doesNotMatch(out, /button lines returned fewer attributes/);
  assert.equal(c.remapStale(buttonWindow, 'app.click(90)'), undefined);
});

test('an old bare button sharing the ID also prevents folding a richer button', () => {
  const c = createReadCompactor();
  apply(c, tree([...sidebar, '\t90 button Description: Save, ID: Action', '\t91 button Action']));
  const [out] = apply(c, GUARD_MARK + tree([...sidebar, '\t92 button Action']));
  assert.doesNotMatch(out, /button lines returned fewer attributes/);
  assert.equal(c.remapStale(buttonWindow, 'app.click(90)'), undefined);
});

test('a split acquisition\'s tree is left out only when the rest of its call returns a newer full tree', () => {
  const tree = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled\n\t1 text entry area';
  const head = [{ type: 'text', text: '## Computer Use\ndocs\n' + tree }];
  assert.deepEqual(dropAcquisitionTree(head, [{ type: 'text', text: tree + '\n\t2 button' }]), [{ type: 'text', text: '## Computer Use\ndocs' }]);
  assert.deepEqual(dropAcquisitionTree([{ type: 'text', text: tree }], [{ type: 'text', text: tree }]), []);
  const diff = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled\nsleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):\n+ \t2 button';
  assert.equal(hasFullTree(diff), false);
  assert.equal(dropAcquisitionTree(head, [{ type: 'text', text: diff }]), head, 'a diff needs the tree it was taken against');
  assert.equal(dropAcquisitionTree(head, [{ type: 'text', text: 'saved' }]), head);
});


test('an action full read drops an identical guard tree across text items and retains its delta', () => {
  const c = createReadCompactor();
  apply(c, tree([...sidebar, '\t60 text field Value: before']));
  const action = c.beginAction('await app.typeText("after")');
  const after = tree([...sidebar, '\t60 text field Value: after']);
  const out = c.process([text(after), text(GUARD_MARK + after + GUARD_END)],
    { explicitFull: true, action }).map(i => i.text).join('\n');
  assert.equal(out.match(/standard window/g)?.length, 1);
  assert.match(out, /UI changed \(value\)/);
});


for (const split of [false, true]) {
  test('duplicate marked action reads keep the full read and its UI note, split=' + split, () => {
    const c = createReadCompactor();
    apply(c, tree([...sidebar, '\t60 text field Value: before']));
    const action = c.beginAction('await app.typeText("after")');
    const after = tree([...sidebar, '\t60 text field Value: after']);
    const marked = GUARD_MARK + after + GUARD_END;
    const out = c.process((split ? [marked, marked] : [marked + marked]).map(text),
      { explicitFull: true, action }).map(i => i.text).join('\n');
    assert.equal(out.match(/standard window/g)?.length, 1);
    assert.match(out, /UI changed \(value\)/);
  });
}

test('a different guard tree stays visible and invalidates numbers absent from it', () => {
  const c = createReadCompactor();
  const before = tree([...sidebar, '\t60 button Old']);
  apply(c, before);
  const action = c.beginAction('await app.click(60)');
  const after = tree([...sidebar, '\t61 button New']);
  const out = c.process([text(before), text(GUARD_MARK + after + GUARD_END)],
    { explicitFull: true, action }).map(i => i.text).join('\n');
  assert.equal(out.match(/standard window/g)?.length, 2);
  assert.match(out, /61 button New/);
  assert.equal(c.seenLines({ title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' }, [60]), undefined);
});

test('a plain read after renumbering shows current numbers for previously visible lines', () => {
  const c = createReadCompactor();
  const window = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
  const before = tree([...sidebar, '\t60 button First', '\t61 button Second']);
  const after = tree([...sidebar, '\t61 button First', '\t60 button Second']);
  apply(c, before);
  apply(c, GUARD_MARK + after + GUARD_END);
  assert.deepEqual(c.staleIndex(window, 'app.click(60)'), { number: 60 });
  const out = c.process([text(GUARD_MARK + after + GUARD_END)],
    { code: 'await app.getAXState()' }).map(i => i.text).join('\n');
  assert.match(out, /\+ \t61 button First/);
  assert.match(out, /\+ \t60 button Second/);
  assert.doesNotMatch(out, /Chat 49/);
  assert.equal(c.staleIndex(window, 'app.click(60)'), undefined);
  assert.equal(c.staleIndex(window, 'app.click(61)'), undefined);
});

test('a re-acquired window shown whole later in the call drops its duplicate acquisition tree, never another window\'s', async () => {
  const { dropAcquisitionTree } = await import('../plugins/sleight/lib/compact-reads.mjs');
  const tree = (title, row) => `Window: "${title}", App: Editor.\n0 standard window ${title}\n\t1 button ${row}`;
  const head = [{ type: 'text', text: 'note before\n' + tree('Report', 'Open') }];
  assert.deepEqual(dropAcquisitionTree(head, [{ type: 'text', text: tree('Report', 'Saved') }]), [{ type: 'text', text: 'note before' }]);
  assert.deepEqual(dropAcquisitionTree(head, [{ type: 'text', text: tree('Other', 'Saved') }]), head);
  assert.deepEqual(dropAcquisitionTree(head, [{ type: 'text', text: 'no tree here' }]), head);
});


test('observed line inventory can remap replay identities without guessing element numbers', () => {
  const c = createReadCompactor();
  const window = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
  apply(c, tree(['\t171 image ID: source', '\t192 image ID: target']));
  const lines = c.seenLines(window);
  assert.equal(lines[171], 'image ID: source'); assert.equal(lines[192], 'image ID: target');
  assert.equal(c.seenLines({ ...window, title: 'unobserved' }), undefined);
});
