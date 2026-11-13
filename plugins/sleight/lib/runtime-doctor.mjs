// Runtime diagnosis uses only the helper's public TCC preflights and bounded Node probes.
// It never requests grants, captures a screen, or queries TCC's private database.
import { createHash } from 'node:crypto';
import { lstatSync, statSync, readdirSync, readFileSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { macDriverSource } from './mac-driver/build.mjs';
import { defaultHelperCache, helperBuildKey, helperBuildRecipes, helperCompileFailure, handHostRecipe, ordinary } from './direct-browser/host-cache.mjs';
import { selectRuntime } from './runtime-choice.mjs';
import { createReplNodeSelector, selectReplNode, supportsReplNode, nodeSelectionRefusals } from './repl/node.mjs';
import { waitForMacInputRegistrar } from './mac-driver/input-registrar.mjs';
import { compilerDiagnosticLine } from './direct-browser/compiler-diagnostics.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const peerSource = fileURLToPath(new URL('./direct-browser/native/peer-host.c', import.meta.url));
const fs = { lstatSync, statSync, readdirSync, readFileSync, realpathSync, openSync, closeSync, fstatSync, readSync };
const absent = error => error?.code === 'ENOENT';

// Inspect compiler files without invoking xcrun, whose missing-tools path can
// show an installer. Discovery does not prove SDK availability or a usable build.
export function runtimeCompilerState({ io = fs } = {}) {
  const roots = [];
  try { roots.push(io.realpathSync('/var/db/xcode_select_link')); } catch {}
  roots.push('/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer');
  for (const root of new Set(roots)) {
    const found = ['swiftc', 'clang'].every(tool => ['usr/bin', 'Toolchains/XcodeDefault.xctoolchain/usr/bin']
      .some(folder => { try { return io.statSync(join(root, folder, tool)).isFile(); } catch { return false; } }));
    if (found) return 'found (Swift and Clang files; compiler not run)';
  }
  return 'not found (install Xcode command-line tools)';
}

export function runtimeBuildState({ source = macDriverSource, peer = () => ordinary(peerSource),
  cacheRoot = join(defaultHelperCache(), 'mac-driver'), read = ordinary } = {}) {
  let assembled, hashes, build;
  try {
    assembled = source();
    build = /^let driverBuild = "([a-f0-9]{64})"/.exec(assembled)?.[1];
    if (!build) throw Error('DRIVER_SOURCE_MISSING');
    hashes = { 'peer-host.c': digest(peer()), 'glide-engine.swift': digest(assembled) };
  } catch { return { status: 'source unreadable', build: null }; }
  const directory = join(cacheRoot, helperBuildKey(hashes));
  try {
    const record = JSON.parse(read(join(directory, 'build.json'), 0o600));
    if (record.protocol !== 1 || record.arch !== process.arch || JSON.stringify(record.sources) !== JSON.stringify(hashes) ||
        JSON.stringify(record.recipes) !== JSON.stringify(helperBuildRecipes(hashes)) ||
        !['peer-host', 'glide-engine'].every(name => digest(read(join(directory, name), 0o700)) === record.binaries?.[name])) {
      throw Error('HOST_PACKAGE_MISMATCH');
    }
    return { status: 'compiled (matching source and binary hashes; not executed)', build };
  } catch (error) {
    const failure = helperCompileFailure({ cacheRoot, key: helperBuildKey(hashes) });
    if (failure?.retryAfterMs > 0) {
      const diagnostic = typeof failure.diagnostic === 'string' ? compilerDiagnosticLine(failure.diagnostic) : undefined;
      return { status: `compile failed (HOST_COMPILE_FAILED; automatic retry in ${Math.ceil(failure.retryAfterMs / 1000)} s; clear ${helperBuildKey(hashes)}.startup-failed.json in the helper cache to retry now)` +
        (diagnostic ? `; ${diagnostic}` : ''), build, failure };
    }
    return { status: absent(error) ? 'not compiled for this source' : 'cached build invalid or unreadable', build };
  }
}

// The probe accepts arbitrary --out paths and has no global latest pointer.
// Read only runtime-probe*.json in this documented folder, newest mtime first.
export function runtimeLastProbe({ directory = join(userInfo().homedir, 'Library/Logs/sleight'), io = fs,
  build } = {}) {
  let entries;
  try {
    if (io.realpathSync(directory) !== directory) return 'unavailable (report folder is linked)';
    entries = io.readdirSync(directory).filter(name => /^runtime-probe(?:[-.][A-Za-z0-9_.-]+)?\.json$/.test(name));
  } catch (error) { return absent(error) ? 'none saved in ~/Library/Logs/sleight/runtime-probe*.json' : 'unavailable (report folder unreadable)'; }
  const candidates = entries.flatMap(name => {
    try {
      const path = join(directory, name), stat = io.lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ path, stat }] : [];
    } catch { return []; }
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
  if (!candidates.length) return 'none saved in ~/Library/Logs/sleight/runtime-probe*.json';
  try {
    const { path, stat } = candidates[0];
    if (stat.size > 16 * 1024 * 1024 || io.realpathSync(path) !== path) throw Error('REPORT_UNSAFE');
    const report = JSON.parse(io.readFileSync(path, 'utf8'));
    if (report.schema !== 'sleight.runtime-probe/2' || report.runtime !== 'own' ||
        report.dryRun || !Array.isArray(report.cells)) throw Error('REPORT_INVALID');
    const verdict = report.verdict?.verdict;
    if (!['step1: mechanisms-pass', 'step1: stop-program', 'step1: diagnose-and-fix', 'step1: sitting-not-qualification', 'step1: stopped'].includes(verdict) ||
        typeof report.finishedAt !== 'string' || report.cells.some(row => !row || typeof row !== 'object')) throw Error('REPORT_INVALID');
    const date = new Date(report.finishedAt);
    if (!Number.isFinite(date.getTime())) throw Error('REPORT_INVALID');
    const sources = report.cells.flatMap(row => (row.trialsData ?? []).map(trial => trial.runtimeReceipt?.driverSourceBuild));
    const match = build && sources.length && sources.every(source => source === build) ? 'current source' : 'different or unknown source';
    return `${date.toISOString()}: ${verdict}; ${report.cells.filter(row => row?.passed === true).length}/${report.cells.length} cells passed; cleanup ${report.cleanupConfirmed === true ? 'confirmed' : 'unconfirmed'}; ${match}; saved result only`;
  } catch { return 'latest saved report invalid or unreadable (not a passing result)'; }
}

// Saved undo is data only. Do not launch recovery or infer a live AX value.
export function runtimeRendererRecords({ directory = join(userInfo().homedir,
  'Library/Application Support/sleight/runtime/renderer-restore'), io = fs, uid = process.getuid?.() } = {}) {
  const records = [];
  let invalid = 0, names;
  try {
    if (io.realpathSync(directory) !== directory) return 'unavailable (record folder is linked)';
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)
      return 'unavailable (record folder permissions)';
    names = io.readdirSync(directory).filter(name => /^renderer-[0-9]+-[0-9]+[.][0-9]+-(?:AXManualAccessibility|AXEnhancedUserInterface)\.json$/.test(name)).sort();
  } catch (error) { return absent(error) ? '0 record(s)' : 'unavailable (record folder unreadable)'; }
  for (const name of names) {
    let fd;
    try {
      const path = join(directory, name), entry = io.lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error('RECORD_UNSAFE');
      fd = io.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = io.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
          stat.size < 1 || stat.size > 1024 || stat.dev !== entry.dev || stat.ino !== entry.ino || io.realpathSync(path) !== path)
        throw Error('RECORD_UNSAFE');
      const bytes = Buffer.alloc(1025), size = io.readSync(fd, bytes, 0, bytes.length, 0);
      if (size !== stat.size || size > 1024) throw Error('RECORD_UNSAFE');
      const record = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      const reasons = { 'assistive-technology-running': 'assistive technology running',
        'value-changed-since': 'value changed since', 'identity-changed': 'identity changed',
        'lease-unavailable': 'lease unavailable', 'recovery-disabled': 'automatic recovery disabled' };
      // Legacy RTW2B records remain readable; output always spells this bundleId.
      const bundleId = record.bundleId ?? record.bundleID;
      if (!Number.isInteger(record.pid) || record.pid < 1 || record.pid > 2147483647 ||
          typeof record.processStart !== 'string' || record.processStart.length > 64 ||
          !/^[0-9]+[.][0-9]+$/.test(record.processStart) || typeof bundleId !== 'string' || !/^[A-Za-z0-9._+-]{1,255}$/.test(bundleId) || /[\r\n]/.test(bundleId) ||
          record.original !== false || !['AXManualAccessibility', 'AXEnhancedUserInterface'].includes(record.attribute) ||
          name !== `renderer-${record.pid}-${record.processStart}-${record.attribute}.json` ||
          (Object.hasOwn(record, 'recoveryReason') &&
            (typeof record.recoveryReason !== 'string' || !Object.hasOwn(reasons, record.recoveryReason))) ||
          Object.keys(record).sort().join(' ') !== ['attribute', record.bundleId !== undefined ? 'bundleId' : 'bundleID', 'original', 'pid', 'processStart',
            ...(Object.hasOwn(record, 'recoveryReason') ? ['recoveryReason'] : [])].sort().join(' '))
        throw Error('RECORD_INVALID');
      const reason = record.recoveryReason ? `; last recovery: ${reasons[record.recoveryReason]}` : '';
      records.push(`${bundleId} pid ${record.pid} start ${record.processStart} ${record.attribute}: pending${reason}; ` +
        'the app may still carry this enabled attribute; automatic recovery leaves it unchanged; quitting the app clears it ' +
        '(if the recorded process already exited, nothing remains; current value not inspected)');
    } catch { invalid++; }
    finally { if (fd !== undefined) io.closeSync(fd); }
  }
  return `${records.length} record(s)` + (records.length ? ': ' + records.join('; ') : '') +
    (invalid ? `; ${invalid} invalid or unreadable record(s) (no recovery run)` : '');
}

