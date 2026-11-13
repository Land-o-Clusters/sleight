// macOS settings verdicts come from the helper. Node has no settings MAC key or verifier.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darwinPaths, darwinEnvironment } from './platform/paths.mjs';
import { handInventory, helperSourceHashes, helperBuildKey, helperBuildRecipes, ordinary } from './direct-browser/host-cache.mjs';
import { SETTINGS_BUILD_POLICY } from './settings-build-policy.mjs';
export { SETTINGS_BUILD_POLICY };
import { codeRequirement, REQUIRED_STATUS_FLAGS, REFUSED_STATUS_FLAGS, REQUIRED_CODE_FLAGS } from './direct-browser/executable-trust.mjs';

export const SEALED_SETTINGS_FILES = Object.freeze(['preapproved.json', 'permissions.json', 'turbo.json', 'turbo-owner.json',
  'turbo-apps.json', 'electron-grants.json', 'hand.json', 'settings-link.json', 'routine-launcher.mjs']);
const states = new Set(['trusted', 'absent', 'unsealed', 'tampered', 'stale', 'unsafe']);
export const isSealedSettingsName = file => typeof file === 'string' && (SEALED_SETTINGS_FILES.includes(file) ||
  /^(routines|watches)\/[a-f0-9]{20}\/[a-z][a-z0-9-]*\.json$/.test(file));
