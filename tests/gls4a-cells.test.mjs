import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './fixtures/gls2-runtime.mjs';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { formFixture } from './fixtures/runtime-helpers.mjs';

const seven = readFileSync(new URL('./fixtures/glc2-calculator-after-seven.txt', import.meta.url), 'utf8');
const zero = seven.replace('StandardInputView;value:7', 'StandardInputView;value:0')
  .replace('Edit field, Value: 7', 'Edit field, Value: 0').replace('Clear, ID: Clear', 'All Clear, ID: AllClear');
const text = result => result.content.map(item => item.text ?? '').join('\n');

test('GLS4-1 plain recorded keypad cell delivers exactly one post read and changed Value lines', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { initial: zero, afterClick: () => seven, plainAction: true });
  assert.equal((await f.js('let app = await cua.getApp("Calculator");')).isError, false);
  const before = f.calls.length;
  const result = await f.js('await app.click({id:"Seven"}); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /^- .*Edit field, Value: 0$/m);
  assert.match(text(result), /^\+ .*Edit field, Value: 7$/m);
  assert.equal(f.calls.slice(before).filter(row => row.method === 'getAXState').length, 2, 'one admission and one post read');
  assert.ok(result.timing.actions.at(-1).postReadMs > 0, JSON.stringify(result.timing));
  assert.equal((await f.js('await app.click({id:"One"}); void 0;')).isError, false, 'handle follows the post read');
});

test('GLS4-1 two plain actions get one final read; explicit final read avoids an extra read', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { initial: zero, afterClick: () => seven, plainAction: true });
  await f.js('let app = await cua.getApp("Calculator");');
  let before = f.calls.length;
  let result = await f.js('await app.click({id:"Seven"}); await app.click({id:"One"}); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.slice(before).filter(row => row.method === 'getAXState').length, 3);
  before = f.calls.length;
  result = await f.js('await app.click({id:"One"}); await app.getAXState(); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.slice(before).filter(row => row.method === 'getAXState').length, 2);
});

test('GLS4-3 a refused menu title resyncs the handle without changing F, then the numbered leaf binds', { skip: replWorkerSkip }, async t => {
  const captured = readFileSync(new URL('./fixtures/gls4-calculator-scientific.txt', import.meta.url), 'utf8');
  const title = Number(/^\t*(\d+) View$/m.exec(captured)[1]);
  const item = Number(/^\t*(\d+) menu item (?:\([^\n]*?\) )?Basic(?:,.*)?$/m.exec(captured)[1]);
  const f = await fixture(t, { initial: captured, realPolicy: true });
  await f.js('let app = await cua.getApp("Calculator");');
  const refused = await f.js(`await app.click(${title});`);
  assert.equal(refused.isError, true, text(refused));
  assert.match(text(refused), /ACTION_UNSUPPORTED/);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 0);
  const next = await f.js(`await app.click(${item}); void 0;`);
  assert.equal(next.isError, false, text(next));
  assert.equal(f.calls.filter(row => row.method === 'click').length, 1);
});

for (const wireClient of [false, true]) for (const [name, output] of [
  ['filter', 'st.split("\\n").filter(l => /View|Basic|Mode|menu \\(/.test(l)).join("\\n")'],
  ['JSON slice', 'JSON.stringify(st).slice(0,6000)'],
]) test('GLS4-2 recorded r3 ' + name + ' replay through real worker, real client=' + wireClient, { skip: replWorkerSkip }, async t => {
  const captured = readFileSync(new URL(name === 'filter' ? './fixtures/gls4-calculator-scientific.txt' : './fixtures/gls4-calculator-basic.txt', import.meta.url), 'utf8');
  const f = await fixture(t, { initial: captured, wireClient });
  const read = await f.js(`let app = await cua.getApp("Calculator"); let st = await app.getAXState({disableDiffing:true}); nodeRepl.write(${output});`);
  assert.equal(read.isError, false, text(read));
  const result = await f.js(name === 'filter' ? 'await app.click(97); void 0;' :
    'let app = await cua.getApp("Calculator"); for (const id of ["AllClear","Two","Five","Multiply","Three","Three","Equals"]) await app.click({id}); await app.getAXState(); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(row => row.method === 'click').length, name === 'filter' ? 1 : 7);
});

for (const sentVerified of [false, true]) test('GLS4-9 action-ending cell prints one parent summary and no receipt JSON, verified=' + sentVerified, { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { initial: zero, afterClick: () => seven, plainAction: true, sentVerified });
  await f.js('let app = await cua.getApp("Calculator");');
  const result = await f.js('await app.click(14);');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), new RegExp('click 14.*sent, ' + (sentVerified ? 'verified' : 'unverified')));
  assert.doesNotMatch(text(result), /"(?:delivery|timing|retry|window)":|retry=read-first/);
  assert.match(text(result), /lines changed/);
});

test('GLS4-3 helper inspection refusals preserve the parent admission readId too', { skip: replWorkerSkip }, async t => {
  const window = { windowId: '101', processStart: '1.2', pid: 42, bundleId: 'test.fixture',
    app: 'Fixture', title: 'Draft', identityVerified: true };
  const tree = 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 text field Name';
  let clicks = 0;
  const client = createMacReplClient({ environment: () => ({}), admit: () => true,
    driver: { async restart() {}, async close() {}, async request(method, params) {
      if (method === 'click') { assert.equal(params.readId, 2); clicks++; return { window, readId: 2, delivery: 'sent-verified' }; }
      return { window, readId: method === 'getApp' ? 1 : 2, text: tree };
    } }, inspectHelperCall() {
      throw Object.assign(Error('refused'), { code: 'ACTION_UNSUPPORTED', menuRefusal: 'menu-compound',
        parentSafety: true, delivery: 'not-sent', retry: 'safe', readId: 2 });
    } });
  t.after(() => client.close());
  await client.execute({ code: `let app=await cua.getApp("Fixture"); var h=(${formFixture.toString()})({Name:{}},app); void 0;` });
  const refused = await client.execute({ code: 'await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"}]);' });
  assert.equal(refused.isError, true);
  const next = await client.execute({ code: 'await app.click(1); void 0;' });
  assert.equal(next.isError, false, text(next)); assert.equal(clicks, 1);
});
