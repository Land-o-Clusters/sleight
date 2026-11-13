// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import test from './macos-only.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { getEventListeners } from 'node:events';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { packageSkip } from './requirements.mjs';

// Dynamic imports keep each missing-feature assertion independent on the old tree.
const load = name => import(`../bench/battery/${name}.mjs`);
function bank(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-battery-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('catalog covers 31 apps and 4 ZCode flows with five shared fixture/check kinds', async () => {
  const { tasks, counts } = await load('tasks');
  assert.equal(tasks.length, 35);
  assert.deepEqual(counts(tasks), { 'doc-file': 12, 'self-message': 5, 'web-page': 5, 'app-state': 9, 'app-flow': 4 });
  assert.equal(new Set(tasks.map(t => t.bundle)).size, 32);
  assert.equal(new Set(tasks.map(t => t.id)).size, 35);
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
  assert.equal(all.runs.length, 140);
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
test('battery dry-run never starts an executable, writes outside stdout, or takes a live lock', { skip: packageSkip('typescript') }, t => {
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
  assert.equal(out.runs.length, 70);
  assert.deepEqual(out.counts, { 'doc-file': 12, 'self-message': 5, 'web-page': 5, 'app-state': 9, 'app-flow': 4 });
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
  const flow = { ...ctx, expect: ['scrap $marker'] };
  assert.equal(checkAnswer('app-flow', { ...flow, state: 'row scrap BATTERY-abc123 now' }, ''), true);
  assert.notEqual(checkAnswer('app-flow', { ...flow, state: 'row BATTERY-abc123 now' }, ''), true, 'the marker alone is not the rename');
  assert.notEqual(checkAnswer('app-flow', { ...ctx, expect: [], state: ctx.marker }, ''), true, 'a flow needs expectations');
});
test('ZCode flow prompts allow only their own message and keep other tasks off limits', async () => {
  const { tasks } = await load('tasks'), { promptFor, plan } = await load('plan');
  const flows = tasks.filter(t => t.fixtureKind === 'app-flow');
  assert.deepEqual(flows.map(t => t.id), ['zcode-send', 'zcode-rename', 'zcode-pin', 'zcode-sidebar']);
  for (const task of flows) {
    assert.equal(task.bundle, 'dev.zcode.app');
    assert.equal(task.ownerPresent, false);
    const prompt = promptFor(task, { marker: 'BATTERY-abc123' });
    assert.match(prompt, /sleight-scrap/);
    assert.match(prompt, /send exactly: Reply with the single word ok\. BATTERY-abc123/);
    assert.match(prompt, /Send only the message the steps give/);
    assert.match(prompt, /other tasks belong to running agents/);
    assert.doesNotMatch(prompt, /Never send/);
    assert.doesNotMatch(prompt, /\$marker/);
  }
  assert.deepEqual(plan({ wanted: ['zcode-send'] }).setupOnce.length, 1);
  assert.deepEqual(plan({ wanted: ['calculator'] }).setupOnce, []);
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
    out: { result: 'private response' }, stderr: `${MAC_USERS}owner/private`, prompt: 'private task', ...metrics });
  assert.doesNotMatch(JSON.stringify(result), /private|Users|code|prompt|out"|stderr/);
  assert.equal(result.calls.length, 2);
});

test('paired lifecycle resets the fixture, publishes failures, and stops on unconfirmed cleanup', async () => {
  const { executePlan } = await load('run');
  const { plan } = await load('plan');
  const calls = [], published = [];
  const runtime = {
    async setupPair() { return { target: `${MAC_TMP}/fixture.txt`, marker: 'BATTERY-test' }; },
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

const fixturePath = `${MAC_TMP}/sleight-battery-unit/pair/fixture.txt`;
// Execute the real host against native API doubles. No app, engine or live lock is used.
function cleanupHost(options = {}) {
  const events = [], presses = [], scripts = [];
  let command = '', now = 0, opened = false, present = true, terminations = 0, windowReads = 0, foreignGone = false, earlyWindowReads = 0;
  let nextTerminations = 0; const psCalls = [];
  const path = options.path ?? fixturePath, expected = pathToFileURL(path).href;
  const window = {}, secondWindow = {}, foreignWindow = {}, close = {}, appElement = {}, nextElement = {}, extraWindow = {};
  const list = values => ({ count: values.length, objectAtIndex: n => values[n] });
  const app = { processIdentifier: 42, bundleIdentifier: 'org.example.fixture', terminated: false,
    launchDate: { timeIntervalSince1970: (options.wasRunning ? -60 : 0) },
    get isFinishedLaunching() { return options.finishLaunchingAt === undefined || now >= options.finishLaunchingAt; },
    get terminate() { terminations++; if (!options.stuckApp) this.terminated = true; return !options.stuckApp; } };
  // A second instance of the same bundle: the launched process relaunched itself (relaunchAt).
  const next = { processIdentifier: 43, bundleIdentifier: 'org.example.fixture', terminated: false,
    get launchDate() { return { timeIntervalSince1970: (options.nextLaunchedAt ?? options.relaunchAt ?? options.nextAt ?? 0) / 1000 }; },
    get isFinishedLaunching() { return !options.nextNeverFinishes; },
    get terminate() { nextTerminations++; this.terminated = true; return true; } };
  const ended = () => options.exitAt !== undefined && now >= options.exitAt || options.relaunchAt !== undefined && now >= options.relaunchAt;
  function instances() {
    if (!(opened || options.wasRunning)) return [];
    if (ended()) app.terminated = true;
    const live = [...(!app.terminated || options.listsTerminated ? [app] : []),
      ...((options.relaunchAt !== undefined && now >= options.relaunchAt || options.nextAt !== undefined && now >= options.nextAt) && !next.terminated ? [next] : [])];
    return options.secondInstance ? [...live, next] : live;
  }
  const dollar = value => typeof value === 'string' ? { value, toString: () => value, dataUsingEncoding: () => value } : value;
  Object.assign(dollar, {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list(instances()),
      runningApplicationWithProcessIdentifier: pid => pid === 43 ? next : app },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { bundleIdentifier: 'org.example.owner' },
      URLForApplicationWithBundleIdentifier: () => ({ path: '/Applications/Fixture.app' }) } },
    NSFileManager: { defaultManager: {
      contentsOfDirectoryAtPathError: dir => String(dir) === '/Applications/Fixture.app/Contents/Frameworks' ? list(options.frameworks ?? []) : null,
      fileExistsAtPath: file => (options.frameworkFiles ?? []).includes(String(file)) } },
    CGWindowListCopyWindowInfo: () => list([]),
    NSRunLoop: { currentRunLoop: { runUntilDate() { now += 200; if (options.ownCloseAt && now >= options.ownCloseAt) present = false; } } },
    NSDate: { dateWithTimeIntervalSinceNow: seconds => seconds },
    NSString: { stringWithContentsOfFileEncodingError: () => JSON.stringify({ command }),
      alloc: { initWithDataEncoding: data => data } },
    // /bin/ps for the launched pid's arguments: the fake returns options.processArgs.
    NSTask: { alloc: { get init() { const task = { get launch() { psCalls.push(task.arguments); return task; }, get waitUntilExit() { return task; } }; return task; } } },
    NSPipe: { get pipe() { return { fileHandleForReading: { get readDataToEndOfFile() { return options.processArgs ?? ''; } } }; } },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData(data) {
      const event = JSON.parse(data); events.push(event);
      if (event.stage === 'armed') { opened = true; command = options.finishFirst ? 'finish' : 'launched'; }
      if (event.stage === 'ready' || event.stage === 'error') command = 'finish';
    } } },
    NSURL: { fileURLWithPath: value => ({ absoluteString: pathToFileURL(String(value)).href }) },
    AXUIElementCreateApplication: pid => pid === 43 ? nextElement : options.strictApplicationRef ? { rawApplication: appElement } : appElement,
    AXUIElementCopyAttributeValue(element, name, out) {
      name = String(name);
      if (element?.rawApplication) throw new Error('Ref has incompatible type');
      if (element === nextElement && name === 'AXWindows') { windowReads++; out[0] = list(present ? [window] : []); return 0; }
      if (element === appElement && name === 'AXWindows') {
        windowReads++;
        // An application element whose process has exited answers -25204 (cannot complete).
        if (ended()) return -25204;
        if (opened && !app.isFinishedLaunching) earlyWindowReads++;
        if (options.baselineStatus && !opened && windowReads <= (options.baselineFailures ?? Infinity)) return options.baselineStatus;
        if (options.windowReadFailure && now >= 10000) return -25204;
        if (opened && options.startupStatus && now < (options.recoverAt ?? Infinity)) return options.startupStatus;
        if (opened && options.startupFailures && windowReads <= options.startupFailures) return -25204;
        const foreign = !foreignGone && ((options.restoredWindow && opened) || (options.restoredOnRead && windowReads >= options.restoredOnRead) ||
          (options.extraWindowAfterPress && presses.length) || (options.transientWindow && now >= 400 && now < 5000));
        out[0] = list([...((opened || options.baselineWindow) && present ? options.multipleWindows ? [window, secondWindow] : [window] : []), ...(foreign ? [foreignWindow] : []),
          ...(opened && options.pendingExtra ? [extraWindow] : []),
          ...(opened && present && options.lateSecondAt !== undefined && now >= options.lateSecondAt ? [secondWindow] : [])]); return 0;
      }
      if (element === foreignWindow && options.invalidForeign && now >= (options.invalidForeignAfter ?? 0) && ['AXDocument', 'AXSheets'].includes(name)) {
        if (!options.foreignStaysPresent) foreignGone = true;
        return options.invalidStatus ?? -25201;
      }
      if (element === foreignWindow && name === 'AXDocument') { out[0] = `file://${MAC_TMP}/another.txt`; return 0; }
      if (element === secondWindow && !present) return -25202;
      if (element !== window && element !== secondWindow) return -25205;
      if (name === 'AXDocument') {
        if (options.documentReadError) throw new Error(options.documentReadError);
        if (options.documentMissing) return -25205;
        if (options.documentStatus && now < (options.documentStatusUntil ?? Infinity)) return options.documentStatus;
        if (element === secondWindow && now < (options.secondBusyUntil ?? -1)) return -25204;
        if (options.busyFrom !== undefined && now >= options.busyFrom && now < options.busyFrom + 600) return -25204;
        if (options.changedDocumentCloses && now >= 10000) present = false;
        out[0] = options.changedDocument && now >= 10000 ? options.changedDocument : options.document ?? expected; return 0;
      }
      if (name === 'AXTitle') { if (options.titleStatus) return options.titleStatus; out[0] = options.windowTitle ?? ''; return 0; }
      if (name === 'AXCloseButton' && !options.closeMissing) { out[0] = close; return 0; }
      if (name === 'AXSheets') { if (options.sheetStatus) return options.sheetStatus;
        out[0] = list(options.sheet || (options.lateSheet && now >= 10000) ? [{}] : []); return 0; }
      return -25205;
    },
    AXUIElementPerformAction(element, action) {
      if (options.strictRefs) { if (element?.cast !== close) throw new Error('Ref has incompatible type'); }
      else assert.equal(element, close);
      assert.equal(String(action), 'AXPress'); presses.push(now);
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
  const ObjC = { import() {}, unwrap: value => value?.value ?? value, deepUnwrap: value => value,
    castRefToObject: value => value?.rawApplication ?? (options.strictRefs && value === close ? { cast: close } : value) };
  const request = { bundle: 'org.example.fixture', targetURL: options.noTarget ? undefined : expected, control: 'ignored', fixturePath: path,
    fixtureRoot: `${MAC_TMP}/sleight-battery-unit/pair`, ...(options.windowMarker && { windowMarker: options.windowMarker }),
    ...(options.ownedArg && { ownedArg: options.ownedArg }) };
  const source = readFileSync(new URL('../bench/battery/host.js', import.meta.url), 'utf8');
  runInNewContext(`${source}\nrun([request]);`, { $: dollar, ObjC, Ref: () => [], Date: { now: () => now }, request: JSON.stringify(request) });
  return { ...events.findLast(e => e.stage === 'cleanup'), events, presses, scripts, terminations, present, now, windowReads,
    earlyWindowReads, nextTerminations, psCalls };
}

test('the application Ref is cast before reading its AXWindows', () => {
  const result = cleanupHost({ strictApplicationRef: true, axCloses: true });
  assert.equal(result.confirmed, true);
  assert.equal(result.presses.length, 1);
  assert.equal(result.terminations, 1);
});

test('native startup errors report their own message, stage and observed window count', () => {
  const result = cleanupHost({ documentReadError: 'Ref has incompatible type' });
  const event = result.events.find(e => e.stage === 'error');
  assert.equal(event.error.message, 'Ref has incompatible type');
  assert.equal(event.error.stage, 'retain');
  assert.equal(event.error.windowCount, 1);
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.equal(result.presses.length, 0);
});

test('a restored foreign document stops startup without retaining or closing its window', () => {
  const result = cleanupHost({ restoredWindow: true, axCloses: true });
  assert.equal(result.confirmed, false);
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.deepEqual(result.presses, []);
  assert.deepEqual(result.scripts, []);
  assert.equal(result.terminations, 0);
  const foreign = result.details.windows.find(w => w.document === `file://${MAC_TMP}/another.txt`);
  assert.equal(foreign.retained, false);
  assert.ok(foreign.reasons.includes('WINDOW_NOT_RETAINED'));
  assert.equal(result.events.find(e => e.stage === 'error').error.windowCount, 2);
});

test('a foreign document appearing in the readiness snapshot prevents readiness', () => {
  // Readiness and window classification share one AXWindows snapshot, so the first launched read is the readiness snapshot.
  assert.equal(cleanupHost({ axCloses: true }).events.find(e => e.stage === 'ready').windowCount, 1);
  const result = cleanupHost({ restoredOnRead: 1, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.equal(result.confirmed, false);
  assert.equal(result.details.windows[0].retained, false);
  assert.equal(result.details.windows[0].document, `file://${MAC_TMP}/another.txt`);
  assert.deepEqual(result.presses, []);
  assert.deepEqual(result.scripts, []);
  assert.equal(result.terminations, 0);
});

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
  const runtime = cleanupRuntime({ document: `file://${MAC_TMP}/another.txt` });
  await assert.rejects(executePlan(plan({ wanted: ['textedit'] }), runtime), /CLEANUP_UNCONFIRMED/);
  const row = runtime.published.at(-1)[0];
  assert.equal(row.passed, true);
  assert.equal(row.checkCode, 'PASS');
  assert.equal(row.cleanupConfirmed, false);
  assert.equal(runtime.published.length, 1);
  assert.deepEqual(runtime.cleanups[0].presses, []);
  assert.deepEqual(runtime.cleanups[0].scripts, []);
  assert.equal(runtime.cleanups[0].terminations, 0);
  assert.equal(row.cleanupDetails.windows[0].document, `file://${MAC_TMP}/another.txt`);
  assert.equal(row.cleanupDetails.windows[0].expectedURL, `file://${MAC_TMP}/sleight-battery-unit/pair/fixture.txt`);
  assert.ok(row.cleanupDetails.windows[0].reasons.includes('DOCUMENT_NOT_MATCHED'));
});

test('the close button is pressed as a cast object, which JXA requires', async () => {
  const { executePlan } = await load('run'), { plan } = await load('plan');
  const runtime = cleanupRuntime({ strictRefs: true, axCloses: true });
  const rows = await executePlan(plan({ wanted: ['textedit'] }), runtime);
  assert.ok(rows.every(row => row.passed && row.cleanupConfirmed));
  for (const cleanup of runtime.cleanups) { assert.equal(cleanup.presses.length, 1); assert.equal(cleanup.scripts.length, 0); }
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
  ['changed document after close', { changedDocument: `file://${MAC_TMP}/another.txt` }, 'DOCUMENT_NOT_MATCHED'],
  ['external file', { path: `${MAC_USERS}example/private.txt` }, 'SCRIPTING_NOT_OWN_FIXTURE'],
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
  assert.equal(result.details.windows[1].document, `file://${MAC_TMP}/another.txt`);
  assert.ok(result.details.windows[1].reasons.includes('WINDOW_NOT_RETAINED'));
});

test('an unretained invalid window absent at finish is recorded as gone without failing cleanup', () => {
  const result = cleanupHost({ axCloses: true, extraWindowAfterPress: true, invalidForeign: true });
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  const row = result.details.windows[1];
  assert.equal(row.retained, false);
  assert.equal(row.documentStatus, -25201);
  assert.equal(row.sheetStatus, -25201);
  assert.equal(row.present, false);
  assert.equal(row.stillPresentAfter10s, false);
  assert.equal(row.gone, true);
  assert.deepEqual(row.reasons, ['WINDOW_NOT_RETAINED', 'DOCUMENT_NOT_MATCHED', 'SHEETS_READ_FAILED']);
  assert.equal(result.presses.length, 1);
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 1);
});

test('an invalid unretained window still present at finish prevents cleanup and app termination', () => {
  const result = cleanupHost({ axCloses: true, extraWindowAfterPress: true, invalidForeign: true, foreignStaysPresent: true });
  assert.equal(result.confirmed, false);
  assert.equal(result.details.windows[1].present, true);
  assert.notEqual(result.details.windows[1].gone, true);
  assert.equal(result.presses.length, 1);
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
});

test('a previously readable foreign window still fails when it expires during close polling', () => {
  const result = cleanupHost({ extraWindowAfterPress: true, invalidForeign: true, invalidForeignAfter: 10000, ownCloseAt: 10000 });
  assert.equal(result.confirmed, false);
  const row = result.details.windows[1];
  assert.equal(row.present, false);
  assert.equal(row.documentStatus, -25201);
  assert.notEqual(row.gone, true);
  assert.equal(row.documentReads[0].document, `file://${MAC_TMP}/another.txt`);
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
});

test('a changed document still stops cleanup when its window disappears after revalidation', () => {
  const result = cleanupHost({ changedDocument: `file://${MAC_TMP}/another.txt`, changedDocumentCloses: true });
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
  assert.equal(result.details.windows[1].document, `file://${MAC_TMP}/another.txt`);
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
  const dir = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-battery-test-'))));
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
      { dir, path, target: own ? path : `${MAC_TMP}/other.txt` }, new AbortController().signal, runProcess);
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

test('only a newly launched app receives the one-launch persistence argument', async t => {
  const { startHost } = await load('runtime');
  const dir = bank(t);
  for (const wasRunning of [false, true]) for (const target of [undefined, `${MAC_TMP}/fixture.txt`]) {
    const launches = [], response = Promise.withResolvers();
    const runProcess = (executable, args, options) => {
      if (executable === '/usr/bin/open') {
        launches.push(args); return Promise.resolve({ exit: { code: 0 }, groupClean: true });
      }
      assert.equal(executable, '/usr/bin/osascript');
      options.onStdout(JSON.stringify({ stage: 'armed', wasRunning }) + '\n{"stage":"ready"}\n');
      return response.promise;
    };
    const host = await startHost({ bundle: 'org.example.fixture' }, { dir, target }, new AbortController().signal, runProcess);
    const args = ['-g', '-b', 'org.example.fixture', ...(target ? [target] : [])];
    assert.deepEqual(launches, wasRunning && !target ? [] : [[...args,
      ...(!wasRunning ? ['--args', '-ApplePersistenceIgnoreState', 'YES'] : [])]]);
    response.resolve({ exit: { code: 0 }, groupClean: true });
    await host.finish();
  }
});

for (const nativeError of [true, false]) test(`host startup publishes ${nativeError ? 'native error metadata' : 'an early process error'} before stopping the pass`, async t => {
  const { startHost } = await load('runtime'), { executePlan } = await load('run'), { plan } = await load('plan');
  const dir = bank(t), published = [];
  let driven = 0;
  const runProcess = (executable, args, options) => {
    assert.equal(executable, '/usr/bin/osascript');
    if (nativeError) {
      const message = JSON.stringify({ stage: 'error', error: {
        message: `Ref has incompatible type at ${homedir()}/private`, stage: 'retain', windowCount: 2,
      } }) + '\n';
      options.onStdout(message.slice(0, 30)); options.onStdout(message.slice(30));
    }
    return Promise.resolve({ exit: { code: nativeError ? 0 : 1 }, groupClean: true,
      stderr: nativeError ? '' : `execution error: host failed at ${homedir()}/private` });
  };
  const runtime = { async setupPair() { return { dir }; }, async resetFixture() {},
    startHost: (task, ctx) => startHost(task, ctx, new AbortController().signal, runProcess),
    async drive() { driven++; }, publish(rows) { published.push(structuredClone(rows)); }, async closePair() {},
  };
  await assert.rejects(executePlan(plan({ wanted: ['word'] }), runtime), /CLEANUP_UNCONFIRMED/);
  assert.equal(driven, 0);
  assert.equal(published.length, 1);
  const row = published[0][0];
  assert.equal(row.checkCode, 'RUN_FAILED');
  assert.equal(row.cleanupConfirmed, false);
  assert.deepEqual(row.cleanupDetails.startError, nativeError
    ? { message: 'Ref has incompatible type at ~/private', stage: 'retain', windowCount: 2 }
    : { message: 'execution error: host failed at ~/private', stage: 'armed', windowCount: null });
});

test('a restored-window startup receipt reaches the published row before any driver call', async t => {
  const { startHost } = await load('runtime'), { executePlan } = await load('run'), { plan } = await load('plan');
  const native = cleanupHost({ restoredWindow: true, axCloses: true });
  const dir = bank(t), published = [], response = Promise.withResolvers();
  let receive, driven = 0;
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/osascript') {
      receive = options.onStdout;
      receive(JSON.stringify(native.events.find(e => e.stage === 'armed')) + '\n');
      return response.promise;
    }
    assert.equal(executable, '/usr/bin/open');
    for (const event of native.events.filter(e => ['cleanup', 'error', 'ready'].includes(e.stage))) receive(JSON.stringify(event) + '\n');
    response.resolve({ exit: { code: 0 }, groupClean: true });
    return Promise.resolve({ exit: { code: 0 }, groupClean: true });
  };
  const runtime = { async setupPair() { return { dir, target: fixturePath }; }, async resetFixture() {},
    startHost: (task, ctx) => startHost(task, ctx, new AbortController().signal, runProcess),
    async drive() { driven++; return { groupClean: true, code: 0 }; }, async check() { return true; },
    publish(rows) { published.push(structuredClone(rows)); }, async closePair() {},
  };
  await assert.rejects(executePlan(plan({ wanted: ['word'] }), runtime), /CLEANUP_UNCONFIRMED/);
  assert.equal(driven, 0);
  assert.equal(published.length, 1);
  const row = published[0][0];
  assert.equal(row.checkCode, 'RUN_FAILED');
  assert.deepEqual(row.cleanupDetails.reasons, ['FOREIGN_WINDOW_ON_START']);
  const { startWait, ...startError } = row.cleanupDetails.startError;
  assert.deepEqual(startError, { message: 'FOREIGN_WINDOW_ON_START', stage: 'retain', windowCount: 2 });
  assert.equal(startWait.windowCount, 2);
  assert.equal(row.cleanupDetails.windows[0].retained, false);
  assert.equal(row.cleanupDetails.windows[0].document, `file://${MAC_TMP}/another.txt`);
  assert.equal(row.cleanupConfirmed, false);
  assert.deepEqual(native.presses, []);
  assert.deepEqual(native.scripts, []);
  assert.equal(native.terminations, 0);
});


test('owned workspace marker can retain a fresh window without AXDocument, but not a different document', () => {
  const accepted = cleanupHost({ documentMissing: true, windowMarker: 'AM1-unique', windowTitle: 'AM1-unique', axCloses: true });
  assert.equal(accepted.confirmed, true); assert.equal(accepted.presses.length, 1);
  const refused = cleanupHost({ document: `file://${MAC_TMP}/owner.txt`, windowMarker: 'AM1-unique', windowTitle: 'AM1-unique', axCloses: true });
  assert.equal(refused.confirmed, false); assert.equal(refused.presses.length, 0);
});
test('a folder window with an empty document CFString and no sheets closes without quitting its running app', () => {
  const result = cleanupHost({ document: { value: '' }, windowMarker: 'AM1-unique', windowTitle: 'AM1-unique',
    sheetStatus: -25212, wasRunning: true, axCloses: true });
  assert.equal(result.confirmed, true, JSON.stringify(result.details ?? {}));
  assert.equal(result.presses.length, 1);
  assert.equal(result.present, false);
  assert.equal(result.terminations, 0);
  assert.deepEqual(result.scripts, []);
});
test('a marker never overrides a document mismatch, sheet timeout or ambiguous folder window', () => {
  for (const options of [{ document: `file://${MAC_TMP}/owner.txt` }, { sheetStatus: -25204 }, { multipleWindows: true }]) {
    const result = cleanupHost({ document: { value: '' }, windowMarker: 'AM1-unique', windowTitle: 'AM1-unique',
      wasRunning: true, axCloses: true, ...options });
    assert.equal(result.confirmed, false);
    assert.equal(result.presses.length, 0);
    assert.equal(result.terminations, 0);
  }
});
test('duplicate workspace markers refuse before retaining or closing a window', () => {
  const result = cleanupHost({ documentMissing: true, multipleWindows: true, windowMarker: 'AM1-unique', windowTitle: 'AM1-unique', axCloses: true });
  assert.equal(result.confirmed, false); assert.equal(result.presses.length, 0); assert.equal(result.terminations, 0);
});
test('workspace and prepared-container prerequisites refuse before open', async t => {
  const { startHost } = await load('runtime'); const dir = bank(t);
  for (const [wasRunning, option] of [[true, 'requireStopped'], [false, 'requireRunning']]) {
    const response = Promise.withResolvers(); let opened = false;
    const runProcess = (executable, args, options) => {
      if (executable === '/usr/bin/open') { opened = true; throw Error('must not open'); }
      options.onStdout(JSON.stringify({stage:'armed', wasRunning}) + '\n{"stage":"ready"}\n');
      options.signal.addEventListener('abort', () => response.resolve({exit:{code:0}, groupClean:true}));
      return response.promise;
    };
    await assert.rejects(startHost({bundle:'org.example.fixture'}, {dir, [option]:true}, new AbortController().signal, runProcess), error => {
      assert.equal(error.hostCleanup.confirmed, true); return /APP_ALREADY_RUNNING|FIXTURE_NOT_OPEN/.test(error.message);
    });
    assert.equal(opened, false);
  }
});


test('startup retries late AXWindows until the owned readiness deadline with an injected clock', () => {
  const result = cleanupHost({ startupFailures: 3, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'error'), false);
  assert.equal(result.events.some(e => e.stage === 'ready'), true);
  assert.equal(result.confirmed, true);
  assert.equal(result.present, false);
  assert.equal(result.terminations, 1);
  assert.ok(result.now >= 400 && result.now < 30000);
});

test('a persistent late tree fails with its AX status at the readiness deadline and leaves cleanup unconfirmed', () => {
  const result = cleanupHost({ startupStatus: -25204, axCloses: true });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.message, 'WINDOWS_READ_FAILED');
  assert.equal(error.axStatus, -25204);
  assert.equal(error.stage, 'retain');
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.equal(result.confirmed, false);
  assert.ok(result.now >= 60000 && result.now < 100000);
  assert.equal(result.terminations, 0);
  assert.equal(error.startWait.budgetMs, 60000);
  assert.equal(error.startWait.lastWindowsStatus, -25204);
  assert.ok(error.startWait.windowsStatus['-25204'] > 1);
});

