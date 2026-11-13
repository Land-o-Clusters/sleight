import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, chmod, symlink, rm, mkdir, cp, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource, macDriverBuildInfo, prepareMacDriver } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { helperBuildRecipes } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { MAC_DRIVER_RELEASE_PIN, preparePrebuiltMacDriver, verifyMacDriverSignature } from '../plugins/sleight/lib/mac-driver/host.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = macDriverSource();
const expected = { sourceHash: digest(source), build: /^let driverBuild = "([a-f0-9]{64})"/.exec(source)[1] };
let fake, fakeIntel, fixtureRoot;
let driverBytes;
const hostURL = new URL('../plugins/sleight/lib/mac-driver/host.mjs', import.meta.url);
const buildURL = new URL('../plugins/sleight/lib/mac-driver/build.mjs', import.meta.url);
before(async () => {
  if (process.platform !== 'darwin') return;
  fixtureRoot = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-signing-fixture-')));
  const source = join(fixtureRoot, 'fake.c'), binary = join(fixtureRoot, 'fake');
  await writeFile(source, 'int main(void) { return 0; }\n');
  execFileSync('/usr/bin/xcrun', ['clang', '-target', 'arm64-apple-macos14.0', source, '-o', binary], { timeout: 300000, killSignal: 'SIGKILL' });
  fake = await readFile(binary);
  execFileSync('/usr/bin/xcrun', ['clang', '-target', 'x86_64-apple-macos14.0', source, '-o', binary], { timeout: 300000, killSignal: 'SIGKILL' });
  fakeIntel = await readFile(binary);
});
after(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

// Import a private package copy. Native edits, pins and bundled paths never touch
// the checkout or the user's installed plugin. All helpers stay unlaunched.
async function packageFixture(t) {
  if (!driverBytes) {
    const input = join(fixtureRoot, 'main.swift'), binary = join(fixtureRoot, 'current-driver');
    await writeFile(input, source);
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-module-name', 'GlideEngine', '-target', 'arm64-apple-macos14.0',
      '-module-cache-path', join(fixtureRoot, 'modules'), input, '-o', binary], { timeout: 600000, killSignal: 'SIGKILL', stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.sleight.glide-engine', '--timestamp=none', binary], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe' });
    driverBytes = await readFile(binary);
    assert.ok(driverBytes.includes(Buffer.from(expected.build)), 'the current source build stamp is embedded in the binary');
    t.diagnostic(`current-source optimized ad-hoc helper: ${driverBytes.length} bytes; never launched`);
  }
  const root = registerTemp(t, await mkdtemp(join(await realpath(tmpdir()), 'sleight-prebuilt-package-')));
  await cp(new URL('./native/', buildURL), join(root, 'native'), { recursive: true });
  const binary = join(root, 'prebuilt', 'darwin-arm64', 'glide-engine');
  await mkdir(join(root, 'prebuilt', 'darwin-arm64'), { recursive: true });
  await writeFile(binary, driverBytes, { mode: 0o700 });
  const hostText = (await readFile(hostURL, 'utf8'))
    .replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, hostURL).href}'`);
  const buildText = (await readFile(buildURL, 'utf8'))
    .replace(/from '(\.[^']+)'/g, (_, path) => path === './host.mjs' ? "from './host.mjs'" : `from '${new URL(path, buildURL).href}'`)
    .replace("from 'node:child_process'", "from './fake-child.mjs'")
    .replace("new URL('../direct-browser/native/peer-host.c', import.meta.url)",
      JSON.stringify(new URL('../direct-browser/native/peer-host.c', buildURL).href));
  await writeFile(join(root, 'host.mjs'), hostText);
  await writeFile(join(root, 'build.mjs'), buildText);
  await writeFile(join(root, 'fake-child.mjs'), 'export let spawns = 0; export function spawn() { spawns++; return { fake: true }; }\n');
  const moduleURL = name => new URL(name, new URL('file://' + root + '/'));
  const host = await import(moduleURL('host.mjs')), builder = await import(moduleURL('build.mjs'));
  const child = await import(moduleURL('fake-child.mjs'));
  const pin = { ...expected, arch: 'arm64', kind: 'adhoc', teamId: null,
    identifier: 'com.sleight.glide-engine', sha256: digest(driverBytes) };
  const refusals = [];
  const load = (options = {}, implementation = host.preparePrebuiltMacDriver) => implementation({ ...builder.macDriverBuildInfo(),
    arch: 'arm64', pin, allowAdHoc: true, onRefusal: reason => refusals.push(reason), ...options });
  const prepare = options => builder.prepareMacDriver({ platform: 'darwin', prebuilt: identity => load(identity), ...options });
  const variant = async (name, from, to, target = 'host') => {
    const text = target === 'host' ? hostText : buildText;
    assert.equal(text.split(from).length, 2, `mutation ${name} must replace exactly one check`);
    const file = `${target}-${name}.mjs`;
    await writeFile(join(root, file), text.replace(from, to));
    return import(moduleURL(file));
  };
  return { root, binary, builder, child, pin, refusals, load, prepare, variant };
}

