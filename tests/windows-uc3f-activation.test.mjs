import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as collector from '../bench/windows/uc3f-collect.mjs';
import { verifyWindowIdentity } from '../plugins/sleight/lib/repl/identity.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
const source = readFileSync(url, 'utf8');
const nativeRoot = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
const variants = {
  'core-pid-ignored': ['w.corePid === app.pid', 'true'],
  'core-birth-ignored': ['w.coreProcessStart === app.processStart', 'true'],
  'containment-ignored': ['w.coreParentId === w.windowId', 'true'],
  'core-class-ignored': ["w.coreClassName === 'Windows.UI.Core.CoreWindow'", 'true'],
  'frame-birth-ignored': ['birth(w.frameProcessStart)', 'true'],
  'exited-activation-accepted': ["if (proof.activation.exited === true) fail('FIXTURE_EXITED');", ''],
  'title-only-frame-accepted': ['hwnd(w.coreWindowId) && w.coreWindowId !== w.windowId', 'true'],
  'cleanup-code-dropped': ['cleanupCodes.push({ stage, code });', ''],
  'blanket-worker-code': ['code = (GuestFailure $_) } | ConvertTo-Json -Compress', 'code = "FIXTURE_IDENTITY_CHANGED" } | ConvertTo-Json -Compress'],
  'close-targets-stub': ['CloseWindow($h)', 'CloseWindow($p.MainWindowHandle)'],
  'close-waits-two-seconds': ['$wait.ElapsedMilliseconds -lt 10000', '$wait.ElapsedMilliseconds -lt 2000'],
  'close-skips-birth': ['[void](WindowIdentity $r.fixture)\n    if (-not [Uc3fWindow]::DefaultDesktop())', 'if (-not [Uc3fWindow]::DefaultDesktop())'],
  'unsafe-arguments-accepted': ['/[\u005cs"\x27]/.test(s)', 'false'],
  'activation-replaced-by-exec': ['$activatedPid = [Uc3fWindow]::Activate', '$activatedPid = Start-Process'],
  'frame-containment-unchecked': ['IsChild(frame.Handle, core)', 'true', 'DriverInventory.cs'],
  'frame-input-root': ['hwnd != window.InputRoot && !IsChild(window.InputRoot, hwnd)', 'hwnd != window.Handle && !IsChild(window.Handle, hwnd)', 'DriverInput.cs'],
  'uia-reads-frame-host': ['automation.ElementFromHandleBuildCache(window.InputRoot, cache)', 'automation.ElementFromHandleBuildCache(window.Handle, cache)', 'DriverUia.cs'],
  'task-drops-cause': ['$reply.error = $code', "$reply.error = 'UC3F_GUEST_OPERATION_FAILED'", 'uc3f-task.ps1'],
  'observer-drops-cause': ['[Console]::Error.WriteLine($code)', "[Console]::Error.WriteLine('UC3F_OBSERVER_REFUSED')", 'uc3f-observer.ps1'],
  'injector-drops-gone': ['catch (ArgumentException) { throw new InvalidOperationException("FIXTURE_PROCESS_GONE"); }', 'catch (ArgumentException) { identityMatches = false; }', 'uc3f-inject.ps1'],
  'direct-worker-drops-cause': ['catch { @{ guestCode = (GuestFailure $_)', 'catch { @{ guestCode = "DIRECT_REPLY_TIMEOUT"'],
  'inner-fixed-code-lost': ["if ($innerCode -cmatch '^[A-Z][A-Z0-9_]{0,79}\\z') { return $innerCode }", ''],
  'driver-aumid-unchecked': ["if (receipt.activation && found.aumid !== receipt.activation.aumid) fail('FIXTURE_ACTIVATION_UNPROVED');", ''],
  'recovery-stops-at-stub': ['for (const fixture of state.fixtures) if (live.fixturePids.includes(fixture.pid)) {',
    "for (const receipt of state.launched) if (live.fixturePids.includes(receipt.pid)) {\n        const fixture = state.fixtures.find(f => f.pid === receipt.pid && f.processStart === receipt.processStart);\n        if (!fixture) fail('FIXTURE_CLOSE_UNPROVED');"],
};
const variant = process.env.UC3GFIX8_BROKEN;
if (variant && !variants[variant]) throw Error('UNKNOWN_TEST_VARIANT');
function changed(text, file) {
  const v = variants[variant];
  if (!v || v[2] !== file) return text;
  assert.ok(text.includes(v[0]), `${variant}: mutation anchor missing`);
  return text.replace(v[0], v[1]);
}
const activeSource = changed(source, undefined);
const api = variant && !variants[variant][2] ? await import('data:text/javascript;base64,' + Buffer.from(activeSource
  .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
  .replaceAll('import.meta.url', JSON.stringify(url.href)) + '\n//# sourceURL=uc3gf8-collector-mutant.mjs\n').toString('base64')) : collector;
