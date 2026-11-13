import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseSittingArgs, sittingPlan, percentile, summarize, validateResult, runSitting as actualRunSitting, main as actualMain,
  selftestArguments, fixtureArguments, focusVerdict, runSafetyChecks, executeStep, createFixtureBatch, assertStandardUser, supportsBatch } from '../bench/windows/driver-sitting.mjs';
import { createWindowsReplClient } from '../plugins/sleight/lib/windows-repl/client.mjs';
import { startFixtureServer } from '../bench/windows/driver-fixture-server.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { redactReport } from '../bench/windows/kit.mjs';
import * as sitting from '../bench/windows/driver-sitting.mjs';
import { createAttestation } from '../bench/windows/uc3f-export.mjs';

const safetyContext = { revision: 'a'.repeat(40), kitManifestSha256: 'b'.repeat(64), exporterSha256: 'c'.repeat(64),
  observerSha256: 'd'.repeat(64), userSidSha256: 'e'.repeat(64), vm: { vmId: 'fixture', manufacturer: 'QEMU',
    model: 'Virtual Machine', build: 26200, hostnameSha256: 'f'.repeat(64), machineGuidSha256: '1'.repeat(64) } };
const runSitting = (o, deps = {}) => actualRunSitting({ ...o,
  ...o.safetyEvidence ? { safetyAttestation: o.safetyEvidence + '.attestation.json' } : {} },
{ assertUnelevated: async () => {}, batchSupported: true, safetyContext, ...deps });
const main = (o, deps = {}) => actualMain(o, { assertVm: async () => {}, assertUnelevated: async () => {}, batchSupported: true, ...deps });
const opts = extra => ({ phase: 'all', runs: 20, dpi: 100, origin: 'standard', size: 'compact', revision: 'a'.repeat(40), ...extra });
const geometry = { exposure: 'covered', dpi: 96, clientOrigin: [0, 0], clientSize: [1920, 1080], monitors: [[0, 0, 2560, 1440]] };
const window = { windowId: '12', processStart: '123', pid: 2, integrity: 'medium', image: 'C:\\Windows\\Notepad.exe', title: 'driver-notepad.txt - Notepad', app: 'Notepad' };
const read = text => ({ window, text: text ?? 'Window: "fixture", App: Notepad.\n0 standard window fixture\n\t1 text field Editor, ID: Editor, Value: abc (focused)', readId: 1, geometry });
const clean = { startedUtc: new Date().toISOString(), initial: { hwnd: '0x63', ms: 0 }, final: { hwnd: '0x63', ms: 120000 }, transitions: [], clicks: [], hookInstalled: true, hookRemoved: true, callbackError: false, truncated: false };

test('strict arguments: defaults, decimal HWNDs, fixed phases and bounded trials', () => {
  assert.deepEqual(parseSittingArgs(['--dry-run']), opts({ revision: undefined, dryRun: true }));
  const o = parseSittingArgs(['--phase', 'core', '--runs', '20', '--notepad', '12', '--dpi', '150', '--origin', 'negative', '--size', 'large', '--output', 'x.json', '--revision', 'a'.repeat(40)]);
  assert.equal(o.notepad, '12'); assert.equal(o.dpi, 150);
  for (const args of [[], ['--wat'], ['--dry-run', 'xxnotepad', '12'], ['--dry-run', '--dry-run'], ['--phase', 'oops'], ['--runs', '21'], ['--runs', '0'], ['--notepad', '0'], ['--notepad', '0x12'], ['--dpi', '175'], ['--origin', 'left'], ['--size', '800x600'], ['--revision', 'main']])
    assert.throws(() => parseSittingArgs(args), JSON.stringify(args));
});

test('dry plan names every study step, safety row, toolkit action and DPI cell', () => {
  const plan = sittingPlan(opts());
  for (const id of ['build', 'selftest', 'inventory', 'read-notepad', 'read-calculator', 'read-edge', 'invoke-calculator', 'setvalue-notepad', 'type-notepad', 'return-notepad', 'escape-calculator', 'save-notepad', 'batch-calculator', 'capture-notepad', 'capture-calculator', 'capture-edge', 'decline-no-read', 'terminal-refused', 'elevated-refused'])
    assert.ok(plan.some(s => s.id === id), id);
  assert.equal(plan.filter(s => s.phase === 'dpi').length, 8);
  assert.equal(sittingPlan({ phase: 'inventory' })[0].trials, 1);
  for (const toolkit of ['win32', 'winui', 'wpf', 'chromium']) for (const action of ['value', 'wmchar', 'chord'])
    assert.ok(plan.some(s => s.id === `toolkit-${toolkit}-${action}`));
});

test('vectors use fixed non-drawing host mode and PowerShell File, never Command', () => {
  assert.deepEqual(selftestArguments(), ['--driver-selftest']);
  const v = fixtureArguments('cover');
  assert.equal(v.includes('-Command'), false); assert.equal(v[v.indexOf('-Mode') + 1], 'cover');
  assert.ok(v.includes('-STA')); assert.throws(() => fixtureArguments('bad'));
});

test('nearest-rank percentiles and pass counts include failures without inventing samples', () => {
  assert.equal(percentile([], .5), null); assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), .9), 18);
  const s = summarize([{ status: 'pass', elapsedMs: 10 }, { status: 'fail', elapsedMs: 40 }, { status: 'skip', note: 'absent' }]);
  assert.deepEqual([s.pass, s.fail, s.skip, s.p50Ms, s.p90Ms], [1, 1, 1, 10, 40]);
  assert.deepEqual([s.passP50Ms, s.passP90Ms], [10, 10]);
});

test('observer requires full interval, cover in foreground, healthy hook and zero transitions/input', () => {
  assert.equal(focusVerdict(clean, { cover: '99', start: Date.parse(clean.startedUtc) + 10, end: Date.parse(clean.startedUtc) + 20 }).status, 'pass');
  for (const edit of [{ hookRemoved: false }, { callbackError: true }, { truncated: true }, { transitions: [{ hwnd: '0x1' }] }, { clicks: [{}] }, { final: { ms: 1 } }, { initial: { hwnd: '0x1' } }])
    assert.notEqual(focusVerdict({ ...clean, ...edit }, { cover: '99', start: Date.parse(clean.startedUtc) + 10, end: Date.parse(clean.startedUtc) + 20 }).status, 'pass');
});

test('dry run starts zero processes and writes no report, even on Windows', async t => {
  let calls = 0, printed = '';
  const spies = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name =>
    t.mock.method(childProcess, name, () => { calls++; throw Error('dry run started a process'); }));
  syncBuiltinESMExports();
  try {
    const report = await main(['--dry-run'], { platform: 'win32', prepare: () => calls++, createClient: () => calls++,
      observe: () => calls++, assertUnelevated: () => calls++, print: s => { printed += s; } });
    assert.equal(calls, 0); assert.equal(report.mode, 'dry-run');
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    for (const step of sittingPlan(opts())) assert.ok(printed.includes(step.id));
  } finally { for (const spy of spies) spy.mock.restore(); syncBuiltinESMExports(); }
});

test('real mode refuses Mac before preparing a host', async () => {
  let calls = 0;
  await assert.rejects(runSitting(opts(), { platform: 'darwin', prepare: () => calls++ }), /Windows/);
  assert.equal(calls, 0);
});

test('missing fixtures skip explicitly, partial result cannot qualify', async () => {
  const report = await runSitting(opts({ phase: 'core' }), { platform: 'win32', createClient: () => ({ request: async () => ({ windows: [] }), close: async () => {} }), now: () => 1 });
  assert.equal(report.verdict, 'incomplete'); assert.ok(report.steps.every(s => s.summary.pass === 0));
  assert.equal(validateResult(report), true);
});

