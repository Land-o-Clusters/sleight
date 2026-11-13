import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tabProbeRefusal } from '../plugins/sleight/lib/tab-probe.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
function fixture({ tickMs = 0, collide = false } = {}) {
  let time = 0, equalCalls = 0;
  const hashes = new Map();
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const node = (AXRole, more = {}) => ({ AXRole, AXChildren: list([]), ...more });
  const window = node('AXWindow', { AXTitle: 'Before', AXSubrole: 'AXStandardWindow', AXWindowNumber: 22 });
  const tab = node('AXRadioButton', { AXValue: 1 });
  const tabs = node('AXTabGroup', { AXChildren: list([tab]) });
  const field = node('AXComboBox', { AXIdentifier: 'urlbar-input', AXEnabled: true, settable: true });
  const toolbar = node('AXToolbar', { AXChildren: list([field]) });
  const page = node('AXWebArea');
  window.AXChildren = list([tabs, toolbar, page]);
  for (const child of [tabs, toolbar, page]) child.AXParent = window;
  tab.AXParent = tabs; field.AXParent = toolbar;
  const menu = node('AXMenuBar');
  const app = { AXWindows: list([window]), AXFocusedWindow: window, AXFocusedUIElement: field, AXMenuBar: menu };
  const reads = [];
  const $ = value => value;
  Object.assign($, { NSUUID: { UUID: { UUIDString: 'epoch' } }, AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ processIdentifier: 123, launchDate: { timeIntervalSince1970: 1 } }]) },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, ref) => {
      reads.push([element, name]); time += tickMs;
      assert.ok(element !== page || ['AXRole', 'AXRoleDescription'].includes(name), 'no document content or children');
      assert.ok(name !== 'AXValue' || element.AXRole === 'AXRadioButton', 'no field values');
      if (element.failure === name) return -25204;
      if (!(name in element)) return -25212;
      ref[0] = element[name]; return 0;
    },
    AXUIElementIsAttributeSettable: (element, name, ref) => { assert.equal(name, 'AXValue'); ref[0] = !!element.settable; return 0; },
    CFHash: element => { if (!hashes.has(element)) hashes.set(element, hashes.size + 1); return collide ? 1 : hashes.get(element); },
    CFEqual: (a, b) => { equalCalls++; return a === b; }, CGEventSourceSecondsSinceLastEventType: () => 1000 });
  const context = { Date: { now: () => time }, $, Ref: () => [], ObjC: { import() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x } };
  runInNewContext(source, context);
  const request = { appId: 'org.test.browser', app: 'Fixture Browser', title: 'Before', url: null, windowNumber: 22, focus: true, tabCertificate: true };
  const read = (extra = {}) => { context.request = { ...request, ...extra }; return JSON.parse(runInNewContext('run([JSON.stringify(request)])', context)); };
  return { list, node, window, tab, tabs, field, toolbar, page, app, menu, reads, read, equalCalls: () => equalCalls };
}

test('CK3 native certificate retains tab and group references without reading document content', () => {
  const f = fixture(), before = f.read();
  assert.equal(before.chrome?.complete, true);
  assert.equal(before.chrome.tabCount, 1);
  assert.equal(before.chrome.childCount, 1);
  assert.equal(before.chrome.addressField, before.chrome.focused);
  assert.equal(before.chrome.tabs.filter(t => t.selected).length, 1);
  const second = f.read();
  assert.deepEqual(second.chrome, before.chrome);
  const added = f.node('AXRadioButton', { AXValue: 1, AXParent: f.tabs });
  f.tab.AXValue = 0; f.tabs.AXChildren = f.list([f.tab, added]); f.window.AXTitle = 'New Tab';
  const after = f.read({ followTab: true, nativeIdentity: before });
  assert.equal(after.status, 'ok');
  assert.equal(after.title, 'New Tab');
  assert.equal(after.window, before.window);
  assert.equal(after.chrome.group, before.chrome.group);
  assert.equal(after.chrome.tabCount, 2);
  assert.equal(after.chrome.childCount, 2);
  assert.equal(after.chrome.tabs[0].ref, before.chrome.tabs[0].ref);
  assert.notEqual(after.chrome.tabs[1].ref, before.chrome.tabs[0].ref);
});