function expectRefusal(f, reason, implementation) {
  f.refusals.length = 0;
  assert.equal(f.load({}, implementation), null, `${reason} must refuse`);
  assert.deepEqual(f.refusals, [reason]);
}

test('the shipping pin accepts the bundled helper for the current source',
  { skip: MAC_DRIVER_RELEASE_PIN === null || process.platform !== 'darwin' }, () => {
    assert.ok(preparePrebuiltMacDriver(macDriverBuildInfo()), 'rebuild and re-pin after any native source change');
  });

test('a current-source bundled ad-hoc helper refuses each single mutation and detects omitted checks',
  { skip: process.platform !== 'darwin' }, async t => {
    const cases = [
      { name: 'source edit', reason: 'source-hash',
        mutate: async f => {
          const path = join(f.root, 'native', 'DriverMain.swift');
          await writeFile(path, await readFile(path, 'utf8') + '\n// package changed after release\n');
        }, omit: "    if (!hash(sourceHash) || pin.sourceHash !== sourceHash) refuse('source-hash');" },
      { name: 'binary byte flip', reason: 'binary-hash',
        mutate: async f => {
          const bytes = await readFile(f.binary); bytes[4096] ^= 1; await writeFile(f.binary, bytes);
        }, omit: "      if (digest(readFileSync(binary)) !== pin.sha256) refuse('binary-hash');" },
      { name: 'wrong architecture', reason: 'architecture',
        mutate: async f => {
          await writeFile(f.binary, fakeIntel);
          execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.sleight.glide-engine', '--timestamp=none', f.binary], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe' });
          // Isolate the architecture check from the independent byte pin.
          f.pin.sha256 = digest(await readFile(f.binary));
        }, omit: "  if (tool('/usr/bin/lipo', ['-archs', binary], 'architecture').stdout.trim() !== 'arm64')\n    refuse('architecture', 'HOST_SIGNATURE_MISMATCH');" },
      { name: 'wrong identifier', reason: 'identifier',
        mutate: async f => {
          execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.other.driver', '--timestamp=none', f.binary], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe' });
          f.pin.sha256 = digest(await readFile(f.binary));
        }, omit: "  if (!stderr.split('\\n').includes('Identifier=' + pin.identifier)) refuse('identifier', 'HOST_SIGNATURE_MISMATCH');" },
      { name: 'group-writable file', reason: 'file-mode', mutate: f => chmod(f.binary, 0o720),
        omit: "      if (stat.mode & 0o022 || !(stat.mode & 0o100)) refuse('file-mode');" },
      { name: 'symlinked bundle directory', reason: 'symlink',
        mutate: async f => {
          const directory = join(f.root, 'prebuilt', 'darwin-arm64'), target = join(f.root, 'actual-arm64');
          await rename(directory, target); await symlink(target, directory);
        }, omit: "      if (stat.isSymbolicLink() || realpathSync(binary) !== binary) refuse('symlink');" },
    ];
    for (const row of cases) await t.test(row.name, async t => {
      const f = await packageFixture(t);
      assert.deepEqual(f.builder.macDriverBuildInfo(), expected);
      const host = await f.prepare({ tools: () => assert.fail('a bundled helper does not need tools'),
        prepare: () => assert.fail('an accepted bundle must bypass compilation') });
      assert.equal(host.origin, 'prebuilt'); assert.equal(host.binary, f.binary);
      assert.equal(host.build, expected.build); assert.equal(f.child.spawns, 0);
      await row.mutate(f);
      expectRefusal(f, row.reason);
      const mutant = await f.variant(row.reason, row.omit, '');
      // These are the same behavioral assertions as above. Each must fail when
      // only its check is omitted, even if a later check also refuses the file.
      let unchecked;
      assert.throws(() => expectRefusal(f, row.reason, options => unchecked = mutant.preparePrebuiltMacDriver(options)), assert.AssertionError);
      if (row.reason === 'source-hash') assert.deepEqual(f.refusals, ['build-id']);
      else if (row.reason === 'binary-hash') assert.deepEqual(f.refusals, ['signature']);
      else { assert.ok(unchecked, 'the omitted guard admits this mutation'); assert.deepEqual(f.refusals, []); }
      assert.equal(f.child.spawns, 0);
    });
  });

