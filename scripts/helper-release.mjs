// Offline by default. Never starts the driver. Ad-hoc mode doesn't require a keychain.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { macDriverSource, macDriverBuildInfo } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { verifyMacDriverSignature } from '../plugins/sleight/lib/mac-driver/host.mjs';
import { darwinEnvironment } from '../plugins/sleight/lib/platform/paths.mjs';
import { appleToolsPresent } from '../plugins/sleight/lib/direct-browser/host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const notaryNames = ['SLEIGHT_NOTARY_KEY_FILE', 'SLEIGHT_NOTARY_KEY_ID', 'SLEIGHT_NOTARY_ISSUER'];

// Own each child until close. Terminal SIGINT is forwarded to the active command;
// a timed-out compiler's group is collected before temporary files are removed.
async function runTool(file, args, { env = darwinEnvironment(), timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', size = 0, failure;
    let forceTimer;
    const stop = signal => {
      failure ??= Error('RELEASE_TOOL_INTERRUPTED');
      try { if (child.pid) process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') failure = error; }
    };
    const interrupt = () => { stop('SIGINT'); forceTimer = setTimeout(() => stop('SIGKILL'), 2000); };
    process.once('SIGINT', interrupt);
    const timer = setTimeout(() => stop('SIGKILL'), timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      size += bytes.length;
      if (size > 1024 * 1024) stop('SIGKILL');
      else if (stream === child.stdout) output += bytes;
      else stderr += bytes;
    });
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(forceTimer); process.off('SIGINT', interrupt);
      // Signing and notary diagnostics may contain account data. Only compiler
      // diagnostics are safe to return; their input is the public driver source.
      if (failure || code !== 0 || signal) reject(failure ?? Error(`RELEASE_TOOL_FAILED: ${file} (${code ?? signal})` +
        (file === '/usr/bin/xcrun' && args[0] === 'swiftc' ? '\n' + stderr.trim() : '')));
      else resolve(output);
    });
  });
}

export function parseArguments(args) {
  const options = {};
  const values = { '--output': 'output', '--identity': 'identity', '--team-id': 'teamId', '--keychain': 'keychain' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], key = flag === '--submit' ? 'submit' : values[flag];
    if (!key || Object.hasOwn(options, key)) throw Error('RELEASE_ARGUMENTS');
    if (key === 'submit') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error('RELEASE_ARGUMENTS');
      options[key] = value;
    }
  }
  return options;
}

