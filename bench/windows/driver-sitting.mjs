// VM-only fixture runner. Imports, planning and dry runs never inspect a desktop.
import { existsSync, openSync, closeSync, lstatSync, fstatSync, readSync, constants } from 'node:fs';
import { arch, release } from 'node:os';
import { win32, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createWindowsDriverClient, DRIVER_PROTOCOL } from '../../plugins/sleight/lib/windows-driver/client.mjs';
import { createWindowsReplClient } from '../../plugins/sleight/lib/windows-repl/client.mjs';
import { verifyWindowIdentity } from '../../plugins/sleight/lib/windows-repl/identity.mjs';
import { prepareWindowsHandHost, windowsHostExecutable } from '../../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { checkReportPath, integer, isMain, redactReport, runChild, writeReport } from './kit.mjs';
import { probeEngine } from './probe-engine.mjs';
import { WINDOWS_DRIVER_ERRORS } from '../../plugins/sleight/lib/windows-driver/errors.mjs';

export const SITTING_SCHEMA = 'sleight.windows-driver-sitting/1';
const phases = ['all', 'build', 'inventory', 'core', 'toolkit', 'capture', 'dpi', 'safety'];
const targets = ['notepad-untitled', 'notepad', 'calculator', 'edge', 'wpf', 'terminal', 'elevated', 'cover'];
const baseline = 'SLEIGHT-WDR7-' + 'x'.repeat(187); // 200 ASCII characters.
const suffix = 'WDR7-TYPED-' + 'y'.repeat(29); // 40 ASCII characters.
const failure = (code, note = code) => Object.assign(Error(note), { code });
const codeOf = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code) ? e.code : 'STEP_ERROR';
const skipped = note => ({ status: 'skip', note });
const passed = extra => ({ status: 'pass', ...extra });
const failed = (code, extra) => ({ status: 'fail', code, ...extra });

// UC3F acceptance targets, not a record of measured Windows behavior. None of
// these cases starts an intervention. The guest observer supplies measurements.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const nonnegative = { number: true };
const countBelow = lt => ({ integer: true, gte: 1, lt });
const beforeInput = (code, reason) => ({ code, reason, delivery: 'not-sent', retry: 'safe', unhealthy: false, postedMessages: 0, patternCalls: 0 });
const afterInput = (code, reason) => ({ code, reason, delivery: 'sent-unverified', retry: 'read-first', unhealthy: false,
  typed: countBelow(3000), keyUpsDelivered: true, postsAfterStop: 0 });
const noReads = { uiaFetches: 0, captures: 0 };
const browserBlocked = { code: 'BROWSER_TARGET_REFUSED', cards: 0, leases: 0, contentReads: 0 };
const identityBlocked = code => ({ code, uiaFetches: 0 });
const caseRule = (id, trials, expect) => ({ id, trials, expect });
const identityCases = override => ['direct-terminal', 'parent-terminal', 'direct-settings', 'parent-settings'].map(id =>
  caseRule(id, 10, { source: id.startsWith('direct') ? 'scheduled-direct' : 'parent',
    ...override ? { override: true } : {},
    ...override && id.endsWith('terminal') ? { readPassed: true } : identityBlocked(id.endsWith('settings') ? 'FORBIDDEN_SETTINGS' : 'FORBIDDEN_TARGET') }));
const uc3fRules = [
  ['person-idle', '100 idle actions preserve GetLastInputInfo; 10 Calculator reads refuse before input; 20 background actions pass.', [
    ...['notepad', 'wpf'].map(id => caseRule(id, 50, { lastInputUnchanged: true, refused: false, effectObserved: true })),
    caseRule('calculator-refused', 10, { code: 'HOSTED_APP_UNRESOLVED', postedMessages: 0, patternCalls: 0, uiaFetches: 0 }), caseRule('background-word', 20, { refused: false, effectObserved: true, typingTarget: { oneOf: ['word', 'wpf'] } })]],
  ['person-key-before', '20 scheduled keys measured 50 through 150 ms before typing refuse before any input.', [
    caseRule('scheduled-key', 20, { ...beforeInput('PERSON_TOOK_OVER', 'person-active'), source: 'scheduled-sendinput', keyLeadMs: { number: true, gte: 50, lte: 150 } })]],
  ['person-key-during', '10 typing pumps stop below 3000 units, preserve key-ups and post nothing after stop.', [
    caseRule('typing', 10, { ...afterInput('PERSON_TOOK_OVER', 'person-active'), requestedUnits: 3000, source: 'scheduled-sendinput' })]],
  ['lock-refused', '10 locked reads, captures and actions each refuse; 50 unlocked actions and 1000 WTS queries pass; flags are 0/1.', [
    ...['read', 'capture', 'action'].map(id => caseRule(id, 10, { ...beforeInput('SCREEN_LOCKED', 'session-locked'), ...noReads })),
    caseRule('unlocked-action', 50, { refused: false, effectObserved: true }), caseRule('wts-query', 1000, { ok: true }),
    caseRule('flags', 1, { locked: 0, unlocked: 1, firstAfterUnlockPassed: true })]],
  ['lock-during-type', '10 locked pumps stop below 3000 units, preserve key-ups and take no final read.', [
    caseRule('typing', 10, { ...afterInput('SCREEN_LOCKED', 'session-locked'), requestedUnits: 3000, finalReads: 0 })]],
  ['screensaver-refused', '5 screensaver trials refuse before reads, captures or input.', [
    caseRule('screensaver', 5, { ...beforeInput('SCREEN_LOCKED', 'screensaver'), ...noReads })]],
  ['session-switch-refused', '5 disconnected trials refuse without reads or input, then resume without driver restart.', [
    caseRule('switch', 5, { ...beforeInput('SCREEN_LOCKED', 'session-disconnected'), ...noReads, resumedWithoutRestart: true })]],
  ['uac-refused', '10 first calls at a secure prompt refuse with zero input; 100 idle probes and 50 actions have no false secure refusals.', [
    caseRule('prompt', 10, { ...beforeInput('SECURE_DESKTOP_ACTIVE', 'secure-desktop'), firstCall: true, inputWhilePrompt: 0 }),
    caseRule('idle-probe', 100, { falseSecureRefusal: false, effectObserved: true }), caseRule('idle-action', 50, { falseSecureRefusal: false, effectObserved: true })]],
  ['uac-hint', '10 prompt-raising actions report secure-desktop-seen on cap, budget or deadline, with zero stacked prompts and recovery.', [
    caseRule('raised-prompt', 10, { replyMode: { oneOf: ['cap', 'budget', 'deadline'] }, secureDesktopSeen: true, stackedPrompts: 0, firstAfterAnswerPassed: true })]],
  ['escape-stop-hardware', '10 hardware Escapes stop under 250 ms, preserve cleanup, are not swallowed and latch the next action.', [
    caseRule('hardware', 10, { ...afterInput('USER_STOPPED', 'escape'), typed: countBelow(4000), requestedUnits: 4000,
      source: { oneOf: ['owner-keyboard', 'qemu-display'] }, injectedFlag: false,
      stopMs: { number: true, lt: 250 }, swallowed: false, nextCode: 'USER_STOPPED', nextPosts: 0, nextPatternCalls: 0 })]],
  ['escape-ignored-injected', '10 scheduled SendInput Escapes have injected flags and zero Escape stops.', [
    caseRule('injected', 10, { source: 'scheduled-sendinput', injectedFlag: true, escapeStops: 0 })]],
  ['escape-ignored-posted', '10 stuck-menu posted Escapes generate zero hook events and zero Escape stops.', [
    caseRule('posted', 10, { source: 'stuck-menu-escape', hookEvents: 0, escapeStops: 0 })]],
  ['cancel-frame', '10 cancel flags set under 300 ms, both reply orders match their ids and cleanup completes.', [
    ...['cancel-first', 'job-first'].map(id => caseRule(id, 5, { ...afterInput('USER_STOPPED', 'cancel'),
      requestedUnits: 3000, flagMs: { number: true, lt: 300 }, jobReplyMatched: true, cancelReplyMatched: true }))]],
  ['direct-launch-terminal', '10 terminal and settings refusals on both direct and parent paths, zero UIA fetches.', identityCases(false)],
  ['direct-launch-override', '10 overridden terminal reads pass on each path; 10 settings refusals on each path retain zero UIA fetches.', identityCases(true)],
  ['browser-refused-edge', '10 Edge refusals each by name and HWND, zero cards, leases and content reads; 50 Notepad and 100 WPF acquisitions pass.', [
    ...['name', 'hwnd'].map(id => caseRule(id, 10, browserBlocked)),
    ...['notepad', 'wpf'].map(id => caseRule(id, id === 'wpf' ? 100 : 50, { refused: false, effectObserved: true }))]],
  ['browser-refused-firefox', '10 Firefox refusals each by name and HWND, zero cards, leases and content reads.', [
    ...['name', 'hwnd'].map(id => caseRule(id, 10, browserBlocked))]],
  ['browser-refused-renamed', '10 renamed Edge refusals with preserved PE identity, zero cards, leases and content reads.', [
    caseRule('renamed', 10, { ...browserBlocked, originalFilenamePreserved: true, productNamePreserved: true })]],
  ['checkpoint-cost', 'Measurement only: each checkpoint time with every safety check active. Keyboard latency not measured; no cost qualification.', [
    ...['session-probe', 'lock-check', 'desktop-check', 'person-input', 'budget-check', 'hook-install', 'hook-remove'].map(id => caseRule(id, 50, { elapsedMs: nonnegative })),
    caseRule('hook-callback', 100, { elapsedUs: nonnegative })]],
].map(([id, passRule, cases]) => ({ id, phase: 'safety', trials: 1, estimatedSeconds: 120, passRule, cases,
  // This sitting measures only. A separate reviewed item registers bounds.
  ...(id === 'checkpoint-cost' ? { measurementOnly: true } : {}) }));