for (const wasRunning of [false, true]) test(`startup failure cleans the exact fixture and ${wasRunning ? 'preserves' : 'quits'} the app`, () => {
  const result = cleanupHost({ startupStatus: -25204, recoverAt: 60200, wasRunning, axCloses: true });
  assert.equal(result.events.find(e => e.stage === 'error').error.axStatus, -25204);
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.equal(result.confirmed, true, JSON.stringify(result.details ?? {}));
  assert.equal(result.presses.length, 1);
  assert.equal(result.present, false);
  assert.equal(result.terminations, wasRunning ? 0 : 1);
});

for (const status of [-25202, -25205, -25212]) test(`AXWindows status ${status} fails immediately without retrying startup`, () => {
  const result = cleanupHost({ startupStatus: status, axCloses: true });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.axStatus, status);
  assert.equal(result.now, 0);
  assert.equal(result.confirmed, false);
  assert.equal(result.terminations, 0);
});

test('runtime waits for the startup-error cleanup receipt before collecting the host', async t => {
  const { startHost } = await load('runtime'), dir = bank(t);
  const response = Promise.withResolvers(); let receive, aborted = false;
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/osascript') {
      receive = options.onStdout;
      receive('{"stage":"armed","wasRunning":false}\n');
      options.signal.addEventListener('abort', () => {
        aborted = true; response.resolve({ exit: { code: 0 }, groupClean: true });
      });
      return response.promise;
    }
    assert.equal(executable, '/usr/bin/open');
    receive('{"stage":"error","error":{"message":"WINDOWS_READ_FAILED","stage":"retain","axStatus":-25204,"windowCount":null}}\n');
    setImmediate(() => {
      receive('{"stage":"cleanup","confirmed":true,"details":{"reasons":[],"windows":[],"app":{"terminated":true}}}\n');
      response.resolve({ exit: { code: 0 }, groupClean: true });
    });
    return Promise.resolve({ exit: { code: 0 }, groupClean: true });
  };
  await assert.rejects(startHost({ bundle: 'org.example.fixture' }, { dir, target: fixturePath },
    new AbortController().signal, runProcess), error => {
    assert.equal(error.hostCleanup.confirmed, true);
    assert.equal(error.hostCleanup.details.app.terminated, true);
    return error.message === 'WINDOWS_READ_FAILED';
  });
  assert.equal(aborted, false);
});


