import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rule from '../plugins/sleight/lib/windows-driver/clipboard.mjs';
import { parseAccelerator } from '../plugins/sleight/lib/windows-driver/actions.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { MAC_DRIVER_SENTENCES, formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { windowsClipboardFixture as fixture } from './fixtures/windows-driver-fake.mjs';

const base = new URL('../plugins/sleight/lib/', import.meta.url);
const nodes = (name = 'Ordinary', accelerator = '', access = '') => [
  { depth: 0, role: 'dialog', name: 'Fixture' },
  { depth: 1, role: 'button', name, accelerator, access, focused: true },
];
const oem = [[';', 0xba], [':', 0xba], ['=', 0xbb], ['+', 0xbb], [',', 0xbc], ['<', 0xbc],
  ['-', 0xbd], ['_', 0xbd], ['.', 0xbe], ['>', 0xbe], ['/', 0xbf], ['?', 0xbf], ['`', 0xc0], ['~', 0xc0],
  ['[', 0xdb], ['{', 0xdb], ['\\', 0xdc], ['|', 0xdc], [']', 0xdd], ['}', 0xdd], ["'", 0xde], ['"', 0xde]];

async function punctuation(module) {
  let layouts = 0;
  for (const [key, vk] of oem) {
    const resolved = module.resolveWindowsAccelerator('Ctrl+' + key, () => { layouts++; return -1; });
    assert.equal(resolved.key, vk, key); assert.deepEqual(resolved.modifiers, [17]);
    const h = fixture({ rule: module, nodes: nodes('Command', 'Ctrl+' + key), map: () => { layouts++; return -1; } });
    await assert.doesNotReject(h.action('click', [1]));
    assert.equal(h.actions.length, 1, key);
  }
  assert.equal(layouts, 0, 'Russian layout is never queried for US accelerator punctuation');
}
test('WCB1C 22 OEM accelerator glyphs, including a Ctrl+/ click, bypass a Russian layout', async () => {
  await punctuation(rule);
  // Typed keys keep the target layout path, even for the same slash glyph.
  await assert.rejects(fixture({ map: () => -1 }).action('pressKey', ['/'], { parent: false }), { code: 'KEY_LAYOUT_UNAVAILABLE' });
});

