import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    const args = server.args ?? [], resolvedEnv = server.env ?? {};
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !resolvedEnv ||
        typeof resolvedEnv !== 'object' || Array.isArray(resolvedEnv) || Object.values(resolvedEnv).some(value => typeof value !== 'string'))
      throw Error('Invalid resolved arguments or environment');
    // Sort keys so configuration key order cannot change identity. Never retain env values.
    const envSHA256 = createHash('sha256').update(JSON.stringify(Object.entries(resolvedEnv).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
    engine.resolved = { version: server.version, command: server.command, args: [...args], envSHA256, configPath: server.configPath };
  } catch { engine.error = 'Cannot resolve computer-use server identity'; }
  return engine;
}

export function engineDifference(reads) {
  if (reads.some(engine => !engine || typeof engine.version !== 'string' || !engine.version.trim() ||
      typeof engine.build !== 'string' || !engine.build.trim() || engine.error)) return 'engine version or build unverified';
  if (new Set(reads.map(engine => JSON.stringify([engine.version, engine.build]))).size > 1) return 'engine build changed during campaign';
  if (reads.some(engine => typeof engine.resolved?.version !== 'string' || !engine.resolved.version.trim() || engine.resolved.version === 'bundle' ||
      typeof engine.resolved.command !== 'string' || !engine.resolved.command.trim() || !Array.isArray(engine.resolved.args) ||
      engine.resolved.args.some(arg => typeof arg !== 'string') || !/^[a-f0-9]{64}$/.test(engine.resolved.envSHA256 ?? '')))
    return 'resolved engine version, command, arguments or environment unverified';
  if (new Set(reads.map(engine => JSON.stringify([engine.resolved.version, engine.resolved.command, engine.resolved.args, engine.resolved.envSHA256]))).size > 1)
    return 'resolved engine version, command, arguments or environment changed during campaign';
  return null;
}

// Deferred reads start with the fixture's final child env, before any server launch,
// and end after cleanup. A changed build stops later launches.
export async function engineIteration(operation, { previous = [], read = env => readReplayEngine({ env }), deferred = false } = {}) {
  const engine = {};
  const reads = previous.flatMap(span => [span?.start, span?.end]);
  let environment;
  const begin = async env => {
    if (engine.start) throw Error('Engine identity already started');
    environment = env;
    engine.start = await read(env);
    const reason = engineDifference([...reads, engine.start]);
    if (reason) throw Error(reason);
  };
  let result;
  try {
    if (deferred) result = await operation(begin);
    else {
      engine.start = await read();
      const stop = engineDifference([...reads, engine.start]);
      result = stop ? { verdict: 'diverge', reason: stop, calls: [], totalToolMs: 0, cleanupConfirmed: true } : await operation();
    }
  } catch (error) { error.engine = engine; throw error; }
  finally {
    if (engine.start) engine.end = await read(environment);
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