test('a failed baseline snapshot never closes an existing app or adopts its windows', () => {
  const result = cleanupHost({ baselineStatus: -25204, baselineFailures: 1, baselineWindow: true, wasRunning: true, axCloses: true });
  assert.equal(result.events.find(e => e.stage === 'error').error.stage, 'baseline');
  assert.equal(result.presses.length, 0);
  assert.equal(result.terminations, 0);
  assert.equal(result.confirmed, false);
  assert.equal(result.now, 0);
});

for (const lateConfirmed of [false, true]) test(`a safety abort during startup-error recovery stays unconfirmed with cleanup receipt ${lateConfirmed}`, async t => {
  const { startHost } = await load('runtime'), dir = bank(t), safety = new AbortController();
  const response = Promise.withResolvers(); let receive, hostSignal, afterAbort;
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/osascript') {
      receive = options.onStdout; hostSignal = options.signal;
      receive('{"stage":"armed","wasRunning":false}\n');
      return response.promise;
    }
    assert.equal(executable, '/usr/bin/open');
    receive('{"stage":"error","error":{"message":"WINDOWS_READ_FAILED","stage":"retain","axStatus":-25204,"windowCount":null}}\n');
    setImmediate(() => {
      safety.abort();
      afterAbort = { command: JSON.parse(readFileSync(join(dir, 'host-control.json'), 'utf8')).command,
        hostAborted: hostSignal.aborted };
      receive(JSON.stringify({ stage: 'cleanup', confirmed: lateConfirmed, details: { reasons: [], windows: [] } }) + '\n');
      response.resolve({ exit: { code: 0 }, groupClean: true });
    });
    return Promise.resolve({ exit: { code: 0 }, groupClean: true });
  };
  await assert.rejects(startHost({ bundle: 'org.example.fixture' }, { dir, target: fixturePath }, safety.signal, runProcess), error => {
    assert.equal(error.message, 'WINDOWS_READ_FAILED');
    assert.equal(error.hostCleanup.details.startError.axStatus, -25204);
    assert.equal(error.hostCleanup.confirmed, false);
    return true;
  });
  assert.deepEqual(afterAbort, { command: 'abort', hostAborted: true });
  assert.equal(getEventListeners(safety.signal, 'abort').length, 0);
});

