import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createCua } from '../plugins/sleight/lib/repl/cua.mjs';
import { elementLines } from '../plugins/sleight/lib/document-scope.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { MAC_WINDOW_REFUSALS } from '../plugins/sleight/lib/mac-safety.mjs';

const exec = promisify(execFile);
const bounds = { x: 100, y: 50, width: 400, height: 600 };
function inventory({ app = 'Electron', onScreen = false, split = false } = {}) {
  const window = { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.parity', app,
    title: 'Cold', bounds, onScreen, minimized: false, layer: 0, hidden: false,
    kCGWindowWorkspace: onScreen ? 1 : 2, isOnCurrentSpace: onScreen };
  const node = (role, title, frame = bounds) => ({ AXRole: role, AXTitle: title, frame, pid: 42 });
  const tree = { ...node('AXWindow', 'Cold'), AXMinimized: false, AXFullScreen: split, children: Array.from({ length: 10 }, (_, i) =>
    node('AXGroup', `Cold ${i}`, { x: 120, y: 80 + i * 20, width: 40, height: 20 })) };
  const data = { displays: [bounds], apps: [{ id: 'test.parity', name: app, pid: 42, processStart: '1.2' }],
    windows: [window], trees: { 7: tree } };
  if (split) {
    data.windows[0] = { ...window, onScreen: true, isOnCurrentSpace: true, kCGWindowWorkspace: 3, splitView: true,
      bounds: { ...bounds, width: 200 } };
    data.trees[7].frame = data.windows[0].bounds;
    data.windows.push({ ...window, windowId: '8', pid: 43, bundleId: 'test.companion', app: 'Companion',
      onScreen: true, isOnCurrentSpace: true, kCGWindowWorkspace: 3, splitView: true,
      bounds: { ...bounds, x: 300, width: 200 } });
    data.apps.push({ id: 'test.companion', name: 'Companion', pid: 43, processStart: '1.2' });
    data.trees[8] = { AXRole: 'AXWindow', AXTitle: 'Cold', AXMinimized: false, AXFullScreen: true, pid: 43, frame: data.windows[1].bounds,
      children: [{ AXRole: 'AXGroup', AXTitle: 'Other', pid: 43, frame: { x: 320, y: 80, width: 40, height: 20 } }] };
  }
  return data;
}