test('a source change between prebuilt acceptance and spawn refuses, then recompiles on preparation',
  { skip: process.platform !== 'darwin' }, async t => {
    const f = await packageFixture(t);
    const host = await f.prepare({ prepare: () => assert.fail('must accept before the edit') });
    assert.equal(host.origin, 'prebuilt');
    const path = join(f.root, 'native', 'DriverMain.swift');
    await writeFile(path, await readFile(path, 'utf8') + '\n// edited between acceptance and spawn\n');
    assert.throws(() => host.spawn({ nonce: 'a'.repeat(64) }), /HOST_SOURCE_MISMATCH/);
    assert.equal(f.child.spawns, 0, 'source recheck must run before spawn');
    const mutant = await f.variant('source-recheck', 'digest(macDriverSource()) !== identity.sourceHash || ', '', 'build');
    // The isolated builder imports a fake spawn, so even an omitted guard cannot
    // run a real helper. Prepare before restoring the source edit for the race.
    const edited = await readFile(path, 'utf8');
    await writeFile(path, edited.replace('\n// edited between acceptance and spawn\n', ''));
    const unchecked = await mutant.prepareMacDriver({ platform: 'darwin', prebuilt: identity => f.load(identity) });
    await writeFile(path, edited);
    assert.throws(() => assert.throws(() => unchecked.spawn({ nonce: 'a'.repeat(64) }), /HOST_SOURCE_MISMATCH/), assert.AssertionError);
    assert.equal(f.child.spawns, 1, 'only the fake spawn was reached by the mutant');
    let compiles = 0;
    const fallback = await f.prepare({ cached: () => true, prepare: async options => {
      compiles++;
      const directory = join(f.root, 'compiled'); await mkdir(directory, { mode: 0o700 });
      const sources = Object.fromEntries(options.inventory.files.map(row => [row.path.split('/').at(-1), row.sha256]));
      const bytes = Buffer.from('fake compiled helper');
      await writeFile(join(directory, 'glide-engine'), bytes, { mode: 0o700 });
      const record = join(directory, 'build.json');
      await writeFile(record, JSON.stringify({ protocol: 1, arch: process.arch, sources, recipes: helperBuildRecipes(sources),
        binaries: { 'glide-engine': digest(bytes) } }), { mode: 0o600 });
      return { status: 'ready', directory, record };
    } });
    assert.equal(compiles, 1); assert.equal(fallback.origin, 'source'); assert.equal(fallback.status, 'ready');
    assert.deepEqual(f.refusals, ['source-hash']);
    assert.equal(fallback.build, f.builder.macDriverBuildInfo().build);
    assert.notEqual(fallback.build, host.build);
  });

async function fixture(t, bytes = fake) {
  const root = registerTemp(t, await mkdtemp(join(await realpath(tmpdir()), 'sleight-prebuilt-')));
  const binary = join(root, 'glide-engine');
  await writeFile(binary, bytes, { mode: 0o700 });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.sleight.glide-engine', '--timestamp=none', binary], { timeout: 10000, killSignal: 'SIGKILL' });
  const pin = { ...expected, arch: 'arm64', kind: 'adhoc', teamId: null,
    identifier: 'com.sleight.glide-engine', sha256: digest(await readFile(binary)) };
  const refusals = [];
  const load = (options = {}) => preparePrebuiltMacDriver({ ...expected, arch: 'arm64', binary, pin, allowAdHoc: true,
    onRefusal: reason => refusals.push(reason), ...options });
  return { binary, pin, load, refusals };
}

