// The launcher's second check behind the guard hook: a command that changes sleight's settings runs only when a person
// started it in a terminal. The hook reads command text; this reads the process itself. Read-only forms run anywhere.
// Tests inject the ancestor walk as a function. Nothing in the environment turns this off.
import { execFileSync } from 'node:child_process';

// Each command family the launcher gates, with the forms that only read. Every other form in a family is refused
// unless a person started it, so a new writer is covered before anyone lists it here.
const READS = {
  hand: a => a.length === 1 && a[0] === 'status',
  turbo: a => a.length === 1 && a[0] === 'status',
  cursor: a => a.length === 1 && ['list', 'status'].includes(a[0]) || a.length === 2 && a[0] === 'check',
  permissions: a => !a.length || a.length === 1 && ['list', 'memory'].includes(a[0]) || a.length === 2 && a[0] === 'memory' && a[1] === 'list',
  allow: a => a.length === 1 && a[0] === 'list',
  // run-now runs a saved routine or watch the person installed; it changes no setting.
  routine: a => a.length === 1 && a[0] === 'list' || a[0] === 'run-now',
  watch: a => a.length === 1 && ['list', 'notes'].includes(a[0]) || a[0] === 'run-now',
};
export const GATED_COMMANDS = Object.keys(READS);

/** The command's name for the refusal line when args (the launcher's argv after the script) change settings. */
export function settingsCommand(args) {
  const [family, ...rest] = args;
  if (!Object.hasOwn(READS, family) || READS[family](rest)) return undefined;
  const words = [family, ...rest.slice(0, family === 'turbo' && rest[0] === 'app' || family === 'permissions' && rest[0] === 'memory' ? 2 : 1)];
  return words.map(word => String(word).replace(/[^\w.:/@-]/g, '').slice(0, 40)).filter(Boolean).join(' ');
}

export const refusalLine = command => `sleight: ${command} changes sleight's settings, so run it yourself in a terminal (or use the menu bar).`;

const base = path => path.split('/').at(-1).toLowerCase();
/** True when one `ps -o ppid=,comm=,args=` row (without its ppid) is Claude Code or the Claude desktop app. comm can hold
 *  spaces (Claude Helper), so the bundle path is matched anywhere in the row. */
export function claudeProcess(row) {
  if (typeof row !== 'string') return true;
  if (/\/claude\.app\/contents\//i.test(row) || row.includes('@anthropic-ai/claude-code')) return true;
  const words = row.trim().split(/\s+/);
  // The claude executable by comm or argv[0], or node running the CLI (an npm install starts `node .../bin/claude`).
  if (words.slice(0, 2).some(word => base(word) === 'claude')) return true;
  return base(words[0] ?? '') === 'node' && words.slice(1).some(word => base(word) === 'claude' || /(?:^|\/)claude-code\//i.test(word));
}

const defaultPs = (pid, timeout) => execFileSync('/bin/ps', ['-o', 'ppid=,comm=,args=', '-p', String(pid)],
  { encoding: 'utf8', timeout: Math.max(1, Math.ceil(timeout)), stdio: ['ignore', 'pipe', 'ignore'] });

/** Walks the parents of `pid` up to launchd with one ps call per level, at most `levels` levels within `budgetMs`.
 *  Returns { ok: true } or { ok: false, reason }. Anything it can't read fails closed. */
export function walkAncestors({ pid = process.ppid, ps = defaultPs, levels = 32, budgetMs = 1000, now = Date.now } = {}) {
  const deadline = now() + budgetMs;
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'orphaned' }; // a person's shell is always the parent
  for (let level = 0; level < levels; level++) {
    const left = deadline - now();
    if (left <= 0) return { ok: false, reason: 'timeout' };
    let text;
    try { text = ps(pid, left); } catch { return { ok: false, reason: 'ps failed' }; }
    const match = typeof text === 'string' && /^\s*(\d+)\s+(\S.*)$/.exec(text.split('\n').find(line => line.trim()) ?? '');
    if (!match) return { ok: false, reason: 'unreadable' };
    if (claudeProcess(match[2])) return { ok: false, reason: 'claude' };
    pid = Number(match[1]);
    if (pid <= 1) return now() > deadline ? { ok: false, reason: 'timeout' } : { ok: true };
  }
  return { ok: false, reason: 'too deep' };
}

/** undefined when the person may run args, else the refusal line. Both rules must hold: stdin and stdout are terminals, and
 *  no ancestor is Claude Code or the Claude app (a pseudo-terminal started from Claude's shell still sits under it). */
export function settingsRefusal(args, { stdin = process.stdin, stdout = process.stdout, ancestors = walkAncestors } = {}) {
  const command = settingsCommand(args);
  if (command === undefined) return undefined;
  try {
    if (stdin?.isTTY !== true || stdout?.isTTY !== true || ancestors()?.ok !== true) return refusalLine(command);
  } catch { return refusalLine(command); }
  return undefined;
}
