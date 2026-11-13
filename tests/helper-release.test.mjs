import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { releaseHelper, parseArguments } from '../scripts/helper-release.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { dirty = false, fail = false, notaryStatus = 'Accepted' } = {}) {
  const root = registerTemp(t, await mkdtemp(join(await realpath(tmpdir()), 'sleight-release-test-')));
  const calls = [];
  // Only replace external tools. Source composition, files, receipts and refusal paths stay real.
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file === '/usr/bin/git') {
      if (args.includes('status')) return dirty ? ' M source.swift\n' : '';
      if (args.includes('rev-parse')) return 'a'.repeat(40) + '\n';
      if (args.includes('show')) return '1700000000\n';
    }
    if (file === '/usr/bin/xcrun') {
      if (args.includes('--show-sdk-path')) return '/SDK/MacOSX.sdk\n';
      if (args.includes('--show-sdk-version')) return '26.0\n';
      if (args.includes('--version')) return 'Apple Swift version fixture\n';
      if (args[0] === 'swiftc') {
        if (fail) throw Error('fixture compiler failed');
        const source = await readFile(args[args.indexOf('-module-cache-path') + 2], 'utf8');
        await writeFile(args[args.indexOf('-o') + 1], source);
        return '';
      }
      if (args[0] === 'notarytool') return JSON.stringify({ status: notaryStatus, id: '12345678-1234-1234-1234-123456789abc',
        message: 'notary service text must not be copied into the receipt' });
      throw Error('unexpected upload or xcrun call');
    }
    if (file === '/usr/bin/codesign') return '';
    if (file === '/usr/bin/ditto') { await writeFile(args.at(-1), 'archive'); return ''; }
    throw Error('unexpected tool: ' + file);
  };
  const verify = () => true;
  return { root, calls, run, verify, tools: async () => true,
    options: { output: join(root, 'out'), identity: '-', submit: false } };
}

test('release records the source hash and ID1B build pin with stable compiler inputs', async t => {
  const f = await fixture(t);
  const result = await releaseHelper(f.options, f);
  const record = JSON.parse(await readFile(join(f.options.output, 'release.json')));
  const source = macDriverSource();
  assert.equal(record.sourceHash, digest(source));
  assert.equal(record.build, /^let driverBuild = "([a-f0-9]{64})"/.exec(source)[1]);
  assert.equal(record.commit, 'a'.repeat(40)); assert.equal(record.arch, 'arm64');
  assert.equal(record.notarization.status, 'not-requested');
  assert.equal(result.pin.sha256, digest(await readFile(join(f.options.output, 'glide-engine'))));
  assert.equal(result.pin.kind, 'adhoc');
  const compile = f.calls.find(c => c.args[0] === 'swiftc' && c.args.includes('-o'));
  assert.ok(compile.args.includes('arm64-apple-macos14.0'));
  assert.ok(compile.args.includes('-no_uuid'));
  assert.equal(compile.args[compile.args.indexOf('-module-name') + 1], 'GlideEngine');
  assert.equal(result.pin.identifier, 'com.sleight.glide-engine');
  const stage = compile.args[compile.args.indexOf('-module-cache-path') + 1];
  await assert.rejects(access(stage), { code: 'ENOENT' });
  const second = await releaseHelper({ ...f.options, output: join(f.root, 'again') }, f);
  assert.equal(second.record.unsignedSha256, record.unsignedSha256);
});

test('dirty checkout and missing identity refuse before compilation or output creation', async t => {
  const f = await fixture(t, { dirty: true });
  await assert.rejects(releaseHelper(f.options, f), /CLEAN_CHECKOUT_REQUIRED/);
  await assert.rejects(access(f.options.output), { code: 'ENOENT' });
  await assert.rejects(releaseHelper({ ...f.options, identity: undefined }, f), /SIGNING_IDENTITY_REQUIRED/);
});

test('missing Apple tools refuses without invoking xcrun or creating output', async t => {
  const f = await fixture(t);
  await assert.rejects(releaseHelper(f.options, { ...f, tools: async () => false }), /APPLE_TOOLS_MISSING/);
  assert.ok(f.calls.every(call => call.file !== '/usr/bin/xcrun'));
  await assert.rejects(access(f.options.output), { code: 'ENOENT' });
});

test('Developer ID needs a team and dedicated keychain; ad-hoc never opens a keychain', async t => {
  const f = await fixture(t);
  await assert.rejects(releaseHelper({ ...f.options, identity: 'Developer ID Application: test' }, f), /SIGNING_TEAM_REQUIRED/);
  await assert.rejects(releaseHelper({ ...f.options, identity: 'Developer ID Application: test', teamId: 'AAAAAAAAAA' }, f), /SIGNING_KEYCHAIN_REQUIRED/);
  await releaseHelper(f.options, f);
  const signing = f.calls.find(c => c.file === '/usr/bin/codesign');
  assert.ok(signing.args.includes('--timestamp=none'));
  assert.ok(!signing.args.includes('--keychain'));
});

