import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as replayModule from '../plugins/sleight/lib/replay.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { elementLine, elementSpec, portableCode, recordSteps, replay } from '../plugins/sleight/lib/replay.mjs';
import { guardedCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const TREE = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator, ID: main\n\t67 View\n\t\t3 Scientific, ID: menuAction:\n\t\t4 Programmer, ID: menuAction:\n\t\t9 button Description: Equals, ID: Equals\n\t\t12 button All Clear\n\t\t13 button Seven, ID: Seven\n\t\t14 text 7';

test('an element number becomes a unique ID, then a unique label, then its whole line', () => {
  assert.deepEqual(elementSpec(elementLine([TREE], 13)), { id: 'Seven' });
  assert.deepEqual(elementSpec(elementLine([TREE], 3)), { line: 'Scientific, ID: menuAction:' });
  assert.deepEqual(elementSpec(elementLine([TREE], 12)), { label: 'All Clear' });
  // A menu bar item named alone is its own label (hasLabel, 2026-10-09); older scripts' { line } still resolve.
  assert.deepEqual(elementSpec(elementLine([TREE], 67)), { label: 'View' });
  assert.equal(elementSpec(elementLine([TREE], 99)), undefined);
  // Two lines alike can't be told apart, so the number stays and the step needs positions.
  assert.equal(elementSpec(elementLine(['\t1 button OK\n\t2 button OK'], 1)), undefined);
});

test('the latest text that lists a number wins, and removed diff lines never do', () => {
  const diff = 'sleight: lines changed\n- \t13 button Eight, ID: Eight\n+ \t13 button Nine, ID: Nine';
  assert.equal(elementLine([TREE, diff], 13).line, 'button Nine, ID: Nine');
  assert.equal(elementLine([TREE, '- \t13 button Eight'], 13).line, 'button Seven, ID: Seven');
});

test('literal numbers are rewritten; coordinates, computed numbers and unknown elements are flagged', () => {
  assert.deepEqual(portableCode('await app.click(13); await app.typeText("13")', [TREE]),
    { code: 'await app.click({"id":"Seven"}); await app.typeText("13")', positions: [] });
  assert.deepEqual(portableCode('await app.click([10, 20])', [TREE]).positions, ['screen coordinates']);
  assert.deepEqual(portableCode('await app.click(n)', [TREE]).positions, ['a computed element number']);
  assert.match(portableCode('await app.click(99)', [TREE]).positions[0], /element 99 has no ID or label/);
  assert.deepEqual(portableCode('await app.click({ id: "Seven" })', [TREE]).positions, []);
});

const use = (id, name, input) => ({ message: { content: [{ type: 'tool_use', id, name: `mcp__plugin_sleight_computer__${name}`, input }] } });
const result = (id, text, isError = false) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] } });

test('recording keeps successful calls in order, drops pure reads and errors, and reads numbers from earlier results', () => {
  const { steps, skipped } = recordSteps([
    use('a', 'js', { code: 'await cua.getState();' }), result('a', '## Computer Use docs'),
    use('b', 'js', { code: 'let app = await cua.getApp("Calculator");', title: 'Open' }), result('b', TREE),
    use('c', 'js', { code: 'await app.click(13);' }), result('c', 'error', true),
    use('d', 'js', { code: 'await app.getScreenshot();' }), result('d', 'image'),
    use('e', 'js', { code: 'await app.click(13); await app.getAXState();' }), result('e', TREE),
    use('f', 'hover', { app: 'Chess', at: [1, 2] }), result('f', 'ok'),
    use('g', 'drag', { app: 'TextEdit', from: [1, 2], to: [3, 4] }), result('g', 'ok'),
    { message: { content: [{ type: 'tool_use', id: 'h', name: 'Bash', input: {} }] } }, result('h', 'x'),
  ]);
  assert.deepEqual(steps.map(s => [s.tool, s.args.code ?? s.args.app, s.positions]), [
    ['js', 'let app = await cua.getApp("Calculator");', []],
    ['js', 'await app.click({"id":"Seven"}); await app.getAXState();', []],
    ['drag', 'TextEdit', ['drag points']],
  ]);
  assert.equal(steps[0].args.title, 'Open');
  assert.deepEqual(skipped, ['hover']);
});

function fakeServer(replies) {
  const sent = []; let handler;
  return { sent, server: {
    send: msg => { sent.push(msg); if (msg.id === undefined) return; queueMicrotask(() => handler(replies(msg) ?? { jsonrpc: '2.0', id: msg.id, result: {} })); },
    onMessage: h => { handler = h; }, close: () => sent.push('closed'),
  }, prompt: msg => handler(msg) };
}