// AM1 late accessibility tree (1.4.0). Live evidence: ledger claims/_evidence-AM1-live (am1-vs, am1e-vs, am1e-office).
test('a launch whose AXWindows answers -25204 for 45 s still becomes ready inside the 60 s startup budget', () => {
  const result = cleanupHost({ startupStatus: -25204, recoverAt: 45000, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'error'), false, JSON.stringify(result.events.find(e => e.stage === 'error')));
  assert.equal(result.events.some(e => e.stage === 'ready'), true);
  assert.equal(result.confirmed, true);
  assert.equal(result.terminations, 1);
});

test('the host reads no AXWindows from a launched app before it finishes launching', () => {
  const result = cleanupHost({ finishLaunchingAt: 5000, axCloses: true });
  assert.equal(result.earlyWindowReads, 0);
  assert.equal(result.events.some(e => e.stage === 'ready'), true);
  assert.equal(result.confirmed, true);
});

for (const status of [-25204, -25205, -25212]) test(`a new window whose document answers ${status} at first is waited for, then retained`, () => {
  const result = cleanupHost({ documentStatus: status, documentStatusUntil: 8000, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'error'), false, JSON.stringify(result.events.find(e => e.stage === 'error')));
  const ready = result.events.find(e => e.stage === 'ready');
  assert.ok(ready, 'ready');
  assert.equal(result.presses.length, 1);
  assert.equal(result.confirmed, true);
  assert.equal(result.terminations, 1);
});