const fail = code => { throw Object.assign(Error(code), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helpers = new WeakMap();
const signingIdentity = SETTINGS_BUILD_POLICY;
const proofOptions = { env: darwinEnvironment(), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] };
function signatureCheck(path, requirement, run = spawnSync) {
  const checked = run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + requirement, path], proofOptions);
  const shown = run('/usr/bin/codesign', ['--display', '--verbose=1', path], proofOptions);
  const lines = String(shown.stderr ?? '').split('\n').filter(line => line.startsWith('CodeDirectory '));
  const flags = lines.length === 1 && / flags=0x([0-9a-f]{1,8})\(/.exec(lines[0]);
  if (checked.status !== 0 || shown.status !== 0 || !flags || (parseInt(flags[1], 16) & REQUIRED_CODE_FLAGS) !== REQUIRED_CODE_FLAGS) fail('HELPER_UNTRUSTED');
}
/** The peer is itself signed and hardened. Its csops result is external to the child, with birth checks around it. */
export function proveSignedSettingsChild({ pid, executable, peer, identity = signingIdentity }, { run = spawnSync } = {}) {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) fail('HELPER_UNTRUSTED');
    const helperRequirement = codeRequirement({ bundleId: identity.helperId, team: identity.team });
    signatureCheck(peer, codeRequirement({ bundleId: identity.peerId, team: identity.team }), run);
    const status = () => {
      const result = run(peer, ['--code-status', String(pid), executable], proofOptions);
      if (result.status !== 0) fail('HELPER_UNTRUSTED');
      const row = JSON.parse(result.stdout);
      if (row.pid !== pid || row.uid !== process.getuid() || !Number.isFinite(row.start) || row.start < 1 ||
          typeof row.incarnation !== 'string' || !Number.isSafeInteger(row.flags) ||
          (row.flags & REQUIRED_STATUS_FLAGS) !== REQUIRED_STATUS_FLAGS || row.flags & REFUSED_STATUS_FLAGS ||
          !/^(arm64e?|x86_64h?)$/.test(row.arch) || !/^[a-f0-9]{40}$/.test(row.cdhash)) fail('HELPER_UNTRUSTED');
      return row;
    };
    const before = status();
    const checked = run('/usr/bin/codesign', ['--verify', '--strict', '--architecture', before.arch,
      `-R=(${helperRequirement}) and cdhash H"${before.cdhash}"`, executable], proofOptions);
    const after = status();
    if (checked.status !== 0 || ['pid', 'uid', 'start', 'incarnation', 'flags', 'arch', 'cdhash'].some(key => before[key] !== after[key])) fail('HELPER_UNTRUSTED');
    return Object.freeze({ signed: true, incarnation: before.incarnation });
  } catch { fail('HELPER_UNTRUSTED'); }
}
function enforcementMode(stderr) {
  let mode; try { mode = JSON.parse(stderr.trim()); } catch { fail('SETTINGS_PROTOCOL'); }
  if (!mode || Object.keys(mode).join() !== 'settingsEnforcement' || typeof mode.settingsEnforcement !== 'boolean') fail('SETTINGS_PROTOCOL');
  return mode.settingsEnforcement;
}
/** A separate Node verifier keeps the synchronous readers while the native child waits for the external csops proof. */
export async function runSignedSettingsVerification({ binary, peer }, { launch = spawn, prove = proveSignedSettingsChild, timeoutMs = 30000 } = {}) {
  const child = launch(binary, ['--settings', 'verify'], { env: darwinEnvironment(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', failure, expired = false;
  const closed = new Promise(resolve => { child.once('close', code => resolve(code)); child.once('error', error => { failure = error; }); });
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8'); child.stderr.on('data', bytes => {
    stderr += bytes; if (Buffer.byteLength(stderr) > 65536) { failure = Error('SETTINGS_PROTOCOL'); child.kill('SIGKILL'); }
  });
  try {
    await new Promise((resolve, reject) => {
      let text = '';
      const ready = child.stdio[3]; ready.setEncoding('utf8');
      ready.on('data', bytes => {
        text += bytes;
        if (Buffer.byteLength(text) > 1024) return reject(Error('SETTINGS_PROTOCOL'));
        if (!text.includes('\n')) return;
        try {
          const row = JSON.parse(text.trim());
          if (Object.keys(row).sort().join() !== 'pid,settingsReady' || row.settingsReady !== 1 || row.pid !== child.pid) throw Error();
          resolve();
        } catch { reject(Error('SETTINGS_PROTOCOL')); }
      });
      ready.on('error', reject); closed.then(() => reject(Error('HELPER_UNTRUSTED')));
    });
    if (child.exitCode !== null || failure || expired) fail('HELPER_UNTRUSTED');
    const proof = prove({ pid: child.pid, executable: binary, peer });
    if (proof?.signed !== true || child.exitCode !== null) fail('HELPER_UNTRUSTED');
    // No stdout data listener exists until the running code has been proved.
    child.stdout.setEncoding('utf8'); child.stdout.on('data', bytes => {
      stdout += bytes; if (Buffer.byteLength(stdout) > 32 * 1024 * 1024) { failure = Error('SETTINGS_PROTOCOL'); child.kill('SIGKILL'); }
    });
    child.stdin.end('go\n');
    const code = await closed;
    if (code !== 0 || failure || expired) fail('HELPER_UNTRUSTED');
    return { stdout, enforcement: enforcementMode(stderr) };
  } finally {
    if (child.exitCode === null) { child.stdin.destroy(); child.kill('SIGKILL'); }
    await closed; clearTimeout(timer);
  }
}

// No build or UI on a synchronous reader. A normal host build populates this cache; a cold cache reports unavailable.
// The build record is same-user strength until a signed distribution supplies the pinned Team and live csops proof.
export function cachedSettingsHelper({ sourceRoot = fileURLToPath(new URL('./direct-browser/native/', import.meta.url)),
  cacheRoot = darwinPaths().helperCache } = {}) {
  if (process.platform !== 'darwin') fail('HELPER_UNTRUSTED');
  const hashes = helperSourceHashes(handInventory(sourceRoot));
  // Both recipes have identical settings guards. Prefer -O only after its receipt validates.
  let directory, recordBytes, record;
  for (const recipe of ['optimized', 'default']) {
    try {
      const candidate = join(cacheRoot, helperBuildKey(hashes, recipe));
      const bytes = ordinary(join(candidate, 'build.json'), 0o600), data = JSON.parse(bytes);
      if (JSON.stringify(data.recipes) !== JSON.stringify(helperBuildRecipes(hashes, recipe))) continue;
      directory = candidate; recordBytes = bytes; record = data; break;
    } catch {}
  }
  if (!record) fail('HELPER_UNTRUSTED');
  if (!Object.hasOwn(hashes, '../../mac-driver/native/SealedSettings.swift')) fail('HELPER_UNTRUSTED');
  if (record.protocol !== 1 || record.arch !== process.arch || JSON.stringify(record.sources) !== JSON.stringify(hashes) ||
      Object.keys(record.binaries ?? {}).sort().join() !== 'consent-host,peer-host' ||
      Object.values(record.binaries).some(value => !/^[a-f0-9]{64}$/.test(value))) fail('HELPER_UNTRUSTED');
  const binary = join(directory, 'consent-host'), expected = record.binaries['consent-host'];
  const prove = () => {
    if (SETTINGS_BUILD_POLICY.enforce && signingIdentity.team === null) fail('HELPER_UNTRUSTED');
    for (const path of [cacheRoot, directory]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) fail('HELPER_UNTRUSTED');
    }
    for (const [name, digest] of Object.entries(hashes)) if (hash(ordinary(join(sourceRoot, name))) !== digest) fail('HELPER_UNTRUSTED');
    for (const [name, digest] of Object.entries(record.binaries)) if (hash(ordinary(join(directory, name), 0o700)) !== digest) fail('HELPER_UNTRUSTED');
    if (hash(ordinary(binary, 0o700)) !== expected || hash(ordinary(join(directory, 'build.json'), 0o600)) !== hash(recordBytes)) fail('HELPER_UNTRUSTED');
    if (signingIdentity.team !== null) {
      signatureCheck(binary, codeRequirement({ bundleId: signingIdentity.helperId, team: signingIdentity.team }));
      signatureCheck(join(directory, 'peer-host'), codeRequirement({ bundleId: signingIdentity.peerId, team: signingIdentity.team }));
    }
    return { signed: signingIdentity.team !== null };
  };
  const helper = args => {
    prove();
    const signed = signingIdentity.team !== null;
    if (signed && args.join(' ') !== '--settings verify') fail('SETTINGS_INTENT_REFUSED');
    const result = signed ? spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--settings-signed-child', binary,
      join(directory, 'peer-host'), expected, record.binaries['peer-host']], {
      env: darwinEnvironment(), encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnSync(binary, args, { env: darwinEnvironment(), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
        input: 'go\n', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    prove();
    if (result.error || result.status !== 0) fail('SETTINGS_HELPER_FAILED');
    let value;
    if (signed) { try { value = JSON.parse(result.stdout); } catch { fail('SETTINGS_PROTOCOL'); } }
    else value = { stdout: result.stdout, enforcement: enforcementMode(result.stderr) };
    if (value.enforcement !== SETTINGS_BUILD_POLICY.enforce) fail('HELPER_UNTRUSTED');
    return value;
  };
  helpers.set(helper, prove); return helper;
}
export function proveSettingsHelper(helper) {
  try { return helpers.get(helper)?.() ?? false; } catch { return false; }
}

/** One helper invocation, one immutable snapshot. Test helpers and proofs are injected functions, never paths or env. */
export function verifySettings({ helper, proveHelper = proveSettingsHelper } = {}) {
  try { helper ??= cachedSettingsHelper(); } catch { fail('HELPER_UNTRUSTED'); }
  let proof;
  try { proof = proveHelper(helper); } catch { fail('HELPER_UNTRUSTED'); }
  if (!(proof === true || proof && typeof proof === 'object' && typeof proof.signed === 'boolean') || typeof helper !== 'function') fail('HELPER_UNTRUSTED');
  const result = helper(['--settings', 'verify']);
  if (!result || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 32 * 1024 * 1024) fail('SETTINGS_PROTOCOL');
  if (result.enforcement && proof.signed !== true) fail('HELPER_UNTRUSTED');
  const values = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { fail('SETTINGS_PROTOCOL'); }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !isSealedSettingsName(entry.file) || !states.has(entry.state) ||
        Object.keys(entry).sort().join() !== (entry.state === 'trusted' ? 'content,file,state' : 'file,state') ||
        entry.state === 'trusted' && (typeof entry.content !== 'string' || Buffer.byteLength(entry.content) > 1048576) ||
        values.has(entry.file) || values.size >= 16384) fail('SETTINGS_PROTOCOL');
    values.set(entry.file, Object.freeze({ ...entry }));
  }
  if (SEALED_SETTINGS_FILES.some(file => !values.has(file))) fail('SETTINGS_PROTOCOL');
  return Object.freeze({ enforcing: result.enforcement === true && proof.signed === true,
    get: file => values.get(file) ?? Object.freeze({ file, state: 'unsafe' }), entries: () => [...values.values()] });
}

