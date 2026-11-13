import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWrite } from '../plugins/sleight/lib/evaluate-write.mjs';
import { withoutPageCallbacks } from '../plugins/sleight/lib/page-callbacks.mjs';
import { unawaitedAction } from '../plugins/sleight/lib/relay.mjs';

for (const prefix of [
  'const tab = { evaluate: f => f() };',
  'const helper = { evaluate: f => f() }; const tab = helper;',
  'function run(tab) {',
]) test(`kernel evaluate keeps its callback visible: ${prefix}`, () => {
  const code = `${prefix} await tab.evaluate(() => { app.typeText('x'); return 1; }); await app.getAXState();${prefix.endsWith('{') ? '}' : ''}`;
  assert.equal(Boolean(evaluateWrite(code)), !prefix.endsWith('{'));
  assert.equal(withoutPageCallbacks(code), code);
  assert.equal(unawaitedAction(code), 'app.typeText(');
});

import { pageCases } from './fixtures/ps5-page-cases.mjs';
import { parseCell } from '../plugins/sleight/lib/code-ast.mjs';
import { pageCode } from '../plugins/sleight/lib/page-code.mjs';
import { evaluateWrite as oldWrite } from './fixtures/ps5-evaluate-write-legacy.mjs';
for (const item of pageCases) test(`PS5 ${item.id}`, () => {
  assert.equal(parseCell(item.code).error, null, 'fixed corpus is valid JS');
  assert.equal(Boolean(evaluateWrite(item.code)), item.write, 'write decision');
  const masked = withoutPageCallbacks(item.code);
  assert.equal(masked !== item.code, item.masked, 'mask decision');
  assert.equal(masked.length, item.code.length, 'UTF-16 offsets preserved');
  assert.deepEqual([...masked.matchAll(/[\n\r\u2028\u2029]/g)].map(m => m.index),
    [...item.code.matchAll(/[\n\r\u2028\u2029]/g)].map(m => m.index), 'line offsets preserved');
  if (Object.hasOwn(item, 'awaiting')) assert.equal(unawaitedAction(item.code), item.awaiting, 'await diagnostic');
});

for (const target of ['value', 'checked', 'innerHTML', 'selected', 'selectedIndex', 'scrollTop', 'scrollLeft', 'draggable', 'cssText', 'onchange']) {
  test(`PS5 refusal bytes: ${target}`, () => {
    const code = `await tab.evaluate(() => {\n document.body.${target} = 1;\n});`;
    assert.equal(evaluateWrite(code), oldWrite(code));
  });
}
for (const op of ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '|=', '&=', '^=', '||=', '&&=', '??=']) {
  test(`PS5 DOM assignment ${op}`, () => assert.match(evaluateWrite(`await tab.evaluate(() => document.body.value ${op} 1)`), /value cannot run there/));
}
for (const code of [
  'await tab.evaluate(() => { function helper({fetch}) { fetch("local"); } return 1; });',
  'await tab.evaluate(() => { try {} catch (fetch) { fetch("local"); } return 1; });',
  'await tab.evaluate(() => { for (let fetch of []) { fetch("local"); } return 1; });',
  'await tab.evaluate(() => { { const fetch = () => 1; fetch("local"); } return 1; });',
  'await tab.evaluate(() => { function helper(...fetch) { return fetch; } return 1; });',
]) test(`PS5 lexical fetch locals: ${code}`, () => assert.equal(evaluateWrite(code), undefined));

test('PS5 arbitrary persisted browser handle is scoped to the relay-provided set', () => {
  const code = 'await selected.evaluate(() => { button.click(); return 1; }); nodeRepl.write(1);';
  assert.equal(withoutPageCallbacks(code), code);
  assert.ok(evaluateWrite(code), 'unknown receivers still receive write preflight');
  assert.ok(evaluateWrite(code, new Set(['selected'])));
  assert.equal(unawaitedAction(code, new Set(['selected'])), undefined);
  const shadowed = 'function run(selected) { ' + code + ' }';
  assert.equal(withoutPageCallbacks(shadowed, new Set(['selected'])), shadowed);
});