test('a window that never shows its identity stops at the startup deadline untouched, with counts and no text', () => {
  const result = cleanupHost({ documentStatus: -25205, windowTitle: 'Private title', axCloses: true });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.message, 'FIXTURE_WINDOW_UNIDENTIFIED');
  assert.equal(error.stage, 'retain');
  assert.equal(error.startWait.pending, 1);
  assert.equal(error.startWait.pendingDocumentStatus, -25205);
  assert.equal(error.startWait.finishedLaunching, true);
  assert.ok(error.startWait.elapsedMs >= 60000);
  assert.equal(result.presses.length, 0);
  assert.equal(result.scripts.length, 0);
  assert.equal(result.terminations, 0);
  assert.equal(result.confirmed, false);
  assert.doesNotMatch(JSON.stringify(result.events), /Private title/);
});

test('a readable different document is still foreign at once, without waiting', () => {
  const result = cleanupHost({ restoredWindow: true, axCloses: true });
  assert.equal(result.events.find(e => e.stage === 'error').error.message, 'FOREIGN_WINDOW_ON_START');
  assert.ok(result.now < 1000);
  assert.equal(result.presses.length, 0);
});

test('a window titled with the fixture marker and no document is the fixture', () => {
  const result = cleanupHost({ documentMissing: true, windowMarker: 'AM1-unique', windowTitle: 'AM1-unique.docx', axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'ready'), true);
  assert.equal(result.confirmed, true);
  assert.equal(result.terminations, 1);
});

test('a launched process that relaunches itself is followed to its new pid and quit there', () => {
  const result = cleanupHost({ relaunchAt: 2000, finishLaunchingAt: 4000, axCloses: true });
  const ready = result.events.find(e => e.stage === 'ready');
  assert.ok(ready, JSON.stringify(result.events.find(e => e.stage === 'error')));
  assert.equal(ready.pid, 43);
  assert.equal(ready.relaunches, 1);
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  assert.equal(result.nextTerminations, 1);
  assert.equal(result.terminations, 0);
});

test('a terminated instance still listed for the bundle is skipped', () => {
  const result = cleanupHost({ relaunchAt: 1000, finishLaunchingAt: 3000, listsTerminated: true, axCloses: true });
  assert.equal(result.events.find(e => e.stage === 'ready')?.pid, 43);
  assert.equal(result.confirmed, true);
});

test('two live instances of a launched bundle wait, then stop as ambiguous without acting', () => {
  const result = cleanupHost({ secondInstance: true, axCloses: true });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.message, 'APP_INSTANCE_AMBIGUOUS');
  assert.equal(error.startWait.instances, 2);
  assert.equal(result.presses.length, 0);
  assert.equal(result.terminations + result.nextTerminations, 0);
  assert.equal(result.confirmed, false);
});

test('a launched app that exits during startup reports APP_EXITED, and cleanup confirms nothing it launched is running', () => {
  const result = cleanupHost({ exitAt: 600, axCloses: true, finishLaunchingAt: 2000 });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.message, 'APP_EXITED');
  assert.equal(error.startWait.exited, true);
  assert.equal(error.startWait.instances, 0);
  assert.equal(result.presses.length, 0);
  assert.equal(result.terminations, 0);
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  assert.equal(result.details.app.exited, true);
  assert.ok(result.now < 70000);
});

