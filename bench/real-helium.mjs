import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';

let compilation, bank, executable, uncollected = false;
process.once('exit', () => { if (bank && !uncollected) rmSync(bank, { recursive: true, force: true }); });
export async function heliumHelper(signal) {
  signal?.throwIfAborted();
  if (uncollected) throw new Error('Helium compiler process group cleanup unconfirmed');
  if (executable) return executable;
  compilation ??= (async () => {
    bank = mkdtempSync(join(tmpdir(), 'real-helium-cache-'));
    const path = join(bank, 'helium-fixture');
    const result = await runOwned('/usr/bin/xcrun', ['swiftc', '-module-cache-path', bank,
      fileURLToPath(new URL('./real-helium.swift', import.meta.url)), '-o', path], { signal, timeoutMs: 180000 });
    if (!result.groupClean) { uncollected = true; throw new Error('Helium compiler process group cleanup unconfirmed'); }
    if (result.exit.code !== 0 || result.cancelled || result.timedOut || result.spawnError) {
      rmSync(bank, { recursive: true, force: true }); bank = undefined;
      throw Object.assign(new Error(`Helium helper compilation failed: ${result.stderr.trim() || result.spawnError || result.exit.code}`), { noMutation: true });
    }
    executable = path;
    return path;
  })();
  try { return await compilation; } finally { compilation = undefined; }
}
