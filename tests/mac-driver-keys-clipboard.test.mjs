import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { macDriverSource, validateMacDriverClipboardSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { keyPlan, clipboardKeyCodes } from '../plugins/sleight/lib/mac-driver/keys.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { clipboardClientReply } from './fixtures/mac-driver-clipboard-client.mjs';
import { createCua } from '../plugins/sleight/lib/repl/cua.mjs';
import { createReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { driverFixture } from './fixtures/driver-fake.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const mutation = process.env.CB1I_MUTATION ?? process.env.CB1G_MUTATION ?? '';
const nativeMutations = {
  Q_PLANNER: ['try Self.refuseClipboardKeys(specs, layout: currentLayout)', '// MUTANT admits clipboard keys'],
  M1: ['try Self.refuseClipboardKeys(specs, layout: currentLayout)', 'if args.keys.contains("meta"), ["c", "x", "v"].contains(args.key?.lowercased() ?? "") { throw Self.clipboardRefusal() }'],
  M2: ['safetyKeyCodes(layout, characters: ["c", "C", "x", "X"], physical: [8, 7])', 'safetyKeyCodes(layout, characters: ["c", "C", "x", "X"], physical: [])'],
  M3: ['[[], ["shift"], ["alt"], ["alt", "shift"], ["meta"], ["meta", "shift"]]', '[[], ["shift"], ["alt"], ["alt", "shift"]]'],
  M7: ['if let previous = lastCount, current != previous, !personInputSince(lastActionEnded)', 'if let previous = lastCount, false && current != previous, !personInputSince(lastActionEnded)'],
  M8: ['try Self.refuseClipboardMenu(Self.menuAttributes(item), layout: ', '// MUTANT unchecked menu: '],
  M9: ['if action == kAXPressAction {', 'if false && action == kAXPressAction {'],
  M10: ['try context.checkCoordinate?(point)', '// MUTANT skipped coordinate check'],
  M12: ['return current != admission.baseline', 'return current > admission.baseline'],
  I_SF1: ['lastCount = current\n            var fault', '// MUTANT baseline unchanged\n            var fault'],
  I_NOTIFY_LABEL: ['try DriverKeyboard.refuseClipboardLabel(label)\n        let attrs', '// MUTANT unchecked action label\n        let attrs'],
  I_NOTIFY_NODE: ['try DriverKeyboard.refuseClipboardMenu(attrs, layout: fake == nil ? nil : [:])\n    }\n    func perform', '// MUTANT unchecked banner title\n    }\n    func perform'],
  I_NOTIFY_EQUIVALENT: ['try DriverKeyboard.refuseClipboardEquivalent(attrs, layout: fake == nil ? nil : [:])', '// MUTANT unchecked banner equivalent'],
  I_POINTER_ELEMENT: ['if !element.secure {\n                    try fromCore', 'if activation && !element.secure {\n                    try fromCore'],
  I_POINTER_COORDINATE: ['}, checkCoordinate: { point in\n                let node', '}, checkCoordinate: { point in\n                guard activation else { return }\n                let node'],
  I_MODIFIERS: ['let mods = driverInteger(attrs[kAXMenuItemCmdModifiersAttribute]) ?? 0', 'let mods = driverInteger(attrs[kAXMenuItemCmdModifiersAttribute]) ?? 8'],
  I22: ['guard mods & 8 == 0 else { return }', 'guard mods == 0 else { return }'],
  I34: [String.raw`(?![\\p{L}\\p{N}])|コピー`, '|コピー'],
  I41_SET: ['try request.admitInput()\n                try access.set(fresh.node, kAXValueAttribute', '// MUTANT no setValue admission\n                try access.set(fresh.node, kAXValueAttribute'],
  I41_SELECT: ['try request.admitInput(); try access.set(fresh.node, kAXSelectedTextRangeAttribute', 'try access.set(fresh.node, kAXSelectedTextRangeAttribute'],
  I48_SHARE: ['inputState = request.inputState', 'inputState = InputAdmission(); inputState.clipboardWatch = request.inputState.clipboardWatch'],
  I48_CHECK: ['try inputState.clipboardWatch?.changed(admission) == true', 'false'],
  I48_STEP: ['"clipboardChanged": true, "step": step]', '"clipboardChanged": true, "step": step + 1]'],
};
let root, binary, source, parentState = createMacReadState, validateScan = validateMacDriverClipboardSource;
before(async () => {
  root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-cb1g-')));
  if (['M4', 'M5', 'M11'].includes(mutation)) {
    const name = mutation === 'M11' ? 'build.mjs' : 'diff.mjs';
    const url = new URL('../plugins/sleight/lib/mac-driver/' + name, import.meta.url);
    let text = await readFile(url, 'utf8');
    const seams = {
      M4: ['if (!row) return;', "if (!row || !/^(?:button|menu item|menu bar item|menu button|pop up button|toggle button)$/.test(row.role)) return;"],
      M5: ["if (method === 'performSecondaryAction') refuseClipboardWrite({ label: params.args?.[1] });", '// MUTANT unchecked secondary name'],
      M11: ["if (source.split(literal).length !== 2 || watch.split(literal).length !== 2) throw Error('DRIVER_CLIPBOARD_CAPABILITY');", '// MUTANT duplicated counter sites accepted'],
    };
    const [from, to] = seams[mutation]; assert.equal(text.split(from).length, 2); text = text.replace(from, to);
    if (mutation === 'M11') text = text.replace("source.replace(literal, '')", "source.replaceAll(literal, '').replaceAll('NSPasteboard.general.string', '')");
    text = text.replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
    const path = join(root, name); await writeFile(path, text);
    const imported = await import(new URL('file://' + path));
    if (mutation === 'M11') validateScan = imported.validateMacDriverClipboardSource;
    else parentState = imported.createMacReadState;
    return;
  }
  if (process.platform !== 'darwin') return;
  source = macDriverSource(); const at = source.lastIndexOf('\ndriverMain()'); assert.notEqual(at, -1);
  source = source.slice(0, at);
  if (mutation === 'I_COST_OLD') {
    // Rebuild the reviewed classifier from its patterns, retaining the original
    // String regex APIs. This variant changes only classification cost.
    for (const [from, to] of [
      ['let camel = clipboardReplace(clipboardCamel, title, "$1 $2")',
        'let camel = title.replacingOccurrences(of: clipboardCamel.pattern, with: "$1 $2", options: .regularExpression)'],
      ['let visible = clipboardReplace(clipboardIgnorable, folded, "")',
        'let visible = folded.replacingOccurrences(of: clipboardIgnorable.pattern, with: "", options: .regularExpression)'],
      ['let label = clipboardReplace(clipboardSpacing, visible, " ")',
        'let label = visible.replacingOccurrences(of: clipboardSpacing.pattern, with: " ", options: .regularExpression)'],
      ['clipboardWords.firstMatch(in: label, range: NSRange(location: 0, length: label.utf16.count)) != nil',
        'label.range(of: clipboardWords.pattern, options: .regularExpression) != nil'],
    ]) { assert.equal(source.split(from).length, 2); source = source.replace(from, to); }
  }
  if (mutation === 'M6') {
    for (const [from, to] of [
      ['let baseline: Int', 'var baseline: Int'],
      ['admission = Admission(current)', 'admission = Admission(Int.min)'],
      ['lastCount = current; lastActionEnded = now()', 'admission.baseline = current; lastCount = current; lastActionEnded = now()'],
    ]) { assert.equal(source.split(from).length, 2); source = source.replace(from, to); }
  }
  if (nativeMutations[mutation]) {
    const [from, to] = nativeMutations[mutation]; assert.ok(source.includes(from), mutation);
    source = mutation === 'M8' ? source.replaceAll(from, to) : source.replace(from, to);
  }
  source += '\n' + await readFile(new URL('./fixtures/mac-driver-clipboard-watch.swift', import.meta.url), 'utf8');
  const path = join(root, 'fixture.swift'); binary = join(root, 'fixture'); await writeFile(path, source);
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), path, '-o', binary],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 480000, maxBuffer: 65536 });
  assert.equal(compiled.status, 0, compiled.stderr);
  console.log(`CB1G binaryBytes=${(await stat(binary)).size} mutation=${mutation || 'none'}`);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const map = (keyCode, modifiers = [], safetyCharacters = []) => ({ keyCode, modifiers, safetyCharacters });