test('the armed receipt says whether the app bundle carries its own argv parser', () => {
  const plain = cleanupHost({ axCloses: true });
  assert.equal(plain.events.find(e => e.stage === 'armed').ownArgv, false);
  for (const options of [{ frameworks: ['Electron Framework.framework'] }, { frameworks: ['Chromium Embedded Framework.framework'] },
    { frameworks: ['Example Framework.framework'], frameworkFiles: ['/Applications/Fixture.app/Contents/Frameworks/Example Framework.framework/Versions/Current/Helpers'] }]) {
    assert.equal(cleanupHost({ ...options, axCloses: true }).events.find(e => e.stage === 'armed').ownArgv, true, JSON.stringify(options));
  }
  assert.equal(cleanupHost({ frameworks: ['Sparkle.framework'], axCloses: true }).events.find(e => e.stage === 'armed').ownArgv, false);
});

function launchRecorder({ ownArgv, wasRunning = false } = {}) {
  const launches = [], response = Promise.withResolvers();
  let request;
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/open') { launches.push(args); return Promise.resolve({ exit: { code: 0 }, groupClean: true }); }
    request = JSON.parse(args.at(-1));
    options.onStdout(JSON.stringify({ stage: 'armed', wasRunning, ownArgv }) + '\n{"stage":"ready"}\n');
    return response.promise;
  };
  return { launches, runProcess, get request() { return request; }, done: () => response.resolve({ exit: { code: 0 }, groupClean: true }) };
}

test('apps with their own argv parser never receive the AppKit persistence switch', async t => {
  // VS Code 1.141 parses "-ApplePersistenceIgnoreState" with minimist 1.2.8 as clustered short flags, and "s" is --status,
  // which quits a first instance ("can only be used if Code is already running"). Its pid then answers -25204 (am1e-vs).
  const { startHost } = await load('runtime'), dir = bank(t);
  for (const ownArgv of [true, false]) {
    const recorder = launchRecorder({ ownArgv });
    const host = await startHost({ bundle: 'org.example.fixture' }, { dir, target: `${MAC_TMP}/fixture` }, new AbortController().signal, recorder.runProcess);
    assert.deepEqual(recorder.launches, [['-g', '-b', 'org.example.fixture', `${MAC_TMP}/fixture`,
      ...(ownArgv ? [] : ['--args', '-ApplePersistenceIgnoreState', 'YES'])]]);
    recorder.done(); await host.finish();
  }
});

test('fixture launch arguments replace the persistence switch, and only for a fresh launch', async t => {
  const { startHost } = await load('runtime'), dir = bank(t);
  for (const wasRunning of [false, true]) {
    const recorder = launchRecorder({ ownArgv: true, wasRunning });
    const host = await startHost({ bundle: 'org.example.fixture' }, { dir, target: `${MAC_TMP}/fixture`, launchArgs: [`--user-data-dir=${MAC_TMP}/p`] },
      new AbortController().signal, recorder.runProcess);
    assert.deepEqual(recorder.launches, [['-g', '-b', 'org.example.fixture', `${MAC_TMP}/fixture`, ...(wasRunning ? [] : ['--args', `--user-data-dir=${MAC_TMP}/p`])]]);
    recorder.done(); await host.finish();
  }
});

test('the runtime gives the host its startup budget and waits past it before HOST_DEADLINE', async t => {
  const { startHost } = await load('runtime'), dir = bank(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = Promise.withResolvers(); let receive, request;
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/open') return Promise.resolve({ exit: { code: 0 }, groupClean: true });
    request = JSON.parse(args.at(-1)); receive = options.onStdout;
    receive('{"stage":"armed","wasRunning":false,"ownArgv":false}\n');
    return response.promise;
  };
  let settled = false;
  const started = startHost({ bundle: 'org.example.fixture' }, { dir, target: `${MAC_TMP}/fixture` }, new AbortController().signal, runProcess)
    .then(host => { settled = true; return host; });
  for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.startupMs, 60000);
  t.mock.timers.tick(65000);
  for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'readiness must outlast the host budget');
  receive('{"stage":"ready","pid":42}\n');
  const host = await started;
  response.resolve({ exit: { code: 0 }, groupClean: true });
  await host.finish();
});

test('a document fixture may name its window by the file stem, and scripting can be withheld', async t => {
  const { startHost } = await load('runtime');
  const dir = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-battery-test-'))));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'AM1-unique.docx'); writeFileSync(path, 'x');
  for (const [ctx, task, marker, scripted] of [
    [{ windowMarker: 'AM1-unique' }, {}, 'AM1-unique', true],
    [{ windowMarker: 'AM1-unique.docx' }, {}, 'AM1-unique.docx', true],
    [{ windowMarker: 'AM1-other' }, {}, undefined, true],
    [{ windowMarker: 'AM1' }, {}, undefined, true],
    [{ windowMarker: 'AM1-unique' }, { noScripting: true }, 'AM1-unique', false],
  ]) {
    const recorder = launchRecorder({ ownArgv: false });
    const host = await startHost({ bundle: 'org.example.fixture', fixtureKind: 'doc-file', ...task }, { dir, path, target: path, ...ctx },
      new AbortController().signal, recorder.runProcess);
    assert.equal(recorder.request.windowMarker, marker, JSON.stringify(ctx));
    assert.equal(recorder.request.fixturePath, scripted ? path : undefined);
    recorder.done(); await host.finish();
  }
});

test('the started host reports how long readiness took and whether the process relaunched', async t => {
  const { startHost } = await load('runtime'), dir = bank(t);
  const response = Promise.withResolvers();
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/open') return Promise.resolve({ exit: { code: 0 }, groupClean: true });
    options.onStdout('{"stage":"armed","wasRunning":false,"ownArgv":false}\n{"stage":"ready","pid":43,"waitMs":12400,"relaunches":1,"windowCount":1}\n');
    return response.promise;
  };
  const host = await startHost({ bundle: 'org.example.fixture' }, { dir, target: `${MAC_TMP}/fixture` }, new AbortController().signal, runProcess);
  assert.deepEqual(host.startup, { waitMs: 12400, relaunches: 1 });
  response.resolve({ exit: { code: 0 }, groupClean: true }); await host.finish();
});

test('a relaunched instance that never finishes launching is reported as such, not by the old pid\'s read status', () => {
  const result = cleanupHost({ startupStatus: -25204, relaunchAt: 3000, nextNeverFinishes: true, axCloses: true });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.message, 'APP_NOT_FINISHED_LAUNCHING');
  assert.equal(error.startWait.relaunches, 1);
  // Recovery still closes the proven fixture window and quits the instance this run launched, never the exited one.
  assert.equal(result.presses.length, 1);
  assert.equal(result.nextTerminations, 1);
  assert.equal(result.terminations, 0);
  assert.equal(result.confirmed, true);
});

