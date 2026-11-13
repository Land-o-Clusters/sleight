import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createWindowsDriverClient, DRIVER_PROTOCOL } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { MAC_DRIVER_SENTENCES, formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { windowsClipboardFixture as fixture, usKey, serializeFixtureTree } from './fixtures/windows-driver-fake.mjs';
import * as rule from '../plugins/sleight/lib/windows-driver/clipboard.mjs';
import { guardWindowsAction } from '../plugins/sleight/lib/windows-driver/guard.mjs';
import { parseChord, validateActionParams } from '../plugins/sleight/lib/windows-driver/actions.mjs';
import { assertWindowsClipboardSources, assertWindowsClipboardParentSources } from '../plugins/sleight/lib/windows-driver/clipboard-source.mjs';
import { clipboardWriteLabels, normalizeActionLabel, clipboardLabelWrites } from '../plugins/sleight/lib/action-labels.mjs';
import * as macLabels from '../plugins/sleight/lib/mac-driver/diff.mjs';

const base = new URL('../plugins/sleight/lib/', import.meta.url);
const native = name => readFileSync(new URL('direct-browser/native/win/' + name, base), 'utf8');
const params = args => ({ windowId: '101', processStart: '1', readId: 1, args });
const menuNodes = (name = 'Copy', accelerator = 'Ctrl+C', extras = {}) => [
  { depth: 0, role: 'menu', name: 'Edit', className: '#32768' },
  { depth: 1, role: 'menu item', name, accelerator, focused: true, rect: [10, 10, 30, 30], ...extras },
];
async function refused(h, method, args, code = 'ACTION_UNSUPPORTED', options = {}) {
  const count = h.actions.length;
  await assert.rejects(h.action(method, args, options), { code });
  assert.equal(h.actions.length, count); assert.equal(h.posts.length, 0); assert.equal(h.patterns.length, 0);
}
async function changed(h, method, args, options) {
  await assert.rejects(h.action(method, args, options), {
    code: 'CLIPBOARD_CHANGED', next: 'stop-tell-user', retry: 'read-first', delivery: 'sent-unverified',
  });
  assert.equal(h.actions.length, 1);
}

test('WCB1 case 1: Control+C refuses before either accelerator Invoke or posted input', async () => {
  for (const nodes of [menuNodes(), menuNodes('Ordinary', '')]) {
    const h = fixture({ nodes }); await refused(h, 'pressKey', ['Control+c'], 'ACTION_UNSUPPORTED', { parent: false });
  }
});
test('WCB1 case 2: Russian resolved VK C refuses, unavailable Latin c never posts', async () => {
  const map = c => c === 'с' ? 0x43 : -1;
  await refused(fixture({ map }), 'pressKey', ['Control+с']);
  await refused(fixture({ map }), 'pressKey', ['Control+c'], 'KEY_LAYOUT_UNAVAILABLE', { parent: false });
});
test('WCB1 case 3: synthetic Dvorak VK mapping is checked, without a live layout claim', async () => {
  for (const character of ['c', 'j']) await refused(fixture({ map: c => c === character ? 0x43 : -1 }), 'pressKey', ['Control+' + character]);
});
test('WCB1 case 4: alternate chords, extra modifiers, PrintScreen and strict paste refuse', async () => {
  for (const chord of ['Control+Insert', 'Shift+Delete', 'Shift+Insert', 'Win+c', 'Win+x', 'Control+Shift+c',
    'Control+Alt+x', 'Control+v', 'PrintScreen', 'Alt+PrintScreen', 'Win+Shift+s', 'ctrl+alt+shift+printscreen'])
    await refused(fixture(), 'pressKey', [chord]);
  assert.equal(parseChord('PrintScreen').virtualKey, 0x2c);
});
test('WCB1 case 5: open-menu AccessKey guards bare and Alt mnemonics, others reach the backstop', async () => {
  for (const access of ['c', 'Alt+C', '&c']) for (const chord of ['c', 'Alt+c'])
    await refused(fixture({ nodes: menuNodes('Ordinary', 'Ctrl+C', { access }) }), 'pressKey', [chord], 'ACTION_UNSUPPORTED', { parent: false });
  for (const chord of ['c', 'Alt+c']) await refused(fixture({ nodes: menuNodes('Copy', '', { access: 'c' }) }), 'pressKey', [chord], 'ACTION_UNSUPPORTED', { parent: false });
  const h = fixture({ nodes: menuNodes('Unknown', '', { access: 'c' }) });
  await changed(h, 'pressKey', ['Alt+c'], { during: () => h.bump() });
  await refused(fixture(), 'pressKey', ['Alt+e']);
});
test('WCB1 case 6: localized modifier text uses the shared table, Cyrillic uses the accelerator or detector', async () => {
  await refused(fixture({ nodes: menuNodes('Kopieren', 'Strg+C') }), 'click', [1]);
  await refused(fixture({ nodes: menuNodes('Копировать', 'Ctrl+C') }), 'click', [1], 'ACTION_UNSUPPORTED', { parent: false });
  const h = fixture({ nodes: menuNodes('Копировать', '') }); await changed(h, 'click', [1], { during: () => h.bump() });
});
test('WCB1 case 7: any-role Copy labels refuse, unlisted languages use the detector', async () => {
  for (const name of ['Copy link', 'Copy as path']) await refused(fixture({ nodes: menuNodes(name, '') }), 'click', [1]);
  // The existing Mac normalizer folds ë to e, matching German kopieren.
  await refused(fixture({ nodes: menuNodes('Link kopiëren', '') }), 'click', [1]);
  const h = fixture({ nodes: menuNodes('Kopieer', '') }); await changed(h, 'click', [1], { during: () => h.bump() });
});
test('WCB1 case 8: submenu and context-menu final items share the native target gate', async () => {
  const h = fixture({ nodes: menuNodes('Share', '') }); await h.action('click', [1]);
  h.nodes[1].name = 'Copy'; h.nodes[1].accelerator = 'Ctrl+C';
  const before = h.actions.length;
  await assert.rejects(h.action('click', [1], { parent: false }), { code: 'ACTION_UNSUPPORTED' });
  assert.equal(h.actions.length, before);
});
test('WCB1 case 9: coordinate hit and same-depth ambiguity refuse with empty sinks', async () => {
  await refused(fixture({ nodes: menuNodes('Unknown', 'Ctrl+C') }), 'click', [[20, 20]], 'ACTION_UNSUPPORTED', { parent: false });
  await refused(fixture({ nodes: menuNodes('Copy', '') }), 'click', [[20, 20]], 'ACTION_UNSUPPORTED', { parent: false });
  const nodes = menuNodes(); nodes.push({ ...nodes[1] });
  await refused(fixture({ nodes }), 'click', [[20, 20]], 'BACKGROUND_UNAVAILABLE', { parent: false });
});
test('WCB1 case 10: every secondary pattern checks the element name, never the pattern name', async () => {
  for (const name of ['Invoke', 'Toggle', 'Select', 'Expand', 'Collapse', 'ScrollIntoView', 'DoDefaultAction'])
    await refused(fixture({ nodes: menuNodes('Copy', '') }), 'performSecondaryAction', [1, name]);
});
test('WCB1 case 11: Return and Space check focus; Paste activation stays allowed', async () => {
  for (const key of ['return', 'space']) {
    await refused(fixture({ nodes: menuNodes('Copy', '') }), 'pressKey', [key], 'ACTION_UNSUPPORTED', { parent: false });
    await refused(fixture({ nodes: menuNodes('Unknown', 'Ctrl+C') }), 'pressKey', [key], 'ACTION_UNSUPPORTED', { parent: false });
    assert.equal((await fixture({ nodes: menuNodes('Paste', 'Ctrl+V') }).action('pressKey', [key])).clipboardChanged, false);
  }
});
test('WCB1 cases 12 and 20: C0 cannot build WM_CHAR or WM_UNICHAR commands', async () => {
  for (const text of ['\u0003', '\u0018', 'a\u0003b', '\u001b']) await refused(fixture(), 'typeText', [text], 'INVALID_PARAMS');
  await refused(fixture(), 'paste', ['a\tb'], 'BACKGROUND_UNAVAILABLE');
  for (const mode of ['WM_CHAR', 'WM_UNICHAR']) {
    const h = fixture(); await refused(h, 'typeText', ['\u0003'], 'INVALID_PARAMS'); assert.equal(h.posts.includes(mode), false);
  }
});
test('WCB1 case 13: select, drag and double-click writes are detected through settle and read', async () => {
  for (const [method, args] of [['selectText', [1, 'ordinary']], ['drag', [1, 1]], ['doubleClick', [1]]])
    for (const phase of ['during', 'settle', 'afterRead']) {
      const h = fixture(); await changed(h, method, args, { [phase]: () => h.bump() });
      assert.deepEqual(h.order, ['native-admission', 'session', 'baseline', 'input', 'settle', 'read', 'baseline']);
    }
});
test('WCB1 case 14: asynchronous fake writes are caught during settle or before the next action, once', async () => {
  const h = fixture(); await changed(h, 'click', [1], { settle: () => h.bump() });
  await h.action('click', [1]); h.bump();
  const before = h.actions.length;
  await assert.rejects(h.action('click', [1]), { code: 'CLIPBOARD_CHANGED', reason: 'since-last-action', delivery: 'not-sent' });
  assert.equal(h.actions.length, before);
  await h.action('click', [1]); assert.equal(h.actions.length, before + 1);
});
test('WCB1 case 15: a person copy during input is reported without attribution, with no duplicate', async () => {
  const h = fixture();
  await changed(h, 'typeText', ['ordinary'], { during: () => { h.person(); h.bump(); } });
  assert.equal((await h.action('click', [1])).clipboardChanged, false);
  h.bump(); h.person(); assert.equal((await h.action('click', [1])).clipboardChanged, false);
});
for (const [number, cause] of [[16, 'history/cloud'], [17, 'RDP/UTM'], [18, 'clipboard manager']])
  test(`WCB1 case ${number}: synthetic ${cause} writes report any size jump`, async () => {
    const h = fixture(); await changed(h, 'click', [1], { during: () => h.bump(999) });
    await h.action('click', [1]);
  });
test('WCB1 case 19: strict paste with no native edit path refuses without a clipboard fallback', async () => {
  const h = fixture({ nodes: menuNodes('Field', '', { edit: false }) });
  await refused(h, 'paste', ['ordinary'], 'BACKGROUND_UNAVAILABLE');
});
const zeroMethods = [['click', [1]], ['pressKey', ['Home']], ['typeText', ['a']], ['paste', ['a']],
  ['performSecondaryAction', [1, 'Invoke']], ['stuckMenuEscape', ['Escape']]];
async function freshBaseline(rule) {
  for (const [method, args] of zeroMethods) {
    const h = fixture({ rule, count: 0 });
    let result; await assert.doesNotReject(async () => { result = await h.action(method, args); });
    assert.equal(result.clipboardChanged, false);
    assert.equal(h.actions.length, 1); assert.equal(h.samples, 2);
    assert.ok(h.order.indexOf('session') < h.order.indexOf('baseline'));
  }
}
async function deniedBaseline(rule) {
  for (const error of [5, 6, 1300, 0xffffffff]) for (const [method, args] of zeroMethods) {
    const h = fixture({ rule, count: 0, error });
    await refused(h, method, args);
    await assert.rejects(h.action(method, args), { code: 'ACTION_UNSUPPORTED', reason: 'clipboard-count-unavailable',
      delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' });
  }
}
async function zeroJump(rule) {
  for (const value of [1, 12, 999]) for (const phase of ['during', 'settle', 'afterRead']) {
    const h = fixture({ rule, count: 0 });
    await changed(h, 'click', [1], { [phase]: () => h.bump(value) });
  }
}
async function zeroLate(rule) {
  for (const person of [false, true]) {
    const h = fixture({ rule, count: 0 }); await h.action('click', [1]); h.bump(12);
    if (person) h.person();
    else {
      const sent = h.actions.length;
      await assert.rejects(h.action('click', [1]), { code: 'CLIPBOARD_CHANGED', reason: 'since-last-action', delivery: 'not-sent' });
      assert.equal(h.actions.length, sent);
    }
    assert.equal((await h.action('click', [1])).clipboardChanged, false);
  }
}
async function sessionFirst(rule) {
  for (const sessionReason of ['input-desktop-unavailable', 'session-disconnected']) for (const [method, args] of zeroMethods) {
    const h = fixture({ rule, count: 0, sessionReason });
    await refused(h, method, args, 'SCREEN_LOCKED');
    assert.equal(h.samples, 0); assert.ok(h.order.includes('session')); assert.ok(!h.order.includes('baseline'));
  }
}
async function lostAccess(rule) {
  for (const count of [0, 10]) for (const fail of [undefined, 'ACTION_UNCONFIRMED']) {
    const h = fixture({ rule, count }); await h.action('click', [1]);
    await assert.rejects(h.action('click', [1], { during: () => h.deny(), fail }), {
      code: 'ACTION_UNSUPPORTED', reason: 'clipboard-count-unavailable', delivery: 'unknown', retry: 'read-first' });
    assert.equal(h.watch.last, count);
    const sent = h.actions.length;
    await assert.rejects(h.action('click', [1]), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
    assert.equal(h.watch.last, count); assert.equal(h.actions.length, sent);
    h.restore(11);
    await assert.rejects(h.action('click', [1]), { code: 'CLIPBOARD_CHANGED', reason: 'since-last-action' });
    assert.equal((await h.action('click', [1])).clipboardChanged, false);
  }
}
function malformedSample(rule) {
  for (const sample of [0, 12, null, [], {}, { value: 0 }, { value: 0, error: 0, extra: 1 },
    Object.create({ value: 0, error: 0 }), { get value() { throw Error('unavailable'); }, error: 0 },
    { value: 0, error: undefined }, { value: -1, error: 0 },
    { value: 0, error: -1 }, { value: 0, error: 0x100000000 }, { value: 0x100000000, error: 0 },
    { value: 0.5, error: 0 }, { value: 0, error: NaN }]) {
    const watch = new rule.WindowsClipboardWatch(() => sample);
    assert.throws(() => watch.admit(), { code: 'ACTION_UNSUPPORTED', reason: 'clipboard-count-unavailable', delivery: 'not-sent' });
    assert.throws(() => watch.finish(0), { code: 'ACTION_UNSUPPORTED', reason: 'clipboard-count-unavailable', delivery: 'unknown' });
  }
}
test('WCB2 case 21a: all six inputs run from a fresh 0/0 baseline', () => freshBaseline(rule));
test('WCB2 case 21b: every jump from zero during input, settle or read is reported', () => zeroJump(rule));
test('WCB2 case 21c: zero last value compares once, with the person reset preserved', () => zeroLate(rule));
test('WCB2 case 21d: every zero with an error refuses all six inputs', () => deniedBaseline(rule));
test('WCB2 case 21e: session refusal precedes sampling for every input', () => sessionFirst(rule));
test('WCB2 case 21f: failed reads preserve last and report a later change once', () => lostAccess(rule));
test('WCB2 case 21g: zero after nonzero is unavailable, restart has no history', async () => {
  for (const phase of ['admit', 'finish']) {
    let value = 10; const watch = new rule.WindowsClipboardWatch(() => ({ value, error: 0 }));
    const baseline = watch.admit(); value = 0;
    assert.throws(() => phase === 'admit' ? watch.admit() : watch.finish(baseline), {
      code: 'ACTION_UNSUPPORTED', reason: 'clipboard-count-unavailable', delivery: phase === 'admit' ? 'not-sent' : 'unknown' });
    assert.equal(new rule.WindowsClipboardWatch(() => ({ value, error: 0 })).admit(), 0);
  }
});
test('WCB2 case 21h: nonzero values ignore stale errors', async () => {
  for (const error of [6, 5, 0xffffffff]) {
    const h = fixture({ count: 12, error }); assert.equal((await h.action('click', [1])).clipboardChanged, false);
  }
});
test('WCB2 malformed samples and exceptions refuse with the phase disposition', () => {
  malformedSample(rule);
  const watch = new rule.WindowsClipboardWatch(() => { throw Error('unavailable'); });
  assert.throws(() => watch.admit(), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
  assert.throws(() => watch.finish(0), { code: 'ACTION_UNSUPPORTED', delivery: 'unknown', retry: 'read-first' });
});
test('WCB1 case 22: independent sessions stop once on the same unidentified late write', async () => {
  let count = 10;
  const a = new rule.WindowsClipboardWatch(() => ({ value: count, error: 0 })), b = new rule.WindowsClipboardWatch(() => ({ value: count, error: 0 }));
  a.finish(a.admit()); b.finish(b.admit()); count++;
  for (const watch of [a, b]) {
    assert.throws(() => watch.admit(), { code: 'CLIPBOARD_CHANGED', reason: 'since-last-action' });
    assert.equal(watch.admit(), count);
  }
});
test('WCB1 case 23: a restarted driver takes a fresh baseline and claims no old write', () => {
  let count = 10; const old = new rule.WindowsClipboardWatch(() => ({ value: count, error: 0 }));
  old.finish(old.admit()); count = 20;
  assert.equal(new rule.WindowsClipboardWatch(() => ({ value: count, error: 0 })).admit(), 20);
});
test('counter reset uses inequality, and failure after partial input still compares', async () => {
  const h = fixture(); await changed(h, 'click', [1], { during: () => h.bump(2), fail: 'ACTION_UNCONFIRMED' });
  const late = fixture(); await late.action('click', [1]); late.bump(2);
  await assert.rejects(late.action('click', [1]), { code: 'CLIPBOARD_CHANGED', reason: 'since-last-action' });
});
test('a zero counter after input fails closed without claiming the clipboard stayed untouched', async () => {
  const h = fixture();
  await assert.rejects(h.action('click', [1], { during: () => h.bump(0) }), { code: 'ACTION_UNSUPPORTED', delivery: 'unknown', retry: 'read-first' });
});
test('stuck Escape has both during-action and next-action counter checks', async () => {
  const h = fixture(); await changed(h, 'stuckMenuEscape', ['Escape'], { settle: () => h.bump() });
  const late = fixture(); await late.action('click', [1]); late.bump();
  await assert.rejects(late.action('stuckMenuEscape', ['Escape']), { code: 'CLIPBOARD_CHANGED', delivery: 'not-sent' });
  assert.equal(late.actions.length, 1);
});
test('shared tables and normalizer are the same objects; all roles and null labels use them', async () => {
  assert.equal(macLabels.normalizeActionLabel, normalizeActionLabel); assert.equal(macLabels.clipboardWriteLabels, clipboardWriteLabels);
  let words = 0;
  for (const labels of Object.values(clipboardWriteLabels)) for (const label of labels.split('|')) {
    assert.equal(clipboardLabelWrites(label), true, label); words++;
    await refused(fixture({ nodes: menuNodes(label, '') }), 'click', [1]);
  }
  assert.equal(Object.keys(clipboardWriteLabels).length, 9); assert.equal(words, 26);
  for (const role of ['button', 'link', 'list item', 'text', 'row', 'cell', 'checkbox', 'group', 'menu item'])
    await refused(fixture({ nodes: menuNodes('Copy link', '', { role }) }), 'click', [1]);
  for (const label of ['Copyright 2026', 'Copywriter', 'Paste', 'Kopieer']) assert.equal(clipboardLabelWrites(label), false);
  for (const label of [null, '\ud800']) assert.equal(clipboardLabelWrites(label), true);
});
test('all target forms bind label refusals and focus, and a requested Copy remains refused', async () => {
  for (const target of [1, { label: 'Copy' }, { id: 'copy-id' }, { line: 'menu item Copy (focused), ID: copy-id' }])
    await refused(fixture({ nodes: menuNodes('Copy', '', { id: 'copy-id' }) }), 'click', [target]);
  await refused(fixture({ nodes: menuNodes('Copy', '') }), 'click', [1], 'ACTION_UNSUPPORTED', { requestedCopy: true });
  assert.throws(() => rule.guardWindowsClipboard({ method: 'click', args: [1], text: '0 standard window Fixture\n\t1 button \ud800' }), { code: 'ACTION_UNSUPPORTED' });
});
test('menu metadata and private blocked rows never appear in serialized tree lines', () => {
  const { text } = serializeFixtureTree('Fixture', 'Fixture', menuNodes('Ordinary', 'Ctrl+C', { access: 'c', clipboardBlocked: true }));
  assert.doesNotMatch(text, /Ctrl\+C|Accelerator|AccessKey|clipboardBlocked/);
});
test('native integration guards all targets before settle, routing and input, and pins checked codes', () => {
  const actions = native('DriverActions.cs'), input = native('DriverInput.cs'), plan = native('DriverActionPlan.cs');
  const run = actions.slice(actions.indexOf('    object RunAction('));
  for (const check of ['RefuseClipboardTarget(node, plan)', 'RefuseClipboardTarget(destination, plan)',
    'RefuseClipboardTarget(acceleratorTarget, plan)', 'RefuseClipboardTarget(item, plan)', 'DriverClipboardRule.RefuseKey(plan.ResolvedKey)'])
    assert.ok(run.indexOf(check) > 0 && run.indexOf(check) < run.indexOf('settle.Begin()'), check);
  assert.ok(run.indexOf('DriverInput.EnsureBudget()') < run.indexOf('clipboardWatch.Admit()'));
  assert.ok(run.indexOf('clipboardWatch.Admit()') < run.indexOf('settle.Begin()'));
  assert.ok(run.indexOf('clipboardWatch.Finish(') > run.indexOf('Json.Object(Read('));
  assert.match(run, /DriverInput.Keys\(node.Host, FocusHandle\(node\), plan.Chord, plan.StuckEscape, plan.ResolvedKey\)/);
  assert.match(actions, /catch \(Exception error\)[\s\S]*clipboardWatch.Finish/);
  assert.match(actions, /Clean\(currentName\) != Clean\(node.Name\)/);
  const targetCheck = actions.slice(actions.indexOf('    void RefuseClipboardTarget('), actions.indexOf('    object RunAction('));
  const passwordBeforeName = source => {
    const masked = source.indexOf('if (Masked(node))');
    assert.ok(masked >= 0 && masked < source.indexOf('GetCurrentPropertyValueEx(Name'));
  };
  passwordBeforeName(targetCheck);
  assert.throws(() => passwordBeforeName(targetCheck.replace('if (Masked(node))', 'if (false)')), { code: 'ERR_ASSERTION' });
  const masked = run.indexOf('if (Masked(node)');
  assert.ok(masked >= 0 && masked < run.indexOf('RefuseClipboardTarget(node, plan)'));
  assert.match(input, /DriverClipboardRule.RefuseKey\(resolved\)/);
  assert.match(input, /key = mapped & 255/); assert.match(plan, /plan.Text.Any\(c => c < 32/);
  assert.match(plan, /\{ "printscreen", 44 \}/);
  assert.match(native('DriverUia.cs'), /Access = read\(AccessKey, true\)/);
  assert.doesNotMatch(native('DriverUia.cs').slice(native('DriverUia.cs').indexOf('internal static string Serialize(')), /node\.(?:Access|Accelerator)/);
});
function sources() {
  const result = {};
  for (const name of readdirSync(new URL('direct-browser/native/win/', base)).filter(n => /\.(?:cs|c|h|ps1)$/.test(n))) result['native/win/' + name] = native(name);
  function powershell(directory = '') {
    for (const entry of readdirSync(new URL(directory, base), { withFileTypes: true })) {
      const path = directory + entry.name;
      if (entry.isDirectory()) powershell(path + '/');
      else if (entry.isFile() && path.endsWith('.ps1') && !path.startsWith('direct-browser/native/win/')) result[path] = readFileSync(new URL(path, base), 'utf8');
    }
  }
  powershell();
  return result;
}
test('source scan permits only the one reviewed sequence-number boundary', () => {
  assert.doesNotThrow(() => assertWindowsClipboardSources(sources()));
  const powershell = Object.keys(sources()).filter(path => path.endsWith('.ps1'));
  assert.ok(powershell.length > 0);
  assert.ok(powershell.includes('windows-node.ps1'));
  assert.ok(powershell.includes('native/win/cache-access.ps1'));
  assert.ok(powershell.includes('hand/windows-security.ps1'));
  assert.ok(powershell.includes('platform/win32-files.ps1'));
  for (const path of powershell) for (const token of ['Set-Clipboard', 'getClipboardData(1)', 'clip.exe', 'PostMessageW(h, 0x301, 0, 0);']) {
    const source = sources(); source[path] += '\n' + token;
    assert.throws(() => assertWindowsClipboardSources(source), /clipboard/, path + ': ' + token);
  }
  for (const token of ['OpenClipboard', 'CloseClipboard', 'SetClipboardData', 'GetClipboardData', 'EmptyClipboard',
    'OleSetClipboard', 'OleGetClipboard', 'AddClipboardFormatListener', 'GetClipboardOwner', 'CountClipboardFormats', 'EnumClipboardFormats', 'GetClipboardFormatName', 'System.Windows.Forms.Clipboard', '"System.Windows.Forms.Clipboard"', '"Clipboard"', 'Clipboard.GetText']) {
    const source = sources(); source['native/win/DriverActions.cs'] += '\n' + token;
    assert.throws(() => assertWindowsClipboardSources(source), /clipboard/);
  }
  for (const path of ['native/win/DriverActions.cs', 'native/win/DriverClipboard.cs']) {
    const source = sources(); source[path] += '\nGetClipboardSequenceNumber()';
    assert.throws(() => assertWindowsClipboardSources(source), /clipboard/);
  }
});

test('M10 access probes: native and parent scans reject every clipboard-access API', async t => {
  for (const token of ['OpenClipboard', 'CloseClipboard', 'AddClipboardFormatListener', 'GetClipboardOwner', 'CountClipboardFormats']) {
    for (const path of Object.keys(sources()).filter(path => path.startsWith('native/win/'))) {
      const source = sources(); source[path] += '\n' + token + '();';
      const witness = scan => assert.throws(() => scan(source), /clipboard/);
      witness(assertWindowsClipboardSources);
      const broken = await mutate('windows-driver/clipboard-source.mjs', s => s.replace('export function assertWindowsClipboardSources(sources) {', `export function assertWindowsClipboardSources(sources) { sources = Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, s.replaceAll('${token}', 'erased')]));`));
      assert.throws(() => witness(broken.assertWindowsClipboardSources), { code: 'ERR_ASSERTION' });
    }
    const source = { 'windows-driver/probe.mjs': token + '();' };
    const witness = scan => assert.throws(() => scan(source), /clipboard/);
    witness(assertWindowsClipboardParentSources);
    const broken = await mutate('windows-driver/clipboard-source.mjs', s => s.replace('export function assertWindowsClipboardParentSources(sources) {',
      `export function assertWindowsClipboardParentSources(sources) { sources = Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, s.replaceAll('${token}', 'erased')]));`));
    assert.throws(() => witness(broken.assertWindowsClipboardParentSources), { code: 'ERR_ASSERTION' });
  }
  t.diagnostic('Every access-probe mutation loses its refusal witness in both scans');
});

test('native zero baseline pins the error read and session-before-counter dispatch', () => {
  const source = native('DriverClipboard.cs');
  assert.match(source, /SetLastError\(0\); uint v = Sequence\(\);\s*return new CounterSample \{ Value = v, Error = \(uint\)Marshal.GetLastWin32Error\(\) \}/);
  assert.match(source, /current.Value == 0 && \(current.Error != 0 \|\| seenNonzero\)/);
  assert.match(source, /if \(current.Value != 0\) seenNonzero = true;/);
  const sessionBeforeAction = dispatch => {
    const require = dispatch.indexOf('DriverSession.Require();', dispatch.indexOf('static object DispatchCore('));
    assert.ok(require >= 0 && require < dispatch.indexOf('return reader.Action(plan, request.Deadline);'));
  };
  const dispatch = native('Driver.cs'); sessionBeforeAction(dispatch);
  assert.throws(() => sessionBeforeAction(dispatch.replace('        DriverSession.Require();\n        DriverIdentity.BeginRequest();', '        DriverIdentity.BeginRequest();')), { code: 'ERR_ASSERTION' });
});

// Load a real mutated module. Each witness is its ordinary assertion, first
// green on production, then caught red on the named broken implementation.
async function mutate(relative, change) {
  const url = new URL(relative, base), original = readFileSync(url, 'utf8');
  let changed = change(original); assert.notEqual(changed, original, 'mutation must change source');
  changed = changed.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
const mirror = 'windows-driver/clipboard.mjs';
const witnesses = [
  ['M1 Russian', s => s.replace('key = mapped & 255;', 'key = parsed.key.charCodeAt(0) & 255;'),
    rule => refused(fixture({ rule, map: () => 0x43 }), 'pressKey', ['Control+с'])],
  ['M1 synthetic physical key', s => s.replace('key = mapped & 255;', 'key = parsed.key.charCodeAt(0) & 255;'),
    rule => refused(fixture({ rule, map: () => 0x43 }), 'pressKey', ['Control+j'])],
  ['M2', s => s.replace('if (resolved) refuseWindowsKey(resolved);', 'if (resolved && nodes.some(n => n.accelerator)) return { node: nodes[1], accelerator: nodes[1], resolved }; if (resolved) refuseWindowsKey(resolved);'),
    rule => refused(fixture({ rule, nodes: menuNodes() }), 'pressKey', ['Ctrl+c'], 'ACTION_UNSUPPORTED', { parent: false })],
  ['M3', s => s.replace('check(node);', 'if (!Array.isArray(args[0])) check(node);'),
    rule => refused(fixture({ rule, nodes: menuNodes('Unknown') }), 'click', [[20, 20]], 'ACTION_UNSUPPORTED', { parent: false })],
  ['M4', s => s.replace('[13, 32].includes(resolved?.key)', 'false'),
    rule => refused(fixture({ rule, nodes: menuNodes() }), 'pressKey', ['return'], 'ACTION_UNSUPPORTED', { parent: false })],
  ['M5', s => s.replace('const baseline = watch.admit();\n  let value;\n  try {\n    value = send();', 'let value = send();\n  const baseline = watch.admit();\n  try {'),
    async rule => { const h = fixture({ rule }); await changed(h, 'doubleClick', [1], { during: () => h.bump() }); }],
  ['M6', s => s.replace('this.last !== undefined && current !== this.last', 'false && current !== this.last'),
    async rule => { const h = fixture({ rule }); await h.action('click', [1]); h.bump(); await assert.rejects(h.action('click', [1]), { code: 'CLIPBOARD_CHANGED' }); }],
  ['M7', s => s.replace('return current !== baseline;', 'return current > baseline;'),
    async rule => { const h = fixture({ rule }); await changed(h, 'click', [1], { during: () => h.bump(2) }); }],
  ['M8a', s => s.replace('REFUSE_INACCESSIBLE_SEQUENCE = true', 'REFUSE_INACCESSIBLE_SEQUENCE = false'), deniedBaseline],
  ['M8b', s => s.replace('sample = this.sample();', 'sample = { ...this.sample(), error: 0 };'), deniedBaseline],
  ['M8c', s => s.replace('(sample.error !== 0 || this.seenNonzero)', 'true'), freshBaseline],
  ['M8d', s => s.replace('return current !== baseline;', 'return baseline !== 0 && current !== baseline;'), zeroJump],
  ['M8e zero last', s => s.replace('this.last !== undefined', 'this.last'), zeroLate],
  ['M8e reset last', s => s.replace('sample = this.sample();', 'sample = this.sample(); if (sample.value === 0 && sample.error !== 0) this.last = undefined;'), lostAccess],
  ['M8f', s => s.replace('  requireSession();\n  const baseline = watch.admit();', '  const baseline = watch.admit();\n  requireSession();'), sessionFirst],
  ['M8g', s => s.replace('sample = this.sample();', 'sample = this.sample(); if (typeof sample === \'number\') sample = { value: sample, error: 0 };'), malformedSample],
  ['M9', s => s.replace('refuseClipboardLabel(windowsActionLabel(line));', 'refuseClipboardLabel(args[1] ?? windowsActionLabel(line));'),
    async rule => assert.throws(() => rule.guardWindowsClipboard({ method: 'performSecondaryAction', args: [1, 'Invoke'], text: '0 standard window Fixture\n\t1 button Copy' }), { code: 'ACTION_UNSUPPORTED' })],
];
for (const [id, mutation, witness] of witnesses) test(`${id}: the witness fails against the actual broken JS mirror`, async t => {
  await witness(rule);
  const broken = await mutate(mirror, mutation);
  await assert.rejects(Promise.resolve().then(() => witness(broken)), { code: 'ERR_ASSERTION' });
  t.diagnostic(id + ': 1 broken-variant witness failed as required; 1 production witness passed');
});
for (const kind of ['API', 'second-site']) test(`M10 ${kind}: the source-scan witness fails when its rule is removed`, async t => {
  const source = sources();
  const boundary = '    [DllImport("user32.dll", EntryPoint = "GetClipboardSequenceNumber", SetLastError = true)] static extern uint Sequence();';
  source['native/win/DriverClipboard.cs'] += kind === 'API' ? '\nGetClipboardData(1);' : '\n' + boundary;
  const witness = scan => assert.throws(() => scan(source), /clipboard/);
  witness(assertWindowsClipboardSources);
  const broken = await mutate('windows-driver/clipboard-source.mjs', kind === 'API'
    ? s => s.replace("checked = source.replace(sequenceBoundary, '');", "checked = source.replace(sequenceBoundary, '').replaceAll('GetClipboardData', '');")
    : s => s.replace('source.replace(sequenceBoundary,', 'source.replaceAll(sequenceBoundary,').replace('sequenceReferences !== 2', 'false'));
  assert.throws(() => witness(broken.assertWindowsClipboardSources), { code: 'ERR_ASSERTION' });
  t.diagnostic('M10 ' + kind + ': 1 broken-variant witness failed as required; 1 production witness passed');
});
test('M11: the C0 witness fails when parser validation is removed', async t => {
  const witness = validate => assert.throws(() => validate('typeText', params(['\u0003'])), { code: 'INVALID_PARAMS' });
  witness(validateActionParams);
  const broken = await mutate('windows-driver/actions.mjs', s => s.replace("if (method === 'typeText' && /[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]/.test(a[0])) invalid();", ''));
  assert.throws(() => witness(broken.validateActionParams), { code: 'ERR_ASSERTION' });
  t.diagnostic('M11: 1 broken-variant witness failed as required; 1 production witness passed');
});

test('Windows parent sources name no clipboard API or managed Clipboard class', () => {
  const parents = {};
  for (const directory of ['windows-driver/', 'windows-repl/'])
    for (const name of readdirSync(new URL(directory, base)).filter(name => name.endsWith('.mjs') && name !== 'clipboard-source.mjs'))
      parents[directory + name] = readFileSync(new URL(directory + name, base), 'utf8');
  for (const name of readdirSync(base).filter(name => /^windows-.*\.mjs$/.test(name)))
    parents[name] = readFileSync(new URL(name, base), 'utf8');
  parents['driver-safety.mjs'] = readFileSync(new URL('driver-safety.mjs', base), 'utf8');
  const relay = readFileSync(new URL('relay.mjs', base), 'utf8');
  parents['relay Windows beforeAction'] = relay.slice(relay.lastIndexOf('      const target = windowFromText(action.text);'));
  assert.doesNotThrow(() => assertWindowsClipboardParentSources(parents));
  for (const name of Object.keys(parents)) {
    assert.throws(() => assertWindowsClipboardParentSources({ ...parents, [name]: parents[name] + '\nGetClipboardData(1)' }), /clipboard/);
  }
});

test('Win+V history and Windows number chords are not misclassified as clipboard writes', () => {
  assert.equal(rule.clipboardKeyRefused(rule.resolveWindowsKey('Win+v', usKey)), false);
  assert.equal(rule.clipboardKeyRefused({ key: 0x33, modifiers: [17, 16] }), false);
  assert.equal(rule.windowsActionLabel('button, ID: Copy'), '');
  assert.equal(rule.windowsActionLabel('text field Field, Value: Copy'), 'Field');
});
test('all seven owner defaults are named and pinned against their native counterparts', () => {
  const source = native('DriverClipboard.cs');
  for (const [name, nativeName, value] of [
    ['REFUSE_CONTROL_COPY', 'RefuseControlCopy', true],
    ['REFUSE_ALTERNATE_CLIPBOARD_KEYS', 'RefuseAlternateClipboardKeys', true],
    ['REFUSE_INACCESSIBLE_SEQUENCE', 'RefuseInaccessibleSequence', true],
    ['REFUSE_REQUESTED_COPY', 'RefuseRequestedCopy', true],
    ['ALLOW_MENU_MNEMONICS', 'AllowMenuMnemonics', true],
    ['USE_SHARED_LABEL_POLICY', 'UseSharedLabelPolicy', true],
    ['EXPOSE_MENU_KEYS_IN_TREE', 'ExposeMenuKeysInTree', false],
  ]) {
    assert.equal(rule[name], value);
    assert.ok(source.includes('const bool ' + nativeName + ' = ' + value + ';'));
  }
});

function wireFixture(t, reply) {
  const calls = [];
  const window = fakeWindows[0], text = 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 button Copy';
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const request = JSON.parse(bytes); calls.push(request); done();
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: DRIVER_PROTOCOL, nonce, id: request.id, ok: true,
        result: ['turn-start', 'turn-end'].includes(request.method)
          ? { turn: request.params.turn, active: request.method === 'turn-start' }
          : request.method === 'getApp' ? { window, text, readId: 1 } : reply }) + '\n'));
    } });
    return child;
  } }) });
  t.after(() => client.close());
  return { client, calls, window };
}
for (const delivery of ['not-sent', 'sent-unverified', 'sent-verified', 'unknown'])
  test(`Windows client maps a typed ${delivery} change to the Mac sentence and stop disposition`, async t => {
    const h = wireFixture(t, { clipboardChanged: true, delivery, retry: delivery === 'not-sent' ? 'safe' : 'read-first',
      reason: 'since-last-action' });
    await assert.rejects(h.client.request('pressKey', { ...params(['Home']), processStart: h.window.processStart }), {
      code: 'CLIPBOARD_CHANGED', message: MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED, delivery, retry: 'read-first', next: 'stop-tell-user',
    });
  });
