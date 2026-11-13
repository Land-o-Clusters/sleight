import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';

const mutations = {
  route: ['if let menu = try semantics.tryMenuPress(request, core: core) { return menu }', ''],
  identity: ['driverCoordinateIdentity(attrs) == retained.coordinateIdentity', 'true'],
  ambiguity: ['guard sameLabel.count == 1 else', 'guard true else'],
  disabled: ['                        guard driverBoolean(attrs[kAXEnabledAttribute]) != false else', '                        guard true else'],
  secure: ['guard !element.secure, element.role == "AXMenuItem"', 'guard true, element.role == "AXMenuItem"'],
  root: ['element.root.same(menu)', 'true'],
  bar: ['if candidates.count == 1, candidates[0].role == "AXMenuBarItem" {', 'if candidates.count == 1, candidates[0].role == "AXMenuBarItem" { try request.admitInput(); try access.perform(candidates[0].node, kAXPressAction, request)'],
  reason: ['fault.disposition["menuRefusal"] = "menu-compound"', ''],
  read: ['if fullRead || result["semantics"] as? String == "menu-accessibility", let settle = settle {', 'if fullRead, let settle = settle {'],
};
const frame = { x: 0, y: 0, width: 100, height: 100 };
const menuItem = (title, attrs = {}) => ({ AXRole: 'AXMenuItem', AXTitle: title, AXEnabled: true, actions: ['AXPress'], ...attrs });
const fixture = control => ({ control,
  apps: [{ id: 'test.fake', name: 'Fixture', pid: 42, processStart: 'start' }],
  windows: [{ windowId: '7', pid: 42, processStart: 'start', app: 'Fixture', title: 'Untitled', bounds: frame, onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Untitled', AXMinimized: false, AXFullScreen: false, frame, children: [] } },
  menu: { AXRole: 'AXMenuBar', children: [{ AXRole: 'AXMenuBarItem', AXTitle: 'View', AXEnabled: true, actions: ['AXPress'], children: [
    { AXRole: 'AXMenu', AXExpanded: false, children: [menuItem('Basic', control.submenu ? { frame: { x: 10, y: 10, width: 20, height: 20 }, children: [{ AXRole: 'AXMenu', children: [] }] } : control.alwaysDisabled ? { AXEnabled: false } : {}), menuItem('Scientific'), menuItem('Copy')] },
  ] }] },
});
const binding = { windowId: '7', processStart: 'start' };
const envelope = (id, method, params) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64), id, method, params, deadline: Date.now() + 30000 });