// Review findings on the late-tree host (2026-10-19).
test('an instance launched before the host armed is never followed or quit', () => {
  const result = cleanupHost({ relaunchAt: 2000, nextLaunchedAt: -5000, finishLaunchingAt: 4000, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.equal(result.events.find(e => e.stage === 'error').error.message, 'APP_EXITED');
  assert.equal(result.presses.length, 0);
  assert.equal(result.nextTerminations, 0);
  assert.equal(result.confirmed, false);
});

test('without a fixture target a launched process that hands over is not followed', () => {
  const result = cleanupHost({ noTarget: true, relaunchAt: 2000, finishLaunchingAt: 4000, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'ready'), false);
  assert.equal(result.presses.length, 0);
  assert.equal(result.nextTerminations, 0);
  assert.equal(result.confirmed, false);
});

test('recovery never switches to another instance, and an instance appearing after an exit stays untouched', () => {
  const result = cleanupHost({ exitAt: 600, finishLaunchingAt: 2000, nextAt: 60300, axCloses: true });
  assert.equal(result.events.find(e => e.stage === 'error').error.message, 'APP_EXITED');
  assert.equal(result.presses.length, 0);
  assert.equal(result.nextTerminations, 0);
  assert.equal(result.confirmed, false);
});

test('finish before any launch command confirms nothing and touches nothing', () => {
  const result = cleanupHost({ finishFirst: true, axCloses: true });
  assert.equal(result.confirmed, false);
  assert.ok(result.details.reasons.includes('LAUNCH_UNCONFIRMED'));
  assert.equal(result.presses.length, 0);
  assert.equal(result.terminations, 0);
});

for (const [name, document] of [['a localhost URL', `file://localhost${MAC_TMP}/sleight-battery-unit/pair/fixture.txt`],
  ['a trailing slash', `file://${MAC_TMP}/sleight-battery-unit/pair/fixture.txt/`]]) {
  test(`a window admitted through ${name} also closes in cleanup`, () => {
    const result = cleanupHost({ document, axCloses: true });
    assert.equal(result.events.some(e => e.stage === 'ready'), true);
    assert.equal(result.confirmed, true, JSON.stringify(result.details));
    assert.equal(result.presses.length, 1);
  });
}

test('a sibling path sharing the fixture prefix is a different document', () => {
  const result = cleanupHost({ document: `file://${MAC_TMP}/sleight-battery-unit/pair/fixture.txt2`, axCloses: true });
  assert.equal(result.events.find(e => e.stage === 'error').error.message, 'FOREIGN_WINDOW_ON_START');
  assert.equal(result.presses.length, 0);
});

test('an app that was already running is ready on its existing windows, as before', () => {
  const result = cleanupHost({ wasRunning: true, baselineWindow: true, document: `file://${MAC_TMP}/owner.txt`, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'ready'), true);
  assert.equal(result.presses.length, 0);
  assert.equal(result.terminations, 0);
});

test('a host that gets finish before readiness after an open failure is aborted, not asked to clean', async t => {
  const { startHost } = await load('runtime'), dir = bank(t);
  const response = Promise.withResolvers(); let commands = [];
  const runProcess = (executable, args, options) => {
    if (executable === '/usr/bin/open') return Promise.resolve({ exit: { code: 1 }, groupClean: true, stderr: 'open failed' });
    options.onStdout('{"stage":"armed","wasRunning":false,"ownArgv":false}\n');
    options.signal.addEventListener('abort', () => response.resolve({ exit: { code: 0 }, groupClean: true }));
    return response.promise;
  };
  await assert.rejects(startHost({ bundle: 'org.example.fixture' }, { dir, target: `${MAC_TMP}/fixture` }, new AbortController().signal, runProcess), error => {
    commands.push(JSON.parse(readFileSync(join(dir, 'host-control.json'), 'utf8')).command);
    assert.equal(error.hostCleanup.confirmed, false);
    return true;
  });
  assert.deepEqual(commands, ['abort']);
});

test('a generic file stem is not accepted as a window marker', async t => {
  const { startHost } = await load('runtime');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-battery-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.txt'); writeFileSync(path, 'x');
  const recorder = launchRecorder({ ownArgv: false });
  const host = await startHost({ bundle: 'org.example.fixture', fixtureKind: 'doc-file' }, { dir, path, target: path, windowMarker: 'fixture' },
    new AbortController().signal, recorder.runProcess);
  assert.equal(recorder.request.windowMarker, undefined);
  recorder.done(); await host.finish();
});

test('the fixture match makes a launch ready while another new window stays unidentified and untouched', () => {
  const result = cleanupHost({ pendingExtra: true, axCloses: true });
  assert.equal(result.events.some(e => e.stage === 'ready'), true, JSON.stringify(result.events.find(e => e.stage === 'error')));
  assert.equal(result.presses.length, 1);
  assert.equal(result.terminations, 0);
  assert.equal(result.confirmed, false);
  assert.ok(result.details.windows.some(row => !row.retained && row.reasons.includes('WINDOW_NOT_RETAINED')));
});

test('a second instance appearing after the launched pid is known stops as ambiguous, and recovery stays with the launched pid', () => {
  const result = cleanupHost({ nextAt: 1000, finishLaunchingAt: 3000, axCloses: true });
  const error = result.events.find(e => e.stage === 'error').error;
  assert.equal(error.message, 'APP_INSTANCE_AMBIGUOUS');
  assert.equal(error.startWait.instances, 2);
  assert.equal(result.nextTerminations, 0);
  assert.equal(result.presses.length, 1);
  assert.equal(result.terminations, 1);
});

test('every host sample names the host stage it was taken in', () => {
  // The window closes 3 s after the press, so cleanup samples while it waits.
  const result = cleanupHost({ finishLaunchingAt: 1000, ownCloseAt: 3000 });
  const stages = [...new Set(result.events.filter(e => e.stage === 'sample').map(e => e.sample.stage))];
  assert.deepEqual(stages, ['baseline', 'retain', 'ready', 'cleanup']);
  assert.ok(result.events.filter(e => e.stage === 'sample').every(e => 'front' in e.sample && Number.isFinite(e.sample.atMs)));
});

// AM1 qualification 2 (2026-10-19 08:45Z): cleanup left an unretained Word window with DOCUMENT_NOT_MATCHED and SHEETS_READ_FAILED.
test('an unretained window whose element reads -25202 (invalid) and is gone at finish does not fail cleanup', () => {
  const result = cleanupHost({ axCloses: true, extraWindowAfterPress: true, invalidForeign: true, invalidStatus: -25202 });
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  assert.equal(result.details.windows[1].gone, true);
  assert.equal(result.terminations, 1);
});

test('a busy fixture window is read again in cleanup instead of failing as not matched', () => {
  const result = cleanupHost({ axCloses: true, busyFrom: 200 });
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  assert.equal(result.presses.length, 1);
  assert.equal(result.terminations, 1);
});

test('cleanup adopts a fixture window that appeared after readiness while its reads were busy', () => {
  const result = cleanupHost({ lateSecondAt: 200, secondBusyUntil: 700 });
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  assert.equal(result.details.windows.filter(row => row.retained).length, 2);
  assert.equal(result.terminations, 1);
});

// AM1 qualification 4 (2026-10-19 09:0xZ): VS Code opened an empty window, the host couldn't prove it was the fixture, and
// cleanup left the run's own editor instance running.
const ownedArg = `--user-data-dir=${MAC_TMP}/sleight-battery-unit/pair/p`;
test('an instance the run launched on its own profile is quit whole, even with an unidentified window', () => {
  const result = cleanupHost({ documentStatus: -25205, ownedArg, processArgs: `/Applications/Fixture.app/Contents/MacOS/Fixture ${ownedArg} --new-window ${MAC_TMP}/x` });
  assert.equal(result.events.find(e => e.stage === 'error').error.message, 'FIXTURE_WINDOW_UNIDENTIFIED');
  assert.equal(result.presses.length, 0);
  assert.equal(result.terminations, 1);
  assert.equal(result.confirmed, true, JSON.stringify(result.details));
  assert.equal(result.details.app.owned, true);
  assert.equal(JSON.stringify(result.psCalls.at(-1)), JSON.stringify(['-ww', '-o', 'args=', '-p', '42']));
});

test('the owned quit also ends a normal cell, through the app instead of window by window', () => {
  const result = cleanupHost({ ownedArg, processArgs: `Fixture ${ownedArg}` });
  assert.equal(result.events.some(e => e.stage === 'ready'), true);
  assert.equal(result.terminations, 1);
  assert.equal(result.confirmed, true);
  assert.equal(result.details.app.owned, true);
});

for (const [name, options] of [
  ['its arguments lack the profile', { processArgs: `Fixture --user-data-dir=${MAC_TMP}/sleight-battery-unit/pair/p2` }],
  ['the profile is only a prefix of an argument', { processArgs: `Fixture ${ownedArg}x` }],
  ['the app was already running', { wasRunning: true, processArgs: `Fixture ${ownedArg}` }],
]) test(`an instance is not owned when ${name}`, () => {
  const result = cleanupHost({ documentStatus: -25205, ownedArg, ...options });
  assert.notEqual(result.details?.app?.owned, true);
  assert.equal(result.terminations, 0);
  assert.equal(result.confirmed, false);
});

test('a target passed in the launch arguments is not also opened as a document', async t => {
  const { startHost } = await load('runtime');
  const dir = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-battery-test-'))));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = launchRecorder({ ownArgv: true });
  const target = join(dir, 'AM1-folder'), profile = join(dir, 'p');
  mkdirSync(target); mkdirSync(profile);
  const host = await startHost({ bundle: 'org.example.fixture' }, { dir, target, targetInArgs: true,
    launchArgs: [`--user-data-dir=${profile}`, '--new-window', target], ownedArg: `--user-data-dir=${profile}` }, new AbortController().signal, recorder.runProcess);
  assert.deepEqual(recorder.launches, [['-g', '-b', 'org.example.fixture', '--args', `--user-data-dir=${profile}`, '--new-window', target]]);
  assert.equal(recorder.request.ownedArg, `--user-data-dir=${profile}`);
  recorder.done(); await host.finish();
});

test('an owned-instance argument outside the fixture folder or absent from the launch is not passed', async t => {
  const { startHost } = await load('runtime'), dir = bank(t);
  for (const ctx of [{ launchArgs: [`--user-data-dir=${MAC_TMP}/elsewhere`], ownedArg: `--user-data-dir=${MAC_TMP}/elsewhere` },
    { launchArgs: ['--new-window'], ownedArg: `--user-data-dir=${join(dir, 'p')}` }]) {
    const recorder = launchRecorder({ ownArgv: true });
    const host = await startHost({ bundle: 'org.example.fixture' }, { dir, target: join(dir, 'f'), ...ctx }, new AbortController().signal, recorder.runProcess);
    assert.equal(recorder.request.ownedArg, undefined, JSON.stringify(ctx));
    recorder.done(); await host.finish();
  }
});

test('host ownership rejects aliases, traversal, missing paths and banks outside the exact temp prefix', async t => {
  const { startHost } = await load('runtime');
  const dir = realpathSync(bank(t)), target = join(dir, 'AM1-unique.txt'), profile = join(dir, 'profile');
  writeFileSync(target, 'x'); mkdirSync(profile);
  const alias = join(dir, 'alias'); symlinkSync(target, alias);
  const linkedProfile = join(dir, 'linked-profile'); symlinkSync(profile, linkedProfile);
  const linkedBank = join(dir, 'linked-bank'); symlinkSync(dir, linkedBank);
  const unprefixed = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'foreign-battery-'))));
  t.after(() => rmSync(unprefixed, { recursive: true, force: true }));
  const foreign = join(unprefixed, 'sleight-battery-nested'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'AM1-unique.txt'), 'x');
  for (const [root, path] of [
    [dir, alias], [linkedBank, join(linkedBank, 'AM1-unique.txt')],
    [dir, `${dir}/./AM1-unique.txt`], [dir, join(dir, 'missing')],
    [foreign, join(foreign, 'AM1-unique.txt')],
  ]) {
    const recorder = launchRecorder();
    const host = await startHost({ bundle: 'org.example.fixture', fixtureKind: 'doc-file' },
      { dir: root, path, target: path, windowMarker: 'AM1-unique' }, new AbortController().signal, recorder.runProcess);
    try {
      assert.equal(recorder.request.fixturePath, undefined, path);
      assert.equal(recorder.request.windowMarker, undefined, path);
    } finally { recorder.done(); await host.finish(); }
  }
  for (const path of [linkedProfile, `${dir}/../outside`, `${dir}/./profile`, dir, join(dir, 'missing'), dir + '-sibling/profile']) {
    const ownedArg = `--user-data-dir=${path}`, recorder = launchRecorder();
    const host = await startHost({ bundle: 'org.example.fixture' },
      { dir, target, ownedArg, launchArgs: [ownedArg] }, new AbortController().signal, recorder.runProcess);
    try { assert.equal(recorder.request.ownedArg, undefined, path); }
    finally { recorder.done(); await host.finish(); }
  }
});

