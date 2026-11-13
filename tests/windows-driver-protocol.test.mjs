import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { createWindowsDriverClient, DRIVER_PROTOCOL } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { compileWindowsHost, prepareWindowsHandHost, windowsDriverSources, windowsHostSources, windowsHostExecutable } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { WINDOW_HEADER, windowFromText, elementLines, elementParents } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor, GUARD_MARK, hasFullTree } from '../plugins/sleight/lib/compact-reads.mjs';
import { notepadNodes, calculatorNodes, serializeFixtureTree } from './fixtures/windows-driver-fake.mjs';

const fake = fileURLToPath(new URL('./fixtures/windows-driver-fake.mjs', import.meta.url));
function fixture(t, scenarios = [], options = {}) {
  const children = [], nonces = [];
  const client = createWindowsDriverClient({ platform: 'win32', ...options, prepare: async opts => {
    assert.equal(opts.kind, 'driver'); assert.equal(opts.platform, 'win32');
    return { status: 'ready', spawn({ nonce }) {
      nonces.push(nonce);
      const child = spawn(process.execPath, [fake, scenarios[children.length] ?? 'normal'], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce },
      }); children.push(child); return child;
    } };
  } });
  t.after(() => client.close());
  return { client, children, nonces };
}

test('non-Windows calls refuse before preparing, while import and construction are inert', async () => {
  let calls = 0;
  const client = createWindowsDriverClient({ platform: 'darwin', prepare() { calls++; assert.fail(); } });
  await assert.rejects(client.getState(), { code: 'PLATFORM' }); assert.equal(calls, 0); await client.close();
});
test('Notepad and Calculator reads share one child, carry identity, and number in tree order', async t => {
  const { client, children } = fixture(t);
  assert.equal((await client.ping()).protocol, DRIVER_PROTOCOL);
  const state = await client.getState(); assert.equal(state.apps.length, 2); assert.equal(state.windows.length, 2);
  assert.deepEqual(await client.listApps(), state);
  const note = await client.getApp('Notepad'), calc = await client.getApp({ windowId: '102' });
  assert.equal(children.length, 1); assert.equal(note.readId, 1); assert.equal(calc.readId, 2);
  assert.equal(typeof note.window.processStart, 'string'); assert.equal(note.window.windowId, '101');
  assert.equal((await client.getAXState('102', { processStart: calc.window.processStart })).window.app, 'Calculator');
  assert.equal(elementLines(note.text).size, 5); assert.equal(elementLines(calc.text).size, 7);
  assert.equal(elementParents(calc.text).get(3), 'group Number pad');
});
test('method and target refusals preserve the warm child', async t => {
  const { client, children } = fixture(t);
  await assert.rejects(client.request('click', { number: 3 }), { code: 'METHOD_NOT_FOUND', unhealthy: false });
  await assert.rejects(client.getApp('Absent'), { code: 'WINDOW_NOT_FOUND' });
  await assert.rejects(client.request('getAXState', { windowId: '101', processStart: '1' }), { code: 'IDENTITY_CHANGED' });
  await client.ping(); assert.equal(children.length, 1);
});
test('OUTPUT_LIMIT is a request refusal and preserves the warm child', async t => {
  const { client, children } = fixture(t, ['output-limit']);
  await assert.rejects(client.getApp('Notepad'), { code: 'OUTPUT_LIMIT', unhealthy: false });
  assert.equal((await client.ping()).protocol, DRIVER_PROTOCOL);
  assert.equal(children.length, 1);
});
test('concurrent calls share preparation and correlate their response ids', async t => {
  const { client, children } = fixture(t);
  const results = await Promise.all([client.getApp('Calculator'), client.getApp('Notepad'), client.getState()]);
  assert.equal(results[0].window.app, 'Calculator'); assert.equal(results[1].window.app, 'Notepad');
  assert.equal(results[2].windows.length, 2); assert.equal(children.length, 1);
});
test('split byte delivery preserves UTF-8 framing', async t => {
  const { client } = fixture(t, ['split']);
  assert.match((await client.getApp('Notepad')).text, /Hello 日本 🪄/);
});
for (const [scenario, code] of [['nonce', 'DRIVER_PROTOCOL'], ['id', 'DRIVER_PROTOCOL'], ['protocol', 'DRIVER_PROTOCOL'],
  ['extra', 'DRIVER_PROTOCOL'], ['invalid-json', 'DRIVER_PROTOCOL'], ['invalid-utf8', 'DRIVER_PROTOCOL'],
  ['partial', 'DRIVER_PROTOCOL'], ['exit', 'DRIVER_EXIT'], ['oversize', 'DRIVER_LINE_LIMIT'], ['unhealthy', 'DEADLINE_EXCEEDED']]) {
  test(`${scenario} retires the child; the next explicit call gets a fresh nonce`, async t => {
    const { client, children, nonces } = fixture(t, [scenario], { lineLimit: 2048 });
    await assert.rejects(client.ping(), { code, unhealthy: true });
    assert.equal((await client.ping()).protocol, DRIVER_PROTOCOL); assert.equal(children.length, 2);
    assert.notEqual(nonces[0], nonces[1]); assert.match(nonces[1], /^[a-f0-9]{64}$/);
    assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
  });
}
test('deadline failure rejects all pending calls and never replays either request', async t => {
  const { client, children } = fixture(t, ['stall']);
  const results = await Promise.allSettled([client.ping({ timeoutMs: 150 }), client.getState()]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'DEADLINE_EXCEEDED'); }
  assert.equal(children.length, 1); await client.ping(); assert.equal(children.length, 2);
});
test('explicit restart invalidates the old child and close prevents future preparation', async t => {
  const { client, children } = fixture(t);
  await client.ping(); await client.restart(); await client.ping(); assert.equal(children.length, 2);
  await client.close(); await assert.rejects(client.ping(), { code: 'DRIVER_CLOSED' }); assert.equal(children.length, 2);
});
test('invalid budgets and oversized requests fail without writes', async t => {
  assert.throws(() => createWindowsDriverClient({ timeoutMs: 0 }), { code: 'INVALID_PARAMS' });
  const { client } = fixture(t, [], { lineLimit: 512 });
  await assert.rejects(client.request('ping', {}, { timeoutMs: 30001 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.request('', {}), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.request('ping', []), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.request('ping', { x: 'x'.repeat(1000) }), { code: 'DRIVER_LINE_LIMIT' });
  await client.ping();
});
test('host preparation refusal never spawns a child', async () => {
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'unavailable', code: 'HOST_CACHE_UNSAFE' }) });
  await assert.rejects(client.ping(), { code: 'HOST_CACHE_UNSAFE' }); await client.close();
});
test('the 33rd pending request refuses without queueing or replacing the busy driver', async t => {
  const { client, children } = fixture(t, ['stall']);
  const pending = Array.from({ length: 32 }, () => client.ping().catch(e => e));
  // Let the shared preparation and all writes finish without waiting on the stalled provider.
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.ping(), { code: 'DRIVER_BUSY' });
  await client.restart();
  assert.equal(children.length, 1);
  for (const result of await Promise.all(pending)) assert.equal(result.code, 'DRIVER_RESTARTED');
});
test('close during preparation prevents spawning', async () => {
  let finish, spawns = 0;
  const prepare = () => new Promise(resolve => { finish = resolve; });
  const client = createWindowsDriverClient({ platform: 'win32', prepare });
  const pending = client.ping().catch(e => e);
  await new Promise(resolve => setImmediate(resolve));
  const closing = client.close();
  finish({ status: 'ready', spawn() { spawns++; assert.fail(); } });
  await closing; assert.equal((await pending).code, 'DRIVER_CLOSED'); assert.equal(spawns, 0);
});