const step = code => ({ tool: 'js', args: { code }, positions: [] });
const scriptOf = (...steps) => ({ sleightReplay: 1, steps });
const missing = (kind, value, method = 'click') => `sleight stopped before ${method}: no element with ${kind} ${JSON.stringify(value)} in this window. Use an element number or another ID from the window below.\n${TREE}`;
const toolReply = (msg, text, isError = false) => ({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) } });
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

test('missing ID, label and line waits retry only the refused first input and report elapsed waits', async () => {
  for (const [key, kind, value] of [['id', 'ID', 'Seven'], ['label', 'label', 'All Clear'], ['line', 'line', 'Scientific, ID: menuAction:']]) {
    let attempts = 0;
    const code = `await app.click(${JSON.stringify({ [key]: value })}); await app.typeText("2");`;
    const { server } = fakeServer(msg => msg.method === 'tools/call'
      ? toolReply(msg, ++attempts < 3 ? missing(kind, value) : TREE, attempts < 3) : undefined);
    const outcome = await replay(scriptOf(step(code)), { server, ask: async () => false, clock: fakeClock(), window: windowFromText(TREE) });
    assert.equal(outcome.ok, true);
    assert.equal(attempts, 3);
    assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 500 }]);
  }
});

test('a missing first element stops at the wait deadline and returns a fresh window with the failed and remaining steps', async () => {
  const first = step('await app.click({"id":"Seven"});');
  const next = step('await app.typeText("2");');
  const calls = [];
  const current = TREE.replace('14 text 7', '14 text 42');
  const { server } = fakeServer(msg => {
    if (msg.method !== 'tools/call') return;
    calls.push(msg.params);
    return toolReply(msg, msg.params.arguments.code === first.args.code ? missing('ID', 'Seven') : current, msg.params.arguments.code === first.args.code);
  });
  const outcome = await replay(scriptOf(first, next), { server, ask: async () => false, waitMs: 600, clock: fakeClock(), window: windowFromText(TREE) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.step, 1);
  assert.deepEqual(outcome.remaining, [first, next]);
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 600 }]);
  assert.equal(outcome.window, current);
  assert.equal(calls.filter(c => c.arguments.code === first.args.code).length, 3);
  assert.match(calls.at(-1).arguments.code, /^await app\.getAXState\(/);
  assert.equal(new Set(calls.map(c => c._meta['x-codex-turn-metadata'])).size, 1);
});

test('partial batches, repeated selectors, complex code, ambiguity and unknown outcomes never retry', async () => {
  const cases = [
    ['await app.click({"id":"Seven"}); await app.click({"id":"Eight"});', missing('ID', 'Eight')],
    ['await app.typeText("x"); await app.click({"id":"Seven"});', missing('ID', 'Seven')],
    ['await app.click({"id":"Seven"}); await app.click({"id":"Seven"});', missing('ID', 'Seven')],
    ['for (const id of ["Seven"]) await app.click({ id });', missing('ID', 'Seven')],
    ['await app.click({"id":"Seven"}); doSomething();', missing('ID', 'Seven')],
    ['await app.click({"id":"Seven"});', 'sleight stopped before click: 2 elements with ID "Seven" in this window.'],
    ['await app.click({"id":"Seven"});', 'timeoutReached; whether input ran is unknown'],
    ['await app.click({"id":"Seven"});', 'no element with ID "Seven"'],
  ];
  for (const [code, error] of cases) {
    let attempts = 0;
    const { server } = fakeServer(msg => msg.method === 'tools/call'
      ? (msg.params.arguments.code === code ? (++attempts, toolReply(msg, error, true)) : toolReply(msg, TREE)) : undefined);
    const outcome = await replay(scriptOf(step(code)), { server, ask: async () => false, clock: fakeClock(), window: windowFromText(TREE) });
    assert.equal(outcome.ok, false, code);
    assert.equal(attempts, 1, code);
    assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 0 }], code);
  }
});

test('a missing element in a changed or unknown window never retries', async () => {
  const code = 'await app.click({"id":"Seven"});';
  for (const window of [undefined, { ...windowFromText(TREE), title: 'Another document' }]) {
    let attempts = 0;
    const error = window ? missing('ID', 'Seven') : missing('ID', 'Seven').split('\n')[0];
    const { server } = fakeServer(msg => msg.method === 'tools/call'
      ? msg.params.arguments.code === code ? (++attempts, toolReply(msg, error, true)) : toolReply(msg, 'Window unavailable') : undefined);
    const outcome = await replay(scriptOf(step(code)), { server, clock: fakeClock(), window });
    assert.equal(outcome.ok, false);
    assert.equal(attempts, 1);
  }
});

