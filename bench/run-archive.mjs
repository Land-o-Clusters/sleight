import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// TextEdit's Save sheet lists the folder it opens in, and every run saves inside the benchmark's
// temp folder: with 135 old runs there, one read of the sheet was 57,000 characters, over Claude
// Code's tool output limit (2026-10-10). Older runs move to an archive, traces kept for studies.
export function archiveOldRuns(benchDir, archiveDir, { maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  if (!existsSync(benchDir)) return [];
  const moved = [];
  for (const name of readdirSync(benchDir)) {
    if (!/^\d{4}-\d\d-\d\dT[\d-]+Z$/.test(name)) continue;
    const from = join(benchDir, name);
    let info;
    try { info = statSync(from); } catch { continue; }
    if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
    mkdirSync(archiveDir, { recursive: true });
    try { renameSync(from, join(archiveDir, name)); moved.push(name); } catch {}
  }
  return moved;
}
