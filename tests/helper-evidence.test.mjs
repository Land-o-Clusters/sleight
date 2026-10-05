import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHelperEvidence } from '../bench/helper-evidence.mjs';

test('helper receipts replace Chess titles everywhere while retaining result evidence', () => {
  const title = 'Example Player (White) vs. Computer (Black)';
  const value = { mode: 'recovery', records: [
    { result: { isError: false, content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: Chess\n0 window ${title}\n1 button Move` }] } },
    { repeatedTitle: title, health: true },
    { text: 'Window: "Calculator", App: Calculator', path: '/example/home/Projects/receipt' },
  ] };
  const text = sanitizeHelperEvidence(value, '/example/home');
  assert.doesNotMatch(text, /Example Player/);
  const result = JSON.parse(text);
  assert.equal(result.records[0].result.isError, false);
  assert.match(result.records[0].result.content[0].text, /Window: "\[Chess window\]", App: Chess\n0 window \[Chess window\]\n1 button Move/);
  assert.equal(result.records[1].health, true);
  assert.equal(result.records[1].repeatedTitle, '[Chess window]');
  assert.equal(result.records[2].path, '~/Projects/receipt');
  assert.equal(result.records[2].text, 'Window: "Calculator", App: Calculator');
  assert.equal(sanitizeHelperEvidence(result, '/example/home'), text);
});

test('Chess titles with quotes and backslashes are replaced in headers and AX labels', () => {
  const title = 'Example "Player" \\ Chess';
  const text = sanitizeHelperEvidence({ text: `Window: ${JSON.stringify(title)}, App: Chess.\n0 window ${title}` });
  assert.equal(JSON.parse(text).text, 'Window: "[Chess window]", App: Chess.\n0 window [Chess window]');
  assert.doesNotMatch(text, /Example/);
});
