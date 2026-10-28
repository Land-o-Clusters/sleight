import { execFileSync } from 'node:child_process';

const plist = '/Applications/ChatGPT.app/Contents/Info.plist';
export function readReplayEngine({ read = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(), now = () => new Date() } = {}) {
  const engine = { version: null, build: null, at: now().toISOString(), source: plist };
  try {
    engine.version = read('CFBundleShortVersionString');
    engine.build = read('CFBundleVersion');
  } catch { engine.error = 'Cannot read ChatGPT engine version and build'; }
  return engine;
}

export function engineDifference(reads) {
  if (reads.some(engine => !engine || typeof engine.version !== 'string' || !engine.version.trim() ||
      typeof engine.build !== 'string' || !engine.build.trim() || engine.error)) return 'engine version or build unverified';
  if (new Set(reads.map(engine => JSON.stringify([engine.version, engine.build]))).size > 1) return 'engine build changed during campaign';
  return null;
}

// Reads bracket setup, transport and cleanup. A changed build stops later launches.
export async function engineIteration(operation, { previous = [], read = readReplayEngine } = {}) {
  const engine = { start: read() };
  const reads = previous.flatMap(span => [span?.start, span?.end]);
  const stop = engineDifference([...reads, engine.start]);
  let result;
  try {
    result = stop ? { verdict: 'diverge', reason: stop, calls: [], totalToolMs: 0, cleanupConfirmed: true } : await operation();
  } catch (error) { error.engine = engine; throw error; }
  finally {
    engine.end = read();
    engine.changed = Boolean(engineDifference([engine.start, engine.end]));
    const reason = engineDifference([...reads, engine.start, engine.end]);
    if (reason) engine.reason = reason;
  }
  return { ...result, ...(engine.reason ? { verdict: 'diverge', reason: engine.reason } : {}), engine };
}

export function campaignEngine(runs) {
  if (!runs.some(run => run.engine)) return { verdict: 'not-recorded' };
  const reads = runs.flatMap(run => [run.engine?.start, run.engine?.end]);
  const reason = engineDifference(reads);
  return { verdict: reason ? 'refuse' : 'pass', version: reason ? null : reads[0].version,
    build: reason ? null : reads[0].build, ...(reason ? { reason } : {}) };
}
