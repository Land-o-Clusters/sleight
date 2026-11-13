import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat, mkdir, chmod, symlink, link, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { runtimeRendererRecords } from '../plugins/sleight/lib/runtime-doctor.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { macLeaseTarget } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

function child(command, args, input = '', environment = {}, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout, env: { ...process.env, ...environment } });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.once('error', reject);
    proc.stdin.on('error', () => {});
    proc.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    proc.stdin.end(input);
  });
}

const manual = 'AXManualAccessibility', enhanced = 'AXEnhancedUserInterface';
const off = { [manual]: false, [enhanced]: false };

test('renderer reads and restores only a leased fake application', { skip: process.platform !== 'darwin', timeout: 900000 }, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-renderer-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await readFile(new URL('./fixtures/mac-driver-renderer.swift', import.meta.url), 'utf8');
  const source = join(root, 'main.swift'), binary = join(root, 'renderer');
  // Interpose only fixture syscalls. The production process-state classifier still runs.
  let composed = macDriverSource();
  function replaceOnce(pattern, replacement) {
    const matches = typeof pattern === 'string' ? composed.split(pattern).length - 1 : [...composed.matchAll(new RegExp(pattern.source, 'g'))].length;
    assert.equal(matches, 1, `fixture seam must match once: ${pattern}`);
    composed = composed.replace(pattern, replacement);
  }
  replaceOnce(/\ndriverMain\(\)\s*$/, '\n');
  replaceOnce('return String(cString: home) + "/Library/Application Support/sleight/runtime"',
    'return ProcessInfo.processInfo.environment["SLEIGHT_RENDERER_FIXTURE_RUNTIME"] ?? "/fixture/runtime"');
  replaceOnce('{ $0.registerRenderer() }', '{ $0.registerRenderer(startup: rendererFixtureStartup()) }');
  assert.ok(composed.includes('AXUIElementSetAttributeValue('));
  composed = composed.replaceAll('AXUIElementSetAttributeValue(', 'rendererFixtureAXWrite(');
  composed = composed.replaceAll('fsync(directory)', 'rendererFixtureDirectorySync(directory)');
  replaceOnce('private var handlers: [String: Handler] = [:]', 'var handlers: [String: Handler] = [:]');
  replaceOnce('let result = proc_pidinfo(', 'let result = rendererFixturePIDInfo(');
  replaceOnce('openat(directory, name,', 'rendererFixtureOpenat(directory, name,');
  replaceOnce('openat(directory, temporary,', 'rendererFixtureSaveOpenat(directory, temporary,');
  replaceOnce('guard fstat(fd, &info) == 0 else', 'guard rendererFixtureFstat(fd, &info) == 0 else');
  replaceOnce('guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,',
    'guard rendererFixtureDirectoryFstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,');
  replaceOnce('let size = Darwin.read(fd, &bytes, bytes.count)', 'let size = rendererFixtureRead(fd, &bytes, bytes.count)');
  await writeFile(source, composed + '\ndriverRestoreRendererMain()\n' + harness);
  const compile = await child('/usr/bin/xcrun', ['swiftc', '-Xfrontend', '-warn-long-expression-type-checking=2000', '-Xfrontend', '-warn-long-function-bodies=10000', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(root, 'modules'), source, '-o', binary], '', {}, 600000);
  assert.equal(compile.code, 0, `compiler signal ${compile.signal}: ${compile.stderr}`);
  if (compile.stderr) t.diagnostic(compile.stderr);
  t.diagnostic(`renderer fixture binary ${(await stat(binary)).size} bytes`);
  async function run(input = {}) {
    const stateDirectory = input.stateDirectory ?? await mkdtemp(join(root, 'state-'));
    const result = await child(binary, [], JSON.stringify({ stateDirectory,
      // Inventory cases model a flag still enabled after the write.
      ...input.recoverOnly || input.armProcesses ? { attributes: { [manual]: true, [enhanced]: true } } : {}, ...input }) + '\n',
      input.runtimeDirectory || input.startup ? { SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory } : {});
    assert.equal(result.code, 0, result.stderr);
    return input.liveAssistiveStates ? JSON.parse(result.stdout) : { ...JSON.parse(result.stdout), stateDirectory };
  }
  const wireLease = { pid: 42, processStart: '1.2', bundleId: 'test.fixture', token: 'fixture-token' };
  await t.test('renderer verdict exposes web roles and completeness without enabling an attribute', async () => {
    for (const webRenderer of [false, true]) {
      const row = await run({ adapter: true, webRenderer, field: false, nodes: 30, growTree: true, attributes: off });
      assert.equal(row.renderer.web, webRenderer);
      assert.equal(row.renderer.complete, true);
    }
    const partial = await run({ adapter: true, webRenderer: true, depth: 0, attributes: off });
    assert.equal(partial.renderer.complete, false);
  });
  await t.test('the compiled live provider leaves unobservable and unknown sources nil without querying settings', async () => {
    assert.deepEqual(await run({ liveAssistiveStates: true }), {
      voiceControl: null, fullKeyboardAccess: null, 'unknown-fixture-source': null,
    });
  });
  await t.test('the production registrar accepts renderer reads and validates restore through fake stdin', async () => {
    const fixture = join(root, 'wire-inventory.json'), nonce = 'a'.repeat(64);
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    await writeFile(fixture, JSON.stringify({
      apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
      windows: [{ windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', app: 'Fixture', title: 'Fixture', bounds: frame }],
      trees: { '7': { AXRole: 'AXWindow', AXTitle: 'Fixture', frame, children: [{ AXRole: 'AXGroup', frame }] } },
    }));
    const binding = { windowId: '7', processStart: '1.2' };
    const messages = [
      ['ping', {}], ['getAXState', { ...binding, args: [{ renderer: true, lease: wireLease }] }],
      ['rendererRestore', { args: [{ lease: wireLease }] }],
      ['getAXState', { ...binding, args: [{ renderer: true, lease: { ...wireLease, pid: 43 } }] }],
      ['getAXState', { ...binding, args: [{ renderer: true }] }],
      ['getAXState', { ...binding, renderer: true, lease: wireLease }],
      ['getAXState', binding], ['health', {}],
    ].map(([method, params], index) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
      id: index + 1, method, params, deadline: Date.now() + 30000 }));
    const reply = await child(binary, ['--fixture', fixture], messages.map(row => JSON.stringify(row) + '\n').join(''), { SLEIGHT_DRIVER_NONCE: nonce });
    assert.equal(reply.code, 0, reply.stderr);
    const replies = reply.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.length, 8); assert.ok(replies[0].result.methods.includes('rendererRestore'));
    assert.equal(replies[1].ok, true); assert.equal(replies[1].result.rendererAttributeChanged, false);
    assert.ok(replies[1].result.rendererNotes.includes('activation-recovery-unavailable'));
    assert.equal(replies[2].result.restored, true); // Default fixture startup has no store and can never activate.
    assert.equal(replies[3].error.code, 'IDENTITY_CHANGED');
    assert.equal(replies[4].error.code, 'INVALID_PARAMS'); assert.equal(replies[5].error.code, 'INVALID_PARAMS');
    assert.equal(replies[6].ok, true); assert.equal(replies[6].result.rendererAttributeChanged, undefined);
    assert.deepEqual(replies[6].result.renderer, { web: false, thin: true, complete: true });
    assert.deepEqual(replies[7].result.rendererRecovery, { available: false });
  });
  await t.test('wire read activates only after a matching parent lease and reports its mutation', async () => {
    const result = await run({ wire: true, wireEnd: true, attributes: off, growTree: true });
    assert.equal(result.error, undefined); assert.equal(result.elements, 509);
    assert.equal(result.rendererAttributeChanged, true);
    assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
    assert.deepEqual(result.records, []); assert.equal(result.leaseEnd.restored, true);
    assert.equal(result.leaseEnd.token, wireLease.token);
    assert.ok(result.methods.includes('rendererRestore'));
  });
  await t.test('combined fake capture uses the renderer tree and retains the mutation result', async () => {
    const result = await run({ wire: true, combined: true, attributes: off, growTree: true });
    assert.equal(result.error, undefined); assert.equal(result.elements, 509);
    assert.equal(result.rendererAttributeChanged, true);
    assert.equal(result.screenshot.mimeType, 'image/png'); assert.equal(result.capture.status, 'ok');
    assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
  });
  await t.test('a matching lease on a complete tree reports no attribute change', async () => {
    const result = await run({ wire: true, field: true, attributes: off, wireEnd: true });
    assert.equal(result.error, undefined); assert.equal(result.rendererAttributeChanged, false);
    assert.deepEqual(result.writes, []); assert.equal(result.leaseEnd.restored, true);
  });
  await t.test('an ignored enable write reports no attribute change', async () => {
    const result = await run({ wire: true, attributes: off, ignoreEnable: true });
    assert.equal(result.error, undefined); assert.equal(result.rendererAttributeChanged, false);
    assert.deepEqual(result.writes, [[manual, true]]);
    assert.deepEqual(result.records, []); assert.deepEqual(result.pendingRestore, []);
  });
  for (const field of Object.keys(wireLease)) {
    await t.test(`wire activation refuses a missing lease ${field}`, async () => {
      const missing = { ...wireLease }; delete missing[field];
      const result = await run({ wire: true, wireLease: missing, attributes: off });
      assert.equal(result.error, 'INVALID_PARAMS'); assert.deepEqual(result.writes, []);
    });
  }
  for (const [field, value] of [['pid', 43], ['processStart', '1.3'], ['bundleId', 'other.fixture']]) {
    await t.test(`wire activation rechecks mismatched ${field} in the helper`, async () => {
      const result = await run({ wire: true, wireLease: { ...wireLease, [field]: value }, attributes: off });
      assert.equal(result.error, 'IDENTITY_CHANGED'); assert.deepEqual(result.writes, []);
    });
  }
  for (const input of [{ omitRenderer: true }, { omitLease: true }, { renderer: false }, { renderer: 1 },
    { wireLease: { ...wireLease, token: '' } }, { wireLease: { ...wireLease, extra: true } }]) {
    await t.test(`wire activation refuses incomplete controls ${JSON.stringify(input)}`, async () => {
      const result = await run({ wire: true, attributes: off, ...input });
      assert.equal(result.error, 'INVALID_PARAMS'); assert.deepEqual(result.writes, []);
    });
  }
  for (const patch of [{ pid: 43 }, { processStart: '1.3' }, { bundleId: 'other.fixture' }]) {
    await t.test(`lease-end restore refuses a different registered identity ${JSON.stringify(patch)}`, async () => {
      const result = await run({ wire: true, wireEnd: true, field: true, restoreLease: { ...wireLease, ...patch } });
      assert.equal(result.error, 'IDENTITY_CHANGED'); assert.deepEqual(result.writes, []);
    });
  }



  await t.test('startup creates missing state parents and exposes an empty recovery report', async () => {
    const stateDirectory = join(root, 'new-home', 'Library', 'Application Support', 'sleight', 'runtime');
    const result = await run({ stateDirectory, startup: true, noLease: true });
    assert.equal(result.error, undefined); assert.equal(result.startupRecovery.complete, true);
    assert.deepEqual(result.startupRecovery.remaining, []);
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDirectory, 'renderer-restore'))).mode & 0o777, 0o700);
  });
  await t.test('startup refuses a symlink in a state parent without creating outside it', async () => {
    const target = await mkdtemp(join(root, 'startup-target-')), linkPath = join(root, 'startup-link');
    await symlink(target, linkPath);
    const result = await run({ stateDirectory: join(linkPath, 'runtime'), startup: true, noLease: true });
    assert.equal(result.error, 'INVALID_PARAMS'); assert.deepEqual(await readdir(target), []);
  });
  await t.test('the headless recovery entry point refuses an arbitrary absolute directory', async () => {
    const stateDirectory = await mkdtemp(join(root, 'entry-'));
    const result = await child(binary, ['--restore-renderer', stateDirectory]);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).error, 'INVALID_PARAMS');
    assert.deepEqual(await readdir(stateDirectory), []);
  });
  await t.test('the recovery command rejects a relative state directory', async () => {
    const result = await child(binary, ['--restore-renderer', 'relative']);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error, 'INVALID_PARAMS');
  });
  await t.test('a second store remains healthy and cannot mutate the active recovery directory', async () => {
    const result = await run({ lockConflict: true, attributes: off });
    assert.equal(result.error, undefined);
    assert.equal(result.walks, 2); assert.deepEqual(result.writes, []);
    assert.ok(result.notes.includes('activation-recovery-unavailable'));
  });
  await t.test('a lease with no-op recovery callbacks cannot activate', async () => {
    const result = await run({ attributes: off, noOpCallbacks: true, webRenderer: true });
    assert.equal(result.error, undefined); assert.equal(result.nodes, 11);
    assert.deepEqual(result.writes, []); assert.deepEqual(result.records, []);
    assert.ok(result.notes.includes('activation-recovery-unavailable'));
  });
  for (const options of [{ exited: true }, { liveStart: '9.9' }]) await t.test(`recovery prunes exited process records: ${JSON.stringify(options)}`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'stale-'));
    const killed = await child(binary, [], JSON.stringify({ stateDirectory, attributes: off, persistentApp: true, killAfterWrite: true }) + '\n');
    assert.equal(killed.signal, 'SIGKILL');
    const result = await run({ stateDirectory, persistentApp: true, recoverOnly: true, ...options });
    assert.equal(result.consumed, 0); assert.deepEqual(result.writes, []); assert.equal(result.records.length, 0);
    assert.equal(result.attributes[manual], true);
    assert.equal(result.recoveryReport.pruned, 1); assert.equal(result.recoveryReport.failed, 0);
    assert.equal(result.recoveryReport.retained, 0); assert.equal(result.recoveryExit, 0);
    assert.equal(result.events.some(row => row.startsWith('recover-read:')), false);
    assert.equal(runtimeRendererRecords({ directory: join(stateDirectory, 'renderer-restore') }), '0 record(s)');
  });
  for (const options of [{ liveBundle: 'replacement.app' }]) await t.test(`startup retains changed bundle identity: ${JSON.stringify(options)}`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'changed-identity-'));
    const killed = await child(binary, [], JSON.stringify({ stateDirectory, attributes: off,
      persistentApp: true, killAfterWrite: true }) + '\n');
    assert.equal(killed.signal, 'SIGKILL');
    const result = await run({ stateDirectory, persistentApp: true, startup: true, noLease: true, health: true, ...options });
    assert.deepEqual(result.writes, []); assert.equal(result.attributes[manual], true);
    assert.equal(result.records.length, 1); assert.equal(result.recoveryExit, 0);
    assert.equal(result.recoveryReport.retained, 1); assert.equal(result.recoveryReport.failed, 0);
    assert.deepEqual(result.startupRecovery.remaining, [{ pid: 42, processStart: '1.2', bundleId: 'test.fixture',
      attribute: manual, reason: 'recovery-disabled' }]);
    assert.match(runtimeRendererRecords({ directory: join(stateDirectory, 'renderer-restore') }), /automatic recovery disabled/);
    assert.equal(result.events.some(row => row.startsWith('recover-read:')), false);
    assert.deepEqual(result.health.rendererRecovery, result.startupRecovery);
  });


  for (const kind of ['invalid-json', 'unknown-attribute', 'symlink', 'public-mode', 'mode-0000', 'socket', 'fifo', 'hard-link', 'oversize', 'filename-mismatch', 'directory', 'newline-start']) await t.test(`unsafe undo data is quarantined without poisoning reads: ${kind}`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'unsafe-'));
    const directory = join(stateDirectory, 'renderer-restore'); await mkdir(directory, { mode: 0o700 });
    const file = join(directory, `renderer-42-1.2-${manual}.json`);
    if (kind === 'symlink') {
      const target = join(stateDirectory, 'target.json'); await writeFile(target, '{}', { mode: 0o600 });
      await symlink(target, file);
    } else if (kind === 'directory') {
      await mkdir(file, { mode: 0o700 });
    } else if (kind === 'socket') {
      const server = createServer();
      // A short owned socket path avoids macOS's sockaddr_un length limit.
      const socketPath = join(await mkdtemp('/tmp/rt10e-sock-'), 's');
      t.after(() => rm(socketPath.substring(0, socketPath.lastIndexOf('/')), { recursive: true, force: true }));
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      t.after(() => new Promise(resolve => server.close(resolve)));
      await rename(socketPath, file);
    } else if (kind === 'fifo') {
      const made = await child('/usr/bin/mkfifo', ['-m', '600', file]);
      assert.equal(made.code, 0, made.stderr);
    } else {
      await writeFile(file, kind === 'invalid-json' ? '{' : kind === 'oversize' ? 'x'.repeat(1025) : JSON.stringify({ pid: 42,
        processStart: kind === 'filename-mismatch' ? '2.3' : kind === 'newline-start' ? '1.2\n' : '1.2', bundleId: 'test.fixture',
        attribute: kind === 'unknown-attribute' ? 'AXFocused' : manual, original: false }), { mode: 0o600 });
      if (kind === 'public-mode') await chmod(file, 0o644);
      if (kind === 'mode-0000') await chmod(file, 0o000);
      if (kind === 'hard-link') await link(file, join(stateDirectory, 'linked-record'));
    }
    const result = await run({ stateDirectory, recoverOnly: true });
    assert.equal(result.error, undefined); assert.equal(result.consumed, 0);
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 0);
    assert.equal(result.recoveryReport.quarantined, 1);
    assert.equal(result.recoveryReport.complete, true); assert.equal(result.recoveryExit, 0);
    assert.equal(result.canActivate, true);
    const entries = await readdir(directory);
    assert.equal(entries.filter(n => n.startsWith('.quarantine-')).length, 1);
    if (kind === 'hard-link') assert.ok((await stat(join(stateDirectory, 'linked-record'))).size > 0);
  });
  for (const part of ['state', 'restore']) await t.test(`an unrelated 0755 ${part} directory is refused without chmod`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'permissions-'));
    const directory = part === 'state' ? stateDirectory : join(stateDirectory, 'renderer-restore');
    if (part === 'restore') await mkdir(directory);
    await chmod(directory, 0o755);
    const result = await run({ stateDirectory, recoverOnly: true });
    assert.equal(result.error, 'INVALID_PARAMS'); assert.equal((await stat(directory)).mode & 0o777, 0o755);
  });
  await t.test('only the runtime state directory receives the 0755 repair', async () => {
    const stateDirectory = await mkdtemp(join(root, 'runtime-mode-')); await chmod(stateDirectory, 0o755);
    const result = await run({ stateDirectory, recoverOnly: true, runtimeDirectory: true });
    assert.equal(result.error, undefined); assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  });
  for (const mode of [0o750, 0o777]) await t.test(`runtime mode ${mode.toString(8)} is refused without chmod`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'runtime-unsafe-')); await chmod(stateDirectory, mode);
    const result = await run({ stateDirectory, recoverOnly: true, runtimeDirectory: true });
    assert.equal(result.error, 'INVALID_PARAMS'); assert.equal((await stat(stateDirectory)).mode & 0o777, mode);
  });
  for (const part of ['state', 'ancestor', 'restore']) await t.test(`a symlinked ${part} directory is refused before recovery`, async () => {
    const actual = await mkdtemp(join(root, 'actual-'));
    let stateDirectory;
    if (part === 'restore') {
      stateDirectory = await mkdtemp(join(root, 'symlink-'));
      await symlink(actual, join(stateDirectory, 'renderer-restore'));
    } else {
      const alias = join(root, `alias-${part}`); await symlink(actual, alias);
      if (part === 'ancestor') await mkdir(join(actual, 'state'), { mode: 0o700 });
      stateDirectory = part === 'ancestor' ? join(alias, 'state') : alias;
    }
    const result = await run({ stateDirectory, recoverOnly: true });
    assert.equal(result.error, 'INVALID_PARAMS'); assert.equal(result.unhealthy, false);
    assert.match(result.message, /symlink|directory/i); assert.deepEqual(result.writes, []);
  });
  async function seed(stateDirectory, records) {
    const directory = join(stateDirectory, 'renderer-restore');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(stateDirectory, 'fake-attributes.json'), JSON.stringify({ [manual]: true, [enhanced]: true }));
    for (const record of records) await writeFile(join(directory,
      `renderer-${record.pid}-${record.processStart}-${record.attribute}.json`), JSON.stringify(record), { mode: 0o600 });
  }
  const undo = { pid: 42, processStart: '1.2', bundleId: 'test.fixture', attribute: manual, original: false };
  await t.test('a planted running-app record passes real restore, runtime selection and safety lease endings', async () => {
    const stateDirectory = await mkdtemp(join(root, 'retained-wiring-'));
    await seed(stateDirectory, [undo]);
    const fakeWindow = { windowId: '7', ...wireLease, app: 'Fixture', title: 'Fixture', identityVerified: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 } };
    delete fakeWindow.token;
    const requests = [], reports = [];
    let releases = 0, restarts = 0, actions = 0;
    const driver = {
        async ping() { return { build: 'a'.repeat(64), methods: ['localTool'] }; },
        async request(method, params) {
          if (method === 'inputGateState') return { enabled: true };
          requests.push(method);
          if (method === 'resolveApp') return { app: { id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }, windows: [fakeWindow] };
          if (method === 'verifyWindowIdentity') return { window: fakeWindow };
          if (method === 'ping') return { methods: ['localTool'] };
          if (method === 'localTool') {
            assert.equal(params.args[0], 'select-window.js'); actions++; return { ok: true };
          }
          const input = { stateDirectory, liveUnknownAssistive: true, persistentApp: true };
          if (method === 'rendererRestore') {
            const result = await run({ ...input, restoreFresh: true, restoreLease: params.args[0].lease });
            assert.equal(result.error, undefined); assert.deepEqual(result.writes, []);
            assert.equal(result.leaseEnd.restored, true); assert.equal(result.leaseEnd.retained, 1);
            assert.equal(result.leaseEnd.recovery.failed, 0); reports.push(result.leaseEnd);
            return result.leaseEnd;
          }
          assert.equal(method, 'getAXState');
          const result = await run({ ...input, wire: true, wireLease: params.args[0].lease, field: true });
          assert.equal(result.error, undefined); assert.deepEqual(result.writes, []);
          return result;
        },
        async restart() { restarts++; }, async close() {},
      };
    // The local action uses only this fake driver. Production input keeps its
    // capability refusal; the real factory pins and binds this test registrar.
    const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
    const runtime = createOwnRuntime({
      driver, inputRegistrar,
      lease: { acquire: () => leaseKey(macLeaseTarget(fakeWindow)), renew() {}, grant: () => ({ token: wireLease.token }),
        renewGrant() {}, release() { releases++; }, close() {} },
      approve: () => true, policy: () => ({ allow: true }),
      permissions: { app() {}, page() {}, sitesLimited: () => false },
      targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
      rendererLog: line => assert.fail(line), localToolOptions: { fallback: () => assert.fail('no live fallback') },
    });
    try {
      for (let turn = 0; turn < 2; turn++) {
        await runtime.safety.request('getApp', { selector: 'Fixture' });
        const result = await runtime.safety.request('getAXState', { windowId: '7', processStart: '1.2' });
        assert.ok(result.text.includes('Fixture'));
        const action = await runtime.localServices.localTools.call('select_window', { app: 'Fixture', title: 'Fixture' },
          async () => true, undefined, { appId: 'test.fixture' });
        assert.notEqual(action.isError, true);
        await runtime.safety.endTurn();
        assert.equal(releases, turn + 1);
      }
      assert.equal(restarts, 0); assert.equal(actions, 2); assert.equal(reports.length, 2);
      assert.equal(requests.filter(method => method === 'getAXState').length, 4);
      assert.equal((await readdir(join(stateDirectory, 'renderer-restore'))).filter(name => name.endsWith('.json')).length, 1);
    } finally { await runtime.close(); }
  });
  for (const unavailable of ['held-lock', 'invalid-directory']) await t.test(`${unavailable} permits two real runtime turn endings`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'unavailable-wiring-'));
    if (unavailable === 'invalid-directory') await chmod(stateDirectory, 0o750);
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    const fixture = join(root, `inventory-${unavailable}.json`);
    await writeFile(fixture, JSON.stringify({
      apps: [{ id: 'test.fixture', name: 'Fixture', pid: 42, processStart: '1.2' }],
      windows: [{ windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', app: 'Fixture', title: 'Fixture', bounds: frame }],
      trees: { '7': { AXRole: 'AXWindow', AXTitle: 'Fixture', frame, children: [{ AXRole: 'AXGroup', frame }] } },
    }));
    const window = { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', bounds: frame };
    function instance() {
      let starts = 0, releases = 0;
      const reports = [], diagnostics = [];
      const client = createMacDriverClient({ requiredMethods: ['rendererRestore', 'getAXState'],
        prepare: async () => ({ status: 'ready', spawn({ nonce }) {
          starts++;
          return spawn(binary, ['--fixture', fixture], { stdio: ['pipe', 'pipe', 'pipe'], env: {
            ...process.env, SLEIGHT_DRIVER_NONCE: nonce, SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory,
          } });
        } }), diagnostics: line => diagnostics.push(line),
      });
      const runtime = createOwnRuntime({ driver: { ...client, async request(method, params, options) {
        const reply = await client.request(method, params, options);
        if (method === 'rendererRestore') reports.push(reply);
        return reply;
      } }, lease: {
        acquire: () => leaseKey(macLeaseTarget(window)), renew() {}, grant: () => ({ token: wireLease.token }),
        renewGrant() {}, release() { releases++; }, close() {},
      }, approve: () => true, policy: () => ({ allow: true }),
      permissions: { app() {}, page() {}, sitesLimited: () => false },
      targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }], rendererLog: line => assert.fail(line) });
      return { runtime, client, reports, diagnostics, counts: () => ({ starts, releases }) };
    }
    const owner = unavailable === 'held-lock' ? instance() : undefined;
    const second = instance();
    try {
      if (owner) {
        await owner.runtime.safety.request('getApp', { selector: 'Fixture' });
        assert.equal((await owner.client.request('health', {})).rendererRecovery.complete, true);
      }
      for (let turn = 0; turn < 2; turn++) {
        await second.runtime.safety.request('getApp', { selector: 'Fixture' });
        const result = await second.runtime.safety.request('getAXState', { windowId: '7', processStart: '1.2' });
        assert.equal(result.rendererAttributeChanged, false);
        assert.ok(result.rendererNotes.includes('activation-recovery-unavailable'));
        await second.runtime.safety.endTurn();
      }
      assert.deepEqual(second.counts(), { starts: 1, releases: 2 });
      assert.equal(second.reports.length, 2);
      for (const report of second.reports) {
        assert.equal(report.restored, true); assert.equal(report.retained, 0);
        assert.deepEqual(report.recovery, { available: false });
      }
      const health = await second.client.request('health', {});
      if (owner) {
        assert.equal(health.rendererRecovery.complete, false);
        assert.equal(second.diagnostics.length, 1);
        assert.match(second.diagnostics[0], /^sleight: renderer recovery: /);
        const startup = JSON.parse(second.diagnostics[0].slice('sleight: renderer recovery: '.length));
        assert.equal(startup.complete, false); assert.equal(startup.failed, 0);
        assert.equal(startup.retained, 0); assert.deepEqual(startup.remaining, []);
        assert.deepEqual(owner.diagnostics, []);
      } else {
        assert.deepEqual(health.rendererRecovery, { available: false });
        assert.deepEqual(second.diagnostics, ['sleight: renderer recovery state unavailable; activation disabled.']);
      }
      assert.deepEqual((await readdir(stateDirectory)).filter(name => name.endsWith('.json')), []);
      if (owner) {
        assert.deepEqual((await readdir(join(stateDirectory, 'renderer-restore'))).filter(name => name.endsWith('.json')), []);
        await owner.runtime.safety.endTurn();
        assert.deepEqual(owner.counts(), { starts: 1, releases: 1 });
      }
    } finally {
      await second.runtime.close();
      await owner?.runtime.close();
    }
  });
  await t.test('the raw AX write canary detects a mutation without calling macOS', async () => {
    assert.equal((await run({ axWriteCanary: true })).rawAXWrites, 1);
  });
  await t.test('recovery issues zero AX writes through every entry and scan outcome', async () => {
    // recover has no AX provider parameter. The global interceptor also catches
    // any future direct AX call, and the canary above proves it can fail.

    for (const options of [
      { recoverOnly: true }, { startup: true }, { leaseEndOnly: true },
      { wire: true, wireEnd: true }, { wire: true, wireEnd: true, combined: true },
      { lockConflict: true }, { restoreFresh: true, restoreLease: wireLease },
      { recoverOnly: true, exited: true }, { recoverOnly: true, liveStart: '9.9' },
      { recoverOnly: true, processError: 'EIO' }, { recoverOnly: true, openError: 'EMFILE' },
      { recoverOnly: true, recoveryBudget: 0 }, { recoverOnly: true, cancelBeforeRecovery: true },
    ]) {
      const stateDirectory = await mkdtemp(join(root, 'zero-ax-'));
      await seed(stateDirectory, [undo, { ...undo, attribute: enhanced }]);
      const result = await run({ stateDirectory, attributes: off, ...options });
      assert.deepEqual(result.writes, [], JSON.stringify(options));
      assert.equal(result.rawAXWrites, 0, JSON.stringify(options));
      if (options.wire) {
        assert.equal(result.error, undefined); assert.equal(result.elements, 2);
        assert.ok(result.rendererNotes.includes('activation-recovery-unavailable'));
        assert.equal(result.leaseEnd.restored, true); assert.equal(result.leaseEnd.retained, 2);
      }
      assert.equal(result.events.some(event => /^(read|settable|write|assistive):/.test(event)), false);
      if (result.recoveryReport) assert.equal(result.recoveryReport.restored, 0);
    }
    const stateDirectory = await mkdtemp(join(root, 'zero-ax-cli-'));
    await seed(stateDirectory, [undo]);
    const appFile = join(stateDirectory, 'fake-attributes.json');
    const before = await readFile(appFile);
    const result = await child(binary, ['--restore-renderer', stateDirectory], '',
      { SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory });
    assert.equal(result.code, 0); assert.doesNotMatch(result.stderr, /renderer-fixture-AX-write/);
    assert.equal(JSON.parse(result.stdout).restored, 0);
    assert.equal(JSON.parse(result.stdout).retained, 1); assert.deepEqual(await readFile(appFile), before);
  });
  for (const attribute of [manual, enhanced]) {
    // Display preferences aren't a source any more, so a fake "display: true" must not veto (checked below).
    for (const technology of ['voiceOver', 'switchControl', 'voiceControl', 'fullKeyboardAccess', 'knownTool']) {
      for (const state of [true, null, 'throws']) await t.test(`${attribute} cleanup with ${technology} ${state}`, async () => {
        const result = await run({ attributes: { [attribute]: false }, webRenderer: true, assistive: { [technology]: state } });
        assert.equal(result.error, undefined);
        if (state === true) {
          assert.deepEqual(result.writes, [[attribute, true]]); assert.equal(result.records.length, 1);
          assert.ok(result.notes.includes('activation-cleanup-retained:assistive-technology-running'));
          const saved = JSON.parse(await readFile(join(result.stateDirectory, 'renderer-restore', result.records[0]), 'utf8'));
          assert.equal(saved.recoveryReason, 'assistive-technology-running');
        } else {
          assert.deepEqual(result.writes, [[attribute, true], [attribute, false]]);
          assert.deepEqual(result.records, []); assert.deepEqual(result.pendingRestore, []);
          assert.equal(result.notes.some(note => note.startsWith('activation-cleanup-retained:')), false);
        }
      });
    }
    await t.test(`${attribute} cleanup ignores display preferences`, async () => {
      const result = await run({ attributes: { [attribute]: false }, webRenderer: true, assistive: { display: true } });
      assert.equal(result.error, undefined); assert.deepEqual(result.writes, [[attribute, true], [attribute, false]]);
      assert.deepEqual(result.records, []);
    });
    for (const value of [false, null, 'changed']) await t.test(`${attribute} cleanup preserves changed value ${value}`, async () => {
      const result = await run({ attributes: { [attribute]: false }, webRenderer: true, cleanupAttribute: attribute, cleanupValue: value });
      assert.equal(result.error, undefined); assert.deepEqual(result.writes, [[attribute, true]]);
      assert.equal(result.records.length, value === false ? 0 : 1); assert.equal(result.attributes[attribute], value);
      assert.equal(result.notes.includes('activation-cleanup-retained:value-changed-since'), value !== false);
    });
  }
  await t.test('cleanup undoes its own enable with Voice Control and Full Keyboard Access unknown', async () => {
    const result = await run({ wire: true, wireEnd: true, attributes: off, liveUnknownAssistive: true });
    assert.equal(result.error, undefined); assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
    assert.equal(result.rendererNotes?.some(note => note.startsWith('activation-cleanup-retained:')) ?? false, false);
    assert.equal(result.leaseEnd.restored, true); assert.equal(result.leaseEnd.retained, 0);
    assert.deepEqual(result.records, []);
  });
  await t.test('cleanup samples assistive state after reading the current attribute', async () => {
    const result = await run({ attributes: off, assistiveAfterRead: true });
    assert.equal(result.error, undefined); assert.deepEqual(result.writes, [[manual, true]]);
    assert.equal(result.records.length, 1);
    assert.ok(result.notes.includes('activation-cleanup-retained:assistive-technology-running'));
  });
  for (const options of [{ fail: 'lease-after-wait' }, { revokeAfterRead: true }]) await t.test(`cleanup requires a live lease ${JSON.stringify(options)}`, async () => {
    const result = await run({ attributes: off, ...options });
    assert.deepEqual(result.writes, [[manual, true]]); assert.equal(result.records.length, 1);
    assert.equal(result.events.includes('restored:' + manual), false);
    assert.equal(result.recoveryReport.remaining[0].reason, 'lease-unavailable');
  });
  await t.test('lease-end filtering opens only its matching filename in a 514-entry bank', async () => {
    const stateDirectory = await mkdtemp(join(root, 'filtered-bank-'));
    await seed(stateDirectory, [undo, { ...undo, processStart: '7.8' },
      ...Array.from({ length: 512 }, (_, i) => ({ ...undo, pid: 1000 + i }))]);
    const result = await run({ stateDirectory, filteredScan: true });
    assert.equal(result.recordOpens, 1); assert.equal(result.processCalls, 1);
    assert.equal(result.recoveryReport.retained, 1); assert.equal(result.recoveryReport.pruned, 0);
    assert.equal(result.records.length, 514); assert.equal(result.directorySyncs, 1);
    assert.deepEqual(result.writes, []);
  });
  await t.test('a scan sync failure is reported once and disables activation', async () => {
    const stateDirectory = await mkdtemp(join(root, 'scan-sync-'));
    await seed(stateDirectory, Array.from({ length: 3 }, (_, i) => ({ ...undo, pid: 1000 + i })));
    const result = await run({ stateDirectory, recoverOnly: true, syncError: 'EIO' });
    assert.equal(result.directorySyncs, 1); assert.equal(result.recoveryReport.pruned, 3);
    assert.equal(result.recoveryReport.failed, 1); assert.equal(result.recoveryReport.complete, false);
    assert.equal(result.canActivate, false); assert.deepEqual(result.writes, []);
  });
  await t.test('a deliberately retained failed in-read cleanup also permits lease end', async () => {
    const stateDirectory = await mkdtemp(join(root, 'retained-cleanup-'));
    const read = await run({ stateDirectory, wire: true, attributes: off, webRenderer: true, fail: 'restore' });
    assert.equal(read.error, 'DRIVER_INTERNAL'); assert.equal(read.records.length, 2);
    const result = await run({ stateDirectory, restoreFresh: true, restoreLease: wireLease, liveUnknownAssistive: true });
    assert.equal(result.leaseEnd.restored, true); assert.equal(result.leaseEnd.retained, 2);
    assert.equal(result.leaseEnd.recovery.failed, 0); assert.deepEqual(result.writes, []);
  });
  await t.test('a real recovery failure still returns an unconfirmed lease end', async () => {
    const stateDirectory = await mkdtemp(join(root, 'failed-lease-end-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, restoreFresh: true, restoreLease: wireLease,
      attributes: { [manual]: true }, openError: 'EMFILE' });
    assert.equal(result.leaseEnd.restored, false); assert.equal(result.leaseEnd.retained, 0);
    assert.equal(result.leaseEnd.recovery.failed, 1); assert.equal(result.records.length, 1);
  });
  await t.test('failure to save a retention reason is diagnostic and cannot fail lease end', async () => {
    const stateDirectory = await mkdtemp(join(root, 'retained-save-fault-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, restoreFresh: true, restoreLease: wireLease,
      liveUnknownAssistive: true, saveError: 'EIO' });
    assert.equal(result.leaseEnd.restored, true); assert.equal(result.leaseEnd.retained, 1);
    assert.equal(result.leaseEnd.recovery.failed, 0); assert.equal(result.leaseEnd.recovery.reasonSaveFailed, 1);
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
    const saved = JSON.parse(await readFile(join(stateDirectory, 'renderer-restore', result.records[0]), 'utf8'));
    assert.equal(saved.recoveryReason, undefined);
  });
  await t.test('retained records with an unchanged reason avoid rewrites across three scans', async () => {
    const stateDirectory = await mkdtemp(join(root, 'retention-io-')); await seed(stateDirectory, [undo]);
    const file = join(stateDirectory, 'renderer-restore', `renderer-42-1.2-${manual}.json`);
    const first = await run({ stateDirectory, recoverOnly: true, liveUnknownAssistive: true });
    assert.equal(first.recoveryReport.retained, 1); assert.equal(first.recoveryReport.failed, 0);
    const saved = await stat(file), bytes = await readFile(file);
    for (let scan = 0; scan < 3; scan++) {
      const result = await run({ stateDirectory, recoverOnly: true, liveUnknownAssistive: true });
      assert.equal(result.recoveryReport.retained, 1); assert.equal(result.recoveryReport.failed, 0);
      const unchanged = await stat(file);
      assert.equal(unchanged.ino, saved.ino); assert.equal(unchanged.mtimeMs, saved.mtimeMs);
      assert.deepEqual(await readFile(file), bytes); assert.equal(result.directorySyncs, 0);
    }

  });
  await t.test('legacy RTW2B bundleID records remain readable', async () => {
    const stateDirectory = await mkdtemp(join(root, 'legacy-key-'));
    const { bundleId, ...record } = undo; await seed(stateDirectory, [{ ...record, bundleID: bundleId }]);
    const result = await run({ stateDirectory, recoverOnly: true });
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
  });
  await t.test('a bad record is quarantined while a live record remains inventoried', async () => {
    const stateDirectory = await mkdtemp(join(root, 'mixed-'));
    await seed(stateDirectory, [undo]);
    await writeFile(join(stateDirectory, 'renderer-restore', 'renderer-bad'), '{', { mode: 0o600 });
    const result = await run({ stateDirectory, recoverOnly: true, attributes: { [manual]: true } });
    assert.equal(result.error, undefined); assert.equal(result.consumed, 0);
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
    assert.equal((await readdir(join(stateDirectory, 'renderer-restore'))).filter(n => n.startsWith('.quarantine-')).length, 1);
  });
  await t.test('a changed unleased app record stays saved while another leased app activates', async () => {
    const stateDirectory = await mkdtemp(join(root, 'other-app-'));
    await seed(stateDirectory, [{ ...undo, pid: 77 }]);
    const result = await run({ stateDirectory, attributes: off, allRecordedLive: true });
    assert.equal(result.error, undefined); assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
    assert.equal(result.records.length, 1);
    assert.match(runtimeRendererRecords({ directory: join(stateDirectory, 'renderer-restore') }), /automatic recovery disabled/);
  });
  for (const bundleID of ['test.fixture_with_underscores', 'test.fixture+variant', '_test.fixture']) {
    await t.test(`bundle identifier ${bundleID} can activate and undo`, async () => {
      const result = await run({ attributes: off, bundleID });
      assert.equal(result.error, undefined); assert.deepEqual(result.pendingRestore, []);
      assert.deepEqual(result.writes, [[manual, true], [manual, false]]); assert.deepEqual(result.records, []);
    });
  }
  for (const bundleID of ['test/fixture', 'test.fixture\n']) await t.test('invalid bundle data never arms parent recovery', async () => {
    const result = await run({ attributes: off, bundleID });
    assert.equal(result.error, undefined); assert.equal(result.walks, 2); assert.deepEqual(result.writes, []);
    assert.deepEqual(result.pendingRestore, []); assert.equal(result.events.includes('arm:' + manual), false);
    assert.ok(result.notes.includes('activation-recovery-unavailable'));
  });
  for (const openError of ['EMFILE', 'ENFILE', 'EINTR', 'EAGAIN']) await t.test(`a transient ${openError} preserves undo for retry`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'open-error-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, recoverOnly: true, openError });
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
    assert.equal((await readdir(join(stateDirectory, 'renderer-restore'))).filter(n => n.startsWith('.quarantine-')).length, 0);
    assert.equal(result.canActivate, false);
    assert.equal(result.recoveryReport.failed, 1); assert.equal(result.recoveryReport.quarantined, 0);
    assert.equal(result.recoveryExit, 1);
    const retry = await run({ stateDirectory, recoverOnly: true });
    assert.equal(retry.consumed, 0); assert.deepEqual(retry.writes, []); assert.equal(retry.records.length, 1);
  });
  for (const operation of ['openError', 'statError', 'readError']) {
    for (const error of ['EACCES', 'EPERM', 'ENOMEM', 'EIO', 'EISDIR', 'ENXIO', 'EOPNOTSUPP']) {
      await t.test(`${operation} ${error} quarantines the entry and permits activation`, async () => {
        const stateDirectory = await mkdtemp(join(root, 'permanent-io-')); await seed(stateDirectory, [undo]);
        const result = await run({ stateDirectory, recoverOnly: true, [operation]: error });
        assert.equal(result.consumed, 0); assert.deepEqual(result.writes, []); assert.deepEqual(result.records, []);
        assert.equal(result.recoveryReport.quarantined, 1); assert.equal(result.recoveryReport.failed, 0);
        assert.equal(result.recoveryReport.complete, true); assert.equal(result.canActivate, true);
        assert.equal(result.recoveryExit, 0);
        const retry = await run({ stateDirectory, recoverOnly: true });
        assert.equal(retry.recoveryExit, 0); assert.equal(retry.recoveryReport.quarantined, 0);
      });
    }
    if (operation === 'openError') continue;
    for (const error of ['EMFILE', 'ENFILE', 'EINTR', 'EAGAIN']) {
      await t.test(`${operation} ${error} retains undo for a later retry`, async () => {
        const stateDirectory = await mkdtemp(join(root, 'transient-io-')); await seed(stateDirectory, [undo]);
        const result = await run({ stateDirectory, recoverOnly: true, [operation]: error });
        assert.equal(result.records.length, 1); assert.equal(result.recoveryReport.quarantined, 0);
        assert.equal(result.recoveryExit, 1); assert.deepEqual(result.writes, []);
        const retry = await run({ stateDirectory, recoverOnly: true });
        assert.equal(retry.consumed, 0); assert.deepEqual(retry.writes, []);
      });
    }
  }
  for (const processError of ['EACCES', 'EPERM', 'ENOMEM', 'EINTR', 'EAGAIN', 'EIO']) {
    await t.test(`proc_pidinfo ${processError} retains undo without AX or activation`, async () => {
      const stateDirectory = await mkdtemp(join(root, 'process-io-')); await seed(stateDirectory, [undo]);
      const result = await run({ stateDirectory, recoverOnly: true, processError });
      assert.equal(result.consumed, 0); assert.equal(result.records.length, 1); assert.deepEqual(result.writes, []);
      assert.equal(result.recoveryReport.pruned, 0); assert.equal(result.recoveryReport.failed, 1);
      assert.equal(result.recoveryExit, 1); assert.equal(result.canActivate, false);
      const retry = await run({ stateDirectory, recoverOnly: true });
      assert.equal(retry.consumed, 0); assert.deepEqual(retry.writes, []);
    });
  }
  await t.test('a partial proc_pidinfo result cannot prove exit even with ESRCH', async () => {
    const stateDirectory = await mkdtemp(join(root, 'partial-process-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, recoverOnly: true, processPartial: true });
    assert.equal(result.records.length, 1); assert.deepEqual(result.writes, []);
    assert.equal(result.recoveryReport.pruned, 0); assert.equal(result.recoveryReport.failed, 1);
  });
  await t.test('proc_pidinfo ESRCH prunes undo without AX', async () => {
    const stateDirectory = await mkdtemp(join(root, 'gone-process-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, recoverOnly: true, processError: 'ESRCH' });
    assert.equal(result.consumed, 0); assert.equal(result.records.length, 0); assert.deepEqual(result.writes, []);
    assert.equal(result.recoveryReport.pruned, 1); assert.equal(result.recoveryExit, 0);
    assert.deepEqual(result.recoveryReport.remaining, []);
  });
  for (const liveStart of [null, '9.9']) await t.test(`512 stale unleased records are pruned: ${liveStart}`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'many-stale-'));
    await seed(stateDirectory, [...Array.from({ length: 512 }, (_, i) => ({ ...undo, pid: 1000 + i })), undo]);
    const result = await run({ stateDirectory, recoverOnly: true, staleStart: liveStart });
    assert.equal(result.error, undefined);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.writes, []); assert.equal(result.canActivate, false);
    assert.equal(result.recoveryReport.pruned, 512);
    assert.equal(result.recoveryReport.remaining.length, 1);
    assert.equal(result.recoveryReport.restored, 0);
    assert.equal(result.directorySyncs, 1);
    assert.ok(result.clock < 0.75);
  });
  await t.test('an expired deadline leaves all 512 stale unleased records armed', async () => {
    const stateDirectory = await mkdtemp(join(root, 'expired-stale-'));
    await seed(stateDirectory, Array.from({ length: 512 }, (_, i) => ({ ...undo, pid: 1000 + i })));
    const result = await run({ stateDirectory, recoverOnly: true, noLease: true, recoveryBudget: 0 });
    assert.equal(result.consumed, 0); assert.equal(result.recoveryReport.pruned, 0);
    assert.equal(result.records.length, 512); assert.deepEqual(result.writes, []); assert.equal(result.recoveryExit, 1);
    assert.equal(result.processCalls, 0); assert.equal(result.recoveryReport.complete, false);
  });
  for (const staleStart of [null]) await t.test(`a short deadline bounds pruning a 512-record bank: ${staleStart}`, async () => {
    const stateDirectory = await mkdtemp(join(root, 'prune-budget-'));
    await seed(stateDirectory, Array.from({ length: 512 }, (_, i) => ({ ...undo, pid: 1000 + i })));
    const result = await run({ stateDirectory, recoverOnly: true, noLease: true, staleStart,
      recoveryBudget: 0.05, recoveryCheckDelay: 0.001 });
    assert.equal(result.error, undefined); assert.equal(result.consumed, 0);
    assert.ok(result.recoveryReport.pruned > 0 && result.recoveryReport.pruned < 512);
    assert.equal(result.directorySyncs, 1);
    assert.equal(result.records.length + result.recoveryReport.pruned, 512);
    assert.equal(result.recoveryReport.complete, false);
    assert.ok(result.clock <= 0.052); assert.equal(result.recoveryExit, 1); assert.deepEqual(result.writes, []);
    const retry = await run({ stateDirectory, recoverOnly: true, noLease: true, staleStart });
    assert.equal(retry.consumed, 0); assert.equal(retry.records.length, 0);
    assert.equal(retry.recoveryReport.pruned, result.records.length);
  });
  await t.test('cancellation interrupts a 512-record retention bank', async () => {
    const stateDirectory = await mkdtemp(join(root, 'prune-cancel-'));
    await seed(stateDirectory, Array.from({ length: 512 }, (_, i) => ({ ...undo, pid: 1000 + i })));
    const result = await run({ stateDirectory, recoverOnly: true, noLease: true, allRecordedLive: true,
      assistive: { voiceOver: true }, cancelAtRecoveryCheck: 12 });
    assert.equal(result.error, 'ACTION_UNSUPPORTED'); assert.equal(result.recoveryChecks, 12);
    assert.equal(result.directorySyncs, 1);
    assert.equal(result.records.length, 512);
    assert.equal(result.recoveryReport.complete, false); assert.deepEqual(result.writes, []);
  });
  await t.test('512 non-record entries share the lease-check budget', async () => {
    const stateDirectory = await mkdtemp(join(root, 'junk-')); await seed(stateDirectory, [undo]);
    for (let i = 0; i < 512; i++) await writeFile(join(stateDirectory, 'renderer-restore', `.quarantine-${i}`), 'x');
    const result = await run({ stateDirectory, recoverOnly: true, recoveryCheckDelay: 0.01 });
    assert.equal(result.recoveryReport.complete, false); assert.equal(result.canActivate, false);
    assert.ok(result.clock <= 0.77); assert.ok(result.recoveryChecks < 100);
    assert.equal(result.recoveryExit, 1);
  });
  await t.test('the inventory entry point retains matching live records without a token', async () => {
    const stateDirectory = await mkdtemp(join(root, 'supervisor-')); await seed(stateDirectory, [undo]);
    const result = await child(binary, ['--restore-renderer', stateDirectory], '',
      { SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.restored, 0); assert.equal(report.retained, 1); assert.equal(report.skipped, 0); assert.equal(report.quarantined, 0);
    assert.equal(report.failed, 0); assert.equal(report.complete, true);
  });
  await t.test('the inventory entry point reports quarantine separately from retention', async () => {
    const stateDirectory = await mkdtemp(join(root, 'supervisor-bad-')); await seed(stateDirectory, [undo]);
    await writeFile(join(stateDirectory, 'renderer-restore', 'renderer-bad'), '{', { mode: 0o600 });
    const result = await child(binary, ['--restore-renderer', stateDirectory], '',
      { SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory });
    assert.equal(result.code, 0);
    const { original, ...identity } = undo;
    assert.deepEqual(JSON.parse(result.stdout), { restored: 0, retained: 1, skipped: 0, quarantined: 1, pruned: 0, failed: 0,
      complete: true, remaining: [{ ...identity, reason: 'recovery-disabled' }] });
  });
  await t.test('the inventory command exits nonzero and retains a record when its open fails', async () => {
    const stateDirectory = await mkdtemp(join(root, 'supervisor-io-')); await seed(stateDirectory, [undo]);
    const result = await child(binary, ['--restore-renderer', stateDirectory], '',
      { SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory, SLEIGHT_RENDERER_FIXTURE_OPEN_ERROR: 'EMFILE' });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), { restored: 0, retained: 0, skipped: 0, quarantined: 0, pruned: 0, failed: 1, complete: false, remaining: [] });
    assert.equal((await readdir(join(stateDirectory, 'renderer-restore'))).filter(n => n.endsWith('.json')).length, 1);
  });
  await t.test('the recovery entry point prunes an exited process record', async () => {
    const stateDirectory = await mkdtemp(join(root, 'supervisor-stale-'));
    await seed(stateDirectory, [{ ...undo, pid: 99 }]);
    const result = await child(binary, ['--restore-renderer', stateDirectory], '',
      { SLEIGHT_RENDERER_FIXTURE_RUNTIME: stateDirectory });
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.restored, 0); assert.equal(report.pruned, 1); assert.equal(report.failed, 0);
    assert.deepEqual(report.remaining, []);
    assert.equal((await readdir(join(stateDirectory, 'renderer-restore'))).filter(n => n.endsWith('.json')).length, 0);
  });
  await t.test('a record with another bundle never addresses the leased PID', async () => {
    const stateDirectory = await mkdtemp(join(root, 'bundle-'));
    await seed(stateDirectory, [{ ...undo, bundleId: 'other.app' }]);
    const result = await run({ stateDirectory, recoverOnly: true });
    assert.equal(result.consumed, 0); assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
  });
  await t.test('a conflicting bundle record permits plain reads and disables activation for that PID', async () => {
    const stateDirectory = await mkdtemp(join(root, 'bundle-conflict-'));
    await seed(stateDirectory, [{ ...undo, bundleId: 'other.app' }]);
    const result = await run({ stateDirectory, attributes: off });
    assert.equal(result.error, undefined); assert.equal(result.nodes, 11); assert.equal(result.walks, 2);
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
    assert.ok(result.notes.includes('activation-recovery-unavailable'));
  });
  await t.test('a live bundle identity failure retains undo without AX', async () => {
    const stateDirectory = await mkdtemp(join(root, 'live-bundle-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, recoverOnly: true, liveBundle: 'replacement.app' });
    assert.equal(result.consumed, 0); assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
    assert.equal(result.recoveryReport.pruned, 0); assert.equal(result.recoveryReport.failed, 0);
    assert.equal(result.recoveryReport.retained, 1);
  });





  await t.test('cancellation before recovery performs no writes', async () => {
    const stateDirectory = await mkdtemp(join(root, 'cancel-before-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, recoverOnly: true, cancelBeforeRecovery: true });
    assert.equal(result.error, 'ACTION_UNSUPPORTED'); assert.equal(result.unhealthy, false);
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1);
  });
  await t.test('a revoked lease is checked before startup recovery addresses its process', async () => {
    const stateDirectory = await mkdtemp(join(root, 'lease-cancel-')); await seed(stateDirectory, [undo]);
    const result = await run({ stateDirectory, attributes: off, fail: 'lease' });
    assert.equal(result.error, 'ACTION_UNSUPPORTED'); assert.equal(result.unhealthy, false);
    assert.deepEqual(result.writes, []); assert.equal(result.records.length, 1); assert.equal(result.walks, 0);
  });


  await t.test('lease-end recovery retains an already-restored value after failed confirmation', async () => {
    const result = await run({ attributes: off, fail: 'confirm', recoverAfterRead: true });
    assert.equal(result.ownConsumed, 0); assert.equal(result.records.length, 1);
    assert.equal(result.recoveryReport.remaining[0].reason, 'recovery-disabled');
    assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
  });
  await t.test('a non-owned directory is refused before creating a restore subdirectory', async () => {
    const stateDirectory = await mkdtemp(join(root, 'foreign-owner-'));
    const before = await stat(stateDirectory);
    const result = await run({ stateDirectory, foreignOwner: true, recoverOnly: true });
    assert.equal(result.error, 'INVALID_PARAMS'); assert.equal(result.unhealthy, false);
    assert.match(result.message, /belong/); assert.deepEqual(result.writes, []);
    const after = await stat(stateDirectory);
    assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid);
    assert.deepEqual(await readdir(stateDirectory), []);
  });
  await t.test('a plain re-walk fills the tree before any attribute probe', async () => {
    const result = await run({ attributes: off, expandOnWalk: true });
    assert.equal(result.nodes, 509); assert.equal(result.walks, 2);
    assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
    assert.equal(result.events.some(e => /^(read|settable):/.test(e)), false);
  });
  await t.test('Manual alone fills the tree before Enhanced is probed', async () => {
    const result = await run({ attributes: off, activatedTree: true });
    assert.equal(result.nodes, 509); assert.equal(result.walks, 3);
    assert.deepEqual(result.attributes, off); assert.deepEqual(result.waits, [2]);
    assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
    assert.equal(result.events.includes('read:' + enhanced + ':false'), false);
    assert.ok(result.events.indexOf('arm:' + manual) < result.events.indexOf('write:' + manual + ':true'));
    assert.deepEqual(result.pendingRestore, []);
  });
  await t.test('Enhanced follows an ineffective Manual walk only for a web renderer', async () => {
    const result = await run({ attributes: off, activatedTree: true, needsEnhanced: true, webRenderer: true });
    assert.equal(result.nodes, 509); assert.equal(result.walks, 4);
    assert.deepEqual(result.waits, [2, 2]);
    assert.deepEqual(result.writes, [[manual, true], [enhanced, true], [enhanced, false], [manual, false]]);
    for (const name of [manual, enhanced]) {
      assert.ok(result.events.indexOf('read:' + name + ':true') > result.events.indexOf('write:' + name + ':true'));
      assert.ok(result.events.indexOf('arm:' + name) < result.events.indexOf('write:' + name + ':true'));
      const undo = result.events.indexOf('write:' + name + ':false');
      assert.ok(result.events.indexOf('restored:' + name) > result.events.indexOf('read:' + name + ':false', undo));
      assert.ok(result.events.indexOf('restored:' + name) > result.events.indexOf('write:' + manual + ':false'));
    }
    assert.deepEqual(result.pendingRestore, []); assert.deepEqual(result.records, []);
  });
  await t.test('a native thin window never probes Enhanced', async () => {
    const result = await run({ attributes: off });
    assert.equal(result.nodes, 11);
    assert.equal(result.events.some(e => e.includes(enhanced)), false);
    assert.deepEqual(result.writes, [[manual, true], [manual, false]]);
  });
  for (const fail of ['probe-read', 'probe-settable']) await t.test(`an unwritten ${fail} returns the plain tree with a note`, async () => {
    const result = await run({ attributes: off, fail, webRenderer: true });
    assert.equal(result.error, undefined); assert.equal(result.nodes, 11);
    assert.ok(result.notes.includes('activation-probe-failed')); assert.deepEqual(result.writes, []);
  });
  await t.test('a plain full walk expands a thin tree without attribute support or waiting', async () => {
    const result = await run({ expandOnWalk: true });
    assert.equal(result.nodes, 509); assert.equal(result.walks, 2);
    assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
  });
  await t.test('no lease permits a plain re-walk with zero attribute operations', async () => {
    const result = await run({ attributes: off, noLease: true, expandOnWalk: true });
    assert.equal(result.nodes, 509); assert.equal(result.walks, 2);
    assert.equal(result.events.some(e => /^(read|settable|write):/.test(e)), false);
  });
  for (const name of [manual, enhanced]) await t.test(`${name} alone can enable the tree`, async () => {
    const result = await run({ attributes: { [name]: false }, activatedTree: true, webRenderer: true });
    assert.equal(result.nodes, 509); assert.deepEqual(result.waits, [2]);
    assert.deepEqual(result.writes, [[name, true], [name, false]]);
  });
  await t.test('already enabled attributes are preserved and add no debounce', async () => {
    const result = await run({ attributes: { [manual]: true, [enhanced]: true }, expandOnWalk: true });
    assert.equal(result.nodes, 509); assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
    assert.deepEqual(result.attributes, { [manual]: true, [enhanced]: true });
  });
  await t.test('an existing true flag survives while the other flag is restored', async () => {
    const result = await run({ attributes: { [manual]: true, [enhanced]: false }, activatedTree: true, webRenderer: true });
    assert.equal(result.nodes, 509); assert.deepEqual(result.waits, [2]);
    assert.deepEqual(result.writes, [[enhanced, true], [enhanced, false]]);
    assert.deepEqual(result.attributes, { [manual]: true, [enhanced]: false });
  });
  await t.test('unknown or non-Boolean original values are not overwritten', async () => {
    const result = await run({ attributes: { [manual]: 0, [enhanced]: 'false' } });
    assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []); assert.equal(result.walks, 2);
  });
  await t.test('read-only attributes are not changed', async () => {
    const result = await run({ attributes: off, notSettable: true });
    assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
  });
  await t.test('a false activation readback skips the wait and removes the record without undo', async () => {
    const result = await run({ attributes: off, ignoreEnable: true });
    assert.equal(result.nodes, 11); assert.equal(result.walks, 3); assert.deepEqual(result.waits, []);
    assert.deepEqual(result.attributes, off); assert.equal(result.writes.length, 1); assert.equal(result.records.length, 0);
    assert.deepEqual(result.pendingRestore, []);
  });
  for (const input of [{ nodes: 21 }, { nodes: 11, field: true }, { nodes: 11, truncated: true }, { nodes: 11, depthLimited: true }]) {
    await t.test(`a complete field or limited/dense tree does not activate: ${JSON.stringify(input)}`, async () => {
      const result = await run({ attributes: off, ...input });
      assert.equal(result.walks, 1); assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
    });
  }
  await t.test('the thin-tree boundary includes 20 window nodes', async () => {
    const result = await run({ nodes: 20, expandOnWalk: true });
    assert.equal(result.nodes, 509); assert.equal(result.walks, 2);
  });
  await t.test('a still-thin native tree stops after the Manual retry', async () => {
    const result = await run({ attributes: off });
    assert.equal(result.nodes, 11); assert.equal(result.walks, 3); assert.deepEqual(result.waits, [2]);
  });
  await t.test('a rejected enable with the original value false leaves no record or undo write', async () => {
    const result = await run({ attributes: off, fail: 'enable-before-write' });
    assert.equal(result.error, 'AX_UNAVAILABLE'); assert.deepEqual(result.attributes, off);
    assert.deepEqual(result.writes, [[manual, true]]); assert.deepEqual(result.records, []);
    assert.deepEqual(result.pendingRestore, []); assert.equal(result.canActivate, true);
  });
  await t.test('a pre-enabled attribute in a thin tree is never owned by this read', async () => {
    const result = await run({ attributes: { [manual]: true, [enhanced]: true }, webRenderer: true });
    assert.equal(result.error, undefined); assert.equal(result.walks, 2);
    assert.deepEqual(result.writes, []); assert.deepEqual(result.records, []);
    assert.equal(result.events.some(event => event.startsWith('assistive:')), false);
    assert.deepEqual(result.attributes, { [manual]: true, [enhanced]: true });
  });
  for (const fail of ['enable', 'readback', 'wait', 'second-walk']) await t.test(`restoration survives ${fail}`, async () => {
    const result = await run({ attributes: off, fail, webRenderer: true });
    assert.ok(result.error); assert.deepEqual(result.attributes, off);
    assert.ok(result.writes.some(([name, value]) => name === manual && value === false));
  });
  await t.test('a denied lease stops before the first walk or attribute read', async () => {
    const result = await run({ attributes: off, fail: 'lease' });
    assert.equal(result.error, 'ACTION_UNSUPPORTED'); assert.equal(result.walks, 0); assert.deepEqual(result.writes, []);
  });
  await t.test('closing the window retains the record without an undo write', async () => {
    const result = await run({ attributes: off, fail: 'window-after-wait' });
    assert.equal(result.error, 'IDENTITY_CHANGED'); assert.equal(result.attributes[manual], true);
    assert.deepEqual(result.writes, [[manual, true]]); assert.equal(result.records.length, 1);
  });
  await t.test('the entire retry has an earlier deadline while its parent can still restore', async () => {
    const result = await run({ deadlineCopy: true });
    assert.equal(result.retryAllowed, false); assert.equal(result.parentAllowed, true); assert.equal(result.reserved, 1.25);
    const activated = await run({ attributes: off });
    assert.equal(activated.retryReserve, 1.25);
    const plain = await run({ noLease: true });
    assert.equal(plain.retryReserve, 0);
  });
  await t.test('PID reuse never writes to the replacement application', async () => {
    const result = await run({ attributes: off, fail: 'identity-after-wait' });
    assert.ok(result.error); assert.deepEqual(result.writes, [[manual, true]]);
    assert.equal(result.walks, 2); assert.deepEqual(result.pendingRestore, [manual]);
    assert.equal(result.records.length, 1); assert.equal(result.unhealthy, false);
  });
  await t.test('one failed restoration still attempts the other and faults', async () => {
    const result = await run({ attributes: off, fail: 'restore', webRenderer: true });
    assert.equal(result.error, 'DRIVER_INTERNAL'); assert.equal(result.unhealthy, true);
    assert.deepEqual(result.writes.slice(-2), [[enhanced, false], [manual, false]]);
    assert.equal(result.attributes[manual], false); assert.equal(result.attributes[enhanced], true);
    assert.deepEqual(result.pendingRestore, [enhanced, manual]);
  });
  await t.test('failure to arm parent recovery prevents all attribute writes', async () => {
    const result = await run({ attributes: off, fail: 'arm' });
    assert.equal(result.error, 'AX_UNAVAILABLE'); assert.deepEqual(result.writes, []); assert.deepEqual(result.attributes, off);
  });
  await t.test('unacknowledged restoration leaves recovery armed and faults', async () => {
    const result = await run({ attributes: off, fail: 'confirm', webRenderer: true });
    assert.equal(result.error, 'DRIVER_INTERNAL'); assert.equal(result.unhealthy, true);
    assert.deepEqual(result.attributes, off); assert.deepEqual(result.pendingRestore, [enhanced, manual]);
  });
  await t.test('confirmation after the deadline follows every AX undo', async () => {
    const result = await run({ attributes: off, fail: 'slow-confirm', remaining: 10, webRenderer: true });
    assert.equal(result.error, undefined); assert.deepEqual(result.attributes, off);
    assert.deepEqual(result.pendingRestore, []); assert.deepEqual(result.records, []);
    assert.ok(result.events.indexOf('write:' + manual + ':false') < result.events.indexOf('restored:' + enhanced));
  });
  for (const [remaining, writes] of [[4.74, []], [4.75, [[manual, true], [manual, false]]]]) {
    await t.test(`activation reserves the complete walk and cleanup budget at ${remaining} s`, async () => {
      const result = await run({ attributes: off, remaining });
      assert.equal(result.error, undefined); assert.deepEqual(result.writes, writes);
      assert.deepEqual(result.attributes, off); assert.deepEqual(result.records, []);
      if (!writes.length) assert.ok(result.notes.includes('activation-budget-skipped'));
    });
  }
  await t.test('a short remaining deadline never starts activation', async () => {
    const result = await run({ attributes: off, remaining: 2.4 });
    assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []); assert.equal(result.walks, 2);
  });
  await t.test('the core adapter binds the lease and retains only the final tree element map', async () => {
    const result = await run({ adapter: true, attributes: off });
    assert.equal(result.error, undefined); assert.equal(result.readId, 3);
    assert.match(result.text, /container Renderer/); assert.equal(result.elements, 2);
    assert.deepEqual(result.attributes, off);
  });
  await t.test('the core re-walk reads all 509 actual fake nodes after activation', async () => {
    const result = await run({ adapter: true, attributes: off, growTree: true });
    assert.equal(result.readId, 3); assert.equal(result.elements, 509);
    assert.match(result.text, /508 text entry area Editor/); assert.deepEqual(result.attributes, off);
    assert.deepEqual(result.waits, [2]);
  });
  await t.test('menu-bar nodes do not hide a thin application tree', async () => {
    const result = await run({ adapter: true, attributes: off, menu: true });
    assert.equal(result.readId, 3); assert.equal(result.elements, 28);
    assert.deepEqual(result.waits, [2]); assert.deepEqual(result.attributes, off);
  });
  for (const options of [{ field: true }, { secure: true }, { depth: 0 }]) await t.test(`the adapter honors fields and intentional limits: ${JSON.stringify(options)}`, async () => {
    const result = await run({ adapter: true, attributes: off, ...options });
    assert.equal(result.readId, 1); assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
  });
  await t.test('default providers in fixture mode never access a real AX application', async () => {
    const result = await run({ adapter: true, attributes: off, defaultProviders: true });
    assert.equal(result.readId, 2); assert.deepEqual(result.writes, []); assert.deepEqual(result.waits, []);
  });
  await t.test('the adapter passes a generic web role to the Enhanced gate', async () => {
    const result = await run({ adapter: true, attributes: off, webRenderer: true });
    assert.equal(result.readId, 4); assert.deepEqual(result.waits, [2, 2]);
    assert.deepEqual(result.writes, [[manual, true], [enhanced, true], [enhanced, false], [manual, false]]);
  });
  for (const fail of ['probe-read', 'probe-settable']) await t.test(`the adapter retains its plain map on ${fail}`, async () => {
    const result = await run({ adapter: true, attributes: off, fail });
    assert.equal(result.error, undefined); assert.equal(result.readId, 2); assert.equal(result.elements, 2);
    assert.ok(result.rendererNotes.includes('activation-probe-failed')); assert.deepEqual(result.writes, []);
  });
  await t.test('the core adapter rejects another process lease before attribute access', async () => {
    const result = await run({ adapter: true, wrongLease: true, attributes: off });
    assert.equal(result.error, 'IDENTITY_CHANGED'); assert.deepEqual(result.writes, []);
  });
  await t.test('the core adapter rejects a mismatched bundle before attribute access', async () => {
    const result = await run({ adapter: true, wrongBundleLease: true, attributes: off });
    assert.equal(result.error, 'IDENTITY_CHANGED'); assert.deepEqual(result.writes, []);
  });
});
