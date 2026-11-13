import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armPaths, ordinaryPath, guardLive, requireOwnerFree } from './contract.mjs';
import { DesktopDriver } from './desktop.mjs';
import { detectRun, assertComputerUseOnly } from './state.mjs';
import { scrubCursor } from './scrub.mjs';

export { makeCalibration, validateCalibration, verifySelection } from './selection.mjs';
import { makeCalibration } from './selection.mjs';
export function calibrationPlan() {
  return { arm: 'cursor-cu', supervised: true, paths: armPaths(), prompt: 'Say ready.', timeoutMs: 1200000,
    preconditions: ['--owner-says-cursor-free', 'installed Cursor running with owner login', 'exclusive benchmark live lock', 'no sleight-hold'],
    preparation: ['bind installed Cursor without launching or quitting it', 'save owner selections and open a new chat'],
    ownerSteps: ['Choose Computer Use / This Mac / Grok 4.7 High, high effort, normal speed in the new chat.',
      'Submit exactly: Say ready. Wait for the turn to settle. The harness saves selection markers and field shapes, then restores your selections.'],
    writes: ['new chat in owner Cursor', 'calibration.json with selection markers and field shapes'] };
}
export async function calibrate({ dryRun = false, ownerAway = false, ownerSaysCursorFree = false } = {}, { driver, lock, print = console.log, now = Date.now, exists = existsSync,
  pause = ms => new Promise(r => setTimeout(r, ms)), signal, guard,
  save = (file, data) => { mkdirSync(ordinaryPath(calibrationPlan().paths.root), { recursive: true, mode: 0o700 }); writeFileSync(ordinaryPath(file), data, { mode: 0o600, flag: 'wx' }); } } = {}) {
  const plan = { ...calibrationPlan(), ownerSaysCursorFree };
  if (dryRun) return calibrationPlan();
  requireOwnerFree({ ownerSaysCursorFree });
  if (exists(plan.paths.calibration)) throw Error('Cursor calibration already exists; refusing another calibration');
  (guard ?? guardLive)({ ownerAway, supervised: true, ownerSaysCursorFree });
  driver ??= new DesktopDriver();
  // Admission is read-only and precedes lock acquisition and UI changes.
  await driver.preflight(plan, { calibration: true });
  const release = await (lock ?? (await import('../../../live-lock.mjs')).acquireLiveLock)();
  let opened = false, clean = true, capture, pinnedRun;
  const start = now();
  try {
    opened = true; clean = false;
    await driver.open(plan, { calibration: true, signal });
    const bound = await driver.setupCalibration(plan, { signal });
    print(plan.ownerSteps.join('\n'));
    while (now() - start < plan.timeoutMs) {
      signal?.throwIfAborted(); await driver.foreignGuard();
      const snapshot = await driver.readState();
      assertComputerUseOnly(snapshot, driver.composerId);
      const found = detectRun(snapshot, { prompt: plan.prompt, submittedAt: start, allowUncalibratedModel: true, baselineIds: bound.baselineIds, composerId: driver.composerId, ...pinnedRun });
      if (found.started && !pinnedRun) pinnedRun = { composerId: found.composerId, generationId: found.generationId };
      if (found.ended) {
        await driver.verifyCalibrationUI();
        capture = makeCalibration(snapshot.composers.find(c => c.composerId === found.composerId), {
          settled: true, ownerModelLabel: 'Grok 4.7 High', bubbles: snapshot.bubbles[found.composerId] });
        break;
      }
      await pause(250);
    }
    if (!capture) throw Error('Cursor calibration timed out before the harmless turn settled');
  } finally {
    if (opened) {
      let idle = true;
      if (!capture) { try { idle = await driver.cancel?.(plan, { calibration: true }) !== false; } catch { idle = false; } }
      try { clean = await driver.close() === true && idle; } catch { clean = false; }
    }
    if (clean) await release();
    else print('Cursor calibration cleanup unverified; live lock retained');
  }
  if (!clean) throw Error('Cursor calibration cleanup unverified; calibration not written');
  save(plan.paths.calibration, JSON.stringify(capture, null, 2) + '\n');
  return capture;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), abort = () => controller.abort();
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, abort);
  try {
    const args = process.argv.slice(2);
    if (args.some(a => !['--dry-run', '--owner-says-cursor-free'].includes(a)) || new Set(args).size !== args.length) throw Error('calibrate accepts --dry-run and --owner-says-cursor-free; live mode requires the owner present');
    console.log(JSON.stringify(scrubCursor(await calibrate({ dryRun: args.includes('--dry-run'), ownerSaysCursorFree: args.includes('--owner-says-cursor-free') }, { signal: controller.signal })), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(s, abort); }
}