test('transport and snapshot failures retain the stopped step and never repeat input', async () => {
  const steps = scriptOf(step('await app.typeText("x");'), step('await app.typeText("y");'));
  let calls = 0;
  const outcome = await replayModule.replaySteps(steps, { clock: fakeClock(), call: async () => {
    calls++;
    throw new Error(calls === 1 ? 'Connection failed, input unknown' : 'Snapshot unavailable');
  } });
  assert.equal(calls, 2);
  assert.equal(outcome.step, 1);
  assert.match(outcome.error, /input unknown/);
  assert.deepEqual(outcome.remaining, steps.steps);
  assert.equal(outcome.window, null);
  assert.equal(outcome.windowError, 'Snapshot unavailable');
});

test('zero disables waiting and invalid budgets refuse before any request', async () => {
  let attempts = 0;
  const code = 'await app.click({"id":"Seven"});';
  const { server, sent } = fakeServer(msg => msg.method === 'tools/call'
    ? (msg.params.arguments.code === code ? (++attempts, toolReply(msg, missing('ID', 'Seven'), true)) : toolReply(msg, TREE)) : undefined);
  for (const waitMs of [-1, NaN, Infinity, 60001, '5000']) {
    await assert.rejects(replay(scriptOf(step(code)), { server, waitMs }), /waitMs/);
  }
  assert.deepEqual(sent, []);
  const outcome = await replay(scriptOf(step(code)), { server, waitMs: 0, clock: fakeClock() });
  assert.equal(attempts, 1);
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 0 }]);
});

function bridgeHarness(t, reply) {
  assert.equal(typeof replayModule.replayBridge, 'function', 'the replay tool must run in the current relay');
  const input = new PassThrough(), output = new PassThrough(), sent = [], received = [];
  const bridge = replayModule.replayBridge({ input, output, clock: fakeClock() });
  const send = msg => input.write(JSON.stringify(msg) + '\n');
  const respond = msg => bridge.clientOut.write(JSON.stringify(msg) + '\n');
  const incoming = createInterface({ input: bridge.clientIn });
  incoming.on('line', line => { const msg = JSON.parse(line); sent.push(msg); reply?.(msg, respond); });
  const outgoing = createInterface({ input: output });
  outgoing.on('line', line => received.push(JSON.parse(line)));
  t.after(() => { input.end(); incoming.close(); outgoing.close(); });
  return { send, sendLine: line => input.write(line + '\n'), respond, sent, received, bridge };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('ordinary bridge traffic stays byte for byte without JSON parsing or serialization', () => {
  const input = new PassThrough(), output = new PassThrough(), sent = [], received = [];
  const bridge = replayModule.replayBridge({ input, output });
  bridge.clientIn.on('data', chunk => sent.push(chunk.toString()));
  output.on('data', chunk => received.push(chunk.toString()));
  const client = [' { "params": { "name": "js", "arguments": { "code": "await app.getScreenshot();" } }, "method" : "tools/call", "id": 7 }\n',
    '{ "method": "notifications/initialized", "jsonrpc": "2.0" }\r\n', 'invalid line\n'];
  const server = [' { "id": 7, "result": { "content": [{ "type": "image", "data": "' + 'A'.repeat(2 ** 20) + '" }] } }\n',
    '{ "method": "elicitation/create", "id": "ask", "params": {"message":"Allow Calculator?"} }\r\n'];
  const parse = JSON.parse, stringify = JSON.stringify;
  let parses = 0, serializations = 0;
  try {
    JSON.parse = (...args) => { parses++; return parse(...args); };
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    for (const line of client) input.write(line);
    for (const line of server) bridge.clientOut.write(line);
  } finally { JSON.parse = parse; JSON.stringify = stringify; input.end(); bridge.clientOut.end(); }
  assert.equal(parses, 0);
  assert.equal(serializations, 0);
  assert.equal(sent.join(''), client.join(''));
  assert.equal(received.join(''), server.join(''));
});

test('a pending tool list parses only its matching reply and preserves other lines', () => {
  const input = new PassThrough(), output = new PassThrough(), sent = [], received = [];
  const bridge = replayModule.replayBridge({ input, output });
  bridge.clientIn.on('data', chunk => sent.push(chunk.toString()));
  output.on('data', chunk => received.push(chunk.toString()));
  const request = ' { "id" : "catalog", "method" : "tools/list", "params": {} }\n';
  input.write(request);
  const unrelated = '{ "id": "catalog-other", "result": { "content": [{"type":"image","data":"' + 'A'.repeat(2 ** 20) + '"}] } }\n';
  const parse = JSON.parse, stringify = JSON.stringify;
  let parses = 0, serializations = 0;
  try {
    JSON.parse = (...args) => { parses++; return parse(...args); };
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    bridge.clientOut.write(unrelated);
    assert.equal(parses, 0);
    assert.equal(serializations, 0);
    bridge.clientOut.write('{ "id" : "catalog", "result": { "tools": [{ "name":"js" }] } }\n');
  } finally { JSON.parse = parse; JSON.stringify = stringify; input.end(); bridge.clientOut.end(); }
  assert.equal(parses, 1);
  assert.equal(serializations, 1);
  assert.equal(sent.join(''), request);
  assert.equal(received[0], unrelated);
  assert.ok(JSON.parse(received[1]).result.tools.some(tool => tool.name === 'replay'));
});

test('an action-only replay waits using its first refused result without adding a read', async t => {
  let reads = 0, attempts = 0;
  const code = 'await app.click({"id":"Seven"});';
  const h = bridgeHarness(t, (msg, respond) => {
    if (msg.method !== 'tools/call') return;
    if (msg.params.arguments.code !== code) { reads++; respond(toolReply(msg, TREE)); }
    else { attempts++; respond(toolReply(msg, attempts === 1 ? missing('ID', 'Seven') : TREE, attempts === 1)); }
  });
  h.send({ jsonrpc: '2.0', id: 'run', method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(step(code)) } } });
  await settle();
  const outcome = JSON.parse(h.received.at(-1).result.content[0].text);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 250 }]);
  assert.equal(reads, 0);
  assert.equal(h.sent[0].params.arguments.code, code);
});