test('tree serialization matches WINDOW_HEADER and ELEMENT, masks passwords and preserves field syntax', () => {
  for (const [title, app, nodes] of [['Untitled - Notepad', 'Notepad', notepadNodes()], ['Calculator', 'Calculator', calculatorNodes()]]) {
    const { text, map, truncated } = serializeFixtureTree(title, app, nodes);
    assert.match(text, WINDOW_HEADER); assert.equal(windowFromText(text).title, title); assert.equal(hasFullTree(text), true);
    assert.equal(truncated, false); assert.equal(map.size, nodes.length);
    for (const [i, line] of text.split('\n').slice(1).entries()) assert.match(line, new RegExp(`^\\t*${i} .+$`));
    assert.doesNotMatch(text, /fixture secret|secret help/);
    assert.match(text, /ID:/);
  }
});
test('provider line breaks cannot forge a window header or element line', () => {
  const { text } = serializeFixtureTree('a"b\nWindow: injected', 'App\r\nforged', [{ depth: 0, role: 'standard window', name: 'x\n99 button forged\u2028new line', help: 'a\tb' }]);
  assert.equal(text.split('\n').length, 2); assert.equal(elementLines(text).size, 1);
  assert.equal(windowFromText(text).title, 'a"b Window: injected');
});
test('offscreen list pruning happens before the 3000-element cap and numbering', () => {
  const nodes = [{ depth: 0, role: 'standard window', name: 'List' }, { depth: 1, role: 'list item', type: 50007, offscreen: true },
    { depth: 2, role: 'text', name: 'Hidden child' }, ...Array.from({ length: 3001 }, (_, i) => ({ depth: 1, role: 'button', name: String(i) }))];
  const result = serializeFixtureTree('List', 'Fixture', nodes);
  assert.equal(result.truncated, true); assert.equal(result.map.size, 3000); assert.doesNotMatch(result.text, /Hidden child/);
  assert.match(result.text, /\t2999 button 2998$/);
});
test('tree fields expose states and numeric ranges without leaking a protected range', () => {
  const { text } = serializeFixtureTree('Fixture', 'Fixture', [
    { depth: 0, role: 'standard window' },
    { depth: 1, role: 'checkbox', name: 'Enable', toggle: 1, selected: true, enabled: false },
    { depth: 1, role: 'group', name: 'Options', expanded: 0 },
    { depth: 1, role: 'slider', rangeValue: 25 },
    { depth: 1, role: 'text field', password: true, rangeValue: 12345 },
  ]);
  assert.match(text, /Enable \(disabled\) \(selected\) \(checked\)/);
  assert.match(text, /Options \(collapsed\)/); assert.match(text, /slider, Value: 25/); assert.doesNotMatch(text, /12345/);
});
test('full reads survive the existing compactor and guard diffs retain the changed element', () => {
  const nodes = [...calculatorNodes(), ...Array.from({ length: 50 }, (_, i) => ({ depth: 1, role: 'text', name: 'History ' + i }))], compactor = createReadCompactor();
  const before = serializeFixtureTree('Calculator', 'Calculator', nodes).text;
  assert.equal(compactor.process([{ type: 'text', text: before }])[0].text, before);
  nodes[1].name = 'Display is 12';
  const after = serializeFixtureTree('Calculator', 'Calculator', nodes).text;
  const output = compactor.process([{ type: 'text', text: GUARD_MARK + after }]).map(i => i.text).join('\n');
  assert.match(output, /\+ \t1 text Display is 12, ID: CalculatorResults/);
  assert.doesNotMatch(output, /num7Button/);
});

