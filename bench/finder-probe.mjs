import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';
import { runOwned } from './preapproved-process.mjs';

const helper = fileURLToPath(new URL('./real-fixture.js', import.meta.url));

export async function runFinderProbe({ dryRun = false, ownerAway = false, debug = false, signal } = {}, deps = {}) {
  const stderr = deps.stderr ?? (message => process.stderr.write(message));
  const diagnostic = (step, error) => {
    if (!debug) return;
    try { stderr(`[finder-probe debug] step=${step}\nmessage: ${error.message}\nstack: ${error.stack}\n`); } catch {}
  };
  let step = 'authorization';
  try {
    if (dryRun) return { dryRun: true, opensWindows: false, writesFiles: false, setups: 1,
      command: 'node bench/finder-probe.mjs --owner-away',
      records: ['roles', 'desktopReferenceEquality', 'ownerWindowsEqual', 'createdWindow', 'scrollAreasBaseline', 'scrollAreasMatched', 'panel'],
      cleanup: 'Production cleanup closes only the retained created window. Unconfirmed cleanup keeps the live lock.',
      coverage: 'Run once with zero owner windows and once with one existing owner window. This probe never creates an owner window.' };
    if (!ownerAway) throw new Error('Finder probe requires explicit --owner-away');
    signal?.throwIfAborted();
    step = 'hold';
    const hold = deps.hold ?? (() => existsSync('/tmp/sleight-hold'));
    const check = () => { signal?.throwIfAborted(); if (hold()) throw new Error('Live hold exists; Finder probe stopped'); };
    check();
    step = 'lock';
    const release = await (deps.lock ?? acquireLiveLock)('/tmp/sleight-live.lock', { wait: false, signal });
    const persist = deps.persist ?? (receipt => writeFileSync(receipt.receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }));
    let attempted = false, result, dir, cancelled = false;
    const writeControl = () => {
      const next = join(dir, 'control.next');
      writeFileSync(next, JSON.stringify({ cancelled }), { mode: 0o600 });
      renameSync(next, join(dir, 'control.json'));
    };
    const cancel = () => {
      cancelled = true;
      try { writeControl(); } catch (error) { diagnostic('write cancellation control', error); }
    };
    try {
      step = 'fixture directory';
      check();
      dir = mkdtempSync(join(deps.tempRoot ?? '/private/tmp', 'sleight-finder-probe-'));
      const target = join(dir, 'Finder-probe');
      mkdirSync(target, { mode: 0o700 });
      writeControl();
      signal?.addEventListener('abort', cancel, { once: true });
      check();
      attempted = true;
      step = 'helper';
      // The control file lets the AX host finish its own cleanup on interruption.
      // The process runner owns and collects its child, even on a deadline.
      const child = await (deps.run ?? runOwned)('/usr/bin/osascript', ['-l', 'JavaScript', helper, JSON.stringify({
        mode: 'finder-probe', bundle: 'com.apple.finder', ownerAway: true, stopOnLiveHold: true, debug,
        fixtureRoot: dir, target, control: join(dir, 'control.json'),
      })], { timeoutMs: 45000, graceMs: 1000 });
      // The helper's stderr is local diagnostic output only. It is never copied
      // into the result or either receipt write.
      if (debug && child.stderr) { try { stderr(child.stderr); } catch {} }
      step = 'helper receipt';
      let receipt;
      try { receipt = JSON.parse(child.stdout?.trim()); }
      catch (error) { diagnostic('parse helper receipt', error); }
      if (receipt?.probe !== 'finder-setup') receipt = { probe: 'finder-setup', passed: false, cleanupConfirmed: false, failure: 'helper-receipt-unavailable' };
      const collected = child.groupClean === true && child.exit?.code === 0;
      if (!collected || receipt.failure === 'helper-receipt-unavailable')
        diagnostic('helper collection', new Error(child.spawnError || 'Helper receipt or clean exit unavailable'));
      result = { ...receipt, passed: receipt.passed === true && collected && !cancelled,
        helperCollected: collected, cancelled, liveLockKept: true, receiptPath: join(dir, 'receipt.json') };
      step = 'persist receipt';
      persist(result);
      if (collected && receipt.cleanupConfirmed === true) {
        step = 'release lock';
        await release(); result.liveLockKept = false;
        try { persist(result); }
        catch (error) { diagnostic('update receipt', error); result.passed = false; result.receiptUpdateFailed = true; }
      }
      return result;
    } catch (error) {
      diagnostic(step, error);
      if (!attempted) {
        try { await release(); }
        catch (failure) { diagnostic('release lock before helper', failure); throw failure; }
      }
      throw Object.assign(new Error('Finder probe stopped; ' + (attempted ? 'cleanup unconfirmed, live lock kept' : 'no helper started')),
        { receiptDir: dir });
    } finally { signal?.removeEventListener('abort', cancel); }
  } catch (error) { diagnostic(step, error); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--owner-away', '--debug'].includes(arg)) || new Set(args).size !== args.length) {
    console.error('Usage: node bench/finder-probe.mjs --dry-run | --owner-away [--debug]');
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Finder probe interrupted'));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const result = await runFinderProbe({ dryRun: args.includes('--dry-run'), ownerAway: args.includes('--owner-away'),
        debug: args.includes('--debug'), signal: controller.signal });
      console.log(JSON.stringify(result, null, 2));
      if (!result.dryRun && !result.passed) process.exitCode = 1;
    } catch (error) { console.error(error.message); if (error.receiptDir) console.error(error.receiptDir); process.exitCode = 1; }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
}
