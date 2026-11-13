import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { macDriverSource, macDriverBuildInfo } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { createRuntimeActionEvents } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const frame = { x: 0, y: 0, width: 400, height: 300 };
const ids = ['AllClear', 'Three', 'Six', 'Multiply', 'Seven', 'Nine', 'Equals'];
const item = title => ({ AXRole: 'AXMenuItem', AXTitle: title, AXEnabled: true, pid: 42, frame });
const menu = children => ({ AXRole: 'AXMenu', AXExpanded: false, pid: 42, frame, children });
const bar = (title, children) => ({ AXRole: 'AXMenuBarItem', AXTitle: title, AXEnabled: true, pid: 42, frame, children: [menu(children)] });
const fixture = {
  apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
  windows: [{ windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', app: 'Fixture', title: 'Draft', bounds: frame,
    onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Draft', AXMinimized: false, AXFullScreen: false, pid: 42, frame,
    children: [{ AXRole: 'AXStaticText', AXValue: '0', pid: 42, frame }, { AXRole: 'AXGroup', pid: 42, frame,
      children: ids.map(id => ({ AXRole: 'AXButton', AXIdentifier: id, AXTitle: id, AXEnabled: true,
        actions: ['AXPress'], pid: 42, frame: { x: 10, y: 10, width: 20, height: 20 } })) }] } },
  menu: { AXRole: 'AXMenuBar', pid: 42, frame, children: [bar('Apple', [item('Private')]),
    ...['Fixture', 'File', 'Edit', 'View', 'Window', 'Help'].map(title => bar(title, Array.from({ length: 10 }, (_, i) => item(title + ' ' + i))))] },
};

test('GLS1 recorded seven-click cell through the real native client and parent admission', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-gls4-cell-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = macDriverSource();
  const base = process.env.GLS4_TIMING_BASE;
  if (base) {
    assert.match(base, /^[a-f0-9]{8,40}$/);
    const directory = 'plugins/sleight/lib/mac-driver/native/';
    const names = spawnSync('/usr/bin/git', ['ls-tree', '--name-only', base + ':' + directory.slice(0, -1)],
      { timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8' });
    assert.equal(names.status, 0, names.stderr);
    const files = names.stdout.trim().split('\n').filter(name => /^Driver[A-Za-z0-9]*\.swift$/.test(name)).sort();
    let body = '';
    for (const name of [...files.filter(name => name !== 'DriverMain.swift'), 'DriverMain.swift']) {
      const result = spawnSync('/usr/bin/git', ['show', base + ':' + directory + name],
        { timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 2 << 20 });
      assert.equal(result.status, 0, result.stderr); body += '// Source: ' + name + '\n' + result.stdout + '\n';
    }
    const contract = source.slice(source.indexOf('\n') + 1, source.indexOf('// Source:'));
    source = 'let driverBuild = "' + createHash('sha256').update(contract + body).digest('hex') + '"\n' + contract + body;
  }
  if (process.env.GLS4_EVENT_MUTANT === '1') {
    const anchor = 'if let action = request.actionEvent {';
    assert.ok(source.includes(anchor)); source = source.replace(anchor, 'if let action = request.actionEvent, false {');
  }
  const info = macDriverBuildInfo(source), path = join(root, 'driver.swift'), binary = join(root, 'driver'), dataPath = join(root, 'fixture.json');
  const at = source.lastIndexOf('\ndriverMain()'); assert.ok(at > 0);
  await writeFile(path, source.slice(0, at) + await readFile(new URL('./fixtures/gls4-recorded-cell.swift', import.meta.url), 'utf8'));
  await writeFile(dataPath, JSON.stringify(fixture));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), path, '-o', binary],
    { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(compile.status, 0, compile.stderr);
  const events = process.env.GLS4_EVENT_PROOF === '1' ? createRuntimeActionEvents() : undefined;
  const eventRows = [];
  events?.connect(row => { eventRows.push(row); });
  t.after(() => events?.close());
  const driver = createMacDriverClient({ platform: 'darwin', actionEvents: events,
    requiredMethods: ['ping', 'resolveApp', 'verifyWindowIdentity', 'getAXState', 'inputGateState', 'personState', 'click'],
    prepare: async () => ({ status: 'ready', build: info.build,
    spawn: ({ nonce, actionEvents }) => spawn(binary, [dataPath], {
      env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce, ...actionEvents ? { SLEIGHT_DRIVER_EVENTS: '1' } : {} },
      stdio: ['pipe', 'pipe', 'pipe', ...actionEvents ? ['pipe'] : []] }) }) });
  t.after(() => driver.close());
  const inputRegistrar = await prepareMacInputRegistrar(driver, info.build);
  const safety = createMacSafety({ driver, inputRegistrar, ...base ? { readReuse: false } : {},
    lease: { acquire: () => 'lease', renew() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/fixture/host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  t.after(() => safety.close());
  safety.setPolicy({ checkPause() {}, beforeAction: ({ args, personToken }) => ({ args, personToken }) });
  const reads = createMacReadState();
  let current = await safety.request('getApp', { selector: 'Fixture' });
  const snapshot = reads.read(current); reads.endCell([{ type: 'text', text: current.text }], [snapshot]);
  const context = { cell: 'recorded', observe: result => reads.read(result),
    beforeRequest: (method, params) => reads.assertCurrent(method, params, 'recorded'), fullTree: params => reads.fullTree(params) };
  const rows = [];
  for (const id of ids) {
    current = await safety.request('click', { windowId: '7', processStart: '1.2', readId: current.readId, args: [{ id }] }, context);
    if (!base) assert.equal(current.semanticPress, true);
    assert.equal(current.delivery, 'sent-unverified');
    rows.push({ id, ...current.timing });
  }
  assert.equal((await driver.request('fixtureStats', {})).clicks, 7);
  if (events) {
    for (let i = 0; i < 32; i++) await new Promise(resolve => setImmediate(resolve));
    const acts = eventRows.filter(row => row.type === 'action' && row.phase === 'act');
    assert.equal(acts.length, 7);
    for (const act of acts) {
      assert.deepEqual(act.window, { id: 7, pid: 42, rect: [0, 0, 400, 300] });
      assert.deepEqual(act.rect, [10, 10, 20, 20]); assert.deepEqual(act.point, [20, 20]);
    }
    assert.doesNotMatch(JSON.stringify(eventRows), /AllClear|Scientific|Draft/);
  }
  t.diagnostic(JSON.stringify({ base: base ?? 'working', actions: rows }));
  const means = {};
  for (const key of ['admissionMs', 'admissionReadMs', 'personMs', 'policyMs', 'sendMs', 'settleMs', 'postReadMs', 'observeMs', 'totalMs'])
    means[key] = rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  t.diagnostic(JSON.stringify({ base: base ?? 'working', means }));
});