export function trustedSettingsContent(snapshot, file, kind) {
  if (!isSealedSettingsName(file)) fail('SETTINGS_UNTRUSTED');
  const row = snapshot.get(file);
  if (row?.state === 'trusted' && typeof row.content === 'string') return row.content;
  if (kind === 'grant' || kind === 'display') return undefined;
  // A genuinely absent deny list is allowed; recorded absence comes back as tampered from the helper.
  if (row?.state === 'absent' && kind === 'deny') return undefined;
  fail('SETTINGS_UNTRUSTED');
}
export function settingsSealNote(row, policy = SETTINGS_BUILD_POLICY) {
  if (!row || !isSealedSettingsName(row.file) || !states.has(row.state) || ['trusted', 'absent'].includes(row.state)) return undefined;
  // The preview uses this builder only outside model text. Register it in the model-visible
  // notice inventory when a signed release enables enforcement and budgets the I4 line.
  const advice = policy.enforce ? "settings untrusted, review this file in sleight's settings." : 'adoption comes with the signed release.';
  return `sleight settings: ${row.file} ${row.state}; ${advice}`;
}

const forms = Object.freeze({ 'allow add': 2, 'allow remove': 1, 'turbo on': 0, 'turbo off': 0, 'turbo app on': 1,
  'turbo app off': 1, 'permissions block': 1, 'permissions unblock': 1, 'permissions sites': 1, 'permissions revoke': 1,
  'permissions repair': 0, 'hand off': 0, 'routine add': 1, 'routine unlock': 1, 'routine remove': 1, 'watch record': 1,
  'watch unlock': 1, 'watch remove': 1, adopt: 0, repair: 0 });
