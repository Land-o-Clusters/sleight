import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as rule from '../plugins/sleight/lib/windows-driver/clipboard.mjs';
import { windowsClipboardFixture as fixture } from './fixtures/windows-driver-fake.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { driverFixture } from './fixtures/driver-fake.mjs';
import { assertWindowsClipboardSources, assertWindowsClipboardParentSources } from '../plugins/sleight/lib/windows-driver/clipboard-source.mjs';
import { parseAccelerator } from '../plugins/sleight/lib/windows-driver/actions.mjs';
import { inspectDriverSource } from './fixtures/windows-source-policy.mjs';

const base = new URL('../plugins/sleight/lib/', import.meta.url);
const nodes = (name, accelerator = '', access = '') => [
  { depth: 0, role: 'dialog', name: 'Fixture' },
  { depth: 1, role: 'button', name, accelerator, access, focused: true },
];
async function refused(h, method, args, options = { parent: false }) {
  await assert.rejects(h.action(method, args, options), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
  assert.deepEqual(h.actions, []); assert.deepEqual(h.posts, []); assert.deepEqual(h.patterns, []);
}

test('WCB1B newline text checks the one focused target before any character', async () => {
  for (const text of ['\n', '\r', 'prefix\ntrailer', 'prefix\r\ntrailer']) {
    for (const [name, accelerator] of [['Copy', ''], ['Ordinary', 'Ctrl+C']])
      await refused(fixture({ nodes: nodes(name, accelerator) }), 'typeText', [text]);
    assert.equal((await fixture({ nodes: nodes('Field') }).action('typeText', [text])).clipboardChanged, false);
  }
  for (const focused of [0, 2]) {
    const items = nodes('Copy'); items[0].focused = focused === 2; items[1].focused = focused === 2;
    const h = fixture({ nodes: items });
    await assert.rejects(h.action('typeText', ['\n'], { parent: false }), { code: 'NO_BACKGROUND_FOCUS' });
    assert.deepEqual(h.actions, []);
  }
});

test('WCB1B Latin accelerator keys bypass the Russian typed-character layout', async () => {
  const map = c => c === 'с' ? 0x43 : -1;
  const h = fixture({ map, nodes: nodes('Save', 'Ctrl+S') });
  await h.action('click', [1]); assert.equal(h.actions.length, 1);
  await refused(fixture({ map, nodes: nodes('Ordinary', 'Ctrl+C') }), 'click', [1]);
  await refused(fixture({ map }), 'pressKey', ['Control+с']);
  await assert.rejects(fixture({ map }).action('pressKey', ['Control+s'], { parent: false }), { code: 'KEY_LAYOUT_UNAVAILABLE' });
});

test('WCB1B dialog Alt mnemonics check labels without an open menu', async () => {
  for (const access of ['Alt+C', '&c', 'c', 'Alt, H, C'])
    await refused(fixture({ nodes: nodes('Copy', '', access) }), 'pressKey', ['Alt+c']);
  await refused(fixture({ nodes: nodes('Ordinary', 'Ctrl+C', 'Alt+C') }), 'pressKey', ['Alt+c']);
  const h = fixture({ nodes: nodes('Copy', '', 'Alt+C') });
  await h.action('pressKey', ['c'], { parent: false }); assert.equal(h.posts.length, 1, 'bare text outside a menu remains text');
  const allowed = fixture({ nodes: nodes('Cancel', '', 'Alt+C') });
  await allowed.action('pressKey', ['Alt+c']); assert.equal(allowed.posts.length, 1);
  await refused(fixture({ nodes: nodes('Copy', '', 'Alt, H, C') }), 'pressKey', ['Alt+h']);
});

test('WCB1B accelerator aliases refuse independently of the label', async () => {
  for (const accelerator of ['Ctrl+Ins', 'Ctrl+Insert', 'Ctrl + Insert', 'Shift+Del', 'Shift+Delete', 'PrtSc', 'Prt Scr'])
    await refused(fixture({ nodes: nodes('Ordinary', accelerator) }), 'click', [1]);
});

test('WCB1B parent text rule refuses Windows clipboard keys before native resolution', () => {
  for (const chord of ['Ctrl+c', 'Control+x', 'Win+c', 'Win+x', 'Ctrl+Insert', 'Ctrl+Ins', 'Shift+Delete',
    'Shift+Del', 'Ctrl+v', 'Shift+Insert', 'PrintScreen', 'Alt+PrintScreen', 'Win+Shift+s'])
    assert.throws(() => rule.guardWindowsClipboard({ method: 'pressKey', args: [chord], text: '1 button Done' }),
      { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' }, chord);
  for (const chord of ['Ctrl+s', 'Win+v', 'c'])
    assert.doesNotThrow(() => rule.guardWindowsClipboard({ method: 'pressKey', args: [chord], text: '1 button Done' }));
});

test('WCB1B clipboard messages and command/API spellings fail native and parent scans', () => {
  const boundary = readFileSync(new URL('direct-browser/native/win/DriverClipboard.cs', base), 'utf8');
  for (const token of ['WM_COPY', 'WM_CUT', 'WM_PASTE', 'WM_CLEAR', '0x300', '0x301', '0x302', '0x303',
    '768', '769', '770', '771', '770u', 'message: 771', '(uint)770', '0x0301UL']) for (const api of ['SendMessage', 'SendMessageW', 'SendMessageTimeoutW', 'PostMessage', 'PostMessageW']) {
    const planted = `${api}(h, ${token}, 0, 0);`;
    assert.throws(() => assertWindowsClipboardSources({ 'native/win/DriverClipboard.cs': boundary, 'native/win/probe.ps1': planted }), /clipboard/, planted);
    assert.throws(() => assertWindowsClipboardParentSources({ 'windows-repl/probe.mjs': planted }), /clipboard/, planted);
  }
  for (const planted of ['clip.exe', 'getClipboardData(1)', 'Get-Clipboard', 'Set-Clipboard']) {
    assert.throws(() => assertWindowsClipboardSources({ 'native/win/DriverClipboard.cs': boundary, 'probe.ps1': planted }), /clipboard/, planted);
    assert.throws(() => assertWindowsClipboardParentSources({ 'windows-repl/probe.mjs': planted }), /clipboard/, planted);
  }
});

test('WCB1B Windows turn latch blocks all input after a real count change and shares turn-end rules', async t => {
  let changed = false;
  const h = await driverFixture('win32', createDriverSafety, { afterInput() {
    if (changed) return; changed = true;
    throw Object.assign(Error('CLIPBOARD_CHANGED'), { code: 'CLIPBOARD_CHANGED', clipboardChanged: true, delivery: 'sent-unverified' });
  } });
  t.after(() => h.safety.close());
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  const input = (method = 'click') => h.safety.request(method, { ...h.binding(), readId: first.readId, args: [1] });
  await assert.rejects(input(), { code: 'CLIPBOARD_CHANGED' });
  for (const method of DRIVER_ACTION_METHODS) await assert.rejects(input(method), { code: 'CLIPBOARD_CHANGED', delivery: 'not-sent' });
  assert.equal(h.actions.length, 1);
  await h.safety.finishCell(1); await h.safety.reset();
  await h.safety.endTurn({ clipboardTurnEnded: false });
  await h.safety.request('getApp', { selector: 'Fixture' });
  await assert.rejects(input(), { code: 'CLIPBOARD_CHANGED' });
  await h.safety.endTurn({ clipboardTurnEnded: true });
  const next = await h.safety.request('getApp', { selector: 'Fixture' });
  await h.safety.request('click', { ...h.binding(), readId: next.readId, args: [1] });
  assert.equal(h.actions.length, 2);
});

test('WCB1B all Latin letter and digit accelerators resolve without a layout query', () => {
  for (const key of 'abcdefghijklmnopqrstuvwxyz0123456789') {
    const resolved = rule.resolveWindowsAccelerator('Ctrl+' + key, () => assert.fail('accelerators do not query the layout'));
    assert.equal(resolved.key, key.toUpperCase().charCodeAt(0)); assert.deepEqual(resolved.modifiers, [17]);
  }
  assert.equal(rule.resolveWindowsAccelerator('Ctrl+с', () => 0x43).key, 0x43);
});

test('WCB1B parent rejects worker-supplied private label verdicts', async t => {
  const h = await driverFixture('win32', createDriverSafety);
  t.after(() => h.safety.close());
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  await assert.rejects(h.safety.request('click', { ...h.binding(), readId: first.readId, args: [1], clipboardBlocked: [] }),
    { code: 'INVALID_PARAMS' });
  assert.deepEqual(h.actions, []);
  assert.equal(rule.windowsActionLabel('dialog Fixture'), 'Fixture');
  assert.deepEqual(rule.windowsClipboardBlockedRows('0 dialog Fixture'), []);
});

test('WCB1B old Windows turn failures cannot latch a newer turn', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const h = await driverFixture('win32', createDriverSafety, { async afterInput() {
    if (h.actions.length !== 1) return;
    enter(); await held;
    throw Object.assign(Error('CLIPBOARD_CHANGED'), { code: 'CLIPBOARD_CHANGED', clipboardChanged: true });
  } });
  t.after(() => h.safety.close());
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  const failed = assert.rejects(h.safety.request('click', { ...h.binding(), readId: first.readId, args: [1] }), { code: 'CLIPBOARD_CHANGED' });
  await entered; await h.safety.endTurn({ clipboardTurnEnded: true }); release(); await failed;
  const next = await h.safety.request('getApp', { selector: 'Fixture' });
  await h.safety.request('click', { ...h.binding(), readId: next.readId, args: [1] });
  assert.equal(h.actions.length, 2);
});

const native = name => readFileSync(new URL('direct-browser/native/win/' + name, base), 'utf8');
function nativeBoundary(source) {
  const run = source.slice(source.indexOf('    object RunAction('));
  assert.match(run, /if \(DriverClipboardRule.TextActivates\(plan\) \|\|/);
  assert.ok(run.indexOf('DriverClipboardRule.TextActivates(plan)') < run.indexOf('settle.Begin()'));
  assert.match(run, /node = FocusedTarget\(latest.Values, candidate =>/);
  assert.ok(run.indexOf('node = FocusedTarget(') < run.indexOf('DriverClipboardRule.TextActivates(plan)'));
  const focus = source.slice(source.indexOf('    internal static DriverNode FocusedTarget('), source.indexOf('    internal static bool NativeFocusMatches('));
  assert.match(focus, /if \(!candidate.Focused \|\| !accepts\(candidate\)\) continue;/);
  assert.match(focus, /if \(selected != null\) throw new DriverFault\("NO_BACKGROUND_FOCUS"\);/);
  assert.match(focus, /if \(selected == null\) throw new DriverFault\("NO_BACKGROUND_FOCUS"\);/);
  assert.match(run, /\(menuOpen \|\| plan.Chord.Modifiers.Contains\(18\)\)/);
}
test('WCB1B C# admission placement has broken-source witnesses', () => {
  const source = native('DriverActions.cs'); nativeBoundary(source);
  for (const mutation of [s => s.replace('DriverClipboardRule.TextActivates(plan) || ', ''),
    s => s.replace('(menuOpen || plan.Chord.Modifiers.Contains(18))', 'menuOpen'),
    s => s.replace('if (selected != null) throw new DriverFault("NO_BACKGROUND_FOCUS");', ''),
    s => s.replace('if (selected == null) throw new DriverFault("NO_BACKGROUND_FOCUS");', ''),
    s => s.replace('node = FocusedTarget(latest.Values, candidate =>', 'node = UncheckedFocus(latest.Values, candidate =>')])
    assert.throws(() => nativeBoundary(mutation(source)), { code: 'ERR_ASSERTION' });
  assert.match(native('DriverClipboard.cs'), /plan.Text.Any\(c => c == '\\r' \|\| c == '\\n'\)/);
  assert.match(native('DriverClipboard.cs'), /ResolveAccelerator\(chord, resolve\)/);
  assert.match(native('DriverClipboard.cs'), /Key = Char.ToUpperInvariant\(chord.Key\[0\]\)/);
});

test('WCB1B source-derived fake UIA schedule counts two added reads per target check', t => {
  const source = native('DriverActions.cs');
  const guard = source.slice(source.indexOf('    void RefuseClipboardTarget('), source.indexOf('    object RunAction('));
  const expressions = [...guard.matchAll(/node\.Element\.GetCurrentPropertyValueEx\((Name|AcceleratorKey), true\)/g)];
  assert.deepEqual(expressions.map(match => match[1]), ['Name', 'AcceleratorKey']);
  const calls = [];
  const fake = { Name: 'Name', AcceleratorKey: 'AcceleratorKey', node: { Element: {
    GetCurrentPropertyValueEx(property, uncached) { assert.equal(uncached, true); calls.push(property); return 'Ordinary'; },
  } } };
  const check = () => { for (const [expression] of expressions) runInNewContext(expression, fake); };
  check(); assert.equal(calls.length, 2, 'admission check');
  const pattern = source.slice(source.indexOf('    string ActionPattern('), source.indexOf('    internal static DriverFault ActionFailure('));
  assert.match(pattern, /RefuseClipboardTarget\(node, plan\)/);
  check(); assert.equal(calls.length, 4, 'admission plus pattern retry check');
  t.diagnostic('source-derived fake schedule: 2 metadata reads/check; 4 for the same target checked at admission and ActionPattern; 0 native timing measurements');
});

async function mutate(relative, change) {
  const url = new URL(relative, base), original = readFileSync(url, 'utf8');
  let changed = change(original); assert.notEqual(changed, original, 'mutation must change source');
  changed = changed.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
const mirror = 'windows-driver/clipboard.mjs';
const mutations = [
  ['B1 newline', mirror, s => s.replace(' || textActivates) check(node)', ') check(node)'),
    module => refused(fixture({ rule: module, nodes: nodes('Ordinary', 'Ctrl+C') }), 'typeText', ['prefix\n'])],
  ['B2 Latin accelerator', mirror, s => s.replace('resolveWindowsAccelerator(node.accelerator, map)', 'resolveWindowsKey(node.accelerator, map)'),
    async module => { const h = fixture({ rule: module, nodes: nodes('Save', 'Ctrl+S'), map: () => -1 }); await assert.doesNotReject(h.action('click', [1])); assert.equal(h.actions.length, 1); }],
  ['B3 Alt outside menu', mirror, s => s.replace('chord.modifiers.includes(18) || ', ''),
    module => refused(fixture({ rule: module, nodes: nodes('Copy', '', 'Alt+C') }), 'pressKey', ['Alt+c'])],
  ['B4 accelerator aliases', 'windows-driver/actions.mjs', s => s.replace("ins: 'insert'", "unused: 'insert'"),
    module => assert.doesNotThrow(() => assert.equal(module.parseAccelerator('Ctrl+Ins').virtualKey, 45))],
  ['B5 parent key rule', mirror, s => s.replace('refuseWindowsKey({ key, modifiers: chord.modifiers });', ''),
    module => assert.throws(() => module.guardWindowsClipboard({ method: 'pressKey', args: ['Ctrl+c'], text: '1 button Done' }), { code: 'ACTION_UNSUPPORTED' })],
  ['B6 multi-step access', mirror, s => s.replace("if (tips.length > 1", "if (false && tips.length > 1"),
    async module => { assert.equal(module.menuAccessMatches('Alt, H, C', 'Alt+h'), true);
      await refused(fixture({ rule: module, nodes: nodes('Copy', '', 'Alt, H, C') }), 'pressKey', ['Alt+h']); }],
];
for (const [id, path, change, witness] of mutations) test(`${id}: production passes and the broken variant fails`, async t => {
  const production = path === mirror ? rule : { parseAccelerator };
  await witness(production);
  const broken = await mutate(path, change);
  await assert.rejects(Promise.resolve().then(() => witness(broken)), { code: 'ERR_ASSERTION' });
  t.diagnostic('1 production witness passed; 1 broken-variant witness failed');
});

for (const scope of ['native', 'parent']) test(`B7 ${scope}: every planted message fails with the rule and passes without it`, async t => {
  const name = scope === 'native' ? 'assertWindowsClipboardSources' : 'assertWindowsClipboardParentSources';
  const original = { assertWindowsClipboardSources, assertWindowsClipboardParentSources };
  const broken = await mutate('windows-driver/clipboard-source.mjs', s => s.replaceAll('assertNoClipboardMessages(checked, path);', '').replaceAll('assertNoClipboardMessages(source, path);', ''));
  let count = 0;
  for (const message of ['WM_COPY', 'WM_CUT', 'WM_PASTE', 'WM_CLEAR', '0x300', '0x301', '0x302', '0x303', '768', '769', '770', '771',
    '770u', 'message: 771', '(uint)770', '0x0301UL']) {
    const sources = { ...scope === 'native' ? { 'native/win/DriverClipboard.cs': native('DriverClipboard.cs') } : {},
      [scope === 'native' ? 'native/win/planted.ps1' : 'windows-repl/planted.mjs']: `SendMessageTimeoutW(h, ${message}, 0, 0);` };
    const witness = module => assert.throws(() => module[name](sources), /clipboard/);
    witness(original); assert.throws(() => witness(broken), { code: 'ERR_ASSERTION' }); count++;
  }
  t.diagnostic(`${count} production witnesses passed; ${count} broken-variant witnesses failed`);
});

test('B8 Windows latch depends on both platform checks and shared turn clearing', async t => {
  const witness = async factory => {
    let changed = false;
    const h = await driverFixture('win32', factory, { afterInput() {
      if (changed) return; changed = true;
      throw Object.assign(Error('CLIPBOARD_CHANGED'), { code: 'CLIPBOARD_CHANGED', clipboardChanged: true });
    } });
    try {
      const first = await h.safety.request('getApp', { selector: 'Fixture' });
      const input = () => h.safety.request('click', { ...h.binding(), readId: first.readId, args: [1] });
      await assert.rejects(input(), { code: 'CLIPBOARD_CHANGED' });
      await assert.rejects(input(), { code: 'CLIPBOARD_CHANGED', delivery: 'not-sent' });
      await h.safety.endTurn({ clipboardTurnEnded: true });
      const next = await h.safety.request('getApp', { selector: 'Fixture' });
      await assert.doesNotReject(h.safety.request('click', { ...h.binding(), readId: next.readId, args: [1] }));
      assert.equal(h.actions.length, 2);
    } finally { await h.safety.close(); }
  };
  await witness(createDriverSafety);
  for (const change of [s => s.replace("['darwin', 'win32'].includes(platform) && clipboardStopped", "platform === 'darwin' && clipboardStopped"),
    s => s.replace("['darwin', 'win32'].includes(platform) && turn", "platform === 'darwin' && turn"),
    s => s.replace('if (clipboardTurnEnded) requests.endClipboardTurn();', '')]) {
    const broken = await mutate('driver-safety.mjs', change);
    await assert.rejects(witness(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
  }
  t.diagnostic('1 production witness passed; 3 broken-variant witnesses failed');
});

test('B9 the send-message allowlist rejects planted WM_PASTE even without the clipboard scanner', async () => {
  const planted = 'SendMessageTimeoutW(h, 0x302, 0, 0);';
  const witness = inspect => assert.throws(() => inspect('Program.cs', planted, []), /unreviewed send/);
  witness(inspectDriverSource);
  const original = readFileSync(new URL('./fixtures/windows-source-policy.mjs', import.meta.url), 'utf8');
  const changed = original.replace("['0', '0x000c', '0x109']", "['0', '0x000c', '0x109', '0x302']");
  assert.notEqual(changed, original);
  const broken = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
  assert.throws(() => witness(broken.inspectDriverSource), { code: 'ERR_ASSERTION' });
});