test('schema refuses forged complete counts, missing timings and unredacted payload fields', async () => {
  const schema = JSON.parse(readFileSync(new URL('../bench/windows/driver-sitting.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.schema.const, 'sleight.windows-driver-sitting/1');
  assert.equal(schema.$defs.trial.additionalProperties, false); assert.equal(schema.$defs.trial.properties.text, undefined);
  const report = await runSitting(opts({ phase: 'core' }), { platform: 'win32', createClient: () => ({ close: async () => {} }), now: () => 1 });
  for (const alter of [r => { r.steps[0].summary.pass++; }, r => { r.steps[0].trials.push({ status: 'pass' }); }, r => { r.windows = [window]; }, r => { r.steps[0].trials[0].text = 'secret'; }]) {
    const copy = structuredClone(report); alter(copy); assert.throws(() => validateResult(copy));
  }
});

test('safe report writer excludes raw failure text and refuses existing outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdr7-'));
  try {
    const output = join(dir, 'result.json');
    const env = { USERPROFILE: 'D:\\People\\Alice', USERNAME: 'Alice', COMPUTERNAME: 'VM-ALICE' };
    await main(['--phase', 'build', '--output', output, '--revision', 'a'.repeat(40)], { platform: 'win32', env,
      prepare: async () => { throw Error('D:\\People\\Alice VM-ALICE'); }, print: () => {} });
    const bytes = readFileSync(output, 'utf8'); assert.doesNotMatch(bytes, /Alice|VM-ALICE|D:\\\\People/i);
    assert.equal(validateResult(JSON.parse(bytes)), true);
    await assert.rejects(main(['--phase', 'build', '--output', output, '--revision', 'a'.repeat(40)], { platform: 'win32' }), /already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writer applies WIN0 redaction and its profile/user/machine projection', async () => {
  const env = { USERPROFILE: 'D:\\People\\Alice', USERNAME: 'Alice', COMPUTERNAME: 'VM-ALICE' };
  const sample = redactReport({ note: 'D:\\People\\Alice\\cache C:\\Users\\Other\\cache Alice VM-ALICE' }, env);
  assert.doesNotMatch(sample.note, /D:\\People|C:\\Users|Alice|VM-ALICE/i);
  assert.match(sample.note, /%USERPROFILE%/);
  const dir = mkdtempSync(join(tmpdir(), 'wdr7-redaction-'));
  try {
    const output = join(dir, 'redacted.json');
    await main(['--phase', 'core', '--output', output, '--revision', 'a'.repeat(40)], {
      platform: 'win32', env: { USERNAME: 'preparing' }, print: () => {},
    });
    const text = readFileSync(output, 'utf8');
    assert.match(text, /%USERNAME%/); assert.doesNotMatch(text, /preparing/);
    assert.equal(validateResult(JSON.parse(text)), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('safety missing API skips 3 checks; matching dispatcher proves decline without content read', async () => {
  const absent = await runSafetyChecks(opts(), {}, null);
  assert.equal(absent.length, 3); assert.ok(absent.every(s => s.trials[0].status === 'skip'));
  let content = 0;
  const createWindowsSafety = ({ driver, approve }) => ({ close() {}, async request(_m, { selector }) {
    await driver.request('getState', {});
    if (selector.windowId === '12') { await approve({}); throw Object.assign(Error(), { code: 'APP_DECLINED' }); }
    throw Object.assign(Error(), { code: selector.windowId === '13' ? 'FORBIDDEN_TARGET' : 'ELEVATED_TARGET' });
  } });
  const rows = await runSafetyChecks(opts({ notepad: '12', terminal: '13', elevated: '14', elevatedPid: 2 }), { request: async method => {
    if (method !== 'getState') content++;
    return { windows: [window, { ...window, windowId: '13', image: 'C:\\WindowsTerminal.exe' }, { ...window, windowId: '14', refused: 'ELEVATED_TARGET' }] };
  } }, { createWindowsSafety });
  assert.equal(content, 0); assert.ok(rows.every(s => s.summary.pass === 1));
});

test('raw step checks observed contents; unchanged typing and wrong calculator result fail', async () => {
  const driver = { request: async method => method === 'getState' ? { windows: [window] } : read() };
  assert.equal((await executeStep({ id: 'type-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver)).status, 'fail');
  const calc = { ...window, image: 'C:\\CalculatorApp.exe', title: 'Calculator' };
  driver.request = async method => method === 'getState' ? { windows: [calc] } : ({ ...read('Window: "Calculator", App: Calculator.\n0 standard window Calculator\n1 button Clear, ID: clearButton\n2 button 7, ID: num7Button\n3 button Plus, ID: plusButton\n4 button 5, ID: num5Button\n5 button Equals, ID: equalButton\n6 text Display, ID: CalculatorResults, Value: 99'), window: calc });
  assert.equal((await executeStep({ id: 'invoke-calculator', target: 'calculator' }, opts({ calculator: '12' }), driver)).status, 'fail');
});

test('fixtures have exact 40 Notepad lines, 500 page controls and WPF automation ids', () => {
  assert.equal(readFileSync(new URL('../bench/windows/fixtures/driver-notepad.txt', import.meta.url), 'utf8').trimEnd().split('\n').length, 40);
  const ps = readFileSync(new URL('../bench/windows/fixtures/driver-wpf.ps1', import.meta.url), 'utf8');
  for (const id of ['Editor', 'InvokeButton', 'Status', 'ChordState']) assert.ok(ps.includes(id));
  const html = readFileSync(new URL('../bench/windows/fixtures/driver-page.html', import.meta.url), 'utf8');
  const buttons = [], marker = { textContent: 'Chord: saved 0' };
  let keydown;
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document: {
    createElement: () => ({}), querySelector: selector => selector === '#controls' ? { append: b => buttons.push(b) } : marker,
    addEventListener: (_event, callback) => { keydown = callback; },
  } });
  assert.equal(buttons.length + 1, 500); assert.equal(buttons.at(-1).id, 'wdr7-button-499');
  keydown({ ctrlKey: true, key: 's', preventDefault() {} }); assert.equal(marker.textContent, 'Chord: saved 1');
  keydown({ ctrlKey: true, key: 'S', preventDefault() {} }); assert.equal(marker.textContent, 'Chord: saved 2');
  assert.doesNotMatch(ps, /SendInput|SetForegroundWindow/);
});

function fakeDesktop({ dialogOpen = false, dismissDialogOnEscape = true } = {}) {
  const windows = [window, { ...window, windowId: '13', image: 'C:\\CalculatorApp.exe', title: 'Calculator' },
    { ...window, windowId: '14', title: 'Untitled - Notepad' },
    { ...window, windowId: '15', image: 'C:\\powershell.exe', title: 'Sleight WDR7 WPF' },
    { ...window, windowId: '16', image: 'C:\\msedge.exe', title: 'Sleight WDR7 page' }];
  let readId = 0, current, text = readFileSync(new URL('../bench/windows/fixtures/driver-notepad.txt', import.meta.url), 'utf8'), menu = false, dialog = dialogOpen, result = '0', actions = [], closed = false;
  const values = {}, chords = {}; let invocations = 0;
  const render = () => {
    const id = current.windowId;
    const editorId = id === '16' ? 'wdr7-editor' : 'Editor';
    const editorText = values[id] ?? (id === '12' ? text : '');
    const body = id === '13' ?
      `1 button Clear, ID: clearButton\n2 button 7, ID: num7Button\n3 button Plus, ID: plusButton\n4 button 5, ID: num5Button\n5 button Equals, ID: equalButton\n6 text Display, ID: CalculatorResults, Value: ${result}\n7 button Menu, ID: TogglePaneButton${menu ? '\n8 menu Modes' : ''}` :
      `1 text field Editor (focused), ID: ${editorId}, Value: ${editorText.replace(/[\r\n]/g, ' ')}${dialog ? '\n2 dialog Save As' : ''}` +
      (id === '15' ? `\n3 text Invoked: ${invocations}, ID: Status\n4 text Chord: saved ${chords[id] ?? 0}, ID: ChordState` : '') +
      (id === '16' ? `\n3 text Chord: saved ${chords[id] ?? 0}, ID: wdr7-chord\n` + '4 button fixture\n'.repeat(500) : '');
    return { ...read(`Window: "fixture", App: fixture.\n0 standard window fixture\n${body}`),
      window: current, readId: ++readId, route: 'WM_CHAR', settle: { elapsedMs: 120 } };
  };
  return {
    get actions() { return actions; }, get closed() { return closed; },
    async request(method, params) {
      assert.equal(closed, false);
      if (method === 'ping') return { protocol: 'sleight.windows-driver/1' };
      if (method === 'getState') return { windows };
      current = windows.find(w => w.windowId === (params.windowId ?? params.selector?.windowId));
      assert.ok(current);
      if (method === 'getAXState' || method === 'getApp') return render();
      assert.equal(params.readId, readId, 'every action must use the fresh map');
      actions.push([method, params.args]);
      if (method === 'setValue') values[current.windowId] = params.args[1];
      if (method === 'typeText') values[current.windowId] += params.args[0];
      if (method === 'pressKey') {
        if (params.args[0] === 'Return') values[current.windowId] += '\r\n';
        if (params.args[0] === 'ctrl+s') {
          if (current.title === 'Untitled - Notepad') dialog = true;
          else if (['15', '16'].includes(current.windowId)) chords[current.windowId] = (chords[current.windowId] ?? 0) + 1;
        }
        if (params.args[0] === 'Escape') { menu = false; if (dismissDialogOnEscape) dialog = false; }
      }
      if (method === 'click') {
        if (Array.isArray(params.args[0])) invocations++;
        if (params.args[0] === 1) result = '0';
        if (params.args[0] === 5) result = '12';
        if (params.args[0] === 7) menu = true;
      }
      return render();
    },
    async close() { closed = true; },
  };
}

test('20-trial core run verifies text, calculator, fresh maps and elapsed/settle distributions', async () => {
  const driver = fakeDesktop();
  const began = Date.now() - 1000;
  const report = await runSitting(opts({ phase: 'core', notepad: '12', 'notepad-untitled': '14', calculator: '13', cover: '99' }), {
    platform: 'win32', createClient: () => driver, now: () => began + 100,
    makeBatch: () => ({ run: async () => ({ ok: true, elapsedMs: 11, settleMs: 480, settleSamples: 4 }), close: async () => {} }),
    observe: async (_o, { onReady }) => { onReady(); return { observation: { ...clean, startedUtc: new Date(began).toISOString() } }; },
  });
  assert.equal(driver.closed, true);
  assert.equal(validateResult(report), true);
  assert.equal(report.verdict, 'incomplete'); // Edge was not supplied.
  for (const step of report.steps.filter(s => s.id !== 'read-edge')) {
    assert.equal(step.summary.pass, 20, step.id);
    assert.equal(step.summary.fail, 0, step.id);
    assert.equal(step.focus.status, 'pass', step.id);
    assert.ok(step.summary.p50Ms >= 0, step.id);
  }
  assert.equal(report.steps.find(s => s.id === 'batch-calculator').summary.batchP90Ms, 11);
  assert.equal(report.steps.find(s => s.id === 'invoke-calculator').summary.settleP50Ms, 120);
  assert.deepEqual(driver.actions.filter(a => a[0] === 'click').slice(0, 5).map(a => a[1]), [[1], [2], [3], [4], [5]]);
});

test('observer not ready performs zero input and an observer transition halts later steps', async () => {
  for (const ready of [false, true]) {
    const driver = fakeDesktop();
    const began = Date.now() - 1000;
    const report = await runSitting(opts({ phase: 'core', notepad: '12', 'notepad-untitled': '14', calculator: '13', cover: '99' }), {
      platform: 'win32', createClient: () => driver, now: () => began + 100,
      observe: async (_o, { onReady }) => {
        if (ready) onReady();
        return { observation: { ...clean, startedUtc: new Date(began).toISOString(), transitions: [{ hwnd: '0x1' }] } };
      },
    });
    assert.equal(report.verdict, 'failed'); assert.equal(driver.actions.length, 0);
    assert.equal(driver.closed, true); assert.equal(validateResult(report), true);
  }
});

test('discovery lists only fixed fixture aliases, never private inventory fields', async () => {
  const driver = fakeDesktop();
  const report = await runSitting(opts({ phase: 'inventory' }), { platform: 'win32', createClient: () => driver });
  assert.equal(report.verdict, 'passed-phase'); assert.equal(report.discovery.length, 5);
  assert.deepEqual(Object.keys(report.discovery[0]).sort(), ['pid', 'target', 'windowId']);
  assert.doesNotMatch(JSON.stringify(report), /driver-notepad.txt|Notepad.exe|processStart/);
  assert.equal(validateResult(report), true);
});

test('fixture server refuses Mac before creating a listener', () => {
  assert.throws(() => startFixtureServer({ platform: 'darwin' }), /Windows/);
});

test('DPI cell records actual negative geometry and advances the WPF counter exactly once', async () => {
  const w = { ...window, image: 'C:\\Windows\\powershell.exe', title: 'Sleight WDR7 WPF' };
  let value = 0, point;
  const g = { ...geometry, dpi: 144, clientOrigin: [-1800, 60], monitors: [[-1920, 0, 1920, 1080]] };
  const result = () => ({ ...read(`Window: "Sleight WDR7 WPF", App: powershell.\n0 standard window fixture\n1 text Invoked: ${value}, ID: Status`), window: w, geometry: g });
  const driver = { async request(method, params) {
    if (method === 'getState') return { windows: [w] };
    if (method === 'click') { point = params.args[0]; value++; }
    return result();
  } };
  const trial = await executeStep({ id: 'dpi-150-negative', target: 'wpf' }, opts({ wpf: '12', dpi: 150, origin: 'negative' }), driver);
  assert.equal(trial.status, 'pass'); assert.deepEqual(point, [150, 144]);
  assert.equal(trial.originX, -1800); assert.equal(trial.negativeMonitor, true);
  await assert.rejects(executeStep({ id: 'dpi-150-standard', target: 'wpf' }, opts({ wpf: '12', dpi: 150 }), driver), /STANDARD_ORIGIN_MISMATCH/);
});

test('capture rejects black, malformed or missing-display output without retaining screenshot bytes', async () => {
  for (const status of ['black', 'ok']) {
    const driver = { request: async method => method === 'getState' ? { windows: [window] } : method === 'getAXState' ? read() :
      ({ window, geometry, capture: { status }, screenshot: { mimeType: 'image/png', data: Buffer.from('not PNG').toString('base64') } }) };
    const result = await executeStep({ id: 'capture-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver);
    assert.equal(result.status, 'fail'); assert.equal('screenshot' in result, false);
    assert.equal(result.code, status === 'black' ? 'PRINTWINDOW_BLACK' : 'CAPTURE_NOT_RENDERED');
  }
  const driver = { request: async method => method === 'getState' ? { windows: [window] } : method === 'getAXState' ? read() :
    ({ window, geometry: { ...geometry, clientSize: [1280, 720], monitors: [] }, capture: { status: 'ok' } }) };
  await assert.rejects(executeStep({ id: 'capture-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver),
    e => e.code === 'CAPTURE_DISPLAY_MISSING');
});

test('repeated toolkit chord must advance a counter; a stale success marker fails', async () => {
  const w = { ...window, image: 'C:\\Windows\\powershell.exe', title: 'Sleight WDR7 WPF' };
  const driver = { request: async method => method === 'getState' ? { windows: [w] } :
    ({ ...read('Window: "WPF", App: powershell.\n0 standard window fixture\n1 text Chord: saved 1, ID: ChordState'), window: w }) };
  const result = await executeStep({ id: 'toolkit-wpf-chord', target: 'wpf' }, opts({ wpf: '12' }), driver);
  assert.equal(result.status, 'fail'); assert.equal(result.code, 'CHORD_NOT_CONFIRMED');
});

test('js batch runs 4 calls through a real isolated worker with fixture-only admission', { skip: !process.allowedNodeEnvironmentFlags.has('--allow-net') }, async () => {
  const driver = fakeDesktop();
  const ids = { num7Button: 2, plusButton: 3, num5Button: 4, equalButton: 5 };
  const restrictedDriver = { ...driver, restart: async () => {}, request: (method, params) => driver.request(method,
    method === 'click' ? { ...params, args: [ids[params.args[0].id]] } : params) };
  const batch = createFixtureBatch(restrictedDriver, { platform: 'win32', createRepl: options => createWindowsReplClient({ ...options, environment: () => ({}) }) });
  try {
    const result = await batch.run({ ...window, windowId: '13' });
    assert.equal(result.ok, true); assert.equal(driver.actions.length, 4);
    assert.deepEqual(driver.actions.map(a => a[1]), [[2], [3], [4], [5]]);
    assert.equal(result.settleSamples, 4); assert.equal(result.settleMs, 480);
    assert.ok(result.elapsedMs > 0);
  } finally { await batch.close(); await driver.close(); }
});

test('missing safety module and UC3F evidence return 22 skips and make zero driver calls', async () => {
  let calls = 0;
  const report = await runSitting(opts({ phase: 'safety' }), { platform: 'win32', loadSafetyModule: async () => null, createClient: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(report.steps.length, 22); assert.equal(report.verdict, 'incomplete');
  assert.equal(validateResult(report), true);
});

test('build phase uses the receipt helper once and only runs the non-drawing selftest vector', async () => {
  let builds = 0, runs = 0;
  const receipt = {};
  const report = await runSitting(opts({ phase: 'build' }), {
    platform: 'win32', prepare: async options => { builds++; assert.equal(options.kind, 'driver'); return { status: 'ready', receipt }; },
    executableOf: r => { assert.equal(r, receipt); return 'C:\\fixture\\driver-host.exe'; },
    execute: async (command, args, options) => {
      runs++; assert.equal(command, 'C:\\fixture\\driver-host.exe'); assert.deepEqual(args, ['--driver-selftest']);
      assert.equal(options.lowPriority, true); assert.equal(options.timeout, 10000);
      return { status: 0, stdout: JSON.stringify({ protocol: 'sleight.windows-driver/1', drawing: false, passed: 19, failed: 0, text: 'PRIVATE TREE' }) };
    },
  });
  assert.equal(builds, 1); assert.equal(runs, 1); assert.equal(report.verdict, 'passed-phase');
  assert.equal(report.steps[1].trials[0].nativePass, 19); assert.equal(validateResult(report), true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE TREE/);
});

test('cleanup failure retains a failed report instead of claiming a passed inventory', async () => {
  const report = await runSitting(opts({ phase: 'inventory' }), { platform: 'win32', createClient: () => ({
    request: async () => ({ windows: [] }), close: async () => { throw Error('cleanup'); },
  }) });
  assert.equal(report.verdict, 'failed'); assert.equal(report.steps.at(-1).trials[0].code, 'CLEANUP_UNPROVED');
  assert.equal(validateResult(report), true);
});

test('identity mismatch stops later input even when the returned tree looks like a fixture', async () => {
  const driver = fakeDesktop();
  const original = driver.request;
  driver.request = async (method, params) => {
    const r = await original(method, params);
    return method === 'getAXState' ? { ...r, window: { ...r.window, processStart: '456' } } : r;
  };
  const began = Date.now() - 1000;
  const report = await runSitting(opts({ phase: 'core', notepad: '12', 'notepad-untitled': '14', calculator: '13', cover: '99' }), {
    platform: 'win32', createClient: () => driver, now: () => began + 100,
    observe: async (_o, { onReady }) => { onReady(); return { observation: { ...clean, startedUtc: new Date(began).toISOString() } }; },
  });
  assert.equal(report.verdict, 'failed'); assert.equal(driver.actions.length, 0);
  assert.equal(report.steps.find(s => s.id === 'read-notepad').trials[0].code, 'IDENTITY_CHANGED');
});

test('a stale desired value cannot pass a new typing trial when reset did nothing', async () => {
  const baseline = 'SLEIGHT-WDR7-' + 'x'.repeat(187), suffix = 'WDR7-TYPED-' + 'y'.repeat(29);
  const driver = { request: async method => method === 'getState' ? { windows: [window] } : read(`Window: "fixture", App: Notepad.\n0 standard window fixture\n1 text field Editor, ID: Editor, Value: ${baseline}${suffix}`) };
  const result = await executeStep({ id: 'type-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver);
  assert.equal(result.status, 'fail'); assert.equal(result.code, 'SETVALUE_NOT_CONFIRMED');
});

test('Escape must remove the opened menu, rather than only change an unrelated field', async () => {
  const w = { ...window, image: 'C:\\CalculatorApp.exe', title: 'Calculator' };
  let opened = false, extra = '';
  const driver = { request: async method => {
    if (method === 'getState') return { windows: [w] };
    if (method === 'click') opened = true;
    if (method === 'pressKey') extra = '\n5 text other change';
    return { ...read(`Window: "Calculator", App: Calculator.\n0 standard window fixture\n1 button Menu, ID: TogglePaneButton${opened ? '\n2 menu Modes' : ''}${extra}`), window: w };
  } };
  const result = await executeStep({ id: 'escape-calculator', target: 'calculator' }, opts({ calculator: '12' }), driver);
  assert.equal(result.status, 'fail'); assert.equal(result.code, 'ESCAPE_NOT_CONFIRMED');
});

test('typing verifies 40 inserted characters at the existing caret, including inside wrapped text', async () => {
  let value = '', methods = [];
  const driver = { request: async (method, params) => {
    if (method === 'getState') return { windows: [window] };
    if (method === 'setValue') { value = params.args[1]; methods.push(method); }
    if (method === 'typeText') { value = value.slice(0, 50) + params.args[0] + value.slice(50); methods.push(method); }
    return read(`Window: "fixture", App: Notepad.\n0 standard window fixture\n1 text field Editor, ID: Editor, Value: ${value}`);
  } };
  const result = await executeStep({ id: 'type-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver);
  assert.equal(result.status, 'pass'); assert.deepEqual(methods, ['setValue', 'typeText']);
});

test('Return checks flattened spacing before the typed marker, with line-break correctness unverified', async () => {
  for (const works of [true, false]) {
    let value = '', caret = 50;
    const driver = { request: async (method, params) => {
      if (method === 'getState') return { windows: [window] };
      if (method === 'setValue') value = params.args[1];
      if (method === 'pressKey' && params.args[0] === 'Return' && works) { value = value.slice(0, caret) + '\n' + value.slice(caret); caret++; }
      if (method === 'typeText') value = value.slice(0, caret) + params.args[0] + value.slice(caret);
      return read(`Window: "fixture", App: Notepad.\n0 standard window fixture\n1 text field Editor, ID: Editor, Value: ${value.replace(/\n/g, ' ')}`);
    } };
    const result = await executeStep({ id: 'return-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver);
    assert.equal(result.status, works ? 'pass' : 'fail');
  }
});

test('driver warmup precedes observation and an expired observation blocks new content requests', async () => {
  const driver = fakeDesktop(), began = Date.now() - 1000;
  let time = began + 100, inventories = 0, warmed = false;
  const request = driver.request;
  driver.request = async (method, params) => {
    if (method === 'ping') warmed = true;
    if (method === 'getState' && ++inventories === 21) time = began + 101100;
    return request(method, params);
  };
  const report = await runSitting(opts({ phase: 'core', notepad: '12', 'notepad-untitled': '14', calculator: '13', cover: '99' }), {
    platform: 'win32', createClient: () => driver, now: () => time,
    observe: async (_o, { onReady }) => { assert.equal(warmed, true); onReady(); return { observation: { ...clean, startedUtc: new Date(began).toISOString() } }; },
  });
  assert.equal(report.verdict, 'failed'); assert.equal(driver.actions.length, 0);
  assert.equal(report.steps.find(s => s.id === 'read-notepad').trials[0].code, 'OBSERVER_BUDGET');
  assert.equal(driver.closed, true);
});

test('Ctrl+S timing excludes Escape used to dismiss its observed dialog', async () => {
  let time = 0, dialog = false, value = '';
  const untitled = { ...window, title: 'Untitled - Notepad' };
  const driver = { request: async (method, params) => {
    if (method === 'getState') return { windows: [untitled] };
    if (method === 'setValue') value = params.args[1];
    if (method === 'pressKey') {
      dialog = params.args[0] === 'ctrl+s';
      time += dialog ? 5 : 25;
    }
    return { ...read(`Window: "fixture", App: Notepad.\n0 standard window fixture\n1 text field Editor, ID: Editor, Value: ${value}${dialog ? '\n2 dialog Save As' : ''}`), window: untitled };
  } };
  const trial = await executeStep({ id: 'save-notepad', target: 'notepad-untitled' }, opts({ 'notepad-untitled': '12' }), driver, { clock: () => time });
  assert.equal(trial.status, 'pass'); assert.equal(trial.operationMs, 5); assert.equal(time, 30);
});

const observeClean = began => async (_o, { onReady }) => {
  onReady(); return { observation: { ...clean, startedUtc: new Date(began).toISOString() } };
};

test('DPI selected cell passes 20 trials with 7 expected skips; missing selected fixture remains incomplete', async () => {
  const began = Date.now() - 1000;
  for (const supplied of [true, false]) {
    const report = await runSitting(opts({ phase: 'dpi', wpf: supplied ? '15' : undefined, cover: '99' }), {
      platform: 'win32', createClient: fakeDesktop, now: () => began + 100, observe: observeClean(began),
    });
    assert.equal(report.verdict, supplied ? 'passed-phase' : 'incomplete');
    assert.equal(report.steps.filter(s => s.trials[0].code === 'DPI_CELL_NOT_SELECTED').length, 7);
    assert.equal(report.steps.find(s => s.id === 'dpi-100-standard').summary.pass, supplied ? 20 : 0);
    assert.equal(validateResult(report), true);
    if (supplied) {
      const altered = structuredClone(report); altered.steps[1].trials[0].code = 'UNEXPECTED_SKIP';
      assert.throws(() => validateResult(altered), /verdict/);
      const absent = structuredClone(report); absent.steps.pop(); assert.throws(() => validateResult(absent), /verdict/);
    }
  }
});

test('toolkit passes 9 applicable rows and excludes exactly 3 Calculator skips', async () => {
  const began = Date.now() - 1000;
  for (const supplied of [true, false]) {
    const report = await runSitting(opts({ phase: 'toolkit', notepad: '12', 'notepad-untitled': '14',
      wpf: supplied ? '15' : undefined, edge: '16', cover: '99' }), {
      platform: 'win32', createClient: fakeDesktop, now: () => began + 100, observe: observeClean(began),
    });
    assert.equal(report.verdict, supplied ? 'passed-phase' : 'incomplete');
    assert.equal(report.steps.filter(s => s.summary.skip && s.trials[0].code === 'CALCULATOR_EDITOR_NOT_APPLICABLE').length, 3);
    assert.equal(report.steps.filter(s => s.summary.pass === 20).length, supplied ? 9 : 6);
    assert.equal(validateResult(report), true);
  }
  assert.equal(sittingPlan(opts({ phase: 'toolkit' })).reduce((n, s) => n + s.estimatedSeconds, 0), 1080);
  assert.equal(sittingPlan(opts({ phase: 'dpi' })).reduce((n, s) => n + s.estimatedSeconds, 0), 120);
});

test('named Notepad refuses save-dialog rows before any input; untitled fixture raises the dialog', async () => {
  const driver = fakeDesktop();
  const step = sittingPlan().find(s => s.id === 'save-notepad');
  await assert.rejects(executeStep(step, opts({ 'notepad-untitled': '12' }), driver), e => e.code === 'FIXTURE_IDENTITY_MISMATCH');
  assert.equal(driver.actions.length, 0);
  // The fake models a named save as silent, to catch accidental target regressions.
  await driver.request('getAXState', { windowId: '12' });
  const named = await driver.request('pressKey', { windowId: '12', readId: 1, args: ['ctrl+s'] });
  assert.doesNotMatch(named.text, /dialog Save As/);
  assert.equal((await executeStep(step, opts({ 'notepad-untitled': '14' }), driver)).status, 'pass');
  assert.throws(() => parseSittingArgs(['--dry-run', '--notepad', '12', '--notepad-untitled', '12']), /differ/);
  const renamed = fakeDesktop(), request = renamed.request;
  renamed.request = async (method, params) => {
    const reply = await request(method, params);
    return method === 'setValue' ? { ...reply, window: { ...reply.window, title: 'driver-notepad.txt - Notepad' } } : reply;
  };
  await assert.rejects(executeStep(step, opts({ 'notepad-untitled': '14' }), renamed), e => e.code === 'FIXTURE_IDENTITY_MISMATCH');
  assert.deepEqual(renamed.actions.map(a => a[0]), ['setValue']);

});

for (const id of ['save-notepad', 'toolkit-win32-chord']) {
  const step = sittingPlan().find(s => s.id === id);
  const o = opts({ 'notepad-untitled': '14' });
  test(`${id} refuses a dialog already open before input`, async () => {
    const driver = fakeDesktop({ dialogOpen: true });
    const trial = await executeStep(step, o, driver);
    assert.equal(trial.status, 'fail'); assert.equal(trial.code, 'SAVE_DIALOG_PRESENT_BEFORE');
    assert.equal(driver.actions.length, 0);
  });
  test(`${id} refuses a dialog introduced while seeding before Ctrl+S`, async () => {
    const driver = fakeDesktop(), request = driver.request;
    driver.request = async (method, params) => {
      const reply = await request(method, params);
      return method === 'setValue' ? { ...reply, text: reply.text + '\n2 dialog Save As' } : reply;
    };
    const trial = await executeStep(step, o, driver);
    assert.equal(trial.status, 'fail'); assert.equal(trial.code, 'SAVE_DIALOG_PRESENT_BEFORE');
    assert.deepEqual(driver.actions.map(a => a[0]), ['setValue']);
  });
  test(`${id} fails when Escape leaves the dialog open and refuses the next trial`, async () => {
    const driver = fakeDesktop({ dismissDialogOnEscape: false });
    const trial = await executeStep(step, o, driver);
    assert.equal(trial.status, 'fail'); assert.equal(trial.code, 'SAVE_DIALOG_NOT_DISMISSED');
    assert.deepEqual(driver.actions.map(a => [a[0], a[1][0]]), [
      ['setValue', 1], ['pressKey', 'ctrl+s'], ['pressKey', 'Escape'],
    ]);
    const next = await executeStep(step, o, driver);
    assert.equal(next.status, 'fail'); assert.equal(next.code, 'SAVE_DIALOG_PRESENT_BEFORE');
    assert.equal(driver.actions.length, 3);
  });
}

test('older Node skips batch before creating a worker or observing; unsupported skip stays incomplete', async () => {
  assert.equal(supportsBatch(new Set()), false); assert.equal(supportsBatch(new Set(['--allow-net'])), true);
  const began = Date.now() - 1000;
  const report = await runSitting(opts({ phase: 'core', notepad: '12', 'notepad-untitled': '14', calculator: '13', edge: '16', cover: '99' }), {
    platform: 'win32', batchSupported: false, createClient: fakeDesktop, now: () => began + 100, observe: observeClean(began),
    makeBatch: () => { assert.fail('old Node must never create a worker'); },
  });
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.steps.at(-1).trials[0].code, 'NODE_BATCH_UNSUPPORTED');
  assert.equal(report.steps.at(-1).summary.fail, 0); assert.equal(validateResult(report), true);
});

test('capture records real client and containing display dimensions at two guest resolutions', async () => {
  for (const [display, size] of [[[1366, 768], [640, 400]], [[1920, 1080], [1200, 800]]]) {
    const g = { ...geometry, clientOrigin: [20, 30], clientSize: size, monitors: [[0, 0, ...display]] };
    const png = Buffer.alloc(25); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(size[0], 16); png.writeUInt32BE(size[1], 20);
    const driver = { request: async method => method === 'getState' ? { windows: [window] } : method === 'getAXState' ? { ...read(), geometry: g } :
      ({ window, geometry: g, capture: { status: 'ok' }, screenshot: { mimeType: 'image/png', data: png.toString('base64') } }) };
    const trial = await executeStep({ id: 'capture-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver);
    assert.equal(trial.status, 'pass'); assert.deepEqual([trial.width, trial.height], size);
    assert.deepEqual([trial.monitorWidth, trial.monitorHeight], display);
    assert.equal(trial.displayWidthFraction, size[0] / display[0]); assert.equal('screenshot' in trial, false);
    png.writeUInt32BE(size[0] + 1, 16);
    assert.equal((await executeStep({ id: 'capture-notepad', target: 'notepad' }, opts({ notepad: '12' }), driver)).status, 'fail');
  }
});

test('real WDR5 safety module refuses decline, terminal and elevated fixtures with zero content reads', async t => {
  const candidates = [new URL('../plugins/sleight/lib/windows-driver/safety.mjs', import.meta.url),
    new URL('../../wdr5/plugins/sleight/lib/windows-driver/safety.mjs', import.meta.url)];
  const path = candidates.find(p => existsSync(p));
  if (!path) { t.skip('WDR5 real safety.mjs absent in this checkout and sibling wdr5; rerun after integration'); return; }
  t.diagnostic(`Real WDR5 module: ${path.pathname.includes('/wdr5/') ? 'sibling wdr5' : 'current checkout'}`);
  const module = await import(path.href);
  assert.equal(typeof module.createWindowsSafety, 'function');
  let requests = 0;
  const windows = [{ ...fakeWindows[0], title: 'driver-notepad.txt - Notepad' },
    { ...fakeWindows[1], windowId: '103', image: 'C:\\WindowsTerminal.exe', app: 'Windows Terminal' },
    { ...fakeWindows[0], windowId: '104', pid: 43, integrity: 'high', refused: 'ELEVATED_TARGET' }];
  const rows = await runSafetyChecks(opts({ notepad: '101', terminal: '103', elevated: '104', elevatedPid: 43 }), {
    request: async method => { requests++; assert.equal(method, 'getState'); return { windows }; },
  }, module);
  assert.equal(rows.length, 3); assert.equal(rows.reduce((n, s) => n + s.summary.pass, 0), 3);
  assert.ok(rows.every(s => s.trials[0].contentRequests === 0)); assert.equal(requests, 4);
  const wrongPid = await runSafetyChecks(opts({ elevated: '104', elevatedPid: 99 }), { request: async () => ({ windows }) }, module);
  assert.equal(wrongPid.at(-1).trials[0].code, 'SAFETY_FIXTURE_IDENTITY_MISMATCH');
});

test('validator failure retains redacted measurements marked invalid without raw error text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdr7-invalid-'));
  try {
    const output = join(dir, 'invalid.json'); let printed = '';
    const report = await main(['--phase', 'inventory', '--output', output, '--revision', 'a'.repeat(40)], {
      platform: 'win32', createClient: fakeDesktop, print: s => { printed += s; },
      validate: () => { throw Error('PRIVATE VALIDATOR ERROR'); },
    });
    const stored = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(stored.verdict, 'invalid'); assert.deepEqual(stored.steps, report.steps);
    assert.equal(stored.discovery.length, 5); assert.doesNotMatch(readFileSync(output, 'utf8'), /PRIVATE VALIDATOR ERROR/);
    assert.equal(JSON.parse(printed).steps[0].focusStatus, 'not-observed');
    assert.throws(() => validateResult(stored), /Invalid sitting result/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('integrity precheck rejects elevated and unknown tokens and passes only low or medium with narrow child environment', async () => {
  for (const level of [4096, 8192, 12288, 16384, null]) {
    const check = assertStandardUser({ env: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', SECRET: 'hidden', NODE_OPTIONS: '--inspect' },
      execute: async (command, args, options) => {
        assert.equal(command, 'C:\\Windows\\System32\\whoami.exe'); assert.deepEqual(args, ['/groups', '/fo', 'csv', '/nh']);
        assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' });
        return { status: 0, stdout: level === null ? 'unknown' : `S-1-16-${level}` };
      } });
    if ([4096, 8192].includes(level)) await check;
    else await assert.rejects(check, e => e.code === (level === null ? 'INTEGRITY_UNPROVED' : 'ELEVATED_SITTING_REFUSED'));
  }
  let calls = 0;
  const report = await actualRunSitting(opts({ phase: 'build' }), { platform: 'win32',
    execute: async () => ({ status: 0, stdout: 'S-1-16-12288' }), prepare: () => calls++ });
  assert.equal(calls, 0); assert.equal(report.verdict, 'failed'); assert.equal(validateResult(report), true);
});

test('selftest child receives only Windows system and temporary directory values', async () => {
  const report = await runSitting(opts({ phase: 'build' }), {
    platform: 'win32', env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', SECRET: 'hidden', NODE_OPTIONS: '--inspect' },
    prepare: async () => ({ status: 'ready', receipt: {} }), executableOf: () => 'fixture.exe',
    execute: async (_command, _args, options) => {
      assert.deepEqual(Object.keys(options.env).sort(), ['SystemRoot', 'TEMP', 'TMP', 'WINDIR']);
      return { status: 0, stdout: JSON.stringify({ protocol: 'sleight.windows-driver/1', drawing: false, passed: 19, failed: 0 }) };
    },
  });
  assert.equal(report.verdict, 'passed-phase');
});

test('WM_CHAR row rejects a different route even if text changed correctly', async () => {
  const driver = fakeDesktop(), request = driver.request;
  driver.request = async (method, params) => ({ ...await request(method, params), route: 'posted-key' });
  const trial = await executeStep({ id: 'toolkit-win32-wmchar', target: 'notepad' }, opts({ notepad: '12' }), driver);
  assert.equal(trial.status, 'fail'); assert.equal(trial.code, 'WMCHAR_ROUTE_MISMATCH');
});

test('cover leaves a console strip and never maximizes; runbooks agree on Node and safe Edge launch', () => {
  const ps = readFileSync(new URL('../bench/windows/fixtures/driver-wpf.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(ps, /WindowState = 'Maximized'/); assert.match(ps, /\$work.Width \* 0\.75/);
  const vm = readFileSync(new URL('../bench/windows/vm-runbook.md', import.meta.url), 'utf8');
  const sitting = readFileSync(new URL('../bench/windows/driver-sitting-runbook.md', import.meta.url), 'utf8');
  for (const book of [vm, sitting]) {
    assert.match(book, /Node 25\.0\.0/); assert.doesNotMatch(book, /v24\./);
    assert.match(book, /nodejs.org\/en\/download/); assert.match(book, /SHASUMS256/); assert.match(book, /Get-FileHash/);
  }
  assert.match(vm, /install Node 25\.0\.0 ARM64 for both runbooks/);
  assert.match(vm, /requires the pinned commit,\s+Windows build 22000 or newer, native ARM64 Windows and Node 25\.0\.0 ARM64/);
  assert.match(sitting, /--inprivate --new-window/);
});

test('printed summary includes focus failures beside pass counts and computes passing read targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdr7-summary-')), began = Date.now() - 1000;
  try {
    for (const focusFails of [true, false]) {
      let printed = '';
      await main(['--phase', 'core', '--notepad', '12', '--notepad-untitled', '14', '--calculator', '13', '--edge', '16',
        '--cover', '99', '--revision', 'a'.repeat(40), '--output', join(dir, `${focusFails}.json`)], {
        platform: 'win32', createClient: fakeDesktop, now: () => began + 100, print: s => { printed += s; },
        makeBatch: () => ({ run: async () => ({ ok: true, elapsedMs: 11, settleMs: 480, settleSamples: 4 }), close: async () => {} }),
        observe: async (_o, { onReady }) => {
          onReady(); return { observation: { ...clean, startedUtc: new Date(began).toISOString(), transitions: focusFails ? [{}] : [] } };
        },
      });
      const summary = JSON.parse(printed);
      assert.equal(summary.steps[0].pass, 20);
      assert.equal(summary.steps[0].focusStatus, focusFails ? 'fail' : 'pass');
      assert.equal(summary.verdict, focusFails ? 'failed' : 'passed-phase');
      const read = summary.steps.find(s => s.id === 'read-notepad');
      assert.equal(read.readP50Under300Ms, focusFails ? null : read.passP50Ms < 300);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Literal VM observations, independent of the acceptance-rule builder. These
// test the evidence evaluator only; no synthetic sample is a Windows receipt.
const samples = (id, n, sample) => ({ id, samples: Array.from({ length: n }, () => structuredClone(sample)) });
const beforeRefusal = (code, reason) => ({ code, reason, delivery: 'not-sent', retry: 'safe', unhealthy: false,
  postedMessages: 0, patternCalls: 0 });
const stoppedType = (code, reason) => ({ code, reason, delivery: 'sent-unverified', retry: 'read-first', unhealthy: false,
  typed: 128, keyUpsDelivered: true, postsAfterStop: 0 });
const noRead = { uiaFetches: 0, captures: 0 };
const browserRefusal = { code: 'BROWSER_TARGET_REFUSED', cards: 0, leases: 0, contentReads: 0 };
const identityRefusal = code => ({ code, uiaFetches: 0 });
const uc3Cases = {
  'person-idle': [samples('notepad', 50, { lastInputUnchanged: true, refused: false, effectObserved: true }),
    samples('wpf', 50, { lastInputUnchanged: true, refused: false, effectObserved: true }),
    samples('calculator-refused', 10, { code: 'HOSTED_APP_UNRESOLVED', postedMessages: 0, patternCalls: 0, uiaFetches: 0 }),
    samples('background-word', 20, { refused: false, effectObserved: true, typingTarget: 'wpf' })],
  'person-key-before': [samples('scheduled-key', 20, { ...beforeRefusal('PERSON_TOOK_OVER', 'person-active'), source: 'scheduled-sendinput', keyLeadMs: 100 })],
  'person-key-during': [samples('typing', 10, { ...stoppedType('PERSON_TOOK_OVER', 'person-active'), requestedUnits: 3000, source: 'scheduled-sendinput' })],
  'lock-refused': ['read', 'capture', 'action'].map(id => samples(id, 10, { ...beforeRefusal('SCREEN_LOCKED', 'session-locked'), ...noRead }))
    .concat([samples('unlocked-action', 50, { refused: false, effectObserved: true }), samples('wts-query', 1000, { ok: true }),
      samples('flags', 1, { locked: 0, unlocked: 1, firstAfterUnlockPassed: true })]),
  'lock-during-type': [samples('typing', 10, { ...stoppedType('SCREEN_LOCKED', 'session-locked'), requestedUnits: 3000, finalReads: 0 })],
  'screensaver-refused': [samples('screensaver', 5, { ...beforeRefusal('SCREEN_LOCKED', 'screensaver'), ...noRead })],
  'session-switch-refused': [samples('switch', 5, { ...beforeRefusal('SCREEN_LOCKED', 'session-disconnected'), ...noRead, resumedWithoutRestart: true })],
  'uac-refused': [samples('prompt', 10, { ...beforeRefusal('SECURE_DESKTOP_ACTIVE', 'secure-desktop'), firstCall: true, inputWhilePrompt: 0 }),
    samples('idle-probe', 100, { falseSecureRefusal: false, effectObserved: true }), samples('idle-action', 50, { falseSecureRefusal: false, effectObserved: true })],
  'uac-hint': [samples('raised-prompt', 10, { replyMode: 'cap', secureDesktopSeen: true, stackedPrompts: 0, firstAfterAnswerPassed: true })],
  'escape-stop-hardware': [samples('hardware', 10, { ...stoppedType('USER_STOPPED', 'escape'), requestedUnits: 4000, source: 'owner-keyboard',
    injectedFlag: false, stopMs: 249, swallowed: false, nextCode: 'USER_STOPPED', nextPosts: 0, nextPatternCalls: 0 })],
  'escape-ignored-injected': [samples('injected', 10, { source: 'scheduled-sendinput', injectedFlag: true, escapeStops: 0 })],
  'escape-ignored-posted': [samples('posted', 10, { source: 'stuck-menu-escape', hookEvents: 0, escapeStops: 0 })],
  'cancel-frame': [samples('cancel-first', 5, { ...stoppedType('USER_STOPPED', 'cancel'), requestedUnits: 3000, flagMs: 299, jobReplyMatched: true, cancelReplyMatched: true }),
    samples('job-first', 5, { ...stoppedType('USER_STOPPED', 'cancel'), requestedUnits: 3000, flagMs: 299, jobReplyMatched: true, cancelReplyMatched: true })],
  'direct-launch-terminal': ['direct-terminal', 'parent-terminal', 'direct-settings', 'parent-settings'].map(id =>
    samples(id, 10, { ...identityRefusal(id.endsWith('settings') ? 'FORBIDDEN_SETTINGS' : 'FORBIDDEN_TARGET'),
      source: id.startsWith('direct') ? 'scheduled-direct' : 'parent' })),
  'direct-launch-override': ['direct-terminal', 'parent-terminal'].map(id => samples(id, 10, { source: id.startsWith('direct') ? 'scheduled-direct' : 'parent',
    override: true, readPassed: true })).concat(['direct-settings', 'parent-settings'].map(id => samples(id, 10, {
    ...identityRefusal('FORBIDDEN_SETTINGS'), source: id.startsWith('direct') ? 'scheduled-direct' : 'parent', override: true }))),
  'browser-refused-edge': ['name', 'hwnd'].map(id => samples(id, 10, browserRefusal)).concat(
    [samples('notepad', 50, { refused: false, effectObserved: true }), samples('wpf', 100, { refused: false, effectObserved: true })]),
  'browser-refused-firefox': ['name', 'hwnd'].map(id => samples(id, 10, browserRefusal)),
  'browser-refused-renamed': [samples('renamed', 10, { ...browserRefusal, originalFilenamePreserved: true, productNamePreserved: true })],
  'checkpoint-cost': ['session-probe', 'lock-check', 'desktop-check', 'person-input', 'budget-check', 'hook-install', 'hook-remove'].map(id => samples(id, 50, { elapsedMs: 0.1 })).concat([samples('hook-callback', 100, { elapsedUs: 9.9 })]),
};
const evidenceFor = id => ({ cases: structuredClone(uc3Cases[id]), ...(id === 'checkpoint-cost' ? {
  plannedUtc: '2026-11-01T10:00:00.000Z', startedUtc: '2026-11-01T11:00:00.000Z',
} : {}) });

// The current sitting never qualifies cost, even when the evidence proposes bounds.
function evaluatorWithRegisteredNoise() { return sitting.evaluateSafetyEvidence; }

test('UC3E2 cost evidence cannot buy a pass for a 500x slowdown with its own noise', () => {
  for (const noise of [0, 0.2, 1e9]) {
    const e = evidenceFor('checkpoint-cost');
    e.noise = {};
    for (const c of e.cases.slice(0, 3)) {
      e.noise[c.id] = noise;
      c.samples.forEach(s => { s.afterMs = s.beforeMs * 500; });
    }
    assert.equal(sitting.evaluateSafetyEvidence('checkpoint-cost', e).status, 'fail', `noise=${noise}`);
  }
});

test('UC3E2 hardware source labels require an explicitly clear injected flag', () => {
  for (const source of ['owner-keyboard', 'qemu-display']) {
    const e = evidenceFor('escape-stop-hardware');
    e.cases[0].samples.forEach(s => { s.source = source; delete s.injectedFlag; });
    assert.equal(sitting.evaluateSafetyEvidence('escape-stop-hardware', e).status, 'fail', source);
    e.cases[0].samples.forEach(s => { s.injectedFlag = true; });
    assert.equal(sitting.evaluateSafetyEvidence('escape-stop-hardware', e).status, 'fail', source);
    e.cases[0].samples.forEach(s => { s.injectedFlag = false; });
    assert.equal(sitting.evaluateSafetyEvidence('escape-stop-hardware', e).status, 'pass', source);
  }
});

test('UC3E2 key lead is a measured inclusive 50 to 150 ms range', () => {
  for (const [lead, status] of [[50, 'pass'], [97.6, 'pass'], [150, 'pass'], [49.99, 'fail'], [150.01, 'fail']]) {
    const e = evidenceFor('person-key-before');
    e.cases[0].samples[19].keyLeadMs = lead;
    assert.equal(sitting.evaluateSafetyEvidence('person-key-before', e).status, status, `${lead} ms`);
  }
});

test('UC3E2 mid-typing rows require at least one typed unit', () => {
  for (const id of ['person-key-during', 'lock-during-type', 'escape-stop-hardware', 'cancel-frame']) {
    const e = evidenceFor(id);
    e.cases[0].samples[0].typed = 1;
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'pass', id);
    e.cases[0].samples[0].typed = 0;
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'fail', id);
  }
});

test('UC3E2 no false refusal cases need observed success, including delivery to background Notepad', () => {
  for (const [id, cases] of [
    ['person-idle', ['notepad', 'wpf', 'background-word']],
    ['lock-refused', ['unlocked-action']], ['uac-refused', ['idle-probe', 'idle-action']],
    ['browser-refused-edge', ['notepad', 'wpf']],
  ]) for (const caseId of cases) {
    const e = evidenceFor(id), sample = e.cases.find(c => c.id === caseId).samples[0];
    delete sample.effectObserved;
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'fail', `${id}/${caseId}: absent effect`);
    sample.effectObserved = false;
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'fail', `${id}/${caseId}: failed effect`);
    sample.effectObserved = true;
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'pass', `${id}/${caseId}: observed effect`);
  }
});

test('UC3E2 runbook marks owner-present rows and repeats the VM hold and owner-away gates', () => {
  const book = readFileSync(new URL('../bench/windows/driver-sitting-runbook.md', import.meta.url), 'utf8');
  const section = book.slice(book.indexOf('### UC3F acceptance plan'), book.indexOf('### Collect and grade'));
  assert.match(section, /Owner presence/);
  for (const id of ['lock-refused', 'lock-during-type', 'screensaver-refused', 'session-switch-refused', 'uac-refused', 'uac-hint'])
    assert.match(section, new RegExp(`\\| ${id} \\| Owner present`));
  assert.match(section, /\| escape-stop-hardware \| Owner present for owner-keyboard/);
  assert.match(section, /\/tmp\/sleight-hold/);
  assert.match(section, /owner returns/);
  assert.match(section, /quiet window/);
  assert.match(section, /explicit permission/);
});

// Each mutation names a concrete unsafe observation which must never qualify.
const brokenEvidence = {
  'person-idle': e => { e.cases[0].samples[49].lastInputUnchanged = false; },
  'person-key-before': e => { e.cases[0].samples[19].postedMessages = 1; },
  'person-key-during': e => { e.cases[0].samples[9].typed = 3000; },
  'lock-refused': e => { e.cases[1].samples[9].captures = 1; },
  'lock-during-type': e => { e.cases[0].samples[9].finalReads = 1; },
  'screensaver-refused': e => { e.cases[0].samples[4].code = 'OK'; },
  'session-switch-refused': e => { e.cases[0].samples[4].resumedWithoutRestart = false; },
  'uac-refused': e => { e.cases[0].samples[9].inputWhilePrompt = 1; },
  'uac-hint': e => { e.cases[0].samples[9].secureDesktopSeen = false; },
  'escape-stop-hardware': e => { e.cases[0].samples[9].stopMs = 250; },
  'escape-ignored-injected': e => { e.cases[0].samples[9].escapeStops = 1; },
  'escape-ignored-posted': e => { e.cases[0].samples[9].escapeStops = 1; },
  'cancel-frame': e => { e.cases[1].samples[4].flagMs = 300; },
  'direct-launch-terminal': e => { e.cases[2].samples[9].code = 'OK'; },
  'direct-launch-override': e => { e.cases[0].samples[9].readPassed = false; },
  'browser-refused-edge': e => { e.cases[0].samples[9].cards = 1; },
  'browser-refused-firefox': e => { e.cases[1].samples[9].contentReads = 1; },
  'browser-refused-renamed': e => { e.cases[0].samples[9].code = 'OK'; },
  'checkpoint-cost': e => { e.cases.at(-1).samples.forEach(s => { s.elapsedUs = -1; }); },
};

for (const id of Object.keys(uc3Cases)) test(`UC3F ${id}: accepts full evidence, rejects its broken variant and absent samples`, () => {
  assert.equal(typeof sitting.evaluateSafetyEvidence, 'function', 'missing UC3F evidence evaluator');
  const evaluate = id === 'checkpoint-cost' ? evaluatorWithRegisteredNoise() : sitting.evaluateSafetyEvidence;
  const good = evidenceFor(id);
  assert.equal(evaluate(id, good).status, id === 'checkpoint-cost' ? 'skip' : 'pass');
  const bad = structuredClone(good); brokenEvidence[id](bad);
  assert.equal(evaluate(id, bad).status, 'fail', `broken variant escaped: ${id}`);
  bad.cases = [];
  assert.equal(sitting.evaluateSafetyEvidence(id, bad).status, 'fail');
  assert.equal(sitting.evaluateSafetyEvidence(id).status, 'skip');
  for (const c of good.cases) {
    const short = structuredClone(good); short.cases.find(x => x.id === c.id).samples.pop();
    assert.equal(evaluate(id, short).status, id === 'checkpoint-cost' ? 'skip' : 'fail', `missing ${c.id} sample escaped qualification`);
    if (id === 'checkpoint-cost') {
      const measured = sitting.evaluateSafetyEvidence(id, short);
      assert.equal(measured.status, 'skip'); assert.equal(measured.note, 'bounds not registered');
      assert.equal(measured.costs[c.id].count, c.samples.length - 1);
    }
  }
});

test('UC3F plan fixes 19 row rules and counts, diagnostic runs never lower them', () => {
  const plan = sittingPlan({ phase: 'safety', runs: 1 });
  assert.equal(plan.length, 22);
  assert.deepEqual(plan.filter(s => s.passRule).map(s => s.id), Object.keys(uc3Cases));
  for (const step of plan.filter(s => s.passRule)) {
    assert.equal(step.trials, 1); assert.ok(step.passRule.length > 20);
    assert.deepEqual(step.cases.map(c => [c.id, c.trials]), uc3Cases[step.id].map(c => [c.id, c.samples.length]));
  }
});

test('UC3F malformed, duplicated, extra and nonfinite evidence cannot pass or leak raw text', () => {
  const changes = [e => { e.cases[0].samples[0].text = 'PRIVATE'; }, e => e.cases.push(e.cases[0]),
    e => { e.cases[0].samples[0].postedMessages = NaN; }, e => { e.cases[0].samples[0].typed = -1; },
    e => { e.cases[0].samples[0].typed = 0.5; }, e => { e.cases[0].samples[0].typed = true; },
    e => { e.cases[0].samples[0].unhealthy = true; }, e => { e.cases[0].samples[0].retry = 'safe'; }];
  for (const change of changes) {
    const e = evidenceFor('person-key-during'); change(e);
    const verdict = sitting.evaluateSafetyEvidence('person-key-during', e);
    assert.equal(verdict.status, 'fail'); assert.doesNotMatch(JSON.stringify(verdict), /PRIVATE|NaN/);
  }
});

test('UC3F hardware provenance, cleanup, cancel ids and reply modes are required', () => {
  for (const [id, field, value] of [['escape-stop-hardware', 'source', 'scheduled-sendinput'],
    ['escape-stop-hardware', 'swallowed', true], ['escape-stop-hardware', 'keyUpsDelivered', false],
    ['escape-stop-hardware', 'nextPosts', 1], ['cancel-frame', 'cancelReplyMatched', false],
    ['cancel-frame', 'jobReplyMatched', false], ['uac-hint', 'stackedPrompts', 1], ['uac-hint', 'replyMode', 'event-quiet']]) {
    const e = evidenceFor(id); e.cases[0].samples[0][field] = value;
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'fail', `${id}/${field}`);
  }
  for (const mode of ['cap', 'budget', 'deadline']) {
    const e = evidenceFor('uac-hint'); e.cases[0].samples[0].replyMode = mode;
    assert.equal(sitting.evaluateSafetyEvidence('uac-hint', e).status, 'pass');
  }
});

test('UC3F cost remains measurement-only with all checks on and refuses pair and noise payloads', () => {
  const evidence = evidenceFor('checkpoint-cost');
  assert.equal(sitting.evaluateSafetyEvidence('checkpoint-cost', evidence).status, 'skip');
  const slow = structuredClone(evidence); slow.cases[0].samples.forEach(s => { s.elapsedMs = 5000; });
  const result = sitting.evaluateSafetyEvidence('checkpoint-cost', slow);
  assert.equal(result.status, 'skip'); assert.equal(result.costs['session-probe'].p90Ms, 5000);
  for (const mutate of [e => { e.noise = { click: 1e9 }; },
    e => { e.cases[0].samples[0] = { beforeMs: 1, afterMs: 2 }; },
    e => { e.cases[0].id = 'keyboard'; }]) {
    const bad = structuredClone(evidence); mutate(bad);
    assert.equal(sitting.evaluateSafetyEvidence('checkpoint-cost', bad).status, 'fail');
  }
});

test('UC3F dry run ignores an unreadable evidence path and never probes a VM', async () => {
  let calls = 0;
  const result = await main(['--dry-run', '--phase', 'safety', '--safety-evidence', 'missing-evidence.json'], {
    platform: 'darwin', print() {}, assertVm: () => calls++, createClient: () => calls++, prepare: () => calls++,
  });
  assert.equal(calls, 0); assert.equal(result.steps.length, 22);
});

test('UC3F every observation field is mandatory, inverted WTS flags and any query failure refuse qualification', () => {
  for (const id of Object.keys(uc3Cases)) for (const c of uc3Cases[id]) for (const field of Object.keys(c.samples[0])) {
    const e = evidenceFor(id); delete e.cases.find(x => x.id === c.id).samples[0][field];
    assert.equal(sitting.evaluateSafetyEvidence(id, e).status, 'fail', `${id}/${c.id}/${field}`);
  }
  const e = evidenceFor('lock-refused');
  Object.assign(e.cases.at(-1).samples[0], { locked: 1, unlocked: 0 });
  assert.equal(sitting.evaluateSafetyEvidence('lock-refused', e).status, 'fail');
  const failedQuery = evidenceFor('lock-refused'); failedQuery.cases.find(c => c.id === 'wts-query').samples[999].ok = false;
  assert.equal(sitting.evaluateSafetyEvidence('lock-refused', failedQuery).status, 'fail');
});

test('VM preflight rejects physical or unknown machines without starting a driver', async () => {
  assert.equal(typeof sitting.assertVirtualMachine, 'function');
  for (const [info, pass] of [[{ Manufacturer: 'QEMU', Model: 'QEMU Virtual Machine' }, true],
    [{ Manufacturer: 'Microsoft Corporation', Model: 'Virtual Machine' }, true],
    [{ Manufacturer: 'Dell Inc.', Model: 'Precision' }, false], [{}, false]]) {
    const call = sitting.assertVirtualMachine({ env: { SystemRoot: 'C:\\Windows', SECRET: 'hidden' },
      execute: async (command, args, options) => {
        assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.ok(args.includes('-NoProfile')); assert.equal(options.timeout, 10000);
        assert.equal(options.env.SECRET, undefined);
        return { status: 0, stdout: JSON.stringify(info) };
      } });
    if (pass) await call; else await assert.rejects(call, e => e.code === 'VM_UNPROVED');
  }
  let calls = 0;
  await assert.rejects(actualMain(['--phase', 'safety', '--output', join(tmpdir(), `uc3e-never-${process.pid}.json`), '--revision', 'a'.repeat(40)], {
    platform: 'win32', assertVm: async () => { throw Object.assign(Error(), { code: 'VM_UNPROVED' }); },
    createClient: () => calls++, prepare: () => calls++, print() {},
  }), e => e.code === 'VM_UNPROVED');
  assert.equal(calls, 0);
});

test('UC3F evidence schema bounds counters and excludes raw strings and application payloads', () => {
  const schema = JSON.parse(readFileSync(new URL('../bench/windows/driver-sitting.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.evidence.additionalProperties, false);
  assert.equal(schema.$defs.observation.additionalProperties, false);
  assert.equal(schema.$defs.evidence.properties.cases.items.properties.samples.maxItems, 1000);
  assert.equal(schema.$defs.observation.properties.typed.type, 'integer');
  for (const field of ['text', 'title', 'window', 'image', 'stdout', 'screenshot'])
    assert.equal(schema.$defs.observation.properties[field], undefined);
});

test('measurement-only cost schema retains zero counts and nullable statistics', () => {
  const schema = JSON.parse(readFileSync(new URL('../bench/windows/driver-sitting.schema.json', import.meta.url), 'utf8'));
  if (process.env.UC3G4_SCHEMA_BROKEN === 'counts') delete schema.$defs.costs.properties['session-probe'].properties.count;
  if (process.env.UC3G4_SCHEMA_BROKEN === 'nulls') schema.$defs.costs.properties['session-probe'].properties.p50Ms.type = 'number';
  assert.equal(schema.$defs.evidence.properties.cases.items.properties.samples.minItems, 0);
  const evidence = evidenceFor('checkpoint-cost'); delete evidence.noise;
  for (const c of evidence.cases) c.samples = [];
  const measured = sitting.evaluateSafetyEvidence('checkpoint-cost', evidence);
  assert.equal(measured.status, 'skip'); assert.equal(measured.note, 'not measured: no timing producer');
  assert.equal(schema.$defs.evidence.properties.measurementOnly.const, 'bounds not registered');
  const marked = evidenceFor('checkpoint-cost'); delete marked.noise;
  marked.measurementOnly = 'bounds not registered';
  assert.equal(evaluatorWithRegisteredNoise()('checkpoint-cost', marked).status, 'skip');
  marked.measurementOnly = 'passed';
  assert.equal(sitting.evaluateSafetyEvidence('checkpoint-cost', marked).status, 'fail');
  for (const [id, stats] of Object.entries(measured.costs)) {
    const properties = schema.$defs.costs.properties[id].properties;
    assert.equal(stats.count, 0); assert.equal(stats.plannedCount, id === 'hook-callback' ? 100 : 50);
    assert.equal(properties.count.type, 'integer'); assert.equal(properties.count.minimum, 0);
    assert.equal(properties.plannedCount.type, 'integer');
    for (const [key, value] of Object.entries(stats)) {
      assert.ok(properties[key], key);
      if (!['count', 'plannedCount'].includes(key)) {
        assert.equal(value, null); assert.deepEqual(properties[key].type, ['number', 'null']);
      }
    }
  }
});

test('schema scope: counts belong only to cost statistics and raw observations never admit null', () => {
  const schema = JSON.parse(readFileSync(new URL('../bench/windows/driver-sitting.schema.json', import.meta.url), 'utf8'));
  if (process.env.UC3G4_SCHEMA_BROKEN === 'scope') schema.$defs.trial.allOf[0].if.properties.count = { type: 'integer' };
  if (process.env.UC3G4_SCHEMA_BROKEN === 'rawNull') schema.$defs.observation.properties.stopMs.type = ['number', 'null'];
  const walk = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const next = `${path}/${key}`;
      if (key === 'count' || key === 'plannedCount') assert.ok(next.startsWith('/$defs/costs/'), next);
      walk(item, next);
    }
  };
  walk(schema);
  for (const [name, field] of Object.entries(schema.$defs.observation.properties))
    if (field.type) assert.equal(Array.isArray(field.type) && field.type.includes('null'), false, name);
});

const withEvidenceFile = async (run, bundle) => {
  const dir = mkdtempSync(join(tmpdir(), 'uc3e-evidence-'));
  try {
    const path = join(dir, 'input.json'); writeFileSync(path, JSON.stringify(bundle));
    if (bundle.revision === safetyContext.revision) writeFileSync(path + '.attestation.json',
      JSON.stringify(createAttestation(readFileSync(path), safetyContext)));
    return await run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const evidenceBundle = () => ({ schema: 'sleight.windows-uc3f-evidence/1', revision: 'a'.repeat(40),
  rows: Object.keys(uc3Cases).map(id => ({ id, evidence: evidenceFor(id) })) });

test('UC3F reader binds revision and rejects extra, duplicate, unknown and oversized inputs', async () => {
  await withEvidenceFile(path => assert.equal(sitting.readSafetyEvidence(path, 'a'.repeat(40)).size, 19), evidenceBundle());
  for (const edit of [b => { b.revision = 'b'.repeat(40); }, b => b.rows.push(b.rows[0]),
    b => { b.rows[0].id = 'other'; }, b => { b.text = 'PRIVATE'; }]) {
    const b = evidenceBundle(); edit(b);
    await withEvidenceFile(path => assert.throws(() => sitting.readSafetyEvidence(path, 'a'.repeat(40))), b);
  }
  await withEvidenceFile(path => assert.throws(() => sitting.readSafetyEvidence(path, 'a'.repeat(40))), { text: 'x'.repeat(1024 * 1024) });
});

test('UC3F reader rejects symlinks and directories', { skip: process.platform === 'win32' ? 'symlink creation needs Windows privilege' : false }, async () => {
  await withEvidenceFile(path => {
    const alias = join(path, '..', 'alias.json'); symlinkSync(path, alias);
    assert.throws(() => sitting.readSafetyEvidence(alias, 'a'.repeat(40)));
    assert.throws(() => sitting.readSafetyEvidence(join(path, '..'), 'a'.repeat(40)));
  }, evidenceBundle());
});

test('UC3F runner cannot qualify without evidence; imported observations are regraded', async () => {
  const deps = { platform: 'win32', loadSafetyModule: async () => null };
  const absent = await runSitting(opts({ phase: 'safety' }), deps);
  assert.equal(absent.steps.length, 22); assert.equal(absent.verdict, 'incomplete');
  assert.equal(validateResult(absent), true);
  await withEvidenceFile(async path => {
    const report = await runSitting(opts({ phase: 'safety', safetyEvidence: path }), deps);
    assert.equal(report.verdict, 'incomplete'); // 3 original refusal fixtures absent.
    assert.equal(report.steps.filter(s => s.summary.pass).length, 18);
    assert.equal(validateResult(report), true);
    assert.equal(report.steps.at(-1).trials[0].status, 'skip'); // Owner bounds unset.
    for (const id of Object.keys(uc3Cases).filter(id => id !== 'checkpoint-cost')) {
      const bad = structuredClone(report), step = bad.steps.find(s => s.id === id);
      brokenEvidence[id](step.trials[0].evidence);
      assert.throws(() => validateResult(bad), /UC3F/, id);
    }
    const forged = structuredClone(report);
    forged.steps.at(-1).trials[0].status = 'pass';
    assert.throws(() => validateResult(forged), /UC3F/);
    const missing = structuredClone(report); delete missing.steps[3].trials[0].evidence;
    assert.throws(() => validateResult(missing), /UC3F/);
  }, evidenceBundle());
});

test('UC3F missing noise bounds leave a valid incomplete report without retaining unchecked timestamps', async () => {
  const bundle = evidenceBundle(), cost = bundle.rows.find(r => r.id === 'checkpoint-cost').evidence;
  delete cost.noise;
  cost.plannedUtc = 'PRIVATE planning data'; cost.startedUtc = 'PRIVATE measurement data';
  await withEvidenceFile(async path => {
    const report = await runSitting(opts({ phase: 'safety', safetyEvidence: path }), {
      platform: 'win32', loadSafetyModule: async () => null,
    });
    assert.equal(report.verdict, 'incomplete');
    assert.equal(report.steps.at(-1).trials[0].status, 'skip');
    assert.equal(report.steps.at(-1).trials[0].note, 'bounds not registered');
    assert.equal(report.steps.at(-1).trials[0].costs['session-probe'].count, 50);
    assert.equal(validateResult(report), true);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
    const forged = structuredClone(report);
    forged.steps.at(-1).trials[0].note = 'PRIVATE unchecked reason';
    assert.throws(() => validateResult(forged), /UC3F/);
    const wrongCount = structuredClone(report);
    wrongCount.steps.at(-1).trials[0].costs['session-probe'].count++;
    assert.throws(() => validateResult(wrongCount), /UC3F/);
  }, bundle);
});

test('UC3F rows skipped after a build failure keep the failed report valid and unqualified', async () => {
  const report = await runSitting(opts(), {
    platform: 'win32', prepare: async () => { throw Object.assign(Error(), { code: 'BUILD_FAILED' }); },
  });
  assert.equal(report.verdict, 'failed');
  for (const row of report.steps.filter(s => sitting.UC3F_ROWS.some(r => r.id === s.id)))
    assert.equal(row.trials[0].status, 'skip');
  assert.equal(validateResult(report), true);
  const forged = structuredClone(report);
  forged.verdict = 'passed-phase';
  assert.throws(() => validateResult(forged));
});

test('UC3F only all 22 rows qualify, and unsafe or unmeasured rows cannot be hidden by summary counts', async () => {
  const windows = [{ ...fakeWindows[0], title: 'driver-notepad.txt - Notepad' },
    { ...fakeWindows[1], windowId: '103', image: 'C:\\WindowsTerminal.exe', app: 'Windows Terminal' },
    { ...fakeWindows[0], windowId: '104', pid: 43, integrity: 'high', refused: 'ELEVATED_TARGET' }];
  await withEvidenceFile(async path => {
    const report = await runSitting(opts({ phase: 'safety', notepad: '101', terminal: '103', elevated: '104', elevatedPid: 43, safetyEvidence: path }), {
      platform: 'win32', createClient: () => ({ close() {}, request: async method => {
        assert.equal(method, 'getState', 'refusal checks must not fetch content'); return { windows };
      } }),
    });
    assert.equal(report.verdict, 'incomplete'); assert.equal(report.steps.length, 22); assert.equal(validateResult(report), true);
    assert.equal(report.steps.filter(s => s.summary.pass).length, 21);
    const missing = structuredClone(report); missing.steps.pop(); missing.verdict = 'passed-phase';
    assert.throws(() => validateResult(missing), /verdict/);
    const unsafe = structuredClone(report), step = unsafe.steps.find(s => s.id === 'lock-during-type');
    step.trials[0] = sitting.evaluateSafetyEvidence(step.id, (() => {
      const e = evidenceFor(step.id); brokenEvidence[step.id](e); return e;
    })());
    step.summary = summarize(step.trials); unsafe.verdict = 'failed';
    assert.equal(validateResult(unsafe), true);
    unsafe.verdict = 'passed-phase'; assert.throws(() => validateResult(unsafe), /verdict/);
  }, evidenceBundle());
});

// Run the same acceptance assertion against production code with exactly one
// critical field check removed. A surviving mutant is a test failure.
function assertEvidencePair(evaluate, id) {
  const good = evidenceFor(id), bad = structuredClone(good); brokenEvidence[id](bad);
  assert.equal(evaluate(id, good).status, id === 'checkpoint-cost' ? 'skip' : 'pass');
  assert.equal(evaluate(id, bad).status, 'fail');
}
const mutationField = {
  'person-idle': 'lastInputUnchanged', 'person-key-before': 'postedMessages', 'person-key-during': 'typed',
  'lock-refused': 'captures', 'lock-during-type': 'finalReads', 'screensaver-refused': 'code',
  'session-switch-refused': 'resumedWithoutRestart', 'uac-refused': 'inputWhilePrompt', 'uac-hint': 'secureDesktopSeen',
  'escape-stop-hardware': 'stopMs', 'escape-ignored-injected': 'escapeStops', 'escape-ignored-posted': 'escapeStops',
  'cancel-frame': 'flagMs', 'direct-launch-terminal': 'code', 'direct-launch-override': 'readPassed',
  'browser-refused-edge': 'cards', 'browser-refused-firefox': 'contentReads', 'browser-refused-renamed': 'code',
};
for (const id of Object.keys(uc3Cases)) test(`UC3F mutation proof: ${id} test fails when its critical check is broken`, () => {
  const source = readFileSync(new URL('../bench/windows/driver-sitting.mjs', import.meta.url), 'utf8');
  let evaluator = source.slice(source.indexOf('const record ='), source.indexOf('export function parseSittingArgs')).replaceAll('export ', '');
  if (id === 'checkpoint-cost') {
    assert.ok(evaluator.includes('sample[key], expect, true'));
    evaluator = evaluator.replace('!matchesObservation(sample[key], expect, true)', 'false');
  } else {
    assert.ok(evaluator.includes('!matchesObservation(sample[key], expect, true)'));
    assert.ok(evaluator.includes('matchesObservation(sample[key], expect));'));
    evaluator = evaluator.replace('!matchesObservation(sample[key], expect, true)',
      '!(id === disabledId && key === disabledField) && !matchesObservation(sample[key], expect, true)')
      .replace('matchesObservation(sample[key], expect));',
        '(id === disabledId && key === disabledField) || matchesObservation(sample[key], expect));');
  }
  const mutant = runInNewContext(`${evaluator}\nevaluateSafetyEvidence`, {
    structuredClone, percentile, disabledId: id, disabledField: mutationField[id],
    failure: code => Object.assign(Error(), { code }),
    skipped: note => ({ status: 'skip', note }), passed: extra => ({ status: 'pass', ...extra }),
    failed: (code, extra) => ({ status: 'fail', code, ...extra }),
  });
  assertEvidencePair(id === 'checkpoint-cost' ? evaluatorWithRegisteredNoise() : sitting.evaluateSafetyEvidence, id);
  assert.throws(() => assertEvidencePair(mutant, id), { code: 'ERR_ASSERTION' }, `surviving mutant: ${id}`);
});


test('minimal Windows children retain PATHEXT without inheriting unrelated variables', () => {
  const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
    PATHEXT: '.COM;.EXE;.BAT;.CMD', OS: 'Windows_NT', ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Local',
    PATH: 'PRIVATE', SECRET: 'PRIVATE', NODE_OPTIONS: '--inspect' };
  assert.deepEqual(sitting.minimalWindowsEnv(env), { SystemRoot: env.SystemRoot, WINDIR: env.WINDIR,
    TEMP: env.TEMP, TMP: env.TMP, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.deepEqual(sitting.collectorWindowsEnv(env), { SystemRoot: env.SystemRoot, WINDIR: env.WINDIR,
    TEMP: env.TEMP, TMP: env.TMP, PATHEXT: '.COM;.EXE;.BAT;.CMD', OS: 'Windows_NT',
    ProgramFiles: env.ProgramFiles, 'ProgramFiles(x86)': env['ProgramFiles(x86)'], LOCALAPPDATA: env.LOCALAPPDATA });
  assert.deepEqual(sitting.minimalWindowsEnv({ PATHEXT: undefined, SECRET: 'PRIVATE' }), {});
});