function freezeDeep(value) {
  if (record(value) || Array.isArray(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
export const UC3F_ROWS = freezeDeep(uc3fRules);

function matchesObservation(value, expect, shapeOnly = false) {
  if (record(expect)) {
    if (expect.oneOf) return expect.oneOf.includes(value);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!expect.integer || Number.isSafeInteger(value)) &&
      (shapeOnly || (expect.lt === undefined || value < expect.lt) && (expect.gte === undefined || value >= expect.gte) &&
        (expect.lte === undefined || value <= expect.lte));
  }
  if (typeof expect === 'number') return Number.isSafeInteger(value) && value >= 0 && (shapeOnly || value === expect);
  if (typeof expect === 'boolean') return typeof value === 'boolean' && (shapeOnly || value === expect);
  // Strings are fixed vocabulary, never application text or exception messages.
  return value === expect;
}

export function evaluateSafetyEvidence(id, evidence) {
  const rule = UC3F_ROWS.find(s => s.id === id);
  if (!rule) throw failure('UNKNOWN_SAFETY_ROW');
  if (evidence === undefined) return skipped('VM observer evidence absent; this row was not measured');
  const invalid = () => failed('UC3F_EVIDENCE_INVALID', { elapsedMs: 0 });
  const cost = id === 'checkpoint-cost';
  const unregistered = cost;
  if (!record(evidence) || Object.keys(evidence).some(k => !(cost ? ['cases', 'plannedUtc', 'startedUtc', 'measurementOnly'] : ['cases']).includes(k)) ||
      evidence.measurementOnly !== undefined && evidence.measurementOnly !== 'bounds not registered' ||
      !Array.isArray(evidence.cases) || evidence.cases.length !== rule.cases.length ||
      new Set(evidence.cases.map(c => c?.id)).size !== rule.cases.length) return invalid();
  let ok = true;
  for (const c of rule.cases) {
    const actual = evidence.cases.find(a => a?.id === c.id);
    if (!exactKeys(actual, ['id', 'samples']) || !Array.isArray(actual.samples) ||
        (unregistered ? actual.samples.length > c.trials : actual.samples.length !== c.trials)) return invalid();
    for (const sample of actual.samples) {
      if (!exactKeys(sample, Object.keys(c.expect)) || Object.entries(c.expect).some(([key, expect]) => !matchesObservation(sample[key], expect, true))) return invalid();
      ok &&= Object.entries(c.expect).every(([key, expect]) => matchesObservation(sample[key], expect));
    }
  }
  let costs;
  if (cost) {
    if (unregistered) {
      // Measurement-only sitting: keep only checked numeric samples, counts and
      // descriptive statistics. No threshold, timestamp or noise echo qualifies it.
      costs = {};
      for (const c of evidence.cases) {
        const planned = rule.cases.find(r => r.id === c.id).trials;
        const stats = { count: c.samples.length, plannedCount: planned };
        if (c.id === 'hook-callback') stats.p99Us = percentile(c.samples.map(s => s.elapsedUs), .99);
        else {
          stats.p50Ms = percentile(c.samples.map(s => s.elapsedMs), .5);
          stats.p90Ms = percentile(c.samples.map(s => s.elapsedMs), .9);
        }
        costs[c.id] = stats;
      }
      const note = Object.values(costs).some(c => c.count > 0) ? 'bounds not registered' : 'not measured: no timing producer';
      return { ...skipped(note), evidence: { cases: structuredClone(evidence.cases), measurementOnly: 'bounds not registered' }, costs };
    }

  }
  return { ...ok ? passed() : failed('UC3F_RULE_FAILED'), elapsedMs: 0, evidence: structuredClone(evidence), ...costs ? { costs } : {} };
}

export function readSafetyEvidence(path, revision) {
  if (!path) return new Map();
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.isSymbolicLink()) throw failure('UC3F_EVIDENCE_INVALID');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bundle;
  try {
    const stat = fstatSync(fd);
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > limit) throw failure('UC3F_EVIDENCE_INVALID');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0, read;
    while (length < bytes.length && (read = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += read;
    if (length > limit) throw failure('UC3F_EVIDENCE_INVALID');
    bundle = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
  if (!exactKeys(bundle, ['schema', 'revision', 'rows']) || bundle.schema !== 'sleight.windows-uc3f-evidence/1' || bundle.revision !== revision ||
      !Array.isArray(bundle.rows) || bundle.rows.length > 19 || new Set(bundle.rows.map(s => s?.id)).size !== bundle.rows.length ||
      bundle.rows.some(s => !exactKeys(s, ['id', 'evidence']) || !UC3F_ROWS.some(r => r.id === s.id))) throw failure('UC3F_EVIDENCE_INVALID');
  return new Map(bundle.rows.map(s => [s.id, s.evidence]));
}

export function parseSittingArgs(args) {
  const o = { phase: 'all', runs: 20, dpi: 100, origin: 'standard', size: 'compact', revision: undefined };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--')) throw Error('Expected an option beginning with --');
    if (seen.has(key)) throw Error('Duplicate option');
    seen.add(key);
    if (key === '--dry-run') { o.dryRun = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw Error('Missing option value');
    const name = key.slice(2);
    if (targets.includes(name)) {
      if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw Error('Use a decimal HWND');
      o[name] = value;
    } else if (key === '--phase' && phases.includes(value)) o.phase = value;
    else if (key === '--runs') o.runs = integer(value, 1, 20, key);
    else if (key === '--dpi' && ['100', '125', '150', '200'].includes(value)) o.dpi = Number(value);
    else if (key === '--origin' && ['standard', 'negative'].includes(value)) o.origin = value;
    else if (key === '--size' && ['compact', 'large'].includes(value)) o.size = value;
    else if (key === '--elevated-pid') o.elevatedPid = integer(value, 1, 2147483647, key);
    else if (key === '--revision' && /^[a-f0-9]{40}$/.test(value)) o.revision = value;
    else if (key === '--output') o.output = value;
    else if (key === '--safety-evidence') o.safetyEvidence = value;
    else if (key === '--safety-attestation') o.safetyAttestation = value;
    else throw Error('Unknown or invalid sitting option');
  }
  if (!o.dryRun && (!o.output || !o.revision)) throw Error('--output and --revision are required');
  if (!o.dryRun && Boolean(o.safetyEvidence) !== Boolean(o.safetyAttestation)) throw failure('UC3F_EVIDENCE_INVALID');
  const handles = targets.map(t => o[t]).filter(Boolean);
  if (new Set(handles).size !== handles.length) throw Error('Fixture HWNDs must differ');
  return o;
}

export function sittingPlan(o = {}) {
  const steps = [
    ['build', 'build'], ['selftest', 'build'], ['inventory', 'core'],
    ...['notepad', 'calculator', 'edge'].map(t => [`read-${t}`, 'core', t]),
    ['invoke-calculator', 'core', 'calculator'], ['setvalue-notepad', 'core', 'notepad'],
    ['type-notepad', 'core', 'notepad'], ['return-notepad', 'core', 'notepad'],
    ['escape-calculator', 'core', 'calculator'], ['save-notepad', 'core', 'notepad-untitled'], ['batch-calculator', 'core', 'calculator'],
    ...['notepad', 'calculator', 'edge'].map(t => [`capture-${t}`, 'capture', t]),
    ...Object.entries({ win32: 'notepad', winui: 'calculator', wpf: 'wpf', chromium: 'edge' })
      .flatMap(([kit, t]) => ['value', 'wmchar', 'chord'].map(a => [`toolkit-${kit}-${a}`, 'toolkit', t])),
    ...[100, 125, 150, 200].flatMap(dpi => ['standard', 'negative'].map(origin => [`dpi-${dpi}-${origin}`, 'dpi', 'wpf'])),
    ['decline-no-read', 'safety', 'notepad'], ['terminal-refused', 'safety', 'terminal'], ['elevated-refused', 'safety', 'elevated'],
  ].map(([id, phase, target]) => ({ id, phase, ...(target ? { target: id === 'toolkit-win32-chord' ? 'notepad-untitled' : target } : {}), trials: ['build', 'safety'].includes(phase) || o.phase === 'inventory' ? 1 : o.runs ?? 20,
    estimatedSeconds: phase === 'toolkit' && target === 'calculator' || phase === 'dpi' && id !== `dpi-${o.dpi ?? 100}-${o.origin ?? 'standard'}` ? 0 : o.phase === 'inventory' ? 10 : phase === 'build' ? (id === 'build' ? 300 : 10) : phase === 'safety' ? 10 : 120 }));
  steps.push(...UC3F_ROWS);
  return o.phase && o.phase !== 'all' ? steps.filter(s => o.phase === 'inventory' ? s.id === 'inventory' : s.phase === o.phase) : steps;
}
export const selftestArguments = () => ['--driver-selftest'];
export function fixtureArguments(mode = 'editor') {
  if (!['editor', 'cover'].includes(mode)) throw Error('Invalid fixture mode');
  return ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'bench/windows/fixtures/driver-wpf.ps1', '-Mode', mode];
}
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function summarize(trials) {
  const times = trials.filter(t => t.status !== 'skip' && Number.isFinite(t.operationMs ?? t.elapsedMs)).map(t => t.operationMs ?? t.elapsedMs);
  const passTimes = trials.filter(t => t.status === 'pass' && Number.isFinite(t.operationMs ?? t.elapsedMs)).map(t => t.operationMs ?? t.elapsedMs);
  const walls = trials.filter(t => t.status !== 'skip' && Number.isFinite(t.elapsedMs)).map(t => t.elapsedMs);
  const settle = trials.flatMap(t => t.settleTimings ?? (Number.isFinite(t.settleMs) ? [t.settleMs] : []));
  const settleModes = {};
  for (const mode of trials.flatMap(t => t.settleModes ?? [])) settleModes[mode] = (settleModes[mode] ?? 0) + 1;
  const batches = trials.filter(t => Number.isFinite(t.batchMs)).map(t => t.batchMs);
  return { trials: trials.length, pass: trials.filter(t => t.status === 'pass').length, fail: trials.filter(t => t.status === 'fail').length,
    skip: trials.filter(t => t.status === 'skip').length, p50Ms: percentile(times, .5), p90Ms: percentile(times, .9),
    passP50Ms: percentile(passTimes, .5), passP90Ms: percentile(passTimes, .9),
    wallP50Ms: percentile(walls, .5), wallP90Ms: percentile(walls, .9),
    settleP50Ms: percentile(settle, .5), settleP90Ms: percentile(settle, .9),
    settleModes, batchP50Ms: percentile(batches, .5), batchP90Ms: percentile(batches, .9) };
}
const row = (step, trials, focus) => ({ id: step.id, phase: step.phase, trials, summary: summarize(trials), ...(focus ? { focus } : {}) });
export function focusVerdict(obs, { cover, start, end }) {
  if (!obs || !obs.hookInstalled || !obs.hookRemoved || obs.callbackError || obs.truncated ||
      !Array.isArray(obs.transitions) || !Array.isArray(obs.clicks)) return failed('OBSERVER_UNPROVED');
  const began = Date.parse(obs.startedUtc);
  if (!Number.isFinite(began) || !Number.isFinite(start) || !Number.isFinite(end) || start < began || end < start ||
      !Number.isFinite(obs.final?.ms) || end > began + obs.final.ms) return failed('OBSERVER_INTERVAL_MISSED');
  if (!cover || !/^0x[0-9a-f]+$/i.test(obs.initial?.hwnd ?? '') || BigInt(obs.initial.hwnd).toString() !== cover)
    return failed('COVER_NOT_FOREGROUND');
  if (obs.transitions.length || obs.clicks.length || obs.final?.hwnd !== obs.initial.hwnd) return failed('FOREGROUND_OR_INPUT_CHANGED');
  return passed({ transitions: 0, clicks: 0, durationMs: obs.final.ms });
}

// Discovery contains only fixed aliases and numeric identity. No window titles,
// paths, user names, machine names or arbitrary inventory strings survive.
export function discoverTargets(state) {
  if (!Array.isArray(state?.windows)) throw failure('DRIVER_PROTOCOL');
  return state.windows.flatMap(w => {
    let target = ['notepad', 'notepad-untitled', 'calculator', 'edge', 'wpf'].find(t => fixtureWindow(w, t));
    const image = String(w.image ?? '').split(/[\\/]/).pop().toLowerCase();
    if (!target && image === 'windowsterminal.exe') target = 'terminal';
    if (!target && image === 'powershell.exe' && w.title === 'Sleight WDR7 cover') target = 'cover';
    if (!target && w.refused === 'ELEVATED_TARGET') target = 'elevated-candidate';
    if (!target || !/^[1-9]\d*$/.test(w.windowId) || !Number.isSafeInteger(w.pid) || w.pid < 1) return [];
    return [{ target, windowId: w.windowId, pid: w.pid }];
  });
}

function lines(text) { return String(text ?? '').split('\n'); }
function idTarget(result, id) {
  const found = lines(result.text).filter(l => l.includes(`, ID: ${id}`) && new RegExp(`, ID: ${id}(?:,|$| \\()`).test(l));
  if (found.length !== 1) throw failure('FIXTURE_ELEMENT_MISSING');
  return Number(found[0].trimStart().match(/^\d+/)?.[0]);
}
function editorTarget(result, target) {
  if (target === 'wpf') return idTarget(result, 'Editor');
  if (target === 'edge') return idTarget(result, 'wdr7-editor');
  const found = lines(result.text).filter(l => /^\s*\d+ (?:text field|text area|text entry area)(?: |$)/.test(l) && !l.includes('<redacted>'));
  if (found.length !== 1) throw failure('FIXTURE_EDITOR_AMBIGUOUS');
  return Number(found[0].trimStart().match(/^\d+/)[0]);
}
function contains(result, text) { return String(result?.text ?? '').includes(text); }
function editorValue(result, target) {
  const id = editorTarget(result, target);
  const line = lines(result.text).find(l => new RegExp(`^\\s*${id} `).test(l));
  return line?.match(/, Value: (.*?)(?=, (?:Help|Secondary Actions): |$)/)?.[1];
}
function inserted(value, before, addition) {
  return typeof value === 'string' && value.includes(addition) && value.indexOf(addition) === value.lastIndexOf(addition) && value.replace(addition, '') === before;
}
const menuRows = result => lines(result.text).filter(l => /^\s*\d+ (?:menu(?! bar)|list item|navigation)/.test(l)).map(l => l.replace(/^\s*\d+ /, ''));
function calculatorShows(result, expected) {
  const display = lines(result.text).filter(l => /, ID: CalculatorResults(?:,|$| \()/.test(l));
  if (display.length !== 1) return false;
  const numbers = display[0].replace(/^\s*\d+\s+/, '').match(/[-+]?\d+(?:[.,]\d+)*/g);
  return !!numbers?.length && numbers.every(n => Number(n) === expected);
}
function counter(result, id, prefix) {
  const found = lines(result.text).filter(l => l.includes(`, ID: ${id}`));
  const match = found.length === 1 && found[0].match(new RegExp(prefix + ': (?:saved )?(\\d+)'));
  if (!match) throw failure('FIXTURE_COUNTER_MISSING');
  return Number(match[1]);
}
function fixtureWindow(w, target) {
  if (!w || w.refused) return false;
  const image = String(w.image ?? '').split(/[\\/]/).pop().toLowerCase();
  if (target === 'notepad-untitled') return image === 'notepad.exe' && /^\*?Untitled(?: - Notepad)?$/i.test(w.title ?? '');
  if (target === 'notepad') return image === 'notepad.exe' && /driver-notepad\.txt/i.test(w.title ?? '');
  if (target === 'calculator') return ['calculatorapp.exe', 'calculator.exe', 'calc.exe'].includes(image);
  if (target === 'edge') return image === 'msedge.exe' && /Sleight WDR7 page/.test(w.title ?? '');
  if (target === 'wpf') return ['powershell.exe', 'pwsh.exe'].includes(image) && w.title === 'Sleight WDR7 WPF';
  return false;
}
async function readTarget(o, driver, target) {
  const state = await driver.request('getState', {});
  const w = state.windows?.find(w => w.windowId === o[target]);
  if (!fixtureWindow(w, target)) throw failure('FIXTURE_IDENTITY_MISMATCH');
  const start = performance.now();
  const result = await driver.request('getAXState', { windowId: w.windowId, processStart: w.processStart });
  verifyWindowIdentity(w, result.window);
  return { ...result, clientReadMs: performance.now() - start };
}
function geometryCheck(g, o) {
  const facts = {};
  if (Number.isInteger(g?.dpi) && g.dpi > 0) facts.dpi = g.dpi;
  if (Array.isArray(g?.clientSize) && g.clientSize.length === 2 && g.clientSize.every(n => Number.isInteger(n) && n > 0)) [facts.width, facts.height] = g.clientSize;
  if (Array.isArray(g?.clientOrigin) && g.clientOrigin.length === 2 && g.clientOrigin.every(Number.isFinite)) [facts.originX, facts.originY] = g.clientOrigin;
  const refuse = code => { throw Object.assign(failure(code), { facts }); };
  if (g?.exposure !== 'covered') refuse('TARGET_NOT_COVERED');
  if (g.dpi !== o.dpi * .96) refuse('DPI_MISMATCH');
  if (facts.width === undefined || facts.originX === undefined) refuse('GEOMETRY_MISSING');
  if (o.origin === 'negative' && !(g.clientOrigin.some(n => n < 0) && g.monitors?.some(m => m[0] < 0 || m[1] < 0))) refuse('NEGATIVE_ORIGIN_NOT_MEASURED');
  if (o.origin === 'standard' && g.clientOrigin.some(n => n < 0)) refuse('STANDARD_ORIGIN_MISMATCH');
}

export async function executeStep(step, o, driver, { batch, clock = () => performance.now() } = {}) {
  const target = step.target;
  if (target && !o[target]) return skipped(`No --${target} HWND supplied`);
  let r, settleMs = 0, settleSamples = 0, route;
  const settleTimings = [], settleModes = [];
  const actionTimes = [];
  async function action(method, args) {
    const start = clock();
    const before = r.window;
    r = await driver.request(method, { windowId: r.window.windowId, processStart: r.window.processStart, readId: r.readId, args });
    verifyWindowIdentity(before, r.window);
    actionTimes.push(clock() - start);
    if (Number.isFinite(r.settle?.elapsedMs)) {
      settleMs += r.settle.elapsedMs; settleSamples++; settleTimings.push(r.settle.elapsedMs);
      settleModes.push(['event-quiet', 'poll-stable', 'cap', 'budget'].includes(r.settle.mode) ? r.settle.mode : 'unknown');
    }
    route = typeof r.route === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(r.route) ? r.route : undefined;
    return r;
  }
  const verified = (ok, code = 'POSTCONDITION_FAILED', extra = {}) => ({ ...ok ? passed() : failed(code),
    ...actionTimes.length ? { operationMs: actionTimes.at(-1) } : {},
    ...settleSamples ? { settleMs, settleSamples, settleTimings, settleModes } : {}, ...route ? { route } : {}, ...extra });
  if (step.id === 'inventory') {
    const start = performance.now();
    const state = await driver.request('getState', {});
    return verified(['notepad', 'calculator'].every(t => state.windows?.some(w => w.windowId === o[t] && fixtureWindow(w, t))), 'INVENTORY_MISSING_FIXTURES', { operationMs: performance.now() - start });
  }
  r = await readTarget(o, driver, target);
  geometryCheck(r.geometry, o);
  if (step.id.startsWith('read-')) {
    const full = typeof r.text === 'string' && /^Window: /.test(r.text) && !r.partialTree && !r.truncated;
    const fixturePresent = target === 'notepad' ? Array.from({ length: 40 }, (_, i) => `WDR7 fixture line ${String(i + 1).padStart(2, '0')}:`).every(text => contains(r, text)) :
      target === 'edge' ? lines(r.text).length >= 500 : true;
    return verified(full && fixturePresent, full ? 'READ_FIXTURE_CONTENT_MISSING' : 'PARTIAL_OR_INVALID_READ',
      { operationMs: r.clientReadMs, lines: lines(r.text).length, driverMs: Number(r.elapsedMs) || 0 });
  }
  if (step.id.startsWith('capture-')) {
    const start = performance.now();
    const c = await driver.request('getScreenshot', { windowId: r.window.windowId, processStart: r.window.processStart });
    const operationMs = performance.now() - start;
    verifyWindowIdentity(r.window, c.window);
    geometryCheck(c.geometry, o);
    const monitor = c.geometry.monitors?.find(m => Array.isArray(m) && m.length === 4 && m.every(Number.isFinite) && m[2] > 0 && m[3] > 0 &&
      c.geometry.clientOrigin.every((n, i) => n >= m[i] && n + c.geometry.clientSize[i] <= m[i] + m[i + 2]));
    if (!monitor) throw failure('CAPTURE_DISPLAY_MISSING');
    const png = c.screenshot?.mimeType === 'image/png' && typeof c.screenshot.data === 'string' ? Buffer.from(c.screenshot.data, 'base64') : Buffer.alloc(0);
    const ok = c.capture?.status === 'ok' && png.length > 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      png.readUInt32BE(16) === c.geometry.clientSize[0] && png.readUInt32BE(20) === c.geometry.clientSize[1];
    return verified(ok, c.capture?.status === 'black' ? 'PRINTWINDOW_BLACK' : 'CAPTURE_NOT_RENDERED', { operationMs, width: c.geometry.clientSize[0], height: c.geometry.clientSize[1], monitorWidth: monitor[2], monitorHeight: monitor[3],
      displayWidthFraction: c.geometry.clientSize[0] / monitor[2], displayHeightFraction: c.geometry.clientSize[1] / monitor[3], pngBytes: png.length });
  }
  if (step.id.startsWith('dpi-')) {
    const before = counter(r, 'Status', 'Invoked');
    await action('click', [[100 * o.dpi / 100, 96 * o.dpi / 100]]);
    geometryCheck(r.geometry, o);
    return verified(counter(r, 'Status', 'Invoked') === before + 1, 'DPI_CLICK_NOT_CONFIRMED', {
      dpi: r.geometry.dpi, originX: r.geometry.clientOrigin[0], originY: r.geometry.clientOrigin[1],
      width: r.geometry.clientSize[0], height: r.geometry.clientSize[1],
      clickX: o.dpi, clickY: 96 * o.dpi / 100, negativeMonitor: r.geometry.monitors?.some(m => m[0] < 0 || m[1] < 0) ?? false });
  }
  if (['invoke-calculator', 'batch-calculator'].includes(step.id)) {
    await action('click', [idTarget(r, 'clearButton')]);
    if (!calculatorShows(r, 0)) return failed('CALCULATOR_CLEAR_NOT_CONFIRMED');
    if (step.id === 'batch-calculator') {
      if (!batch) return skipped('JavaScript worker unavailable; no js timing collected');
      // Preparation and clear are excluded. This time includes one worker execute
      // call with four actions, IPC, settle and the returned result items.
      const result = await batch(r.window);
      return verified(result.ok, 'JS_BATCH_NOT_CONFIRMED', { batchMs: result.elapsedMs,
        operationMs: result.elapsedMs, settleMs: result.settleMs, settleSamples: result.settleSamples,
        settleTimings: result.settleTimings, settleModes: result.settleModes });
    }
    // Resolve each element number from the preceding action's returned map.
    const started = performance.now();
    for (const id of ['num7Button', 'plusButton', 'num5Button', 'equalButton']) await action('click', [idTarget(r, id)]);
    const batchMs = performance.now() - started;
    return verified(calculatorShows(r, 12), 'CALCULATOR_NOT_12', { batchMs, operationMs: batchMs });
  }
  if (step.id === 'escape-calculator') {
    const original = new Set(menuRows(r));
    await action('click', [idTarget(r, 'TogglePaneButton')]);
    const opened = menuRows(r).filter(l => !original.has(l));
    if (!opened.length) return failed('CALCULATOR_MENU_NOT_OBSERVED');
    await action('pressKey', ['Escape']);
    const after = new Set(menuRows(r));
    return verified(opened.every(l => !after.has(l)), 'ESCAPE_NOT_CONFIRMED');
  }
  const kind = step.id.split('-').at(-1);
  if (target === 'calculator') return skipped('Calculator has no editable Value/WM_CHAR fixture. Its Invoke and Escape rows run in core.');
  const editor = () => editorTarget(r, target);
  if (step.id === 'save-notepad' || kind === 'chord') {
    if (target === 'notepad-untitled') {
      const hasDialog = () => /^\s*\d+ dialog\b/m.test(r.text);
      if (hasDialog()) return failed('SAVE_DIALOG_PRESENT_BEFORE');
      // A named document is refused by readTarget before Ctrl+S can save it.
      await action('setValue', [editor(), baseline]);
      if (editorValue(r, target) !== baseline) return failed('SETVALUE_NOT_CONFIRMED');
      if (!fixtureWindow(r.window, target)) throw failure('FIXTURE_IDENTITY_MISMATCH');
      if (hasDialog()) return verified(false, 'SAVE_DIALOG_PRESENT_BEFORE');
      const before = r.text;
      await action('pressKey', ['ctrl+s']);
      const operationMs = actionTimes.at(-1);
      if (!hasDialog()) return verified(false, 'SAVE_DIALOG_NOT_OBSERVED', { changed: r.text !== before, operationMs });
      await action('pressKey', ['Escape']);
      return verified(!hasDialog(), 'SAVE_DIALOG_NOT_DISMISSED', { changed: r.text !== before, operationMs });
    }
    const id = target === 'wpf' ? 'ChordState' : 'wdr7-chord';
    const before = counter(r, id, 'Chord');
    await action('pressKey', ['ctrl+s']);
    return verified(counter(r, id, 'Chord') === before + 1, 'CHORD_NOT_CONFIRMED');
  }
  await action('setValue', [editor(), baseline]);
  if (step.id === 'setvalue-notepad' || kind === 'value') return verified(editorValue(r, target) === baseline);
  if (editorValue(r, target) !== baseline) return failed('SETVALUE_NOT_CONFIRMED');
  if (step.id === 'return-notepad') {
    await action('pressKey', ['Return']);
    const operationMs = actionTimes.at(-1);
    await action('typeText', [suffix]);
    const value = editorValue(r, target);
    return verified(inserted(value, baseline, ' ' + suffix) || inserted(value, baseline, '  ' + suffix), 'RETURN_NOT_CONFIRMED', { operationMs,
      note: 'Flattened UIA spacing cannot prove a line break; owner inspection of the first VM Return result is required.' });
  }
  await action('typeText', [suffix]);
  return verified(inserted(editorValue(r, target), baseline, suffix) && (kind !== 'wmchar' || ['WM_CHAR', 'WM_UNICHAR'].includes(route)),
    kind === 'wmchar' && !['WM_CHAR', 'WM_UNICHAR'].includes(route) ? 'WMCHAR_ROUTE_MISMATCH' : 'TYPING_NOT_CONFIRMED');
}

// WDR5's API is optional until integrated. These refusal paths must never reach a
// lease or a content call. A declined callback tests the dispatcher, not card UI.
export async function runSafetyChecks(o, driver, safetyModule) {
  const steps = sittingPlan({ phase: 'safety' }).filter(s => !s.passRule);
  if (typeof safetyModule?.createWindowsSafety !== 'function') return steps.map(s => row(s, [skipped('WDR5 safety wiring absent; rerun after integration')]));
  const state = await driver.request('getState', {});
  const results = [];
  for (const step of steps) {
    if (!o[step.target]) { results.push(row(step, [skipped(`No --${step.target} HWND supplied`)])); continue; }
    const w = state.windows?.find(w => w.windowId === o[step.target]);
    const image = String(w?.image ?? '').split(/[\\/]/).pop().toLowerCase();
    const correct = step.target === 'notepad' ? fixtureWindow(w, 'notepad') : step.target === 'terminal' ? image === 'windowsterminal.exe' : w?.refused === 'ELEVATED_TARGET' && Number.isSafeInteger(o.elevatedPid) && w.pid === o.elevatedPid;
    if (!correct) { results.push(row(step, [failed('SAFETY_FIXTURE_IDENTITY_MISMATCH')])); continue; }
    let content = 0, decisions = 0;
    const unexpected = () => { throw failure('UNEXPECTED_LEASE_OR_READ'); };
    const safety = safetyModule.createWindowsSafety({ allowForbidden: false, stuckEscape: false,
      driver: { request: async (method, params) => {
        if (method !== 'getState' && method !== 'listApps') { content++; throw failure('UNEXPECTED_CONTENT_READ'); }
        return driver.request(method, params);
      } }, approve: async () => { decisions++; return false; },
      lease: { ready: unexpected, acquire: unexpected, renew: unexpected, release() {}, close() {} } });
    const started = performance.now();
    try {
      await safety.request('getApp', { selector: { windowId: o[step.target] } });
      results.push(row(step, [failed('REFUSAL_MISSING', { contentRequests: content, decisions, elapsedMs: performance.now() - started })]));
    } catch (e) {
      const expected = { notepad: 'APP_DECLINED', terminal: 'FORBIDDEN_TARGET', elevated: 'ELEVATED_TARGET' }[step.target];
      const ok = e.code === expected && content === 0 && decisions === (step.target === 'notepad' ? 1 : 0);
      results.push(row(step, [{ ...ok ? passed() : failed(codeOf(e)), contentRequests: content, decisions, elapsedMs: performance.now() - started }]));
    } finally { safety.close(); }
  }
  return results;
}

const safetyPath = new URL('../../plugins/sleight/lib/windows-driver/safety.mjs', import.meta.url);
async function loadSafety() { return existsSync(safetyPath) ? import(safetyPath.href) : null; }

export function createFixtureBatch(driver, { platform, createRepl = createWindowsReplClient, clock = () => performance.now() } = {}) {
  let bound, settleMs = 0, settleSamples = 0;
  let settleTimings = [], settleModes = [];
  const request = async (method, params) => {
    const valid = bound && (method === 'getApp' ? params?.selector?.windowId === bound.windowId && Object.keys(params.selector).length === 1 :
      ['getAXState', 'click'].includes(method) && params?.windowId === bound.windowId && params?.processStart === bound.processStart);
    if (!valid || method === 'click' && (!Array.isArray(params.args) || params.args.length !== 1 ||
        !['num7Button', 'plusButton', 'num5Button', 'equalButton'].includes(params.args[0]?.id))) throw failure('FIXTURE_BATCH_REFUSED');
    const reply = await driver.request(method, params);
    if (method === 'click' && Number.isFinite(reply.settle?.elapsedMs)) {
      settleMs += reply.settle.elapsedMs; settleSamples++; settleTimings.push(reply.settle.elapsedMs);
      settleModes.push(['event-quiet', 'poll-stable', 'cap', 'budget'].includes(reply.settle.mode) ? reply.settle.mode : 'unknown');
    }
    return reply;
  };
  const repl = createRepl({ platform, driver: { request, restart: () => driver.restart(), close: async () => {} },
    // WDR2 and WDR5 have different dispatcher entry points. Both route through
    // the same fixture-only validator, outside the worker realm.
    admit: async () => true, dispatch: request });
  return {
    async run(window) {
      bound = { windowId: window.windowId, processStart: window.processStart };
      const prepared = await repl.execute({ timeout_ms: 15000, code: `var wdr7App = await cua.getApp({windowId:${JSON.stringify(bound.windowId)}},{emit:false})` });
      if (prepared.isError) throw failure('JS_WORKER_UNAVAILABLE');
      settleMs = 0; settleSamples = 0; settleTimings = []; settleModes = [];
      const started = clock();
      const result = await repl.execute({ timeout_ms: 15000, code: `await wdr7App.click({id:"num7Button"}); await wdr7App.click({id:"plusButton"}); await wdr7App.click({id:"num5Button"}); var wdr7Result = await wdr7App.click({id:"equalButton"}); var wdr7Display = wdr7Result.text.split("\\n").filter(l => /, ID: CalculatorResults(?:,|$| \\()/.test(l)); var wdr7Numbers = wdr7Display.length === 1 && wdr7Display[0].replace(/^\\s*\\d+\\s+/, "").match(/[-+]?\\d+(?:[.,]\\d+)*/g); nodeRepl.write({wdr7Batch12: !!wdr7Numbers?.length && wdr7Numbers.every(n => Number(n) === 12)})` });
      const elapsedMs = clock() - started;
      return { ok: !result.isError && result.content?.some(c => c.type === 'text' && /["']?wdr7Batch12["']?\s*:\s*true/.test(c.text)), elapsedMs, settleMs, settleSamples, settleTimings, settleModes };
    },
    close: () => repl.close(),
  };
}

export const minimalWindowsEnv = env => Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']
  .filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
export const collectorWindowsEnv = env => ({ ...minimalWindowsEnv(env), ...Object.fromEntries(
  ['OS', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]])) });
export async function assertVirtualMachine({ execute = runChild, env = process.env } = {}) {
  const command = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await execute(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress'],
  { env: minimalWindowsEnv(env), timeout: 10_000, lowPriority: true });
  if (result.reason || result.status !== 0 || result.cleanup === 'tree-unconfirmed') throw failure('VM_UNPROVED');
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw failure('VM_UNPROVED'); }
  const maker = info?.Manufacturer, model = info?.Model;
  if (typeof maker !== 'string' || typeof model !== 'string' ||
      !(/^(?:QEMU|VMware, Inc\.|innotek GmbH|Parallels Software International Inc\.)$/i.test(maker) ||
        maker === 'Microsoft Corporation' && model === 'Virtual Machine')) throw failure('VM_UNPROVED');
}
export const supportsBatch = (flags = process.allowedNodeEnvironmentFlags) => flags.has('--allow-net');
export async function assertStandardUser({ execute = runChild, env = process.env } = {}) {
  const result = await execute(win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'],
    { env: minimalWindowsEnv(env), timeout: 10_000, lowPriority: true });
  if (result.reason || result.status !== 0 || result.cleanup === 'tree-unconfirmed') throw failure('INTEGRITY_UNPROVED');
  const levels = [...result.stdout.matchAll(/S-1-16-(\d+)/g)].map(m => Number(m[1]));
  if (levels.length !== 1 || ![4096, 8192].includes(levels[0])) throw failure(levels.some(n => n >= 12288) ? 'ELEVATED_SITTING_REFUSED' : 'INTEGRITY_UNPROVED');
}
function expectedSkip(step, r) {
  return step.trials.length === 1 && step.trials[0].status === 'skip' &&
    (step.phase === 'dpi' && step.id !== `dpi-${r.configuration.dpi}-${r.configuration.origin}` && step.trials[0].code === 'DPI_CELL_NOT_SELECTED' ||
      /^toolkit-winui-(?:value|wmchar|chord)$/.test(step.id) && step.trials[0].code === 'CALCULATOR_EDITOR_NOT_APPLICABLE');
}

export async function runSitting(o, { platform = process.platform, prepare = prepareWindowsHandHost, createClient = createWindowsDriverClient,
  execute = runChild, executableOf = windowsHostExecutable, observe = probeEngine, loadSafetyModule = loadSafety, makeBatch = createFixtureBatch, now = Date.now, env = process.env, assertUnelevated = assertStandardUser, batchSupported = supportsBatch(), safetyContext } = {}) {
  if (platform !== 'win32') throw Error('The driver sitting requires Windows; no command was started');
  const plan = sittingPlan(o), steps = [];
  let driver, host, batch, driverReady = false, observationDeadline, stopped = false, interrupted = false;
  const controller = new AbortController();
  const interrupt = () => { interrupted = true; stopped = true; controller.abort(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const client = () => {
    const raw = createClient({ platform });
    return { request: (...args) => {
      if (interrupted) throw failure('SITTING_INTERRUPTED');
      if (observationDeadline !== undefined && now() >= observationDeadline) throw failure('OBSERVER_BUDGET');
      return raw.request(...args);
    }, close: () => raw.close(), restart: () => raw.restart() };
  };
  const report = { schema: SITTING_SCHEMA, mode: 'vm', revision: o.revision, phase: o.phase, requestedRuns: o.runs,
    environment: { platform, arch: arch(), node: process.version, osRelease: release() },
    configuration: { dpi: o.dpi, origin: o.origin, size: o.size },
    macReferenceMs: { idleRead: 48, postInputRead: 416, warmWrite: 72 },
    steps, discovery: [], verdict: 'incomplete', limitations: ['Fixture measurements; no model or full MCP relay timing. Batch timing includes the Windows js worker.',
      'Core and toolkit steps use a fixture-only driver client. Production admission is exercised only by the refusal checks.',
      'The driver is warmed with ping before observation. Compile and driver startup are excluded from API percentiles.',
      'PrintWindow nonblack PNG is checked; visual correctness needs owner inspection.',
      'Only the selected DPI/origin cell runs. Other cells need separate owner configurations.'] };
  try {
    await assertUnelevated({ execute, env });
    if (o.phase === 'inventory') {
      driver = client();
      const start = performance.now();
      report.discovery = discoverTargets(await driver.request('getState', {}));
      steps.push(row(plan[0], [passed({ elapsedMs: performance.now() - start })]));
    }
    for (const step of plan) {
      if (o.phase === 'inventory') break;
      if (stopped) { steps.push(row(step, [skipped(interrupted ? 'Owner interrupted the sitting; later steps were not run' : 'Previous fatal error or observer failure stopped this phase')])); continue; }
      if (step.phase === 'build') {
        const start = performance.now();
        try {
          host ??= await prepare({ platform, kind: 'driver', signal: controller.signal });
          if (host.status !== 'ready') throw failure(host.code ?? 'BUILD_FAILED');
          if (step.id === 'build') steps.push(row(step, [passed({ elapsedMs: performance.now() - start })]));
          else {
            const result = await execute(executableOf(host.receipt, { platform }), selftestArguments(), { env: minimalWindowsEnv(env), timeout: 10_000, lowPriority: true });
            if (result.cleanup === 'tree-unconfirmed') throw failure('SELFTEST_CLEANUP_UNPROVED');
            if (result.reason || result.status !== 0) throw failure('DRIVER_SELFTEST_FAILED');
            const value = JSON.parse(result.stdout);
            if (value.protocol !== DRIVER_PROTOCOL || value.drawing !== false || !Number.isInteger(value.passed) || value.passed < 1 || value.failed !== 0) throw failure('DRIVER_SELFTEST_INVALID');
            steps.push(row(step, [passed({ elapsedMs: performance.now() - start, nativePass: value.passed, nativeFail: value.failed })]));
          }
        } catch (e) { steps.push(row(step, [failed(codeOf(e), { elapsedMs: performance.now() - start,
          note: 'Build or selftest failed. Raw compiler and provider output is excluded.' })])); stopped = true; }
        continue;
      }
      if (step.phase === 'safety') {
        let evidence = new Map(), invalidEvidence = false;
        if (o.safetyEvidence || o.safetyAttestation) try {
          if (!o.safetyEvidence || !o.safetyAttestation) throw failure('UC3F_EVIDENCE_INVALID');
          const { readBounded, verifyAttestation, loadAttestationContext } = await import('./uc3f-export.mjs');
          const expected = safetyContext ?? await loadAttestationContext({ revision: o.revision,
            bank: dirname(o.safetyEvidence), execute, env });
          if (expected.revision !== o.revision) throw failure('UC3F_EVIDENCE_INVALID');
          evidence = verifyAttestation(readBounded(o.safetyEvidence), JSON.parse(readBounded(o.safetyAttestation, 16384)), expected);
        } catch { invalidEvidence = true; }
        const safety = await loadSafetyModule();
        if (safety) driver ??= client();
        steps.push(...await runSafetyChecks(o, driver, safety));
        for (const target of UC3F_ROWS) steps.push(row(target, [invalidEvidence ? failed('UC3F_EVIDENCE_INVALID', { elapsedMs: 0 }) :
          evaluateSafetyEvidence(target.id, evidence.get(target.id))]));
        break;
      }
      if (step.phase === 'dpi' && step.id !== `dpi-${o.dpi}-${o.origin}`) { steps.push(row(step, [{ ...skipped('DPI cell outside this configuration'), code: 'DPI_CELL_NOT_SELECTED' }])); continue; }
      if (step.phase === 'toolkit' && step.target === 'calculator') {
        steps.push(row(step, [{ ...skipped('Calculator has no editable Value/WM_CHAR fixture. Invoke and Escape run in core.'), code: 'CALCULATOR_EDITOR_NOT_APPLICABLE' }])); continue;
      }
      if (step.id === 'batch-calculator' && !batchSupported) {
        steps.push(row(step, [{ ...skipped('Node 25 or later with --allow-net is required for the js worker'), code: 'NODE_BATCH_UNSUPPORTED' }])); continue;
      }
      if (step.target && !o[step.target] || !o.cover || step.id === 'inventory' && (!o.notepad || !o.calculator)) {
        steps.push(row(step, [skipped('Supply explicit fixture HWNDs and --cover after preparing the VM')])); continue;
      }
      driver ??= client();
      if (!driverReady) { await driver.request('ping', {}); driverReady = true; }
      if (step.id === 'batch-calculator') batch ??= makeBatch(driver, { platform });
      const trials = [];
      let work, workStart, workEnd, ready = false;
      let observer;
      try { observer = await observe({ searchRoots: [], connectMs: 100, readMs: 100, observeSeconds: 120 }, { platform, env, onReady: () => {
        if (ready) return;
        ready = true;
        work = (async () => {
          workStart = now();
          observationDeadline = workStart + 100_000;
          for (let n = 0; n < o.runs; n++) {
            if (interrupted) { trials.push(failed('SITTING_INTERRUPTED', { elapsedMs: 0 })); break; }
            if (now() - workStart > 85_000) { trials.push(skipped('Observer budget exhausted; remaining trials not run')); break; }
            const start = performance.now();
            try {
              const trial = { ...await executeStep(step, o, driver, { batch: batch && (w => batch.run(w)) }), elapsedMs: performance.now() - start };
              trials.push(trial);
              if (trial.status !== 'pass') break;
            } catch (e) {
              trials.push(failed(codeOf(e), { ...e.facts, elapsedMs: performance.now() - start }));
              // Never repeat a possibly partial input, unsupported action or identity failure.
              stopped ||= interrupted || e.unhealthy || ['IDENTITY_CHANGED', 'FIXTURE_IDENTITY_MISMATCH', 'DRIVER_EXIT', 'DRIVER_PROTOCOL', 'DEADLINE_EXCEEDED', 'OBSERVER_BUDGET'].includes(e.code);
              break;
            }
          }
          workEnd = now();
        })();
      } }); } catch (e) { if (work) await work; throw e; }
      if (work) await work;
      observationDeadline = undefined;
      const focus = focusVerdict(observer.observation, { cover: o.cover, start: workStart, end: workEnd });
      if (!ready) trials.push(failed('OBSERVER_NOT_READY', { elapsedMs: 0 }));
      steps.push(row(step, trials, focus));
      if (focus.status !== 'pass') stopped = true;
    }
  } catch (e) {
    steps.push(row({ id: 'runner', phase: 'runner' }, [failed(codeOf(e), { elapsedMs: 0 })]));
  } finally {
    try { if (batch) await batch.close(); if (driver) await driver.close(); }
    catch { steps.push(row({ id: 'cleanup', phase: 'runner' }, [failed('CLEANUP_UNPROVED', { elapsedMs: 0 })])); }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  report.verdict = resultVerdict(report);
  return redactReport(report, env);
}

function resultVerdict(r) {
  return r.steps.some(s => s.summary.fail || s.focus?.status === 'fail') ? 'failed' :
    r.steps.length && sittingPlan({ phase: r.phase }).every(p => r.steps.some(s => s.id === p.id)) &&
    r.steps.every(s => expectedSkip(s, r) || s.summary.pass === (r.phase === 'inventory' || ['build', 'safety'].includes(s.phase) ? 1 : r.requestedRuns) && !s.summary.skip) ? 'passed-phase' : 'incomplete';
}

export function validateResult(r) {
  const exact = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k));
  if (!exact(r, ['schema', 'mode', 'revision', 'phase', 'requestedRuns', 'environment', 'configuration', 'macReferenceMs', 'steps', 'discovery', 'verdict', 'limitations']) ||
      r.schema !== SITTING_SCHEMA || r.mode !== 'vm' || !/^[a-f0-9]{40}$/.test(r.revision) || !phases.includes(r.phase) ||
      !Number.isInteger(r.requestedRuns) || r.requestedRuns < 1 || r.requestedRuns > 20 || !Array.isArray(r.steps) ||
      !['passed-phase', 'failed', 'incomplete'].includes(r.verdict)) throw Error('Invalid sitting result');
  if (!exact(r.environment, ['platform', 'arch', 'node', 'osRelease']) || r.environment.platform !== 'win32' ||
      !['arm64', 'x64', 'ia32'].includes(r.environment.arch) || !/^v\d+\.\d+\.\d+/.test(r.environment.node) ||
      typeof r.environment.osRelease !== 'string' ||
      !exact(r.configuration, ['dpi', 'origin', 'size']) || ![100, 125, 150, 200].includes(r.configuration.dpi) ||
      !['standard', 'negative'].includes(r.configuration.origin) || !['compact', 'large'].includes(r.configuration.size) ||
      !isDeepStrictEqual(r.macReferenceMs, { idleRead: 48, postInputRead: 416, warmWrite: 72 }) ||
      !Array.isArray(r.limitations) || !r.limitations.every(s => typeof s === 'string') || !Array.isArray(r.discovery) ||
      !r.discovery.every(d => exact(d, ['target', 'windowId', 'pid']) && [...targets, 'elevated-candidate'].includes(d.target) &&
        /^[1-9]\d*$/.test(d.windowId) && Number.isSafeInteger(d.pid) && d.pid > 0)) throw Error('Invalid metadata');
  const known = new Map([...sittingPlan(), { id: 'runner', phase: 'runner' }, { id: 'cleanup', phase: 'runner' }].map(s => [s.id, s.phase]));
  if (new Set(r.steps.map(s => s.id)).size !== r.steps.length) throw Error('Duplicate step');
  const allowedTrials = ['status', 'note', 'code', 'elapsedMs', 'operationMs', 'settleMs', 'settleSamples', 'settleTimings', 'settleModes', 'driverMs', 'route', 'lines', 'width', 'height', 'monitorWidth', 'monitorHeight', 'displayWidthFraction', 'displayHeightFraction', 'pngBytes', 'dpi', 'batchMs', 'changed', 'nativePass', 'nativeFail', 'contentRequests', 'decisions', 'originX', 'originY', 'clickX', 'clickY', 'negativeMonitor', 'evidence', 'costs'];
  const numeric = allowedTrials.filter(k => !['status', 'note', 'code', 'route', 'changed', 'settleTimings', 'settleModes', 'negativeMonitor', 'evidence', 'costs'].includes(k));
  for (const step of r.steps) {
    if (!exact(step, ['id', 'phase', 'trials', 'summary', 'focus']) || known.get(step.id) !== step.phase || !Array.isArray(step.trials) || !step.trials.length || step.trials.length > 20) throw Error('Invalid step');
    if (!['runner', 'cleanup'].includes(step.id) && !sittingPlan({ phase: r.phase }).some(s => s.id === step.id)) throw Error('Step outside selected phase');
    if (UC3F_ROWS.some(s => s.id === step.id)) {
      if (step.trials.length !== 1) throw Error('Invalid UC3F trial count');
      const t = step.trials[0];
      const checked = evaluateSafetyEvidence(step.id, t.evidence);
      // Unmeasured rows have no evidence to regrade. Accept only fixed runner reasons.
      const unmeasured = exactKeys(t, ['status', 'note']) && t.status === 'skip' &&
        (t.note === 'Owner interrupted the sitting; later steps were not run' ||
         t.note === 'Previous fatal error or observer failure stopped this phase');
      // Invalid input is deliberately excluded from published reports.
      if (!unmeasured && !(t.status === 'fail' && t.code === 'UC3F_EVIDENCE_INVALID' && t.evidence === undefined && exactKeys(t, ['status', 'code', 'elapsedMs']) && t.elapsedMs === 0) &&
          !isDeepStrictEqual(t, checked)) throw Error('Invalid UC3F evidence verdict');
    } else if (step.trials.some(t => t.evidence !== undefined || t.costs !== undefined)) throw Error('Evidence outside UC3F row');
    for (const t of step.trials) {
      if (!exact(t, allowedTrials) || !['pass', 'fail', 'skip'].includes(t.status) || t.status !== 'skip' && !Number.isFinite(t.elapsedMs) ||
          numeric.some(k => t[k] !== undefined && (!Number.isFinite(t[k]) || !['originX', 'originY'].includes(k) && t[k] < 0)) ||
          t.note !== undefined && typeof t.note !== 'string' || t.code !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(t.code) ||
          t.route !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(t.route) ||
          ['changed', 'negativeMonitor'].some(k => t[k] !== undefined && typeof t[k] !== 'boolean') ||
          t.status === 'fail' && !t.code || t.status === 'skip' && !t.note) throw Error('Invalid trial');
      if (t.settleTimings !== undefined && (!Array.isArray(t.settleTimings) || !t.settleTimings.every(n => Number.isFinite(n) && n >= 0) ||
          t.settleTimings.length !== t.settleSamples || t.settleTimings.reduce((a, b) => a + b, 0) !== t.settleMs) ||
          t.settleModes !== undefined && (!Array.isArray(t.settleModes) || t.settleModes.length !== t.settleSamples ||
            !t.settleModes.every(m => ['event-quiet', 'poll-stable', 'cap', 'budget', 'unknown'].includes(m)))) throw Error('Invalid settle');
    }
    if (!isDeepStrictEqual(step.summary, summarize(step.trials))) throw Error('Invalid summary');
    if (step.summary.pass && r.phase !== 'inventory' && ['core', 'capture', 'toolkit', 'dpi'].includes(step.phase) && !step.focus) throw Error('Missing focus evidence');
    if (step.focus && (!exact(step.focus, ['status', 'code', 'transitions', 'clicks', 'durationMs']) || !['pass', 'fail'].includes(step.focus.status))) throw Error('Invalid focus');
    if (step.focus?.status === 'pass' && (step.focus.transitions !== 0 || step.focus.clicks !== 0 || !Number.isFinite(step.focus.durationMs) || step.focus.durationMs < 0)) throw Error('Invalid focus evidence');
    if (step.focus?.status === 'fail' && !/^[A-Z][A-Z0-9_]{0,79}$/.test(step.focus.code)) throw Error('Invalid focus failure');
  }
  if (r.verdict !== resultVerdict(r)) throw Error('Invalid verdict');
  return true;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const o = parseSittingArgs(args), print = dependencies.print ?? (s => process.stdout.write(s));
  if (o.dryRun) {
    const plan = { schema: SITTING_SCHEMA, mode: 'dry-run', steps: sittingPlan(o), refusalMessages: WINDOWS_DRIVER_ERRORS,
      fixtureArguments: ['editor', 'cover'].map(fixtureArguments), selftestArguments: selftestArguments() };
    print(JSON.stringify(plan, null, 2) + '\n'); return plan;
  }
  checkReportPath(o.output);
  if ((dependencies.platform ?? process.platform) !== 'win32') throw Error('The driver sitting requires Windows; no command was started');
  await (dependencies.assertVm ?? assertVirtualMachine)({ execute: dependencies.execute ?? runChild, env: dependencies.env ?? process.env });
  const report = await runSitting(o, dependencies);
  try { (dependencies.validate ?? validateResult)(report); }
  catch {
    // Preserve the already projected and redacted measurements, without validator error text.
    report.verdict = 'invalid';
  }
  writeReport(o.output, report);
  print(JSON.stringify({ schema: report.schema, verdict: report.verdict, steps: report.steps.map(s => ({ id: s.id, ...s.summary, focusStatus: s.focus?.status ?? 'not-observed',
    ...['read-notepad', 'read-calculator'].includes(s.id) ? { readP50Under300Ms: s.summary.passP50Ms === null ? null : s.summary.passP50Ms < 300 } : {} })) }) + '\n');
  return report;
}
if (isMain(import.meta.url)) main().then(r => { process.exitCode = r.mode === 'dry-run' || r.verdict === 'passed-phase' ? 0 : r.verdict === 'incomplete' ? 2 : 1; })
  .catch(() => { process.stderr.write('Driver sitting refused or could not write its report. Check arguments, output path and Windows platform.\n'); process.exitCode = 1; });
