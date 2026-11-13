// Offline guest checks only. No browser, renderer, consent host UI, or engine is launched.
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { windowsSharedPlans } from '../../scripts/windows-plan-compat.mjs';
import { checkReportPath, integer, isMain, ROOT, runChild, stderrTail, writeReport } from './kit.mjs';

export const MANIFEST = new URL('./check-manifest.json', import.meta.url);
export const FIXTURE = new URL('./fixtures/swift-ring-plans.json.gz', import.meta.url);

// Raw stdio-spawn diagnostics only. Claude Code's own plugin loader still needs a VM check.
export async function probeWindowsLaunchers({ root = ROOT, platform = process.platform, execute = runChild, env = process.env } = {}) {
  if (platform !== 'win32') throw Error('Launcher probes require Windows');
  const script = win32.join(root, 'plugins', 'sleight', 'bin', 'sleight-mcp');
  // CMD resolves the extensionless manifest path through PATHEXT. Never ask CreateProcess to execute
  // a shell script or .cmd directly. /s forms model shell-mediated loading; the explicit /c form is separate.
  const cmd = 'C:\\Windows\\System32\\cmd.exe';
  const forms = [
    ['extensionless', cmd, ['/d', '/s', '/c', `""${script}" --doctor"`]],
    ['cmd', cmd, ['/d', '/s', '/c', `""${script}.cmd" --doctor"`]],
    ['cmd-exe', cmd, ['/d', '/c', `""${script}.cmd" --doctor"`]],
  ];
  const results = [];
  for (const [form, command, args] of forms) {
    const config = mkdtempSync(join(tmpdir(), 'lane-claude-'));
    try {
      const started = performance.now();
      const result = await execute(command, args, { cwd: root, env: { ...env, CLAUDE_CONFIG_DIR: config },
        timeout: 60000, maxBytes: 65536, lowPriority: true, windowsVerbatimArguments: true });
      results.push({ form, exitCode: result.status, reason: result.reason, cleanup: result.cleanup,
        durationMs: Math.round(performance.now() - started), doctorReached: /^platform\s+win32\r?$/m.test(result.stdout),
        stderrTail: stderrTail(result.stderr, env) });
      if (result.reason === 'interrupted' || ['tree-unconfirmed', 'restore-required'].includes(result.cleanup)) break;
    } finally { rmSync(config, { recursive: true, force: true }); }
  }
  return results;
}

export function readFixture(path) {
  const bytes = readFileSync(path);
  return JSON.parse(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8') : bytes.toString('utf8'));
}

function contained(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export function discoverSuites(root, manifest) {
  if (manifest.schema !== 'sleight.windows-check-manifest/1' || !Array.isArray(manifest.suites) || manifest.suites.length !== 4 ||
      new Set(manifest.suites.map(s => s.item)).size !== 4) throw new Error('Manifest must name WIN1 through WIN4 exactly once');
  const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort();
  const assigned = new Set();
  return manifest.suites.map(suite => {
    if (!/^WIN[1-4]$/.test(suite.item) || !Array.isArray(suite.patterns) || suite.patterns.length > 20 || !suite.patterns.length) throw new Error('Invalid suite');
    const patterns = suite.patterns.map(pattern => {
      if (typeof pattern !== 'string' || !/^[a-zA-Z0-9.*-]+\.test\.mjs$/.test(pattern)) throw new Error('Use test basenames only');
      return new RegExp('^' + pattern.replaceAll('.', '\\.').replaceAll('*', '.*') + '$');
    });
    const selected = files.filter(file => patterns.some(p => p.test(file)));
    for (const file of selected) {
      const path = join(root, 'tests', file);
      if (!lstatSync(path).isFile() || !contained(root, path) || assigned.has(file)) throw new Error('Symlinked or duplicate test selection');
      assigned.add(file);
    }
    return { item: suite.item, files: selected.map(file => 'tests/' + file) };
  });
}

export function tapCounts(text) {
  const take = key => {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    return matches.length === 1 ? Number(matches[0][1]) : null;
  };
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, take(key)]));
  if (Object.values(counts).some(n => n === null) || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) return null;
  return counts;
}

