#!/usr/bin/env node
// RT1 gate orchestration. Imports of this module never import or execute run.mjs.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStep1, engineIdentity, validEngine, sameIdentity, validRuntimeReceipt, RELEASE_POLICY,
  gateVerdict, gateMarkdown, loadParityProof, verifyParityProof } from './runtime-gate.mjs';
import { awaitEngineIdle, bindOwnBinary, observeRuntimeAttempt, validEngineExecution } from './runtime-evidence.mjs';
import { prepareGlide, glidePreparationSummary, glideBuildCheck, glideBuildSummary } from './glide-preflight.mjs';
import { loadReceipt, loadSummary } from './load.mjs';

export const GATE_TASKS = Object.freeze(['calculator-click', 'calculator-menu', 'textedit-save', 'preview-read', 'textedit-calculator']);
export const RUNTIME_ARMS = Object.freeze({ sleight: 'engine', 'sleight-own': 'own' });
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
function checkedSource(read) {
  try { return read(); }
  catch (error) {
    if (error.code === 'ETIMEDOUT') throw Error('SOURCE_CHECK_TIMEOUT', { cause: error });
    throw error;
  }
}
export function sourceIdentity(root = ROOT, { read = execFileSync } = {}) {
  const options = { cwd: root, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' };
  return checkedSource(() => ({ sleightCommit: read('/usr/bin/git', ['rev-parse', 'HEAD'], options).trim(),
    sleightDirty: !!read('/usr/bin/git', ['status', '--porcelain'], options).trim() }));
}
export function runtimeName(env = process.env) {
  const name = env.SLEIGHT_RUNTIME ?? 'engine';
  if (!['engine', 'own'].includes(name)) throw Error('INVALID_RUNTIME: SLEIGHT_RUNTIME must be engine or own');
  return name;
}
export function runtimeBuild(root = ROOT, runtime = runtimeName(), engineVersion = null) {
  if (runtime === 'engine') return { kind: 'engine', version: engineVersion };
  const base = join(root, 'plugins/sleight/lib/mac-driver');
  if (!existsSync(join(base, 'client.mjs'))) throw Error('RUNTIME_ABSENT: own needs RT2 mac-driver/client.mjs');
  const files = directory => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name))
      : entry.isFile() && /\.(swift|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : []);
  const hash = createHash('sha256');
  for (const file of files(base)) hash.update(file.slice(base.length)).update('\0').update(readFileSync(file));
  return { kind: 'own', sourceSha256: hash.digest('hex') };
}
export function assertOwnRelay(root = ROOT) {
  // RT8 owns this selector and the relay wiring. Never label an engine fallback as the own arm.
  if (!existsSync(join(root, 'plugins/sleight/lib/runtime-select.mjs')) ||
      !readFileSync(join(root, 'plugins/sleight/lib/relay.mjs'), 'utf8').includes('runtime-select')) {
    throw Error('RUNTIME_ABSENT: sleight-own needs RT8 runtime-select and relay wiring');
  }
}
export function outputStem(requested) {
  if (!requested) throw Error('OUTPUT_REQUIRED: pass --out with a new report stem');
  const stem = resolve(requested);
  for (let path = stem; path !== dirname(path); path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('OUTPUT_SYMLINK');
  }
  if ([stem, stem + '.json', stem + '.md'].some(existsSync)) throw Error('OUTPUT_EXISTS');
  return stem;
}
export function writeRuntimeReport(stem, report, markdown) {
  mkdirSync(dirname(stem), { recursive: true });
  writeFileSync(stem + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(stem + '.md', markdown, { flag: 'wx', mode: 0o600 });
}
export function armPlan({ tasks = GATE_TASKS, runs = 5, arms = ['sleight', 'sleight-own'] } = {}) {
  if (runs !== 5 || tasks.length !== GATE_TASKS.length || new Set(tasks).size !== tasks.length || tasks.some(t => !GATE_TASKS.includes(t))) {
    throw Error('GATE_PLAN_REQUIRED: RT1 uses all five tasks, five runs per side');
  }
  if (arms.join(',') !== 'sleight,sleight-own') throw Error('GATE_ARMS_REQUIRED: --arm sleight,sleight-own');
  return Array.from({ length: runs }, (_, index) => tasks.flatMap(task =>
    (index % 2 ? [...arms].reverse() : arms).map(arm => ({ task, run: index + 1, arm, runtime: RUNTIME_ARMS[arm] })))).flat();
}
export function armCommand(row, { root = ROOT, env = process.env } = {}) {
  return { command: process.execPath, args: [join(root, 'bench/run.mjs'), '--suite', 'world', '--arm', 'sleight', '--tasks', row.task,
    '--runs', '1', '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'login', '--clean-arms', '--owner-away', '--no-hub'],
    env: { ...env, SLEIGHT_RUNTIME: row.runtime, SLEIGHT_HAND: '0', SLEIGHT_NO_HUB: '1',
      ...(row.runNonce && { SLEIGHT_RUNTIME_RUN_NONCE: row.runNonce }) } };
}
const lowerMedian = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
export function scoreRuntimeArms(rows, { fixRound = 0, driverIdentity } = {}) {
  const byArm = {}, reasons = [];
  if (rows.length !== 50 || rows.some(row => !GATE_TASKS.includes(row.task) || !Object.hasOwn(RUNTIME_ARMS, row.arm))) reasons.push('expected exactly 50 gate attempts');
  for (const arm of Object.keys(RUNTIME_ARMS)) {
    byArm[arm] = {};
    for (const task of GATE_TASKS) {
      const samples = rows.filter(row => row.arm === arm && row.task === task);
      const validAttempt = row => Number.isInteger(row.run) && row.run >= 1 && row.run <= 5 && typeof row.passed === 'boolean' &&
        Number.isFinite(row.seconds) && row.seconds >= 0 && !row.skipped && !row.dryRun;
      const valid = samples.length === 5 && new Set(samples.map(row => row.run)).size === 5 &&
        samples.every(validAttempt);
      if (!valid) reasons.push(`${arm}/${task}: incomplete or invalid attempts`);
      const verified = samples.filter(row => validAttempt(row) && row.valid !== false && row.runtime === RUNTIME_ARMS[arm] &&
        (arm === 'sleight-own'
          ? validRuntimeReceipt(row.runtimeReceipt, { nonce: row.runNonce, build: row.runtimeBuild, processEvidence: row.processEvidence })
          : validEngineExecution(row.engineReceipt, row.processEvidence, { version: row.engineVersion, build: row.engineBuild }, row.runtimeReceipt)));
      if (verified.length !== samples.length) reasons.push(`${arm}/${task}: invalid runtime receipt or arm identity`);
      const passes = verified.filter(row => row.passed);
      byArm[arm][task] = { runs: samples.length, passes: passes.length,
        scoredRuns: verified.length, medianSeconds: lowerMedian(passes.map(row => row.seconds)), medianTurns: lowerMedian(verified.map(row => row.turns).filter(Number.isFinite)),
        expectedSeconds: valid && verified.length === samples.length && passes.length ? verified.reduce((sum, row) => sum + row.seconds, 0) / passes.length : null };
    }
  }
  const totals = Object.fromEntries(Object.entries(byArm).map(([arm, tasks]) => [arm,
    Object.values(tasks).every(t => t.medianSeconds !== null) ? Object.values(tasks).reduce((sum, t) => sum + t.medianSeconds, 0) : null]));
  for (const task of GATE_TASKS) {
    const a = byArm.sleight[task], b = byArm['sleight-own'][task];
    if (a.expectedSeconds === null || b.expectedSeconds === null) reasons.push(`${task}: no passing expected time`);
    else if (b.expectedSeconds > a.expectedSeconds * (1 + RELEASE_POLICY.limits['native-haiku'])) reasons.push(`${task}: own expected time over 120% of engine`);
    if (a.passes - b.passes >= RELEASE_POLICY.passDrop) reasons.push(`${task}: own loses at least 2 passes`);
  }
  if (totals.sleight === null || totals['sleight-own'] === null || totals['sleight-own'] > totals.sleight) reasons.push('own total exceeds engine or is unavailable');
  const versions = new Set(rows.map(r => r.engineVersion));
  const engineBuilds = new Set(rows.map(r => r.engineBuild));
  const commits = new Set(rows.map(r => r.sleightCommit));
  const cliVersions = new Set(rows.map(r => r.claudeVersion));
  if (versions.size !== 1 || ![...versions][0] || engineBuilds.size !== 1 || ![...engineBuilds][0] ||
      rows.some(row => row.engineChanged !== false)) reasons.push('same unchanged engine version and build unproved');
  for (const arm of Object.keys(RUNTIME_ARMS)) {
    const samples = rows.filter(row => row.arm === arm);
    if (!samples[0]?.runtimeBuild || samples.some(row => !sameIdentity(row.runtimeBuild, samples[0].runtimeBuild))) reasons.push(`${arm}: same runtime build unproved`);
  }
  const own = rows.filter(row => row.arm === 'sleight-own');
  const observedDriver = own[0]?.runtimeReceipt && { version: own[0].runtimeReceipt.driverVersion, build: own[0].runtimeReceipt.driverBuild };
  if (driverIdentity && !sameIdentity(driverIdentity, observedDriver)) reasons.push('step-1 driver build/version differs');
  if (own.length && (new Set(own.map(row => row.runNonce)).size !== own.length ||
      new Set(own.map(row => row.runtimeReceipt?.driverBuild)).size !== 1 ||
      new Set(own.map(row => row.runtimeReceipt?.driverVersion)).size !== 1)) reasons.push('unique per-run runtime nonces and same driver build/version unproved');
  const expectedOrder = armPlan();
  if (rows.some((row, index) => ['arm', 'task', 'run'].some(key => row[key] !== expectedOrder[index]?.[key]))) reasons.push('ABBA order unproved');
  if (commits.size !== 1 || ![...commits][0] || rows.some(row => row.sleightDirty !== false)) reasons.push('same clean commit unproved');
  if (cliVersions.size !== 1 || ![...cliVersions][0] || rows.some(row => row.model !== 'claude-haiku-5-5' || row.effort !== 'high' ||
      (row.models ?? []).some(model => model !== 'claude-haiku-5-5') || row.passed && !row.models?.length)) reasons.push('same Claude Code version and Haiku high model unproved');
  return { passed: reasons.length === 0, complete: rows.length === 50, verdict: !reasons.length ? 'step2: speed-pass' : fixRound ? 'step2: stop-program' : 'step2: diagnose-and-fix',
    driverIdentity: observedDriver,
    totals, byArm, reasons, timing: 'sum of lower medians of passing seconds; expected seconds = all attempt seconds / passes' };
}
export function armMarkdown(report) {
  const gate = report.gate ?? gateVerdict({ step2: report.score });
  const lines = ['# Runtime gate', '', ...gateMarkdown(gate), `Step verdict: ${report.score.verdict}. ${report.results.length}/50 attempts recorded.`, '',
    ...glidePreparationSummary(report.glidePreparation), '',
    '| Arm | Task | Passes | Scored attempts | Median seconds | Expected seconds | Median turns | Runtime build |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const [arm, tasks] of Object.entries(report.score.byArm)) for (const [task, s] of Object.entries(tasks)) {
    const build = report.builds?.[arm];
    lines.push(`| ${arm} | ${task} | ${s.passes}/${s.runs} | ${s.scoredRuns}/${s.runs} | ${s.medianSeconds ?? 'unknown'} | ${s.expectedSeconds ?? 'unknown'} | ${s.medianTurns ?? 'unknown'} | ${build?.sourceSha256 ?? build?.version ?? 'unknown'} |`);
  }
  return lines.concat('', ...loadSummary(report.results), '', ...glideBuildSummary(report.results), '',
    ...report.score.reasons.map(reason => `- ${reason}`), '', 'Five runs do not certify a speed win below 20%.', '').join('\n');
}
export function parseArmOptions(args) {
  const options = { dryRun: false, ownerAway: false, fixRound: 0 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--dry-run') options.dryRun = true;
    else if (key === '--owner-away') options.ownerAway = true;
    else if (['--arm', '--tasks', '--runs', '--out', '--fix-round', '--step1', '--parity'].includes(key)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw Error('OPTION_VALUE_REQUIRED: ' + key);
      options[{ '--arm': 'arms', '--tasks': 'tasks', '--runs': 'runs', '--out': 'out', '--fix-round': 'fixRound', '--step1': 'step1', '--parity': 'parity' }[key]] =
        ['--runs', '--fix-round'].includes(key) ? Number(value) : ['--arm', '--tasks'].includes(key) ? value.split(',') : value;
    } else throw Error('UNKNOWN_OPTION: ' + key);
  }
  if (![0, 1].includes(options.fixRound)) throw Error('INVALID_FIX_ROUND');
  return options;
}
export async function runRuntimeArms(options, { root = ROOT, env = process.env, held = () => existsSync('/tmp/sleight-hold'),
  liveLockHeld = () => existsSync('/tmp/sleight-live.lock'),
  engine, build = runtimeBuild, source = sourceIdentity, ownReady = assertOwnRelay, execute, now = () => new Date().toISOString(), load = loadavg,
  observe = observeRuntimeAttempt, inventory, prepare = prepareGlide,
  publish = writeRuntimeReport, log = line => console.log(line) } = {}) {
  const plan = armPlan(options);
  if (options.dryRun) {
    log(JSON.stringify({ dryRun: true, arms: RUNTIME_ARMS, order: 'A B B A (reverse each even round)', plan,
      commands: plan.slice(0, 2).map(row => ({ ...row, ...armCommand(row, { root, env }), env: { SLEIGHT_RUNTIME: row.runtime } })) }, null, 2));
    return 0;
  }
  if (!options.ownerAway) throw Error('OWNER_AWAY_REQUIRED');
  if (held()) throw Error('HOLD');
  const stem = outputStem(options.out);
  if (!options.step1) throw Error('STEP1_REQUIRED: pass --step1 report.json');
  ownReady(root);
  const engineRead = engine ?? (await import('./engine-version.mjs')).readEngine;
  const initialEngine = engineRead();
  const readSource = () => checkedSource(() => source(root));
  const identity = engineIdentity(initialEngine), src = readSource(), ownBuild = build(root, 'own');
  if (!validEngine(identity)) throw Error('ENGINE_VERSION_BUILD_UNAVAILABLE');
  if (!src.sleightCommit || src.sleightDirty !== false) throw Error('CLEAN_SOURCE_REQUIRED');
  const step1 = assertStep1(JSON.parse(readFileSync(options.step1, 'utf8')), { build: ownBuild, engine: identity, ...src });
  const report = { schema: 'sleight.runtime-ab/2', startedAt: now(), plan, engine: identity, ...src,
    step1, parity: options.parity ? loadParityProof(options.parity) : verifyParityProof(step1.parity, dirname(resolve(options.step1))), builds: {
      sleight: build(root, 'engine', initialEngine.version), 'sleight-own': ownBuild }, results: [], children: [] };
  const updateScore = () => {
    report.score = scoreRuntimeArms(report.results, { ...options, driverIdentity: step1.driverIdentity });
    report.gate = gateVerdict({ step1: { ...step1.verdict, driverIdentity: step1.driverIdentity }, step2: report.score, parity: report.parity, build: ownBuild,
      engine: identity, sleightCommit: src.sleightCommit });
  };
  const drive = execute ?? (async command => {
    const { runOwned } = await import('./preapproved-process.mjs');
    const result = await runOwned(command.command, command.args, { env: command.env, signal: command.signal,
      timeoutMs: 12 * 60 * 1000, onStdout: chunk => process.stdout.write(chunk) });
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  });
  const controller = new AbortController(), interrupt = () => controller.abort(Error('INTERRUPTED'));
  let processWitness, processBank, pendingAttempt;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    // Complete source preparation before process observation or any attempt clock.
    report.glidePreparation = await prepare({ signal: controller.signal });
    if (report.glidePreparation.status !== 'ready') throw Error('GLIDE_PREPARATION_UNAVAILABLE');
    controller.signal.throwIfAborted();
    if (held()) throw Error('HOLD');
    if (!inventory) {
      processBank = mkdtempSync('/private/tmp/rt13-process-');
      const { startProcessWitness } = await import('./runtime-probe-live.mjs');
      const { runOwned } = await import('./preapproved-process.mjs');
      processWitness = await startProcessWitness(processBank, { runProcess: runOwned, signal: controller.signal });
      inventory = () => processWitness.call({ op: 'inventory' });
    }
    for (const row of plan) {
      controller.signal.throwIfAborted();
      if (held()) throw Error('HOLD');
      const before = engineRead();
      if (!sameIdentity(engineIdentity(before), identity)) throw Error('ENGINE_BUILD_CHANGED');
      if (!sameIdentity(readSource(), src)) throw Error('SOURCE_CHANGED');
      if (JSON.stringify(build(root, row.runtime, before.version)) !== JSON.stringify(report.builds[row.arm])) throw Error('RUNTIME_BUILD_CHANGED');
      const runNonce = randomUUID();
      pendingAttempt = { ...row, runNonce };
      if (row.runtime === 'own') pendingAttempt.idleWait = await awaitEngineIdle(inventory, { signal: controller.signal,
        boundary: () => { if (held()) throw Error('HOLD'); } });
      const command = armCommand({ ...row, runNonce }, { root, env: { ...env, CLAUDE_CONFIG_DIR: mkdtempSync('/tmp/lane-claude-') } });
      const resultDirectory = resolve(root, 'bench/results');
      const preexisting = new Set(existsSync(resultDirectory) ? readdirSync(resultDirectory) : []);
      const loadStart = load(), observed = await observe(() => drive({ ...command, signal: controller.signal }), { inventory }),
        result = observed.value, loadEnd = load();
      pendingAttempt.processEvidence = observed.processEvidence;
      const match = /^results: (.+\.json)\s*$/m.exec(result.stdout ?? '');
      if (!result.groupClean || !match) throw Error('CLAIM_CHILD_UNCONFIRMED');
      const path = resolve(match[1]);
      if (dirname(path) !== resolve(root, 'bench/results')) throw Error('CLAIM_RESULT_OUTSIDE_BANK');
      const info = lstatSync(path);
      if (preexisting.has(basename(path)) || !info.isFile() || info.nlink !== 1 || realpathSync(dirname(path)) !== resultDirectory) throw Error('CLAIM_RESULT_NOT_NEW');
      const child = JSON.parse(readFileSync(path, 'utf8'));
      report.children.push({ task: row.task, arm: row.arm, file: path.slice(root.length), exitCode: result.exit?.code });
      if (child.results?.length !== 1 || child.results[0].task !== row.task || child.results[0].arm !== 'sleight') throw Error('CLAIM_RESULT_SHAPE');
      const recorded = { ...child.results[0], arm: row.arm, run: row.run, runtime: row.runtime,
        runtimeBuild: report.builds[row.arm], harnessLoadStart: loadStart, harnessLoadEnd: loadEnd, model: child.model, effort: child.effort,
        claudeVersion: child.armMetadata?.sleight?.claudeVersion, runNonce, idleWait: pendingAttempt.idleWait,
        runtimeReceipt: child.results[0].runtimeReceipt ?? child.runtimeReceipt,
        engineReceipt: child.results[0].engineReceipt ?? child.engineReceipt,
        engineBuild: child.engine?.start?.chatgptBuild, engineChanged: child.engine?.changed };
      Object.assign(recorded, loadReceipt(recorded));
      if (row.runtime === 'own') recorded.glideBuildCheck = glideBuildCheck(report.glidePreparation, recorded);
      const preparationMismatch = recorded.glideBuildCheck?.status === 'mismatch';
      const preparationUnverified = report.glidePreparation.build && recorded.glideBuildCheck?.status === 'unverified';
      recorded.processEvidence = row.runtime === 'own' ? bindOwnBinary(recorded.runtimeReceipt, observed.processEvidence) : observed.processEvidence;
      const receiptInvalid = row.runtime === 'own' && !validRuntimeReceipt(recorded.runtimeReceipt,
        { nonce: runNonce, build: ownBuild, processEvidence: recorded.processEvidence });
      const engineInvalid = row.runtime === 'engine' && !validEngineExecution(recorded.engineReceipt, recorded.processEvidence, identity, recorded.runtimeReceipt);
      // Runtime comes from the observed producer, never just the selected arm.
      recorded.runtime = !receiptInvalid && row.runtime === 'own' ? 'own' : !engineInvalid && row.runtime === 'engine' ? 'engine' : 'unproven';
      const driverDrift = row.runtime === 'own' && !sameIdentity(step1.driverIdentity,
        { version: recorded.runtimeReceipt?.driverVersion, build: recorded.runtimeReceipt?.driverBuild });
      report.claudeVersion ??= recorded.claudeVersion;
      const wrongConfiguration = !recorded.claudeVersion || recorded.claudeVersion !== report.claudeVersion ||
        recorded.model !== 'claude-haiku-5-5' || recorded.effort !== 'high' ||
        (recorded.models ?? []).some(model => model !== 'claude-haiku-5-5') || recorded.passed && !recorded.models?.length;
      const unsafe = recorded.cleanupError || recorded.groupClean === false || recorded.skipped || recorded.seconds == null ||
        child.cleanupDeferred || child.passCleanupErrors?.length || child.leftWindows?.length || child.heldAttempts?.length ||
        child.engine?.changed !== false || recorded.engineVersion !== identity.version || recorded.engineBuild !== identity.build ||
        !sameIdentity(engineIdentity(child.engine?.start), identity) ||
        !sameIdentity(engineIdentity(child.engine?.end), identity) || !sameIdentity(engineIdentity(engineRead()), identity) ||
        liveLockHeld() || ![0, 1].includes(result.exit?.code) ||
        ['permissionPrompt', 'permissionRefusal', 'observerError', 'appDialog', 'approvalStop'].some(key => recorded[key]);
      const drifted = !sameIdentity(build(root, row.runtime, engineRead().version), report.builds[row.arm]) ||
        !sameIdentity(readSource(), src) || recorded.sleightCommit !== src.sleightCommit || recorded.sleightDirty !== false;
      recorded.valid = !(unsafe || drifted || driverDrift || preparationMismatch || preparationUnverified || wrongConfiguration || receiptInvalid || engineInvalid);
      if (!recorded.valid) Object.assign(recorded, { passed: false,
        reason: preparationMismatch ? 'GLIDE_BUILD_MISMATCH' : preparationUnverified ? 'GLIDE_BUILD_UNVERIFIED' : receiptInvalid ? 'RUNTIME_RECEIPT_INVALID' : engineInvalid ? 'ENGINE_RECEIPT_INVALID' : driverDrift ? 'RUNTIME_BUILD_CHANGED' : unsafe ? 'CLAIM_SAFETY_STOP' : drifted ? 'RUNTIME_BUILD_CHANGED' : 'CLAIM_CONFIGURATION_STOP' });
      report.results.push(recorded);
      pendingAttempt = undefined;
      // These files were just created by this child. Label the raw rows too, so claim readers cannot mix own with engine.
      child.arms = [row.arm]; child.runtime = recorded.runtime; child.runtimeBuild = report.builds[row.arm];
      child.results = [recorded];
      child.heldAttempts = (child.heldAttempts ?? []).map(attempt => ({ ...attempt, arm: row.arm, runtime: row.runtime, runtimeBuild: report.builds[row.arm] }));
      child.armMetadata = { [row.arm]: child.armMetadata?.sleight };
      writeFileSync(path, JSON.stringify(child, null, 2) + '\n', { mode: 0o600 });
      updateScore(); publish(stem + '.partial-' + report.results.length, report, armMarkdown(report));
      if (!recorded.valid) throw Error(recorded.reason);
    }
  } catch (error) { report.stop = error.message;
    if (error.preparation) report.glidePreparation = error.preparation;
    if (error.cleanupConfirmed === false) report.processCleanupUnconfirmed = true;
    if (pendingAttempt) report.failedAttempt = { ...pendingAttempt, idleWait: error.idleWait ?? pendingAttempt.idleWait,
      processEvidence: error.processEvidence ?? pendingAttempt.processEvidence };
    if (error.processEvidence) report.processEvidenceAtStop = error.processEvidence; }
  finally {
    try { await processWitness?.close(); if (processBank && !report.processCleanupUnconfirmed) rmSync(processBank, { recursive: true }); }
    catch { report.stop = 'PROCESS_WITNESS_CLEANUP_UNCONFIRMED'; report.processCleanupUnconfirmed = true; }
    if (report.processCleanupUnconfirmed) report.retainedProcessBank = processBank;
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    report.finishedAt = now(); updateScore();
    if (report.stop) { report.score.passed = false; report.score.verdict = 'step2: stopped'; report.score.reasons.push(report.stop);
      report.gate = gateVerdict({ step1: step1.verdict, step2: report.score, parity: report.parity, build: ownBuild,
        engine: identity, sleightCommit: src.sleightCommit }); }
    publish(stem, report, armMarkdown(report));
  }
  return report.gate.passed ? 0 : 1;
}
export async function routeRuntimeArms(args) {
  const i = args.indexOf('--arm');
  if (i < 0 || !args[i + 1]?.split(',').includes('sleight-own')) return false;
  try { process.exitCode = await runRuntimeArms(parseArmOptions(args)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  return true;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runRuntimeArms(parseArmOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
