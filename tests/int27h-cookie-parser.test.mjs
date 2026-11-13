import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { engineConsent } from '../plugins/sleight/lib/consent-wall.mjs';
import { elementLines, guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const header = 'Window: "Fixture", App: Browser.\n0 standard window Fixture\n\t1 HTML content Fixture';
const wall = header + '\n\t\t2 dialog\n\t\t\t3 text We use cookies\n\t\t\t4 button Accept all\n\t\t\t5 button Reject all';
async function click(text, id, { fresh = text } = {}) {
  let current = text;
  const expected = windowFromText(fresh);
  const sent = [], raw = { getAXState: async () => current, click: async target => { sent.push(target); } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const run = source => runInNewContext(`(async () => { ${source} })()`, context);
  await run(readCode('await cua.getApp("' + expected.app + '");'));
  current = fresh;
  await run(guardedCode(`await app.click(${id});`, expected, 'Stopped.'));
  assert.deepEqual(sent, [id]);
}
const excel = JSON.parse(readFileSync(new URL('./fixtures/excel-reacquire.json', import.meta.url))).results[3].rest[1];
const bodies = new Map(), repeated = new Map();
for (const raw of excel.split('\n')) {
  const row = /^\t*(\d+) (.*)$/.exec(raw);
  if (!row) continue;
  const id = Number(row[1]);
  if (bodies.has(id)) { assert.equal(bodies.get(id), row[2]); repeated.set(id, row[2]); }
  bodies.set(id, row[2]);
}
assert.equal(repeated.size, 17);
// Check the original compound reply's number map. For serialized dispatch,
// put its same 17 repeats next to their primary rows, preserving both window
// identity and parents. The original rootless tail proves neither separately.
const primaryExcel = excel.split('\nWindow: ')[0];
const repeatedExcel = primaryExcel.split('\n').flatMap(raw => {
  const row = /^\t*(\d+) /.exec(raw);
  return row && repeated.has(Number(row[1])) ? [raw, raw] : [raw];
}).join('\n');
for (const [id, body] of repeated) test('INT27H identical Excel repeat resolves and dispatches ' + id, async () => {
  assert.equal(elementLines(excel).get(id), body);
  await click(repeatedExcel, id);
});

const selectedDocument = header + '\n\t\t2 text Note\nSelected:\n\t\t3 button Next\n\t\t4 button Finish\n5 menu bar\n\t6 Browser\nSelected:\n\t3 button Next';
for (const [id, body] of [[3, 'button Next'], [4, 'button Finish'], [5, 'menu bar'], [6, 'Browser']])
  test('INT27H document Selected line retains fresh row ' + id, async () => {
    assert.equal(elementLines(selectedDocument).get(id), body);
    await click(selectedDocument, id);
  });
const selectedWall = wall.replace('\n\t\t\t4 button', '\nSelected:\n\t\t\t4 button') + '\n6 menu bar\n\t7 Browser\nSelected:\n\t5 button Reject all';
test('INT27H fresh footer rows remain wall controls and a real echo adds no ancestry', () => {
  assert.match(engineConsent('click', [4], selectedWall)?.why ?? '', /Reject all/);
  assert.equal(engineConsent('click', [5], selectedWall)?.decline, true);
  assert.equal(elementLines(selectedWall).get(4), 'button Accept all');
  assert.equal(elementLines(selectedWall).get(7), 'Browser');
});
test('INT27H serialized fresh footer rows permit Reject and block Accept with its hint', async () => {
  await click(selectedWall, 5);
  await assert.rejects(click(selectedWall, 4), error => /Reject all/.test(error.message) && !/could not be verified/.test(error.message));
});
for (const separator of ['\r', '\u2028', '\u2029']) {
  const after = wall + '\n\t\t6 text a' + separator + 'b\n7 menu bar\n\t8 Browser';
  const beside = header + '\n\t\t2 dialog Print\n\t\t\t3 text Printer settings\n\t\t4 text a' + separator + 'b\n\t\t5 dialog\n\t\t\t6 text We use cookies\n\t\t\t7 button Accept all\n\t\t\t8 button Reject all\n9 menu bar\n\t10 Browser';
  for (const [where, text, accept, reject] of [['after closed wall', after, 4, 5], ['beside unrelated dialog', beside, 7, 8]]) {
    test('INT27H separator ' + JSON.stringify(separator) + ' ' + where + ' keeps Accept verifiable', () => {
      const result = engineConsent('click', [accept], text);
      assert.equal(result?.blocked, true);
      assert.match(result.why, /Reject all/);
      assert.doesNotMatch(result.why, /could not be verified/);
    });
    test('INT27H separator ' + JSON.stringify(separator) + ' ' + where + ' keeps Reject verifiable', async () => {
      assert.equal(engineConsent('click', [reject], text)?.decline, true);
      await click(text, reject);
    });
  }
}