test('PS5 function masks include parameter defaults, leave call arguments and receiver expressions visible', () => {
  const code = 'function cb(x = button.click()) { return x; } await tab.evaluate(cb, app.click(1)); nodeRepl.write(1);';
  const masked = withoutPageCallbacks(code);
  assert.ok(!masked.includes('button.click'));
  assert.ok(masked.includes('app.click'));
  assert.equal(pageCode(code).callbacks.length, 1);
});

test('PS5 no source execution and no shared AST mutation', () => {
  const code = 'globalThis.__ps5SideEffect = 1; await tab.evaluate(() => document.body.click());';
  const parsed = parseCell(code), before = JSON.stringify(parsed.ast);
  evaluateWrite(code); withoutPageCallbacks(code);
  assert.equal(globalThis.__ps5SideEffect, undefined);
  assert.equal(JSON.stringify(parsed.ast), before);
});

for (const source of [
  'class Box { #value = 0; run() { this.#value = 2; return this.#value; } } return new Box().run();',
  'class Box { #click() { return 1; } run() { return this.#click(); } } return new Box().run();',
]) test(`PS5 private class members are not DOM names: ${source}`, () => {
  assert.equal(evaluateWrite(`await tab.evaluate(() => { ${source} });`), undefined);
});

import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
function relayHarness(t) {
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [], replies = [];
  for (const [stream, records] of [[serverIn, sent], [clientOut, replies]])
    stream.setEncoding('utf8').on('data', data => data.trim().split('\n').filter(Boolean).forEach(line => records.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); [clientIn, clientOut, serverIn, serverOut].forEach(stream => stream.destroy()); });
  return { sent, replies,
    call: (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: id => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text: 'ok' }],
      _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } }) + '\n') };
}

test('PS5 relay confirms an arbitrary tab name, masks its local data callback, and refuses its DOM write', t => {
  const h = relayHarness(t);
  h.call(1, 'const selected = await cua.getTab("1");');
  assert.equal(h.sent.length, 1);
  h.reply(1);
  h.call(2, 'await selected.evaluate(() => { const data = { click() { return 1; } }; data.click(); return 1; }); nodeRepl.write(1);');
  assert.equal(h.sent.length, 2, 'confirmed page callback is not kernel code');
  h.reply(2);
  h.call(3, 'await selected.evaluate(() => document.body.click());');
  assert.equal(h.sent.length, 2, 'DOM write never reaches the engine');
  assert.match(h.replies.find(reply => reply.id === 3)?.result.content[0].text ?? '', /evaluate is read-only; click/);
});

for (const id of ['kernel-helper', 'kernel-tab-shadow', 'kernel-param-shadow', 'asi-kernel-after', 'tab-method-replaced', 'tab-method-alias-replaced']) {
  test(`PS5 relay keeps kernel action refusal: ${id}`, t => {
    const h = relayHarness(t), item = pageCases.find(item => item.id === id);
    h.call(1, item.code);
    assert.equal(h.sent.length, 0);
    assert.match(h.replies[0].result.content[0].text, /has no await|evaluate is read-only/);
  });
}

for (const id of ['data-reassigned-page', 'data-shadowed-page', 'fetch-block-shadow', 'event-block-shadow', 'named-alias', 'evaluate-all-write']) {
  test(`PS5 relay refuses newly recognized page writes: ${id}`, t => {
    const h = relayHarness(t), item = pageCases.find(item => item.id === id);
    h.call(1, item.code);
    assert.equal(h.sent.length, 0);
    assert.match(h.replies[0].result.content[0].text, /evaluate is read-only/);
  });
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
test('PS5 frozen evaluate-write oracle stays pinned', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('./fixtures/ps5-evaluate-write-legacy.mjs', import.meta.url))).digest('hex'),
    '09f9967bb05824c496ebdd7e26f1db868fe527914e45ed89dfd7202e20797ec6');
});
test('PS5 frozen page-callbacks oracle stays pinned', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('./fixtures/ps5-page-callbacks-legacy.mjs', import.meta.url))).digest('hex'),
    '9ace51f3e63bd961ae1f77546db8b91257f497624b58759f9fe28c6db0c1ba7d');
});
test('PS5 frozen unawaited oracle stays pinned', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('./fixtures/ps5-unawaited-legacy.mjs', import.meta.url))).digest('hex'),
    '9648e9056436b04575fbf540a162e581af0c070b9120dfa07ee0c9c262d4ce67');
});