for (const [name, change] of [
  ['nested sheet', f => { f.toolbar.AXChildren = f.list([f.field, f.node('AXGroup', { AXChildren: f.list([f.node('AXSheet')]) })]); }],
  ['dialog', f => { f.window.AXChildren = f.list([f.tabs, f.toolbar, f.page, f.node('AXDialog')]); }],
  ['menu trap', f => { f.menu.AXChildren = f.list([f.node('AXMenuBarItem', { AXSelected: true })]); }],
  ['popover', f => { f.toolbar.AXChildren = f.list([f.field, f.node('AXPopover')]); }],
  ['secure field', f => { f.field.AXSubrole = 'AXSecureTextField'; }],
  ['page focus', f => { f.app.AXFocusedUIElement = f.node('AXTextField', { AXParent: f.page }); }],
  ['ordinary chrome search field', f => { f.field.AXIdentifier = 'search-input'; }],
  ['noneditable field', f => { f.field.settable = false; }],
  ['disabled field', f => { f.field.AXEnabled = false; }],
  ['missing tab selection', f => { delete f.tab.AXValue; }],
  ['two selected tabs', f => { f.tabs.AXChildren = f.list([f.tab, f.node('AXRadioButton', { AXValue: 1, AXParent: f.tabs })]); }],
  ['ambiguous group', f => { f.window.AXChildren = f.list([f.tabs, f.toolbar, f.page, f.node('AXTabGroup')]); }],
  ['truncated children', f => { f.toolbar.AXChildren = { count: 257 }; }],
  ['missing children', f => { delete f.toolbar.AXChildren; }],
  ['failed AX query', f => { f.field.failure = 'AXIdentifier'; }],
  ['ancestry cycle', f => { f.field.AXParent = f.field; }],
]) test(`CK3 native certificate refuses ${name}`, () => {
  const f = fixture(); change(f);
  assert.notEqual(f.read().chrome?.complete, true);
});

test('CK3 following a retitled window requires the same retained native window, pid, process and helper', () => {
  const f = fixture(), before = f.read(); f.window.AXTitle = 'New Tab';
  for (const [key, value] of [['epoch', 'other'], ['window', 999], ['pid', 456], ['processStart', 2]]) {
    const now = f.read({ followTab: true, nativeIdentity: { ...before, [key]: value } });
    assert.notEqual(now.status, 'ok');
  }
  assert.notEqual(f.read({ followTab: true }).status, 'ok');
});

test('CK3 certificate off performs no chrome enumeration', () => {
  const f = fixture();
  assert.equal(f.read({ tabCertificate: false, focus: false }).chrome, undefined);
  assert.equal(f.reads.some(([element]) => element === f.field || element === f.tabs || element === f.page), false);
});

for (const role of ['AXMenuBarItem', 'AXPopUpButton', 'AXMenuButton']) {
  test(`CK3 accepts closed ${role} menus without walking their contents`, () => {
    const f = fixture();
    const content = f.node('AXSheet');
    const menu = f.node('AXMenu', { AXVisible: false, AXSelectedChildren: f.list([]), AXChildren: f.list([content]) });
    const owner = f.node(role, { AXSelected: false, AXChildren: f.list([menu]) });
    if (role === 'AXMenuBarItem') f.menu.AXChildren = f.list([owner]);
    else f.toolbar.AXChildren = f.list([f.field, owner]);
    assert.equal(f.read().chrome?.complete, true);
    assert.equal(f.reads.some(([element, name]) => element === content || element === menu && name === 'AXChildren'), false);
  });
}
for (const state of [{ AXVisible: true }, { AXSelectedChildren: { count: 1 } }]) {
  test(`CK3 refuses an open menu with ${Object.keys(state)[0]}`, () => {
    const f = fixture(), menu = f.node('AXMenu', state);
    f.menu.AXChildren = f.list([f.node('AXMenuBarItem', { AXChildren: f.list([menu]) })]);
    assert.equal(f.read().chrome?.reason, 'chrome-transient');
  });
}
test('CK3 stops the native walk at its wall-clock budget', () => {
  const f = fixture({ tickMs: 10 });
  f.toolbar.AXChildren = f.list([f.field, ...Array.from({ length: 100 }, () => f.node('AXButton'))]);
  const result = f.read();
  assert.equal(result.chrome?.complete, false);
  assert.equal(result.chrome?.reason, 'chrome-deadline');
  assert.equal(result.chrome?.check, 'walk');
  assert.ok(result.chrome.walkMs >= 250 && result.chrome.walkMs <= 260);
  assert.ok(f.reads.filter(([element]) => element.AXRole === 'AXButton').length < 10);
});
test('CK3 buckets native identity comparisons and preserves references on CFHash collisions', () => {
  const f = fixture();
  f.toolbar.AXChildren = f.list([f.field, ...Array.from({ length: 200 }, () => f.node('AXButton'))]);
  assert.equal(f.read().chrome?.complete, true);
  assert.ok(f.equalCalls() < 100, 'distinct hashes must not incur pairwise CFEqual scans');
  const collision = fixture({ collide: true }), before = collision.read();
  assert.equal(before.chrome?.complete, true);
  assert.notEqual(before.chrome.addressField, before.chrome.group);
  assert.deepEqual(collision.read().chrome, before.chrome);
  collision.toolbar.AXChildren = collision.list([collision.field, collision.field]);
  assert.equal(collision.read().chrome?.reason, 'incomplete-chrome');
});

