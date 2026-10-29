import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { evaluateWrite } from '../plugins/sleight/lib/evaluate-write.mjs';
import { withoutPageCallbacks } from '../plugins/sleight/lib/page-callbacks.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const escaped = [
  'await tab.evaluate(() => document.body.cl\\u0069ck())',
  'await tab.evaluate(() => document.body["\\u0063lick"]())',
  'await tab.evaluate(() => document.body["cl\\x69ck"]())',
  'await tab.evaluate(() => document.body[`cl\\u0069ck`]())',
  'await tab.evaluate(() => { const t\\u0069tle = document.title; return title; })',
  'await locator.evaluateAll(nodes => nodes[0].cl\\u{69}ck())',
  'const cb = () => document.body.cl\\u0069ck(); await tab.evaluate(cb)',
  'function cb() { document.body["\\x63lick"](); } await tab.evaluate(cb)',
  'function cb(t\\u0069tle) { return title; } await tab.evaluate(cb)',
  'const cb = () => document.title; await tab.evaluate(c\\u0062)',
  'await tab.eval\\u0075ate(() => document.body.click())',
  'await tab["eval\\u0075ate"](() => document.body.click())',
  'await tab["eval\\\nuate"](() => document.title)',
  'const escaped\\u004eame = 1; await tab.evaluate(callbackFromElsewhere)',
  'await tab.evaluate(() => `${document.body.cl\\u0069ck()}`)',
];

for (const [index, code] of escaped.entries()) test(`escaped callback ${index + 1} refuses before dispatch and remains visible`, t => {
  assert.match(evaluateWrite(code) ?? '', /evaluate is read-only; .* cannot run there\./);
  assert.equal(withoutPageCallbacks(code), code);
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', data => sent.push(data.toString()));
  clientOut.on('data', data => replies.push(JSON.parse(data.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /evaluate is read-only/);
});

test('plain member controls retain the existing refusal bytes', () => {
  const expected = 'Line 1: evaluate is read-only; click cannot run there. Use locator.click(). Rejected before the engine call.';
  for (const member of ['.click', '["click"]'])
    assert.equal(evaluateWrite(`await tab.evaluate(() => document.body${member}())`), expected);
});

test('ordinary string values, comments and regex escapes stay allowed', () => {
  for (const body of ['"\\u0063lick"', 'document.title.replace(/\\s+/g, " ")', '/* cl\\u0069ck */ document.title',
    '`text \\u0063lick`', '/\\u0063lick/.test(document.title)', 'document.body["title"]'])
    assert.equal(evaluateWrite(`await tab.evaluate(() => ${body})`), undefined, body);
  const code = 'const o\\u0074her = 1; await tab.evaluate(() => document.title)';
  assert.equal(evaluateWrite(code), undefined);
  assert.equal(evaluateWrite('const o\\u0074her = 1; app.click(26)'), undefined);
});