test('an acquisition result supplies the expected window without an extra read', async t => {
  let attempts = 0;
  const code = 'await app.click({"id":"Seven"});';
  const h = bridgeHarness(t, (msg, respond) => {
    const failed = msg.params.arguments.code === code && ++attempts === 1;
    respond(toolReply(msg, failed ? missing('ID', 'Seven') : TREE, failed));
  });
  h.send({ jsonrpc: '2.0', id: 'run', method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(step('app = await cua.getApp("Calculator");'), step(code)) } } });
  await settle();
  const outcome = JSON.parse(h.received.at(-1).result.content[0].text);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 250 }]);
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent.some(msg => msg.params.arguments.code.includes('getAXState')), false);
});

test('escaped envelope fields and tool-list IDs still concern the bridge', async t => {
  const h = bridgeHarness(t);
  h.sendLine('{"\\u006dethod":"tools\\u002flist","id":"catalog"}');
  h.bridge.clientOut.write('{"id":"\\u0063atalog","result":{"tools":[{"name":"js"}]}}\n');
  assert.ok(h.received.at(-1).result.tools.some(tool => tool.name === 'replay'));
  h.sendLine('{"method":"tools\\/list","id":"catalog/2"}');
  h.bridge.clientOut.write('{"id":"catalog\\/2","result":{"tools":[{"name":"js"}]}}\n');
  assert.ok(h.received.at(-1).result.tools.some(tool => tool.name === 'replay'));
  h.sendLine('{"id":"run","method":"tools\\u002fcall","params":{"name":"re\\u0070lay","arguments":{"script":{"sleightReplay":1,"steps":[]}}}}');
  await settle();
  assert.equal(JSON.parse(h.received.at(-1).result.content[0].text).ok, true);
});

test('bridge framing preserves split UTF-8, multiple lines and an unterminated final line', async () => {
  const input = new PassThrough(), output = new PassThrough(), sent = [], received = [];
  const bridge = replayModule.replayBridge({ input, output });
  bridge.clientIn.on('data', chunk => sent.push(chunk.toString()));
  output.on('data', chunk => received.push(chunk.toString()));
  const data = Buffer.from('{"method":"unknown","text":"é ♟"}\r\n{"id":7,"result":{}}\nfinal');
  for (const byte of data) input.write(Buffer.from([byte]));
  bridge.clientOut.write(data);
  input.end(); bridge.clientOut.end();
  await settle();
  assert.equal(sent.join(''), data.toString());
  assert.equal(received.join(''), data.toString());
});

