import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));

// Pin the same resolution inputs in the launcher children and the harness observations.
export function replayEngineEnvironment(env = process.env) {
  return { CODEX_HOME: env.CODEX_HOME || join(homedir(), '.codex'),
    SLEIGHT_CHATGPT_APP: env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app' };
}

export async function readReplayEngine({ env = process.env, worktree = repo, resolve,
  read = (key, plist) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(), now = () => new Date() } = {}) {
  const plist = join(env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app', 'Contents/Info.plist');
  const engine = { version: null, build: null, at: now().toISOString(), source: plist };
  try {
    engine.version = read('CFBundleShortVersionString', plist);
    engine.build = read('CFBundleVersion', plist);
  } catch { engine.error = 'Cannot read ChatGPT engine version and build'; }
  try {
    // Each arm runs its own launcher, which can change resolution between builds.
    resolve ??= (await import(pathToFileURL(join(worktree, 'plugins/sleight/lib/launch.mjs')).href)).resolveServer;
    const server = await resolve(env);
    if (server.error) throw Error(server.error);
    engine.resolved = { version: server.version, command: server.command, configPath: server.configPath };
  } catch { engine.error = 'Cannot resolve computer-use server identity'; }
  return engine;
}

export function engineDifference(reads) {
  if (reads.some(engine => !engine || typeof engine.version !== 'string' || !engine.version.trim() ||
      typeof engine.build !== 'string' || !engine.build.trim() || engine.error)) return 'engine version or build unverified';
  if (new Set(reads.map(engine => JSON.stringify([engine.version, engine.build]))).size > 1) return 'engine build changed during campaign';
  if (reads.some(engine => typeof engine.resolved?.version !== 'string' || !engine.resolved.version.trim() || engine.resolved.version === 'bundle' ||
      typeof engine.resolved.command !== 'string' || !engine.resolved.command.trim())) return 'resolved engine version or command unverified';
  if (new Set(reads.map(engine => JSON.stringify([engine.resolved.version, engine.resolved.command]))).size > 1)
    return 'resolved engine version or command changed during campaign';
  return null;
}

// Reads bracket setup, transport and cleanup. A changed build stops later launches.
export async function engineIteration(operation, { previous = [], read = readReplayEngine } = {}) {
  const engine = { start: await read() };
  const reads = previous.flatMap(span => [span?.start, span?.end]);
  const stop = engineDifference([...reads, engine.start]);
  let result;
  try {
    result = stop ? { verdict: 'diverge', reason: stop, calls: [], totalToolMs: 0, cleanupConfirmed: true } : await operation();
  } catch (error) { error.engine = engine; throw error; }
  finally {
    engine.end = await read();
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
    build: reason ? null : reads[0].build, resolved: reason ? null : reads[0].resolved, ...(reason ? { reason } : {}) };
}
