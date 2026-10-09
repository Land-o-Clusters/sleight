import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { elementLine, elementSpec, portableCode, recordSteps, replay } from '../plugins/sleight/lib/replay.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

const TREE = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator, ID: main\n\t67 View\n\t\t3 Scientific, ID: menuAction:\n\t\t4 Programmer, ID: menuAction:\n\t\t9 button Description: Equals, ID: Equals\n\t\t12 button All Clear\n\t\t13 button Seven, ID: Seven\n\t\t14 text 7';

test('an element number becomes a unique ID, then a unique label, then its whole line', () => {
  assert.deepEqual(elementSpec(elementLine([TREE], 13)), { id: 'Seven' });
  assert.deepEqual(elementSpec(elementLine([TREE], 3)), { line: 'Scientific, ID: menuAction:' });
  assert.deepEqual(elementSpec(elementLine([TREE], 12)), { label: 'All Clear' });
  assert.deepEqual(elementSpec(elementLine([TREE], 67)), { line: 'View' });
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

test('replay runs each step and stops at the first error', async () => {
  const script = { sleightReplay: 1, steps: [
    { tool: 'js', args: { code: 'one' }, positions: [] }, { tool: 'js', args: { code: 'two' }, positions: [] }, { tool: 'js', args: { code: 'three' }, positions: [] }] };
  const { sent, server } = fakeServer(msg => msg.method === 'tools/call' && msg.params.arguments.code === 'two'
    ? { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'no element with ID "AllClear"' }] } } : undefined);
  const outcome = await replay(script, { server, ask: async () => true });
  assert.deepEqual(outcome, { ok: false, step: 2, error: 'no element with ID "AllClear"' });
  assert.deepEqual(sent.filter(m => m.method === 'tools/call').map(m => m.params.arguments.code), ['one', 'two']);
  assert.equal(sent.at(-1), 'closed');
});

test('a script tied to positions refuses before starting the relay, unless allowed', async () => {
  const script = { sleightReplay: 1, steps: [{ tool: 'drag', args: {}, positions: ['drag points'] }] };
  const { sent, server } = fakeServer(() => undefined);
  await assert.rejects(replay(script, { server, ask: async () => true }), /step 1 \(drag points\).*--allow-positions/);
  assert.deepEqual(sent, []);
  assert.deepEqual(await replay(script, { server, ask: async () => true, allowPositions: true }), { ok: true, steps: 1 });
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