test('Claude sees replay in tools/list and gets the stopped step, remaining work, waits and fresh window', async t => {
  const stopped = step('await app.click({"id":"Seven"});');
  const next = step('await app.typeText("2");');
  const current = TREE.replace('14 text 7', '14 text 42');
  const h = bridgeHarness(t, (msg, respond) => {
    if (msg.method === 'tools/list') respond({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'js' }] } });
    if (msg.method === 'tools/call') respond(toolReply(msg, msg.params.arguments.code === stopped.args.code ? missing('ID', 'Seven') : current, msg.params.arguments.code === stopped.args.code));
  });
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const definition = h.received[0].result.tools.find(tool => tool.name === 'replay');
  assert.ok(definition);
  assert.equal(definition._meta?.['anthropic/alwaysLoad'], false, 'replay stays discoverable without forcing its schema into every prompt');
  assert.ok(definition.inputSchema.properties.waitMs);
  h.send({ jsonrpc: '2.0', id: 'read', method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.getAXState();' } } });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(stopped, next), waitMs: 500 }, _meta: { trace: 'same Claude turn' } } });
  await settle();
  const reply = h.received.find(msg => msg.id === 2);
  assert.equal(reply.result.isError, undefined, 'a stop returns structured takeover context');
  const outcome = JSON.parse(reply.result.content[0].text);
  assert.equal(outcome.step, 1);
  assert.deepEqual(outcome.remaining, [stopped, next]);
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 500 }]);
  assert.equal(outcome.window, current);
  assert.ok(h.sent.filter(msg => msg.method === 'tools/call' && msg.id !== 'read').every(msg => msg.params._meta.trace === 'same Claude turn'));
  assert.equal(h.received.some(msg => String(msg.id).startsWith('sleight-replay-')), false, 'internal replies stay internal');
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.pressKey("Escape");' } } });
  assert.equal(h.sent.at(-1).id, 3, 'Claude can use the existing handle after a stop');
});

test('waiting against the real guard sends input once and never repeats a partially completed batch', async () => {
  for (const partial of [false, true]) {
    const clock = fakeClock(), inputs = [];
    const code = partial ? 'await app.click({"id":"Seven"}); await app.click({"id":"Eight"});' : 'await app.click({"id":"Seven"});';
    const current = () => partial || clock.now() >= 500 ? TREE : TREE.replace('\t\t13 button Seven, ID: Seven\n', '');
    const raw = { getAXState: async () => current(), click: async number => inputs.push(number) };
    const outcome = await replayModule.replaySteps(scriptOf(step(code)), {
      clock, window: windowFromText(TREE),
      call: async (_name, args) => {
        const output = [];
        try {
          await runInNewContext(`(async () => { ${guardedCode(args.code, windowFromText(TREE))} })()`, {
            app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: text => output.push(text) },
          });
          return { result: { content: [{ type: 'text', text: output.join('\n') }] } };
        } catch (error) { return { result: { isError: true, content: [{ type: 'text', text: error.message }] } }; }
      },
    });
    assert.deepEqual(inputs, [13]);
    assert.equal(outcome.ok, !partial);
    assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: partial ? 0 : 500 }]);
    if (partial) assert.match(outcome.window, /Window: "Calculator"/);
  }
});