const native = name => readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url), 'utf8');
test('native string selector matching excludes refused windows and popups before testing private fields', () => {
  assert.match(native('DriverInventory.cs'), /windows\.Where\(w => w\.Refused == null && !w\.Popup && new\[\] \{ w\.App, w\.Image, w\.Aumid, w\.Title \}/);
});
test('native sources exclude input, managed UIA, windows and network transport', () => {
  for (const name of ['Driver.cs', 'DriverUia.cs', 'DriverInventory.cs']) {
    const source = native(name);
    assert.doesNotMatch(source, /SendInput|SetForegroundWindow|AttachThreadInput|SetFocus|BringWindowToTop|ShowWindow|MoveWindowToDesktop|PostMessage|SendMessage|SetWindowPos|MoveWindow/);
    assert.doesNotMatch(source, /System\.Windows\.Automation|System\.Windows\.Forms|CreateWindow|TcpClient|NamedPipeServerStream/);
    assert.doesNotMatch(source, /\$"|\?\.|nameof\(|using var /, 'C# 5 syntax');
  }
  assert.match(native('Program.cs'), /^#if SLEIGHT_DRIVER[\s\S]*Driver\.Entry\(args\)/);
  assert.match(native('Driver.cs'), /--driver-selftest/); assert.match(native('Driver.cs'), /"drawing", false/);
});
test('native reads fetch one element at a time with full references and protected values masked', () => {
  const source = native('DriverUia.cs');
  assert.equal([...source.matchAll(/automation\.ElementFromHandleBuildCache\(/g)].length, 1);
  assert.match(source, /cache\.PutTreeScope\(1\)/); assert.match(source, /cache\.PutElementMode\(1\)/);
  assert.match(source, /GetFirstChildElementBuildCache/); assert.match(source, /GetNextSiblingElementBuildCache/);
  assert.doesNotMatch(source, /PutTreeScope\(7\)/);
  assert.match(source, /PutAutomaticFocus\(false\)/); assert.match(source, /PutConnectionTimeout\(1000\)/);
  assert.match(source, /PutTransactionTimeout\(2000\)/); assert.match(source, /if \(!node\.Password\)/);
  assert.match(source, /node\.Password \? "<redacted>"/);
  assert.match(source, /LineBudget = 3000/); assert.match(source, /RuntimeId = read\(RuntimeId, true\) as int\[\]/);
  assert.match(source, /return !\(value is bool\) \|\| \(bool\)value/, 'unknown password state masks');
  assert.match(source, /"Window: " \+ Json\.Codec\.Serialize\(Clean\(title\)\) \+ ", App: "/);
});
test('provider policy distinguishes text controls and treats unsupported enabled state as enabled', () => {
  const source = native('DriverUia.cs');
  assert.match(source, /Password\(read, \(int\)type\)/);
  assert.match(source, /read\(IsPassword, sensitive\)/);
  for (const id of [50003, 50004, 50025, 50030, 50033]) assert.match(source, new RegExp(`case ${id}:`));
  assert.match(source, /Enabled\(read\(IsEnabled, true\)\)/);
  assert.match(source, /internal static bool Enabled\(object value\)/);
});
test('identity checks include HWND and fresh headers but exclude title changes', () => {
  const source = native('DriverUia.cs'), inventory = native('DriverInventory.cs');
  assert.match(source, /window\.SameIdentity\(after\)/);
  assert.match(source, /Serialize\(after\.Title, after\.App/);
  assert.match(inventory, /Handle == other\.Handle/);
  assert.doesNotMatch(source, /after\.Title != window\.Title/);
});
test('tree and response limits return partial trees or a correlated OUTPUT_LIMIT refusal', () => {
  const source = native('DriverUia.cs'), driver = native('Driver.cs');
  assert.match(source, /TextBudget = 1024 \* 1024/);
  assert.match(source, /Encoding\.UTF8\.GetByteCount/);
  assert.match(source, /DepthBudget = 32/);
  assert.match(source, /FetchCallBudget = 6000/);
  assert.match(source, /"partialTree", partial/);
  assert.match(driver, /ResponseLine\(response\)/);
  assert.match(driver, /catch \(InvalidOperationException\)/);
  assert.match(driver, /"OUTPUT_LIMIT"[\s\S]*"unhealthy", false/);
});
test('refused inventory strips provider content in window and app records', () => {
  const source = native('DriverInventory.cs');
  assert.match(source, /"image", Refused == null \|\| Refused == "ELEVATED_TARGET" \? Image : null/);
  assert.match(source, /"title", Refused == null \? Title : null/);
  assert.match(source, /"aumid", Refused == null \? Aumid : null/);
  assert.match(source, /"id", first\.Refused == null \? first\.Aumid \?\? first\.Image : null/);
});
test('COM read subset preserves SDK slot indices, GUIDs and BOOL/VARIANT marshalling', () => {
  const source = native('DriverUia.cs');
  const slots = name => source.match(new RegExp(`interface ${name}\\n\\{([\\s\\S]*?)\\n\\}`))[1]
    .replace(/\/\/[^\n]*/g, '').replace(/\[[^\]]*\]/g, '').match(/\w+\([^;]*?\);/g).map(m => m.slice(0, m.indexOf('(')));
  assert.equal(slots('IUIAutomation')[7], 'ElementFromHandleBuildCache');
  assert.equal(slots('IUIAutomation')[11], 'ControlViewWalker');
  assert.equal(slots('IUIAutomation')[15], 'ControlViewCondition'); assert.equal(slots('IUIAutomation')[17], 'CreateCacheRequest');
  assert.equal(slots('IUIAutomation2')[55], 'GetAutomaticFocus'); assert.equal(slots('IUIAutomation2')[60], 'PutTransactionTimeout');
  assert.equal(slots('IUIAutomationElement')[10], 'GetCachedPropertyValueEx'); assert.equal(slots('IUIAutomationElement')[16], 'GetCachedChildren');
  assert.equal(slots('IUIAutomationTreeWalker')[7], 'GetFirstChildElementBuildCache');
  assert.equal(slots('IUIAutomationTreeWalker')[9], 'GetNextSiblingElementBuildCache');
  assert.match(source, /Guid\("34723aff-0c9d-49d0-9896-7ab52df8cd8a"\)/);
  assert.match(source, /MarshalAs\(UnmanagedType\.Struct\)/); assert.match(source, /MarshalAs\(UnmanagedType\.Bool\)/);
});
test('inventory and loop source checks cover the platform observations and deadline worker', () => {
  const source = native('DriverInventory.cs');
  for (const api of ['EnumWindows', 'DwmGetWindowAttribute', 'IsWindowOnCurrentVirtualDesktop', 'GetApplicationUserModelId',
    'GetTokenInformation', 'GetProcessTimes', 'ProcessIdToSessionId', 'PopupFor']) assert.ok(source.includes(api), api);
  assert.match(source, /ELEVATED_TARGET/); assert.match(source, /MINIMIZED_PACKAGED_WINDOW/); assert.match(source, /AMBIGUOUS_APP/);
  const driver = native('Driver.cs');
  assert.match(driver, /SLEIGHT_DRIVER_NONCE/); assert.match(driver, /r\.Id <= previous/);
  assert.match(driver, /ApartmentState\.MTA/); assert.match(driver, /Done\.WaitOne/); assert.match(driver, /return 70/);
  assert.match(driver, /new UTF8Encoding\(false, true\)/);
  assert.match(driver, /Json\.UniqueKeys\(line\)/); assert.match(driver, /\[ThreadStatic\]/);
});
test('UIA roles use the SDK control-type ids including Calendar before CheckBox', () => {
  const source = native('DriverUia.cs');
  for (const [id, role] of [[50001, 'calendar'], [50002, 'checkbox'], [50004, 'text field'], [50007, 'list item'], [50020, 'text']])
    assert.ok(source.includes(`case ${id}: return "${role}"`));
});

test('driver build uses separate hashed source bank, receipt and executable with fixed spawn arguments', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wdr1-build-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), cacheRoot = join(root, 'cache'), compiler = join(root, 'csc.exe');
  mkdirSync(sourceRoot); writeFileSync(compiler, 'fake compiler');
  for (const name of windowsDriverSources) writeFileSync(join(sourceRoot, name), 'source:' + name);
  const calls = [], options = { platform: 'win32', kind: 'driver', sourceRoot, cacheRoot, compiler,
    access(checks) { for (const [op, path] of checks) if (op === 'create') mkdirSync(path, { recursive: true }); },
    async compile({ sources, binary }) { calls.push(sources); assert.ok(binary.endsWith('driver-host.exe')); writeFileSync(binary, 'fake driver'); },
    run(file, args, options) { calls.push({ file, args, options }); return {}; } };
  const built = await prepareWindowsHandHost(options); assert.equal(built.status, 'ready', JSON.stringify(built));
  assert.ok(windowsHostExecutable(built.receipt, { platform: 'win32' }).endsWith('driver-host.exe'));
  assert.equal(calls[0].length, windowsDriverSources.filter(name => name.endsWith('.cs')).length);
  assert.equal(windowsHostSources.includes('Driver.cs'), false);
  assert.equal(windowsHostSources.includes('DriverCapture.cs'), false);
  assert.equal(windowsHostSources.includes('DriverIdentity.cs'), false);
  const record = JSON.parse(readFileSync(built.record));
  assert.equal(record.binaries['driver-host.exe'], createHash('sha256').update('fake driver').digest('hex'));
  assert.equal(existsSync(join(built.directory, 'cursor-host.exe')), false);
  assert.throws(() => built.spawn({ nonce: 'bad' }), /DRIVER_NONCE_INVALID/);
  built.spawn({ nonce: 'a'.repeat(64) });
  assert.deepEqual(calls[1].args, ['--driver']); assert.deepEqual(calls[1].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[1].options.env.SLEIGHT_DRIVER_NONCE, 'a'.repeat(64)); assert.equal(calls[1].options.shell, undefined);
  assert.equal((await prepareWindowsHandHost(options)).status, 'ready'); assert.equal(calls.length, 2);
});
test('driver compiler vector uses only in-box framework references and the driver entry define', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  let args;
  const result = compileWindowsHost({ sources: windowsDriverSources.filter(s => s.endsWith('.cs')).map(s => 'C:\\source\\' + s),
    binary: 'C:\\bank\\driver-host.exe', compiler: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    run(_file, vector) { args = vector; queueMicrotask(() => child.emit('close', 0)); return child; } });
  await result;
  assert.ok(args.includes('/define:SLEIGHT_DRIVER')); assert.ok(args.includes('/main:Sleight.Cursor.Program'));
  assert.equal(args.some(arg => arg.includes('SLEIGHT_TEST_SEAMS')), false);
  assert.deepEqual(args.filter(a => a.startsWith('/r:')).map(a => win32.basename(a)), ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll']);
  assert.doesNotMatch(args.join(' '), /UIAutomationClient|Windows\.Forms/);
});

test('action watchdog permits native cleanup grace and preserves the uncertain-input error', async t => {
  let killed = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { killed++; queueMicrotask(() => child.emit('close', 70)); };
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close());
  child.stdin.on('data', bytes => {
    const r = JSON.parse(bytes.toString());
    if (r.method === 'turn-start') {
      child.stdout.write(JSON.stringify({ protocol: r.protocol, nonce: r.nonce, id: r.id, ok: true,
        result: { turn: r.params.turn, active: true } }) + '\n');
      return;
    }
    setTimeout(() => child.stdout.write(JSON.stringify({ protocol: r.protocol, nonce: r.nonce, id: r.id, ok: false,
      error: { code: 'DEADLINE_EXCEEDED', message: 'Input may have landed; cleanup completed.', unhealthy: true } }) + '\n'), 100);
  });
  await assert.rejects(client.typeText({ windowId: '101', processStart: '3', readId: 1 }, ['a'], { timeoutMs: 30 }),
    { code: 'DEADLINE_EXCEEDED', message: 'Input may have landed; cleanup completed.', unhealthy: true });
  assert.equal(killed, 1);
});
