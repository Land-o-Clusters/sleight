import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SETTINGS_TITLE } from '../plugins/sleight/lib/blocked-apps.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/blocked-app.js', import.meta.url), 'utf8');
const recorded = JSON.parse(readFileSync(new URL('../docs/benchmarks/2026-10-04T15-34-50-972Z-blocked-codex.json', import.meta.url), 'utf8'));
// The recording retains numbered roles and labels, not native AX attributes.
// Attribute cases below are constructed variants; they are not live settings captures.
const main = { role: 'AXWindow', subrole: 'AXStandardWindow', title: 'ChatGPT', children: [
  { role: 'AXStaticText' }, { role: 'AXButton', subrole: 'AXCloseButton' },
  { role: 'AXButton', subrole: 'AXFullScreenButton' }, { role: 'AXButton', subrole: 'AXMinimizeButton' },
] };
function element(tree) {
  const children = (tree.children ?? []).map(element);
  return {
    title: () => tree.title ?? '', role: () => tree.role ?? 'AXGroup', subrole: () => tree.subrole ?? '',
    toolbars: () => tree.toolbars ?? [],
    attributes: { byName: name => ({ value: () => ({ AXIdentifier: tree.identifier ?? '', AXModal: tree.modal ?? false })[name] }) },
    uiElements: () => { if (tree.unreadable) throw new Error('cannotComplete'); return children; },
  };
}
function classify(tree) {
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => ({}) });
  vm.runInContext(source, context);
  return context.isSettingsWindow(element(tree), SETTINGS_TITLE.source, SETTINGS_TITLE.flags);
}

test('every legacy settings-window rule still refuses on its own', () => {
  for (const title of ['Settings', 'Preferences', '  Settings  ', 'PREFERENCES']) {
    assert.equal(classify({ ...main, title }), true, `title: ${title}`);
  }
  assert.equal(classify({ ...main, toolbars: [{}] }), true, 'win.toolbars(), with no AXToolbar child');
  assert.equal(classify({ ...main, children: [{ role: 'AXToolbar' }] }), true, 'direct AXToolbar child, with no win.toolbars()');
  assert.equal(classify(main), false, 'ordinary content control');
});

test('the recorded ChatGPT content window remains available, including its settings launcher button', () => {
  assert.ok(recorded.reported.some(text => text.includes('minimize button')));
  assert.equal(classify(main), false);
  assert.equal(classify({ ...main, children: [...main.children, { role: 'AXButton', identifier: 'open-settings' }] }), false);
});

test('settings identifiers refuse untranslated pane names and arbitrary localized titles without a toolbar', () => {
  for (const title of ['General', 'Algemeen', '일반', 'الإعدادات']) {
    for (const identifier of ['com.apple.Terminal.preferences', 'NSPreferencesWindow', 'settings-window']) {
      assert.equal(classify({ ...main, title, identifier }), true, `${title}/${identifier}`);
    }
  }
});

test('nested settings containers and nested toolbars refuse without using their labels', () => {
  for (const node of [{ role: 'AXGroup', identifier: 'com.openai.settings.content' }, { role: 'AXToolbar' }]) {
    assert.equal(classify({ ...main, title: 'General', children: [{ role: 'AXGroup', children: [node] }] }), true);
  }
});

test('modal and dialog windows refuse before exposing their contents', () => {
  for (const attrs of [{ modal: true }, { subrole: 'AXDialog' }, { subrole: 'AXSystemDialog' }]) {
    assert.equal(classify({ ...main, title: 'General', ...attrs }), true);
  }
});

test('settings inspection refuses unreadable and over-budget trees instead of assuming ordinary content', () => {
  assert.equal(classify({ ...main, unreadable: true }), true);
  assert.equal(classify({ ...main, children: Array.from({ length: 301 }, () => ({ role: 'AXGroup' })) }), true);
  let nested = { role: 'AXGroup' };
  for (let i = 0; i < 14; i++) nested = { role: 'AXGroup', children: [nested] };
  assert.equal(classify({ ...main, children: [nested] }), true);
});

test('ordinary terminal text and controls mentioning settings do not classify the document as settings', () => {
  assert.equal(classify({ ...main, title: 'preferences.txt', children: [
    { role: 'AXTextArea', title: 'settings', identifier: 'terminal-content' },
    { role: 'AXButton', identifier: 'settings' },
  ] }), false);
});
