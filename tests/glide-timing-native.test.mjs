import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { macDriverSource, macDriverBuildInfo } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { waitForMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { createOwnRuntime, prepareOwnRuntimeHost } from '../plugins/sleight/lib/runtime-select.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const frame = { x: 0, y: 0, width: 400, height: 300 };
const ids = ['AllClear', 'Three', 'Six', 'Multiply', 'Seven', 'Nine', 'Equals'];
const fixture = {
  apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
  windows: [{ windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', app: 'Fixture', title: 'Draft', bounds: frame,
    onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Draft', AXMinimized: false, AXFullScreen: false, pid: 42, frame,
    children: [{ AXRole: 'AXStaticText', AXValue: '0', pid: 42, frame }, ...ids.map(id => ({ AXRole: 'AXButton',
      AXIdentifier: id, AXTitle: id, AXEnabled: true, pid: 42, frame: { x: 10, y: 10, width: 20, height: 20 } }))] } },
  menu: { AXRole: 'AXMenuBar', pid: 42, children: [{ AXRole: 'AXMenuBarItem', AXTitle: 'View', pid: 42,
    children: [{ AXRole: 'AXMenu', pid: 42, children: Array.from({ length: 195 }, (_, i) => ({
      AXRole: 'AXMenuItem', AXTitle: 'Fixture item ' + i, AXEnabled: true, pid: 42, frame })) }] }] },
};

test('seven recorded click targets return native send, settle and post-read timings through parent admission',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-gls1-timing-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    let source = macDriverSource();
    if (process.env.GLS1_TIMING_MUTANT === 'native') source = source.replaceAll('result["timing"] = timing', '/* omit native timing */');
    const info = macDriverBuildInfo(source), at = source.lastIndexOf('\ndriverMain()');
    assert.ok(at > 0, 'the fixture must remove the production entry point before compiling');
    const path = join(root, 'timing.swift'), binary = join(root, 'driver'), dataPath = join(root, 'fixture.json');
    await writeFile(path, source.slice(0, at) + '\n' + await readFile(new URL('./fixtures/gls1-timing.swift', import.meta.url), 'utf8'));
    await writeFile(dataPath, JSON.stringify(fixture));
    let compiled = false;
    const host = await prepareOwnRuntimeHost({ lazy: true, driverOptions: { platform: 'darwin',
      requiredMethods: ['ping', 'resolveApp', 'verifyWindowIdentity', 'getAXState', 'inputGateState', 'personState', 'click'],
      async prepare({ signal, onProgress }) {
        onProgress({ stage: 'compile', helper: 'glide-engine' });
        await new Promise((resolve, reject) => {
          const child = spawn('/usr/bin/xcrun', ['swiftc', ...process.env.GLS1_OPTIMIZE === '1' ? ['-O'] : [],
            '-module-cache-path', join(root, 'modules'), path, '-o', binary],
          { signal, timeout: 240000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
          child.once('error', reject);
          child.once('close', code => code === 0 ? resolve() : reject(Error('fixture compiler: ' + stderr)));
        });
        compiled = true; onProgress({ stage: 'publish' });
        return { status: 'ready', origin: 'source', build: info.build, spawn: ({ nonce }) => spawn(binary, [dataPath], {
          env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'] }) };
      } } });
    const runtime = createOwnRuntime({ ...host, stopControl: { beginGlideStop: async () => () => {}, close() {} },
      lease: { acquire: () => 'lease', grant: () => ({ token: 'lease' }), renewGrant() {}, renew() {}, release() {}, close() {} }, approve: () => true,
      policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/fixture/host' }],
      permissions: { app() {}, page() {}, sitesLimited: () => false } });
    t.after(() => runtime.close());
    runtime.safety.setPolicy({ checkPause() {}, beforeAction: ({ args, personToken }) => ({ args, personToken }) });
    let id = 0, buffer = '';
    const pending = new Map();
    runtime.serverOut.on('data', bytes => {
      buffer += bytes;
      for (let lf; (lf = buffer.indexOf('\n')) >= 0;) {
        const message = JSON.parse(buffer.slice(0, lf)); buffer = buffer.slice(lf + 1);
        if (message.result) {
          runtime.safety.guardResult(message);
          message.result = runtime.safety.displayResult(message.id, message.result);
          runtime.safety.recordDelivery(message.result);
        }
        pending.get(message.id)?.(message.result); pending.delete(message.id);
      }
    });
    const call = (method, params) => new Promise(resolve => {
      pending.set(++id, resolve);
      runtime.serverIn.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const js = (code, timeout_ms = 30000) => call('tools/call', { name: 'js', arguments: { code, timeout_ms } });
    const listingStart = performance.now();
    const listing = await call('tools/list');
    assert.ok(listing.tools.some(tool => tool.name === 'js'));
    assert.equal(compiled, false, 'tools/list waited for compilation');
    t.diagnostic('cold tools/list ms=' + (performance.now() - listingStart));
    const cold = await js('throw Error("must not evaluate")', 40);
    assert.match(JSON.stringify(cold.content), /DRIVER_PREPARING/);
    assert.doesNotMatch(JSON.stringify(cold.content), /REPL_TIMEOUT|must not evaluate/);
    await waitForMacInputRegistrar(host.inputRegistrar, host.driver, 240000);
    const first = await js('var app = await cua.getApp("Fixture"); await app.getAXState()');
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    assert.equal(JSON.stringify(first.content).match(/Window: /g)?.length, 1);
    t.diagnostic('cold preparation receipt ' + JSON.stringify(first.timing) + ' binaryBytes=' + (await stat(binary)).size);
    const result = await js(ids.map(id => `await app.click({id:${JSON.stringify(id)}});`).join('\n'));
    if (result.isError) t.diagnostic('seven-click result timing ' + JSON.stringify(result.timing));
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(result.timing.actions.length, 7);
    t.diagnostic('seven-click cell ms=' + result.timing.cellMs);
    for (const [index, row] of result.timing.actions.entries()) {
      assert.equal(row.nativeTimingAvailable, true);
      for (const key of ['admissionReadMs', 'personMs', 'policyMs', 'sendMs', 'driverMs', 'totalMs'])
        assert.ok(Number.isFinite(row[key]) && row[key] > 0, 'missing ' + key);
      assert.equal(row.settleMs, 0);
      if (index === result.timing.actions.length - 1) assert.ok(row.postReadMs > 0, 'one end-of-cell post read');
      else assert.equal(row.postReadMs, 0);
    }
    t.diagnostic('seven-click phase ms ' + JSON.stringify(result.timing.actions.map((row, i) => ({ id: ids[i], ...row }))));
    assert.equal((await host.driver.request('fixtureStats', {})).clicks, 7);
    await host.driver.request('fixtureEnableChanges', {});
    const read = await runtime.safety.request('getAXState', { windowId: '7', processStart: '1.2' });
    const full = await runtime.safety.request('click', { windowId: '7', processStart: '1.2', readId: read.readId,
      args: [{ id: 'Equals' }], read: 'full' });
    assert.equal(full.settled, true);
    assert.ok(full.timing.settleMs >= 100);
    assert.ok(full.timing.postReadMs > 0);
    assert.match(full.text, /^\t1 text 8$/m);
    t.diagnostic('explicit full-read control ' + JSON.stringify(full.timing));
    await assert.rejects(runtime.safety.request('click', { windowId: '7', processStart: '1.2', readId: full.readId,
      args: [999999] }), error => {
      assert.equal(error.delivery, 'not-sent');
      assert.ok(error.timing.sendMs > 0, 'native refusal lost its measured send phase');
      assert.equal(error.timing.settleMs, 0); assert.equal(error.timing.postReadMs, 0);
      return true;
    });
  });
