import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { CONTINUATION, INSTRUCTION, gradeControl, runControl, traceCalls } from '../bench/sf6-focus-probe.mjs';
import { modelPlan, streamSession, traceMatchesTranscript } from '../bench/sf6-focus-runtime.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/sf6-run7.json', import.meta.url)));
const filteredRead = 'let state = await app.getAXState({ disableDiffing: true });\nstate.split("\\n").filter(l => /Memo|Reference|focus/i.test(l)).join("\\n")';

test('the recorded numeric-target shape is refused by the real relay with zero engine messages', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [], replies = [];
  serverIn.on('data', chunk => forwarded.push(JSON.parse(chunk)));
  clientOut.on('data', chunk => replies.push(JSON.parse(chunk)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'var app = await cua.getApp("Firefox");' } } }) + '\n');
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text',
    text: 'Window: "SF6R focus probe", App: Firefox.\n32 text field Memo\n35 text field Reference' }],
    _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'org.mozilla.firefox' } } } } }) + '\n');
  forwarded.length = 0; replies.length = 0;
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'await app.typeText(32, "cobalt heron 47");' } } }) + '\n');
  assert.equal(forwarded.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /typeText\(text: string\).*nothing was sent/);
});

test('the first model turn receives only driver code and reply, and the second receives only continuation', async t => {
  const seed = { request: { code: 'await app.typeText(32, "cobalt heron 47");', title: 'Refuse numeric-target Memo input' },
    result: { isError: true, content: [{ type: 'text', text: 'typeText(text: string); no target; nothing was sent.' }] } };
  const plan = modelPlan({ command: 'fake', cwd: '/tmp/fake', config: process.env.CLAUDE_CONFIG_DIR,
    dir: '/tmp/fake', url: 'http://127.0.0.1/owned/', seed });
  const messages = [];
  const session = streamSession(plan, { run: (_command, _args, options) => new Promise(resolve => {
    options.input.on('data', chunk => {
      messages.push(JSON.parse(chunk));
      options.onStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'same',
        mcp_servers: [{ name: 'plugin:sleight:computer', status: 'connected' }] }) + '\n');
      options.onStdout(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'same' }) + '\n');
    });
    options.input.on('end', () => resolve({ code: 0, groupClean: true }));
  }) });
  t.after(() => session.close());
  await session.turn(CONTINUATION);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'user');
  const content = messages[0].message.content;
  assert.ok(content.includes(INSTRUCTION));
  assert.ok(content.includes(JSON.stringify({ code: seed.request.code, result: seed.result })));
  assert.equal(content.includes(seed.request.title), false);
  assert.equal(content.includes('"request"'), false);
  assert.ok(content.endsWith(CONTINUATION));
  await session.turn(CONTINUATION);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message.content, CONTINUATION);
  assert.equal((await session.close()).groupClean, true);
});

test('the driver refuses and stops before any model turn, then submits only recovery', async () => {
  const p = recorded.unchanged.row, calls = [], snapshots = [p.initial, p.afterRefusal, p.boundary, p.final];
  const row = await runControl('unchanged', {
    snapshot: async () => snapshots.shift(),
    refusal: async () => { calls.push('driver-refusal'); return { ...p.refusal, stopped: true }; },
    turn: async message => { calls.push(message); return { stopped: true }; },
    cleanup: async () => p.cleanup, finish: async () => ({}),
  });
  assert.equal(row.error, undefined);
  assert.deepEqual(calls, ['driver-refusal', CONTINUATION]);
  assert.equal(row.checks.focusBoundary.status, 'pass');
});

test('run 7 unchanged: a filtered AX read leaves all twelve recovery checks provable', () => {
  const { row, trace, transcript } = recorded.unchanged;
  const audit = traceCalls(trace), refusal = audit.refusals[0];
  assert.equal(traceMatchesTranscript(transcript, trace), true);
  assert.deepEqual(audit.unknown, []);
  const graded = gradeControl({ ...row, recovery: { traceComplete: audit.complete,
    unknown: audit.unknown, actions: audit.actions.filter(a => a.order > refusal.order) } });
  assert.equal(graded.status, 'pass');
  assert.equal(Object.values(graded.checks).filter(c => c.status === 'pass').length, 12);
  assert.deepEqual(graded.speedNotes, ['1 redundant Memo click']);
});

test('run 7 moved: the model never attempted the refused numeric call', () => {
  const { row, trace, transcript } = recorded.moved;
  const audit = traceCalls(trace);
  assert.equal(traceMatchesTranscript(transcript, trace), true);
  assert.equal(audit.refusals.length, 0);
  assert.equal(audit.actions.length, 0);
  assert.equal(gradeControl(row).status, 'inconclusive');
  assert.equal(row.error, 'One numeric-target refusal unproved');
});

for (const code of [filteredRead.replace('app.getAXState', 'other.getAXState'),
  filteredRead.replace('test(l)', 'test(app.typeText("oops"))'),
  filteredRead + '; await app.click(target);', filteredRead.replace('filter(l =>', 'filter(l => app.click(32) ||'),
  filteredRead.replace('/Memo|Reference|focus/i', '/anything/i')])
  test(`filtered read exception rejects changed or hidden actions: ${code}`, () => {
    const trace = structuredClone(recorded.unchanged.trace);
    trace.find(e => e.msg.params?.code === filteredRead).msg.params.code = code;
    assert.ok(traceCalls(trace).unknown.length > 0);
  });
