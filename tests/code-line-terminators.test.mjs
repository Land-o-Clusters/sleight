import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { splitTextSave, statementSpans } from '../plugins/sleight/lib/text-save.mjs';
import { evaluateWrite } from '../plugins/sleight/lib/evaluate-write.mjs';
import { withoutPageCallbacks } from '../plugins/sleight/lib/page-callbacks.mjs';
import { isBrowserRead } from '../plugins/sleight/lib/browser-read.mjs';
import { browserCall } from '../plugins/sleight/lib/browser-call.mjs';
import { sourceOf } from '../plugins/sleight/lib/browser-recovery.mjs';
import { typingReceiptCall } from '../plugins/sleight/lib/typed-text-receipt.mjs';
import { browserActionCount } from '../plugins/sleight/lib/action-outcomes.mjs';
import { unchangedListClicks } from '../plugins/sleight/lib/offscreen-click.mjs';
import { getAppTargets } from '../plugins/sleight/lib/own-host.mjs';

const head = 'await app.click("File"); await app.click("Save"); ';
const ends = [['LF', '\n'], ['CR', '\r'], ['LS', '\u2028'], ['PS', '\u2029'], ['CRLF', '\r\n']];
for (const [name, end] of ends) {
  test(`${name}: a line comment never hides the next token or flow input`, () => {
    assert.deepEqual(tokens(`// c${end}await app.click(3)`).map(t => t.v), ['await', 'app', '.', 'click', '(', '3', ')']);
    const flow = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
    assert.equal(flow.analyze('js', { code: `// c${end}await app.typeText("SECRET")` }, { app: 'Fixture' }).violations.length, 1);
  });
  test(`${name}: a trailing action refuses menu continuation and remains in the save head`, () => {
    for (const tail of ['nodeRepl.write("x")', 'nodeRepl.emitImage(await app.getScreenshot())']) {
      assert.equal(splitMenuActions(head + `${tail} // c${end}await app.click(3)`), undefined);
    }
    const save = splitTextSave(`await app.setValue(1, "safe"); // c${end}await app.click(3); await app.pressKey("super+s")`);
    assert.ok(save.head.includes('await app.click(3)'));
  });
  test(`${name}: evaluate and callback scans see code after comments`, () => {
    assert.match(evaluateWrite(`tab.playwright.evaluate(() => { // c${end}document.body.click(); })`), /read-only/);
    const outside = `tab.playwright.evaluate(() => 1); // c${end}await app.click(3)`;
    assert.ok(withoutPageCallbacks(outside).includes('await app.click(3)'));
    const inside = `tab.playwright.evaluate(() => { // c${end}return 1; }); await app.click(3)`;
    assert.ok(!withoutPageCallbacks(inside).includes('return 1'));
  });
  test(`${name}: routing, retries, receipts and list scans see hidden input`, () => {
    assert.equal(isBrowserRead(`await tab.getAXState(); // c${end}await tab.click(3)`), false);
    assert.equal(browserCall(`await tab.getAXState(); // c${end}await app.click(3)`, new Set(['tab'])), undefined);
    assert.ok(sourceOf(`// c${end}await app.click(3)`).includes('app.click(3)'));
    assert.equal(typingReceiptCall(`await app.typeText("safe"); // c${end}await app.click(3)`), false);
    assert.equal(browserActionCount(`// c${end}await tab.click(3)`), 1);
    const lines = ['0 window Fixture', '\t1 list Items', '\t\t3 row Item'];
    assert.equal(unchangedListClicks(`// c${end}await app.click(3)`, lines, lines).length, 1);
  });
  test(`${name}: literal content stays data and block comments stay comments`, () => {
    const value = `before${end}after`;
    const cooked = end.replace(/\r\n?/g, '\n');
    assert.deepEqual(tokens('`before' + end + 'after`'), [{ v: `before${cooked}after`, string: true }]);
    assert.deepEqual(tokens('"before\\' + end + 'after"'), [{ v: 'beforeafter', string: true }]);
    assert.deepEqual(getAppTargets('await cua.getApp("Fixture\\' + end + 'App")'), ['FixtureApp']);
    assert.equal(evaluateWrite('tab.playwright.evaluate(() => "document.body.click()' + (end.includes('\n') || end.includes('\r') ? '\\' + end : end) + '")'), undefined);
    assert.deepEqual(tokens(`/* before${end}await app.click(3) */ 1`), [{ v: '1' }]);
    assert.ok(splitMenuActions(head + 'nodeRepl.write(`' + value + '`)'));
    assert.ok(statementSpans('await app.setValue(1, `' + value + '`); await app.pressKey("super+s")'));
  });
  if (name !== 'LF') test(`${name}: parser ranges accept engine-valid terminators without allowing interpolated read tails`, () => {
    for (const code of [head + end, head + `// c${end}`, head + `/* c${end} */`, head + 'nodeRepl.write(`${1' + end + '}`)']) {
      assert.ok(statementSpans(code));
      if (code.includes('${1')) assert.equal(splitMenuActions(code), undefined);
      else assert.equal(splitMenuActions(code)?.actions.length, 2);
    }
  });
}

