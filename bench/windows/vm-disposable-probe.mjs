// Headless disposable probe, followed by one person-idle row when --kit is supplied.
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLiveLock } from '../live-lock.mjs';
import { lockVM, createRowTransport, parseArgs, runRows } from './vm-rows.mjs';
import { isMain, runChild } from './kit.mjs';

export async function disposableProbe(options, dependencies = {}) {
  if (options.dryRun || options.rows || !options.bank) throw Error('PROBE_ARGUMENTS_REQUIRED');
  const env = dependencies.env ?? process.env;
  const ownerAwayFile = options.ownerAwayFile ?? env.SLEIGHT_OWNER_AWAY_FILE;
  const testGateFile = options.testGateFile ?? env.SLEIGHT_BENCH_GATE_FILE;
  const legacyDoneFile = options.legacyDoneFile ?? env.SLEIGHT_VM_LEGACY_DONE_FILE;
  const legacyBlockedFile = options.legacyBlockedFile ?? env.SLEIGHT_VM_LEGACY_BLOCKED_FILE;
  if (![ownerAwayFile, testGateFile, legacyDoneFile, legacyBlockedFile].every(path => typeof path === 'string' && path))
    throw Error('PROBE_MARKER_PATHS_REQUIRED');
  const check = () => {
    if (!existsSync(ownerAwayFile)) throw Error('OWNER_AWAY_REQUIRED');
  };
  const waits = [], pause = dependencies.pause ?? sleep;
  const wait = async (reason, blocked) => {
    if (!blocked()) return;
    const start = Date.now();
    (dependencies.print ?? console.log)(JSON.stringify({ wait: reason, start }));
    while (blocked()) { check(); await pause(60000); }
    const entry = { reason, start, ms: Date.now() - start }; waits.push(entry);
    (dependencies.print ?? console.log)(JSON.stringify(entry));
  };
  check();
  mkdirSync(options.bank, { mode: 0o700 });
  const child = async (command, args, settings) => {
    const start = Date.now(), result = await (dependencies.child ?? runChild)(command, args, settings);
    appendFileSync(join(options.bank, 'commands.jsonl'), JSON.stringify({ command, args, start, ms: Date.now() - start,
      status: result.status, signal: result.signal, reason: result.reason, stdout: result.stdout?.slice(0, 65536), stderr: result.stderr?.slice(0, 4096) }) + '\n', { mode: 0o600 });
    return result;
  };
  await wait('legacy users', () => existsSync(dependencies.legacyLockPath ?? '/tmp/sleight-live.lock') ||
    ![legacyDoneFile, legacyBlockedFile].some(path => existsSync(path)));
  await wait('test gate', () => !existsSync(testGateFile));
  await wait('hold', () => existsSync(dependencies.holdFile ?? '/tmp/sleight-hold'));
  const releaseLive = await (dependencies.liveLock ?? acquireLiveLock)();
  let unlock;
  try {
    unlock = (dependencies.lock ?? lockVM)();
    const transport = (dependencies.transport ?? createRowTransport)({ ...options, restoreMode: 'disposable' }, { check, child });
    const start = Date.now();
    await transport.restore();
    try {
      const ready = await transport.ready(), restoreToReadyMs = Date.now() - start;
      const sample = await transport.probe();
      const result = { rows: 0, ready, restoreToReadyMs, sample, waits };
      writeFileSync(join(options.bank, 'probe.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await transport.finish();
      unlock(); unlock = undefined;
      if (options.kit) {
        await wait('test gate', () => !existsSync(testGateFile));
        await wait('hold', () => existsSync(dependencies.holdFile ?? '/tmp/sleight-hold'));
        result.row = await (dependencies.runRows ?? runRows)({ ...options, ownerAwayFile, bank: join(options.bank, 'person-idle'), rows: ['person-idle'] }, { child });
      }
      return result;
    } catch (error) { if (unlock) await transport.finish(); throw error; }
  } finally { unlock?.(); await releaseLive(); }
}
if (isMain(import.meta.url)) disposableProbe(parseArgs(process.argv.slice(2)))
  .then(result => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.row && !result.row.completed ? 1 : 0; }).catch(error => { console.error(error.message); process.exitCode = 1; });