async function keyTips(module) {
  for (const items of [nodes('Copy', '', 'Alt, H, C'), nodes('Ordinary')]) {
    const h = fixture({ rule: module, nodes: items });
    await assert.rejects(h.action('pressKey', ['Alt'], { parent: false }), {
      code: 'ACTION_UNSUPPORTED', reason: 'key-tip-target-unresolved', delivery: 'not-sent', retry: 'safe', clipboard: 'untouched',
    });
    assert.deepEqual(h.actions, []); assert.deepEqual(h.posts, []); assert.deepEqual(h.patterns, []);
  }
  const unknown = fixture({ rule: module, nodes: nodes('Ordinary') });
  await assert.rejects(unknown.action('pressKey', ['Alt+h'], { parent: false }), { code: 'ACTION_UNSUPPORTED', reason: 'key-tip-target-unresolved' });
  assert.deepEqual(unknown.actions, []);
  for (const chord of ['Alt+h', 'Alt+c']) {
    for (const items of [nodes('Copy', '', 'Alt, H, C'), nodes('Ordinary', 'Ctrl+C', 'Alt, H, C')]) {
      const h = fixture({ rule: module, nodes: items });
      await assert.rejects(h.action('pressKey', [chord], { parent: false }), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
      assert.deepEqual(h.actions, []);
    }
  }
  const allowed = fixture({ rule: module, nodes: nodes('Cancel', '', 'Alt+C') });
  await allowed.action('pressKey', ['Alt+c'], { parent: false }); assert.equal(allowed.posts.length, 1);
  const plain = fixture({ rule: module, nodes: nodes('Copy', '', 'Alt, H, C') });
  await plain.action('pressKey', ['h'], { parent: false }); assert.equal(plain.posts.length, 1, 'ordinary text has no preceding admitted Alt');
}
test('WCB1C ribbon sequence refuses standalone Alt before its first post; explicit tips require a target', async () => keyTips(rule));

test('WCB1C PrintScreen accelerator aliases refuse independently of the label', async () => {
  for (const text of ['PrtScn', 'Print Screen', 'Alt+PrtScn', 'Alt+Print Screen']) {
    assert.equal(parseAccelerator(text).virtualKey, 44);
    const h = fixture({ nodes: nodes('Ordinary', text) });
    await assert.rejects(h.action('click', [1], { parent: false }), { code: 'ACTION_UNSUPPORTED' });
    assert.deepEqual(h.actions, []);
  }
});

test('WCB1C mirror checks focus before resolving/refusing a clipboard key, matching C#', () => {
  for (const focused of [0, 2]) {
    const items = nodes(); items.forEach(n => { n.focused = focused === 2; });
    assert.throws(() => rule.admitWindowsClipboardAction({ method: 'pressKey', args: ['Ctrl+c'], nodes: items,
      map: () => 67, resolveTarget() {} }), { code: 'NO_BACKGROUND_FOCUS' });
  }
});

async function latch(factory) {
  let sent = 0;
  const safety = factory({ platform: 'win32' }, {
    queue: { queued: 0, serial: Promise.resolve() }, epoch: () => 0,
    fail(code) { throw Object.assign(Error(code), { code }); },
    dispatch() { sent++; throw Object.assign(Error(MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED), { code: 'CLIPBOARD_CHANGED', clipboardChanged: true }); },
  });
  await assert.rejects(safety.request('click', {}), { code: 'CLIPBOARD_CHANGED' });
  const stopped = { code: 'CLIPBOARD_CHANGED', message: MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED,
    delivery: 'not-sent', retry: 'read-first', next: 'stop-tell-user' };
  await assert.rejects(safety.request('click', {}), { ...stopped, message: formatMacDriverError(stopped, { action: true }) });
  assert.equal(sent, 1);
}
test('WCB1C fast latched Windows error carries the existing stop directive', async () => latch(createDriverSafety));

async function mutate(relative, change) {
  const url = new URL(relative, base), original = readFileSync(url, 'utf8');
  let changed = change(original); assert.notEqual(changed, original);
  changed = changed.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_, q, path) => `from ${q}${new URL(path, url).href}${q}`);
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
for (const [id, relative, change, witness] of [
  ['C1 OEM map', 'windows-driver/clipboard.mjs', s => s.replace('if (Object.hasOwn(oem, chord.key))', 'if (false && Object.hasOwn(oem, chord.key))'), punctuation],
  ['C2 standalone Alt', 'windows-driver/clipboard.mjs', s => s.replace('chord.key === undefined && chord.modifiers.includes(18)', 'false'), keyTips],
  ['C3 unresolved Alt letter', 'windows-driver/clipboard.mjs', s => s.replace('targets.length === 0', 'false'), keyTips],
  ['C4 latched text', 'driver-safety.mjs', s => s.replace("return platform === 'win32' ? windowsClipboardError(error) : error;", 'return error;'), m => latch(m.createDriverSafety)],
]) test(`${id}: production passes and broken variant fails`, async t => {
  const production = relative === 'driver-safety.mjs' ? { createDriverSafety } : rule;
  await witness(production);
  const broken = await mutate(relative, change);
  await assert.rejects(Promise.resolve().then(() => witness(broken)));
  t.diagnostic('1 production witness passed; 1 broken-variant witness failed');
});

function nativeBoundary(source) {
  const run = source.slice(source.indexOf('    object RunAction('));
  const start = run.indexOf('plan.Chord.Key == null && plan.Chord.Modifiers.Contains(18)');
  const unresolved = run.indexOf('plan.Chord.Modifiers.Contains(18) && accessTargets.Count == 0');
  assert.ok(start >= 0 && start < run.indexOf('settle.Begin()'));
  assert.ok(unresolved > start && unresolved < run.indexOf('settle.Begin()'));
  assert.match(run.slice(unresolved), /throw DriverClipboardRule.Refusal\("key-tip-target-unresolved"\)/);
  assert.match(run, /foreach \(var item in accessTargets\)[\s\S]*?GetCurrentPropertyValueEx\(AccessKey, true\)[\s\S]*?RefuseClipboardTarget\(item, plan\)/);
}
test('WCB1C uncompiled C# key-tip guards precede input, with broken placement witnesses', () => {
  const source = readFileSync(new URL('direct-browser/native/win/DriverActions.cs', base), 'utf8');
  nativeBoundary(source);
  for (const mutation of [s => s.replace('plan.Chord.Key == null && plan.Chord.Modifiers.Contains(18)', 'false'),
    s => s.replace('plan.Chord.Modifiers.Contains(18) && accessTargets.Count == 0', 'false')])
    assert.throws(() => nativeBoundary(mutation(source)), { code: 'ERR_ASSERTION' });
  const clipboard = readFileSync(new URL('direct-browser/native/win/DriverClipboard.cs', base), 'utf8');
  for (const [key, vk] of oem.filter(([key]) => key !== '+')) {
    const literal = JSON.stringify(key);
    const start = clipboard.indexOf('case ' + literal + ':', clipboard.indexOf('int oem = 0;'));
    assert.ok(start >= 0, literal);
    assert.match(clipboard.slice(start).split('break;')[0], new RegExp('oem = 0x' + vk.toString(16)), literal);
  }
});
