import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { recordedFixture } from './fixtures/mac-driver-recorded-tree.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const frame = { x: 0, y: 0, width: 100, height: 100 };
const item = (AXTitle, extra = {}) => ({ AXRole: 'AXMenuItem', AXTitle, AXEnabled: true, actions: ['AXPress'], children: [], ...extra });
const menu = (children, expanded = false) => ({ AXRole: 'AXMenu', AXExpanded: expanded, children });
const barItem = (AXTitle, children) => ({ AXRole: 'AXMenuBarItem', AXTitle, AXEnabled: true, children: [menu(children)] });
const binding = { windowId: '7', processStart: '1.2' };
const base = () => ({
  apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
  windows: [{ ...binding, pid: 42, bundleId: 'test.fixture', app: 'Fixture', title: 'Untitled', bounds: frame, onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Untitled', AXMinimized: false, AXFullScreen: false, frame,
    children: [{ AXRole: 'AXButton', AXTitle: 'Mode', AXIdentifier: 'Mode', pid: 42, frame, children: [] }] } },
  popup: menu([item('Basic'), item('Scientific'), item('Programmer')]),
  menu: { AXRole: 'AXMenuBar', children: [barItem('Apple', [item('About This Mac'), item('Recent Items', {
    children: [menu([item('private-file.txt', { AXIdentifier: '_recentItemRequested:' })], true)] }), item('Shut Down…', { AXIdentifier: '_shutDownRequested:' })]),
    barItem('View', [item('Basic'), item('Scientific')]),
    barItem('File', [item('Open Recent', { children: [menu([item('x.txt'), item('Clear Menu')], true)] })]),
    barItem('Format', [item('Font', { children: [menu([item('Bold')], true)] })]),
    barItem('Calculator', [item('Services', { children: [menu([item('Installed Software')], true)] })])] },
});
const req = (id, method, params = {}, extra = {}) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64),
  id, method, params: { ...binding, ...params }, deadline: Date.now() + 30000, ...extra });
const read = (id, params, extra) => req(id, 'getAXState', params, extra);
const click = (id, target, readId, extra) => req(id, 'click', { readId, read: 'full', args: [target] }, extra);
const variants = {
  'timing-success': ['result["timing"] = timing', '/* timing omitted */'],
  'timing-fault': ['mark(); fault.disposition["timing"] = timing', 'mark(); /* timing omitted */'],
  'apple': ['let hideApple = apple && !appleExpanded', 'let hideApple = false'],
  'submenu': ['let hideSubmenu = !submenu.isEmpty && !(requestedSubmenu && submenuExpanded)', 'let hideSubmenu = false'],
  'retained': ['if hideApple || hideSubmenu { /* Intentionally omitted, not truncated. */ }', 'if false { }'],
  'localized': ['["", "Apple", ""].contains(driverClean(attrs[kAXTitleAttribute]))', 'driverClean(attrs[kAXIdentifierAttribute]) == "_aboutThisMacRequested:"'],
  'provenance': ['if let input = input, !input.map.truncated, input.map.root.same(map.root), input.sequence == sequence {', 'if let input = input, !input.map.truncated, input.map.root.same(map.root) {'],
  'sequence': ['&& $0.sequence == sequence', ''],
  'chain': ['owner.same(record.owner),', 'true,'],
  'expanded': ['flags.contains("expanded") && !flags.contains("collapsed")', 'true'],
  'subtree': ['driverCoordinateIdentity(attrs, attributes: driverMenuAttributes) == retained.menuIdentity', 'true'],
  'window': ['$0.window == window && $0.root.same(root)', 'true'],
  'cell': ['let input = pending.removeValue(forKey: window)', 'let input = pending.removeValue(forKey: window); if input == nil { records.removeValue(forKey: window) }'],
  'bar-chain': ['guard !["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem"].contains(attrs[kAXRoleAttribute] as? String ?? ""),', 'guard true,'],
  'leaf': ['if candidates[0].root.same(map.root) { throw DriverFault("ACTION_UNSUPPORTED") }', 'if candidates[0].root.same(map.root) { try request.admitInput(); try access.perform(candidates[0].node, kAXPressAction, request) }'],
  'any-menu': ['guard let record = core.popups.record(menu: menuNode, window: id, root: bound.root, sequence: core.person.inputSequence()) else {',
    'let record = core.popups.record(menu: menuNode, window: id, root: bound.root, sequence: core.person.inputSequence()) ?? DriverPopupBank.Record(window: id, root: bound.root, owner: menu.parent!, menu: menuNode, sequence: core.person.inputSequence()); if false {'],
  'first-read': ['let input = pending.removeValue(forKey: window)', 'let input = pending[window]'],
  'menu-node': ['&& $0.menu.same(menu)', ''],
  'submenu-count': ['guard menus > 0, count == expected else', 'guard true else'],
  'press-advertised': ['guard actions.contains(kAXPressAction) else', 'guard true else'],
  'popup-enabled': ['guard node.enabled else { throw DriverCompoundStop.disabled }\n        return node', 'return node'],
};

