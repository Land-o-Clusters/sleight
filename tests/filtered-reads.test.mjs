import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { constants, createContext, runInContext } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const header = 'Window: "Fixture", App: Fixture Editor.';
const tree = (shifted = false) => header + '\n0 standard window Fixture\n' +
  Array.from({ length: 100 }, (_, i) => `\t${i + 1} button Row ${shifted ? i + 1 : i}`).join('\n');
const filtered = expression => `const state = await app.getAXState(); nodeRepl.write(${expression});`;

async function engine(t, { maxItems, acquire = true, valueOnAction = false } = {}) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-filtered-read-')));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const pending = new Map(), actions = [];
  let id = 0, shifted = false, changed = false, value = false, content = [];
  const current = () => (changed ? tree(shifted).replace('"Fixture"', '"Other"') : tree(shifted)) +
    (valueOnAction ? '\n\t101 text field Value: ' + (value ? 'after' : 'before') : '');
  const write = value => content.push({ type: 'text', text: typeof value === 'string' ? value :
    JSON.stringify(Array.isArray(value) && maxItems !== undefined ? value.slice(0, maxItems) : value) });
  const raw = { getAXState: async () => current(), click: async n => actions.push(n), pressKey: async key => { actions.push(key); value = true; } };
  const context = createContext({ evaluations: 0, cua: {
    getApp: async () => { write(current()); return raw; }, listApps: async () => [],
  }, nodeRepl: { write }, console: { log: (...args) => write(format(...args)) } });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'filtered-fixture',
    changeReview: false, inputLease: new InputLease({ directory: dir, holder: 'fixture' }) });
  clientOut.setEncoding('utf8').on('data', data => {
    for (const line of data.trim().split('\n')) {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg.result); pending.delete(msg.id);
    }
  });
  let queue = Promise.resolve();
  serverIn.setEncoding('utf8').on('data', data => {
    for (const line of data.trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method !== 'tools/call') continue;
      queue = queue.then(async () => {
        content = [];
        let isError = false;
        const code = msg.params.arguments.code.replace(/\bvar app\s*=/, 'globalThis.app =');
        try { await runInContext('(async () => { ' + code + ' })()', context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (error) { isError = true; write(error.message); }
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content, isError,
          _meta: { 'codex/toolSurface': { app: { appId: 'example.fixture' } } } } }) + '\n');
      });
    }
  });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(dir, { recursive: true, force: true }); });
  const call = code => new Promise(resolve => {
    const callId = ++id; pending.set(callId, resolve);
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call',
      params: { name: 'js', arguments: { code } } }) + '\n');
  });
  if (acquire) {
    const acquisition = await call('var app = await cua.getApp("example.fixture")');
    assert.equal(acquisition.isError, false);
    assert.match(JSON.stringify(acquisition.content), /Row 99/, 'the first acquisition keeps its tree');
  }
  return { call, actions, evaluations: () => context.evaluations,
    shift: () => { shifted = true; }, change: () => { changed = true; } };
}

const output = result => result.content.map(c => c.text ?? '').join('\n');

for (const code of [
  'const d = await app.getAXState(); d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n") || "none"',
  'const d = await app.getAXState(); d.split("\\n").filter(() => false).join("\\n") || "none"',
  'await app.getAXState().then(s => s.split("\\n").filter(l => /Row 7/.test(l)).join("\\n"));',
  'app.getAXState().then(s => s.split("\\n").filter(l => /Row 7/.test(l)).join("\\n"));',
  'const d = await app.getAXState(); await Promise.resolve(d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n"));',
  'const d = await app.getAXState(); console.log(d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n"));',
  'const d = await app.getAXState(); console.log(d.split("\\n").filter(l => /Row 7/.test(l)));',
  'console.log((await app.getAXState()).split("\\n").filter(l => /Row 7/.test(l)).join("\\n"));',
  'const d = await app.getAXState(); d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n") // selected rows',
  'const d = await app.getAXState(); console.log(d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n"),);',
]) {
  test('a final read-derived value prints by default and filters its tree: ' + code, async t => {
    const h = await engine(t);
    const result = await h.call(code);
    assert.equal(result.isError, false);
    assert.match(output(result), code.includes('false') ? /none/ : /Row 7/);
    assert.match(output(result), /Window: "Fixture", App: Fixture Editor\./);
    assert.doesNotMatch(output(result), /standard window|Row 99|no change since|filtered-read/);
  });
}