export function writeSettings(intent, { helper, proveHelper = proveSettingsHelper } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).some(key => !['family', 'op', 'args'].includes(key))) fail('SETTINGS_INTENT_REFUSED');
  const form = [intent.family, intent.op].filter(value => value !== undefined).join(' '), args = intent.args ?? [];
  if (!Object.hasOwn(forms, form) || !Array.isArray(args) || args.length !== forms[form] || args.some(value =>
    typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x1f\x7f-\x9f{}\[\]]/.test(value)) ||
    form === 'allow add' && !['low', 'medium', 'high'].includes(args[1])) fail('SETTINGS_INTENT_REFUSED');
  try { helper ??= cachedSettingsHelper(); } catch { fail('HELPER_UNTRUSTED'); }
  const proof = proveHelper(helper);
  if (!(proof === true || proof && typeof proof === 'object' && typeof proof.signed === 'boolean')) fail('HELPER_UNTRUSTED');
  return helper(['--settings', ...form.split(' '), ...args]);
}

const observed = new Map(), pending = new Map();
function signature(path) {
  try { const s = lstatSync(path, { bigint: true }); return [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':'); }
  catch (error) { return error.code ?? 'error'; }
}
const grantFiles = new Set(['preapproved.json', 'electron-grants.json', 'turbo-apps.json', 'turbo.json']);
export const settingsFileKind = file => grantFiles.has(file) ? 'grant' : file === 'hand.json' ? 'display'
  : file.endsWith('.mjs') || file.includes('/') ? 'code' : 'deny';
