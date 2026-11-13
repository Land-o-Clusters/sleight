// UC2C's model-free probe. Imports and dry runs do not create a host or fixture.
import { existsSync, readFileSync } from 'node:fs';
import { startGuard } from './sitting-process.mjs';
import { outputStem, writeRuntimeReport } from './runtime-arm.mjs';

export const rendererProbePlan = ({ includeDiscord = false } = {}) =>
  JSON.parse(readFileSync(new URL('./runtime-probe-plan.json', import.meta.url))).subsets.rendererBackground.cells
    .filter(cell => cell.app !== 'discord' || includeDiscord);
const targetLines = text => String(text).split('\n').map(line => /^\s*(\d+) (.*)$/.exec(line)).filter(Boolean);
const exact = (text, pattern) => {
  const matches = targetLines(text).filter(line => pattern.test(line[2]));
  if (matches.length !== 1) throw Error('RENDERER_TARGET_UNAVAILABLE');
  return { id: Number(matches[0][1]), line: matches[0][2] };
};
function target(cell, before) {
  if (cell.app === 'vscode') {
    const selected = exact(before.text, /^tab \([^)]*\bselected\b[^)]*\) UC2C-[ab]\.txt(?:,|$)/);
    const name = selected.line.includes('UC2C-a.txt') ? 'UC2C-b.txt' : 'UC2C-a.txt';
    return { id: exact(before.text, new RegExp('^tab(?: \\([^)]*\\))? ' + name.replace('.', '\\.') + '(?:,|$)')).id,
      changed: after => targetLines(after.text).some(line => /^tab \([^)]*\bselected\b[^)]*\) /.test(line[2]) &&
        new RegExp('\\) ' + name.replace('.', '\\.') + '(?:,|$)').test(line[2])) };
  }
  if (cell.app !== 'discord') throw Error('RENDERER_APP_UNSUPPORTED');
  // Fresh, signed-out Discord only. Never submit a form or enter credentials.
  const register = targetLines(before.text).filter(line => /^link Register(?:,|$)/.test(line[2]));
  const toRegister = register.length === 1;
  const item = exact(before.text, toRegister ? /^link Register(?:,|$)/ : /^link Already have an account\?(?:,|$)/);
  return { id: item.id, changed: after => targetLines(after.text).some(line =>
    (toRegister ? /^link Already have an account\?(?:,|$)/ : /^link Register(?:,|$)/).test(line[2])) };
}
export function rendererWitnessValid(log, window) {
  const samples = log?.samples, events = log?.events;
  if (log?.covered !== true || log.overflow === true || log.tapFailed === true || log.sampleIntervalMs !== 20 || !Array.isArray(samples) || samples.length < 2 ||
      !Array.isArray(events) || events.length !== 2) return false;
  const first = samples[0];
  return Number.isSafeInteger(first.frontmostPID) && first.frontmostPID > 0 && first.frontmostPID !== window.pid &&
    Array.isArray(first.pointer) && first.pointer.length === 2 && first.pointer.every(Number.isFinite) &&
    samples.every((s, i) => Number.isFinite(s.ms) && s.ms >= 0 && s.frontmostPID === first.frontmostPID && s.covered === true &&
      Array.isArray(s.pointer) && s.pointer.length === 2 && s.pointer.every((n, j) => n === first.pointer[j]) &&
      (!i || s.ms > samples[i - 1].ms && s.ms - samples[i - 1].ms <= 40)) &&
    events.every((event, i) => event.type === i + 1 && event.flags === 0 && event.pid === window.pid &&
      event.source === -1 && String(event.windowId) === window.windowId);
}
export async function rendererClickTrial(cell, { driver, witness }, { now = performance.now.bind(performance), check = async () => {} } = {}) {
  const before = await driver.read(false);
  if (before.truncated || before.renderer?.web !== true || before.renderer.complete !== true) throw Error('RENDERER_TREE_UNAVAILABLE');
  const next = target(cell, before);
  const cover = await witness.call({ op: 'renderer-cover', window: before.window });
  if (cover.covered !== true) throw Error('RENDERER_COVER_UNCONFIRMED');
  const watching = await witness.call({ op: 'renderer-watch-begin' });
  if (watching.watching !== true) throw Error('WITNESS_NOT_WATCHING');
  let after, reply, elapsedMs, log, failure;
  try {
    await check();
    const start = now();
    reply = await driver.act('click', next.id);
    elapsedMs = now() - start;
    after = await driver.read(false);
  } catch (error) { failure = error; }
  finally { log = await witness.call({ op: 'renderer-watch-end' }); }
  if (failure) throw Object.assign(failure, { rendererEvidence: { elapsedMs, witness: log } });
  const sameWindow = after?.window && ['pid', 'windowId', 'processStart', 'bundleId'].every(key => after.window[key] === before.window[key]);
  const stateChanged = sameWindow && !after.truncated && next.changed(after);
  const witnessVerified = rendererWitnessValid(log, before.window);
  const reason = !sameWindow ? 'IDENTITY_CHANGED' : after.truncated || after.renderer?.complete !== true ? 'RENDERER_READ_UNCONFIRMED' :
    !witnessVerified ? 'RENDERER_WITNESS_UNCONFIRMED' :
    !['sent-unverified', 'sent-verified'].includes(reply?.delivery) || reply.postedEvents !== 2 ? 'POINTER_SEQUENCE_UNCONFIRMED' :
    !Number.isFinite(elapsedMs) || elapsedMs < 0 ? 'RENDERER_TIMING_UNCONFIRMED' : !stateChanged ? 'RENDERER_CLICK_MISS' : undefined;
  return { elapsedMs, delivery: reply?.delivery, postedEvents: reply?.postedEvents, stateChanged, renderer: before.renderer,
    witness: log, witnessVerified, reason, passed: !reason };
}