test('host ownership accepts the canonical system temp bank and a production-shaped pair directory', async t => {
  const { startHost } = await load('runtime');
  const root = realpathSync(bank(t)), dir = join(root, 'textedit-1'); mkdirSync(dir);
  const path = join(dir, 'AM1-unique.txt'), profile = join(dir, 'profile');
  writeFileSync(path, 'x'); mkdirSync(profile);
  const ownedArg = `--user-data-dir=${profile}`, recorder = launchRecorder();
  const host = await startHost({ bundle: 'org.example.fixture', fixtureKind: 'doc-file' },
    { dir, path, target: path, windowMarker: 'AM1-unique', ownedArg, launchArgs: [ownedArg] },
    new AbortController().signal, recorder.runProcess);
  try {
    assert.equal(recorder.request.fixturePath, path);
    assert.equal(recorder.request.windowMarker, 'AM1-unique');
    assert.equal(recorder.request.ownedArg, ownedArg);
  } finally { recorder.done(); await host.finish(); }
});

test('host ownership keeps a unique folder title marker for a canonical owned directory', async t => {
  const { startHost } = await load('runtime');
  const dir = realpathSync(bank(t)), target = join(dir, 'AM1-unique-folder'); mkdirSync(target);
  const recorder = launchRecorder();
  const host = await startHost({ bundle: 'org.example.fixture' },
    { dir, target, windowMarker: 'AM1-unique-folder' }, new AbortController().signal, recorder.runProcess);
  try { assert.equal(recorder.request.windowMarker, 'AM1-unique-folder'); }
  finally { recorder.done(); await host.finish(); }
});

test('host ownership preserves the legacy production bank only on macOS', () => {
  const source = readFileSync(new URL('../bench/battery/runtime.mjs', import.meta.url), 'utf8');
  const checks = source.slice(source.indexOf('function canonicalPath('), source.indexOf('function codexTurns('));
  for (const platform of ['darwin', 'linux']) {
    const system = join('/', 'canonical-system-temp');
    const own = runInNewContext(`${checks}; ownedFixtureRoot`, {
      realpathSync: value => value, lstatSync: () => ({ isDirectory: () => true }),
      tmpdir: () => system, process: { platform }, relative, resolve, sep,
    });
    assert.equal(own(join(system, 'sleight-battery-nonce', 'word-1')), true);
    assert.equal(own(`${MAC_TMP}/sleight-battery-nonce/word-1`), platform === 'darwin');
    assert.equal(own(join(system, 'unrelated', 'sleight-battery-nonce')), false);
    assert.equal(own(join(system, 'sleight-battery-')), false);
    assert.equal(own(join(system + '-sibling', 'sleight-battery-nonce')), false);
  }
});
