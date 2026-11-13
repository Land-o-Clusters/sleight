// Offline format fixtures. This evaluates only G1's pure retention expression.
// It does not execute PowerShell, install a hook or prove Windows scheduling.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../bench/windows/uc3f-observer.ps1', import.meta.url), 'utf8');
const expression = /static bool RetainState\([^)]*\)\s*\{\s*return ([^;]+);\s*\}/.exec(source)?.[1];
if (!expression || !/^[\w\s|>=+()-]+$/.test(expression)) throw Error('RETENTION_EXPRESSION_INVALID');
const retain = runInNewContext(`(changed, tick, lastTick, force) => (${expression})`, { HeartbeatMs: 1000 }, { timeout: 100 });
const templates = readFileSync(new URL('./uc3f-observer-lines.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
export function syntheticObserver({ startTickMs = 100, durationMs = 900000, lease, invocation = '1', fault } = {}) {
  const rows = [{ ...templates[0], tickMs: startTickMs, leaseExpiresUtc: lease.expiresUtc.replace(/\.(\d{3})Z$/, '.$10000Z'),
    rowToken: lease.token, rowId: lease.row, invocation }];
  const poll = templates.find(r => r.kind === 'poll');
  let lastTick = startTickMs, pollCount = 0;
  for (let elapsed = 0; elapsed <= durationMs; elapsed += 10) {
    pollCount++;
    const tickMs = startTickMs + elapsed;
    if (retain(elapsed === 0, tickMs, lastTick, elapsed === durationMs)) {
      rows.push({ ...poll, tickMs, pollCount, maxGapMs: 10 }); lastTick = tickMs;
    }
  }
  rows.push({ ...templates.at(-1), tickMs: startTickMs + durationMs, records: rows.length + 1,
    pollCount, stopReason: 'stop-requested', diskError: fault === 'disk-overflow', truncated: fault === 'overflow' });
  rows.forEach((r, n) => { r.seq = n + 1; });
  if (fault === 'gap') rows.splice(2, 1);
  if (fault === 'heartbeat') {
    rows.splice(2, 1);
    rows.forEach((r, n) => { r.seq = n + 1; }); rows.at(-1).records = rows.length;
  }
  if (fault === 'missing-receipt') rows.pop();
  return rows;
}