import { unsupportedCodeLines, lineCommentEnd } from '../plugins/sleight/lib/code-line-terminators.mjs';
import { createRelay, nativeGetStateCode, finalReturnCode, usesRequire } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';
import { TurnJournal } from '../plugins/sleight/lib/turn-receipts.mjs';
import { handTargets } from '../plugins/sleight/lib/hand/planner.mjs';
import { createReadCompactor, filteredReadCode } from '../plugins/sleight/lib/compact-reads.mjs';
import { finalExpression, autoPrintCode } from '../plugins/sleight/lib/no-output.mjs';
import { runInNewContext } from 'node:vm';

for (const [name, end] of ends) {
  test(`${name}: masking preserves literal and block-comment boundaries`, () => {
    for (const literal of ['`before' + end + 'await tab.click(3)`', '"before\\' + end + 'await tab.click(3)"', '/* before' + end + 'await tab.click(3) */']) {
      assert.equal(browserActionCount('const x = ' + literal + '; await tab.getAXState()'), 0);
      assert.equal(typingReceiptCall('const x = ' + literal + '; await app.typeText("safe")'), true);
      assert.equal(browserCall('const x = ' + literal + '; await tab.getAXState()', new Set(['tab']))?.handles.length, 0);
      assert.equal(evaluateWrite('tab.playwright.evaluate(() => { const x = ' + literal + '; return 1; })'), undefined);
      assert.equal(handTargets({ code: 'const x = ' + literal + '; await app.click(3)', lines: { 3: 'button Item' } }).actions.length, 1);
      assert.equal(nativeGetStateCode('const x = ' + literal + '; await app.getState()').includes('await app.getAXState()'), true);
    }
    assert.match(nativeGetStateCode(`// c${end}await app.getState()`), /app\.getAXState/);
    assert.equal(usesRequire(`// c${end}require("x")`), true);
    assert.equal(handTargets({ code: `// c${end}await app.click(3)`, lines: { 3: 'button Item' } }).actions.length, 1);
    const compactor = createReadCompactor();
    assert.ok(compactor.beginAction(`// c${end}await app.click(3)`));
    assert.equal(lineCommentEnd('x// c' + end + 'code', 1), 5);
    assert.equal(finalReturnCode(`return // c${end}await app.click(3)`), `return // c${end}await app.click(3)`, 'return ASI stays intact');
    assert.equal(finalExpression(`await app.getAXState(); // c${end}42`)?.expression, '42');
  });
  test(`${name}: tokens agree with JavaScript on literal values`, () => {
    for (const literal of ['`before' + end + 'after`', '"before\\' + end + 'after"', "'before\\" + end + "after'"]) {
      assert.equal(tokens(literal)[0].v, runInNewContext(literal));
    }
    const computed = 'tab.playwright.evaluate(() => document.body["cl\\' + end + 'ick"]())';
    assert.match(evaluateWrite(computed), /read-only/);
    const j = new TurnJournal({ ownerNames: [] });
    j.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '// c' + end + 'await app.typeText("secret\\' + end + 'text")' } } });
    j.reply({ id: 1, result: { content: [{ type: 'text', text: 'secrettext' }] } });
    const receipt = j.finish({});
    assert.equal(receipt.calls[0].actions[0].input.length, 10);
    assert.ok(!JSON.stringify(receipt).includes('secrettext'));
    const read = 'const s = await app.getAXState(); // c' + end + 'nodeRepl.write(s.slice(0, 1));';
    assert.notEqual(filteredReadCode(read), read);
  });
  test(`${name}: relay enforces source admission and preserves literal text`, async t => {
    const streams = Array.from({ length: 4 }, () => new PassThrough());
    const [clientIn, clientOut, serverIn, serverOut] = streams;
    const sent = [], received = [];
    serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
    t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
    let id = 0;
    const call = (code, command = false) => clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: {
      name: 'js', arguments: command ? { command: code } : { code } } }) + '\n');
    if (name !== 'LF') {
      for (const tail of ['nodeRepl.write("x")', 'nodeRepl.emitImage(await app.getScreenshot())']) {
        for (const command of [false, true]) call(head + `${tail} // c${end}await app.click(3)`, command);
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sent.length, 0);
      assert.equal(received.length, 4);
      for (const reply of received) { assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, /Raw CR\/U\+2028\/U\+2029/); }
    }
    const safe = 'nodeRepl.write(`before' + end + 'after`)';
    call(safe);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(msg => msg.method === 'tools/call').length, 1);
  });
}

