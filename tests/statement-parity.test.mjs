import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyConsumers, compareRecord } from '../bench/code-ast/statement-replay.mjs';
import { parseCell } from '../plugins/sleight/lib/code-ast.mjs';

const old = await legacyConsumers();
const head = 'await app.click("File"); await app.click("Save"); ';

test('safe legacy trailing values and quoted selectors retain their allow/refuse decisions', () => {
  for (const code of [
    ...['true', 'false', 'null', 'this', 'debugger', 'undefined', 'NaN', 'Infinity', '-4', '"done"', '`done`']
      .map(tail => head + tail),
    'let app = await cua.getApp({ "windowId": 12 }); await app.click("File"); await app.click("Save");',
    'await app.click({ "id": "file" }); await app.click({ "label": "Save" });',
  ]) {
    assert.equal(parseCell(code).error, null, code);
    assert.ok(old.menu.splitMenuActions(code), code);
    assert.deepEqual(compareRecord(code, old).differences.filter(d => d.consumer !== 'statements' && d.reason !== 'engine-action-ranges'), [], code);
  }
});

test('legacy action, argument and read families retain semantic outputs', () => {
  const bodies = ['click(3)', 'click([20,40])', 'click({id:"ok"})', 'pressKey("Return")', 'typeText("data")',
    'setValue(2, "value")', 'scroll("down", 2, {pixels: 12})', 'drag([1,2], [3,4])', 'paste("text")',
    'selectText("x")', 'performSecondaryAction(3)', 'click({id: "x", extra: [true, false, null, -1]})',
    'click([,1])', 'scroll("down", 2, {values: [,1]})',
    'click(-true)', 'click(- -"2")', 'click(1-2)', 'scroll("down", 2, {offset: -"2"})',
    'click({["id"]:"x"})', 'click({[["x"]]:1})'];
  const tails = ['', 'await app.getAXState();', 'let s = await app.getAXState({disableDiffing:true}); s',
    'const s = await app.getAXState(); nodeRepl.write(s.split("\\n").filter(l => /a|b/i.test(l)).slice(0, -4).join("\\n"));',
    'const s = await app.getAXState(); nodeRepl.write(s.trim().length);',
    'nodeRepl.emitImage(await app.getScreenshot({emit:false}));'];
  for (const body of bodies) for (const tail of tails) {
    const code = `await app.${body}; await app.pressKey("Return"); ${tail}`;
    assert.ok(old.menu.splitMenuActions(code), code);
    assert.deepEqual(compareRecord(code, old).differences.filter(d => d.consumer !== 'statements' && d.reason !== 'engine-action-ranges'), [], code);
  }
});

test('unknown or executable shapes remain refused by both consumers', () => {
  for (const tail of ['nodeRepl.write(s.map(f))', 'nodeRepl.write(s["trim"]())', 'nodeRepl.write(s?.trim())',
    'await other.getAXState()', 'nodeRepl.emitImage(await app.getScreenshot(next()))', 'const x = await app.click(3)',
    'app = other', 'await app.click(3)']) {
    const code = head + 'const s = await app.getAXState(); ' + tail;
    assert.equal(old.menu.splitMenuActions(code), undefined, code);
    assert.equal(compareRecord(code, old).after.menu, null, code);
  }
});