export async function rendererProbeMain(args = process.argv.slice(2), dependencies = {}) {
  const options = { dryRun: false, includeDiscord: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--renderer-background') continue;
    if (args[i] === '--owner-away') continue; // Legacy flag grants no live permission.
    else if (args[i] === '--include-discord') options.includeDiscord = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (['--out', '--driver', '--driver-sha256', '--sitting-guard'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = { '--out': 'out', '--driver': 'driverBinary', '--driver-sha256': 'driverSha256', '--sitting-guard': 'guardTool' }[args[i]];
      options[key] = args[++i];
    }
    else throw Error('UNKNOWN_OPTION');
  }
  const plan = rendererProbePlan(options);
  if (options.dryRun) {
    const preview = { schema: 'sleight.renderer-probe/1', dryRun: true, qualification: false,
      runtime: 'own', wakeImplemented: false, plan, totalTrials: plan.reduce((total, cell) => total + cell.trials, 0),
      discord: { included: options.includeDiscord, requires: '--include-discord',
        reason: 'Off by owner decision (2026-11-02): login-page input and app updater. --include-discord adds it.' },
      liveRequires: ['--sitting-guard', '--out', '--driver', '--driver-sha256'],
      helper: 'Source-matched private input-gate build, supplied by sleight-arch.' };
    (dependencies.print ?? console.log)(JSON.stringify(preview, null, 2)); return 0;
  }
  if (!options.guardTool) throw Error('SITTING_GUARD_REQUIRED');
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw Error('MACOS_REQUIRED');
  const held = dependencies.held ?? (() => existsSync('/tmp/sleight-hold'));
  const boundary = () => { if (held()) throw Error('HOLD'); };
  boundary();
  const stem = outputStem(options.out), controller = new AbortController();
  const interrupt = () => controller.abort(Error('INTERRUPTED'));
  const signals = dependencies.signals ?? process;
  signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt);
  let backend, guard, unlock, cleanupFailed = false;
  const check = async () => {
    boundary(); controller.signal.throwIfAborted();
    const sample = await guard.check();
    if (!Number.isFinite(sample?.hidIdleMs) || sample.hidIdleMs < 30000) throw Error('PERSON_ACTIVE');
    boundary(); controller.signal.throwIfAborted();
  };
  const report = { schema: 'sleight.renderer-probe/1', runtime: 'own', qualification: false, wakeImplemented: false,
    includeDiscord: options.includeDiscord, startedAt: new Date().toISOString(), cells: [], cleanupConfirmed: false };
  try {
    guard = (dependencies.startGuard ?? startGuard)(options.guardTool, { kind: 'renderer',
      onStop: code => controller.abort(Error(code)) });
    await guard.start();
    await check();
    const takeLock = dependencies.takeLock ?? (await import('./live-lock.mjs')).acquireLiveLock;
    unlock = await takeLock(undefined, { signal: controller.signal });
    backend = await (dependencies.createBackend ?? (await import('./runtime-probe-live.mjs')).createRendererProbe)({
      signal: controller.signal, check, driverBinary: options.driverBinary, driverSha256: options.driverSha256 });
    report.build = await backend.metadata();
    if (report.build.sleightDirty !== false) throw Error('RUNTIME_BUILD_DIRTY');
    for (const cell of plan) {
      await check();
      const row = { ...cell, trialsData: [] }; report.cells.push(row);
      try {
        const fixture = await backend.prepare(cell);
        for (let index = 0; index < cell.trials; index++) {
          await check();
          let evidence;
          try { evidence = await rendererClickTrial(cell, fixture, { check }); await check(); }
          catch (error) {
            row.trialsData.push({ trial: index + 1, passed: false, error: /^[A-Z][A-Z0-9_]+/.exec(error.message)?.[0] ?? 'TRIAL_FAILED',
              ...error.rendererEvidence });
            throw error;
          }
          row.trialsData.push({ trial: index + 1, ...evidence });
          // A delivery miss is evidence, never permission to add a wake or replay.
          if (!evidence.passed) throw Error(evidence.reason ?? 'RENDERER_PROBE_UNCONFIRMED');
        }
      } finally {
        try { if ((await backend.closeFixture()).confirmed !== true) throw Error('CLEANUP_UNCONFIRMED'); }
        catch { cleanupFailed = true; throw Error('CLEANUP_UNCONFIRMED'); }
      }
    }
    const end = await backend.metadata();
    if (JSON.stringify(end) !== JSON.stringify(report.build)) throw Error('RUNTIME_BUILD_CHANGED');
  } catch (error) {
    report.stop = /^[A-Z][A-Z0-9_]+/.exec(error.message)?.[0] ?? 'RENDERER_PROBE_FAILED';
  } finally {
    try { report.cleanupConfirmed = backend ? (await backend.close()).confirmed === true && !cleanupFailed : true; }
    catch { report.cleanupConfirmed = false; }
    try { await guard?.close(); } catch { report.cleanupConfirmed = false; }
    if (unlock && report.cleanupConfirmed) { try { await unlock(); } catch { report.cleanupConfirmed = false; } }
    signals.off('SIGINT', interrupt); signals.off('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString(); report.verdict = rendererProbeVerdict(report.cells, report.cleanupConfirmed, options);
    if (report.stop) report.verdict.passed = false;
    (dependencies.publish ?? writeRuntimeReport)(stem, report, ['# Renderer background input probe', '',
      `Passed: ${report.verdict.passed}. Cleanup confirmed: ${report.cleanupConfirmed}. Wake implemented: false.`,
      ...report.verdict.cells.map(c => `- ${c.id}: ${c.passes}/${c.attempted} clicks, p50 ${c.p50Ms ?? 'unmeasured'} ms.`),
      ...(report.stop ? [`Stopped: ${report.stop}.`] : []), '', 'This probe does not qualify the runtime.', ''].join('\n'));
  }
  return report.verdict.passed ? 0 : 1;
}
export function rendererProbeVerdict(cells, cleanupConfirmed, options = {}) {
  const expected = rendererProbePlan(options);
  const rows = cells.map(cell => {
    const samples = cell.trialsData ?? [], times = samples.map(t => t.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
    const p50Ms = times.length ? times[Math.ceil(times.length / 2) - 1] : null;
    return { id: cell.id, attempted: samples.length, passes: samples.filter(t => t.passed === true).length, p50Ms,
      passed: samples.length === 20 && samples.every(t => t.passed === true) && times.length === 20 && p50Ms < 150 };
  });
  return { passed: cleanupConfirmed === true && cells.length === expected.length && expected.every(c => rows.filter(r => r.id === c.id && r.passed).length === 1),
    qualification: false, wakeImplemented: false, cells: rows };
}