test('uncommon-line admission rejects regex ambiguity, nested interpolation and legacy comments', () => {
  for (const end of ['\r', '\u2028', '\u2029']) {
    for (const code of ['const r = /"/; // c' + end + 'await app.click(3); "x"',
      '<!-- "' + end + 'await app.click(3); "x"',
      '`safe ${ { value: `nested ${ 1' + end + '}` } }`',
      '`safe ${ /* c' + end + ' */ 1 }`',
      '"safe" // "' + end + 'await app.click(3)',
      '`safe ${ "x" / 2 }' + end + '`']) assert.equal(unsupportedCodeLines(code), true, JSON.stringify(code));
    for (const code of ['"before' + (end === '\r' ? '\\' : '') + end + 'after"',
      '`before' + end + 'after`', '`safe ${ { value: `nested' + end + '` } }`']) {
      assert.equal(unsupportedCodeLines(code), false, JSON.stringify(code));
    }
  }
  assert.equal(unsupportedCodeLines('`' + '${`'.repeat(100) + '\r' + '`}'.repeat(100) + '`'), true);
});


test('the exact review example executes a hidden mock click in JavaScript and is refused by admission', async () => {
  for (const end of ['\r', '\u2028', '\u2029']) {
    for (const tail of ['nodeRepl.write("x")', 'nodeRepl.emitImage(await app.getScreenshot())']) {
      const code = head + tail + ' // c' + end + 'await app.click(3)';
      const clicks = [];
      await runInNewContext('(async () => {' + code + '\n})()', {
        app: { async click(value) { clicks.push(value); }, async getScreenshot() { return 'image'; } },
        nodeRepl: { write() {}, emitImage() {} },
      });
      assert.deepEqual(clicks, ['File', 'Save', 3]);
      assert.equal(splitMenuActions(code), undefined);
    }
  }
});

for (const [name, end] of ends) test(`${name}: string and template data do not invent retries, writes or receipts`, () => {
  for (const literal of ['`await app.click(3)' + end + '`', '"await app.click(3)\\' + end + '"']) {
    assert.equal(isBrowserRead('const x = ' + literal + '; await app.click(3)'), false);
    assert.ok(!sourceOf('const x = ' + literal)?.includes('app.click'));
    assert.equal(unchangedListClicks('nodeRepl.write(' + literal + ')', ['0 list Items', '\t3 row Item'], ['0 list Items', '\t3 row Item']).length, 0);
    const output = 'nodeRepl.write(' + literal + ')';
    assert.equal(autoPrintCode(output, true), output);
    assert.ok(!withoutPageCallbacks('tab.playwright.evaluate(() => ' + literal + ')').includes('app.click'));
  }
  const journal = new TurnJournal({ ownerNames: [] });
  journal.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText(`a' + end + 'b`)' } } });
  journal.reply({ id: 1, result: { content: [] } });
  assert.equal(journal.finish({}).calls[0].actions[0].input.length, ('a' + end.replace(/\r\n?/g, '\n') + 'b').length);
});

test('AST callbacks preserve engine-valid line terminators before regex test members', () => {
  for (const end of ['\r', '\u2028', '\u2029']) {
    const code = head + 'const state = await app.getAXState(); nodeRepl.write(state.filter(l => /safe/' + end + '.test(l)));';
    assert.equal(splitMenuActions(code)?.actions.length, 2);
  }
});
