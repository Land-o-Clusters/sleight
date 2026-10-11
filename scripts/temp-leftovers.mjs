// List or remove leftover sleight-* temp folders. Never touches other names,
// $TMPDIR/sleight-bench, a folder a process still holds, or a git worktree.
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const KEEP_NAME = 'sleight-bench';

export function keepTemp() {
  return process.env.SLEIGHT_KEEP_TEMP === '1';
}

export function removeTemp(dir) {
  if (keepTemp() || !dir) return;
  try { unlinkSync(join(dir, '.coordinator.sqlite')); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 }); } catch {}
}

export function registerTemp(t, dir) {
  t.after(() => removeTemp(dir));
  return dir;
}

const tracked = new Set();
function flushTracked() {
  for (const dir of tracked) removeTemp(dir);
  tracked.clear();
}

export function trackTemp(dir) {
  if (!trackTemp.armed) {
    trackTemp.armed = true;
    process.on('exit', flushTracked);
  }
  tracked.add(dir);
  return dir;
}

export function prefixOf(name) {
  return name.replace(/-[A-Za-z0-9]{6}$/, '');
}

export function defaultRoots() {
  const roots = [];
  for (const raw of ['/private/tmp', tmpdir()]) {
    try { roots.push(realpathSync(raw)); } catch { roots.push(raw); }
  }
  return [...new Set(roots)];
}

export function folderSize(dir) {
  let total = 0;
  const walk = path => {
    let st;
    try { st = lstatSync(path); } catch { return; }
    total += st.size;
    if (st.isDirectory() && !st.isSymbolicLink()) {
      let names = [];
      try { names = readdirSync(path); } catch { return; }
      for (const name of names) walk(join(path, name));
    }
  };
  walk(dir);
  return total;
}

export function heldPaths() {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-F', 'n'], { encoding: 'utf8', maxBuffer: 80_000_000 });
  const held = new Set();
  for (const line of (result.stdout ?? '').split('\n')) {
    if (line.startsWith('n') && line.length > 1) held.add(line.slice(1));
  }
  return held;
}

function resolve(path) {
  try { return realpathSync(path); } catch { return path; }
}

export function isHeld(path, held) {
  const resolved = resolve(path);
  for (const open of held) {
    const name = open.startsWith('n') ? open.slice(1) : open;
    if (name === resolved || name.startsWith(resolved + '/')) return true;
  }
  return false;
}

export function refuseNonSleight(path) {
  const name = basename(String(path).replace(/\/+$/, '') || path);
  if (!name.startsWith('sleight-')) return `refuses a path that is not sleight-: ${path}`;
  return null;
}

export function listLeftovers({
  roots = defaultRoots(), now = Date.now(), minAgeMs = MAX_AGE_MS, held = heldPaths(),
} = {}) {
  const items = [];
  for (const root of roots) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('sleight-') || name === KEEP_NAME) continue;
      const path = join(root, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (!st.isDirectory() || existsSync(join(path, '.git'))) continue;
      if (now - st.mtimeMs < minAgeMs) continue;
      if (isHeld(path, held)) continue;
      items.push({ path, name, prefix: prefixOf(name), size: folderSize(path), ageMs: now - st.mtimeMs });
    }
  }
  return items;
}

export function main(argv = process.argv.slice(2), io = process) {
  const roots = [];
  const paths = [];
  let remove = false;
  let maxAgeHours = 6;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remove') remove = true;
    else if (arg === '--root') {
      if (!argv[i + 1]) { io.stderr.write('missing --root path\n'); return 2; }
      roots.push(argv[++i]);
    } else if (arg === '--max-age-hours') maxAgeHours = Number(argv[++i]);
    else if (arg.startsWith('-')) { io.stderr.write(`unknown flag: ${arg}\n`); return 2; }
    else paths.push(arg);
  }
  for (const path of paths) {
    const err = refuseNonSleight(path);
    if (err) { io.stderr.write(err + '\n'); return 2; }
  }
  const items = listLeftovers({
    roots: roots.length ? roots : defaultRoots(),
    minAgeMs: maxAgeHours * 60 * 60 * 1000,
  });
  const selected = paths.length
    ? items.filter(item => paths.includes(item.path) || paths.includes(item.name))
    : items;
  for (const item of selected) {
    io.stdout.write(`${item.size}\t${item.prefix}\t${item.path}\n`);
    if (remove) rmSync(item.path, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