export async function runtimeGrantState({ driverOptions = {}, timeoutMs = 30000 } = {}) {
  const { prepareOwnRuntimeHost } = await import('./runtime-select.mjs');
  const { driver, inputRegistrar, runtimeHost } = await prepareOwnRuntimeHost({ driverOptions, lazy: true });
  let timer;
  try {
    // DriverCore.health uses AXIsProcessTrusted and CGPreflightScreenCaptureAccess.
    const result = await Promise.race([(async () => {
      await waitForMacInputRegistrar(inputRegistrar, driver, timeoutMs);
      return driver.health();
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error('DRIVER_PREPARE_TIMEOUT'), { code: 'DRIVER_PREPARE_TIMEOUT' })), timeoutMs);
    })]);
    if (typeof result.accessibility !== 'boolean' || typeof result.screenRecording !== 'boolean')
      throw Error('DRIVER_PROTOCOL');
    return { accessibility: result.accessibility, screenRecording: result.screenRecording };
  } catch (error) {
    return { unavailable: ['REPL_TIMEOUT', 'DRIVER_PREPARING'].includes(error?.code) ? 'DRIVER_PREPARE_TIMEOUT'
      : error?.causeCode ?? (/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'DRIVER_UNAVAILABLE') };
  } finally {
    clearTimeout(timer); runtimeHost.startup.abort(); runtimeHost.actionEvents.close();
    await driver.close();
  }
}

