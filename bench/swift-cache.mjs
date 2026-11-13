import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { runOwned } from './preapproved-process.mjs';

// One module cache for every benchmark helper compile. A fresh cache per compile cost about 230 MB
// of disk and a full module build each time, and a killed test left it behind: 35 of them held
// 6.5 GB of the temp folder on 2026-10-10. Concurrent swiftc runs share a module cache safely.
export function swiftModuleCache(home = homedir()) {
  const path = join(home, 'Library', 'Caches', 'sleight-bench', 'swift-module-cache');
  mkdirSync(path, { recursive: true });
  return path;
}

// Compile only on demand, before driving an app. Publish complete helpers by rename, as window-cover does.
// runOwned collects the compiler and its frontend group before a timeout returns.
export async function compileSwiftHelper(source, { home = homedir(), run = runOwned, signal, timeoutMs = 310000 } = {}) {
  signal?.throwIfAborted();
  const bytes = readFileSync(source);
  const hash = createHash('sha256').update(bytes).update(`\0${process.platform}\0${process.arch}`).digest('hex');
  const helpers = join(home, 'Library', 'Caches', 'sleight-bench', 'helpers');
  const binary = join(helpers, `${basename(source, '.swift')}-${hash}`);
  if (existsSync(binary)) return binary;
  mkdirSync(helpers, { recursive: true });
  const bank = mkdtempSync(join(helpers, '.build-')), output = join(bank, 'helper');
  let uncollected = false;
  try {
    const result = await run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(home), source, '-o', output],
      { signal, timeoutMs });
    if (result.groupClean !== true) {
      uncollected = true;
      throw Object.assign(new Error(`Swift helper compiler process group cleanup unconfirmed; staging: ${bank}`), { uncollected: true });
    }
    if (result.timedOut || result.cancelled || result.spawnError || result.exit?.code !== 0) {
      const reason = result.timedOut ? `timed out after ${timeoutMs} ms` : result.cancelled ? 'cancelled' :
        result.stderr?.trim() || result.spawnError || `exit ${result.exit?.code}`;
      throw new Error(`Swift helper compilation failed: ${reason}`);
    }
    signal?.throwIfAborted();
    if (!readFileSync(source).equals(bytes)) throw new Error('Swift helper source changed during compilation');
    renameSync(output, binary);
    return binary;
  } finally { if (!uncollected) rmSync(bank, { recursive: true, force: true }); }
}