test('source fallback receipts require matching source hashes and compiler recipes',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = registerTemp(t, await mkdtemp(join(await realpath(tmpdir()), 'sleight-source-receipt-')));
    for (const fault of ['none', 'missing recipe', 'changed recipe', 'changed source']) await t.test(fault, async () => {
      const prepare = async options => {
        const directory = join(root, fault); await mkdir(directory, { mode: 0o700 });
        const sources = Object.fromEntries(options.inventory.files.map(row => [row.path.split('/').at(-1), row.sha256]));
        const bytes = Buffer.from('unlaunched source fixture');
        await writeFile(join(directory, 'glide-engine'), bytes, { mode: 0o700 });
        const receipt = { protocol: 1, arch: process.arch, sources, recipes: helperBuildRecipes(sources),
          binaries: { 'glide-engine': digest(bytes) } };
        if (fault === 'missing recipe') delete receipt.recipes;
        if (fault === 'changed recipe') receipt.recipes['glide-engine'].args.push('-Onone');
        if (fault === 'changed source') receipt.sources['glide-engine.swift'] = '0'.repeat(64);
        const record = join(directory, 'build.json');
        await writeFile(record, JSON.stringify(receipt), { mode: 0o600 });
        return { status: 'ready', directory, record };
      };
      const load = () => prepareMacDriver({ platform: 'darwin', prebuilt: () => null, cached: () => true,
        tools: () => assert.fail('a cached fixture needs no tool probe'), prepare });
      if (fault === 'none') assert.equal((await load()).origin, 'source');
      else await assert.rejects(load, /HOST_PACKAGE_MISMATCH/);
    });
  });

test('an absent release pin performs no binary inspection', () => {
  assert.equal(preparePrebuiltMacDriver({ ...expected, pin: null, binary: '/does-not-exist',
    onRefusal: () => assert.fail('a disabled pin is not a refused package') }), null);
});

test('each prebuilt verification timeout refuses and falls back to source compilation', async t => {
  const root = registerTemp(t, await mkdtemp(join(await realpath(tmpdir()), 'sleight-prebuilt-timeout-')));
  const binary = join(root, 'glide-engine'), bytes = Buffer.from('synthetic signed helper');
  await writeFile(binary, bytes, { mode: 0o700 });
  const pin = { ...expected, arch: 'arm64', kind: 'adhoc', teamId: null,
    identifier: 'com.sleight.glide-engine', sha256: digest(bytes) };
  // Only tool replies are synthetic. The real package checks and builder select
  // the prebuilt receipt or compile path, and no helper is ever spawned.
  const stub = join(root, 'child.mjs');
  await writeFile(stub, `export const calls = [];
export let timeoutAt = -1;
export function reset(index) { timeoutAt = index; calls.length = 0; }
export function spawnSync(file, args, options) {
  const index = calls.length;
  calls.push({ file, args, options });
  if (index === timeoutAt) return { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } };
  return { status: 0, signal: null, stdout: file.endsWith('/lipo') ? 'arm64\\n' : '',
    stderr: 'Identifier=com.sleight.glide-engine\\nTeamIdentifier=not set\\nSignature=adhoc\\n' };
}
`);
  const text = (await readFile(hostURL, 'utf8'))
    .replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, hostURL).href}'`)
    .replace("from 'node:child_process'", "from './child.mjs'");
  const hostFile = join(root, 'host.mjs');
  await writeFile(hostFile, text);
  const host = await import(new URL('file://' + hostFile));
  const child = await import(new URL('file://' + stub));
  const refusals = [];
  const load = identity => host.preparePrebuiltMacDriver({ ...identity, binary, pin, arch: 'arm64', allowAdHoc: true,
    onRefusal: reason => refusals.push(reason) });
  child.reset(-1);
  assert.ok(load(expected), 'the same fixture passes when all three tools succeed');
  assert.equal(child.calls.length, 3);
  const stages = [['codesign display', 'signature'], ['codesign verify', 'signature'], ['lipo architecture', 'architecture']];
  for (const [index, [name, reason]] of stages.entries()) await t.test(name, async () => {
    child.reset(index); refusals.length = 0;
    let compiles = 0;
    const fallback = await prepareMacDriver({ platform: 'darwin', prebuilt: load, cached: () => true,
      tools: () => assert.fail('cached source preparation needs no tool probe'), prepare: async options => {
        compiles++;
        const directory = join(root, 'compiled-' + index); await mkdir(directory, { mode: 0o700 });
        const sources = Object.fromEntries(options.inventory.files.map(row => [row.path.split('/').at(-1), row.sha256]));
        await writeFile(join(directory, 'glide-engine'), bytes, { mode: 0o700 });
        const record = join(directory, 'build.json');
        await writeFile(record, JSON.stringify({ protocol: 1, arch: process.arch, sources, recipes: helperBuildRecipes(sources),
          binaries: { 'glide-engine': digest(bytes) } }), { mode: 0o600 });
        return { status: 'ready', directory, record };
      } });
    assert.equal(compiles, 1); assert.equal(fallback.origin, 'source'); assert.equal(fallback.status, 'ready');
    assert.deepEqual(refusals, [reason]);
    assert.equal(child.calls.length, index + 1, 'verification stops at the timed-out tool');
    assert.deepEqual(child.calls.map(({ file, args }) => [file, args[0]]),
      [['/usr/bin/codesign', '--display'], ['/usr/bin/codesign', '--verify'], ['/usr/bin/lipo', '-archs']].slice(0, index + 1));
    for (const { options } of child.calls) {
      assert.equal(options.timeout, 10000); assert.equal(options.killSignal, 'SIGKILL');
    }
  });
});

