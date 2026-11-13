import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { macDriverSource } from '../../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacDriverClient } from '../../plugins/sleight/lib/mac-driver/client.mjs';
import { appleToolsPresent } from '../../plugins/sleight/lib/direct-browser/host.mjs';
import { macCommandSkip } from '../requirements.mjs';

let root, binary;
// Explicit readable window metadata for local-input fixtures. Tests for missing
// state pass an empty bank instead; native providers are never consulted.
export function localSpaceFixture(pid = 42, appId = 'org.test.fixture', {
  windowId = '7', processStart = 'fixture-start', title = 'Fixture',
  bounds = { x: 0, y: 0, width: 300, height: 200 },
} = {}) {
  return { apps: [{ id: appId, name: 'Fixture', pid, processStart }],
    displays: [{ ...bounds }],
    windows: [{ windowId, pid, processStart, bundleId: appId,
      title, bounds: { ...bounds }, onScreen: true, layer: 0, hidden: false }],
    trees: { [windowId]: { AXRole: 'AXWindow', AXTitle: title, AXMinimized: false, AXFullScreen: false,
      AXWindowNumber: Number(windowId), pid, frame: { ...bounds } } } };
}
// Explicit opt-in for admitted input tests. nativeLocal never fills in missing
// bindings, so refusal fixtures still exercise the caller's exact arguments.
export function localInputFixture(identity = { ...localSpaceFixture().windows[0], identityVerified: true }) {
  const spaceInventory = localSpaceFixture(identity.pid, identity.bundleId, identity);
  const lease = { path: '/fixture/lease.json', token: 'owned' };
  return {
    args: { appId: identity.bundleId, pid: identity.pid, processStart: identity.processStart,
      driverIdentity: identity, lease },
    fixture: { spaceInventory,
      apps: [{ name: 'Fixture', appId: identity.bundleId, pid: identity.pid, processStart: identity.processStart }],
      driverIdentities: [identity], focusedWindowId: identity.windowId,
      lease: { token: lease.token, expires: Date.now() + 30000,
        window: { appId: identity.bundleId, title: identity.title, windowNumber: Number(identity.windowId), url: null } } },
  };
}
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
export const localBackends = process.platform === 'darwin' ? ['script', 'driver'] : ['script'];
// xcrun's shim can exist without the tools. Check the selected developer tree
// before xcrun so a missing installation cannot raise an install dialog.
export async function nativeToolsRequirement({ command = macCommandSkip, tools = appleToolsPresent } = {}) {
  return command('xcrun') || (!await tools() && 'requires Xcode command-line tools (xcrun swiftc unavailable)');
}
export const nativeToolsSkip = await nativeToolsRequirement();
export const localBackendSkip = backend => backend === 'driver' && nativeToolsSkip;
const hash = value => createHash('sha256').update(value).digest('hex');
const sharedCache = process.env.SLEIGHT_RT15_FIXTURE_CACHE;
// Node's isolated test children share a runner PID. A private bank for that
// runner avoids compiling once in every file during the ordinary full check.
// Runs without isolation already share this module's one prepared binary.
export function nativeToolsCache({ override = sharedCache, context = process.env.NODE_TEST_CONTEXT, parent = process.ppid,
  uid = process.getuid?.(), temporary = tmpdir() } = {}) {
  return override ?? (context?.startsWith('child') && Number.isInteger(uid)
    ? join(temporary, `sleight-rt15-runner-${uid}-${parent}`) : undefined);
}
function privateDirectory(path) {
  const info = lstatSync(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0,
    'The RT15 fixture cache must be an owned private directory');
}
function prepare() {
  assert.equal(nativeToolsSkip, false, String(nativeToolsSkip));
  if (binary) return binary;
  if (root) throw new Error('Native fixture preparation failed earlier in this file; see its first diagnostic');
  root = mkdtempSync(join(tmpdir(), 'sleight-rt15-test-'));
  const composed = macDriverSource(), at = composed.lastIndexOf('\ndriverMain()');
  assert.ok(at > 0);
  const text = composed.slice(0, at) + '\n' + readFileSync(new URL('./mac-driver-tools.swift', import.meta.url), 'utf8');
  // Explicit banks can span runner invocations. Automatic banks are confined to
  // one runner and remain eligible for sleight's ordinary temp-folder sweep.
  const cache = nativeToolsCache() ?? root;
  if (cache !== sharedCache && cache !== root) {
    try { mkdirSync(cache, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  privateDirectory(cache);
  const bank = join(cache, hash(text));
  mkdirSync(bank, { recursive: true, mode: 0o700 }); privateDirectory(bank);
  const output = join(bank, 'tools'), receipt = join(bank, 'sha256'), lock = join(bank, 'compiling');
  const limit = Date.now() + 250000;
  while (true) {
    if (existsSync(receipt)) {
      const info = lstatSync(output);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid());
      assert.equal(hash(readFileSync(output)), readFileSync(receipt, 'utf8'));
      binary = output; return binary;
    }
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.ok(Date.now() < limit, 'RT15 fixture compile lock timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    // A competing file may have published between our read and lock claim.
    if (!existsSync(receipt)) {
      const source = join(bank, 'tools.swift'), staging = join(bank, 'tools.partial');
      writeFileSync(source, text);
      const r = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', staging], {
        killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536,
      });
      assert.equal(r.status, 0, r.stderr);
      renameSync(staging, output);
      const stamp = join(bank, `sha256-${process.pid}.partial`);
      writeFileSync(stamp, hash(readFileSync(output)), { flag: 'wx', mode: 0o600 });
      renameSync(stamp, receipt);
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
  binary = output; return binary;
}
export function nativeLocal(script, args, fixture, preceding = []) {
  const r = spawnSync(prepare(), [], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000,
    input: [...preceding, { script, args, fixture }].map(JSON.stringify).join('\n') + '\n', maxBuffer: 1048576 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
export const prepareNativeToolsFixture = () => { prepare(); };
let serial = 0;
export function nativeToolsClient(fixture = {}) {
  const binary = prepare(), path = join(root, `wire-${++serial}.json`);
  writeFileSync(path, JSON.stringify(fixture));
  return createMacDriverClient({ platform: 'darwin', requiredMethods: ['ping', 'localTool'], prepare: async () => ({
    status: 'ready', spawn: ({ nonce }) => spawn(binary, ['--wire', path], {
      env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'],
    }),
  }) });
}