export function observeSettingsFile(path, options = {}) {
  // Check the build policy before resolving paths, polling stats or proving/spawning a helper.
  // Explicit enforcement is an offline test seam; no production caller supplies options.
  if (!(options.enforce ?? SETTINGS_BUILD_POLICY.enforce)) return undefined;
  const { verify = verifySettings, root = darwinPaths().settings } = options;
  if (process.platform !== 'darwin' && verify === verifySettings) return undefined;
  if (typeof path !== 'string' || !path.startsWith('/') || typeof root !== 'string') return undefined;
  const file = relative(root, path);
  if (!isSealedSettingsName(file)) return undefined;
  const key = [signature(path), signature(path + '.seal'), signature(root), signature(dirname(path))].join('|');
  let seen = observed.get(path);
  if (!seen || seen.key !== key || seen.verify !== verify) {
    let snapshot;
    try { snapshot = verify(); }
    catch { snapshot = Object.freeze({ enforcing: SETTINGS_BUILD_POLICY.enforce, get: name => ({ file: name, state: 'unsafe' }) }); }
    const row = snapshot.get(file), note = settingsSealNote(row);
    if (snapshot.enforcing && note && seen?.note !== note) pending.set(file, note);
    seen = { key, verify, snapshot, note };
    if (observed.size >= 16384) observed.clear();
    observed.set(path, seen);
  }
  return seen.snapshot;
}
/** Readers call this once, then parse the returned bytes with their existing schema. Preview uses the existing read. */
export function readSettingsBytes(path, legacyRead = () => readFileSync(path, 'utf8'), options = {}) {
  const snapshot = observeSettingsFile(path, options);
  if (!snapshot?.enforcing) return legacyRead();
  return trustedSettingsContent(snapshot, relative(options.root ?? darwinPaths().settings, path),
    settingsFileKind(relative(options.root ?? darwinPaths().settings, path)));
}
export function readSettingsPreview(path, legacyRead, options = {}) {
  const snapshot = observeSettingsFile(path, options);
  if (snapshot?.enforcing) fail('SETTINGS_ENFORCEMENT_INTEGRATION_REQUIRED');
  return legacyRead();
}
export function settingsFilePresent(path, options = {}) {
  const view = observeSettingsFile(path, options);
  if (!view?.enforcing) return existsSync(path);
  const row = view.get(relative(options.root ?? darwinPaths().settings, path));
  if (row.state === 'trusted') return true;
  if (row.state === 'absent') return false;
  fail('SETTINGS_UNTRUSTED');
}
export const takeSettingsSealNotes = () => { const lines = [...pending.values()]; pending.clear(); return lines; };
export function appendSettingsSealNotes(message) {
  if (message?.method !== undefined || !Array.isArray(message?.result?.content)) return;
  for (const text of takeSettingsSealNotes()) message.result.content.push({ type: 'text', text });
}
export function settingsSealDoctorLine({ verify = verifySettings } = {}) {
  try {
    const view = verify(), rows = view.entries(), problems = rows.filter(row => !['trusted', 'absent'].includes(row.state));
    return `seals     ${view.enforcing ? 'enforced' : 'preview, trust unchanged'}: ${problems.length ? problems.map(row => `${row.file} ${row.state}`).join(', ') +
      (view.enforcing ? "; settings untrusted, review these files in sleight's settings." : '; adoption comes with the signed release.') : rows.filter(row => row.state === 'trusted').length + ' trusted'}`;
  } catch { return SETTINGS_BUILD_POLICY.enforce
    ? 'seals     enforced: helper unavailable, settings untrusted; run sleight-mcp --doctor after reinstalling the signed helper.'
    : 'seals     preview, trust unchanged: helper unavailable; run sleight-mcp --doctor after the helper is built.'; }
}

// Internal verifier process. Arguments contain only paths and public build hashes, never key-store material or settings bytes.
// The async function keeps top-level await out of this module, so CommonJS callers (the bench's rounds.mjs) can still require it.
if (process.argv[1] === fileURLToPath(import.meta.url)) void (async () => {
  const [mode, binary, peer, binaryHash, peerHash, ...rest] = process.argv.slice(2);
  try {
    if (mode !== '--settings-signed-child' || rest.length || signingIdentity.team === null ||
        !/^[a-f0-9]{64}$/.test(binaryHash ?? '') || !/^[a-f0-9]{64}$/.test(peerHash ?? '') ||
        hash(ordinary(binary, 0o700)) !== binaryHash || hash(ordinary(peer, 0o700)) !== peerHash) fail('HELPER_UNTRUSTED');
    const result = await runSignedSettingsVerification({ binary, peer });
    if (hash(ordinary(binary, 0o700)) !== binaryHash || hash(ordinary(peer, 0o700)) !== peerHash) fail('HELPER_UNTRUSTED');
    process.stdout.write(JSON.stringify(result));
  } catch { process.stderr.write('HELPER_UNTRUSTED\n'); process.exitCode = 1; }
})();
