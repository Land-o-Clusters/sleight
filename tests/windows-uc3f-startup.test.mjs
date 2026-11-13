import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import * as collector from '../bench/windows/uc3f-collect.mjs';

const url = new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url);
const source = readFileSync(url, 'utf8');
async function changed(before, after) {
  assert.ok(source.includes(before));
  return import('data:text/javascript;base64,' + Buffer.from(source.replace(before, after)
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href))).toString('base64'));
}
test('fixture generation inserts the exact preflight bytes once, including PowerShell dollar quotes', async () => {
  const o = { bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', ownerAway: true, lease: { token: 'a'.repeat(32) } };
  const context = "$r = '" + JSON.stringify({ bank: o.bank, operation: 'fixture', presence: 'away' }) + "' | ConvertFrom-Json\n";
  const [before, after] = collector.GUEST_FIXTURE.split('# UC3F_PREFLIGHT');
  const expected = before + context + collector.GUEST_OPERATIONS.split('switch ($r.operation)')[0]
    .replace('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n', '') + after;
  assert.equal(collector.guestFixtureSource(o), expected);
  const broken = await changed("replace('# UC3F_PREFLIGHT', () =>", "replace('# UC3F_PREFLIGHT',");
  assert.notEqual(broken.guestFixtureSource(o), expected);
  assert.equal(collector.guestFixtureSource(o).split('public static class Uc3fReceiver').length, 2);
});
test('windowless embedded preflight never accesses Console encoding while CLI protocol keeps UTF-8', async () => {
  const options = { bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', ownerAway: true, lease: { token: 'a'.repeat(32) } };
  assert.doesNotMatch(collector.guestFixtureSource(options), /\[Console\]::OutputEncoding/);
  assert.match(collector.GUEST_OPERATIONS, /\[Console\]::OutputEncoding = New-Object Text\.UTF8Encoding\(\$false\)/);
  const broken = await changed(".replace('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\\n', '')", '');
  assert.match(broken.guestFixtureSource(options), /\[Console\]::OutputEncoding/);
});
test('native WPF polling filters title and class before deciding that launch is ready', () => {
  const predicate = "if ($target -ceq 'wpf' -and ($title.ToString() -cne 'Sleight WDR7 WPF' -or -not $class.ToString().StartsWith('HwndWrapper[',[StringComparison]::Ordinal))) { continue }";
  const audit = text => {
    const block = text.slice(text.indexOf("  'launch' {"), text.indexOf("'compile-fixture'"));
    assert.ok(block.includes(predicate));
    assert.ok(block.indexOf(predicate) < block.indexOf('$windows += @{ pid=$owner;'));
  };
  audit(collector.GUEST_OPERATIONS);
  assert.throws(() => audit(collector.GUEST_OPERATIONS.replace(predicate, '')), assert.AssertionError);
});
test('embedded fixture loads only its bank-bound reviewed script, without changing execution policy', () => {
  const audit = s => {
    assert.match(s, /ps\.AddScript\(File\.ReadAllText\(Path\.Combine\(args\[0\], "receiver.ps1"\)\)\)/);
    assert.match(s, /AddParameter\("Bank",args\[0\]\)/);
    assert.match(s, /AddParameter\("Token",Path.GetFileName\(args\[0\]\)\)/);
    assert.ok(s.includes('@"\u005cAC:\u005c\u005csleight-setup\u005c\u005cuc3f-[a-f0-9]{16}\u005cz"'));
    assert.doesNotMatch(s, /AddCommand|Set-ExecutionPolicy|ExecutionPolicy\s*=/);
  };
  audit(collector.FIXTURE_LAUNCHER);
  for (const [before, after] of [['AddScript', 'AddCommand'], ['"receiver.ps1"', 'args[0]'],
    ['AddParameter("Bank",args[0])', 'AddParameter("Bank","other")']])
    assert.throws(() => audit(collector.FIXTURE_LAUNCHER.replace(before, after)), assert.AssertionError);
});

test('embedded receiver retains bounded startup failure metadata without error messages', () => {
  const audit = text => {
    for (const needle of ['receiver-startup.json', 'FileMode.CreateNew', 'new UTF8Encoding(false)',
      'count++ == 8', 'error.InvocationInfo.ScriptLineNumber', 'error.Exception.GetType().FullName',
      'if (ps.HadErrors) StartupFailure(args[0], ps.Streams.Error)',
      'catch (RuntimeException error)', 'new[] { error.ErrorRecord }']) assert.ok(text.includes(needle), needle);
    assert.doesNotMatch(text, /error\.Exception\.Message|error\.ToString\(|error\.ErrorDetails|ScriptStackTrace/);
  };
  audit(collector.FIXTURE_LAUNCHER);
  for (const needle of ['receiver-startup.json', 'FileMode.CreateNew', 'count++ == 8',
    'if (ps.HadErrors) StartupFailure(args[0], ps.Streams.Error)'])
    assert.throws(() => audit(collector.FIXTURE_LAUNCHER.replace(needle, 'REMOVED')), assert.AssertionError);
});

test('receiver publishes atomic JSON with a typed null backup and no BOM', () => {
  const audit = s => {
    assert.ok(s.includes('public static void Publish(string path, string record)'));
    assert.ok(s.includes('File.WriteAllText(pending, record, new UTF8Encoding(false))'));
    assert.ok(s.includes('if (File.Exists(path)) File.Replace(pending, path, null)'));
    assert.ok(s.includes('else File.Move(pending, path)'));
    assert.ok(s.includes('[Uc3fReceiver]::Publish($path,$record)'));
    assert.doesNotMatch(s, /\[IO.File\]::Replace/);
  };
  audit(collector.GUEST_FIXTURE);
  for (const [before, after] of [['new UTF8Encoding(false)', 'new UTF8Encoding(true)'], ['File.Replace(pending, path, null)', 'File.Replace(pending, path, "")'],
    ['else File.Move(pending, path)', 'else {}'], ['[Uc3fReceiver]::Publish($path,$record)', '[IO.File]::Replace($path,$path,$null)']])
    assert.throws(() => audit(collector.GUEST_FIXTURE.replace(before, after)), assert.AssertionError, before);
});

test('refusal-only Calculator receives measured process integrity with bounded token cleanup', () => {
  const audit = text => {
    for (const needle of ['OpenProcessToken(process, 0x0008, out token)', 'GetTokenInformation(token, 25, data, needed, out needed)',
      'needed > 65536', 'count < 1 || count > 15', 'Marshal.FreeHGlobal(data)', '!CloseHandle(token)',
      'rid >= 0x3000 ? "high"', '$candidate.integrity = [Uc3fWindow]::ProcessIntegrity($p.Handle)']) assert.ok(text.includes(needle), needle);
    assert.ok(text.includes('FIXTURE_INTEGRITY_UNPROVED'));
  };
  audit(collector.GUEST_OPERATIONS);
  for (const needle of ['OpenProcessToken(process, 0x0008, out token)', 'GetTokenInformation(token, 25, data, needed, out needed)',
    'needed > 65536', 'count < 1 || count > 15', 'Marshal.FreeHGlobal(data)', '!CloseHandle(token)',
    'rid >= 0x3000 ? "high"', '$candidate.integrity = [Uc3fWindow]::ProcessIntegrity($p.Handle)'])
    assert.throws(() => audit(collector.GUEST_OPERATIONS.replace(needle, 'REMOVED')), assert.AssertionError);
  const fixture = { pid: 7, processStart: '134381425370282313', windowId: '2360086', image: 'fixture.exe', className: 'ApplicationFrameWindow' };
  for (const integrity of ['low', 'medium']) assert.doesNotThrow(() => collector.assertFixture({ ...fixture, integrity }, [{ ...fixture, integrity }]));
  for (const integrity of [undefined, 'unknown', 'high', 'system']) assert.throws(() => collector.assertFixture({ ...fixture, integrity }, [{ ...fixture, integrity }]));
});

const receipt = { pid: 7, processStart: '134381425370282313', windowId: '2360086', image: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', title: 'Sleight WDR7 cover', className: 'HwndWrapper[fixture]' };
const window = { pid: receipt.pid, processStart: receipt.processStart, windowId: receipt.windowId, image: null, title: null,
  className: null, integrity: 'medium', refused: 'FORBIDDEN_TARGET', cloaked: false, minimized: false, popup: false, onCurrentDesktop: true };
const native = { ...receipt };
test('cover cleanup identity retains the driver refusal and requires exact native metadata', () => {
  const result = collector.bindRefusedFixture(receipt, window, native, 'cover');
  assert.equal(result.refused, 'FORBIDDEN_TARGET'); assert.equal(result.refusalOnly, true);
  assert.equal(result.image, receipt.image); assert.equal(result.refusalObserved, undefined);
  for (const field of ['pid', 'processStart', 'windowId']) assert.throws(() => collector.bindRefusedFixture(receipt,
    { ...window, [field]: field === 'pid' ? 8 : '1' }, native, 'cover'));
  for (const field of ['pid', 'processStart', 'image', 'title', 'className']) assert.throws(() => collector.bindRefusedFixture(receipt,
    window, { ...native, [field]: field === 'pid' ? 8 : 'other' }, 'cover'));
  for (const patch of [{ refused: 'FORBIDDEN_SETTINGS' }, { refused: null }, { integrity: 'high' }, { cloaked: true },
    { minimized: true }, { popup: true }, { onCurrentDesktop: false }])
    assert.throws(() => collector.bindRefusedFixture(receipt, { ...window, ...patch }, native, 'cover'));
  assert.throws(() => collector.bindRefusedFixture(receipt, window, native, 'wpf'));
});
test('refusal binding catches broken PID, birth, native identity, refusal and scope variants', () => {
  const body = collector.bindRefusedFixture.toString();
  const make = (before, after) => { assert.ok(body.includes(before)); return Function('fail', 'win32', `return (${body.replace(before, after)})`)(code => { throw Error(code); }, win32); };
  const tests = [
    ["['pid', 'processStart', 'windowId'].some(k => window[k] !== receipt[k])", 'false', { window: { ...window, pid: 8 } }],
    ["['pid', 'processStart', 'image', 'title', 'className'].some(k => native?.[k] !== receipt[k])", 'false', { native: { ...native, className: 'other' } }],
    ["window?.refused !== 'FORBIDDEN_TARGET'", 'false', { window: { ...window, refused: null } }],
    ["!['cover', 'terminal'].includes(target)", 'false', { target: 'wpf' }],
  ];
  for (const [before, after, patch] of tests) {
    const f = make(before, after);
    assert.doesNotThrow(() => f(receipt, patch.window ?? window, patch.native ?? native, patch.target ?? 'cover'));
  }
});
test('registration requires an observed product refusal before retaining native cleanup identity', () => {
  const audit = s => {
    assert.ok(s.includes("const fixture = bindRefusedFixture(receipt, found, native, target)"));
    assert.ok(s.includes("if (error.code !== 'FORBIDDEN_TARGET') throw error"));
    const block = s.slice(s.indexOf("if (['cover', 'terminal'].includes(target) && found.refused"), s.indexOf('if (found.image !== receipt.image'));
    assert.ok(block.includes("c.request('getApp', { selector: { windowId: receipt.windowId } })"));
    assert.ok(block.indexOf('fixture.refusalObserved = true') > block.indexOf("c.request('getApp'"));
    assert.ok(block.indexOf('register(fixture)') > block.indexOf('fixture.refusalObserved = true'));
  };
  const collectorSource = readFileSync(new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), 'utf8');
  audit(collectorSource);
  for (const needle of ['const fixture = bindRefusedFixture(receipt, found, native, target)', "if (error.code !== 'FORBIDDEN_TARGET') throw error", 'fixture.refusalObserved = true'])
    assert.throws(() => audit(source.replace(needle, 'REMOVED')), assert.AssertionError);
});