for (const ending of [
  '(++globalThis.evaluations, d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n"))',
  'console.log((++globalThis.evaluations, d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n")))',
]) {
  test('the final value is evaluated and printed once: ' + ending, async t => {
    const h = await engine(t);
    const result = await h.call('const d = await app.getAXState(); ' + ending);
    assert.equal(result.isError, false);
    assert.equal(h.evaluations(), 1);
    assert.equal(output(result).match(/\t8 button Row 7\n/g)?.length, 1);
    assert.doesNotMatch(output(result), /standard window|Row 99/);
  });
}

for (const expression of ['d.length', '({ rows: d.split("\\n").slice(2, 3) })', '("prefix:" + d).repeat(10)']) {
  test('read-derived bare values use the bounded autoprint formatter: ' + expression, async t => {
    const h = await engine(t);
    const result = await h.call('const d = await app.getAXState(); ' + expression);
    assert.equal(result.isError, false);
    const printed = result.content.filter(c => c.type === 'text' && !c.text.startsWith('Window:'));
    assert.equal(printed.length, 1);
    assert.ok(printed[0].text.length <= 4000);
    assert.match(printed[0].text, expression === 'd.length' ? /^\d+$/ : expression.startsWith('({') ? /rows: \[/ : /\[output truncated\]$/);
  });
}

test('a final filtered value on first acquisition keeps the whole window tree', async t => {
  const h = await engine(t, { acquire: false });
  const result = await h.call('var app = await cua.getApp("example.fixture"); const d = await app.getAXState(); d.split("\\n").slice(2, 3)');
  assert.equal(result.isError, false);
  assert.match(output(result), /standard window/);
  assert.match(output(result), /Row 99/);
});

for (const code of ['await app.getAXState();', 'const d = await app.getAXState(); d;']) {
  test('an unfiltered bare read keeps its ordinary diff without duplicate output: ' + code, async t => {
    const h = await engine(t);
    const result = await h.call(code);
    assert.equal(result.isError, false);
    assert.match(output(result), /no change since/);
    assert.doesNotMatch(output(result), /Row 99/);
    assert.equal(output(result).match(/Window:/g)?.length, 1);
  });
}

for (const code of [
  'const d = await app.getAXState(); await app.click(1); d.split("\\n").slice(2, 3)',
  'const d = await app.getAXState(); const act = app.click; await act(1); d.split("\\n").slice(2, 3)',
  'const d = await app.getAXState(); const other = await app.getAXState(); d.split("\\n").slice(2, 3)',
  'let d = await app.getAXState(); d = "unrelated"; d.split("\\n")',
  'const d = await app.getAXState(); "unrelated"',
  'const d = await app.getAXState(); console.log(d.split("\\n").slice(2, 3), "other")',
  'const d = await app.getAXState(); console.log("first", d.split("\\n").slice(2, 3))',
  'const d = await app.getAXState(); console.log(...[d.split("\\n").slice(2, 3), "other"])',
  'const d = await app.getAXState(); d.split("\\n").filter(() => { throw new Error("fixture failure"); })',
]) {
  test('excluded final values preserve the normal tree: ' + code, async t => {
    const h = await engine(t);
    const result = await h.call(code);
    if (code.includes('const act = app.click')) {
      assert.equal(result.isError, true); assert.match(output(result), /click method extraction.*Use direct handle\.click\(/);
      assert.deepEqual(h.actions, []); return;
    }
    assert.match(output(result), /standard window|no change since|lines changed since/);
    if (code.includes('fixture failure')) {
      assert.equal(result.isError, true);
      assert.match(output(result), /fixture failure/);
    }
    if (code.includes('console.log') && !code.includes('...')) assert.match(output(result), /other|first/);
  });
}

test('a bare filtered result preserves window-change refusal and hidden numeric guards', async t => {
  const h = await engine(t);
  h.shift();
  const result = await h.call('const d = await app.getAXState(); d.split("\\n").filter(l => /Row 7/.test(l)).join("\\n")');
  assert.doesNotMatch(output(result), /Row 100/);
  const action = await h.call('await app.click(1);');
  assert.equal(action.isError, true);
  assert.deepEqual(h.actions, []);
  h.change();
  const changed = await h.call('const d = await app.getAXState(); d.split("\\n").slice(2, 3)');
  assert.match(output(changed), /standard window|Input lease:|Document scope:/);
});

test('autoprint truncation never authorizes element numbers from hidden array entries', async t => {
  const h = await engine(t);
  h.shift();
  const filtered = await h.call('const d = await app.getAXState(); d.split("\\n").slice(2)');
  assert.equal(filtered.isError, false);
  assert.match(output(filtered), /more items/);
  assert.doesNotMatch(output(filtered), /Row 50|Row 100/);
  const action = await h.call('await app.click(50);');
  assert.notDeepEqual(h.actions, [50]);
  assert.deepEqual(h.actions, action.isError ? [] : [49]);
});

test('a derived object is inspected without running getters or custom inspectors', async t => {
  const h = await engine(t);
  const result = await h.call(`const d = await app.getAXState(); ({ length: d.length,
    get danger() { ++globalThis.evaluations; throw new Error('getter ran'); },
    [Symbol.for('nodejs.util.inspect.custom')]() { ++globalThis.evaluations; return 'custom ran'; } })`);
  assert.equal(result.isError, false);
  assert.equal(h.evaluations(), 0);
  assert.match(output(result), /danger: \[Getter\]/);
  assert.doesNotMatch(output(result), /custom ran|getter ran/);
});

for (const expression of [
  'state.split("\\n").filter(line => line.includes("Row 7")).join("\\n")',
  'state.split("\\n").filter(line => line.includes("Row 7"))',
  'state.match(/Row 7\\d/g)',
]) {
  test('a derived string or array keeps its value and just the window header: ' + expression, async t => {
    const h = await engine(t);
    const result = await h.call(filtered(expression));
    assert.equal(result.isError, false);
    assert.match(output(result), /Row 7/);
    assert.match(output(result), /Window: "Fixture", App: Fixture Editor\./);
    assert.doesNotMatch(output(result), /standard window|no change since|lines changed since|Row 99|sleight:filtered/);
  });
}

for (const expression of ['state.split("\\n").filter(() => false)', 'state.slice(0, 0)', '"  "']) {
  test('an empty derived value keeps the window instead of leaving only a header: ' + expression, async t => {
    const h = await engine(t);
    const result = await h.call(filtered(expression));
    assert.equal(result.isError, false);
    assert.match(output(result), /standard window|no change since|lines changed since/);
    assert.doesNotMatch(output(result), /sleight:filtered/);
  });
}

for (const code of [
  'nodeRepl.write((await app.getAXState()).split("\\n").filter(line => line.includes("Row 7")));',
  'const state = await app.getAXState(); const rows = state.split("\\n").filter(line => line.includes("Row 7")); nodeRepl.write(rows);',
]) {
  test('inline and assigned filtered reads omit the redundant tree: ' + code, async t => {
    const h = await engine(t);
    const result = await h.call(code);
    assert.equal(result.isError, false);
    assert.match(output(result), /Row 7/);
    assert.match(output(result), /Window:/);
    assert.doesNotMatch(output(result), /standard window|Row 99/);
  });
}

test('a filtered emit:false read preserves the caller choice to hide the header', async t => {
  const h = await engine(t);
  const result = await h.call(filtered('state.split("\\n").slice(2, 3)').replace('getAXState()', 'getAXState({emit:false})'));
  assert.equal(result.isError, false);
  assert.match(output(result), /Row 0/);
  assert.doesNotMatch(output(result), /Window:|standard window/);
});

test('an action before the filtered read keeps the action\'s tree result', async t => {
  const h = await engine(t);
  const result = await h.call('await app.click(1); ' + filtered('state.split("\\n").filter(line => line.includes("Row 7"))'));
  assert.equal(result.isError, false);
  assert.deepEqual(h.actions, [1]);
  assert.match(output(result), /standard window|sleight: (?:no change since|lines changed)/);
});

for (const suffix of ['await app.click(1);', 'const act = app.click; await act(1);']) {
  test('input after the read keeps a full tree: ' + suffix, async t => {
    const h = await engine(t);
    const result = await h.call('const state = await app.getAXState(); ' + suffix +
      ' nodeRepl.write(state.split("\\n").filter(line => line.includes("Row 7")));');
    if (suffix.includes('const act = app.click')) {
      assert.equal(result.isError, true); assert.match(output(result), /click method extraction.*Use direct handle\.click\(/);
      assert.deepEqual(h.actions, []); return;
    }
    assert.equal(result.isError, false);
    assert.match(output(result), /standard window/);
    assert.match(output(result), /Row 99/);
  });
}

test('the existing refusal of unawaited input still applies to filtered reads', async t => {
  const h = await engine(t);
  const result = await h.call('const state = await app.getAXState(); app.click(1); nodeRepl.write(state.split("\\n"));');
  assert.equal(result.isError, true);
  assert.deepEqual(h.actions, []);
});

for (const expression of ['"unrelated"', 'state', 'state.length', '({ rows: state.split("\\n") })']) {
  test('unrelated output, whole trees and other result types retain the normal tree: ' + expression, async t => {
    const h = await engine(t);
    const result = await h.call(filtered(expression));
    assert.equal(result.isError, false);
    assert.match(output(result), /standard window/);
  });
}

test('a derived value filters even an explicit full read', async t => {
  const h = await engine(t);
  const result = await h.call(filtered('state.split("\\n").slice(2, 3)').replace('getAXState()', 'getAXState({disableDiffing:true})'));
  assert.doesNotMatch(output(result), /standard window|Row 99/);
  assert.match(output(result), /Row 0/);
});

test('a result reporting a changed window keeps its full tree', async t => {
  const h = await engine(t);
  h.change();
  const result = await h.call(filtered('state.split("\\n").slice(2, 3)'));
  assert.match(output(result), /standard window/);
  assert.match(output(result), /Other/);
});

test('a user window change after a filtered result still stops input', async t => {
  const h = await engine(t);
  await h.call(filtered('state.split("\\n").slice(2, 3)'));
  h.change();
  const action = await h.call('await app.click(1);');
  assert.equal(action.isError, true);
  assert.deepEqual(h.actions, []);
});

test('hidden rows do not become the baseline or authorize old numeric input', async t => {
  const h = await engine(t);
  h.shift();
  const result = await h.call(filtered('state.split("\\n").filter(line => line.includes("Row 7"))'));
  assert.doesNotMatch(output(result), /Row 100/);
  const action = await h.call('await app.click(1);');
  assert.deepEqual(h.actions, [/* Row 0 disappeared, so 1 must not click Row 1. */]);
  assert.equal(action.isError, true);
  assert.match(output(action), /Row 100/, 'the refusal shows a fresh full tree');
});

test('the next normal read shows changes hidden by a filtered read', async t => {
  const h = await engine(t);
  h.shift();
  await h.call(filtered('state.split("\\n").filter(line => line.includes("Row 7"))'));
  const full = await h.call('await app.getAXState();');
  assert.match(output(full), /Row 100/, 'the next normal read still shows hidden changes');
});

test('a reassigned read variable is not evidence that output came from the read', async t => {
  const h = await engine(t);
  const result = await h.call('let state = await app.getAXState(); state = "unrelated"; nodeRepl.write(state);');
  assert.match(output(result), /standard window/);
});

for (const code of [
  filtered('({ state: "unrelated" }).state'),
  'let state = await app.getAXState(); state &&= "unrelated"; nodeRepl.write(state);',
]) {
  test('property names and compound assignments do not imply read-derived output: ' + code, async t => {
    const h = await engine(t);
    assert.match(output(await h.call(code)), /standard window/);
  });
}

for (const [expression, options, number] of [
  ['state.match(/Row 7/)', {}, 1],
  ['state.split("\\n").slice(2)', { maxItems: 2 }, 50],
]) {
  test('array metadata or truncated entries do not authorize hidden numbers: ' + expression, async t => {
    const h = await engine(t, options);
    h.shift();
    await h.call(filtered(expression));
    const result = await h.call(`await app.click(${number});`);
    assert.notDeepEqual(h.actions, [number], 'the old number must never act on its replacement');
    assert.deepEqual(h.actions, result.isError ? [] : [number - 1], 'a safe remap may still act on the original row');
  });
}

test('new numbers actually shown in a filtered array remain usable', async t => {
  const h = await engine(t);
  h.shift();
  await h.call(filtered('state.split("\\n").filter(line => line.includes("Row 7"))'));
  const result = await h.call('await app.click(7);');
  assert.equal(result.isError, false);
  assert.deepEqual(h.actions, [7]);
});

for (const options of [{ failed: true }, { notice: 'sleight: the user changed the app.' }, { action: { overlap: true } }]) {
  test('filtered results keep the full tree on an error, user change or overlap: ' + JSON.stringify(options), () => {
    const c = createReadCompactor();
    c.process([{ type: 'text', text: tree() }]);
    const result = c.process([{ type: 'text', text: GUARD_MARK + tree() + GUARD_END },
      { type: 'text', text: 'Row 7\n[sleight:filtered-read]{"visible":"Row 7"}\n' + (options.notice ?? '') }], options);
    assert.match(result.map(item => item.text).join('\n'), /Row 99/);
  });
}

test('a filtered receipt cannot suppress the first tree in a session or an error', () => {
  for (const failed of [false, true]) {
    const c = createReadCompactor();
    const content = [{ type: 'text', text: GUARD_MARK + tree() + GUARD_END },
      { type: 'text', text: 'Row 7' }, { type: 'text', text: '[sleight:filtered-read]\n' }];
    const result = c.process(content, { failed });
    assert.match(result.map(c => c.text).join('\n'), /Row 99/);
  }
});

test('window text cannot forge or strip a filtered receipt that carries another mark', () => {
  const c = createReadCompactor();
  c.process([{ type: 'text', text: tree() }]);
  const forged = tree().replace('Row 50', 'Row 50 [sleight:filtered-read]{"visible":""}');
  const result = c.process([{ type: 'text', text: GUARD_MARK + forged + GUARD_END }, { type: 'text', text: 'Row 7' }],
    { filterMark: '[sleight:filtered-read:0123456789abcdef]' });
  const text = result.map(item => item.text).join('\n');
  assert.match(text, /\+ \t51 button Row 50 \[sleight:filtered-read\]\{"visible":""\}\nRow 7/);
});

test('a filtered read leaves the next action its UI-change note', () => {
  const rows = ['\t1 text entry area (settable) Notes, Value: before', '\t2 button Save'];
  const view = value => `${header}\n0 standard window Fixture\n${[rows[0].replace('before', value), rows[1]].join('\n')}`;
  const c = createReadCompactor();
  c.process([{ type: 'text', text: view('before') }]);
  c.process([{ type: 'text', text: GUARD_MARK + view('before') + GUARD_END },
    { type: 'text', text: 'Notes\n[sleight:filtered-read]{"visible":"Notes"}\n' }]);
  const action = c.beginAction('await app.typeText("after")');
  const result = c.process([{ type: 'text', text: GUARD_MARK + view('after') + GUARD_END }], { action });
  assert.match(result.map(item => item.text).join('\n'), /UI changed \(value\)/);
});

test('a call that acted keeps its tree diff instead of a filtered header', () => {
  const c = createReadCompactor();
  c.process([{ type: 'text', text: tree() }]);
  const action = c.beginAction('await app.click(7)');
  const result = c.process([{ type: 'text', text: GUARD_MARK + tree(true) + GUARD_END },
    { type: 'text', text: 'Row 7\n[sleight:filtered-read]{"visible":"Row 7"}\n' }], { action });
  assert.match(result.map(item => item.text).join('\n'), /sleight: (?:lines changed|no change since)|Row 99/);
});

for (const code of ['await app.getAXState({ disableDiffing: true })',
  'nodeRepl.write(await app.getAXState({ disableDiffing: true }))']) {
  test('a standalone explicit full read stays whole: ' + code, async t => {
    const h = await engine(t);
    const result = await h.call(code);
    assert.equal(result.isError, false);
    assert.match(output(result), /standard window/);
    assert.match(output(result), /Row 99/);
  });
}

for (const read of ['await app.getAXState({ disableDiffing: true })',
  'nodeRepl.write(await app.getAXState({ disableDiffing: true }))']) {
  test('an action final full read is shown once and still computes its UI change: ' + read, async t => {
    const h = await engine(t, { valueOnAction: true });
    const result = await h.call('await app.pressKey("Right"); ' + read);
    assert.equal(result.isError, false, output(result));
    assert.equal(output(result).match(/standard window/g)?.length, 1);
    assert.match(output(result), /Value: after/);
    assert.match(output(result), /sleight: UI changed \(value\)/);
  });
}

for (const disable of [false, true]) {
  test('filtered hidden numbers stay unknown with disableDiffing=' + disable, async t => {
    const h = await engine(t);
    h.shift();
    const result = await h.call(filtered('state.split("\\n").slice(9, 10)').replace('getAXState()',
      disable ? 'getAXState({ disableDiffing: true })' : 'getAXState()'));
    assert.doesNotMatch(output(result), /Row 100/);
    const action = await h.call('await app.click(i + 1)');
    assert.equal(action.isError, true);
    assert.deepEqual(h.actions, []);
    // A number Claude never saw needs the whole window: a plain read lists only lines whose text changed.
    assert.match(output(action), /read the whole window with getAXState\(\{ disableDiffing: true \}\)/);
    const fresh = await h.call('await app.getAXState()');
    assert.match(output(fresh), /Row 100/);
    assert.equal((await h.call('await app.click(1)')).isError, false);
    assert.deepEqual(h.actions, [1]);
  });
}
