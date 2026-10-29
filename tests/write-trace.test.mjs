import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodeTrace, WRITE_CODE_BYTES } from '../plugins/sleight/lib/write-trace.mjs';
import { tokens } from '../plugins/sleight/lib/flow-rules.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { takeGuardStop } from '../plugins/sleight/lib/menu-continuation.mjs';
import { approvalLogging } from '../plugins/sleight/lib/launch.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { replay } from '../bench/replay/safari-wrong-field.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const head = 'Window: "Form", App: Fixture.\n0 standard window Form\n';
test('code trace masks every string, template, regex and comment, including variable-supplied secrets', () => {
  const source = 'const password = "secret-value"; /* secret-comment */ const card = `5555444433332222`; const rx = /secret-regex/; await app.setValue(26, password); await app.typeText(card);';
  const record = writeCodeTrace(source);
  assert.equal(record.truncated, false);
  assert.doesNotMatch(record.code, /secret|55554444/);
  assert.match(record.code, /app\.setValue\(26, password\)/);
  assert.equal(record.bytes, Buffer.byteLength(source));
  const spans = tokens(source, { positions: true });
  assert.deepEqual(spans.map(({ start, end, ...token }) => token), tokens(source));
  for (const token of spans) assert.ok(token.end > token.start);
});

test('write code is bounded to 8192 bytes, preserves both ends and reports truncation', () => {
  const record = writeCodeTrace('const first = 1;\n' + 'void 0;\n'.repeat(3000) + 'await app.setValue(26, "secret-value");');
  assert.equal(record.truncated, true);
  assert.ok(Buffer.byteLength(record.code) <= WRITE_CODE_BYTES);
  assert.match(record.code, /^const first/);
  assert.match(record.code, /app\.setValue\(26, "<redacted>"\);$/);
  assert.equal(writeCodeTrace('app.typeText("unfinished').code, '[unparseable code redacted]');
});

test('trace serializer retains the bounded write code past the ordinary string cut', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-write-trace-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const code = writeCodeTrace('void 0;\n'.repeat(100) + 'await app.setValue(26, "secret-value");').code;
  const logging = approvalLogging(new Map(), { SLEIGHT_TRACE: dir, SLEIGHT_TRACE_CUT: '20' });
  logging.trace('write-code', { code, text: 'x'.repeat(100) });
  const row = JSON.parse(readFileSync(join(dir, `trace-${process.pid}.jsonl`), 'utf8'));
  assert.equal(row.msg.code, code);
  assert.equal(row.msg.text, 'x'.repeat(20) + '…(100)');
});

test('guard receipts capture the actual remapped element immediately before dispatch', async () => {
  const before = head + '\t26 text field (settable) Address\n\t53 text field (settable) Promo';
  const after = before.replace('26 text field', '54 text field');
  const result = await replay({ before, code: 'await app.setValue(26, "secret-value");' }, { snapshots: [after], recordedEffect: false, timing: true });
  assert.equal(result.error, undefined);
  const taken = takeGuardStop([{ type: 'text', text: result.output.join('\n') }], '[replay]');
  assert.deepEqual(taken.writeForwards, [{ index: 0, method: 'setValue', element: 54, afterClick: null }]);
  assert.doesNotMatch(JSON.stringify(taken.writeForwards), /secret-value/);
});

test('typeText and pressKey receipts keep the preceding click with zero typed values', async () => {
  const output = [], actual = [];
  const tree = head + '\t26 text field (settable) Address\n\nThe focused UI element is 26 text field (settable) Address';
  const raw = { getAXState: async () => tree, click: async n => actual.push(['click', n]),
    typeText: async () => actual.push(['typeText']), pressKey: async () => actual.push(['pressKey']) };
  const source = 'var app = await cua.getApp("Fixture"); await app.click(26); await app.pressKey("super+a"); await app.click(26); await app.typeText("secret-value");';
  const wrapped = guardedCode(source, { title: 'Form', app: 'Fixture', url: null }, undefined, undefined,
    { timing: true, guardStopMark: '[trace]', literals: [26], seenLines: { 26: 'text field (settable) Address' } });
  await runInNewContext(`(async () => { ${wrapped} })()`, { cua: { getApp: async () => raw }, nodeRepl: { write: s => output.push(s) }, setTimeout, clearTimeout });
  const taken = takeGuardStop([{ type: 'text', text: output.join('\n') }], '[trace]');
  assert.deepEqual(taken.writeForwards.map(({ method, element, afterClick }) => ({ method, element, afterClick })), [
    { method: 'pressKey', element: null, afterClick: 26 }, { method: 'typeText', element: null, afterClick: 26 }]);
  assert.equal(actual.length, 4);
  assert.doesNotMatch(JSON.stringify(taken.writeForwards), /secret-value|super/);
});

test('relay writes the code actually sent and strips dispatch marks before delivery', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const traces = [], requests = [], replies = [];
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-write-relay-')));
  const inputLease = new InputLease({ directory, holder: 'SB2 fixture' });
  serverIn.on('data', b => requests.push(...b.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', b => replies.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false, guardTiming: true, traceCode: true,
    trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => { relay.dispose(); inputLease.close(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); rmSync(directory, { recursive: true, force: true }); });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const tree = head + '\t26 text field (settable) Address\n\t53 text field (settable) Promo';
  call(0, 'var app = await cua.getApp("Fixture");');
  serverOut.write(JSON.stringify({ id: 0, result: { content: [{ type: 'text', text: tree }], _meta: { 'codex/toolSurface': { app: { appId: 'org.test.fixture' } } } } }) + '\n');
  call(1, 'await app.setValue(26, "secret-value");');
  assert.equal(traces.filter(t => t.direction === 'write-code').length, 1);
  assert.deepEqual(traces.find(t => t.direction === 'write-code').msg, { id: 1, ...writeCodeTrace(requests.at(-1).params.arguments.code) });
  assert.doesNotMatch(JSON.stringify(traces), /secret-value/);
  assert.match(requests.at(-1).params.arguments.code, /secret-value/);
  const mark = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(requests.at(-1).params.arguments.code)[1]).guardStopMark;
  const dispatch = { index: 0, method: 'setValue', element: 26, afterClick: null };
  const count = requests.length;
  serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: mark + JSON.stringify({ writeForward: dispatch }) + '\n' + tree }],
    _meta: { 'codex/toolSurface': { app: { appId: 'org.test.fixture' } } } } }) + '\n');
  assert.equal(requests.length, count);
  assert.deepEqual(traces.find(t => t.direction === 'write-forwarded').msg, { id: 1, ...dispatch });
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /writeForward|write-forwarded/);
});