test('the tool shares the real relay approval memory, input lease and guards with Claude takeover', async t => {
  const h = bridgeHarness(t), serverIn = new PassThrough(), serverOut = new PassThrough();
  const directory = mkdtempSync(join(tmpdir(), 'sleight-replay-'));
  const relay = createRelay({ clientIn: h.bridge.clientIn, clientOut: h.bridge.clientOut, serverIn, serverOut,
    inputLease: new InputLease({ directory, holder: 'replay test' }), changeReview: false, idleTurnEndMs: 0 });
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = [], waiting = new Map();
  let held;
  const respond = msg => serverOut.write(JSON.stringify(msg) + '\n');
  const answer = msg => {
    const code = msg.params.arguments.code;
    const failure = code.includes('click({"id":"Eight"})');
    const reply = toolReply(msg, failure ? missing('ID', 'Eight') : TREE, failure);
    reply.result._meta = { 'codex/toolSurface': { app: { appId: 'com.apple.calculator' } } };
    respond(reply);
  };
  const lines = createInterface({ input: serverIn });
  t.after(() => lines.close());
  lines.on('line', line => {
    const msg = JSON.parse(line); engine.push(msg);
    if (waiting.has(msg.id)) { const call = waiting.get(msg.id); waiting.delete(msg.id); answer(call); }
    else if (msg.method === 'tools/call') {
      if (msg.params.arguments.code?.includes('app = await cua.getApp')) {
        const id = `ask-${msg.id}`; waiting.set(id, msg);
        respond({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
          message: 'Allow Computer Use to use "Calculator"?', requestedSchema: { type: 'object', properties: {} },
          _meta: { connector_id: 'computer-use', tool_params: { app: 'com.apple.calculator' }, persist: ['session'], riskLevel: 'low' },
        } });
      } else if (msg.params.arguments.code?.includes('typeText("pending")')) held = msg;
      else answer(msg);
    }
  });
  const acquisition = step('app = await cua.getApp("Calculator");');
  h.send({ jsonrpc: '2.0', id: 'run', method: 'tools/call', params: { name: 'replay', arguments: {
    script: scriptOf(acquisition, step('await app.click({"id":"Eight"});'), step('await app.typeText("2");')), waitMs: 500,
  } } });
  const approval = h.received.find(msg => msg.method === 'elicitation/create');
  assert.ok(approval);
  h.send({ jsonrpc: '2.0', id: approval.id, result: { action: 'accept', content: {} } });
  await settle();
  const result = JSON.parse(h.received.find(msg => msg.id === 'run').result.content[0].text);
  assert.equal(result.step, 2);
  assert.deepEqual(result.waits, [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 500 }]);
  assert.match(result.window, /13 button Seven/);
  h.send({ jsonrpc: '2.0', id: 'takeover', method: 'tools/call', params: { name: 'js', arguments: acquisition.args } });
  await settle();
  assert.equal(h.received.filter(msg => msg.method === 'elicitation/create').length, 1, 'session approval survives replay');
  const sessions = engine.filter(msg => msg.method === 'tools/call').map(msg => JSON.parse(msg.params._meta['x-codex-turn-metadata']).session_id);
  assert.equal(new Set(sessions).size, 1);
  assert.equal(h.received.find(msg => msg.id === 'takeover').result.isError, undefined);
  h.send({ jsonrpc: '2.0', id: 'pending', method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("pending");' } } });
  assert.ok(held);
  h.send({ jsonrpc: '2.0', id: 'overlap', method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(step('await app.typeText("next");')) } } });
  await settle();
  const overlap = JSON.parse(h.received.find(msg => msg.id === 'overlap').result.content[0].text);
  assert.equal(overlap.ok, false, 'the current relay still refuses replay input while an ordinary call is pending');
  assert.equal(engine.some(msg => msg.params?.arguments?.code?.includes('typeText("next")')), false);
  answer(held);
});

test('CLI wait options and positional permission are passed explicitly', () => {
  assert.deepEqual(replayModule.replayOptions(['--wait-ms', '750', '--allow-positions']), { waitMs: 750, allowPositions: true });
  assert.deepEqual(replayModule.replayOptions([]), { waitMs: 5000, allowPositions: false });
  for (const args of [['--wait-ms'], ['--wait-ms', '-1'], ['--something']]) assert.throws(() => replayModule.replayOptions(args), /option|value/);
});

test('a first action stop snapshots that action handle rather than a later unrelated read', async () => {
  const calls = [];
  const outcome = await replayModule.replaySteps(scriptOf(step('await calc.click({"id":"Seven"}); await editor.getAXState();')), {
    waitMs: 0, clock: fakeClock(), call: async (_name, args) => {
      calls.push(args.code);
      return calls.length === 1 ? { result: { isError: true, content: [{ type: 'text', text: missing('ID', 'Seven') }] } }
        : { result: { content: [{ type: 'text', text: args.code.includes('calc.getAXState') ? TREE : 'Window: "Other", App: TextEdit.' }] } };
    },
  });
  assert.equal(outcome.window, TREE);
  assert.match(calls[1], /^await calc\.getAXState/);
});

test('a later replay uses its own result before waiting instead of tracking previous results', async t => {
  let attempts = 0;
  const code = 'await app.click({"id":"Seven"});';
  const h = bridgeHarness(t, (msg, respond) => {
    if (msg.method === 'tools/call') {
      const failed = msg.params.arguments.code === code && ++attempts < 2;
      respond(toolReply(msg, failed ? missing('ID', 'Seven') : TREE, failed));
    }
  });
  for (const [id, script] of [[1, scriptOf(step('app = await cua.getApp("Calculator");'))], [2, scriptOf(step(code))]]) {
    h.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'replay', arguments: { script } } });
    await settle();
  }
  const outcome = JSON.parse(h.received.at(-1).result.content[0].text);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 250 }]);
});

