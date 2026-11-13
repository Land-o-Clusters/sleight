import test from 'node:test';
import assert from 'node:assert/strict';
import { packageSkip } from './requirements.mjs';

const skip = packageSkip('typescript');
const { dragMethodAudit } = skip ? {} : await import('../bench/world/method-check.mjs');
const call = (code, id = 'js') => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__js', input: { code } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } },
].map(JSON.stringify).join('\n');
const drag = call('let app = await cua.getApp("Fixture"); await app.drag([1, 2], [3, 4]);', 'drag');
const explain = transcript => dragMethodAudit(transcript, { diagnostics: true });
const verdict = ({ issues, issuesOmitted, ...audit }) => audit;

for (const [code, reason, expression] of [
  ['await cua.getApp({ windowId: 0 }).catch(e => null);', 'unknown-call', 'cua.getApp({ windowId: 0 }).catch(e => null)'],
  ['globalThis.srcApp = app;', 'property-assignment', 'globalThis.srcApp = app'],
  ['const n = "x".codePointAt(0);', 'unknown-call', '"x".codePointAt(0)'],
]) test(`method audit identifies ${reason} without changing the grade: ${code}`, { skip }, () => {
  const transcript = drag + '\n' + call(code, 'inspection');
  const actual = explain(transcript);
  assert.deepEqual(verdict(actual), { drag: true, replacement: false, complete: false });
  assert.deepEqual(verdict(actual), dragMethodAudit(transcript));
  assert.equal(actual.issues.length, 1);
  const issue = actual.issues[0];
  assert.equal(issue.code, reason);
  assert.equal(issue.call, 2);
  assert.equal(issue.transcriptLine, 3);
  assert.equal(code.slice(issue.start, issue.end), expression);
  assert.equal(actual.issuesOmitted, 0);
});

test('method diagnostics never include source text, arguments, document output or tool names', { skip }, () => {
  const secret = 'fixture-sensitive-value';
  const input = call(`unknownMethod("${secret}")`);
  const lines = input.split('\n').map(JSON.parse);
  lines[0].message.content[0].name = secret;
  lines[1].message.content[0].content = [{ type: 'text', text: secret }];
  const result = explain(lines.map(JSON.stringify).join('\n'));
  assert.equal(result.complete, false);
  assert.equal(result.issues[0].code, 'unknown-call');
  assert.doesNotMatch(JSON.stringify(result), /fixture-sensitive-value|unknownMethod/);
});

test('Codex method diagnostics point to the completed MCP item and retain writer detection', { skip }, () => {
  const code = 'await app.typeText("replacement"); unknown();';
  const transcript = drag + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call',
    server: 'plugin_sleight_computer', tool: 'js', arguments: JSON.stringify({ code }), result: {} } });
  const result = explain(transcript);
  assert.deepEqual(verdict(result), { drag: true, replacement: true, complete: false });
  assert.equal(result.issues[0].transcriptLine, 3);
  assert.equal(result.issues[0].call, 2);
  assert.equal(code.slice(result.issues[0].start, result.issues[0].end), 'unknown()');
});

test('method diagnostics are bounded and report the omitted count without changing the verdict', { skip }, () => {
  const transcript = drag + '\n' + call('unknown();'.repeat(100));
  const result = explain(transcript);
  assert.equal(result.issues.length, 64);
  assert.equal(result.issuesOmitted, 36);
  assert.deepEqual(verdict(result), dragMethodAudit(transcript));
  assert.ok(result.issues.every(issue => issue.code === 'unknown-call'));
});

for (const [transcript, reason] of [
  ['', 'no-calls'], ['{broken', 'invalid-json'],
  [JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'missing' }] } }), 'unmatched-result'],
  [JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'pending', name: 'drag', input: {} }] } }), 'pending-call'],
  [call('await app.click('), 'invalid-code'],
]) test(`method diagnostics explain ${reason}`, { skip }, () => {
  const result = explain(transcript);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === reason));
  assert.deepEqual(verdict(result), dragMethodAudit(transcript));
});

test('complete method proof has no diagnostic issues', { skip }, () => {
  assert.deepEqual(explain(drag), { drag: true, replacement: false, complete: true, issues: [], issuesOmitted: 0 });
});
