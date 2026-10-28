import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { syntaxErrorHint, syntaxOrigin } from '../plugins/sleight/lib/syntax-errors.mjs';

// Replies recorded from the real engine (26.1007.71326, 2026-10-15) through the relay. The caller's
// code began on line 1262 of the transmitted source, column 0, in every case.
const recorded = [
  ['const a = 1;\nconst b = ;\nnodeRepl.write("x")', "[1263:10-1263:11]: Unexpected token: ';'", 2, 11],
  ['nodeRepl.write("one");\nnodeRepl.write("two");\nlet q = 5 +* 3;\nnodeRepl.write("four")', "[1264:11-1264:12]: Unexpected token: '*'", 3, 12],
  ['let x = 1;\n  let y = (1 +;\n', "[1263:14-1263:15]: Unexpected token: ';'", 2, 15],
  ['nodeRepl.write("a");\n1 = 2;\n', '[1263:2-1263:3]: Invalid left-hand side in assignment', 2, 3],
  ['nodeRepl.write("a");\n)\n', "[1263:0-1263:1]: Unexpected token: ')'", 2, 1],
  ['const t = `x`;\nlet z = [1, 2;\nnodeRepl.write("b")', "[1263:13-1263:14]: Expected ']'", 2, 14],
  ['nodeRepl.write("a"); let k = 1;\nawait nodeRepl.write(\'y\') +;', "[1263:27-1263:28]: Unexpected token: ';'", 2, 28],
];
for (const [code, raw, line, column] of recorded) test(`recorded engine error ${raw} maps to caller line ${line}, column ${column}`, () => {
  const sent = 'setup;\n'.repeat(1261) + code + '\nteardown;';
  const origin = syntaxOrigin(sent, code);
  assert.deepEqual([origin.line, origin.column], [1262, 0]);
  const hint = syntaxErrorHint(raw, origin);
  assert.match(hint, new RegExp(`^sleight: .*line ${line}, column ${column}\\.$`));
  assert.doesNotMatch(hint, /nodeRepl|const |let /);
  assert.ok(hint.length < 140, hint.length);
});

test('a first-line error accounts for code that starts mid-line in the transmitted source', () => {
  const code = 'foo(;', sent = 'a;\nsetup(); ' + code + '\nb;';
  const origin = syntaxOrigin(sent, code);
  assert.deepEqual(origin, { line: 2, column: 9, lines: 1 });
  assert.match(syntaxErrorHint("[2:13-2:14]: Unexpected token: ';'", origin), /line 1, column 5\./);
});

test('errors outside the caller code, other text and ambiguous copies produce no hint', () => {
  const code = 'const a = 1;\nconst b = ;', sent = 'x;\n'.repeat(5) + code;
  const origin = syntaxOrigin(sent, code);
  assert.equal(syntaxErrorHint("[235:5-235:6]: Unexpected token: ';'", origin), undefined);
  assert.equal(syntaxErrorHint("[3:5-3:6]: Unexpected token: ';'", origin), undefined);
  assert.equal(syntaxErrorHint("[9:0-9:1]: Unexpected token: ';'", origin), undefined);
  for (const text of ["caller says [7:10-7:11]: Unexpected token: ';'", "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    "TypeError: x is not a function\n[7:10-7:11]: Unexpected token", '[7:10-7:11]: ', undefined]) {
    assert.equal(syntaxErrorHint(text, origin), undefined);
  }
  assert.equal(syntaxOrigin(code + '\n' + code, code), undefined);
  assert.equal(syntaxOrigin('other', code), undefined);
  assert.equal(syntaxErrorHint("[7:10-7:11]: Unexpected token", undefined), undefined);
});

test('the relay adds one mapped line to a failed reply, keeps the raw error, and sends no second request', () => {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const requests = [], replies = [];
  serverIn.on('data', data => requests.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  try {
    // The admitted caller source is valid; the fake engine reports a later error.
    const code = 'const a = 1;\nconst b = 2;';
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    assert.equal(requests.length, 1);
    // The fake engine follows the measured convention: 1-based line, 0-based column, in the transmitted code.
    const sent = requests[0].params.arguments.code, start = sent.indexOf(code);
    assert.ok(start >= 0);
    const line = sent.slice(0, start).split('\n').length + 1, column = 10;
    const raw = `[${line}:${column}-${line}:${column + 1}]: Unexpected token: ';'`;
    serverOut.write(JSON.stringify({ id: 1, result: { isError: true, content: [{ type: 'text', text: raw }] } }) + '\n');
    assert.equal(requests.length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result.isError, true);
    assert.equal(replies[0].result.content[0].text, raw);
    assert.match(replies[0].result.content[1].text, /line 2, column 11\./);
    assert.equal(replies[0].result.content.length, 2);
  } finally { relay.dispose(); }
});

test('a JSON-RPC error carries the mapped line in its message, in both prompt variants', () => {
  for (const prompt of [undefined, 'lean']) {
    const clientIn = new PassThrough(), clientOut = new PassThrough();
    const serverIn = new PassThrough(), serverOut = new PassThrough();
    const requests = [], replies = [];
    serverIn.on('data', data => requests.push(...data.toString().trim().split('\n').map(JSON.parse)));
    clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, prompt });
    try {
      const code = 'const a = 1;\nconst b = 2;';
      clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
      const sent = requests[0].params.arguments.code, start = sent.indexOf(code);
      const line = sent.slice(0, start).split('\n').length + 1;
      const raw = `[${line}:10-${line}:11]: Unexpected token: ';'`;
      serverOut.write(JSON.stringify({ id: 1, error: { code: -32603, message: raw } }) + '\n');
      assert.equal(requests.length, 1);
      assert.equal(replies.length, 1);
      const [first, hint, ...rest] = replies[0].error.message.split('\n');
      assert.equal(first, raw);
      assert.match(hint, /^sleight: .*line 2, column 11\.$/);
      assert.equal(rest.length, 0);
      if (prompt === 'lean') assert.doesNotMatch(hint, /setup code/);
    } finally { relay.dispose(); }
  }
});
