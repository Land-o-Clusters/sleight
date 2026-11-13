// Recover an area refusal, or one Preview task whose fixture, server and sampler already proved collection.
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync, rmdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLiveLock } from '../live-lock.mjs';
import { swiftModuleCache } from '../swift-cache.mjs';
const execute = promisify(execFile);
export function areaRecoveryPlan(bank, lock = '/tmp/sleight-live.lock') {
  if (!bank.startsWith(realpathSync('/tmp') + '/') || realpathSync(bank) !== bank) throw Error('Recovery requires a private bank');
  const stat = lstatSync(bank), state = JSON.parse(readFileSync(join(bank, 'check4.json')));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 ||
      state.cleanupConfirmed !== false || state.failure !== 'Fixture area restoration unproved' ||
      !Object.values(state.tasks ?? {}).length || Object.values(state.tasks).some(t => t.complete || t.attempts?.length !== 0)) throw Error('Recovery requires an area failure before task checkpointing');
  const files = readdirSync(bank);
  const taskDirs = files.filter(f => /^preview-read-1-[a-zA-Z0-9]+$/.test(f));
  if (taskDirs.length > 1 || files.some(f => !['check4.json', 'check4.md', ...taskDirs].includes(f) && !/^work-[a-zA-Z0-9]+$/.test(f) && !/^area-[a-z-]+-\d+\.json$/.test(f))) throw Error('Unexpected task evidence; cleanup needs its normal recovery');
  const collectedTasks = taskDirs.map(name => {
    const dir = join(bank, name), result = JSON.parse(readFileSync(join(dir, 'result.json'))), receipt = JSON.parse(readFileSync(join(dir, 'bench-result.json')));
    const hosts = readdirSync(join(dir, 'collections')).map(f => JSON.parse(readFileSync(join(dir, 'collections', f))));
    if (realpathSync(dir) !== dir || result.actualTask !== 'preview-read' || result.cleanupConfirmed !== true ||
        result.benchExit?.signal != null || ![0, 1].includes(result.benchExit?.code) || receipt.cleanupConfirmed !== true ||
        receipt.row?.groupClean !== true || !receipt.row.fixtureDiagnostics?.length ||
        receipt.row.fixtureDiagnostics.some(d => d.windowCleanupConfirmed !== true || d.helperCollectionConfirmed !== true || d.appQuit !== true) ||
        !hosts.length || hosts.some(h => h.collected !== true || h.hosts?.some(p => p.collected !== true))) throw Error('Preview task collection unproved');
    return { dir, collected: true };
  });
  const areas = files.filter(f => f.startsWith('area-'));
  if (areas.length !== 1) throw Error('Expected one area refusal');
  const records = JSON.parse(readFileSync(join(bank, areas[0]))), last = records.at(-1);
  const admission = collectedTasks.length ? records[0].phase === 'ready' && records[0].clear === true : records[0].phase === 'refused' && records[0].reason === 'fixture-area-hide';
  if (records.length !== 2 || !admission || last.phase !== 'restored' ||
      (!collectedTasks.length && last.restored !== true) || last.exit?.code !== 1 || last.exit.signal !== null || !Array.isArray(last.apps)) throw Error('Area child exit and restoration receipts missing');
  const ownedLock = lstatSync(lock), work = files.filter(f => f.startsWith('work-'));
  if (work.length !== 1 || !ownedLock.isDirectory() || ownedLock.isSymbolicLink() || ownedLock.uid !== process.getuid() ||
      ownedLock.birthtimeMs < stat.birthtimeMs || ownedLock.birthtimeMs > lstatSync(join(bank, work[0])).birthtimeMs) throw Error('Retained lock does not belong to the pre-task interval');
  return { state, apps: last.apps, ownedLock, lock, bank, collectedTasks };
}
export function finishAreaRecovery(plan, restored) {
  if (restored?.restored !== true) throw Error('Application restoration unproved');
  const current = lstatSync(plan.lock);
  if (current.dev !== plan.ownedLock.dev || current.ino !== plan.ownedLock.ino) throw Error('Retained lock changed');
  writeFileSync(join(plan.bank, 'area-recovery.json'), JSON.stringify(restored, null, 2) + '\n', { mode: 0o600 });
  rmdirSync(plan.lock);
  // Preserve the failed run and its original verdict. Only the cleanup state is repaired.
  plan.state.cleanupConfirmed = true;
  plan.state.areaRecovery = { restored: true, noTaskStarted: plan.collectedTasks.length === 0, collectedTasks: plan.collectedTasks };
  writeFileSync(join(plan.bank, 'check4.json'), JSON.stringify(plan.state, null, 2) + '\n', { mode: 0o600 });
}
async function restoreApps(apps) {
  const work = mkdtempSync('/private/tmp/check4-area-recovery-');
  const binary = join(work, 'area'), source = fileURLToPath(new URL('./check4-area.swift', import.meta.url));
  await execute('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', swiftModuleCache(), source, '-o', binary],
    { timeout: 600000, killSignal: 'SIGKILL', maxBuffer: 4 << 20 });
  // execFile owns this one native child until close, including its bounded restoration wait.
  let child;
  const result = await new Promise((resolvePromise, reject) => {
    child = execFile(binary, ['--restore-apps'], { timeout: 10000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolvePromise(stdout));
    child.stdin.end(JSON.stringify(apps));
  });
  return JSON.parse(result);
}
async function recover(bank) {
  const plan = areaRecoveryPlan(bank), receipt = await restoreApps(plan.apps); finishAreaRecovery(plan, receipt);
  console.log(JSON.stringify({ ...receipt, lockReleased: true, noTaskStarted: plan.collectedTasks.length === 0, collectedTasks: plan.collectedTasks.length }));
}
export function recordedRefusalApps(bank) {
  if (!bank.startsWith(realpathSync('/tmp') + '/') || realpathSync(bank) !== bank) throw Error('Expected a private refusal bank');
  const stat = lstatSync(bank), state = JSON.parse(readFileSync(join(bank, 'check4.json')));
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077 || state.cleanupConfirmed !== true ||
      !state.failure?.startsWith('Fixture area refused:') || !Object.values(state.tasks ?? {}).length ||
      Object.values(state.tasks).some(t => t.complete || t.attempts?.length !== 0)) throw Error('Expected a collected pre-task refusal');
  const names = readdirSync(bank).filter(f => /^area-[a-z-]+-\d+\.json$/.test(f));
  if (names.length !== 1) throw Error('Expected one area refusal');
  const rows = JSON.parse(readFileSync(join(bank, names[0]))), last = rows.at(-1);
  if (rows.length !== 2 || rows[0].phase !== 'refused' || last.phase !== 'restored' || last.restored !== true ||
      last.exit?.code !== 1 || last.exit.signal !== null || !Array.isArray(last.apps)) throw Error('Missing collected area receipt');
  return last.apps;
}
async function restoreRefusal(bank) {
  const apps = recordedRefusalApps(bank), began = Date.now();
  const unlock = await acquireLiveLock('/tmp/sleight-live.lock', { wait: true, interval: 60000 });
  const lockWaitMs = Date.now() - began;
  const receipt = await restoreApps(apps);
  if (!receipt.restored) throw Error('Recorded app restoration unproved; retained live lock');
  writeFileSync(join(bank, 'area-restoration.json'), JSON.stringify({ ...receipt, lockWaitMs }, null, 2) + '\n', { mode: 0o600 });
  await unlock(); console.log(JSON.stringify({ ...receipt, lockReleased: true, noTaskStarted: true }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 4 && process.argv[2] === '--restore-only') await restoreRefusal(resolve(process.argv[3]));
  else if (process.argv.length === 3) await recover(resolve(process.argv[2]));
  else throw Error('Expected the stopped check 4 bank');
}