export async function runtimeDoctor(options = {}) {
  let selected;
  try { selected = selectRuntime(options.env ?? process.env); } catch {}
  const grants = selected === 'own' && (options.platform ?? process.platform) === 'darwin'
    ? await (options.grantState ?? runtimeGrantState)() : undefined;
  return runtimeDoctorSection({ ...options, grants });
}

export function runtimeDoctorSection({ env = process.env, platform = process.platform, grants,
  node = process, buildState = runtimeBuildState, compilerState = runtimeCompilerState, lastProbe = runtimeLastProbe,
  rendererRecords = runtimeRendererRecords, consentRecipe = handHostRecipe,
  selectNode = node === process ? selectReplNode : createReplNodeSelector({ node, platform, env }) } = {}) {
  let selected;
  try { selected = selectRuntime(env); }
  catch { return { selected: 'invalid', ok: false, lines: ['runtime (opt-in preview)', 'PROBLEM   SLEIGHT_RUNTIME must be engine or own.'] }; }
  const lines = ['runtime (opt-in preview)', `selected  ${selected === 'own' ? 'own (SLEIGHT_RUNTIME=own)' : 'engine (preview off)'}`];
  if (platform !== 'darwin') return { selected, ok: false, lines: [...lines, 'helper    unavailable on this platform'] };
  // Engine diagnosis keeps its current no-probe path. Own diagnosis uses the
  // same cached Node selection as the worker, without launching the worker.
  const workerNode = selected === 'own' ? selectNode() : undefined;
  const nodeSupported = selected === 'own' ? Boolean(workerNode) : supportsReplNode(node.allowedNodeEnvironmentFlags);
  lines.push(`node      ${node.execPath} (${node.version}; relay executable)`);
  if (selected === 'own') lines.push((workerNode
    ? `worker    ready (${workerNode.execPath}; ${workerNode.version}; --permission and --allow-net supported)`
    : 'worker    unavailable (no qualifying Node; REPL_NODE_UNSUPPORTED; install Node 25 or later from nodejs.org or Homebrew)') +
    (nodeSelectionRefusals(selectNode) ? `; refused: ${nodeSelectionRefusals(selectNode)}` : ''));
  const state = buildState(), compiler = compilerState();
  lines.push(`source    ${state.build ?? 'unavailable'}`, `helper    ${state.status}`, `compiler  ${compiler}`,
    `consent   ${consentRecipe()} recipe for next host launch (running host unchanged)`,
    `grants    ${grants?.unavailable ? 'unavailable (' + grants.unavailable + ')' : grants
      ? 'Accessibility: ' + (grants.accessibility ? 'granted' : 'not granted') + '; Screen Recording: ' +
        (grants.screenRecording ? 'granted' : 'not granted') + ' (helper preflight; grants of the app running this command)'
      : 'not checked (preview helper not launched)'}`,
    `probe     ${lastProbe({ build: state.build })}`, `renderer  ${rendererRecords()}`);
  return { selected, ok: !grants?.unavailable && !state.failure && nodeSupported && Boolean(state.build) && (state.status.startsWith('compiled') || compiler.startsWith('found')), lines };
}