// Compare every key and array entry. Only numeric serialization noise is tolerated.
export function comparePlans(expected, actual, epsilon = 1e-6, path = '$') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Number.isFinite(actual) && Math.abs(expected - actual) <= epsilon ? null : `${path}: number differs`;
  }
  if (expected === actual) return null;
  if (typeof expected !== typeof actual || expected === null || actual === null) return `${path}: type or value differs`;
  if (typeof expected !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) return `${path}: value differs`;
  const a = Object.keys(expected).sort(), b = Object.keys(actual).sort();
  if (a.length !== b.length || a.some((key, i) => key !== b[i])) return `${path}: keys differ`;
  for (const key of a) {
    const difference = comparePlans(expected[key], actual[key], epsilon, `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

export function validateFixture(fixture) {
  if (fixture.schema !== 'sleight.windows-ring-fixtures/1' || !/^[a-f0-9]{64}$/.test(fixture.sourceSha256) ||
      typeof fixture.source !== 'string' || !/^[a-zA-Z0-9_./-]+\.swift$/.test(fixture.source) || fixture.source.split('/').includes('..') || fixture.source.startsWith('/') ||
      !Array.isArray(fixture.cases) || !fixture.cases.length || fixture.cases.length > 64) throw new Error('Invalid Swift fixture');
  const ids = new Set();
  for (const entry of fixture.cases) {
    if (!/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id) || !Array.isArray(entry.frames) || !Array.isArray(entry.flags) ||
        !Array.isArray(entry.output) || ![0, 65].includes(entry.exitCode) || entry.frames.length > 128) throw new Error('Invalid fixture case');
    ids.add(entry.id);
    for (const flag of entry.flags) {
      if (!/^(--cursor-style=(ring|seam)|--reduce-motion|--secure-input|--seed=\d+|--clip=-?[\d.,-]+|--gone=[\d,]+)$/.test(flag)) throw new Error('Unsafe fixture flag');
    }
    if (!entry.flags.includes('--cursor-style=ring') && !entry.flags.includes('--cursor-style=seam')) throw new Error('Fixture must select a ring theme');
  }
}

export async function compareHost(host, fixture, { execute = runChild, root = ROOT, env = process.env } = {}) {
  validateFixture(fixture);
  const outcomes = [];
  // No planner frames are sent until a reviewed host confirms a non-drawing mode.
  const capability = await execute(host, ['--capabilities'], { cwd: root, env, input: '', timeout: 3000, maxBytes: 4096 });
  let info;
  try { info = JSON.parse(capability.stdout.trim()); } catch { /* Refuse legacy or unknown hosts. */ }
  if (capability.reason || capability.status !== 0 || info?.schema !== 'sleight.windows-host-capabilities/1' ||
      info.drawing !== false || !Array.isArray(info.modes) || !info.modes.includes('--plan-dump')) {
    return { verdict: 'fail', reason: 'Host did not confirm non-drawing --plan-dump capability',
      exitCode: capability.status, childReason: capability.reason, cleanup: capability.cleanup, stderrTail: stderrTail(capability.stderr, env), cases: outcomes };
  }
  for (const entry of fixture.cases) {
    const result = await execute(host, ['--plan-dump', ...entry.flags], { cwd: root, env,
      input: entry.frames.map(frame => JSON.stringify(frame) + '\n').join(''), timeout: outcomes.length === 0 ? 3000 : 20_000 });
    let output, difference;
    try { output = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).map(JSON.parse) : []; }
    catch { difference = 'invalid JSON lines'; }
    difference ||= result.reason || (result.status !== entry.exitCode ? 'exit code differs' : null) ||
      (entry.exitCode === 0 && output?.at(-1)?.effect !== 'end' ? 'missing end record' : null) ||
      (!output ? 'missing output' : comparePlans(windowsSharedPlans(entry.output), windowsSharedPlans(output)));
    outcomes.push({ id: entry.id, verdict: difference ? 'fail' : 'pass', exitCode: result.status, difference,
      ...(difference ? { stderrTail: stderrTail(result.stderr, env), cleanup: result.cleanup } : {}) });
    if (result.reason || !output || (entry.exitCode === 0 && output.at(-1)?.effect !== 'end')) break;
  }
  return { verdict: outcomes.length === fixture.cases.length && outcomes.every(o => o.verdict === 'pass') ? 'pass' : 'fail', cases: outcomes };
}

export async function runChecks({ root = ROOT, manifest, fixture, host, platform = process.platform, execute = runChild, env = process.env,
  timeout = 120_000, nodeVersion = process.versions.node, probeLaunchers = false } = {}) {
  if (platform !== 'win32') throw new Error('Guest checks require Windows; use --list for a host-side inventory');
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24) throw new Error('Use Node 24 or later in the Windows guest');
  const suites = discoverSuites(root, manifest);
  validateFixture(fixture);
  const source = join(root, fixture.source);
  if (!contained(root, source) || createHash('sha256').update(readFileSync(source, 'utf8').replaceAll('\r\n', '\n')).digest('hex') !== fixture.sourceSha256) {
    throw new Error('Swift source changed after CRLF line endings were normalized; refresh and review the fixture on the Mac');
  }
  if (host && (!isAbsolute(host) || !contained(root, host) || !lstatSync(host).isFile() || !host.toLowerCase().endsWith('.exe'))) {
    throw new Error('--host must be a reviewed regular .exe inside this checkout');
  }
  const report = { schema: 'sleight.windows-checks/1', platform, node: nodeVersion,
    fixtureSourceSha256: fixture.sourceSha256, suites: [], comparison: { verdict: 'blocked', reason: '--host was not supplied' },
    unverified: ['Interactive rendering', 'capture exclusion', 'DPI across monitors', 'idle CPU', 'engine handshake and approvals', 'turbo browser qualification'] };
  for (const suite of suites) {
    if (!suite.files.length) { report.suites.push({ ...suite, verdict: 'blocked', reason: 'No matching tests in this checkout' }); continue; }
    const config = mkdtempSync(join(tmpdir(), 'lane-claude-'));
    try {
      const result = await execute(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...suite.files], {
        cwd: root, env: { ...env, CLAUDE_CONFIG_DIR: config }, timeout, lowPriority: true,
      });
      const counts = tapCounts(result.stdout);
      const verdict = result.reason || result.status !== 0 || !counts || counts.fail || counts.cancelled ? 'fail' :
        (counts.pass === 0 || counts.skipped || counts.todo ? 'incomplete' : 'pass');
      report.suites.push({ ...suite, verdict, exitCode: result.status, reason: result.reason, counts,
        ...(verdict === 'fail' ? { stderrTail: stderrTail(result.stderr, env), cleanup: result.cleanup } : {}) });
      if (result.reason === 'interrupted' || ['tree-unconfirmed', 'restore-required'].includes(result.cleanup)) break;
    } finally { rmSync(config, { recursive: true, force: true }); }
  }
  if (host && report.suites.length === 4 && !report.suites.some(s => s.reason === 'interrupted' || ['tree-unconfirmed', 'restore-required'].includes(s.cleanup))) {
    report.comparison = await compareHost(host, fixture, { execute, root, env });
  }
  if (probeLaunchers && !report.suites.some(s => s.reason === 'interrupted' || ['tree-unconfirmed', 'restore-required'].includes(s.cleanup)))
    report.launcherProbes = await probeWindowsLaunchers({ root, platform, execute, env });
  const probeStopped = report.launcherProbes?.some(p => p.reason === 'interrupted' || ['tree-unconfirmed', 'restore-required'].includes(p.cleanup));
  const failed = probeStopped || report.suites.some(s => s.verdict === 'fail') || report.comparison.verdict === 'fail';
  report.verdict = failed ? 'fail' : (report.suites.length === 4 && report.suites.every(s => s.verdict === 'pass') && report.comparison.verdict === 'pass' ? 'pass' : 'incomplete');
  report.exitCode = failed ? 1 : (report.verdict === 'pass' ? 0 : 2);
  return report;
}

export function parseCheckArgs(args) {
  const options = { manifestPath: MANIFEST, fixturePath: FIXTURE, timeout: 120_000, list: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error('Duplicate option');
    seen.add(key);
    if (key === '--list') { options.list = true; continue; }
    if (key === '--probe-launchers') { options.probeLaunchers = true; continue; }
    const value = args[++i];
    if (!value) throw new Error('Missing option value');
    switch (key) {
      case '--output': options.output = value; break;
      case '--manifest': options.manifestPath = value; break;
      case '--fixture': options.fixturePath = value; break;
      case '--host': options.host = resolve(value); break;
      case '--timeout-ms': options.timeout = integer(value, 1000, 600_000, key); break;
      default: throw new Error('Unknown checks option');
    }
  }
  if (!options.list && !options.output) throw new Error('--output is required');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseCheckArgs(args);
  if (options.list) return { suites: discoverSuites(ROOT, JSON.parse(readFileSync(options.manifestPath, 'utf8'))), comparisonMode: '--plan-dump', executes: false };
  checkReportPath(options.output);
  try {
    const manifest = JSON.parse(readFileSync(options.manifestPath, 'utf8'));
    const fixture = readFixture(options.fixturePath);
    const report = await runChecks({ ...options, manifest, fixture });
    writeReport(options.output, report);
    process.exitCode = report.exitCode;
    return report;
  } catch (error) {
    writeReport(options.output, { schema: 'sleight.windows-checks/1', verdict: 'error', exitCode: 1, reason: error.message });
    throw error;
  }
}
if (isMain(import.meta.url)) main().then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
