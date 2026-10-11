import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';

// Dynamic imports keep each missing-feature assertion independent on the old tree.
const load = name => import(`../bench/battery/${name}.mjs`);
function bank(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-battery-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('catalog covers 31 apps with four shared fixture/check kinds', async () => {
  const { tasks, counts } = await load('tasks');
  assert.equal(tasks.length, 31);
  assert.deepEqual(counts(tasks), { 'doc-file': 12, 'self-message': 5, 'web-page': 5, 'app-state': 9 });
  assert.equal(new Set(tasks.map(t => t.bundle)).size, 31);
  for (const task of tasks) {
    assert.equal(task.fixtureKind, task.checkKind);
    assert.equal(typeof task.goal, 'string');
    assert.equal(typeof task.ownerPresent, 'boolean');
    assert.ok(Object.values(task).every(value => typeof value !== 'function'));
  }
});
test('dry plan alternates arm order and shares a marker and prompt for each pair', async () => {
  const { plan } = await load('plan');
  const all = plan({ ownerPresent: true, runs: 2 });
  assert.equal(all.runs.length, 124);
  for (let n = 0; n < all.runs.length; n += 2) {
    const a = all.runs[n], b = all.runs[n + 1];
    assert.equal(a.task, b.task);
    assert.equal(a.marker, b.marker);
    assert.equal(a.prompt, b.prompt);
    assert.deepEqual([a.arm, b.arm], (n / 2) % 2 ? ['codex', 'sleight'] : ['sleight', 'codex']);
  }
  const away = plan();
  assert.ok(away.excluded.every(t => t.reason === 'requires --owner-present'));
  assert.throws(() => plan({ wanted: ['slack'] }), /owner-present/);
  assert.throws(() => plan({ runs: 0 }), /runs/);
  assert.throws(() => plan({ wanted: ['unknown'] }), /unknown/);
});
test('battery dry-run never starts an executable, writes outside stdout, or takes a live lock', t => {
  const dir = bank(t), guard = join(dir, 'guard.cjs');
  writeFileSync(guard, `const cp = require('node:child_process'), fs = require('node:fs');
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name] = () => { throw Error('child forbidden'); };
    for (const name of ['mkdirSync','writeFileSync','appendFileSync','rmdirSync','rmSync','unlinkSync']) fs[name] = () => { throw Error('write forbidden'); };
    const open = fs.openSync; fs.openSync = (path, flags, ...rest) => { if (flags !== 'r') throw Error('write forbidden'); return open(path, flags, ...rest); };
    require('node:module').syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, ['--require', guard, 'bench/run.mjs', '--suite', 'battery', '--dry-run', '--owner-present'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.runs.length, 62);
  assert.deepEqual(out.counts, { 'doc-file': 12, 'self-message': 5, 'web-page': 5, 'app-state': 9 });
});
test('generic document formats roundtrip markers and require a changed saved file for edits', async t => {
  const { writeDocument, readDocument, checkDocument } = await load('documents');
  const dir = bank(t);
  for (const format of ['txt', 'rtf', 'html', 'md', 'docx', 'xlsx', 'pptx', 'pdf']) {
    const path = join(dir, `fixture.${format}`);
    writeDocument(path, format, 'BATTERY-abc123', 'PENDING');
    assert.match(readDocument(path, format), /BATTERY-abc123/);
    const ctx = { path, format, marker: 'BATTERY-abc123', mode: 'edit' };
    assert.notEqual(checkDocument(ctx), true);
    writeDocument(path, format, 'BATTERY-abc123', 'DONE');
    assert.equal(checkDocument(ctx), true);
    writeDocument(path, format, 'BATTERY-wrong', 'DONE');
    assert.notEqual(checkDocument(ctx), true);
  }
});
test('generic checks reject guesses and require structured private answers or fresh engine state', async () => {
  const { checkAnswer, stateReadCode } = await load('fixtures');
  const ctx = { marker: 'BATTERY-abc123' };
  assert.notEqual(checkAnswer('self-message', ctx, 'BATTERY-abc123'), true);
  assert.equal(checkAnswer('self-message', ctx, JSON.stringify({ marker: ctx.marker, sender: 'self', time: '10:12' })), true);
  assert.notEqual(checkAnswer('web-page', ctx, JSON.stringify({ marker: 'wrong' })), true);
  assert.notEqual(checkAnswer('app-state', { ...ctx, state: '' }, JSON.stringify({ marker: ctx.marker })), true);
  assert.equal(checkAnswer('app-state', { ...ctx, state: ctx.marker }, ''), true);
  assert.doesNotMatch(stateReadCode('example.bundle'), /click|pressKey|typeText|setValue|activate/);
});
test('battery approval is suite scoped and account apps require the owner', async () => {
  const { tasks } = await load('tasks');
  for (const task of tasks) {
    const input = JSON.stringify({ mcp_server_name: 'plugin:sleight:computer', message: `Allow Computer Use to use "${task.bundle}"?` });
    const approve = owner => spawnSync(process.execPath, ['bench/approve.mjs'], { cwd: new URL('..', import.meta.url),
      input, encoding: 'utf8', env: { ...process.env, BENCH_SUITE: 'battery', BENCH_OWNER_PRESENT: owner ? '1' : '' } });
    assert.equal(JSON.parse(approve(true).stdout).hookSpecificOutput.action, 'accept', task.app);
    if (task.ownerPresent) assert.equal(approve(false).stdout, '', task.app);
  }
});
test('call metrics classify waste without publishing code, answers, paths, or transcript text', async () => {
  const { callMetrics, publicResult } = await load('metrics');
  const rows = [
    { type: 'user', timestamp: '2026-10-11T00:00:00Z', message: { content: 'private task' } },
    { type: 'assistant', timestamp: '2026-10-11T00:00:01Z', message: { content: [{ type: 'tool_use', id: '1', name: 'js', input: { code: 'await cua.getState()' } }] } },
    { type: 'user', timestamp: '2026-10-11T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: '1', content: 'private response' }] } },
    { type: 'assistant', timestamp: '2026-10-11T00:00:03Z', message: { content: [{ type: 'tool_use', id: '2', name: 'js', input: { code: 'await cua.getApp("private app")' } }] } },
  ];
  const metrics = callMetrics(rows);
  assert.ok(metrics.calls[0].classes.includes('preliminary-inventory'));
  const result = publicResult({ arm: 'sleight', task: 'textedit', run: 1, passed: false, seconds: 2,
    out: { result: 'private response' }, stderr: '/Users/owner/private', prompt: 'private task', ...metrics });
  assert.doesNotMatch(JSON.stringify(result), /private|Users|code|prompt|out"|stderr/);
  assert.equal(result.calls.length, 2);
});

test('paired lifecycle resets the fixture, publishes failures, and stops on unconfirmed cleanup', async () => {
  const { executePlan } = await load('run');
  const { plan } = await load('plan');
  const calls = [], published = [];
  const runtime = {
    async setupPair() { return { target: '/private/tmp/fixture.txt', marker: 'BATTERY-test' }; },
    async resetFixture() { calls.push('reset'); },
    async startHost() { calls.push('host'); return { async finish() { return { confirmed: true, samples: [] }; } }; },
    async drive(arm, prompt) { calls.push([arm, prompt]); return { code: 0, groupClean: true, answer: 'private', calls: [] }; },
    async check() { return 'WRONG_MARKER'; },
    publish(rows) { published.push(structuredClone(rows)); },
    async closePair() { calls.push('close'); },
  };
  const p = plan({ wanted: ['textedit', 'word'] });
  const results = await executePlan(p, runtime);
  assert.deepEqual(calls.filter(Array.isArray).map(c => c[0]), ['sleight', 'codex', 'codex', 'sleight']);
  assert.equal(calls.filter(Array.isArray)[0][1], calls.filter(Array.isArray)[1][1]);
  assert.equal(results.length, 4);
  assert.ok(results.every(r => r.passed === false));
  assert.equal(published.at(-1).length, 4);
  calls.length = 0;
  runtime.startHost = async () => ({ async finish() { return { confirmed: false, samples: [] }; } });
  await assert.rejects(executePlan(p, runtime), /CLEANUP_UNCONFIRMED/);
  assert.equal(calls.filter(Array.isArray).length, 1);
});

test('host observer emits metadata on stdout and pumps NSWorkspace through the run loop', () => {
  const stdout = [], stderr = [], waits = [];
  const native = value => value;
  const empty = { count: 0 };
  native.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => empty };
  native.NSWorkspace = { sharedWorkspace: { frontmostApplication: { bundleIdentifier: 'org.example.owner-app' } } };
  native.CGWindowListCopyWindowInfo = () => empty;
  native.NSRunLoop = { currentRunLoop: { runUntilDate: date => waits.push(date) } };
  native.NSDate = { dateWithTimeIntervalSinceNow: seconds => seconds };
  native.NSString = { stringWithContentsOfFileEncodingError: () => '{"command":"abort"}' };
  native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: data => stdout.push(data) } };
  // Model NSString.dataUsingEncoding without loading AppKit.
  const dollar = value => typeof value === 'string' ? { dataUsingEncoding: () => value } : value;
  Object.assign(dollar, native);
  const ObjC = { import() {}, unwrap: value => value, castRefToObject: value => value, deepUnwrap: value => value };
  const source = readFileSync(new URL('../bench/battery/host.js', import.meta.url), 'utf8');
  runInNewContext(`${source}\nrun(['{"bundle":"org.example.fixture","control":"ignored"}']);`, {
    $: dollar, ObjC, console: { log: value => stderr.push(value) }, Ref: () => [], Date,
  });
  assert.ok(stdout.length >= 3, 'metadata must reach the owned runner stdout callback');
  assert.equal(stderr.length, 0);
  assert.equal(JSON.parse(stdout[0]).sample.front, 'org.example.owner-app');
  assert.match(source, /NSRunLoop\.currentRunLoop\.runUntilDate/);
  assert.doesNotMatch(source, /delay\(|kCGWindowName|localizedName/);
});

test('app scripting is a generic descriptor and requires an explicitly local fixture container', async () => {
  const { stateSetupRequest } = await load('scripting');
  const { tasks } = await load('tasks');
  for (const id of ['notes', 'reminders', 'calendar']) {
    const task = tasks.find(t => t.id === id);
    assert.throws(() => stateSetupRequest(task, 'BATTERY-test', { id: 'private-id' }), /local fixture/);
    const request = stateSetupRequest(task, 'BATTERY-test', { id: 'fixture-id', local: true });
    assert.equal(request.bundle, task.bundle);
    assert.equal(request.containerID, 'fixture-id');
    assert.equal(request.marker, 'BATTERY-test');
    assert.ok(request.descriptor.items && request.descriptor.constructor);
  }
});

test('stream collector keeps fragmented preflight catalogs and Codex call code in memory only', async () => {
  const { streamMetrics } = await load('metrics');
  const claude = streamMetrics('sleight');
  const catalog = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'plugin:sleight:computer', status: 'connected' }] }) + '\n';
  claude.receive(catalog.slice(0, 12)); claude.receive(catalog.slice(12));
  assert.equal(claude.finish().catalog.mcp_servers[0].status, 'connected');
  const codex = streamMetrics('codex');
  codex.receive(JSON.stringify({ type: 'item.started', item: { id: '1', type: 'mcp_tool_call', tool: 'js' } }) + '\n');
  codex.receive(JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'mcp_tool_call', tool: 'js', arguments: { code: 'await new Promise(r => setTimeout(r, 10))' }, result: { content: [] } } }) + '\n');
  assert.ok(codex.finish().calls[0].classes.includes('explicit-delay'));
  assert.doesNotMatch(JSON.stringify(codex.finish().calls), /setTimeout/);
});

test('OOXML readback joins styled runs instead of breaking a saved marker', async t => {
  const { writeDocument, readDocument } = await load('documents');
  const dir = bank(t), path = join(dir, 'fixture.docx');
  writeDocument(path, 'docx', 'BATTERY-abc123', 'DONE');
  assert.equal(spawnSync('/usr/bin/unzip', ['-q', path], { cwd: dir }).status, 0);
  const xmlPath = join(dir, 'word/document.xml');
  writeFileSync(xmlPath, readFileSync(xmlPath, 'utf8').replace('BATTERY-abc123', 'BATTERY-</w:t></w:r><w:r><w:t>abc123'));
  assert.equal(spawnSync('/usr/bin/zip', ['-q', path, 'word/document.xml'], { cwd: dir }).status, 0);
  assert.match(readDocument(path, 'docx'), /BATTERY-abc123 DONE/);
});

test('presentation fixtures include the layout, master and theme relationships used by readers', async t => {
  const { writeDocument } = await load('documents');
  const path = join(bank(t), 'fixture.pptx');
  writeDocument(path, 'pptx', 'BATTERY-abc123');
  const part = name => spawnSync('/usr/bin/unzip', ['-p', path, name], { encoding: 'utf8' }).stdout;
  assert.match(part('ppt/slides/_rels/slide1.xml.rels'), /slideLayout/);
  assert.match(part('ppt/slideLayouts/_rels/slideLayout1.xml.rels'), /slideMaster/);
  assert.match(part('ppt/slideMasters/_rels/slideMaster1.xml.rels'), /theme/);
});

const fixturePath = '/private/tmp/sleight-battery-unit/pair/fixture.txt';
// Execute the real host against native API doubles. No app, engine or live lock is used.
function cleanupHost(options = {}) {
  const events = [], presses = [], scripts = [];
  let command = '', now = 0, opened = false, present = true, terminations = 0;
  const path = options.path ?? fixturePath, expected = pathToFileURL(path).href;
  const window = {}, secondWindow = {}, foreignWindow = {}, close = {}, appElement = {};
  const list = values => ({ count: values.length, objectAtIndex: n => values[n] });
  const app = { processIdentifier: 42, bundleIdentifier: 'org.example.fixture', isFinishedLaunching: true, terminated: false,
    get terminate() { terminations++; if (!options.stuckApp) this.terminated = true; return !options.stuckApp; } };
  const dollar = value => typeof value === 'string' ? { value, toString: () => value, dataUsingEncoding: () => value } : value;
  Object.assign(dollar, {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list(opened || options.wasRunning ? [app] : []),
      runningApplicationWithProcessIdentifier: () => app },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { bundleIdentifier: 'org.example.owner' } } },
    CGWindowListCopyWindowInfo: () => list([]),
    NSRunLoop: { currentRunLoop: { runUntilDate() { now += 200; } } },
    NSDate: { dateWithTimeIntervalSinceNow: seconds => seconds },
    NSString: { stringWithContentsOfFileEncodingError: () => JSON.stringify({ command }) },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData(data) {
      const event = JSON.parse(data); events.push(event);
      if (event.stage === 'armed') { opened = true; command = 'launched'; }
      if (event.stage === 'ready') command = 'finish';
    } } },
    NSURL: { fileURLWithPath: value => ({ absoluteString: pathToFileURL(String(value)).href }) },
    AXUIElementCreateApplication: () => appElement,
    AXUIElementCopyAttributeValue(element, name, out) {
      name = String(name);
      if (element === appElement && name === 'AXWindows') {
        if (options.windowReadFailure && now >= 10000) return -25204;
        const foreign = (options.extraWindowAfterPress && presses.length) || (options.transientWindow && now >= 400 && now < 5000);
        out[0] = list([...(opened && present ? options.multipleWindows ? [window, secondWindow] : [window] : []), ...(foreign ? [foreignWindow] : [])]); return 0;
      }
      if (element === foreignWindow && name === 'AXDocument') { out[0] = 'file:///private/tmp/another.txt'; return 0; }
      if (element === secondWindow && !present) return -25202;
      if (element !== window && element !== secondWindow) return -25205;
      if (name === 'AXDocument') {
        if (options.documentMissing) return -25205;
        if (options.changedDocumentCloses && now >= 10000) present = false;
        out[0] = options.changedDocument && now >= 10000 ? options.changedDocument : options.document ?? expected; return 0;
      }
      if (name === 'AXCloseButton' && !options.closeMissing) { out[0] = close; return 0; }
      if (name === 'AXSheets') { out[0] = list(options.sheet || (options.lateSheet && now >= 10000) ? [{}] : []); return 0; }
      return -25205;
    },
    AXUIElementPerformAction(element, action) {
      assert.equal(element, close); assert.equal(String(action), 'AXPress'); presses.push(now);
      if (options.axCloses) present = false;
      return options.pressStatus ?? 0;
    },
    CFEqual: (a, b) => a === b,
    NSAppleScript: { alloc: { initWithSource(source) { scripts.push({ source: String(source), atMs: now });
      return { executeAndReturnError(error) {
        if (options.scriptError) { error[0] = { NSAppleScriptErrorNumber: options.scriptError }; return null; }
        if (!options.scriptStuck) present = false;
        return {};
      } };
    } } },
  });
  const ObjC = { import() {}, unwrap: value => value?.value ?? value, castRefToObject: value => value, deepUnwrap: value => value };
  const request = { bundle: 'org.example.fixture', targetURL: expected, control: 'ignored', fixturePath: path,
    fixtureRoot: '/private/tmp/sleight-battery-unit/pair' };
  const source = readFileSync(new URL('../bench/battery/host.js', import.meta.url), 'utf8');
  runInNewContext(`${source}\nrun([request]);`, { $: dollar, ObjC, Ref: () => [], Date: { now: () => now }, request: JSON.stringify(request) });
  return { ...events.findLast(e => e.stage === 'cleanup'), presses, scripts, terminations, present };
}

function cleanupRuntime(options = {}) {
  const published = [], cleanups = [];
  return { published, cleanups,
    async setupPair() { return { target: fixturePath }; }, async resetFixture() {},
    async startHost() { return { async finish() {
      const result = cleanupHost(options); cleanups.push(result); return result;
    } }; },
    async drive() { return { code: 0, groupClean: true, answer: '', calls: [] }; },
    async check() { assert.equal(cleanups.length, published.length, 'check must precede this run cleanup'); return true; },
    publish(rows) { published.push(structuredClone(rows)); }, async closePair() {},
  };
}

test('a passed check survives failed cleanup and publishes each retained window reason before stopping', async () => {
  const { executePlan } = await load('run'), { plan } = await load('plan');
  const runtime = cleanupRuntime({ document: 'file:///private/tmp/another.txt' });
  await assert.rejects(executePlan(plan({ wanted: ['textedit'] }), runtime), /CLEANUP_UNCONFIRMED/);
  const row = runtime.published.at(-1)[0];
  assert.equal(row.passed, true);
  assert.equal(row.checkCode, 'PASS');
  assert.equal(row.cleanupConfirmed, false);
  assert.equal(runtime.published.length, 1);
  assert.deepEqual(runtime.cleanups[0].presses, []);
  assert.deepEqual(runtime.cleanups[0].scripts, []);
  assert.equal(runtime.cleanups[0].terminations, 0);
  assert.equal(row.cleanupDetails.windows[0].document, 'file:///private/tmp/another.txt');
  assert.equal(row.cleanupDetails.windows[0].expectedURL, 'file:///private/tmp/sleight-battery-unit/pair/fixture.txt');
  assert.ok(row.cleanupDetails.windows[0].reasons.includes('DOCUMENT_NOT_MATCHED'));
});

test('a stuck owned fixture closes through bundle scripting and the paired pass continues', async () => {
  const { executePlan } = await load('run'), { plan } = await load('plan');
  const runtime = cleanupRuntime();
  const rows = await executePlan(plan({ wanted: ['textedit'] }), runtime);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.passed && row.cleanupConfirmed && row.checkCode === 'PASS'));
  for (const cleanup of runtime.cleanups) {
    assert.equal(cleanup.scripts.length, 1);
    assert.ok(cleanup.scripts[0].atMs >= 10000);
    assert.match(cleanup.scripts[0].source, /tell application id "org.example.fixture"/);
    assert.match(cleanup.scripts[0].source, /close \(documents whose path is "\/private\/tmp\/sleight-battery-unit\/pair\/fixture.txt"\) saving no/);
    assert.equal(cleanup.terminations, 1);
  }
  assert.equal(rows[0].cleanupDetails.windows[0].scriptingPath, fixturePath);
  assert.equal(rows[0].cleanupDetails.windows[0].axPressStatus, 0);
  assert.ok(rows[0].cleanupDetails.windows[0].reasons.includes('WINDOW_STILL_PRESENT_AFTER_10S'));
});

for (const [name, options, reason] of [
  ['missing close button', { closeMissing: true, scriptError: -1708 }, 'CLOSE_BUTTON_MISSING'],
  ['failed AXPress', { pressStatus: -25204, scriptError: -1708 }, 'AXPRESS_FAILED'],
  ['stuck close button', { scriptError: -1708 }, 'WINDOW_STILL_PRESENT_AFTER_10S'],
  ['sheet before close', { sheet: true }, 'SHEET_PRESENT'],
  ['sheet after close', { lateSheet: true }, 'SHEET_PRESENT'],
  ['absent document', { documentMissing: true }, 'DOCUMENT_NOT_MATCHED'],
  ['changed document after close', { changedDocument: 'file:///private/tmp/another.txt' }, 'DOCUMENT_NOT_MATCHED'],
  ['external file', { path: '/Users/example/private.txt' }, 'SCRIPTING_NOT_OWN_FIXTURE'],
  ['unsupported scripting', { scriptError: -1708 }, 'SCRIPTING_FAILED'],
  ['scripting leaves window', { scriptStuck: true }, 'WINDOW_STILL_PRESENT_AFTER_SCRIPTING'],
]) test(`cleanup records ${name} and retains the stop`, () => {
  const result = cleanupHost(options);
  assert.equal(result.confirmed, false);
  assert.ok(result.details?.windows[0].reasons.includes(reason), JSON.stringify(result.details));
  if (options.pressStatus) assert.equal(result.details.windows[0].axPressStatus, -25204);
  if (options.scriptError) assert.equal(result.details.windows[0].scriptingStatus, -1708);
  if (options.documentMissing) assert.equal(result.details.windows[0].documentStatus, -25205);
  if (!options.scriptError && !options.scriptStuck) assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
});

test('cleanup reports a launched app that does not terminate', () => {
  const result = cleanupHost({ axCloses: true, stuckApp: true });
  assert.equal(result.confirmed, false);
  assert.ok(result.details?.reasons.includes('APP_NOT_TERMINATED'));
  assert.equal(result.details.app.terminated, false);
});

test('a failed window read cannot confirm closure or allow app termination', () => {
  const result = cleanupHost({ windowReadFailure: true });
  assert.equal(result.confirmed, false);
  assert.ok(result.details?.reasons.includes('WINDOWS_READ_FAILED'));
  assert.equal(result.terminations, 0);
  assert.equal(result.scripts.length, 0);
});

test('an unrelated window arriving during cleanup is retained untouched and stops an already running app pass', () => {
  const result = cleanupHost({ wasRunning: true, axCloses: true, extraWindowAfterPress: true });
  assert.equal(result.confirmed, false);
  assert.equal(result.presses.length, 1);
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
  assert.equal(result.details.windows[1].document, 'file:///private/tmp/another.txt');
  assert.ok(result.details.windows[1].reasons.includes('WINDOW_NOT_RETAINED'));
});

test('a changed document still stops cleanup when its window disappears after revalidation', () => {
  const result = cleanupHost({ changedDocument: 'file:///private/tmp/another.txt', changedDocumentCloses: true });
  assert.equal(result.confirmed, false);
  assert.ok(result.details.windows[0].reasons.includes('DOCUMENT_NOT_MATCHED'));
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
});

test('an unrelated window observed only during close polling latches the stop after it disappears', () => {
  const result = cleanupHost({ transientWindow: true });
  assert.equal(result.confirmed, false);
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
  assert.equal(result.details.windows[1].document, 'file:///private/tmp/another.txt');
  assert.ok(result.details.windows[1].reasons.includes('WINDOW_NOT_RETAINED'));
});

test('one fixture script can close two retained windows without reading a stale second reference', () => {
  const result = cleanupHost({ multipleWindows: true });
  assert.equal(result.confirmed, true);
  assert.equal(result.scripts.length, 1);
  assert.equal(result.terminations, 1);
  assert.equal(result.details.windows.length, 2);
  assert.ok(result.details.windows.every(row => !row.present && !row.reasons.includes('DOCUMENT_NOT_MATCHED')));
});

test('owned host collects fragmented cleanup diagnostics and only grants scripting for its temp document', async t => {
  const { startHost } = await load('runtime');
  assert.equal(typeof startHost, 'function');
  const dir = mkdtempSync('/private/tmp/sleight-battery-test-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.txt'); writeFileSync(path, 'BATTERY-test');
  for (const own of [true, false]) {
    let request, receive, complete;
    const runProcess = (executable, args, options) => {
      if (executable === '/usr/bin/open') return Promise.resolve({ exit: { code: 0 }, groupClean: true });
      assert.equal(executable, '/usr/bin/osascript');
      request = JSON.parse(args.at(-1)); receive = options.onStdout;
      const response = Promise.withResolvers(); complete = response.resolve;
      receive('{"stage":"armed","wasRunning":false}\n{"stage":"ready"}\n');
      return response.promise;
    };
    const host = await startHost({ bundle: 'org.example.fixture', fixtureKind: 'doc-file' },
      { dir, path, target: own ? path : '/private/tmp/other.txt' }, new AbortController().signal, runProcess);
    assert.equal(request.fixturePath, own ? path : undefined);
    if (own) assert.equal(request.fixtureRoot, dir);
    const event = JSON.stringify({ stage: 'cleanup', confirmed: false, details: { reasons: [], windows: [
      { document: `file://${homedir()}/other.txt`, expectedURL: pathToFileURL(path).href,
        reasons: ['DOCUMENT_NOT_MATCHED'], scriptingPath: path },
    ] } }) + '\n';
    receive(event.slice(0, 50)); receive(event.slice(50));
    complete({ exit: { code: 0 }, groupClean: true });
    const cleanup = await host.finish();
    assert.equal(cleanup.confirmed, false);
    assert.equal(cleanup.details.windows[0].document, 'file://~/other.txt');
    assert.equal(cleanup.details.windows[0].scriptingPath, path);
  }
});