test('missing notary credentials is an explicit no-op even with submit requested', async t => {
  const f = await fixture(t);
  const result = await releaseHelper({ ...f.options, identity: 'Developer ID Application: test', teamId: 'AAAAAAAAAA',
    keychain: join(f.root, 'ci.keychain-db'), submit: true }, { ...f, env: {} });
  assert.equal(result.record.notarization.status, 'credentials-missing');
  assert.deepEqual(result.record.notarization.missing, ['SLEIGHT_NOTARY_KEY_FILE', 'SLEIGHT_NOTARY_KEY_ID', 'SLEIGHT_NOTARY_ISSUER']);
  assert.equal(f.calls.filter(c => c.args[0] === 'notarytool').length, 0);
});

test('notary submission requires an explicit request, accepts only Accepted, and records only its id', async t => {
  for (const status of ['Accepted', 'Invalid']) {
    const f = await fixture(t, { notaryStatus: status });
    const key = join(f.root, 'notary.p8'); await writeFile(key, 'test-only-key', { mode: 0o600 });
    const env = { SLEIGHT_NOTARY_KEY_FILE: key, SLEIGHT_NOTARY_KEY_ID: 'ABCDEFGHIJ',
      SLEIGHT_NOTARY_ISSUER: '12345678-1234-1234-1234-123456789abc' };
    const options = { ...f.options, identity: 'Developer ID Application: test', teamId: 'AAAAAAAAAA', keychain: join(f.root, 'ci.keychain-db') };
    await releaseHelper(options, { ...f, env });
    assert.equal(f.calls.filter(c => c.args[0] === 'notarytool').length, 0);
    const signing = f.calls.find(c => c.file === '/usr/bin/codesign');
    assert.ok(signing.args.includes('--timestamp')); assert.ok(signing.args.includes('runtime'));
    assert.equal(signing.args[signing.args.indexOf('--keychain') + 1], options.keychain);
    const attempt = releaseHelper({ ...options, output: join(f.root, 'submit'), submit: true }, { ...f, env });
    if (status === 'Accepted') {
      const { record } = await attempt;
      assert.deepEqual(record.notarization, { status: 'accepted', id: '12345678-1234-1234-1234-123456789abc' });
      assert.ok(!JSON.stringify(record).includes('test-only-key'));
    } else {
      await assert.rejects(attempt, /NOTARIZATION_NOT_ACCEPTED/);
      await assert.rejects(access(join(f.root, 'submit')), { code: 'ENOENT' });
    }
  }
});

test('unsafe notary key and a failed signature remove the release before any upload', async t => {
  const f = await fixture(t);
  const key = join(f.root, 'key.p8'), linked = join(f.root, 'link.p8');
  await writeFile(key, 'test-only-key', { mode: 0o600 }); await symlink(key, linked);
  await assert.rejects(releaseHelper({ ...f.options, identity: 'Developer ID Application: test', teamId: 'AAAAAAAAAA',
    keychain: join(f.root, 'ci.keychain-db'), submit: true }, { ...f, env: { SLEIGHT_NOTARY_KEY_FILE: linked,
    SLEIGHT_NOTARY_KEY_ID: 'ABCDEFGHIJ', SLEIGHT_NOTARY_ISSUER: '12345678-1234-1234-1234-123456789abc' } }), /NOTARY_KEY_UNSAFE/);
  assert.equal(f.calls.filter(c => c.args[0] === 'notarytool').length, 0);
  await assert.rejects(access(f.options.output), { code: 'ENOENT' });
  await assert.rejects(releaseHelper(f.options, { ...f, verify: () => { throw Error('HOST_SIGNATURE_MISMATCH'); } }), /HOST_SIGNATURE_MISMATCH/);
  await assert.rejects(access(f.options.output), { code: 'ENOENT' });
});

test('failure removes its private partial output and refuses to replace an existing output', async t => {
  const f = await fixture(t, { fail: true });
  await assert.rejects(releaseHelper(f.options, f), /fixture compiler failed/);
  await assert.rejects(access(f.options.output), { code: 'ENOENT' });
  const good = await fixture(t); await releaseHelper(good.options, good);
  await assert.rejects(releaseHelper(good.options, good), /EEXIST/);
  assert.ok(await readFile(join(good.options.output, 'release.json')));
});

test('CLI parsing refuses duplicate, unknown and missing arguments', () => {
  assert.deepEqual(parseArguments(['--identity', '-', '--output', '/tmp/example']), { identity: '-', output: '/tmp/example' });
  for (const args of [['--unknown'], ['--output'], ['--identity', '-', '--identity', '-'], ['--submit', '--submit']]) {
    assert.throws(() => parseArguments(args), /RELEASE_ARGUMENTS/);
  }
});