test('GLC1 native menu clicks use title paths without frames, through the installed registrar', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-glc1-native-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = macDriverSource();
  if (process.env.GLC1_NATIVE_MUTANT) {
    const [before, after] = mutations[process.env.GLC1_NATIVE_MUTANT];
    assert.ok(source.includes(before), 'native variant anchor'); source = source.replace(before, after);
    if (process.env.GLC1_NATIVE_MUTANT === 'secure') source = source.replace('guard !retained.secure else', 'guard true else');
    if (process.env.GLC1_NATIVE_MUTANT === 'ambiguity') source = source.replace('guard matches.count < 2 else', 'guard true else');
  }
  const at = source.lastIndexOf('\ndriverMain()'); assert.notEqual(at, -1);
  const path = join(root, 'driver.swift'), binary = join(root, 'driver');
  await writeFile(path, source.slice(0, at) + '\n' + await readFile(new URL('./fixtures/glc1-menu.swift', import.meta.url), 'utf8'));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), path, '-o', binary], { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(compile.status, 0, compile.stderr);
  t.diagnostic(`nativeBinaryBytes=${(await stat(binary)).size}`);
  const run = (control = {}, target = { label: 'Basic' }, readId = 1, extras = []) => {
    const requests = [envelope(1, 'getAXState', binding), envelope(2, 'click', { ...binding, readId, args: [target] }), ...extras];
    const result = spawnSync(binary, [], { input: [fixture(control), ...requests].map(JSON.stringify).join('\n') + '\n',
      env: { ...process.env, SLEIGHT_DRIVER_EVENTS: '1', SLEIGHT_DRIVER_NONCE: 'a'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.trim().split('\n').map(JSON.parse);
    rows.events = String(result.output[3] ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
    return rows;
  };
  for (const target of [4, { label: 'Basic' }]) await t.test('closed leaf works by ' + JSON.stringify(target), () => {
    const [before, after] = run({}, target);
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.deepEqual(after.presses, ['Basic']); assert.equal(after.pointerPosts, 0);
    assert.equal(after.result.semantics, 'menu-accessibility');
    assert.equal(after.result.readId, 2, 'tree-free request still returns the post-menu map');
    assert.match(after.result.text, /4 menu item Basic/);
    assert.ok(after.guards >= 3);
  });
  await t.test('a menu action keeps its owned window in the private event stream', () => {
    const rows = run();
    const act = rows.events.find(row => row.phase === 'act');
    assert.ok(act); assert.deepEqual(act.window, { id: 7, pid: 42, rect: [0, 0, 100, 100] });
    assert.doesNotMatch(JSON.stringify(rows.events), /Basic|Scientific|Untitled/);
  });
  await t.test('submenu expansion retains its existing pointer route', () => {
    const [, reply] = run({ submenu: true });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.presses, []); assert.ok(reply.pointerPosts > 0);
  });
  await t.test('menu bar click refuses with menu compound guidance before any input', () => {
    const [, reply] = run({}, { label: 'View' });
    assert.equal(reply.ok, false, JSON.stringify(reply)); assert.deepEqual(reply.presses, []);
    assert.equal(reply.pointerPosts, 0); assert.equal(reply.error.delivery, 'not-sent');
    assert.equal(reply.error.menuRefusal, 'menu-compound');
    assert.match(formatMacDriverError(reply.error), /Menu title: click the item's number; the menu need not be open\./);
  });
  for (const [control, code] of [[{ alwaysDisabled: true }, 'ELEMENT_DISABLED'], [{ secure: true }, 'STALE_ELEMENT'], [{ wrongRoot: true }, 'STALE_ELEMENT'],
    [{ changedLabel: 'Other' }, 'STALE_ELEMENT'], [{ disabled: true }, 'STALE_ELEMENT'],
    [{ duplicate: true }, 'AMBIGUOUS_ELEMENT'], [{ reparented: true }, 'STALE_ELEMENT'],
    [{ noPress: true }, 'ACTION_UNSUPPORTED'], [{ lateChange: true }, 'STALE_ELEMENT'],
    [{ stop: true }, 'USER_STOPPED'], [{ identity: true }, 'IDENTITY_CHANGED']]) await t.test('menu refuses ' + JSON.stringify(control), () => {
    const [, reply] = run(control);
    assert.equal(reply.ok, false); assert.equal(reply.error.code, code, JSON.stringify(reply));
    assert.equal(reply.error.delivery, 'not-sent'); assert.equal(reply.error.retry, 'safe');
    assert.deepEqual(reply.presses, []); assert.equal(reply.pointerPosts, 0);
    if (code === 'IDENTITY_CHANGED') assert.match(formatMacDriverError(reply.error), /step=window-id;/);
  });
  await t.test('clipboard command still refuses without a press', () => {
    const [, reply] = run({}, { label: 'Copy' });
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'ACTION_UNSUPPORTED');
    assert.deepEqual(reply.presses, []); assert.equal(reply.pointerPosts, 0);
  });
  await t.test('a stale read refuses without a press', () => {
    const [, reply] = run({}, { label: 'Basic' }, 2);
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'STALE_READ'); assert.deepEqual(reply.presses, []);
  });
  await t.test('a number naming a menu container still refuses without a press', () => {
    const [, reply] = run({}, 3);
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'STALE_ELEMENT');
    assert.deepEqual(reply.presses, []); assert.equal(reply.pointerPosts, 0);
  });
  await t.test('a lost press reply never falls back to pointer input', () => {
    const [, reply] = run({ lostPress: true });
    assert.equal(reply.ok, false); assert.equal(reply.error.delivery, 'unknown');
    assert.deepEqual(reply.presses, ['Basic']); assert.equal(reply.pointerPosts, 0);
  });
  await t.test('the menu post-read id is required by the following action', () => {
    const replies = run({}, { label: 'Basic' }, 1, [envelope(3, 'click', { ...binding, readId: 1, args: [{ label: 'Scientific' }] })]);
    assert.equal(replies[1].result.readId, 2);
    assert.equal(replies[2].ok, false); assert.equal(replies[2].error.code, 'STALE_READ');
    assert.deepEqual(replies[2].presses, ['Basic']);
  });
});
