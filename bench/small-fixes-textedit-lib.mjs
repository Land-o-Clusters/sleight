// Pure decisions for the select-all check's harness (bench/small-fixes-textedit.mjs). No side
// effects: tests import this file, so it must not touch the filesystem, processes or the network.

// TextEdit launches with window restoration and the iCloud open panel off, so the instance this
// check starts shows only the check's own document (the 2026-10-11 refusals scanned a launch-time
// tree that the engine read contradicted seconds later).
export const LAUNCH_FLAGS = ['-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO'];

export const launchCommand = path => ['/usr/bin/open', ['-g', '-b', 'com.apple.TextEdit', path, '--args', ...LAUNCH_FLAGS]];

// Launch this run's own TextEdit when none runs; attach to the one already running otherwise.
// A foreground TextEdit still refuses without activation, as before.
export function planForPreflight({ running, foregroundTextEdit }) {
  if (foregroundTextEdit) return { launch: false, refuse: 'TextEdit is foreground; no activation attempted' };
  return { launch: !running };
}

// Launch races (process registration, document open) and a busy accessibility read (-25204) retry;
// refusals, including a dialog signal on the owned window, do not.
export const isRetry = message => /^Retry: /.test(message) || /-25204$/.test(message);

// A TextEdit instance this run launched and cannot confirm gone keeps the lock for operator
// inspection. Every other cleanup failure is reported with exit code 1 while the lock releases, so
// a refusal no longer stalls the chain behind it (all three 2026-10-11 dialog refusals kept
// /tmp/sleight-live.lock over a document close that the same false positive had blocked).
export const shouldRetainLock = ({ ownedInstance, quitConfirmed }) => Boolean(ownedInstance && !quitConfirmed);
