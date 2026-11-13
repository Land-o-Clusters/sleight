import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReportPath, integer, isMain, redactReport, redactText, ROOT, runChild, stderrTail, writeReport } from './kit.mjs';

export const PROBE_SCHEMA = 'sleight.windows-engine-probe/1';
const LEGACY_PROBE_SCHEMA = '%USERNAME%.windows-engine-probe/1';
const script = new URL('./probe-engine.ps1', import.meta.url);

export function pipeName(value) {
  const name = value?.replace(/^\\\\\.\\pipe\\/i, '');
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.{}-]{1,240}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Use one local pipe leaf name, without directories');
  }
  return name;
}

export function parseProbeArgs(args) {
  const options = { searchRoots: [], connectMs: 1000, readMs: 1000, observeSeconds: 0 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (value === undefined || (seen.has(key) && key !== '--search-root')) throw new Error('Missing or duplicate option');
    seen.add(key);
    switch (key) {
      case '--output': options.output = value; break;
      case '--baseline': options.baseline = value; break;
      case '--pipe-name': options.pipe = pipeName(value); break;
      case '--search-root':
        if (!win32.isAbsolute(value) || value.startsWith('\\\\') || options.searchRoots.length >= 4) throw new Error('Use up to four local absolute search roots');
        options.searchRoots.push(value); break;
      case '--connect-ms': options.connectMs = integer(value, 100, 10_000, key); break;
      case '--read-ms': options.readMs = integer(value, 100, 10_000, key); break;
      case '--observe-seconds': options.observeSeconds = integer(value, 1, 120, key); break;
      default: throw new Error('Unknown probe option');
    }
  }
  if (!options.output) throw new Error('--output is required');
  return options;
}

export function probeArguments(options) {
  // The bypass applies only to this PowerShell process, with no policy setting written.
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(script),
    '-ConnectMs', String(options.connectMs), '-ReadMs', String(options.readMs),
    '-ObserveSeconds', String(options.observeSeconds)];
  if (options.pipe) args.push('-PipeName', pipeName(options.pipe));
  // PowerShell -File array binding differs between versions; use four separate scalar slots.
  options.searchRoots.forEach((root, i) => args.push(`-SearchRoot${i + 1}`, root));
  return args;
}

function diffInventory(current, baseline) {
  if (!baseline || typeof baseline !== 'object' || ![PROBE_SCHEMA, LEGACY_PROBE_SCHEMA].includes(baseline.schema) ||
      !Array.isArray(baseline.pipes) || !baseline.pipes.every(p => typeof p === 'string') ||
      !Array.isArray(baseline.processes) || !baseline.processes.every(p => p && Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.created === 'string')) {
    throw new Error('Invalid baseline report');
  }
  const oldPipes = new Set(baseline.pipes), oldProcesses = new Set(baseline.processes.map(p => `${p.pid}:${p.created}`));
  return { newPipes: current.pipes.filter(p => !oldPipes.has(p)),
    newProcesses: current.processes.filter(p => !oldProcesses.has(`${p.pid}:${p.created}`)),
    attribution: 'A new pipe and a new process are correlation only. serverPid identifies the connected server, not necessarily its original creator.' };
}

export async function probeEngine(options, { platform = process.platform, execute = runChild, env = process.env, baseline, onReady = () => {} } = {}) {
  if (platform !== 'win32') throw new Error('Engine inventory requires Windows; no probe was started');
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let progress = '', ready = false;
  const result = await execute(executable, probeArguments(options), { cwd: ROOT, env, lowPriority: options.observeSeconds === 0,
    normalPriority: options.observeSeconds > 0,
    timeout: (options.observeSeconds + 60) * 1000 + options.connectMs + options.readMs, maxBytes: 2 * 1024 * 1024,
    onStderr: chunk => {
      progress = (progress + chunk).slice(-256);
      if (!ready && options.observeSeconds && progress.includes('SLEIGHT_OBSERVER_READY')) { ready = true; onReady(); }
    } });
  const fail = message => {
    const tail = stderrTail(result.stderr, env);
    const error = new Error(`${message}${tail ? '\n' + tail : ''}`);
    error.stderrTail = tail;
    error.cleanup = result.cleanup;
    throw error;
  };
  if (result.reason || result.status !== 0) fail(`PowerShell probe failed (${result.reason || result.status}); no report accepted`);
  let inventory;
  try { inventory = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { fail('PowerShell returned invalid JSON'); }
  if (inventory.schema !== PROBE_SCHEMA || !['engines', 'processes', 'pipes', 'errors'].every(k => Array.isArray(inventory[k])) ||
      inventory.connection?.bytesWritten !== 0 || !Array.isArray(inventory.connection.frames)) fail('Invalid probe schema');
  const report = { ...redactReport(inventory, env), questions: {
    enginePresent: inventory.engines.length ? 'found' : (inventory.searchComplete ? 'not-found-in-searched-roots' : 'unknown'),
    pipeServer: inventory.connection.serverPid ? 'measured' : 'unknown',
    externalConnect: inventory.connection.connected ? 'connected-from-standalone-powershell' : (options.pipe ? 'failed' : 'not-tested'),
    handshake: options.pipe ? (inventory.connection.frames.length ? 'server-first-frame-shapes-only' : 'unknown-client-first-or-silent') : 'not-tested',
    thirdPartyEngineUsable: 'unverified: a transport connection does not prove an accepted engine request',
    focus: inventory.observation?.clicks?.length ? 'external-clicks-observed: correlate with the owner-run engine call' : 'not-measured',
    bundledNodeLaunch: 'not-tested: this probe never launches vendor executables',
    approvalsAndEndTurn: 'not-tested: requires a reviewed client-first contract and an owner-run session',
  } };
  if (baseline !== undefined) {
    // Saved baselines already contain scrubbed names. Compare in the same form.
    report.comparison = diffInventory(report, baseline);
    if (baseline.schema === LEGACY_PROBE_SCHEMA) report.baselineSchemaRepaired = true;
  }
  return report;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseProbeArgs(args);
  checkReportPath(options.output);
  try {
    const baseline = options.baseline ? JSON.parse(readFileSync(options.baseline, 'utf8')) : undefined;
    const report = await probeEngine(options, { ...dependencies, baseline, onReady: () => process.stderr.write('Observer ready inside the guest. The observation interval has started.\n') });
    writeReport(options.output, report);
    return report;
  } catch (error) {
    error.message = redactText(error.message, dependencies.env);
    writeReport(options.output, { schema: PROBE_SCHEMA, verdict: 'error', reason: error.message, stderrTail: error.stderrTail, cleanup: error.cleanup });
    throw error;
  }
}
if (isMain(import.meta.url)) main().then(report => {
  process.stdout.write(JSON.stringify({ schema: report.schema, engines: report.engines.length, pipes: report.pipes.length, questions: report.questions,
    ...(report.baselineSchemaRepaired ? { baselineSchemaRepaired: true } : {}) }) + '\n');
}).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
