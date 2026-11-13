import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { recordedFixture } from './fixtures/mac-driver-recorded-tree.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const frame = { x: 0, y: 0, width: 100, height: 100 };
const node = (AXRole, extra = {}) => ({ AXRole, frame, pid: 42, children: [], ...extra });
const base = () => {
  const root = node('AXWindow', { AXWindowNumber: 7, AXTitle: 'Draft', AXMinimized: false, AXFullScreen: false });
  return { apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
    windows: [{ windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', app: 'Fixture', title: 'Draft', bounds: frame, onScreen: true, layer: 0, hidden: false }],
    trees: { 7: root }, axWindows: [root], menu: node('AXMenuBar', { children: [
      node('AXMenuBarItem', { AXTitle: 'View', children: [node('AXMenu', { AXExpanded: false, children: [
        node('AXMenuItem', { AXTitle: 'Basic', actions: ['AXPress'] }),
      ] })] }),
    ] }) };
};
const request = (id, method, params = {}) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64),
  id, method, params: { windowId: '7', processStart: '1.2', ...params }, deadline: Date.now() + 30000 });
test('GLS4-6 and 7 native printer and resized menu observation use offline providers', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-gls4a-'))); t.after(() => rm(root, { recursive: true, force: true }));
  let source = macDriverSource().replace('let fixture: DriverObject?', 'var fixture: DriverObject?');
  const variants = {
    'cache-groups': ["finishGroups(beforeDepth: 0)\n                if fingerprinting", "if fingerprinting"],
    groups: ['if elements.count == group.number + 1, let element = elements.removeValue(forKey: group.number)', 'if false, let element = elements.removeValue(forKey: group.number)'],
    'retained-group': ['printed.removeValue(forKey: DriverSettleNodeKey(node: element.node))', 'elements[group.number] = element'],
    resize: ['menuAfter: result["semantics"] as? String == "menu-accessibility" ? result["window"] as? DriverObject : nil', 'menuAfter: nil'],
  };
  if (process.env.GLS4A_NATIVE_MUTANT) {
    const pair = variants[process.env.GLS4A_NATIVE_MUTANT]; assert.ok(pair); assert.ok(source.includes(pair[0]), 'variant anchor');
    source = source.replace(pair[0], pair[1]);
  }
  const swift = join(root, 'fixture.swift'), binary = join(root, 'fixture');
  await writeFile(swift, source.slice(0, source.lastIndexOf('\ndriverMain()')) + '\n' + await readFile(new URL('./fixtures/gls4a-native.swift', import.meta.url), 'utf8'));
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), swift, '-o', binary],
    { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = (fixture, requests) => {
    const result = spawnSync(binary, [], { input: [fixture, ...requests].map(JSON.stringify).join('\n') + '\n',
      timeout: 15000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1048576 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim().split('\n').map(JSON.parse);
  };
  await t.test('empty anonymous groups and nested empty groups get no text, number or selector', () => {
    const fixture = base(); fixture.trees[7].children = [node('AXGroup', { children: [node('AXGroup')] })];
    fixture.axWindows = [fixture.trees[7]];
    const [read, resolve] = run(fixture, [request(1, 'getAXState'), request(2, 'fixtureResolve', { readId: 1, target: { label: 'container' } })]);
    assert.equal(read.ok, true, JSON.stringify(read)); assert.doesNotMatch(read.result.text, /container/);
    assert.ok(!read.paths.some(path => path.startsWith('7/candidate/0/0')));
    assert.equal(resolve.ok, false); assert.equal(resolve.error.code, 'STALE_ELEMENT');
  });
  await t.test('named, stateful and nonempty groups keep their descendants and dense numbers', () => {
    const fixture = base(); fixture.trees[7].children = [node('AXGroup'), node('AXGroup', { AXIdentifier: 'named' }),
      node('AXGroup', { AXFocused: true }), node('AXGroup', { children: [node('AXButton', { AXTitle: 'Open' })] })];
    fixture.axWindows = [fixture.trees[7]];
    const [read, resolve] = run(fixture, [request(1, 'getAXState'), request(2, 'fixtureResolve', { readId: 1, target: 4 })]);
    assert.match(read.result.text, /\n\t1 container ID: named\n\t2 container \(focused\)\n\t3 container\n\t\t4 button Open/);
    assert.equal(resolve.result.number, 4); assert.match(resolve.result.path, /\/3\/0$/);
  });
  await t.test('GLINT5 cached menu keeps trailing anonymous groups out of text and retained numbers', () => {
    const fixture = base();
    fixture.trees[7].children = [node('AXGroup', { children: [node('AXGroup')] })];
    fixture.axWindows = [fixture.trees[7]];
    const [first, second] = run(fixture, [request(1, 'getAXState'), request(2, 'getAXState')]);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.menuCacheHit, true, 'the second read takes the cached projection');
    assert.equal(second.result.text, first.result.text, 'cache hits preserve the uncached projection');
    assert.deepEqual(second.paths, first.paths, 'unprinted groups never gain retained numbers');
    assert.doesNotMatch(second.result.text, /container/);
  });
  await t.test('recorded Calculator zoom groups disappear from text and retained map', async () => {
    const captured = await readFile(new URL('./fixtures/gls4-calculator-scientific.txt', import.meta.url), 'utf8');
    const fixture = recordedFixture(captured);
    const [read] = run(fixture, [request(1, 'getAXState')]);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.doesNotMatch(read.result.text, /zoom button[^\n]*\n\t\t\d+ container/);
    const count = [...read.result.text.matchAll(/^\t*\d+ /gm)].length;
    assert.equal(read.paths.length, count);
    assert.equal(count, [...captured.matchAll(/^\t*\d+ /gm)].length - 2);
    t.diagnostic(`recordedRows=${[...captured.matchAll(/^\t*\d+ /gm)].length}; printedRows=${count}; printedBytes=${Buffer.byteLength(read.result.text)}`);
  });
  for (const mutation of ['resize', 'move-resize', 'resize-settle', 'pid', 'processStart', 'windowId', 'AXWindowNumber', 'bundleId', 'AXRoot']) {
    await t.test('menu press post read rebinds exact identity: ' + mutation, () => {
      const fixture = base(), after = structuredClone(fixture);
      after.windows[0].bounds = { ...frame, width: 400, ...mutation === 'move-resize' ? { x: 20, y: 30 } : {} };
      after.trees[7].frame = after.windows[0].bounds;
      if (mutation === 'AXWindowNumber') after.trees[7].AXWindowNumber = 8;
      else if (mutation === 'AXRoot') after.trees[7].key = 'replacement-root';
      else if (mutation === 'pid') after.windows[0].pid = 43;
      else if (mutation === 'processStart') after.windows[0].processStart = 'changed';
      else if (mutation === 'windowId') after.windows[0].windowId = '8';
      else if (mutation === 'bundleId') after.windows[0].bundleId = 'test.other';
      after.axWindows = [after.trees[7]]; fixture.after = after;
      if (mutation === 'resize-settle') fixture.settleFailure = 'IDENTITY_UNVERIFIED';
      const [read] = run(fixture, [request(1, 'getAXState')]);
      const number = Number(/^\t*(\d+) menu item Basic$/m.exec(read.result.text)[1]);
      const [, clicked] = run(fixture, [request(1, 'getAXState'), request(2, 'click', { readId: 1, args: [number] })]);
      assert.equal(clicked.presses, 1);
      if (['resize', 'move-resize', 'resize-settle'].includes(mutation)) {
        assert.equal(clicked.ok, true, JSON.stringify(clicked)); assert.equal(clicked.result.observation, undefined);
        assert.equal(clicked.result.window.bounds.width, 400); assert.match(clicked.result.text, /menu item Basic/);
        assert.ok(clicked.result.readId > read.result.readId);
      } else {
        assert.ok(!clicked.ok || clicked.result.observation === 'unavailable', JSON.stringify(clicked));
        assert.equal(clicked.result?.text, undefined, 'identity drift cannot establish a new tree');
      }
    });
  }
});
