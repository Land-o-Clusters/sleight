import test from 'node:test';
import assert from 'node:assert/strict';
import { win32, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { windowBinding } from '../plugins/sleight/lib/windows-repl/identity.mjs';
import * as collector from '../bench/windows/uc3f-collect.mjs';
const { GUEST_OPERATIONS, openTerminalSettings } = collector;

const opener = GUEST_OPERATIONS.split("  'terminal-settings-open' {")[1].split("  'terminal-settings' {")[0];
const census = GUEST_OPERATIONS.split("  'terminal-control-tree' {")[1].split("  'terminal-settings-open' {")[0];

function requireSplitButtonPolicy(source) {
  for (const required of [
    "AutomationIdProperty,'NewTabButton'",
    '$_.Current.ControlType -eq [Windows.Automation.ControlType]::SplitButton',
    '$_.Current.ProcessId -eq $p.Id',
    '$dropdown.Count -ne 1',
    'IsExpandCollapsePatternAvailableProperty',
    'ExpandCollapsePattern]::Pattern).Expand()',
  ]) assert.ok(source.includes(required), required);
  const act = source.indexOf('ExpandCollapsePattern]::Pattern).Expand()');
  assert.ok(source.lastIndexOf('[void](Bound $r.fixture)', act) > source.indexOf('$dropdown.Count -ne 1'));
  assert.ok(source.lastIndexOf('[Uc3fWindow]::DefaultDesktop()', act) > source.indexOf('$dropdown.Count -ne 1'));
  assert.doesNotMatch(source, /InvokePattern|SendInput|SendKeys|SetFocus|NewTabDropdownButton/);
}

test('Terminal 1.24 opener uses the observed SplitButton identity and fails closed on changed UI', () => {
  // The retained 1.24.12741.0 census exposed NewTabButton as a SplitButton.
  // Native execution remains a Windows guest check. These are source-policy assertions.
  requireSplitButtonPolicy(opener);
  for (const required of ["AutomationIdProperty,'NewTabButton'", 'ControlType]::SplitButton',
    '$_.Current.ProcessId -eq $p.Id', '$dropdown.Count -ne 1', 'IsExpandCollapsePatternAvailableProperty',
    '[void](Bound $r.fixture)', '[Uc3fWindow]::DefaultDesktop()'])
    assert.throws(() => requireSplitButtonPolicy(opener.replaceAll(required, 'BROKEN')), assert.AssertionError);
  assert.throws(() => requireSplitButtonPolicy(opener.replace('.Expand()', '.Invoke()')), assert.AssertionError);
});

test('Terminal census includes SplitButton capability metadata without reading terminal content', () => {
  const audit = source => {
    assert.ok(source.includes('[Windows.Automation.ControlType]::SplitButton'));
    assert.ok(source.includes('IsExpandCollapsePatternAvailableProperty'));
    assert.ok(source.includes('$controls.Count -ge 256'));
    assert.ok(source.includes('$clock.ElapsedMilliseconds -gt 1500'));
    assert.doesNotMatch(source, /TextPattern|ValuePattern|GetText|\.Invoke\(|\.Expand\(|SendInput/);
  };
  audit(census);
  assert.throws(() => audit(census.replace('[Windows.Automation.ControlType]::SplitButton', 'BROKEN')), assert.AssertionError);
});

test('a denied second Settings permit sends no menu invocation', async () => {
  const calls = []; let permits = 0;
  await assert.rejects(openTerminalSettings({ beforeInput: async () => {
    if (++permits === 2) throw Error('MAC_INPUT_REFUSED');
  }, check: async () => {}, inspect: async () => {}, call: async name => calls.push(name) }, {}), /MAC_INPUT_REFUSED/);
  assert.deepEqual(calls, ['terminal-settings-open']);
});

const previous = { target: 'terminal', refusalOnly: true, refusalObserved: true, refused: 'FORBIDDEN_TARGET',
  windowId: '101', pid: 42, processStart: '134382652462791842', image: 'C:\\fixture\\WindowsTerminal.exe',
  title: 'uc3f-0123456789abcdef', className: 'CASCADIA_HOSTING_WINDOW_CLASS', integrity: 'medium' };
const settings = { windowId: previous.windowId, pid: previous.pid, processStart: previous.processStart,
  image: null, title: null, className: null, bindingId: null, refused: 'FORBIDDEN_SETTINGS',
  integrity: 'medium', cloaked: false, minimized: false, popup: false, onCurrentDesktop: true };
const native = { pid: previous.pid, processStart: previous.processStart, image: previous.image,
  className: previous.className, title: 'Settings' };

function settingsContract(bind) {
  const result = bind(previous, settings, native);
  assert.equal(result.windowId, previous.windowId);
  assert.equal(result.title, 'Settings');
  assert.equal(result.image, previous.image);
  assert.equal(result.refused, 'FORBIDDEN_SETTINGS');
  assert.equal(result.refusalOnly, true);
  assert.equal(result.refusalObserved, true);
  assert.equal(Object.hasOwn(result, 'bindingId'), false);
  assert.deepEqual(windowBinding(result), { windowId: previous.windowId, processStart: previous.processStart });
  const invalid = [
    [{ ...previous, target: 'cover' }, settings, native],
    [{ ...previous, refusalObserved: false }, settings, native],
    [previous, { ...settings, refused: 'FORBIDDEN_TARGET' }, native],
    [previous, { ...settings, pid: 43 }, native],
    [previous, { ...settings, processStart: '134382652462791843' }, native],
    [previous, { ...settings, windowId: '102' }, native],
    [previous, { ...settings, cloaked: true }, native],
    [previous, { ...settings, minimized: true }, native],
    [previous, { ...settings, popup: true }, native],
    [previous, { ...settings, onCurrentDesktop: false }, native],
    [previous, { ...settings, integrity: 'high' }, native],
    ...['pid', 'processStart', 'image', 'className', 'title'].map(key => [previous, settings, { ...native, [key]: 'changed' }]),
  ];
  for (const args of invalid) assert.throws(() => bind(...args), /FIXTURE_IDENTITY_CHANGED/);
}

test('redacted Settings inventory binds only the same independently checked fixture and grants no read token', () => {
  settingsContract(collector.bindTerminalSettingsFixture);
});

for (const predicate of ["previous?.target !== 'terminal'", 'previous.refusalObserved !== true', "window?.refused !== 'FORBIDDEN_SETTINGS'",
  'window[k] !== previous[k]', 'native?.[k] !== previous[k]', "native?.title !== 'Settings'",
  'window.cloaked || window.minimized || window.popup', 'window.onCurrentDesktop !== true',
  "!['low', 'medium'].includes(window.integrity)"])
test(`Settings identity contract catches removed check: ${predicate}`, () => {
  const source = collector.bindTerminalSettingsFixture.toString();
  assert.ok(source.includes(predicate));
  const broken = new Function('win32', 'windowBinding', 'fail', `return (${source.replace(predicate, 'false')});`)(
    win32, windowBinding, code => { throw Error(code); });
  assert.throws(() => settingsContract(broken), assert.AssertionError);
});

async function settingsBackendContract(t, makeBackend) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-terminal-settings-')));
  t.after(() => removeTemp(root));
  const bank = join(root, previous.title); mkdirSync(bank);
  const lease = { row: 'direct-launch-terminal', presence: 'away', token: 'a'.repeat(32),
    issuedUtc: new Date().toISOString(), expiresUtc: new Date(Date.now() + 60000).toISOString() };
  writeFileSync(join(bank, 'lease.json'), JSON.stringify(lease));
  const initial = { ...settings, refused: 'FORBIDDEN_TARGET' };
  let settingsOpen = false, closedFixture;
  const registered = [], inspections = [];
  const fail = code => Object.assign(Error(code), { code });
  const driver = { request: async method => {
    if (method === 'getState') return { windows: [settingsOpen ? settings : initial] };
    if (method === 'getApp') throw fail(settingsOpen ? 'FORBIDDEN_SETTINGS' : 'FORBIDDEN_TARGET');
    throw Error(method);
  }, close: async () => {} };
  const backend = makeBackend({ bank, rows: ['direct-launch-terminal'], revision: 'a'.repeat(40),
    ownerAway: true, lease, transportInvocation: '3' }, { platform: 'win32', validateBank() {},
    createClient: () => driver,
    makeInspector: () => ({ inspect: async fixture => fixture, close: async () => {} }),
    createRepl: ({ dispatch }) => ({ execute: async () => {
      await dispatch('getApp', { selector: { windowId: previous.windowId } }).catch(() => {});
      return { isError: true, content: [] };
    }, close: async () => {} }),
    guestCall: async (op, params) => {
      if (op === 'fixture-status') return { matches: [] };
      if (op === 'launch') return { expectedImage: previous.image,
        launcher: { pid: previous.pid, processStart: previous.processStart, image: previous.image, observedEnd: previous.processStart },
        windows: [{ ...previous }] };
      if (op === 'inspect') {
        inspections.push(params.fixture);
        return { ...native, title: settingsOpen ? 'Settings' : previous.title };
      }
      if (op === 'terminal-control-tree') return { controls: [] };
      if (op === 'terminal-settings-open') return { opened: true };
      if (op === 'terminal-settings') { settingsOpen = true; return { opened: true }; }
      if (op === 'close') { closedFixture = params.fixture; return { closed: true }; }
      throw Error(op);
    } });
  t.after(() => backend.closeClients());
  await backend.setup({ id: 'direct-launch-terminal' }, { check: async () => {}, register: f => registered.push(f) });
  let adopted;
  const result = await backend.measure({ rowId: 'direct-launch-terminal', caseId: 'parent-settings', trial: 0,
    fixtures: registered, check: async () => {},
    rebindSettings: (old, next) => { assert.equal(old, registered[0]); adopted = next; return next; } });
  assert.equal(result.driver[0].raw.code, 'FORBIDDEN_SETTINGS');
  assert.equal(inspections.at(-1).title, 'Settings');
  assert.equal(inspections.at(-1).windowId, previous.windowId);
  assert.equal(adopted.title, 'Settings');
  assert.equal(Object.hasOwn(adopted, 'bindingId'), false);
  assert.equal(adopted.refusalOnly, true);
  assert.equal(adopted.refusalObserved, true);

}

test('real Settings backend independently inspects and binds the refused Settings window', async t => {
  await settingsBackendContract(t, collector.createGuestBackend);
});
