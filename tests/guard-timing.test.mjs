import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { stripGuardTiming } from '../plugins/sleight/lib/guard-timing.mjs';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

test('guard timing records each real guard read without recording window contents', async () => {
  const output = [];
  const raw = { getAXState: async () => 'Window: "private", App: Calculator.', click: async () => {} };
  const code = guardedCode('nodeRepl.write("prefix"); await app.click(1); await app.click(1); nodeRepl.write("suffix");',
    { title: 'private', app: 'Calculator', url: null }, 'stopped', undefined, { timing: true });
  await runInNewContext(`(async () => { ${code} })()`, {
    app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: text => output.push(text) },
  });
  const metrics = output.filter(text => text.startsWith('[sleight:guard-timing]'));
  assert.equal(metrics.length, 3);
  assert.ok(metrics.every(text => !text.includes('private')));
  const reads = metrics.map(text => JSON.parse(text.slice('[sleight:guard-timing]'.length)));
  assert.deepEqual(reads.map(read => read.phase), ['before-action', 'before-action', 'after-call']);
  assert.ok(reads.every(read => read.ms >= 0 && read.chars === 35));
  const traced = [];
  const cleaned = stripGuardTiming([{ type: 'text', text: output.join('') }], metric => traced.push(metric));
  assert.equal(traced.length, 3, 'the engine concatenates writes without adding newlines');
  assert.ok(!cleaned[0].text.includes('[sleight:guard-timing]'));
  assert.ok(cleaned[0].text.startsWith('prefixsuffix'));
  assert.match(cleaned[0].text, /Window: "private"/);
});

test('timing is removed from mixed results and malformed metrics cannot enter a trace', () => {
  const metrics = [];
  const mark = '[sleight:guard-timing]';
  const good = JSON.stringify({ phase: 'after-call', ms: 12.5, chars: 30, failed: false });
  const content = [{ type: 'text', text: `before\n${mark}${good}\nafter` },
    { type: 'text', text: `${mark}{"phase":"secret","ms":-1}` }, { type: 'image', data: 'unchanged' }];
  assert.deepEqual(stripGuardTiming(content, metric => metrics.push(metric)),
    [{ type: 'text', text: 'before\nafter' }, { type: 'image', data: 'unchanged' }]);
  assert.deepEqual(metrics, [{ phase: 'after-call', ms: 12.5, chars: 30, failed: false }]);
});

test('the relay traces metrics by call ID before delivering a clean full header', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const traces = [], replies = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    guardTiming: true, trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => relay.close());
  clientOut.on('data', chunk => replies.push(JSON.parse(chunk)));
  const metric = { phase: 'before-action', ms: 2.5, chars: 40, failed: false };
  serverOut.write(JSON.stringify({ id: 8, result: { content: [{ type: 'text',
    text: '[sleight:guard-timing]' + JSON.stringify(metric) + '\nWindow: "Calculator", App: Calculator.' }] } }) + '\n');
  assert.deepEqual(traces.find(t => t.direction === 'guard-read')?.msg, { id: 8, ...metric });
  assert.deepEqual(replies[0].result.content, [{ type: 'text', text: 'Window: "Calculator", App: Calculator.' }]);
});
