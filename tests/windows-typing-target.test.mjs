import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import * as collector from '../bench/windows/uc3f-collect.mjs';

const notepad = { target: 'notepad', pid: 41, windowId: '101' };
const receiver = { target: 'wpf', pid: 42, windowId: '102', processStart: '1000000', image: 'C:\\bank\\receiver.exe' };
const state = { unlocked: true, connected: true, tickMs: 10000, lastInputTickMs: 9999, word: false,
  foregroundPid: 42, foregroundWindowId: '102', foregroundProcessStart: receiver.processStart, foregroundImage: receiver.image };

function witness(api) {
  assert.equal(api.backgroundTypingReady(state, [notepad, receiver]).kind, 'wpf');
  assert.equal(api.backgroundTypingReady({ ...state, word: true, foregroundPid: 60, foregroundWindowId: '160' }, [notepad, receiver]).kind, 'word');
  for (const change of [{ foregroundPid: 41 }, { foregroundWindowId: '101' }, { foregroundPid: 99 },
    { foregroundProcessStart: 'recycled' }, { foregroundImage: 'C:\\other.exe' }, { unlocked: false }, { connected: false },
    { lastInputTickMs: 7999 }, { lastInputTickMs: undefined }])
    assert.equal(api.backgroundTypingReady({ ...state, ...change }, [notepad, receiver]), undefined, JSON.stringify(change));
  assert.equal(api.backgroundTypingReady(state, [notepad, receiver], state.lastInputTickMs), undefined);
  assert.equal(api.backgroundTypingReady({ ...state, lastInputTickMs: 8000 }, [notepad, receiver]).kind, 'wpf');
  const wrap = { ...state, tickMs: 0x100000010, lastInputTickMs: 0xfffffff0 };
  assert.equal(api.backgroundTypingReady(wrap, [notepad, receiver]).kind, 'wpf');
  // A receiver bound to another window in the fixture process is still unsafe.
  assert.equal(api.backgroundTypingReady({ ...state, foregroundPid: 41 }, [notepad, { ...receiver, pid: 41 }]), undefined);
}

test('only owned foreground WPF or WINWORD with a new input tick within 2 seconds admits each trial', () => witness(collector));
test('the fixture-as-typing-target broken variant fails the behavioral witness', async () => {
  const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const needles = ['state.foregroundPid === fixture.pid || ', 'value.pid === value.fixturePid ||'];
  let broken = source;
  for (const needle of needles) { assert.ok(broken.includes(needle)); broken = broken.replace(needle, ''); }
  broken = broken.replace(/from '(\.\.?\/[^']+)'/g, (_all, p) => `from '${new URL(p, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(broken).toString('base64'));
  assert.throws(() => witness(mutant), assert.AssertionError);
});
test('present person-idle prepares separate Notepad and harness-owned WPF fixtures without changing case IDs', () => {
  const row = collector.collectorPlan(['person-idle'])[0];
  row.cases = row.cases.filter(c => c.id === 'background-word');
  assert.deepEqual(collector.fixtureTargets(row), ['notepad', 'wpf']);
  assert.equal(row.cases[0].trials, 20);
  const source = collector.guestFixtureSource({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', ownerAway: false, typingTarget: true });
  assert.match(source, /Owner typing target/);
  assert.match(source, /'typing-receiver.json'/);
  assert.doesNotMatch(source, /'receiver.json'/);
});

test('both owner rows set up in one bank, and the production readiness gate rejects the fixture and repeated input', async () => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'windows-typing-target-')));
  const windows = [], compileModes = [];
  let readiness;
  const dependencies = { platform: 'win32', validateBank() {}, tick: () => 10000, notepadPreflight: async () => {},
    makeInspector: () => ({ inspect: async f => ({ ...f }) }),
    createClient: () => ({ request: async method => {
      assert.equal(method, 'getState'); return { windows };
    } }),
    guestCall: async (operation, values) => {
      if (operation === 'readiness') return readiness;
      if (operation === 'compile-fixture') { compileModes.push(values.typingTarget); return {}; }
      assert.equal(operation, 'launch');
      const pid = 50 + windows.length;
      const window = { ...fakeWindows[0], pid, windowId: String(100 + pid), processStart: String(100000 + pid),
        image: values.target === 'wpf' ? win32.join(bank, values.typingTarget ? 'typing-receiver.exe' : 'receiver.exe') : 'C:\\Windows\\notepad.exe',
        title: values.target === 'wpf' ? 'Sleight WDR7 WPF' : `driver-notepad.txt-${win32.basename(bank)}.txt - Notepad`,
        className: values.target === 'wpf' ? 'HwndWrapper[fixture]' : 'Notepad' };
      windows.push(window);
      return { expectedImage: window.image, launcher: { ...window, observedEnd: window.processStart }, windows: [window] };
    } };
  const base = { bank, ownerAway: false, revision: 'a'.repeat(40) };
  const hardware = collector.createGuestBackend({ ...base, rows: ['escape-stop-hardware'], transportInvocation: '2' }, dependencies);
  await hardware.setup(collector.collectorPlan(['escape-stop-hardware'])[0], { check: async () => {}, register() {} });
  const present = collector.createGuestBackend({ ...base, rows: ['person-idle'], transportInvocation: '3' }, dependencies);
  const row = collector.collectorPlan(['person-idle'])[0]; row.cases = row.cases.filter(c => c.id === 'background-word');
  const registered = [];
  await present.setup(row, { check: async () => {}, register: f => registered.push(f) });
  assert.deepEqual(compileModes, [false, true]);
  for (const name of ['receiver.ps1', 'fixture-launcher.cs', 'typing-receiver.ps1', 'typing-fixture-launcher.cs'])
    assert.equal(existsSync(join(bank, name)), true, name);
  const receiver = registered.find(f => f.target === 'wpf'), fixture = registered.find(f => f.target === 'notepad');
  assert.notEqual(receiver.pid, fixture.pid);
  readiness = { ...state, foregroundPid: receiver.pid, foregroundWindowId: receiver.windowId,
    foregroundProcessStart: receiver.processStart, foregroundImage: receiver.image };
  assert.equal(await present.readGo('person-idle', 'background-word', 0), true);
  assert.equal(await present.readGo('person-idle', 'background-word', 1), false);
  readiness.lastInputTickMs++;
  assert.equal(await present.readGo('person-idle', 'background-word', 1), true);
  readiness = { ...readiness, word: true, foregroundPid: fixture.pid, foregroundWindowId: fixture.windowId, lastInputTickMs: 9998 };
  assert.equal(await present.readGo('person-idle', 'background-word', 2), false);
});