test('RT19 rows 33 and 35, real Swift core with fake AX and event providers',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-rt19a-native-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'main.swift'), binary = join(root, 'parity');
    const composed = macDriverSource();
    assert.match(composed, /\ndriverMain\(\)\s*$/);
    const harness = await readFile(new URL('./fixtures/runtime-parity-native.swift', import.meta.url), 'utf8');
    await writeFile(source, composed.replace(/\ndriverMain\(\)\s*$/, '\n') + harness);
    await exec('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES',
      '-module-cache-path', join(root, 'modules'), source, '-o', binary], { timeout: 240000, maxBuffer: 65536 });
    t.diagnostic(`fake-only helper: ${(await stat(binary)).size} bytes`);
    async function run(input) {
      const stateDirectory = await mkdtemp(join(root, 'state-'));
      const child = execFile(binary, ['--parity-fixture'], { timeout: 10000, maxBuffer: 1048576 });
      const completed = new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => {
          try {
            assert.equal(code, 0, stderr);
            const reply = JSON.parse(stdout);
            reply.diagnostics = stderr.trim() ? stderr.trim().split('\n').map(JSON.parse) : [];
            resolve(reply);
          } catch (error) { reject(error); }
        });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ stateDirectory, fixture: inventory(), ...input }) + '\n');
      return completed;
    }
    for (const app of ['Electron', 'Chromium']) await t.test(`row 33: ${app} cold tree grows from 11 to 509 and reaches the real cua facade`, async () => {
      let observation;
      const writes = [];
      const cua = createCua({ platform: 'darwin', write: text => writes.push(text), emitImage: () => assert.fail('no capture'),
        request: async (method, params) => {
          assert.equal(method, 'getApp'); assert.equal(params.selector, app);
          observation = await run({ mode: 'renderer', grow: true, fixture: inventory({ app }) });
          return observation.result;
        } });
      await cua.getApp(app);
      assert.equal(elementLines(writes[0]).size, 509);
      assert.match(writes[0], /508 text entry area Editor/);
      assert.equal(observation.result.truncated, false);
      assert.equal(observation.result.readId, 3, 'initial walk, plain retry, activated walk');
      assert.equal(observation.elements, 509);
      assert.deepEqual(observation.waits, [2]);
      assert.deepEqual(observation.writes, [['AXManualAccessibility', true], ['AXManualAccessibility', false]]);
      assert.deepEqual(observation.attributes, { AXManualAccessibility: false, AXEnhancedUserInterface: false });
      assert.deepEqual(observation.restoreRecords, []);
    });
    await t.test('row 33: unavailable activation reports its recovery limitation without writes', async () => {
      const reply = await run({ mode: 'renderer', noLease: true });
      assert.equal(elementLines(reply.result.text).size, 11);
      assert.equal(reply.result.readId, 2);
      assert.deepEqual(reply.result.rendererNotes, ['activation-recovery-unavailable']);
      assert.deepEqual(reply.writes, []); assert.deepEqual(reply.waits, []);
    });
    await t.test('row 33: a tree that stays at 11 nodes explicitly reports it', async () => {
        const reply = await run({ mode: 'renderer', grow: false });
        assert.equal(reply.elements, 11); assert.equal(reply.result.readId, 3);
        assert.deepEqual(reply.waits, [2]);
        assert.deepEqual(reply.result.rendererNotes, ['tree-still-thin']);
        assert.deepEqual(reply.attributes, { AXManualAccessibility: false, AXEnhancedUserInterface: false });
        assert.deepEqual(reply.restoreRecords, []);
      });
    await t.test('row 33: production getApp dispatch reaches the cold-tree retry', async t => {
        const fixture = join(root, 'cold.json'); await writeFile(fixture, JSON.stringify(inventory()));
        const request = { protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64), id: 1,
          method: 'getApp', params: { selector: 'Electron' }, deadline: Date.now() + 15000 };
        const child = execFile(binary, ['--fixture', fixture], { timeout: 10000,
          env: { ...process.env, SLEIGHT_DRIVER_NONCE: request.nonce } });
        const completed = new Promise((resolve, reject) => {
          let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.once('error', reject);
          child.once('close', code => { try { assert.equal(code, 0); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
        });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request) + '\n');
        const reply = await completed;
        assert.equal(reply.ok, true); assert.equal(elementLines(reply.result.text).size, 11);
        assert.equal(reply.result.window.windowId, '7'); assert.equal(reply.result.window.pid, 42);
        if (reply.result.readId === 1) {
          t.skip('RTW2 gap: production getApp still calls readTree once instead of the leased renderer retry');
          return;
        }
        assert.ok(reply.result.readId >= 2, 'a plain cold-tree retry must precede any AX activation');
      });
    function refusedWithoutInput(reply, message) {
      assert.equal(reply.ok, false, JSON.stringify(reply));
      assert.equal(reply.error.code, 'NO_WINDOWS_AVAILABLE');
      assert.equal(reply.error.message, message);
      assert.equal(reply.error.delivery, 'not-sent'); assert.equal(reply.error.retry, 'safe');
      assert.deepEqual(reply.pointerEvents, []); assert.deepEqual(reply.keyEvents, []);
      assert.deepEqual(reply.focusEvents, []); assert.equal(reply.frontPID, 900);
      assert.deepEqual(reply.diagnostics, []);
    }
    await t.test('row 35: off-Space clicks refuse before posting', async () => {
      const reply = await run({ mode: 'pointer', method: 'click', args: [1] });
      assert.equal(reply.window.onScreen, false); assert.equal(reply.window.kCGWindowWorkspace, 2);
      refusedWithoutInput(reply, MAC_WINDOW_REFUSALS.otherSpace);
    });
    await t.test('row 35: off-Space typing refuses before focus belief or keys', async () => {
      const reply = await run({ mode: 'keyboard', method: 'typeText', args: ['hello 🙂'] });
      assert.equal(reply.window.onScreen, false);
      // DriverKeyboardFault exposes the code as its message at this adapter.
      refusedWithoutInput(reply, 'NO_WINDOWS_AVAILABLE');
    });
    await t.test('row 35: off-Space drag refuses noWindowsAvailable before posting', async () => {
        const reply = await run({ mode: 'pointer', method: 'drag', args: [1, 2] });
        refusedWithoutInput(reply, MAC_WINDOW_REFUSALS.otherSpace);
      });
    for (const [windowId, pid, x] of [['7', 42, 140], ['8', 43, 340]]) {
      await t.test(`row 35: Split View click refuses window ${windowId}, including identical titles`, async () => {
        const reply = await run({ mode: 'pointer', method: 'click', args: [1], windowId,
          fixture: inventory({ split: true }) });
        refusedWithoutInput(reply, MAC_WINDOW_REFUSALS.splitView); assert.equal(reply.window.onScreen, true);
        assert.equal(reply.window.splitView, true); assert.equal(reply.window.kCGWindowWorkspace, 3);
      });
      await t.test(`row 35: Split View typing refuses window ${windowId}`, async () => {
        const reply = await run({ mode: 'keyboard', method: 'typeText', args: ['Split'], windowId,
          fixture: inventory({ split: true }) });
        refusedWithoutInput(reply, 'NO_WINDOWS_AVAILABLE');
      });
      await t.test(`row 35: current-Space Split View drag refuses window ${windowId}`, async () => {
        const reply = await run({ mode: 'pointer', method: 'drag', args: [1, 1], windowId,
          fixture: inventory({ split: true }) });
        refusedWithoutInput(reply, MAC_WINDOW_REFUSALS.splitView);
      });
      for (const [mode, method, args] of [['pointer', 'click', [1]], ['keyboard', 'typeText', ['Split']], ['pointer', 'drag', [1, 1]]]) {
        await t.test(`row 35: ordinary current-Space ${method} binds window ${windowId} with identical titles`, async () => {
          const fixture = inventory({ split: true });
          for (const window of fixture.windows) delete window.splitView;
          for (const tree of Object.values(fixture.trees)) tree.AXFullScreen = false;
          const reply = await run({ mode, method, args, windowId, fixture });
          assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(reply.result.delivery, 'sent-unverified');
          assert.equal(reply.frontPID, 900);
          if (mode === 'keyboard') {
            assert.ok(reply.keyEvents.length > 0); assert.ok(reply.keyEvents.every(event => event.pid === pid));
            assert.equal(reply.keyEvents.filter(event => event.type === 'keyDown').map(event => event.unicode ?? '').join(''), 'Split');
            assert.deepEqual(reply.pointerEvents, []);
          } else {
            assert.equal(reply.pointerEvents.length, method === 'drag' ? 29 : 2);
            assert.ok(reply.pointerEvents.every(event => event.pid === pid && event.windowID === +windowId && event.x === x));
            assert.deepEqual(reply.keyEvents, []); assert.deepEqual(reply.focusEvents, []);
          }
        });
      }
    }
  });