test('cancellation reaches the active internal call and prevents later replay steps', async t => {
  const h = bridgeHarness(t);
  h.send({ jsonrpc: '2.0', id: 'run', method: 'tools/call', params: { name: 'replay', arguments: {
    script: scriptOf(step('await app.typeText("x");'), step('await app.typeText("y");')),
  } } });
  const pending = h.sent[0];
  h.sendLine('{"jsonrpc":"2.0","method":"notifications\\u002fcancelled","params":{"requestId":"run","reason":"user stopped"}}');
  assert.equal(h.sent.at(-1).params.requestId, pending.id);
  h.sendLine('{"method":"notifications\\/cancelled","params":{"requestId":"run"}}');
  assert.equal(h.sent.at(-1).params.requestId, pending.id);
  h.respond(toolReply(pending, 'cancelled, input outcome unknown', true));
  await settle();
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 1);
  const outcome = JSON.parse(h.received.at(-1).result.content[0].text);
  assert.equal(outcome.step, 1);
  assert.equal(outcome.remaining.length, 2);
});

test('a flow refusal preserves the pending user exception without an automatic snapshot call', async t => {
  const h = bridgeHarness(t), serverIn = new PassThrough(), serverOut = new PassThrough(), prompts = [], forwarded = [];
  const relay = createRelay({ clientIn: h.bridge.clientIn, clientOut: h.bridge.clientOut, serverIn, serverOut, changeReview: false,
    flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async (...args) => { prompts.push(args); return 'accept'; }, idleTurnEndMs: 0 });
  t.after(() => relay.close());
  const lines = createInterface({ input: serverIn });
  t.after(() => lines.close());
  lines.on('line', line => { const msg = JSON.parse(line); forwarded.push(msg); serverOut.write(JSON.stringify(toolReply(msg, TREE)) + '\n'); });
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(step('await app.typeText("SECRET");')) } } });
  await settle();
  assert.equal(forwarded.length, 0);
  const outcome = JSON.parse(h.received.at(-1).result.content[0].text);
  assert.match(outcome.error, /Flow rules/);
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flow_exception', arguments: {} } });
  await settle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0][2].detail, /SECRET/);
});

test('a named action replay uses a granted flow exception without an intervening read', async t => {
  const h = bridgeHarness(t), serverIn = new PassThrough(), serverOut = new PassThrough(), forwarded = [];
  const relay = createRelay({ clientIn: h.bridge.clientIn, clientOut: h.bridge.clientOut, serverIn, serverOut, changeReview: false,
    flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async () => 'accept', idleTurnEndMs: 0 });
  t.after(() => relay.close());
  const lines = createInterface({ input: serverIn });
  t.after(() => lines.close());
  lines.on('line', line => { const msg = JSON.parse(line); forwarded.push(msg); serverOut.write(JSON.stringify(toolReply(msg, TREE)) + '\n'); });
  const script = scriptOf(step('await app.setValue({"id":"field"},"SECRET");'));
  h.send({ id: 1, method: 'tools/call', params: { name: 'replay', arguments: { script } } });
  await settle();
  assert.match(JSON.parse(h.received.at(-1).result.content[0].text).error, /Flow rules/);
  assert.equal(forwarded.length, 0);
  h.send({ id: 2, method: 'tools/call', params: { name: 'flow_exception', arguments: {} } });
  await settle();
  h.send({ id: 3, method: 'tools/call', params: { name: 'replay', arguments: { script } } });
  await settle();
  assert.equal(JSON.parse(h.received.at(-1).result.content[0].text).ok, true);
  assert.equal(forwarded.length, 1);
  assert.match(forwarded[0].params.arguments.code, /setValue/);
});

test('the replay tool passes approvals and their decisions through the existing client unchanged', async t => {
  const h = bridgeHarness(t, (msg, respond) => {
    if (msg.method === 'tools/call') respond({ jsonrpc: '2.0', id: 'approval', method: 'elicitation/create', params: { message: 'Allow Calculator?', requestedSchema: { properties: {} } } });
    if (msg.id === 'approval' && msg.result) {
      assert.equal(msg.result.action, 'decline');
      const active = h.sent.find(msg => msg.method === 'tools/call');
      respond(toolReply(active, 'The user declined Calculator. Stop.', true));
    }
  });
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(step('let app = await cua.getApp("Calculator");')) } } });
  await settle();
  assert.equal(h.received[0].id, 'approval');
  h.send({ jsonrpc: '2.0', id: 'approval', result: { action: 'decline', content: {} } });
  await settle();
  const outcome = JSON.parse(h.received.at(-1).result.content[0].text);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /declined/);
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 1, 'a denied acquisition must not be read again');
});

