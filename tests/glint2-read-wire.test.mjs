import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { PassThrough } from 'node:stream';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';

const bounds = { x: 0, y: 0, width: 400, height: 300 };
const binding = { windowId: '7', processStart: '1.2' };
const fixture = {
  apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
  windows: [{ ...binding, pid: 42, bundleId: 'test.fixture', app: 'Fixture', title: 'Draft', bounds,
    onScreen: true, hidden: false, layer: 0 }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Draft', AXMinimized: false, AXFullScreen: false, pid: 42, frame: bounds,
    children: [{ AXRole: 'AXButton', AXTitle: 'Mode', AXIdentifier: 'Mode', pid: 42, frame: bounds }] } },
};
const policyOptions = {
  lease: { acquire: () => 'lease', grant: () => ({ token: 'lease' }), renewGrant() {}, renew() {}, release() {}, close() {} },
  approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1],
  ancestry: () => [{ pid: 999, path: '/fixture/host' }], ownHostPid: () => false,
  permissions: { app() {}, page() {}, sitesLimited: () => false },
};
const plain = result => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');

test('GLS3 reads cross the real client, renderer gate and Swift helper, including relay menu policy',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-glint2-wire-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    let source = macDriverSource();
    const variant = process.env.GLINT2_WIRE_MUTANT;
    const variants = { renderer: ['"args", "reuseIfUnchanged", "menuRequests"', '"args", "reuseIfUnchanged"'],
      capture: ['"scale", "reuseIfUnchanged", "menuRequests"', '"scale", "reuseIfUnchanged"'],
      field: ['fault.disposition["field"] = fields.contains(field) ? field : "params"', 'fault.disposition["field"] = "params"'] };
    if (variant) { const [before, after] = variants[variant]; assert.ok(source.includes(before)); source = source.replace(before, after); }
    const at = source.lastIndexOf('\ndriverMain()'); assert.ok(at > 0);
    // Reuse the existing headless main, then install the production renderer
    // registrar that overrides getAXState in DriverMain. No desktop adapter runs.
    let main = await readFile(new URL('./fixtures/gls1-timing.swift', import.meta.url), 'utf8');
    main = main.replace('DispatchQueue.global().async { runtime.serve() }',
      'runtime.registerRenderer(service: DriverRendererService(store: nil), captureBackend: WireCapture())\nDispatchQueue.global().async { runtime.serve() }');
    const capture = await readFile(new URL('./fixtures/glint2-capture.swift', import.meta.url), 'utf8');
    const path = join(root, 'wire.swift'), binary = join(root, 'driver'), data = join(root, 'fixture.json');
    await writeFile(path, source.slice(0, at) + '\n' + capture + '\n' + main);
    await writeFile(data, JSON.stringify(fixture));
    const compiled = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(root, 'modules'), path, '-o', binary],
      { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    const client = () => createMacDriverClient({ platform: 'darwin', requiredMethods: ['ping', 'resolveApp', 'verifyWindowIdentity', 'getAXState'],
      prepare: async () => ({ status: 'ready', binarySha256, spawn: ({ nonce }) => spawn(binary, [data], {
        env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'],
      }) }) });
    for (const requests of [undefined, [], ['Open Recent']]) await t.test('policy=' + JSON.stringify(requests), async t => {
      const driver = client(), safety = createMacSafety({ ...policyOptions, driver });
      t.after(async () => { await safety.close(); await driver.close(); });
      if (requests) safety.setPolicy({ menuReadRequests: () => requests });
      for (const [method, params] of [['getApp', { selector: 'Fixture' }], ['getAXState', binding], ['getAXStateAndScreenshot', binding]]) {
        const read = await safety.request(method, params);
        assert.match(read.text, /button Mode/); assert.ok(read.readId > 0);
        assert.equal(read.window.identityVerified, true);
      }
    });
    await t.test('native parameter faults cross the real client without values', async t => {
      const driver = client(); t.after(() => driver.close());
      await assert.rejects(driver.request('getAXState', { ...binding, depth: 'PRIVATE VALUE' }), error => {
        assert.equal(error.code, 'INVALID_PARAMS'); assert.equal(error.field, 'depth');
        const line = formatMacDriverError(error, { method: 'getAXState' });
        assert.match(line, /INVALID_PARAMS on getAXState, field depth/);
        assert.match(line, /next=retry-safe/); assert.doesNotMatch(line, /PRIVATE VALUE/); return true;
      });
      // A raw authenticated frame exercises native shape validation as well as
      // the client's earlier guard. Every provider is still the headless main.
      for (const method of ['getAXState', 'getAXStateAndScreenshot'])
        for (const menuRequests of ['PRIVATE VALUE', Array(129).fill('PRIVATE VALUE'), ['x'.repeat(1025)], ['é'.repeat(513)]]) {
          const request = { protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64), id: 1,
            method, params: { ...binding, menuRequests }, deadline: Date.now() + 30000 };
          const raw = spawnSync(binary, [data], { input: JSON.stringify(request) + '\n',
            env: { ...process.env, SLEIGHT_DRIVER_NONCE: request.nonce }, timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8' });
          assert.equal(raw.status, 0, raw.stderr);
          const reply = JSON.parse(raw.stdout.trim()); assert.equal(reply.error.code, 'INVALID_PARAMS');
          assert.equal(reply.error.field, 'menuRequests'); assert.doesNotMatch(raw.stdout, /PRIVATE VALUE|é/);
        }
    });
    await t.test('relay installs menu policy and replays GLS3 calls 2, 4 and 6 without a sleep', async t => {
      const driver = client(), hello = await driver.ping();
      const runtime = createOwnRuntime({ ...policyOptions, driver, inputRegistrar: await prepareMacInputRegistrar(driver, hello.build) });
      const input = new PassThrough(), output = new PassThrough(), bridge = runtime.createTransport(output);
      const relay = createRelay({ clientIn: input, clientOut: bridge.clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
        nativeMac: true, nativeSession: bridge.nativeSession, documentationTrust: runtime.documentationTrust,
        permissions: policyOptions.permissions, ownHostPid: () => false, changeReview: false, warmRepl: false, warmEngine: false, idleTurnEndMs: 0 });
      t.after(async () => { await relay.close(); bridge.close(); await runtime.close(); input.destroy(); output.destroy(); });
      let id = 0, buffer = ''; const pending = new Map();
      output.on('data', bytes => {
        buffer += bytes;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          pending.get(message.id)?.(message.result); pending.delete(message.id);
        }
      });
      const call = (name, args) => new Promise(resolve => {
        pending.set(++id, resolve);
        input.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
      for (const code of ['let app = await cua.getApp("Fixture"); await app.getAXState()',
        'const calc = await cua.getApp("Fixture"); await calc.getAXState()']) {
        const reply = await call('js', { code });
        assert.notEqual(reply.isError, true, plain(reply)); assert.match(plain(reply), /button Mode/);
        assert.equal(reply.runtimeReceipt.driverSourceBuild, hello.build);
        assert.equal(reply.runtimeReceipt.ping.build, hello.build);
        assert.equal(reply.runtimeReceipt.driverBuild, binarySha256);
      }
      await call('js_reset', {});
      const reply = await call('js', { code: 'const calc = await cua.getApp("Fixture"); await calc.getAXState()' });
      assert.notEqual(reply.isError, true, plain(reply)); assert.match(plain(reply), /button Mode/);
      assert.equal(reply.runtimeReceipt.driverBuild, binarySha256, 'reset binds the newly serving helper');
      for (const code of ['}\nfoo();\n{', '}\nfoo();\nasync function z(){',
        'await foo()\nlet x = = 3', 'const a = await foo();\nconst b = ;', 'await app.click(']) {
        const refused = await call('js', { code });
        assert.equal(refused.isError, true, plain(refused));
        assert.match(plain(refused), code.startsWith('}') ? /JS \[1:0\]/ :
          code === 'await app.click(' ? /JS \[1:16\]/ : /JS \[2:(?:8|10)\]/);
      }
      const stillReady = await call('js', { code: 'await calc.getAXState()' });
      assert.notEqual(stillReady.isError, true, plain(stillReady));
      assert.match(plain(stillReady), /button Mode/);
    });
    t.diagnostic('fixture helper bytes=' + (await stat(binary)).size);
  });