test('a refused pin records the failed check without exposing package data', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  for (const [change, reason] of [
    [{ sourceHash: '0'.repeat(64) }, 'source-hash'], [{ build: '0'.repeat(64) }, 'build-id'],
    [{ sha256: '0'.repeat(64) }, 'binary-hash'], [{ arch: 'x64' }, 'architecture'],
    [{ identifier: 'com.other.driver' }, 'identifier'],
    [{ teamId: 'not-a-team', kind: 'developer-id' }, 'team'],
    [{ teamId: 'AAAAAAAAAA', kind: 'developer-id' }, 'team'],
  ]) {
    f.refusals.length = 0;
    assert.equal(f.load({ pin: { ...f.pin, ...change } }), null);
    assert.deepEqual(f.refusals, [reason]);
  }
  f.refusals.length = 0;
  assert.equal(f.load({ allowAdHoc: false }), null);
  assert.deepEqual(f.refusals, ['signature']);
  assert.equal(f.load({ pin: { ...f.pin, build: '0'.repeat(64) }, onRefusal: () => { throw Error('log unavailable'); } }), null);
});

test('the default refusal diagnostic is one private line without paths or signature output',
  { skip: process.platform !== 'darwin' }, async t => {
    const f = await fixture(t), writes = [];
    t.mock.method(process.stderr, 'write', message => { writes.push(message); return true; });
    assert.equal(f.load({ pin: { ...f.pin, build: '0'.repeat(64) }, onRefusal: undefined }), null);
    assert.deepEqual(writes, ['sleight: prebuilt Mac helper refused (build-id); using source compilation.\n']);
  });

test('a valid ad-hoc signed fixture is accepted only through the internal test seam', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  assert.equal(f.load({ allowAdHoc: false }), null);
  const host = f.load();
  assert.equal(host.binary, f.binary);
  assert.equal(host.build, expected.build);
  host.validate();
  await writeFile(f.binary, 'tampered');
  assert.throws(() => host.validate(), /HOST_PACKAGE_MISMATCH/);
});

test('tampering refuses even when a new binary hash is supplied, then falls back to compile', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.binary); bytes[4096] ^= 1;
  await writeFile(f.binary, bytes);
  f.pin.sha256 = digest(bytes);
  assert.equal(f.load(), null, 'the code signature must verify independently of the byte pin');
  assert.deepEqual(f.refusals, ['signature']);
  let compiles = 0;
  const host = await prepareMacDriver({ platform: 'darwin', prebuilt: () => f.load(), cached: () => true,
    prepare: async () => { compiles++; return { status: 'unavailable', code: 'HOST_BUILD_BUSY' }; } });
  assert.equal(host.code, 'HOST_BUILD_BUSY');
  assert.equal(compiles, 1);
});