const us = { c: map(8), C: map(8, ['shift']), x: map(7), X: map(7, ['shift']), v: map(9), q: map(12),
  s: map(1), k: map(40), '3': map(20), '4': map(21), '5': map(23), '6': map(22), '9': map(25) };
const russian = { ...us, 'с': map(8), 'ч': map(7), 'й': map(12) };
const dvorak = { ...us, c: map(34), C: map(34, ['shift']), x: map(11), X: map(11, ['shift']), j: map(8) };
const fullwidth = { ...us, 'ｃ': map(8) };
const dqTranslations = { '8:0': 'j', '34:0': 'c', '8:256': 'c', '8:768': 'C' };
const runMany = values => {
  assert.ok(binary, 'native fixture unavailable');
  const result = spawnSync(binary, [], { input: values.map(JSON.stringify).join('\n') + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, values.length); for (const row of rows) assert.equal(row.fixtureError, undefined, JSON.stringify(row));
  return rows;
};
const run = value => runMany([value])[0];
const key = (chord, layout = us, extra = {}) => run({ chord, layout, ...extra }).replies.at(-1);
const refused = value => {
  assert.equal(value.ok, false, JSON.stringify(value)); assert.equal(value.error.code, 'ACTION_UNSUPPORTED');
  assert.equal(value.error.delivery, 'not-sent'); assert.equal(value.error.retry, 'safe');
  assert.equal(Array.isArray(value.events) ? value.events.length : value.events, 0); assert.notEqual(value.admitted, true);
};
const menu = (character = 'C', extra = {}) => ({ AXRole: 'AXMenuItem', AXTitle: 'Скопировать', AXMenuItemCmdChar: character,
  AXMenuItemCmdModifiers: 0, ...extra });
const binding = { windowId: '7', processStart: 'start', pid: 42, bundleId: 'test.fake', app: 'Editor', title: 'Draft', identityVerified: true };
// The real handle, wrapper and client parser surround the real native keyboard
// and runtime. Only the transport, layout, AX tree, event sink and count are fake.
function macHandleDriver(config) {
  const calls = [], replies = [];
  const driver = { async request(method, params) {
    calls.push({ method, params });
    if (['getApp', 'getAXState'].includes(method)) return { window: binding, readId: 1,
      text: 'Window: "Draft", App: Editor.\n0 standard window Draft', truncated: false };
    assert.equal(method, 'pressKey');
    const native = run({ ...config, integrated: true, calls: [{ method, args: params.args }] }).replies[0];
    replies.push(native);
    const parsed = await clipboardClientReply(native, { method });
    if (!parsed.ok) throw Object.assign(Error(parsed.error.message), parsed.error);
    return parsed.result;
  }, async restart() {}, async close() {} };
  return { driver, calls, replies };
}
async function macHandle(config) {
  const fixture = macHandleDriver(config);
  const cua = createCua({ platform: 'darwin', request: fixture.driver.request, write() {}, emitImage() {} });
  const app = await cua.getApp('Editor');
  assert.equal(cua.isHandle(app), true);
  return { ...fixture, app };
}

test('CB1Q wrapper stops Command+C even with a broken native planner', { skip: process.platform !== 'darwin' }, async () => {
  const planned = key('cmd+c');
  if (mutation === 'Q_PLANNER') {
    assert.equal(planned.ok, true); assert.equal(planned.admitted, true); assert.equal(planned.events.length, 4);
  } else refused(planned);
  const f = await macHandle({ layout: us });
  await assert.rejects(f.app.pressKey('cmd+c'), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
  assert.deepEqual(f.calls.map(call => call.method), ['getApp']);
  assert.equal(f.replies.length, 0, 'the wrapper must refuse before the native event sink');
});

for (const [name, layout, copy, copyCode, cut, cutCode] of [
  ['US', us, 'c', 8, 'x', 7], ['Dvorak', dvorak, 'c', 34, 'x', 11], ['Cyrillic', russian, 'с', 8, 'ч', 7],
]) {
  for (const [letter, code] of [[copy, copyCode], [cut, cutCode]]) for (const shift of [false, true]) {
    const chord = `ctrl+${shift ? 'shift+' : ''}${letter}`;
    test(`CB1P Mac handle ${name} ${chord} reaches the resolved native planner`, { skip: process.platform !== 'darwin' }, async () => {
      const f = await macHandle({ layout });
      const result = await f.app.pressKey(chord);
      assert.equal(result.delivery, 'sent-unverified');
      assert.deepEqual(f.calls.map(call => call.method), ['getApp', 'pressKey']);
      const native = f.replies[0];
      assert.equal(native.admitted, true); assert.equal(native.countReads, 2);
      assert.equal(native.events.length, shift ? 6 : 4);
      assert.deepEqual(native.events.filter(event => event.type === 'keyDown' || event.type === 'keyUp'), [
        { type: 'keyDown', keyCode: code, flags: shift ? 0x60000 : 0x40000 },
        { type: 'keyUp', keyCode: code, flags: shift ? 0x60000 : 0x40000 },
      ]);
    });
  }
  for (const prefix of ['cmd+', 'cmd+ctrl+', 'cmd+shift+']) {
    test(`CB1Q native planner ${name} ${prefix}Copy/Cut sends zero events`, { skip: process.platform !== 'darwin' }, async () => {
      const f = macHandleDriver({ layout });
      for (const letter of [copy, cut]) await assert.rejects(f.driver.request('pressKey', { args: [prefix + letter] }),
        { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
      assert.equal(f.replies.length, 2, 'both Copy and Cut must reach the native planner');
      for (const reply of f.replies) { assert.deepEqual(reply.events, []); assert.equal(reply.admitted, false); }
    });
  }
}
test('CB1P Mac handle uses physical codes and layout modifiers rather than chord text', { skip: process.platform !== 'darwin' }, async () => {
  const f = await macHandle({ layout: { ...us, k: map(8), c: map(8, ['alt']) } });
  await f.app.pressKey('ctrl+k');
  assert.equal(f.replies[0].admitted, true);
  for (const chord of ['ctrl+c', 'cmd+k']) await assert.rejects(f.app.pressKey(chord),
    { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
  assert.equal(f.replies.length, 3);
  for (const reply of f.replies.slice(1)) assert.deepEqual(reply.events, []);
});
test('CB1Q menu equivalence and title refusals independently stop input', { skip: process.platform !== 'darwin' }, async () => {
  for (const attrs of [
    { AXTitle: 'Transfer selection', AXMenuItemCmdChar: 'C', AXMenuItemCmdVirtualKey: 8, AXMenuItemCmdModifiers: 0 },
    { AXTitle: 'Transfer selection', AXMenuItemCmdChar: 'x', AXMenuItemCmdModifiers: 0 },
    { AXTitle: 'Transfer selection', AXMenuItemCmdVirtualKey: 7, AXMenuItemCmdModifiers: 0 },
    { AXTitle: 'Copy' },
  ]) {
    for (const op of ['pointer', 'semantic', 'local']) {
      const reply = integrated({ op, layout: us, attrs: { AXRole: 'AXMenuItem', ...attrs }, args: [1] });
      refused(reply); assert.equal(reply.countReads, 0, op + ' must refuse before admission');
    }
  }
  const neutral = integrated({ op: 'local', attrs: { AXRole: 'AXMenuItem', AXTitle: 'Transfer selection' } });
  assert.equal(neutral.ok, true); assert.equal(neutral.result.pressed, true);
  assert.equal(neutral.events, 1); assert.equal(neutral.countReads, 2);
});
test('CB1Q fallback title refuses Copy and Cut bound to Command+K', { skip: process.platform !== 'darwin' }, async () => {
  for (const AXTitle of ['Copy', 'Cut']) {
    const f = await macHandle({ layout: us, fallback: true,
      menu: { AXRole: 'AXMenuItem', AXTitle, AXMenuItemCmdChar: 'k', AXMenuItemCmdVirtualKey: 40, AXMenuItemCmdModifiers: 0 } });
    await assert.rejects(f.app.pressKey('cmd+k'), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
    assert.equal(f.replies.length, 1); assert.deepEqual(f.replies[0].events, []);
    assert.equal(f.replies[0].menuPresses, 0); assert.equal(f.replies[0].countReads, 0);
  }
});

test('CB1Q caught Control+C clipboard stop latches across cells and reset until the next turn',
  { skip: process.platform !== 'darwin' }, async t => {
  const nativeReplies = [];
  const h = await driverFixture('darwin', createDriverSafety, { async afterInput(method, params) {
    if (method !== 'pressKey') return;
    const native = run({ layout: us, integrated: true, writeOnPost: nativeReplies.length === 0, writtenCount: 11,
      calls: [{ method, args: params.args }] }).replies[0];
    nativeReplies.push(native);
    const parsed = await clipboardClientReply(native, { method });
    if (!parsed.ok) throw Object.assign(Error(parsed.error.message), parsed.error);
  } });
  const repl = createReplClient({ platform: 'darwin', driver: { async restart() {}, async close() {} },
    dispatch: (method, params, context) => h.safety.request(method, params, context),
    onReset: () => h.safety.reset(),
    environment: () => ({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) });
  t.after(async () => { await repl.close(); await h.safety.close(); });
  assert.equal((await repl.execute({ code: 'var app = await cua.getApp("Fixture");' })).isError, false);
  const result = await repl.execute({ code: `
    var stops = [];
    try { await app.pressKey('ctrl+c'); } catch (e) { stops.push(e.code); }
    try { await app.click(1); } catch (e) { stops.push(e.code); }
    try { await app.pressKey('s'); } catch (e) { stops.push(e.code); }
    try { await app.paste('fixture'); } catch (e) { stops.push(e.code); }
    await app.getAXState();
    nodeRepl.write(stops);
  ` });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.ok(result.content.some(item => item.type === 'text' && item.text === JSON.stringify(Array(4).fill('CLIPBOARD_CHANGED'))), text);
  assert.match(result.content[0].text,/1 pressKey.*sent-unverified[\s\S]*2 click.*refused CLIPBOARD_CHANGED[\s\S]*next=read-again/);
  assert.deepEqual(h.actions, [['pressKey', ['ctrl+c']]], 'catching the stop must deliver zero further inputs');
  assert.equal(nativeReplies.length, 1); assert.equal(nativeReplies[0].events.length, 4);
  assert.equal(nativeReplies[0].result.clipboardChanged, true); assert.equal(nativeReplies[0].countReads, 2);
  await repl.execute({ code: 'try { await app.pressKey("s"); } catch (e) { nodeRepl.write(e.code); }' });
  assert.equal(h.actions.length, 1, 'a later cell is still the same turn');
  await repl.reset();
  await repl.execute({ code: 'var app = await cua.getApp("Fixture"); try { await app.click(1); } catch (e) { nodeRepl.write(e.code); }' });
  assert.equal(h.actions.length, 1, 'js_reset cannot clear the clipboard stop');
  await h.safety.endTurn();
  const fresh = await repl.execute({ code: 'var app = await cua.getApp("Fixture"); await app.pressKey("s");' });
  assert.equal(fresh.isError, false, JSON.stringify(fresh));
  assert.deepEqual(h.actions, [['pressKey', ['ctrl+c']], ['pressKey', ['s']]]);
  assert.equal(nativeReplies.length, 2); assert.equal(nativeReplies[1].admitted, true);
});
test('CB1P wrapped Control+C count change stops the REPL cell before its next action', { skip: process.platform !== 'darwin' }, async t => {
  const f = macHandleDriver({ layout: us, writeOnPost: true, writtenCount: 11 });
  const repl = createReplClient({ platform: 'darwin', driver: f.driver, admit: async () => true,
    environment: () => ({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) });
  t.after(() => repl.close());
  const acquired = await repl.execute({ code: 'const app = await cua.getApp("Editor");' });
  assert.equal(acquired.isError, false);
  const result = await repl.execute({ code: 'await app.pressKey("ctrl+c"); await app.pressKey("s");' });
  assert.equal(result.isError, true);
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.match(text, /CLIPBOARD_CHANGED/); assert.match(text, /stop-tell-user/);
  assert.deepEqual(f.calls.filter(call => call.method === 'pressKey').map(call => call.params.args), [['ctrl+c']]);
  assert.equal(f.replies[0].admitted, true); assert.equal(f.replies[0].events.length, 4);
  assert.equal(f.replies[0].countReads, 2); assert.equal(f.replies[0].result.clipboardChanged, true);
});
function parent(body, method = 'click', args = [1]) {
  const text = `Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 ${body}`;
  const state = parentState(), snapshot = state.read({ window: binding, text, readId: 1, truncated: false });
  state.endCell([{ type: 'text', text }], [snapshot]);
  return () => state.assertCurrent(method, { ...binding, readId: 1, args }, 'cell');
}
const step = (do_, extra = {}) => ({ do: do_, ...extra });
const watch = (steps, extra = {}) => run({ op: 'watch', steps: steps.map(value => typeof value === 'string' ? step(value) : value), ...extra });
const integrated = config => run({ ...config, integrated: true });
const protocol = (steps, extra = {}) => run({ op: 'protocol', steps: steps.map(value => typeof value === 'string' ? step(value) : value), ...extra });
const detected = async (native, { delivery = 'sent-unverified', events = true, method = 'click' } = {}) => {
  assert.equal(native.result?.clipboardChanged ?? native.error?.clipboardChanged, true, JSON.stringify(native));
  const count = Array.isArray(native.events) ? native.events.length : native.events;
  assert.equal(events ? count > 0 : count === 0, true);
  const parent = await clipboardClientReply(native, { method });
  assert.equal(parent.ok, false, JSON.stringify(parent));
  assert.equal(parent.error.code, 'CLIPBOARD_CHANGED'); assert.equal(parent.error.next, 'stop-tell-user');
  assert.equal(parent.error.delivery, delivery); assert.equal(parent.error.retry, 'read-first');
  assert.match(parent.error.message, /during or since sleight's last action/);
  assert.match(parent.error.message, /did not write or read it and cannot restore it/);
  return parent.error;
};
const caseTest = (id, title, fn, { native = true } = {}) => test(`CB1G.${String(id).padStart(2, '0')} ${title}`,
  { skip: native && process.platform !== 'darwin', timeout: 600000 }, fn);

caseTest(1, 'US Copy has zero events', () => refused(key('cmd+c')));
caseTest(2, 'Russian physical Copy has zero events', () => refused(key('cmd+с', russian)));
caseTest(3, 'fullwidth key is refused or unmappable', () => {
  refused(key('cmd+ｃ', fullwidth)); const r = key('cmd+ｃ'); assert.equal(r.error.code, 'KEY_UNMAPPABLE'); assert.deepEqual(r.events, []);
});
caseTest(4, 'Dvorak-QWERTY Command j is physical Copy', () => {
  const layout = run({ op: 'translate', translations: dqTranslations }).layout; refused(key('cmd+j', layout));
});
caseTest(5, 'plain Dvorak c uses layout Copy code 34', () => refused(key('cmd+c', dvorak)));
caseTest(6, 'all extra modifiers keep Copy and Cut refused', () => {
  for (const chord of ['cmd+shift+c', 'cmd+alt+c', 'cmd+ctrl+alt+shift+x']) refused(key(chord));
});
caseTest(7, 'held Command stays held after the refused key', () => {
  const rows = run({ layout: us, calls: [{ method: 'modifiers', args: [{ keys: ['meta'], state: 'down' }] },
    { method: 'pressKey', args: ['c'] }, { method: 'pressKey', args: ['s'] }] }).replies;
  refused(rows[1]); assert.equal(rows[2].ok, true); assert.equal(rows[2].events[0].flags, 0x100000);
});
caseTest(8, 'held Command prevents text', () => {
  const r = run({ layout: us, calls: [{ method: 'modifiers', args: [{ keys: ['meta'], state: 'down' }] },
    { method: 'typeText', args: ['c'] }] }).replies.at(-1);
  assert.equal(r.error.code, 'MODIFIERS_HELD'); assert.deepEqual(r.events, []);
});
caseTest(9, 'person holding Command prevents text', () => {
  const r = run({ layout: us, personModifiers: 0x100000, calls: [{ method: 'typeText', args: ['c'] }] }).replies[0];
  assert.equal(r.error.code, 'PERSON_HOLDS_MODIFIER'); assert.deepEqual(r.events, []);
});
caseTest(10, 'key-events ladder cannot bypass physical Copy', () => refused(key('cmd+c', us, { strategy: 'key-events' })));
caseTest(11, 'CB1M Control+C changing the fake count reports once', async () => {
  const rows = run({ integrated: true, writeOnPost: true, writtenCount: 11, layout: us, calls: [
    { method: 'pressKey', args: ['ctrl+c'] }, { method: 'pressKey', args: ['ctrl+c'] },
  ] }).replies;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].admitted, true); assert.equal(rows[0].countReads, 2);
  const error = await detected(rows[0], { method: 'pressKey' });
  assert.equal(error.delivery, 'sent-unverified');
  assert.equal(rows[1].ok, true, JSON.stringify(rows[1]));
  assert.equal(rows[1].admitted, true); assert.equal(rows[1].countReads, 4);
  assert.equal(rows[1].result.clipboardChanged, undefined); assert.equal(rows[1].events.length, 4);
  assert.equal((await clipboardClientReply(rows[1], { method: 'pressKey' })).ok, true);
  assert.equal(rows.filter(row => row.result?.clipboardChanged || row.error?.clipboardChanged).length, 1);
});
caseTest(12, 'strict clipboard Paste chord remains refused', () => refused(key('cmd+v')));
caseTest(13, 'default screenshot chords refuse; remapped writes stop the turn', async () => {
  for (const chord of ['cmd+ctrl+shift+4', 'cmd+shift+3', 'cmd+shift+5', 'cmd+shift+6']) refused(key(chord));
  await detected(key('cmd+shift+9', us, { integrated: true, writeOnPost: true }));
});
caseTest(14, 'Insert aliases stay outside the grammar', () => {
  for (const chord of ['cmd+Insert', 'shift+Insert']) { const r = key(chord); assert.equal(r.error.code, 'INVALID_PARAMS'); assert.deepEqual(r.events, []); }
});
caseTest(15, 'a layout swap never changes checked posted codes; a write is detected', async () => {
  refused(key('cmd+c', dvorak)); assert.deepEqual(clipboardKeyCodes(new Map(Object.entries(dvorak))), new Set([8, 7, 34, 11]));
  const r = key('s', us, { integrated: true, writeOnPost: true, swapLayout: { s: map(8) } });
  assert.equal(r.layoutReads, 1); assert.equal(r.events[0].keyCode, 1); await detected(r);
});
caseTest(16, 'Russian physical Quit is refused', () => refused(key('cmd+й', russian)));
caseTest(17, 'localized Edit Copy refuses on native element paths', () => {
  refused(run({ op: 'pointer', attrs: menu(), args: [1] })); refused(run({ op: 'semantic', attrs: menu() }));
});
caseTest(18, 'context menu Copy uses the same attributes', () => {
  assert.equal(run({ op: 'pointer', method: 'rightClick', attrs: { AXRole: 'AXButton', AXTitle: 'Copy' }, args: [1] }).ok, true);
  refused(run({ op: 'pointer', attrs: menu(), args: [1] }));
});
caseTest(19, 'Copy Link refuses; an unknown label write stops the turn', async () => {
  refused(run({ op: 'menu', attrs: menu('', { AXTitle: 'Copy Link', AXMenuItemCmdModifiers: 8 }) }));
  refused(run({ op: 'menu', attrs: menu('', { AXTitle: 'Link kopiëren', AXMenuItemCmdModifiers: 8 }) }));
  await detected(integrated({ op: 'pointer', args: [1], attrs: menu('', { AXTitle: 'Kopieer link', AXMenuItemCmdModifiers: 8 }), writeOnPost: true }));
});
caseTest(20, 'Cut uses the command equivalent', () => refused(run({ op: 'menu', attrs: menu('X') })));
caseTest(21, 'menu Paste remains available', () => assert.equal(run({ op: 'menu', attrs: menu('V', { AXMenuItemCmdVirtualKey: 9, AXTitle: 'Paste' }) }).ok, true));
caseTest(22, 'Option and Shift equivalents refuse under neutral titles', () => {
  for (const [AXMenuItemCmdModifiers, AXTitle] of [[2, 'Neutral'], [1, 'Computer']]) refused(run({ op: 'menu', attrs: menu('C', { AXMenuItemCmdModifiers, AXTitle }) }));
});
caseTest(23, 'local AXPress checks attributes and titles; unlabelled writes stop the turn', async () => {
  refused(integrated({ op: 'local', attrs: menu() }));
  refused(integrated({ op: 'local', attrs: menu('', { AXTitle: 'Copy', AXMenuItemCmdModifiers: 8 }) }));
  await detected(integrated({ op: 'local', attrs: menu('', { AXTitle: '', AXMenuItemCmdModifiers: 8 }), writeOnPost: true }));
});
caseTest(24, 'local Copy IP refuses; unknown write stops the turn', async () => {
  refused(integrated({ op: 'local', attrs: { AXRole: 'AXButton', AXTitle: 'Copy IP' } }));
  await detected(integrated({ op: 'local', attrs: { AXRole: 'AXButton', AXTitle: 'Kopieer IP' }, writeOnPost: true }));
});
caseTest(25, 'Edit menu is outside the status-menu tool', () => {
  const r = run({ op: 'menuRoute', attrs: { AXRole: 'AXApplication', AXChildren: [{ AXRole: 'AXMenuBar', AXChildren: [{ AXRole: 'AXMenuBarItem', AXTitle: 'Edit' }] }] } });
  assert.equal(r.ok, false); assert.match(r.errorText, /has no status item/); assert.equal(r.events, 0);
});
caseTest(26, 'Services Copy refuses; private-board service stays normal; general-board write stops', async () => {
  refused(run({ op: 'menu', attrs: menu('', { AXTitle: 'Copy …', AXMenuItemCmdModifiers: 8 }) }));
  const attrs = menu('', { AXTitle: 'サービス', AXMenuItemCmdModifiers: 8 });
  const normal = integrated({ op: 'local', attrs });
  assert.equal(normal.ok, true); assert.equal(normal.result.clipboardChanged, undefined); assert.equal(normal.countReads, 2);
  await detected(integrated({ op: 'local', attrs, writeOnPost: true }));
});
caseTest(27, 'RT5 English custom Copy refuses; unknown fallback writes stop the turn', async () => {
  const menu = { AXTitle: 'Copy Link', AXMenuItemCmdChar: 'K', AXMenuItemCmdVirtualKey: 40, AXMenuItemCmdModifiers: 1 };
  refused(key('cmd+shift+k', us, { fallback: true, menu }));
  const r = key('cmd+shift+k', us, { integrated: true, writeOnPost: true, fallback: true, menu: { ...menu, AXTitle: 'Kopieer link' } });
  assert.equal(r.menuPresses, 1); assert.equal(r.result.menuFallbackCount, 1);
  const error = await detected(r, { events: false }); assert.equal(error.menuFallbackCount, 1);
});
caseTest(28, 'RT5 final attribute equality precedes the press', () => {
  const menu = { AXTitle: 'Neutral', AXMenuItemCmdChar: 'K', AXMenuItemCmdVirtualKey: 40, AXMenuItemCmdModifiers: 1 };
  for (const menuAtPress of [{ ...menu, AXTitle: 'Retitled' }, { ...menu, AXMenuItemCmdChar: 'S' }]) {
    const r = key('cmd+shift+k', us, { fallback: true, menu, menuAtPress });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'STALE_ELEMENT'); assert.equal(r.menuPresses, 0); assert.deepEqual(r.events, []);
  }
});
caseTest(29, 'secondary Copy name refuses on a neutral Share row', () => assert.throws(parent('button Share, Secondary Actions: Copy', 'performSecondaryAction', [1, 'Copy']), { code: 'ACTION_UNSUPPORTED' }), { native: false });
caseTest(30, 'camel-case and spaced secondary Copy names refuse', () => {
  for (const action of ['CopyLink', 'Copy Link']) assert.throws(parent('button Share', 'performSecondaryAction', [1, action]), { code: 'ACTION_UNSUPPORTED' });
}, { native: false });
caseTest(31, 'every target role participates in the advisory table', () => {
  for (const role of ['link', 'row', 'cell', 'image', 'checkbox', 'container']) assert.throws(parent(role + ' Copy link'), { code: 'ACTION_UNSUPPORTED' });
}, { native: false });
caseTest(32, 'empty toolbar title still checks Description', () => assert.throws(parent('button, Description: Copy to clipboard'), { code: 'ACTION_UNSUPPORTED' }), { native: false });
caseTest(33, 'unknown web label write stops the turn', async () => {
  assert.doesNotThrow(parent('button Kopieer'));
  await detected(integrated({ op: 'pointer', args: [1], attrs: { AXRole: 'AXButton', AXTitle: 'Kopieer' }, writeOnPost: true }));
});
caseTest(34, 'Copyright and Copywriter retain word boundaries', () => {
  for (const [role, title] of [['link', 'Copyright 2026'], ['cell', 'Copywriter']]) {
    assert.doesNotThrow(parent(`${role} ${title}`));
    const r = run({ op: 'pointer', args: [1], attrs: { AXRole: role === 'link' ? 'AXLink' : 'AXCell', AXTitle: title } });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.events > 0);
  }
});
caseTest(35, 'unrepresentable label fails closed', () => assert.throws(parent('button \ud800'), { code: 'ACTION_UNSUPPORTED' }), { native: false });
caseTest(36, 'selectors refuse full clipboard labels before selector matching', () => {
  assert.throws(parent('button Copy', 'click', [{ label: 'Copy' }]), { code: 'ACTION_UNSUPPORTED' });
  // INT22E restores the full-label clipboard refusal before UC2D selector matching.
  assert.throws(parent('button Share, Foo: Copy', 'click', [{ label: 'Share, Foo: Copy' }]),
    { code: 'ACTION_UNSUPPORTED' });
}, { native: false });
caseTest(37, 'password Copy labels refuse; unknown Russian write stops the turn', async () => {
  for (const label of ['Copy password', 'Kennwort kopieren', '复制密码']) assert.throws(parent('button ' + label), { code: 'ACTION_UNSUPPORTED' });
  await detected(integrated({ op: 'pointer', args: [1], attrs: { AXRole: 'AXButton', AXTitle: 'Копировать пароль' }, writeOnPost: true }));
});
caseTest(38, 'coordinate hit-test checks both command equivalent and button title', () => {
  for (const attrs of [menu(), { AXRole: 'AXButton', AXTitle: 'Copy' }]) refused(run({ op: 'pointer', attrs }));
});
caseTest(39, 'right-click opens while double-click refuses Copy', () => {
  const attrs = { AXRole: 'AXButton', AXTitle: 'Copy' };
  assert.equal(run({ op: 'pointer', method: 'rightClick', attrs }).ok, true);
  refused(run({ op: 'pointer', method: 'doubleClick', attrs }));
});
caseTest(40, 'drag general-board writes stop; ordinary drag leaves the count alone', async () => {
  const normal = integrated({ op: 'pointer', method: 'drag', args: [[20, 20], [30, 30]] });
  assert.equal(normal.ok, true); assert.equal(normal.result.clipboardChanged, undefined); assert.equal(normal.countReads, 2);
  await detected(integrated({ op: 'pointer', method: 'drag', args: [[20, 20], [30, 30]], writeOnPost: true }));
});
caseTest(41, 'input uses two count reads and reads use zero; content capabilities never compile', () => {
  const source = macDriverSource(); assert.doesNotThrow(() => validateScan(source));
  for (const text of ['NSPasteboard.general.string', 'NSPasteboard.general.changeCount']) assert.throws(() => validateScan(source + '\n' + text));
  for (const method of ['setValue', 'selectText', 'paste']) {
    const r = integrated({ op: 'semantic', method });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.events, 1);
    assert.equal(r.countReads, 2); assert.equal(r.readCountReads, 0); assert.equal(r.readReply.ok, true);
    refused(integrated({ op: 'semantic', method, throwAt: 1 }));
  }
});
caseTest(42, 'each late change refuses once, then admits the next action', async () => {
  const a = protocol(['action', 'write', 'action', 'action', 'write', 'action']).replies;
  await detected(a[1], { delivery: 'not-sent', events: false });
  assert.equal(a[2].ok, true, JSON.stringify(a[2])); assert.equal(a[2].events, 1);
  assert.equal(a[2].result.clipboardChanged, undefined); assert.equal(a[2].countReads, 2);
  await detected(a[3], { delivery: 'not-sent', events: false });
  const b = protocol(['action', 'write', 'person', 'action']).replies;
  assert.equal(b[1].ok, true); assert.equal(b[1].result.clipboardChanged, undefined); assert.equal(b[1].events, 1);
});
caseTest(43, 'person copying during an action stops without attributing the writer', async () => {
  await detected(protocol([step('action', { writeAtStep: 1, person: true })]).replies[0]);
  await detected(protocol([step('action', { writeAtStep: 1, person: true, fail: true })]).replies[0], { delivery: 'unknown' });
});
caseTest(44, 'Universal Clipboard arriving during an action stops the turn', async () => {
  await detected(protocol([step('action', { writeAtStep: 1 })]).replies[0]);
});
caseTest(45, 'helper restart forgets the previous count without claiming a late write', () => {
  const r = protocol(['action', 'write', 'restart', 'action']).replies[1];
  assert.equal(r.ok, true); assert.equal(r.result.clipboardChanged, undefined); assert.equal(r.events, 1);
});
caseTest(46, 'a failed count read refuses every input transport before any post', () => {
  for (const config of [{ op: 'pointer' }, { op: 'local' }, { op: 'semantic', attrs: { AXRole: 'AXButton', AXTitle: 'Neutral', actions: ['AXActivate'] } },
    { op: 'key', chord: 's', layout: us }]) {
    const value = integrated({ ...config, throwAt: 1 }); const r = value.replies?.[0] ?? value;
    refused(r); assert.equal(r.error.clipboard, 'untouched'); assert.equal(r.countReads, 1);
  }
  const r = protocol([step('action', { method: 'paste' })], { throwAt: 1 }).replies[0];
  refused(r); assert.equal(r.error.clipboard, 'untouched');
});
caseTest(47, 'a server count decrease is still a change', async () => {
  await detected(protocol([step('action', { writeAtStep: 1, count: 0 })]).replies[0]);
});
caseTest(48, 'disabled compound seam runs real semantic writes and stops before step 3 naming step 2', async () => {
  const r = protocol([step('compound', { writeAtStep: 2 })]).replies[0];
  assert.equal(r.events, 2); assert.equal(r.error.step, 2); assert.equal(r.countReads, 4); await detected(r);
  const normal = protocol(['compound']).replies[0];
  assert.equal(normal.ok, true); assert.equal(normal.events, 3); assert.equal(normal.countReads, 5);
  assert.equal(normal.result.clipboardChanged, undefined);
});
caseTest(49, 'session B stops on a shared count changed since its own last action', async () => {
  const r = protocol([step('action', { session: 'B' }), step('action', { writeAtStep: 1 }), step('action', { session: 'B' })]);
  await detected(r.replies[2], { delivery: 'not-sent', events: false });
});

caseTest(50, 'notification action labels refuse Copy and Cut before a custom press', () => {
  for (const label of ['Copy Code', 'Cut', 'CopyLink', '复制密码']) {
    refused(integrated({ op: 'notification', label }));
  }
  const normal = integrated({ op: 'notification', label: 'Close' });
  assert.equal(normal.ok, true); assert.equal(normal.events, 1); assert.equal(normal.countReads, 2);
});
caseTest(51, 'notification node titles and descriptions refuse before a custom press', () => {
  for (const name of ['AXTitle', 'AXDescription']) {
    refused(integrated({ op: 'notification', attrs: { AXRole: 'AXButton', [name]: 'Copy Code' } }));
  }
});
caseTest(52, 'notification key equivalents refuse with a neutral label on any role', () => {
  for (const attrs of [{ AXMenuItemCmdChar: 'C' }, { AXMenuItemCmdChar: 'X' }, { AXMenuItemCmdVirtualKey: 8 }, { AXMenuItemCmdVirtualKey: 7 }]) {
    refused(integrated({ op: 'notification', attrs: { AXRole: 'AXGroup', AXTitle: 'Neutral', AXMenuItemCmdModifiers: 0, ...attrs } }));
  }
});
caseTest(53, 'right and middle menu clicks check equivalents before every event', () => {
  for (const args of [[1], [[20, 20]]]) for (const method of ['rightClick', 'click']) {
    const targets = method === 'click' ? [...args, { mouseButton: 'middle' }] : args;
    refused(integrated({ op: 'pointer', method, attrs: menu(), args: targets }));
  }
  // The table still permits a right-click on a Copy button to open its menu.
  assert.equal(integrated({ op: 'pointer', method: 'rightClick', attrs: { AXRole: 'AXButton', AXTitle: 'Copy' } }).ok, true);
});
caseTest(54, 'drag destination menu equivalents refuse before the first pointer event', () => {
  const neutral = { AXRole: 'AXButton', AXTitle: 'Neutral' };
  refused(integrated({ op: 'pointer', method: 'drag', args: [[20, 20], [30, 30]], attrs: neutral, endAttrs: menu() }));
  refused(integrated({ op: 'pointer', method: 'drag', args: [[20, 20], 1], attrs: menu(), startAttrs: neutral }));
  const r = integrated({ op: 'pointer', method: 'drag', args: [[20, 20], [30, 30]], attrs: neutral,
    endAttrs: { AXRole: 'AXButton', AXTitle: 'Copy' } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.events > 0);
});
caseTest(55, 'missing or unreadable menu modifiers assume Command', () => {
  for (const AXMenuItemCmdModifiers of [undefined, null, 'unreadable', true, 0.5]) {
    for (const equivalent of [{ AXMenuItemCmdChar: 'C' }, { AXMenuItemCmdChar: 'X' }, { AXMenuItemCmdChar: '', AXMenuItemCmdVirtualKey: 8 }]) {
      refused(run({ op: 'menu', attrs: menu('', { AXTitle: 'Neutral', AXMenuItemCmdModifiers, ...equivalent }) }));
    }
  }
  assert.equal(run({ op: 'menu', attrs: menu('C', { AXTitle: 'Neutral', AXMenuItemCmdModifiers: 8 }) }).ok, true);
  for (const op of ['pointer', 'semantic', 'local', 'notification']) {
    const r = integrated({ op, attrs: menu('C', { AXTitle: 'Neutral', AXMenuItemCmdModifiers: null, actions: ['AXActivate'] }) });
    refused(r); assert.equal(r.error.clipboard, 'untouched'); assert.equal(r.countReads, 0);
  }
});
caseTest(56, 'label classification keeps the pre-cache corpus verdicts', () => {
  const words = ['copy', 'cut', 'copiar', 'cortar', 'copier', 'couper', 'kopieren', 'ausschneiden', 'recortar',
    'copia', 'copiare', 'taglia', 'tagliare', 'コピー', '切り取り', '切取', '复制', '複製', '拷贝', '拷貝', '剪切', '剪下', '복사', '잘라내기',
    'Copyright', 'Copywriter', 'Kopieer', 'Скопировать', 'Paste', 'Computer', 'Close', '', 'aCopy', 'myCopy', 'CopyLink', 'cutlery'];
  const labels = words.flatMap(word => [word, word.toUpperCase(), `pre ${word} post`, `pre_${word}_post`, `pre-${word}-post`,
    `pre\u2212${word}\u00a0post`, `9${word}9`, `A${word}Z`, `${word}\u200b`, `😀${word}😀`]);
  const verdicts = run({ op: 'labels', labels }).refused;
  assert.equal(verdicts.length, 360);
  const digest = createHash('sha256').update(JSON.stringify(verdicts)).digest('hex');
  assert.equal(digest, '1b45ea6b9696dd2bacc72c9f42c05cdd88c3a0e67aa2f5c9ae95e434637fe31c');
  console.log(`CB1I labelComparisons=${labels.length} verdictSha256=${digest}`);
});

for (const [action, method, makeArgs] of [
  ['right-click', 'rightClick', target => [target]],
  ['middle click', 'click', target => [target, { mouseButton: 'middle' }]],
  ['drag start', 'drag', target => [target, [40, 40]]],
  ['drag end', 'drag', target => [[10, 10], target]],
]) {
  test(`CB1J ${action} refuses Copy and Cut menu labels without equivalents before any event`,
    { skip: process.platform !== 'darwin' }, () => {
      for (const AXTitle of ['Copy', 'Cut']) for (const target of [1, action === 'drag end' ? [30, 30] : [20, 20]]) {
        const attrs = { AXRole: 'AXMenuItem', AXTitle };
        const neutral = { AXRole: 'AXButton', AXTitle: 'Neutral' };
        const extra = action === 'drag start' ? { endAttrs: neutral }
          : action === 'drag end' ? { startAttrs: neutral } : {};
        const reply = integrated({ op: 'pointer', method, attrs, args: makeArgs(target), ...extra });
        console.log(`CB1J ${action} label=${AXTitle} target=${JSON.stringify(target)} ok=${reply.ok} events=${reply.events}`);
        refused(reply);
        assert.equal(reply.countReads, 0);
      }
    });
}

test('watch component: baseline then compare uses exactly two reads', { skip: process.platform !== 'darwin' }, () => {
  const r = watch(['admit', 'admit', 'finish']); assert.equal(r.reads, 2); assert.deepEqual(r.changes, [false]); assert.deepEqual(r.faults, []);
});
test('watch component: case 42 late write refuses, person input resets baseline', { skip: process.platform !== 'darwin' }, () => {
  const a = watch(['admit', 'finish', 'write', 'admit']); assert.equal(a.faults.length, 1); assert.equal(a.faults[0].code, 'CLIPBOARD_CHANGED'); assert.equal(a.faults[0].delivery, 'not-sent');
  const b = watch(['admit', 'finish', 'write', 'person', 'admit', 'finish']); assert.deepEqual(b.faults, []); assert.deepEqual(b.changes, [false, false]);
});
test('watch component: cases 19, 43 and 44 report a changed count without attributing the writer', { skip: process.platform !== 'darwin' }, () => {
  for (const steps of [['admit', 'write', 'finish'], ['admit', 'write', 'person', 'finish']]) {
    const r = watch(steps); assert.deepEqual(r.changes, [true]); assert.deepEqual(r.faults, []);
  }
});
test('watch component: case 45 restart loses its old comparison', { skip: process.platform !== 'darwin' }, () => {
  const r = watch(['admit', 'finish', 'write', 'restart', 'admit', 'finish']); assert.deepEqual(r.faults, []); assert.deepEqual(r.changes, [false, false]);
});
test('watch component: case 46 thrown baseline read refuses safely', { skip: process.platform !== 'darwin' }, () => {
  const r = watch(['admit'], { throwAt: 1 }); assert.equal(r.faults[0].delivery, 'not-sent'); assert.equal(r.faults[0].retry, 'safe');
});
test('watch component: case 47 count decrease is a change', { skip: process.platform !== 'darwin' }, () => {
  assert.deepEqual(watch(['admit', step('write', { count: 0 }), 'finish']).changes, [true]);
});
test('watch component: case 48 stops the compound before its next step', { skip: process.platform !== 'darwin' }, () => {
  const r = watch(['admit', 'step', 'write', 'step', 'step']); assert.deepEqual(r.changes, [false, true]); assert.equal(r.trace.at(-1), 'stop-before-next-step');
});
test('watch component: case 49 B detects A write since its own last action', { skip: process.platform !== 'darwin' }, () => {
  const r = watch([step('admit', { session: 'B' }), step('finish', { session: 'B' }), 'admit', 'write', 'finish', step('admit', { session: 'B' })]);
  assert.equal(r.faults[0].code, 'CLIPBOARD_CHANGED'); assert.equal(r.faults[0].reason, 'since-last-action');
});
test('RT32 native completion carries changed-count evidence', { skip: process.platform !== 'darwin' }, () => {
  const r = run({ op: 'event' }); assert.equal(r.records.length, 2);
  assert.equal(r.records[1].outcome.clipboardChanged, true);
  assert.equal(r.records[1].outcome.delivery, 'sent-unverified');
});
test('a failed first count read stays failed across fallback and copied requests', { skip: process.platform !== 'darwin' }, () => {
  for (const setting of ['swallow', 'swallowReturn']) {
    const r = protocol([step('action', { [setting]: true })], { throwAt: 1 });
    refused(r.replies[0]); assert.equal(r.countReads, 1); assert.equal(r.events, 0);
  }
});
test('a count-read refusal sends no cleanup and preserves already held modifiers', { skip: process.platform !== 'darwin' }, () => {
  const rows = run({ integrated: true, throwAt: 3, layout: us, calls: [
    { method: 'modifiers', args: [{ keys: ['meta'], state: 'down' }] },
    { method: 'pressKey', args: ['s'] }, { method: 'pressKey', args: ['s'] },
  ] }).replies;
  refused(rows[1]); assert.equal(rows[2].ok, true); assert.equal(rows[2].events[0].flags, 0x100000);
});
test('a late-write refusal reaches the keyboard transport without any post', { skip: process.platform !== 'darwin' }, async () => {
  const r = run({ integrated: true, writeBetweenCalls: true, layout: us, calls: [
    { method: 'pressKey', args: ['s'] }, { method: 'pressKey', args: ['s'] },
  ] }).replies[1];
  await detected(r, { events: false, delivery: 'not-sent' });
});
test('a failed reply count read preserves unknown delivery and the next action is not replayed', { skip: process.platform !== 'darwin' }, async () => {
  const r = protocol(['action'], { throwAt: 2 }).replies[0];
  assert.equal(r.ok, false); assert.equal(r.events, 1); assert.equal(r.error.delivery, 'unknown');
  assert.equal(r.error.retry, 'read-first'); assert.equal(r.countReads, 2);
  const parent = await clipboardClientReply(r); assert.equal(parent.error.code, 'ACTION_UNSUPPORTED');
});
test('the real runtime watchdog stays armed while the reply count provider is blocked', { skip: process.platform !== 'darwin' }, () => {
  const request = { protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64), id: 1, method: 'click',
    params: { windowId: '7', processStart: 'start', readId: 1, args: [1] }, deadline: Date.now() + 300 };
  const r = spawnSync(binary, ['--watchdog'], { input: JSON.stringify(request) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 70, r.stderr);
  const reply = JSON.parse(r.stdout); assert.equal(reply.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(reply.error.delivery, 'unknown'); assert.equal(reply.error.retry, 'read-first');
});
test('independent layer witnesses for M2 and M3', { skip: process.platform !== 'darwin' }, () => {
  refused(key('cmd+j', dvorak)); // Fixed code 8 even though c is at 34.
  const layout = run({ op: 'translate', translations: { '43:0': 'j', '34:0': 'c', '43:256': 'c' } }).layout;
  refused(key('cmd+j', layout)); // Command-only c away from the fixed codes.
});
for (const [name, layout, copy, copyCode, cut, cutCode] of [
  ['US', us, 'c', 8, 'x', 7], ['Dvorak', dvorak, 'c', 34, 'x', 11], ['Cyrillic', russian, 'с', 8, 'ч', 7],
]) {
  for (const [letter, code] of [[copy, copyCode], [cut, cutCode]]) for (const shift of [false, true]) {
    const chord = `ctrl+${shift ? 'shift+' : ''}${letter}`;
    test(`CB1M native ${name} ${chord} posts with count detection armed`, { skip: process.platform !== 'darwin' }, () => {
      const reply = key(chord, layout, { integrated: true });
      assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(reply.admitted, true);
      assert.equal(reply.countReads, 2); assert.equal(reply.result.clipboardChanged, undefined);
      assert.equal(reply.result.delivery, 'sent-unverified');
      assert.deepEqual(reply.events, shift ? [
        { type: 'flagsChanged', keyCode: 59, flags: 0x40000 }, { type: 'flagsChanged', keyCode: 56, flags: 0x60000 },
        { type: 'keyDown', keyCode: code, flags: 0x60000 }, { type: 'keyUp', keyCode: code, flags: 0x60000 },
        { type: 'flagsChanged', keyCode: 56, flags: 0x40000 }, { type: 'flagsChanged', keyCode: 59, flags: 0 },
      ] : [
        { type: 'flagsChanged', keyCode: 59, flags: 0x40000 }, { type: 'keyDown', keyCode: code, flags: 0x40000 },
        { type: 'keyUp', keyCode: code, flags: 0x40000 }, { type: 'flagsChanged', keyCode: 59, flags: 0 },
      ]);
    });
  }
  for (const prefix of ['cmd+', 'cmd+ctrl+', 'cmd+shift+', 'cmd+ctrl+alt+shift+', 'ctrl+alt+']) {
    test(`CB1M native ${name} ${prefix}Copy/Cut remains refused`, { skip: process.platform !== 'darwin' }, () => {
      for (const letter of [copy, cut]) {
        const reply = key(prefix + letter, layout, { integrated: true });
        refused(reply); assert.equal(reply.countReads, 0);
      }
    });
  }
  test(`CB1M native ${name} held Control posts, held Command refuses`, { skip: process.platform !== 'darwin' }, () => {
    for (const strategy of ['flags-changed', 'flags-only', 'key-events']) for (const [letter, code] of [[copy, copyCode], [cut, cutCode]]) {
      const rows = run({ integrated: true, layout, strategy, calls: [
        { method: 'modifiers', args: [{ keys: ['control'], state: 'down' }] },
        { method: 'pressKey', args: [letter] },
        { method: 'modifiers', args: [{ keys: ['meta'], state: 'down' }] },
        { method: 'pressKey', args: [letter] },
      ] }).replies;
      refused(rows[3]);
      assert.equal(rows[1].ok, true, JSON.stringify(rows[1]));
      assert.deepEqual(rows[1].events, [{ type: 'keyDown', keyCode: code, flags: 0x40000 },
        { type: 'keyUp', keyCode: code, flags: 0x40000 }]);
      assert.equal(rows[1].countReads, 4); assert.equal(rows[3].countReads, 6);
    }
  });
  test(`CB1M native ${name} Control Paste remains refused`, { skip: process.platform !== 'darwin' }, () => {
    const reply = key('ctrl+v', layout, { integrated: true }); refused(reply); assert.equal(reply.countReads, 0);
  });
}

test('Swift and JS verdicts agree on all fixture layouts, strategies and held modifiers', { skip: process.platform !== 'darwin' }, () => {
  const dq = run({ op: 'translate', translations: dqTranslations }).layout;
  const layouts = [us, russian, dvorak, dq, fullwidth];
  const chords = ['cmd+c', 'cmd+с', 'cmd+ｃ', 'cmd+j', 'cmd+x', 'cmd+shift+c', 'cmd+alt+c', 'cmd+ctrl+alt+shift+x',
    'ctrl+c', 'ctrl+x', 'ctrl+shift+c', 'ctrl+shift+x', 'ctrl+с', 'ctrl+ч', 'ctrl+shift+с', 'ctrl+shift+ч',
    'cmd+ctrl+c', 'cmd+ctrl+x', 'cmd+ctrl+с', 'cmd+ctrl+ч', 'cmd+shift+с', 'cmd+shift+ч', 'cmd+shift+x',
    'ctrl+alt+c', 'ctrl+alt+x', 'ctrl+v', 'cmd+v', 'cmd+ctrl+shift+4', 'cmd+shift+3', 'cmd+shift+5', 'cmd+shift+6', 'cmd+shift+9',
    'cmd+Insert', 'shift+Insert', 'cmd+й', 'cmd+q', 'cmd+alt+Escape', 'c', 's'];
  const requests = [], expected = [];
  for (const layout of layouts) for (const strategy of ['flags-changed', 'flags-only', 'key-events']) for (const held of [[], ['meta'], ['control'], ['control', 'shift'], ['control', 'meta']]) for (const chord of chords) {
    const calls = [...held.length ? [{ method: 'modifiers', args: [{ keys: held, state: 'down' }] }] : [], { method: 'pressKey', args: [chord] }];
    requests.push({ layout, strategy, calls });
    try { expected.push({ ok: true, events: keyPlan(chord, new Map(Object.entries(layout)), { strategy, held }) }); }
    catch (error) { expected.push({ ok: false, code: error.code }); }
  }
  const rows = runMany(requests);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].replies.at(-1), oracle = expected[i];
    assert.equal(row.ok, oracle.ok, JSON.stringify({ request: requests[i], row, oracle }));
    if (oracle.ok) assert.deepEqual(row.events, oracle.events);
    else { assert.equal(row.error.code, oracle.code); assert.deepEqual(row.events, []); }
  }
  console.log(`CB1G differentialComparisons=${rows.length}`);
});
test('scan witness: a general-board content accessor is rejected', () => {
  assert.throws(() => validateScan(macDriverSource() + '\nNSPasteboard.general.string'));
});
test('a post-action label change cannot turn delivered semantic input into a safe refusal', { skip: process.platform !== 'darwin' }, () => {
  const r = run({ op: 'semantic', attrs: { AXRole: 'AXButton', AXTitle: 'Neutral', actions: ['AXActivate'] }, afterTitle: 'Copy' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.events, 1); assert.equal(r.result.delivery, 'sent-unverified');
});
test('scan witness: a second general-board count site is rejected', () => {
  assert.throws(() => validateScan(macDriverSource() + '\nNSPasteboard.general.changeCount'));
});
test('fake cost of the count reads, attribute batch, hit test and combined guard', { skip: process.platform !== 'darwin' }, () => {
  const cost = run({ op: 'cost', layout: us });
  assert.equal(cost.countReads, 200000); assert.equal(cost.attributeReads, 100000); assert.equal(cost.hitTests, 100000);
  assert.equal(cost.integratedCountReads, 100000);
  console.log('CB1G fakeCost=' + JSON.stringify(cost));
});
