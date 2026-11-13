import { round2Cases, round2Controls, reviewerCells } from './fixtures/ps5r2-cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewCases, maskingCases, safeReviewCases } from './fixtures/ps5-review-cases.mjs';
import { pageCases } from './fixtures/ps5-page-cases.mjs';
import { evaluateWrite } from '../plugins/sleight/lib/evaluate-write.mjs';
import { withoutPageCallbacks } from '../plugins/sleight/lib/page-callbacks.mjs';
import { parseCell } from '../plugins/sleight/lib/code-ast.mjs';
import { unawaitedAction, createRelay } from '../plugins/sleight/lib/relay.mjs';
import { evaluateWrite as oldWrite } from './fixtures/ps5-evaluate-write-legacy.mjs';
import { unawaitedAction as oldAwait } from './fixtures/ps5-unawaited-legacy.mjs';
import { PassThrough } from 'node:stream';

for (const item of [...reviewCases, ...maskingCases, ...safeReviewCases, ...round2Cases, ...round2Controls]) test(`PS5R ${item.id}`, () => {
  assert.equal(parseCell(item.code).error, null, 'fixture is valid JS');
  assert.equal(Boolean(evaluateWrite(item.code)), item.write, 'write preflight');
  if (Object.hasOwn(item, 'masked')) assert.equal(withoutPageCallbacks(item.code) !== item.code, item.masked, 'callback masking');
  if (Object.hasOwn(item, 'awaiting')) assert.equal(unawaitedAction(item.code), item.awaiting, 'kernel diagnostic');
});

for (const item of [...reviewCases, ...round2Cases]) test(`PS5R refuses before relay dispatch: ${item.id}`, t => {
  const streams = Array.from({length:4}, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', data => sent.push(data.toString()));
  clientOut.on('data', data => replies.push(JSON.parse(data.toString())));
  const relay = createRelay({clientIn, clientOut, serverIn, serverOut, changeReview:false});
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  clientIn.write(JSON.stringify({id:1, method:'tools/call', params:{name:'js', arguments:{code:item.code}}}) + '\n');
  assert.equal(sent.length, 0, 'no engine or prefix dispatch');
  assert.equal(replies.length, 1);
  assert.match(replies[0].result.content[0].text, /evaluate is read-only/);
});

test('PS5R2 retains every legacy refusal without receiver exceptions', () => {
  for (const item of [...pageCases, ...reviewCases, ...maskingCases, ...safeReviewCases, ...round2Cases, ...round2Controls]) {
    if (!(oldWrite(item.code) || oldAwait(item.code))) continue;
    assert.ok(evaluateWrite(item.code) || unawaitedAction(item.code), item.id);
  }
});

test('PS5R nested callback bodies are checked without executing any source', () => {
  const source = 'await tab.evaluate(wrap(() => { globalThis.__ps5rRan = true; return () => document.body.click(); }));';
  assert.match(evaluateWrite(source), /click cannot run there/);
  assert.equal(globalThis.__ps5rRan, undefined);
});

test('PS5R2 with remains a parser refusal before dispatch', t => {
  const code = 'with(tab) { evaluate(() => document.body.click()); }';
  assert.ok(parseCell(code).error);
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({length:4}, () => new PassThrough());
  const sent = [], replies = [];
  serverIn.on('data', data => sent.push(data.toString()));
  clientOut.on('data', data => replies.push(JSON.parse(data.toString())));
  const relay = createRelay({clientIn, clientOut, serverIn, serverOut, changeReview:false});
  t.after(() => { relay.dispose(); [clientIn, clientOut, serverIn, serverOut].forEach(stream => stream.destroy()); });
  clientIn.write(JSON.stringify({id:1, method:'tools/call', params:{name:'js', arguments:{code}}}) + '\n');
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].result.isError);
});

for (const item of reviewerCells) test(`PS5R2 frozen reviewer cell: ${item.id}`, () => {
  const invalid = Boolean(parseCell(item.code).error);
  const refused = invalid || Boolean(evaluateWrite(item.code) || unawaitedAction(item.code));
  if (item.bank === 'adversarial')
    assert.equal(refused, item.id !== 'reviewer-2-a24_string_literal_read', 'review attack or literal-read control');
  if (item.bank === 'read-controls')
    assert.equal(refused, item.id === 'reviewer-6-r24', 'only the fetch control refuses');
  if (item.bank === 'awkward')
    assert.equal(refused, ['reviewer-7-c2', 'reviewer-7-c6', 'reviewer-7-c7', 'reviewer-7-c11'].includes(item.id), 'frozen collateral decision');
  if (oldWrite(item.code) || oldAwait(item.code)) assert.ok(refused, 'legacy refusal retained');
});