test('positions and unknown tools refuse without sending a call, and an active replay excludes concurrent input', async t => {
  const h = bridgeHarness(t);
  for (const script of [scriptOf({ tool: 'drag', args: {}, positions: ['drag points'] }), scriptOf(step('await app.click([1,2]);')), scriptOf({ tool: 'blocked_app', args: {} })]) {
    h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'replay', arguments: { script } } });
    await settle();
    assert.equal(h.received.at(-1).result.isError, true);
    assert.equal(h.sent.length, 0);
  }
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'replay', arguments: { script: scriptOf(step('await app.typeText("x");')) } } });
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("y");' } } });
  assert.equal(h.sent.length, 1);
  assert.equal(h.received.at(-1).id, 3);
  assert.match(h.received.at(-1).result.content[0].text, /replay.*running/i);
  h.respond(toolReply(h.sent[0], TREE));
  await settle();
  assert.equal(JSON.parse(h.received.at(-1).result.content[0].text).ok, true);
});

test('replay runs each step and stops at the first error', async () => {
  const script = { sleightReplay: 1, steps: [
    { tool: 'js', args: { code: 'one' }, positions: [] }, { tool: 'js', args: { code: 'two' }, positions: [] }, { tool: 'js', args: { code: 'three' }, positions: [] }] };
  const { sent, server } = fakeServer(msg => msg.method === 'tools/call' && msg.params.arguments.code === 'two'
    ? { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'no element with ID "AllClear"' }] } } : undefined);
  const outcome = await replay(script, { server, ask: async () => true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.step, 2);
  assert.equal(outcome.error, 'no element with ID "AllClear"');
  assert.deepEqual(outcome.waits, [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 0 }]);
  assert.deepEqual(sent.filter(m => m.method === 'tools/call').map(m => m.params.arguments.code), ['one', 'two']);
  assert.equal(sent.at(-1), 'closed');
});

test('a script tied to positions refuses before starting the relay, unless allowed', async () => {
  const script = { sleightReplay: 1, steps: [{ tool: 'drag', args: {}, positions: ['drag points'] }] };
  const { sent, server } = fakeServer(() => undefined);
  await assert.rejects(replay(script, { server, ask: async () => true }), /step 1 \(drag points\).*--allow-positions/);
  assert.deepEqual(sent, []);
  assert.deepEqual(await replay(script, { server, ask: async () => true, allowPositions: true }), { ok: true, steps: 1, waits: [{ step: 1, waitedMs: 0 }] });
  await assert.rejects(replay({ steps: [] }, { server, ask: async () => true }), /not a sleight replay script/);
});

test('approval prompts go to the person running the replay; other forms are declined', async () => {
  const asked = [];
  const { sent, server } = fakeServer(msg => {
    if (msg.method !== 'tools/call') return undefined;
    // The relay asks before answering the call.
    handlerPrompt({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "Calculator"?', _meta: { connector_id: 'computer-use' } } });
    handlerPrompt({ jsonrpc: '2.0', id: 'e2', method: 'elicitation/create', params: { message: 'Keep or undo?', requestedSchema: { properties: { decision: {} } } } });
    return undefined;
  });
  let handlerPrompt;
  const original = server.onMessage;
  server.onMessage = h => { handlerPrompt = h; original(h); };
  await replay({ sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'x' }, positions: [] }] }, { server, ask: async message => { asked.push(message); return true; } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(asked, ['Allow Computer Use to use "Calculator"?']);
  assert.deepEqual(sent.filter(m => typeof m === 'object' && String(m.id).startsWith('e')).map(m => [m.id, m.result.action]).sort(), [['e1', 'accept'], ['e2', 'decline']]);
});

test('the guard finds an element by its whole line, and stops when none or several match', async () => {
  const clicks = [];
  const app = { getAXState: async () => 'Window: "Calculator", App: Calculator.\n\t3 Scientific, ID: menuAction:\n\t4 Programmer, ID: menuAction:\n\t5 OK\n\t6 OK', click: async n => clicks.push(n) };
  const run = code => runInNewContext(`(async () => { ${guardedCode(code, { title: 'Calculator', app: 'Calculator', url: null })} })()`, { app, cua: { getApp: async () => app }, nodeRepl: { write() {} } });
  await run('await app.click({ line: "Programmer, ID: menuAction:" })');
  assert.deepEqual(clicks, [4]);
  await assert.rejects(run('await app.click({ line: "OK" })'), /2 elements with line "OK"/);
  await assert.rejects(run('await app.click({ line: "Basic" })'), /no element with line "Basic"/);
});