const native = file => changed(readFileSync(new URL(file, nativeRoot), 'utf8'), file);
const guest = file => changed(readFileSync(new URL('../bench/windows/' + file, import.meta.url), 'utf8'), file);
const token = 'uc3f-0123456789abcdef';
const image = 'C:\\Program Files\\WindowsApps\\Calculator\\CalculatorApp.exe';
const birth = '134381325118728105';
const proof = () => ({
  launcher: { pid: 2872, processStart: birth, observedEnd: '134381325128728105', image },
  activation: { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', pid: 2872, processStart: birth, exited: false },
  expectedImage: image, frameHostImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', systemDirectory: 'C:\\Windows\\System32',
  windows: [{ windowId: '459238', pid: 2872, processStart: birth, image, title: 'Calculator', className: 'ApplicationFrameWindow',
    coreWindowId: '590666', corePid: 2872, coreProcessStart: birth, coreClassName: 'Windows.UI.Core.CoreWindow', coreParentId: '459238',
    framePid: 2812, frameProcessStart: '134381300000000000', frameImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe' }],
});
const options = { target: 'calculator', token };

test('UC3GFIX8 activation binds one frame containing the activated app CoreWindow', () => {
  const receipt = api.proveFixtureLaunch(proof(), options);
  assert.equal(receipt.pid, 2872); assert.equal(receipt.processStart, birth);
  assert.equal(receipt.windowId, '459238'); assert.equal(receipt.coreWindowId, '590666');
  assert.equal(receipt.framePid, 2812);
});

test('UC3GFIX8 activation source returns the activated PID, checks exits and waits for the containing frame', () => {
  const launch = api.GUEST_OPERATIONS.split("  'launch' {\n")[1].split("  'compile-fixture' {")[0];
  assert.match(launch, /\$activatedPid = \[Uc3fWindow\]::Activate\(\$aumid,/);
  assert.match(launch, /Get-Process -Id \$activatedPid/);
  assert.match(launch, /\$p.HasExited\) \{ throw 'FIXTURE_EXITED'/);
  assert.match(launch, /throw 'FIXTURE_WINDOW_NOT_SEEN'/);
  assert.match(launch, /\$corePid -ne \$p.Id/);
  assert.match(launch, /\$cores.Count -ne 1/);
  assert.match(launch, /WindowIdentity \$candidate/);
  assert.match(api.GUEST_OPERATIONS, /IApplicationActivationManager/);
  assert.match(api.GUEST_OPERATIONS, /Marshal.ReleaseComObject\(manager\)/);
  for (const id of ['Microsoft.WindowsCalculator', 'Microsoft.WindowsTerminal', 'Microsoft.WindowsNotepad'])
    assert.ok(launch.includes(id + '_8wekyb3d8bbwe!App'));
  // Edge in this table is the classic Program Files executable, including its
  // renamed copy. It never uses the retired packaged Edge activation identity.
  assert.match(launch, /edge = \(\(Get-Item -LiteralPath 'Env:ProgramFiles\(x86\)'/);
  assert.doesNotMatch(launch, /Microsoft\.MicrosoftEdge/);
  assert.match(activeSource, /receipt.activation && found.aumid !== receipt.activation.aumid/);
  assert.match(api.GUEST_FAILURE, /\$innerCode -cmatch '\^\[A-Z\]\[A-Z0-9_\]\{0,79\}\\z'\) \{ return \$innerCode \}/);
});

test('UC3GFIX8 native mapping keeps frame geometry, app input root and rechecked containment', () => {
  const inventory = native('DriverInventory.cs'), input = native('DriverInput.cs'), uia = native('DriverUia.cs');
  assert.match(inventory, /cores.Count != 1/);
  assert.match(inventory, /!app.SameIdentity\(again\) \|\| !frame.SameIdentity\(frameAgain\) \|\| !sight.Contained\(frame.Handle, core\)/);
  assert.match(inventory, /admitted.CoreHandle = core/);
  assert.match(inventory, /admitted.Handle = frame.Handle/);
  assert.match(inventory, /CoreHandle == other.CoreHandle && FramePid == other.FramePid && FrameStart == other.FrameStart/);
  assert.match(input, /hwnd != window\.InputRoot && !child/);
  assert.match(input, /Check\(window, hwnd, thread == 0 \? 0 : pid, IsChild, handle => DriverInventory\.Observe\(handle\)\)/);
  assert.match(input, /hwnd != window\.InputRoot && child\(window\.InputRoot, hwnd\)/);
  assert.match(input, /GetWindowThreadProcessId\(window.InputRoot, out pid\)/);
  assert.match(uia, /automation.ElementFromHandleBuildCache\(window.InputRoot, cache\)/);
  const capture = readFileSync(new URL('DriverCapture.cs', nativeRoot), 'utf8');
  assert.match(capture, /FrameBounds\(window.Handle, out bounds\)/);
  assert.match(input, /ActivityPid\(foreground, foregroundPid, window, DriverInput.IsChild, DriverInventory.LiveHostedAppPid\)/);
});

test('UC3H3 parent refuses packaged frames even with the older composite tuple', () => {
  const w = { ...proof().windows[0], aumid: proof().activation.aumid, integrity: 'low' };
  assert.throws(() => verifyWindowIdentity(w, { ...w }), { code: 'HOSTED_APP_UNRESOLVED' });
  w.className = 'FixtureWindow';
  verifyWindowIdentity(w, { ...w });
  for (const key of ['coreWindowId', 'framePid', 'frameProcessStart'])
    assert.throws(() => verifyWindowIdentity(w, { ...w, [key]: key === 'framePid' ? 99 : '99' }), { code: 'IDENTITY_CHANGED' });
});

function worker(code, captured, startup = false) {
  return api.createGuestInspector({ bank: 'C:\\sleight-setup\\' + token, executable: 'powershell.exe', env: {},
    writeOwned: (_name, text) => { captured.text = text; return 'identity-worker.ps1'; },
    spawnChild: (_exe, args) => {
      const nonce = args.at(-1), child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _enc, done) {
        const frame = JSON.parse(bytes.toString()); captured.frame = frame;
        queueMicrotask(() => {
          if (startup) { child.stderr.write(code + '\n'); child.emit('close', 1); }
          else child.stdout.write(JSON.stringify({ nonce, id: frame.id, ok: false, code }) + '\n');
        }); done();
      }, final(done) { child.emit('close', 0); done(); } });
      return child;
    } });
}

test('UC3GFIX8 startup exceptions and malformed worker codes stay fixed format', async () => {
  for (const [reply, expected, startup] of [['FIXTURE_ACCESS_DENIED', 'FIXTURE_ACCESS_DENIED', true],
    ['PRIVATE C:\\secret\ntext', 'INSPECTOR_PROTOCOL', false]]) {
    const inspector = worker(reply, {}, startup);
    await assert.rejects(inspector.inspect(proof().windows[0]), { code: expected });
    await inspector.close();
  }
});

test('UC3GFIX8 every guest entry point preserves fixed causes with bounded exception classification', () => {
  for (const file of ['uc3f-task.ps1', 'uc3f-observer.ps1', 'uc3f-inject.ps1']) {
    const text = guest(file);
    assert.match(text, /\$depth -lt 4/);
    assert.match(text, /\$innerCode -cin \$known\) \{ \$code = \$innerCode; break \}/);
    assert.match(text, /\$code -cnotin \$known/);
    for (const code of ['FIXTURE_PROCESS_GONE', 'FIXTURE_ACCESS_DENIED', 'FIXTURE_WINDOW_GONE']) assert.ok(text.includes(code), file + ': ' + code);
    if (file === 'uc3f-task.ps1') assert.match(text, /\$reply.error = \$code/);
    if (file === 'uc3f-observer.ps1') assert.match(text, /\[Console\]::Error.WriteLine\(\$code\)/);
    if (file === 'uc3f-inject.ps1') assert.match(text, /catch \(ArgumentException\) \{ throw new InvalidOperationException\("FIXTURE_PROCESS_GONE"\); \}/);
  }
});

test('UC3GFIX8 direct worker returns a fixed cause instead of hiding it behind its output timeout', async () => {
  let script;
  const code = 'FIXTURE_ACCESS_DENIED';
  await assert.rejects(api.runDirectTrial({ target: proof().windows[0], override: false, bank: 'C:\\sleight-setup\\' + token,
    tick: () => 1, now: () => 1, check: async () => {}, sleep: async () => {},
    prepare: async () => ({ status: 'ready', receipt: {} }), executableOf: () => 'driver.exe',
    nextInvocation: () => '1', psCall: async () => {}, writeOwned: (_name, text) => { script = text; return 'direct.ps1'; },
    read: () => JSON.stringify({ guestCode: code }), exists: () => true }), { code });
  assert.match(script, /guestCode = \(GuestFailure \$_\)/);
});

if (!variant) test('each UC3GFIX8 broken variant fails its regression in a separate offline child', () => {
  for (const name of Object.keys(variants)) {
    const env = { ...process.env, UC3GFIX8_BROKEN: name };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000', '--test-name-pattern=UC3GFIX8', fileURLToPath(import.meta.url)],
      { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.equal(result.signal, null, name + ': ' + result.stderr);
    assert.equal(result.status, 1, name + ': ' + result.stdout + result.stderr);
    assert.match(result.stdout, /# fail [1-9]/, name + ': variant must reach an assertion');
    const counts = ['tests', 'pass', 'fail', 'skipped'].map(k => `${k}=${result.stdout.match(new RegExp(`# ${k} (\\d+)`))?.[1] ?? 'missing'}`).join(' ');
    console.log(`BROKEN_VARIANT ${name} exit=${result.status} ${counts}`);
  }
});