test('the client binds its shared-label verdict to an acknowledged read, never a stale identity', async t => {
  const h = wireFixture(t, {}), read = await h.client.getApp('Fixture');
  await h.client.request('click', { windowId: read.window.windowId, processStart: read.window.processStart, readId: 1, args: [[10, 10]] });
  assert.deepEqual(h.calls.at(-1).params.clipboardBlocked, [1]);
  await h.client.request('click', { windowId: read.window.windowId, processStart: read.window.processStart, readId: 1, args: [1], clipboardBlocked: [] });
  assert.deepEqual(h.calls.at(-1).params.clipboardBlocked, [1], 'a caller cannot replace the bound verdict');
  await h.client.request('click', { windowId: read.window.windowId, processStart: read.window.processStart, readId: 2, args: [1], clipboardBlocked: [] });
  assert.equal(Object.hasOwn(h.calls.at(-1).params, 'clipboardBlocked'), false);
});
test('the client projects zero-counter and structural refusal fields without exposing wire markers', async t => {
  const h = wireFixture(t, { clipboardRefused: true, delivery: 'not-sent', retry: 'safe', reason: 'clipboard-count-unavailable' });
  await assert.rejects(h.client.request('pressKey', params(['Home'])), {
    code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe', clipboard: 'untouched', reason: 'clipboard-count-unavailable',
  });
});
for (const result of [
  { clipboardChanged: 'yes' }, { clipboardRefused: 'yes' }, { clipboardChanged: true, delivery: 'sent-unverified', retry: 'safe' },
  { clipboardRefused: true, delivery: 'sent-verified', retry: 'safe' },
]) test('malformed clipboard result cannot produce safe retry permission: ' + JSON.stringify(result), async t => {
  const h = wireFixture(t, result);
  await assert.rejects(h.client.request('pressKey', params(['Home'])), { code: 'DRIVER_PROTOCOL', unhealthy: true });
  await assert.rejects(h.client.ping(), { code: 'DRIVER_CLOSED' });
});
test('Windows error projection reuses the exact Mac recovery line', () => {
  const original = Object.assign(Error('provider-authored text'), { code: 'CLIPBOARD_CHANGED', delivery: 'sent-unverified', retry: 'read-first' });
  const expected = formatMacDriverError(original, { action: true });
  assert.equal(rule.windowsClipboardError(original).message, expected);
  assert.match(expected, /next=stop-tell-user/); assert.doesNotMatch(expected, /provider-authored/);
});

test('counter boundaries read twice even on a post-input unavailable sample', async () => {
  let count = 10, samples = 0;
  const watch = new rule.WindowsClipboardWatch(() => { samples++; return { value: count, error: 0 }; });
  assert.throws(() => rule.runWindowsClipboardTransaction(watch, () => { count = 0; }, () => {}, () => {}),
    { code: 'ACTION_UNSUPPORTED', delivery: 'unknown', retry: 'read-first' });
  assert.equal(samples, 2);
});
test('unavailable person-input metadata also refuses closed', () => {
  let count = 10, personFails = false;
  const watch = new rule.WindowsClipboardWatch(() => ({ value: count, error: 0 }), () => { if (personFails) throw Error('unavailable'); return 0; });
  watch.finish(watch.admit()); count++; personFails = true;
  assert.throws(() => watch.admit(), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
});

test('source scan pins the sequence delegate use as well as its declaration', () => {
  for (const path of ['native/win/DriverClipboard.cs', 'native/win/DriverActions.cs']) {
    const source = sources(); source[path] += '\nSequence();';
    assert.throws(() => assertWindowsClipboardSources(source), /clipboard/);
  }
});
