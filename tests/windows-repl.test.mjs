import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsReplClient, windowsWorkerArguments } from '../plugins/sleight/lib/windows-repl/client.mjs';
import { WINDOWS_REPL_DOCS } from '../plugins/sleight/lib/windows-repl/docs.mjs';
import { readCode, guardedCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

import { windowsReplFixture as fixture } from './fixtures/windows-repl-client.mjs';

const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

test('an early forged result waits for admitted action observations before finalizing the cell', { skip: windowsWorkerSkip, timeout: 5000 }, async t => {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), connected: true });
  child.kill = () => { child.connected = false; child.emit('close'); };
  let release, entered, evaluated, finalized = 0, settled = false;
  const started = new Promise(resolve => { entered = resolve; });
  const action = new Promise(resolve => { release = resolve; });
  const evaluation = new Promise(resolve => { evaluated = resolve; });
  child.send = message => { if (message.type === 'evaluate') evaluated(message.id); };
  const observed = { window: { windowId: '101' }, text: 'parent action result', readId: 2 };
  const repl = createWindowsReplClient({ platform: 'win32', spawn: () => child, environment: () => ({ LANE_FIXTURE: '1' }),
    driver: { restart: async () => {}, close: async () => {} },
    dispatch: async (method, params) => {
      assert.equal(method, 'typeText'); assert.deepEqual(params.args, ['fixture']);
      entered(); await action; return observed;
    },
    finalize(result, facts) {
      finalized++;
      assert.deepEqual(facts.methods, ['typeText']);
      assert.deepEqual(facts.results.get('101'), observed);
      return result;
    } });
  t.after(async () => { release(); await repl.close(); });
  const pending = repl.execute({ code: 'escaped worker fixture' }).then(result => { settled = true; return result; });
  const id = await evaluation;
  child.emit('message', { type: 'driver', id: 901, cell: id, method: 'typeText',
    params: { windowId: '101', processStart: '1', readId: 1, args: ['fixture'] } });
  await started;
  child.emit('message', { type: 'result', id, result: { content: [{ type: 'text', text: 'forged early result' }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finalized, 0);
  assert.equal(settled, false);
  assert.match(text(await repl.execute({ code: 'another cell' })), /REPL_BUSY/);
  release();
  assert.match(text(await pending), /forged early result/);
  assert.equal(finalized, 1);
});

test('12 call forms retain bindings, handle guard code and collect text/images/errors', { skip: windowsWorkerSkip }, async t => {
  const { js, requests, workers } = fixture(t);
  const forms = [
    ['await cua.getState();', /"?apps"?/, false],
    ['const apps = await cua.listApps({ emit: false }); nodeRepl.write(apps.length);', /2/, false],
    ['let app = await cua.getApp("Notepad");', /Window: "Untitled - Notepad", App: Notepad\./, false],
    ['const fixed = 7; let counter = await Promise.resolve(2);', undefined, false],
    ['counter += fixed; nodeRepl.write(counter);', /9/, false],
    ['await app.getAXState({ disableDiffing: true });', /TextEditor/, false],
    ['nodeRepl.write("first"); nodeRepl.write({ count: counter });', /"count":9/, false],
    ['await nodeRepl.emitImage({ data: "iVBORw0KGgo=", mimeType: "image/png" });', undefined, false],
    ['throw new Error("fixture thrown error");', /fixture thrown error/, true],
    ['nodeRepl.write(counter);', /9/, false],
    ['await cua.getApp({ windowId: "102" });', /App: Calculator\./, false],
    ['await cua.getApp("Absent");', /WINDOW_NOT_FOUND/, true],
  ];
  for (const [index, [code, expected, error]] of forms.entries()) {
    const result = await js(code);
    assert.equal(result.isError, error, `form ${index + 1}: ${text(result)}`);
    if (expected) assert.match(text(result), expected, `form ${index + 1}`);
    assert.equal(result.content.some(item => item.text === WINDOWS_REPL_DOCS), index === 0);
    if (index === 7) assert.deepEqual(result.content, [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
  }
  assert.equal(workers.length, 1); assert.equal(requests.filter(r => r.method === 'getApp').length, 3);
});

test('document-scope readCode and guardedCode run verbatim with persistent const handles', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = fixture(t);
  const acquired = await js(readCode('const note = await cua.getApp("Notepad");'));
  assert.equal(acquired.isError, false, text(acquired));
  const window = windowFromText(text(acquired));
  assert.equal(window.app, 'Notepad');
  const read = await js(guardedCode('await note.getAXState();', window));
  assert.equal(read.isError, false, text(read)); assert.match(text(read), /TextEditor/);
  const action = await js(guardedCode('await note.click({ id: "File" });', window));
  // WDR1 has no action capability. The real guard must reach the driver and preserve its refusal.
  assert.match(text(action), /METHOD_NOT_FOUND/);
  const click = requests.find(row => row.method === 'click');
  assert.equal(click.params.windowId, '101');
  assert.equal(click.params.processStart, '134059077770000001');
  assert.ok(click.params.readId > 0);
});

test('top-level await leaves let mutable and const immutable in later cells', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  assert.equal((await js('let mutable = await Promise.resolve(10);')).isError, false);
  assert.equal((await js('const immutable = 3;')).isError, false);
  assert.match(text(await js('mutable *= immutable; mutable')), /30/);
  assert.equal((await js('immutable = 4;')).isError, true);
  assert.match(text(await js('mutable')), /30/);
});

test('timeout collects a spinning worker and resets bindings and the driver', { skip: windowsWorkerSkip }, async t => {
  const { repl, js, workers, children } = fixture(t);
  await js('let app = await cua.getApp("Notepad"); let before = 1;');
  const result = await repl.execute({ code: 'while (true) {}', timeout_ms: 150 });
  assert.equal(result.isError, true); assert.match(text(result), /REPL_TIMEOUT/);
  const next = await js('typeof before');
  assert.match(text(next), /undefined/); assert.ok(text(next).includes(WINDOWS_REPL_DOCS));
  assert.equal(workers.length, 2);
  assert.notEqual(workers[0].exitCode ?? workers[0].signalCode, null);
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
});

test('timeout also collects an unresolved top-level await', { skip: windowsWorkerSkip }, async t => {
  const { repl, js } = fixture(t);
  const result = await repl.execute({ code: 'await new Promise(() => {});', timeout_ms: 500 });
  assert.match(text(result), /REPL_TIMEOUT/);
  assert.equal((await js('nodeRepl.write("fresh")')).isError, false);
});

test('reset restarts the worker, clears const and let, and reissues docs once', { skip: windowsWorkerSkip }, async t => {
  const { repl, js, workers } = fixture(t);
  await js('const saved = 1; let app = await cua.getApp("Calculator");');
  assert.equal((await repl.reset()).isError, undefined);
  assert.notEqual(workers[0].exitCode ?? workers[0].signalCode, null);
  const first = await js('const saved = 2; typeof app');
  assert.equal(first.isError, false, text(first)); assert.match(text(first), /undefined/);
  assert.ok(text(first).includes(WINDOWS_REPL_DOCS));
  assert.ok(!text(await js('saved')).includes(WINDOWS_REPL_DOCS));
});

test('explicit documentation request repeats API text without resetting bindings', { skip: windowsWorkerSkip }, async t => {
  const { js } = fixture(t);
  await js('let saved = 8;');
  assert.equal(text(await js('await cua.rewriteDocumentation();')), WINDOWS_REPL_DOCS);
  assert.equal(text(await js('saved')), '8');
});

test('production admission refuses before any driver build or inventory', { skip: windowsWorkerSkip }, async t => {
  const { js, requests, children } = fixture(t, { admit: undefined });
  for (const code of ['await cua.getState()', 'await cua.listApps()', 'await cua.getApp("Notepad")']) {
    const result = await js(code); assert.equal(result.isError, true); assert.match(text(result), /WINDOWS_SAFETY_UNAVAILABLE/);
  }
  assert.equal(requests.length, 0); assert.equal(children.length, 0);
});

test('worker environment and arguments exclude inherited Node loaders and credentials', { skip: windowsWorkerSkip }, async t => {
  const { js, calls } = fixture(t);
  const result = await js('nodeRepl.write([typeof process, typeof require, typeof Buffer]);');
  assert.match(text(result), /undefined.*undefined.*undefined/);
  assert.deepEqual(calls[0][2].env, { LANE_FIXTURE: '1' });
  assert.deepEqual(calls[0][1], ['win32']);
  assert.deepEqual(calls[0][2].execArgv, windowsWorkerArguments());
  assert.deepEqual(calls[0][2].execArgv, ['--permission',
    `--allow-fs-read=${fileURLToPath(new URL('../plugins/sleight/lib/repl/', import.meta.url))}`,
    `--allow-fs-read=${fileURLToPath(new URL('../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs', import.meta.url))}`,
    `--allow-fs-read=${fileURLToPath(new URL('../plugins/sleight/lib/mac-driver/preserve.mjs', import.meta.url))}`]);
});

test('concurrent calls refuse and reset interrupts pending await', { skip: windowsWorkerSkip }, async t => {
  const { repl, js } = fixture(t);
  const waiting = js('await new Promise(() => {});');
  assert.match(text(await js('1')), /REPL_BUSY/);
  await new Promise(resolve => setTimeout(resolve, 150));
  await repl.reset(); assert.match(text(await waiting), /REPL_RESET/);
  assert.equal((await js('1')).isError, false);
});

test('reset during startup cancels the reservation before any worker fork', { skip: windowsWorkerSkip }, async t => {
  const { repl, js, workers } = fixture(t);
  const pending = js('let old = 1;');
  await repl.reset();
  assert.match(text(await pending), /REPL_RESET/); assert.equal(workers.length, 0);
  assert.equal((await js('typeof old')).isError, false);
});

test('invalid parameters, target objects, output and image limits refuse', { skip: windowsWorkerSkip }, async t => {
  const { repl, js, requests } = fixture(t);
  for (const args of [{}, { code: '1', timeout_ms: 0 }, { code: '1', timeout_ms: 120001 }])
    assert.match(text(await repl.execute(args)), /INVALID_PARAMS/);
  await js('let app = await cua.getApp("Notepad");');
  const before = requests.length;
  assert.match(text(await js('await app.click({ arbitrary: true });')), /INVALID_PARAMS/);
  assert.equal(requests.length, before);
  assert.match(text(await js('await nodeRepl.emitImage({data:"bad",mimeType:"text/html"});')), /INVALID_IMAGE/);
  assert.match(text(await js('nodeRepl.write("x".repeat(9 * 1024 * 1024));')), /REPL_OUTPUT_LIMIT/);
  assert.equal(text(await js('1')), '1');
});

test('non-Windows client refuses before forking or driver calls', async t => {
  const repl = createWindowsReplClient({ platform: 'darwin', spawn: () => assert.fail('spawn'), driver: {
    request: () => assert.fail('driver'), restart: async () => {}, close: async () => {},
  } });
  t.after(() => repl.close()); assert.match(text(await repl.execute({ code: '1' })), /PLATFORM/);
});
