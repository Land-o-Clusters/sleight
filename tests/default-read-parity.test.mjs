import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { defaultReadBaseline, sha256 } from './fixtures/default-read-baseline.mjs';

function throughRelay(t, create, code, result, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const received = [];
  clientOut.on('data', bytes => received.push(bytes.toString()));
  const relay = create({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => relay.dispose());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: structuredClone(result) }) + '\n');
  assert.equal(received.length, 1);
  return received[0];
}

const fixtures = ['calculator-tree.txt', 'mdn-418-tree.txt'].map(name => [name, readFileSync(new URL('fixtures/' + name, import.meta.url), 'utf8')]);
fixtures.push(...JSON.parse(readFileSync(new URL('fixtures/browser-open-real-trees.json', import.meta.url))).map((row, i) => ['browser-' + i, row.tree]));
fixtures.push(['inventory', 'Apps:\n- Fixture'], ['boolean', 'true'], ['number', '42'], ['object', '{"ok":true}'],
  ['diff', 'The following is a diff from the previous accessibility tree for Window: "Guide"\n+ \t9 button New'],
  ['omitted', 'Window: "Guide", App: Fixture.\n0 window Guide\nsleight: 10 tree lines omitted.']);
for (const [name, text] of fixtures) test(`default relay bytes equal d3db241c for ${name}`, t => {
  const result = { content: [{ type: 'text', text }] };
  const code = 'nodeRepl.write(await cua.getState());';
  const actual = throughRelay(t, createRelay, code, result);
  assert.equal(sha256(actual), defaultReadBaseline.relay[name]);
  assert.doesNotMatch(actual, /sleight turn:|# complete|# incomplete/);
});

for (const outcomes of [false, true]) for (const completeness of [false, true]) test(`relay flags are independent, outcomes=${outcomes}, completeness=${completeness}`, t => {
  const result = { content: [{ type: 'text', text: fixtures[0][1] }] };
  const text = throughRelay(t, createRelay, 'nodeRepl.write(await cua.getState());', result, { outcomes, completeness });
  assert.equal(/# complete/.test(text), completeness);
  assert.doesNotMatch(text, /sleight turn:/);
});

for (const [code, filtered] of [
  ['nodeRepl.write((await app.getAXState()).filter(x => x));', true],
  ['const rows = await app.getAXState(); nodeRepl.write(rows.filter(x => x));', true],
  ['const $rows = await app.getAXState(); nodeRepl.write($rows.filter(x => x));', true],
  ['let rows = await app.getAXState(); rows = [1,2]; rows.filter(x => x); nodeRepl.write(await app.getAXState());', false],
  ['const names = [1,2].filter(x => x); nodeRepl.write(await app.getAXState());', false],
  ['const unused = [1,2].filter(x => x); nodeRepl.write((await app.getAXState()).slice(0,100));', true],
]) test(`only filtering a read result changes its scope: ${code}`, t => {
  const result = { content: [{ type: 'text', text: fixtures[0][1] }] };
  const text = throughRelay(t, createRelay, code, result, { completeness: true });
  assert.equal(/# incomplete read \(filtered engine view\)/.test(text), filtered);
});

for (const outcomes of [false, true]) for (const completeness of [false, true]) test(`action results keep flags independent, outcomes=${outcomes}, completeness=${completeness}`, t => {
  const result = { content: [{ type: 'text', text: fixtures[0][1] }] };
  const text = throughRelay(t, createRelay, 'await app.pressKey("Return"); await app.getAXState();', result, { outcomes, completeness });
  assert.equal(/sleight turn: 1 input calls unverified/.test(text), outcomes);
  assert.doesNotMatch(text, /# complete|# incomplete/);
});