test('wrong team, build, source, identifier, bytes and architecture all refuse', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  for (const change of [{ teamId: 'AAAAAAAAAA', kind: 'developer-id' }, { build: '0'.repeat(64) },
    { sourceHash: '0'.repeat(64) }, { identifier: 'com.other.driver' }, { sha256: '0'.repeat(64) }, { arch: 'x64' }]) {
    assert.equal(f.load({ pin: { ...f.pin, ...change } }), null, JSON.stringify(change));
  }
  assert.equal(f.load({ arch: 'x64' }), null);
  await chmod(f.binary, 0o600);
  assert.equal(f.load(), null);
  assert.equal(f.refusals.at(-1), 'file-mode');
  await chmod(f.binary, 0o722);
  assert.equal(f.load(), null);
  await chmod(f.binary, 0o700);
  const linked = f.binary + '-link'; await symlink(f.binary, linked);
  assert.equal(f.load({ binary: linked }), null);
  await rm(linked);
  const ancestor = f.binary + '-directory';
  await symlink(join(f.binary, '..'), ancestor);
  assert.equal(f.load({ binary: join(ancestor, 'glide-engine') }), null);
  assert.equal(f.refusals.at(-1), 'symlink');
});

test('a verified prebuilt bypasses Apple tools and retains the expected-build handshake pin', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const host = await prepareMacDriver({ platform: 'darwin', prebuilt: identity => f.load(identity),
    tools: () => { throw Error('tools probe'); }, prepare: () => { throw Error('compile'); } });
  assert.equal(host.status, 'ready'); assert.equal(host.build, expected.build);
  assert.equal(host.origin, 'prebuilt');
  assert.throws(() => host.spawn({ nonce: 'bad' }), /INVALID_NONCE/);
  const bytes = await readFile(f.binary); bytes[4096] ^= 1; await writeFile(f.binary, bytes);
  assert.throws(() => host.spawn({ nonce: 'a'.repeat(64) }), /HOST_PACKAGE_MISMATCH/);
});

test('a refused prebuilt still refuses missing Apple tools without trying a compile', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const host = await prepareMacDriver({ platform: 'darwin', prebuilt: () => f.load({ pin: { ...f.pin, build: '0'.repeat(64) } }),
    cached: () => false, tools: async () => false, prepare: () => { throw Error('compiler must not run'); } });
  assert.deepEqual(host, { status: 'unavailable', code: 'APPLE_TOOLS_MISSING' });
});

test('a valid signature on an Intel helper cannot satisfy the arm64 pin', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t, fakeIntel);
  assert.equal(f.load(), null);
  assert.deepEqual(f.refusals, ['architecture']);
});

test('a different signing identifier refuses even when the new signed bytes are pinned', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.other.driver', '--timestamp=none', f.binary], { timeout: 10000, killSignal: 'SIGKILL' });
  f.pin.sha256 = digest(await readFile(f.binary));
  assert.equal(f.load(), null);
  assert.deepEqual(f.refusals, ['identifier']);
});


test('GL1A 12: the retired signing identifiers cannot issue a prebuilt receipt', () => {
  for (const identifier of ['sleight-driver', 'com.sleight.driver']) {
    assert.throws(() => verifyMacDriverSignature({ binary: '/fixture/glide-engine',
      pin: { arch: 'arm64', identifier, kind: 'adhoc', teamId: null }, allowAdHoc: true }),
      error => error.reason === 'identifier');
  }
});


test('GL1A 12: the prebuilt loader refuses a helper signed with the retired identifier', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.sleight.driver', '--timestamp=none', f.binary],
    { timeout: 10000, killSignal: 'SIGKILL' });
  const pin = { ...f.pin, identifier: 'com.sleight.driver', sha256: digest(await readFile(f.binary)) };
  assert.equal(f.load({ pin }), null);
  assert.deepEqual(f.refusals, ['identifier']);
});
