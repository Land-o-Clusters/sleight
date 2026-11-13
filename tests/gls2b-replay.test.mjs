import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEvaluator } from '../plugins/sleight/lib/repl/worker.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { checkSessionMenu } from '../plugins/sleight/lib/session-menu.mjs';
const calls = JSON.parse(readFileSync(new URL('./fixtures/gls2b-replay.json', import.meta.url)));
const window = { app: 'Calculator', title: 'Calculator', windowId: '7', processStart: '1.2', pid: 42,
  bundleId: 'test.fixture', identityVerified: true };
const text = result => result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
// Reproduce the recorded target numbers with inert filler rows. These are not
// fresh Calculator observations; the native suite separately proves AX roots.
function tree(expanded, scientific) {
  const rows = ['standard window Calculator', ...Array.from({ length: 31 }, (_, i) => '\tbutton Fixture ' + i),
    '\tbutton Description: Mode, ID: Mode: ' + (scientific ? 'scientific' : 'basic')];
  if (expanded) rows.push('\t\tmenu (expanded)', '\t\t\tmenu item Basic', '\t\t\tmenu item (disabled)', '\t\t\tmenu item Scientific');
  while (rows.length < 149) rows.push('\tbutton Filler ' + rows.length);
  rows.push('menu bar', '\tView', '\t\tmenu (collapsed)', '\t\t\tmenu item Basic', '\t\t\tmenu item Separator', '\t\t\tmenu item Scientific');
  return 'Window: "Calculator", App: Calculator.\n' + rows.map((row, i) => {
    const tabs = /^\t*/.exec(row)[0]; return tabs + i + ' ' + row.slice(tabs.length);
  }).join('\n');
}
function fixture(t) {
  const reads = createMacReadState(), sent = [];
  let readId = 0, expanded = false, scientific = false, cell = 0, snapshots, treeFree = false;
  const observe = () => {
    const reply = { window, text: tree(expanded, scientific), readId: ++readId, truncated: false };
    snapshots.push(reads.read(reply)); return reply;
  };
  const evaluator = createEvaluator({ platform: 'darwin', request: async (method, params) => {
    if (method === 'getApp' || method === 'getAXState') return observe();
    assert.equal(method, 'click');
    reads.assertCurrent(method, params, cell);
    checkSessionMenu({ method, args: params.args, window, text: reads.fullTree(window) });
    const target = params.args[0]; sent.push(target);
    if (target === 32) expanded = true;
    else if (target === 36 && expanded) { expanded = false; scientific = true; }
    else assert.fail('unexpected inert action ' + JSON.stringify(target));
    const reply = observe();
    return { ...treeFree ? { window, readId: reply.readId } : reply,
      delivery: 'sent-unverified', ...target === 36 ? { semantics: 'menu-accessibility' } : {} };
  } });
  t.after(() => evaluator.close());
  return { sent, get readId() { return readId; }, set treeFree(value) { treeFree = value; }, async run(code) {
    cell++; snapshots = []; const result = await evaluator.evaluate(code); reads.endCell(result.content, snapshots); return result;
  } };
}
test('r2 calculator-menu exact calls 3, 5, 6, 17 and 21 through evaluator and delivered-read admission', async t => {
  const f = fixture(t); await f.run('let app = await cua.getApp("Calculator");');
  const third = await f.run(calls[3]); assert.equal(third.isError, true);
  assert.match(text(third), /Menu title:/); assert.equal(f.sent.length, 0);
  const fifth = await f.run(calls[5]); assert.equal(fifth.isError, false, text(fifth));
  assert.match(text(fifth), /menu \(expanded\)/); assert.deepEqual(f.sent, [32]);
  const sixth = await f.run(calls[6]); assert.equal(sixth.isError, false, text(sixth));
  assert.match(text(sixth), /Menu pressed via AX/); assert.deepEqual(f.sent, [32, 36]);
  await f.run('let c3 = await cua.getApp("Calculator");');
  const before17 = f.sent.length, seventeenth = await f.run(calls[17]);
  assert.equal(seventeenth.isError, true); assert.match(text(seventeenth), /STALE_READ/); assert.equal(f.sent.length - before17, 1);
  // GLS4-1 supplies call 20's missing final read after the tree-free reply.
  const g = fixture(t); await g.run('let c3 = await cua.getApp("Calculator");'); g.treeFree = true;
  await g.run('await c3.click(32); nodeRepl.write("opened");');
  const before21 = g.sent.length, twentyFirst = await g.run(calls[21]);
  assert.equal(twentyFirst.isError, false, text(twentyFirst)); assert.match(text(twentyFirst), /Menu pressed via AX/); assert.equal(g.sent.length, before21 + 1);
  t.diagnostic(JSON.stringify({ replay: { 3: 'ACTION_UNSUPPORTED title hint, 0 inputs', 5: 'expanded popup, 1 input',
    6: 'menu-accessibility, 1 input', 17: 'STALE_READ after 1 input', 21: 'post read delivered popup, 1 input' } }));
});
// Replay binding evaluation separately from action admission. Canned driver
// replies make these archived cells inert, including their old target numbers.
for (const cell of calls.redeclare) test('archived redeclaration: ' + cell.run, async t => {
  const requests = []; let readId = 0;
  const evaluator = createEvaluator({ platform: 'darwin', request: async (method, params) => {
    requests.push({ method, params });
    return { window, text: tree(false, false), readId: ++readId, delivery: 'sent-unverified', truncated: false };
  } });
  t.after(() => evaluator.close());
  const initial = await evaluator.evaluate(cell.initial); assert.equal(initial.isError, false, text(initial));
  const result = await evaluator.evaluate(cell.code);
  assert.equal(result.isError, false, text(result)); assert.doesNotMatch(text(result), /SyntaxError/);
  assert.equal(requests.filter(row => row.method === 'click').length, cell.clicks);
  assert.equal(requests.filter(row => row.method === 'getApp').length, 2);
});