// Reconstructed chrome from smoke-ck2c-firefox-mdn/mdn/events.jsonl (2026-10-19).
// The engine renders the tab's numeric AXValue as selected. Firefox exposes DOM ids
// through AXDOMIdentifier, not AXIdentifier (mozAccessible::moxDOMIdentifier).
function firefoxShape() {
  const f = fixture();
  delete f.field.AXIdentifier;
  f.field.AXDOMIdentifier = 'urlbar-input';
  const container = f.node('AXGroup', { AXChildren: f.list([f.field]), AXParent: f.toolbar });
  f.field.AXParent = container;
  f.toolbar.AXChildren = f.list([container]);
  const tabToolbar = f.node('AXToolbar', { AXChildren: f.list([f.tabs]), AXParent: f.window });
  f.tabs.AXParent = tabToolbar;
  f.tabs.AXChildren = f.list([f.tab, f.node('AXButton')]);
  f.window.AXChildren = f.list([tabToolbar, f.toolbar, f.page]);
  return f;
}

// safari-sleight-b10-r2/form-checkout: a content tab group exists with one tab,
// and Cmd+T exposes a separate TabBar?isSeparate=false group with two radio tabs.
function safariShape({ hidden = false } = {}) {
  const f = fixture();
  f.field.AXRole = 'AXTextField';
  f.field.AXIdentifier = 'WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD';
  const scroll = f.node('AXScrollArea', { AXChildren: f.list([f.page]) });
  const content = f.node('AXTabGroup', { AXChildren: f.list([scroll]), AXParent: f.window });
  scroll.AXParent = content; f.page.AXParent = scroll;
  f.tabs.AXIdentifier = 'TabBar?isSeparate=false';
  f.tab.AXValue = 0;
  f.tabs.AXChildren = f.list([f.tab, f.node('AXRadioButton', { AXValue: 1, AXParent: f.tabs })]);
  f.window.AXChildren = f.list([content, f.toolbar, ...(hidden ? [] : [f.tabs])]);
  return f;
}

test('CK2d recorded Firefox chrome proves its address field through AXDOMIdentifier', () => {
  const f = firefoxShape(), before = f.read();
  assert.equal(before.chrome?.complete, true);
  assert.equal(before.chrome.addressField, before.chrome.focused);
  assert.equal(before.chrome.childCount, 2);
  const added = f.node('AXRadioButton', { AXValue: 1, AXParent: f.tabs });
  f.tab.AXValue = 0;
  f.tabs.AXChildren = f.list([f.tab, added, f.tabs.AXChildren.objectAtIndex(1)]);
  const after = f.read();
  assert.equal(after.chrome?.complete, true);
  assert.equal(after.chrome.group, before.chrome.group);
  assert.equal(after.chrome.addressField, before.chrome.addressField);
  assert.equal(after.chrome.tabCount, 2);
  assert.equal(after.chrome.tabs[1].selected, true);
  assert.equal(tabProbeRefusal({ ...before, nativeIdentity: before }, after, 0, 1, true), undefined);
});

test('CK2d recorded Safari chrome uses the visible strip beside the content tab group', () => {
  const f = safariShape(), result = f.read();
  assert.equal(result.chrome?.complete, true);
  assert.equal(result.chrome.tabCount, 2);
  assert.equal(result.chrome.tabs[1].selected, true);
  assert.equal(result.chrome.addressField, result.chrome.focused);
});

test('CK2d hidden Safari strip never invents a baseline tab and passes after the strip appears', () => {
  const f = safariShape({ hidden: true }), before = f.read();
  assert.equal(before.chrome?.complete, false);
  assert.equal(before.chrome?.reason, 'missing-tab-strip');
  assert.equal(before.chrome?.check, 'tab-group');
  f.window.AXChildren = f.list([...Array.from({ length: f.window.AXChildren.count }, (_, i) => f.window.AXChildren.objectAtIndex(i)), f.tabs]);
  const after = f.read();
  assert.equal(after.chrome?.complete, true);
  assert.equal(tabProbeRefusal({ ...before, nativeIdentity: before }, after, 0, 1, true), 'incomplete-chrome');
  // The existing full-tree continuation admits the post-Cmd+T strip as its baseline.
  // That fresh baseline can certify the remainder without inventing a hidden old tab.
  assert.equal(tabProbeRefusal({ ...after, nativeIdentity: after }, f.read(), 0, 1), undefined);
});

for (const [name, mutate, reason, check] of [
  ['unrecognized DOM id', f => { f.field.AXDOMIdentifier = 'search-input'; }, 'unproved-address-field', 'address-field'],
  ['disabled field', f => { f.field.AXEnabled = false; }, 'unproved-address-field', 'address-field'],
  ['secure field', f => { f.field.AXSubrole = 'AXSecureTextField'; }, 'unproved-address-field', 'address-field'],
  ['no selection', f => { f.tab.AXValue = 0; }, 'ambiguous-selected-tab', 'tab-selection'],
  ['duplicate strip', f => { f.window.AXChildren = f.list([f.tabs, f.toolbar, f.page, f.node('AXTabGroup', { AXChildren: f.list([f.node('AXRadioButton', { AXValue: 1 })]) })]); }, 'ambiguous-tab-group', 'tab-group'],
]) test(`CK2d recorded Firefox refuses ${name} with the failed check`, () => {
  const f = firefoxShape(); mutate(f);
  const { chrome } = f.read();
  assert.equal(chrome?.complete, false);
  assert.equal(chrome?.reason, reason);
  assert.equal(chrome?.check, check);
});