test('GLS2 C and D, native printer, provenance and both AX admission checks', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-gls2b-'))); t.after(() => rm(root, { recursive: true, force: true }));
  // Mutable fake inventory is compiled into this harness only.
  let source = macDriverSource().replace('let fixture: DriverObject?', 'var fixture: DriverObject?');
  if (process.env.GLS2B_NATIVE_MUTANT) {
    const [before, after] = variants[process.env.GLS2B_NATIVE_MUTANT];
    assert.ok(source.includes(before), 'variant anchor'); source = source.replace(before, after);
    if (process.env.GLS2B_NATIVE_MUTANT === 'timing-success') source = source.replaceAll(before, after);
    if (process.env.GLS2B_NATIVE_MUTANT === 'chain') source = source.replace('access.parent(menuNode, request)', 'Optional(menu.parent!)')
      .replace('guard let actual = try access.parent(node, request), actual.same(parent) else', 'guard true else');
    if (process.env.GLS2B_NATIVE_MUTANT === 'sequence') source = source.replace('record.sequence == sequence &&', '')
      .replace('input.sequence == sequence', 'true')
      .replace('guard record.sequence == core.person.inputSequence() else { throw DriverFault("PERSON_TOOK_OVER") }', '');
    if (process.env.GLS2B_NATIVE_MUTANT === 'first-read') source = source.replace('defer { popups.cancel(window: id) }', '');
    if (process.env.GLS2B_NATIVE_MUTANT === 'menu-node') source = source.replace('menus.contains { $0.node.same(record.menu) }', '!menus.isEmpty');
  }
  const at = source.lastIndexOf('\ndriverMain()'); assert.ok(at > 0);
  const swift = join(root, 'fixture.swift'), binary = join(root, 'fixture');
  await writeFile(swift, source.slice(0, at) + '\n' + await readFile(new URL('./fixtures/gls2b-menu.swift', import.meta.url), 'utf8'));
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), swift, '-o', binary],
    { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = (fixture, requests) => {
    const result = spawnSync(binary, [], { input: [fixture, ...requests].map(JSON.stringify).join('\n') + '\n',
      timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1048576 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').map(JSON.parse);
  };
  const popupRun = (fixture = base(), extras = []) => run(fixture, [read(1), click(2, 1, 1), ...extras]);
  const refused = (reply, code) => {
    assert.equal(reply.ok, false, JSON.stringify(reply)); if (code) assert.equal(reply.error.code, code, JSON.stringify(reply));
    assert.deepEqual(reply.presses, []); assert.equal(reply.error.delivery, 'not-sent');
  };
  await t.test('C1 collapsed Apple prints only its bar row; C2 hidden numbers and selectors have no candidate', () => {
    const fixture = base();
    for (const target of [{ label: 'Shut Down…' }, { id: '_shutDownRequested:' }, { id: '_recentItemRequested:' }]) {
      const [before, after] = run(fixture, [read(1), click(2, target, 1)]);
      assert.doesNotMatch(before.result.text, /private-file|_recentItemRequested:|Shut Down/);
      assert.match(before.result.text, /\n\t\d+ Apple\n\t\d+ View/);
      assert.equal(before.retained.length, [...before.result.text.matchAll(/^\t*\d+ /gm)].length);
      refused(after, 'STALE_ELEMENT');
    }
  });
  await t.test('C5 expanded Apple prints top level only, including submenu count', () => {
    const fixture = base(); fixture.menu.children[0].AXExpanded = true;
    const [reply] = run(fixture, [read(1)]);
    assert.match(reply.result.text, /menu bar item \(expanded\) Apple/);
    assert.match(reply.result.text, /Recent Items \(submenu, 1 items\)/);
    assert.match(reply.result.text, /Shut Down/); assert.doesNotMatch(reply.result.text, /private-file/);
  });
  await t.test('C2 a hidden session-item selector cannot reach native input', () => {
    const [, reply] = run(base(), [read(1), click(2, { id: '_shutDownRequested:' }, 1)]);
    refused(reply, 'STALE_ELEMENT'); assert.equal(reply.posts, 0);
  });
  for (const [title, secret] of [['Open Recent', 'x.txt'], ['Font', 'Bold'], ['Services', 'Installed Software']])
    await t.test(`C6-8 ${title} collapses in every menu`, () => {
      const [reply] = run(base(), [read(1)]);
      assert.ok(reply.result.text.includes(`${title} (submenu, `)); assert.ok(!reply.result.text.includes(secret));
    });
  await t.test('C9 content ID is no privacy heuristic; localized and empty Apple titles collapse structurally', () => {
    for (const title of ['', '']) {
      const fixture = base(); fixture.menu.children[0].AXTitle = title;
      fixture.trees[7].children.push(item('content item', { AXIdentifier: '_recentItemRequested:' }));
      const [reply] = run(fixture, [read(1)]);
      assert.match(reply.result.text, /content item, ID: _recentItemRequested:/); assert.doesNotMatch(reply.result.text, /private-file/);
      assert.doesNotMatch(reply.result.text, /About This Mac|Shut Down/);
    }
  });
  await t.test('C requested expanded submenu can print; collapsed submenu still hides', () => {
    const fixture = base();
    const [reply] = run(fixture, [read(1, { menuRequests: ['Open Recent'] })]);
    assert.match(reply.result.text, /menu item x.txt/); assert.doesNotMatch(reply.result.text, /private-file|Installed Software/);
    fixture.menu.children[2].children[0].children[0].children[0].AXExpanded = false;
    assert.doesNotMatch(run(fixture, [read(1, { menuRequests: ['Open Recent'] })])[0].result.text, /x.txt/);
  });
  await t.test('C10 persisted bytes are the printer bytes; C11 emit:false observations cannot add private diff rows', async () => {
    const [reply] = run(base(), [read(1)]), path = join(root, 'persisted.txt');
    await writeFile(path, reply.result.text); assert.equal(await readFile(path, 'utf8'), reply.result.text);
    assert.doesNotMatch(await readFile(path, 'utf8'), /private-file|x.txt|Installed Software/);
    const state = createMacReadState(); state.read(reply.result);
    const printed = state.prepareDisplay([], [], { compact: true });
    assert.doesNotMatch(JSON.stringify(printed.content ?? []), /private-file|x.txt/);
  });
  await t.test('Calculator recorded read rows and bytes before and after', async () => {
    for (const file of ['glc1-calculator-closed.txt', 'glc2-calculator-after-seven.txt']) {
      const before = await readFile(new URL('./fixtures/' + file, import.meta.url), 'utf8');
      const fixture = recordedFixture(before); fixture.popup = base().popup;
      const [reply] = run(fixture, [read(1)]);
      assert.equal(reply.ok, true); assert.equal(reply.result.truncated, false);
      const count = text => [...text.matchAll(/^\t*\d+ /gm)].length;
      assert.ok(count(reply.result.text) < count(before) - 70);
      assert.doesNotMatch(reply.result.text, /Memo-acda03e0|_recentItemRequested:/);
      // The archived call 3 starts with click(150). Privacy pruning removes
      // that old number, so its literal replay stops before the second click.
      const [, archived] = run(fixture, [read(1), click(2, 150, 1)]);
      refused(archived, 'STALE_ELEMENT');
      t.diagnostic(JSON.stringify({ calculator: { fixture: file, beforeRows: count(before), beforeBytes: Buffer.byteLength(before),
        afterRows: count(reply.result.text), afterBytes: Buffer.byteLength(reply.result.text) } }));
    }
  });
  await t.test('C compound-compatible View > Basic remains numbered and pressable', () => {
    const [before] = run(base(), [read(1)]);
    const number = Number(/^\t*(\d+) menu item Basic$/m.exec(before.result.text)[1]);
    const [, reply] = run(base(), [read(1), click(2, number, 1)]);
    assert.equal(reply.ok, true, JSON.stringify(reply)); assert.deepEqual(reply.presses, ['Basic']);
  });
  await t.test('D1 own popup returned expanded and pressed through its owner root in the next cell', () => {
    const replies = popupRun(base(), [click(3, 4, 2)]);
    assert.match(replies[1].result.text, /menu \(expanded\)/);
    assert.equal(replies[2].ok, true, JSON.stringify(replies[2]));
    assert.deepEqual(replies[2].presses, ['Scientific']); assert.equal(replies[2].result.semantics, 'menu-accessibility');
    assert.equal(replies[1].ownRootRecord, true);
    for (const reply of replies.slice(1)) for (const key of ['sendMs', 'settleMs', 'postReadMs'])
      assert.ok(Number.isFinite(reply.result.timing?.[key]) && reply.result.timing[key] >= 0, key);
  });
  await t.test('D1 an expanded popup may also report focus', () => {
    const fixture = base(); fixture.popup.AXFocused = true;
    const replies = popupRun(fixture, [click(3, 4, 2)]);
    assert.match(replies[1].result.text, /menu \(focused, expanded\)/);
    assert.equal(replies[2].ok, true, JSON.stringify(replies[2]));
  });
  await t.test('D1 dormant menu nodes gain provenance only when own input expands them', () => {
    const fixture = base(); fixture.trees[7].children[0].children = [menu([])];
    const replies = popupRun(fixture, [click(3, 4, 2)]);
    assert.equal(replies[2].ok, true, JSON.stringify(replies[2]));
  });
  await t.test('D2 person-opened popup has no own-input record', () => {
    const [, reply] = run(base(), [read(1, {}, { fixtureOpen: true }), click(2, { label: 'Programmer' }, 1)]);
    refused(reply, 'ACTION_UNSUPPORTED'); assert.match(formatMacDriverError(reply.error), /Not sleight-opened/);
    assert.equal(reply.ownRootRecord, false); assert.equal(reply.error.menuRefusal, 'person-popup');
    for (const key of ['sendMs', 'settleMs', 'postReadMs'])
      assert.ok(Number.isFinite(reply.error.timing?.[key]) && reply.error.timing[key] >= 0, key);
  });
  await t.test('D3 a replacement menu node cannot inherit another menu record', () => {
    const replies = popupRun(base(), [read(3, {}, { replaceMenu: true }), click(4, { label: 'Programmer' }, 3)]);
    refused(replies[3], 'ACTION_UNSUPPORTED');
  });
  await t.test('D first read after own input must contain the new menu', () => {
    const fixture = base(); fixture.control = { delayedOpen: true };
    const replies = popupRun(fixture, [read(3, {}, { fixtureOpen: true }), click(4, { label: 'Programmer' }, 3)]);
    refused(replies[3], 'ACTION_UNSUPPORTED');
  });
  for (const control of [{ wrongChain: true }, { lateChain: true }, { lateText: true }])
    await t.test('D3 both checks and subtree proof ' + JSON.stringify(control), () => {
      const fixture = base(); fixture.control = control;
      refused(popupRun(fixture, [click(3, { label: 'Programmer' }, 2)])[2], 'STALE_ELEMENT');
    });
  await t.test('D4 changed menu subtree refuses between delivered and fresh reads', () => {
    const replies = popupRun(base(), [read(3, {}, { rename: true }), click(4, { label: 'Scientific' }, 2)]);
    refused(replies[3], 'STALE_READ');
  });
  await t.test('D5 a popup leaf with children is never AXPressed', () => {
    const fixture = base(); fixture.popup.children[2].children = [menu([item('Nested')])];
    const reply = popupRun(fixture, [click(3, { label: 'Programmer' }, 2)])[2];
    refused(reply, 'ACTION_UNSUPPORTED');
  });
  for (const lateHiddenCount of [false, true]) await t.test('D a collapsed submenu sibling keeps its count, drift=' + lateHiddenCount, () => {
    const fixture = base(); fixture.control = { lateHiddenCount, noSiblingActions: true };
    fixture.popup.children.push(item('More', { children: [{ ...menu([item('Private child')], true), privateSubmenu: true },
      { AXRole: 'AXImage', AXTitle: 'Private badge' }] }));
    const reply = popupRun(fixture, [click(3, 4, 2)])[2];
    if (lateHiddenCount) refused(reply, 'STALE_ELEMENT');
    else { assert.equal(reply.ok, true, JSON.stringify(reply)); assert.deepEqual(reply.presses, ['Scientific']); }
    assert.doesNotMatch(JSON.stringify(reply), /Private child|Extra private item|Private badge/);
  });
  for (const [extra, code] of [[{ AXEnabled: false }, 'ELEMENT_DISABLED'], [{ actions: [] }, 'ACTION_UNSUPPORTED'],
    [{ AXSubrole: 'AXSecureTextField' }, 'STALE_ELEMENT']]) await t.test('D popup target eligibility ' + JSON.stringify(extra), () => {
    const fixture = base(); Object.assign(fixture.popup.children[1], extra);
    refused(popupRun(fixture, [click(3, 4, 2)])[2], code);
  });
  await t.test('D8 duplicate popup items refuse ambiguity', () => {
    const fixture = base(); fixture.popup.children.push(item('Programmer'));
    refused(popupRun(fixture, [click(3, { label: 'Programmer' }, 2)])[2], 'AMBIGUOUS_ELEMENT');
  });
  await t.test('D6 a delivered collapsed popup is never admitted', () => {
    const fixture = base(); fixture.control = { forceCollapsed: true };
    refused(popupRun(fixture, [click(3, { label: 'Programmer' }, 2)])[2], 'STALE_ELEMENT');
  });
  await t.test('D7 owner ancestry cannot pass through a menu bar', () => {
    const fixture = base(); fixture.control = { barChain: true };
    refused(popupRun(fixture, [click(3, { label: 'Programmer' }, 2)])[2], 'STALE_ELEMENT');
  });
  await t.test('D9 ownership survives an intervening cell and read', () => {
    const replies = popupRun(base(), [read(3), click(4, { label: 'Programmer' }, 3)]);
    assert.equal(replies[3].ok, true, JSON.stringify(replies[3])); assert.deepEqual(replies[3].presses, ['Programmer']);
  });
  await t.test('D11 coordinate input establishes the same owner record', () => {
    // The fixture geometry is injected in the production pointer registrar by
    // the harness; no image or host event is produced.
    const replies = run(base(), [read(1), click(2, [50, 50], 1), click(3, { label: 'Programmer' }, 2)]);
    assert.equal(replies[1].ok, true, JSON.stringify(replies));
    assert.equal(replies[2].ok, true, JSON.stringify(replies));
  });
  await t.test('D12 person input after opening invalidates ownership', () => {
    const reply = popupRun(base(), [click(3, { label: 'Programmer' }, 2, { personInput: true })])[2];
    refused(reply, 'ACTION_UNSUPPORTED');
  });
  await t.test('D12 person input across the opening action grants no ownership', () => {
    const fixture = base(); fixture.control = { personDuringInput: true };
    refused(popupRun(fixture, [click(3, { label: 'Programmer' }, 2)])[2], 'ACTION_UNSUPPORTED');
  });
  await t.test('D13 same app and window ID do not authorize another AX window root', () => {
    const replies = popupRun(); assert.equal(replies[1].foreignRootRecord, false);
  });
});