// External command/verification seams let tests exercise receipts without a real
// identity, credentials, upload, driver launch or a second expensive compilation.
export async function releaseHelper({ output, identity, teamId, keychain, submit = false },
  { run = runTool, verify = verifyMacDriverSignature, tools = appleToolsPresent, env = process.env } = {}) {
  if (typeof identity !== 'string' || !identity.trim() || /[\x00-\x1f\x7f]/.test(identity) ||
      identity !== '-' && identity.startsWith('-')) throw Error('SIGNING_IDENTITY_REQUIRED');
  const adhoc = identity === '-';
  if (!adhoc && !/^[A-Z0-9]{10}$/.test(teamId ?? '')) throw Error('SIGNING_TEAM_REQUIRED');
  if (!adhoc && (typeof keychain !== 'string' || !isAbsolute(keychain) || normalize(keychain) !== keychain)) throw Error('SIGNING_KEYCHAIN_REQUIRED');
  const outside = typeof output === 'string' && relative(root, output);
  if (!isAbsolute(output ?? '') || normalize(output) !== output || await realpath(dirname(output)) !== dirname(output) ||
      outside !== '..' && !outside.startsWith('../')) throw Error('RELEASE_OUTPUT_OUTSIDE_CHECKOUT_REQUIRED');
  if ((await run('/usr/bin/git', ['status', '--porcelain', '--untracked-files=normal'])).trim()) throw Error('CLEAN_CHECKOUT_REQUIRED');
  const commit = (await run('/usr/bin/git', ['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('RELEASE_COMMIT_REQUIRED');
  const epoch = (await run('/usr/bin/git', ['show', '-s', '--format=%ct', 'HEAD'])).trim();
  if (!/^[0-9]+$/.test(epoch)) throw Error('RELEASE_COMMIT_REQUIRED');
  if (!await tools()) throw Error('APPLE_TOOLS_MISSING');
  const source = macDriverSource(), info = macDriverBuildInfo(source);
  const toolEnv = { ...darwinEnvironment(), SOURCE_DATE_EPOCH: epoch,
    ...env.DEVELOPER_DIR ? { DEVELOPER_DIR: env.DEVELOPER_DIR } : {} };
  const sdk = (await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { env: toolEnv })).trim();
  const sdkVersion = (await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { env: toolEnv })).trim();
  const swiftVersion = (await run('/usr/bin/xcrun', ['swiftc', '--version'], { env: toolEnv })).trim();
  // mkdir is exclusive. Never replace a prior release or clean a directory we did not create.
  await mkdir(output, { mode: 0o700 });
  let stage;
  try {
    stage = await mkdtemp(join(await realpath(tmpdir()), 'sleight-helper-release-'));
    await chmod(stage, 0o700);
    const compilerInput = join(stage, 'main.swift'), binary = join(output, 'glide-engine');
    await writeFile(compilerInput, source, { flag: 'wx', mode: 0o600 });
    await run('/usr/bin/xcrun', ['swiftc', '-O', '-whole-module-optimization', '-module-name', 'GlideEngine',
      '-target', 'arm64-apple-macos14.0', '-sdk', sdk, '-debug-prefix-map', `${stage}=.`,
      '-file-compilation-dir', '.', '-Xlinker', '-no_uuid', '-Xlinker', '-no_adhoc_codesign',
      '-module-cache-path', join(stage, 'modules'), compilerInput,
      '-o', binary], { env: toolEnv });
    await chmod(binary, 0o700);
    const unsignedSha256 = digest(await readFile(binary));
    const signArgs = ['--force', '--sign', identity, '--identifier', 'com.sleight.glide-engine',
      ...adhoc ? ['--timestamp=none'] : ['--keychain', keychain, '--options', 'runtime', '--timestamp'], binary];
    await run('/usr/bin/codesign', signArgs, { env: toolEnv });
    const pin = { ...info, sha256: digest(await readFile(binary)), arch: 'arm64',
      kind: adhoc ? 'adhoc' : 'developer-id', teamId: adhoc ? null : teamId, identifier: 'com.sleight.glide-engine' };
    verify({ binary, pin, allowAdHoc: adhoc });
    const archive = join(output, 'glide-engine.zip');
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', binary, archive], { env: toolEnv });
    let notarization = { status: 'not-requested' };
    if (submit) {
      const missing = notaryNames.filter(name => !env[name]);
      if (missing.length) notarization = { status: 'credentials-missing', missing };
      else if (adhoc) notarization = { status: 'adhoc-not-notarizable' };
      else {
        const key = env.SLEIGHT_NOTARY_KEY_FILE, stat = await lstat(key);
        if (!isAbsolute(key) || await realpath(key) !== key || !stat.isFile() || stat.isSymbolicLink() ||
            stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size < 1 || stat.size > 16384 ||
            !/^[A-Z0-9]{10}$/.test(env.SLEIGHT_NOTARY_KEY_ID) ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.SLEIGHT_NOTARY_ISSUER)) throw Error('NOTARY_KEY_UNSAFE');
        const response = JSON.parse(await run('/usr/bin/xcrun', ['notarytool', 'submit', archive,
          '--key', key, '--key-id', env.SLEIGHT_NOTARY_KEY_ID, '--issuer', env.SLEIGHT_NOTARY_ISSUER,
          '--wait', '--timeout', '20m', '--output-format', 'json'], { env: toolEnv, timeout: 1260000 }));
        if (response.status !== 'Accepted' || !/^[a-f0-9-]{36}$/i.test(response.id ?? '')) throw Error('NOTARIZATION_NOT_ACCEPTED');
        notarization = { status: 'accepted', id: response.id };
      }
    }
    if (digest(await readFile(binary)) !== pin.sha256 || macDriverBuildInfo().sourceHash !== info.sourceHash ||
        (await run('/usr/bin/git', ['status', '--porcelain', '--untracked-files=normal'])).trim() ||
        (await run('/usr/bin/git', ['rev-parse', 'HEAD'])).trim() !== commit) throw Error('RELEASE_SOURCE_CHANGED');
    const record = { protocol: 1, ...pin, commit, sourceDateEpoch: epoch, unsignedSha256,
      archiveSha256: digest(await readFile(archive)), sdkVersion, swiftVersion, notarization };
    await writeFile(join(output, 'release.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'release-pin.json'), JSON.stringify(pin, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { record, pin };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { record } = await releaseHelper(parseArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    if (record.notarization.status !== 'accepted') process.stderr.write(`Notarization: ${record.notarization.status}; no submission was made.\n`);
  } catch (error) {
    process.stderr.write((error.code ?? error.message) + '\n');
    process.exitCode = 1;
  }
}
