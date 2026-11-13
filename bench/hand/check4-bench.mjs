// Narrow adapter for bench/run.mjs. No benchmark imports, model calls or module-level effects.
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MODEL_TASKS } from './check4.mjs';
import { homedir } from 'node:os';

export function loadCheck4Bench(path, { suite, arm, task, runs, auth, ownerAway, dryRun }, parentPid = process.ppid) {
  if (!path) return undefined;
  if (suite !== 'world' || arm !== 'sleight' || !MODEL_TASKS.includes(task) || runs !== 1 || auth !== 'login' || !ownerAway || dryRun)
    throw Error('Check 4 requires one allowed world task, sleight only, one run, login and --owner-away');
  path = resolve(path);
  const stat = lstatSync(path), config = JSON.parse(readFileSync(path, 'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || realpathSync(path) !== path ||
      config.schema !== 'sleight.check4-bench/1' || config.task !== task || config.lock?.ownerPid !== parentPid ||
      dirname(path) !== config.dir || !config.dir.startsWith(realpathSync('/tmp') + '/')) throw Error('Invalid private Check 4 benchmark config');
  for (const key of ['result', 'evidence', 'transcript', 'collections', 'pids', 'status', 'trace', 'armDir']) {
    if (typeof config[key] !== 'string' || !config[key].startsWith(config.dir + '/') || resolve(config[key]) !== config[key])
      throw Error(`Invalid Check 4 ${key} path`);
  }
  if (typeof config.loginConfig !== 'string' || !config.loginConfig.startsWith('/') || resolve(config.loginConfig) !== config.loginConfig ||
      config.loginConfig === join(homedir(), '.claude')) throw Error('Check 4 requires the benchmark isolated login config');
  return config;
}

export function check4BenchDescriptor(config, root, node = process.execPath) {
  return { command: node, args: [join(root, 'bench/hand/check4-server.mjs'), join(config.dir, 'bench-config.json')],
    env: { SLEIGHT_HAND: '1', SLEIGHT_CURSOR_STYLE: 'sprite', SLEIGHT_RUNTIME: 'engine', SLEIGHT_TURBO: '0' } };
}

export function delegatedCheck4Lock(config, path = '/tmp/sleight-live.lock') {
  const verify = () => {
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== config.lock.dev || current.ino !== config.lock.ino)
      throw Error('Check 4 delegated live lock changed');
  };
  verify();
  // The parent owns removal. The child supplies a separate final cleanup receipt.
  return async () => { verify(); };
}

export function writeCheck4BenchResult(config, value) {
  if (!config) return;
  const partial = config.result + '.partial';
  writeFileSync(partial, JSON.stringify({ schema: 'sleight.check4-bench-result/1', ...value }), { mode: 0o600 });
  renameSync(partial, config.result);
}

// Read only this task's independent sampler. An empty PID filter is not a
// baseline: Finder must have been observed before the fixture was created.
export function check4FinderObservation(config, { pid, createdAtMs }, now = Date.now()) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !(createdAtMs > 0)) return null;
    const path = join(config.dir, 'sampler.jsonl'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 64 * 1024 * 1024) return null;
    // The writer may be halfway through its last line. Never use that line.
    const lines = readFileSync(path, 'utf8').split('\n'); lines.pop();
    const rows = lines.filter(Boolean).map(JSON.parse).filter(row => row.source === 'CGWindowListCopyWindowInfo' &&
      row.appPids?.includes(pid) && Array.isArray(row.windows));
    if (!rows.length || rows.some((row, i) => !Number.isFinite(row.epochMs) || i > 0 && row.epochMs < rows[i - 1].epochMs) ||
        rows[0].epochMs >= createdAtMs || now - rows.at(-1).epochMs > 2000 || rows.at(-1).epochMs > now) return null;
    const first = new Map();
    for (const row of rows) for (const window of row.windows) {
      // Finder menus belong to the same PID but cannot be fixture windows.
      if (window.pid !== pid || window.layer !== 0 || !(window.alpha > 0)) continue;
      if (!Number.isSafeInteger(window.id) || window.id <= 0) return null;
      if (!first.has(window.id)) first.set(window.id, { id: window.id, pid, firstSeenAtMs: row.epochMs });
    }
    if (first.size > 128) return null;
    return { schema: 'finder-sampler-witness/1', pid, createdAtMs, observedFromMs: rows[0].epochMs,
      sampledAtMs: rows.at(-1).epochMs, windows: [...first.values()] };
  } catch { return null; }
}
