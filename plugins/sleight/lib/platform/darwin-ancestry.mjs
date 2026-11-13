// Existing macOS person-gate walk. Importing this module reads no process state.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

const base = path => path.split('/').at(-1).toLowerCase();
/** One `ps -o ppid=,comm=,args=` row without its ppid, split into argv. macOS cuts comm to 16 characters and takes it from
 *  argv[0], so comm is the longest prefix of argv[0] (16 characters at most, spaces allowed) that args repeats after it. */
export function rowArgs(row) {
  for (let at = Math.min(16, row.length - 1); at > 0; at--) {
    if (row[at] === ' ' && row.startsWith(row.slice(0, at), at + 1)) return row.slice(at + 1);
  }
  return row; // a ps without the cut (Linux prints a short name): match on everything
}

/** The agent an args string belongs to, or undefined: Claude Code (npm, the native installer's versions folder, the desktop
 *  app's claude.app), the Claude app, the Codex CLI, ChatGPT.app and Codex.app. Words before the first option are the
 *  command and its script, so a path with spaces still ends in its own basename. */
export function agentProcess(args) {
  if (typeof args !== 'string') return 'unreadable';
  if (/\/claude\.app\/contents\/|\/claude\/versions\/|\/claude-code\//i.test(args) || args.includes('@anthropic-ai/claude-code')) return 'claude';
  if (/\/(?:chatgpt|codex)\.app\/contents\//i.test(args) || args.includes('@openai/codex')) return 'openai';
  const words = args.trim().split(/\s+/), end = words.findIndex((word, at) => at > 0 && word.startsWith('-'));
  const lead = words.slice(0, end < 0 ? words.length : end).map(base);
  if (lead.includes('claude')) return 'claude';
  if (lead.includes('codex')) return 'openai';
  return undefined;
}

// A tmux or screen server re-parents to launchd, so a client anywhere can drive a session that looks clean.
const MULTIPLEXERS = new Set(['tmux', 'screen', 'zellij', 'abduco', 'dtach']);
// What may sit between the launcher and the terminal app: shells and the commands that start them.
export const PASS_THROUGH = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', 'sudo', 'su', 'env', 'nice']);
const command = args => base(args.trim().split(/\s+/)[0] ?? '').replace(/^-/, '');
// GUI terminals by bundle path, never by name alone. Editors and terminals that host their own agents (VS Code, Cursor, Warp)
// aren't listed: their agents run commands in those terminals.
const TERMINAL_BUNDLES = ['iTerm.app', 'Ghostty.app', 'WezTerm.app', 'kitty.app', 'Alacritty.app'];
export const terminalBundles = home => ['/System/Applications/Utilities/Terminal.app/Contents/', '/Applications/Utilities/Terminal.app/Contents/',
  ...TERMINAL_BUNDLES.flatMap(bundle => [`/Applications/${bundle}/Contents/`, ...home ? [`${home.replace(/\/$/, '')}/Applications/${bundle}/Contents/`] : []])];

const run = (file, argv, timeout, env = process.env) => execFileSync(file, argv,
  { encoding: 'utf8', timeout: Math.max(1, Math.ceil(timeout)), stdio: ['ignore', 'pipe', 'ignore'], env, killSignal: 'SIGKILL' });
/** Milliseconds from ps's etime ([[dd-]hh:]mm:ss), or NaN for anything else. */
export function elapsedMs(text) {
  const match = /^\s*(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!match) return NaN;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}
// LC_ALL=C keeps ps's output in one format whatever language the person's terminal uses. lsof keeps the person's own
// locale: under C it escapes non-ASCII bytes (`Jos\xc3\xa9`), and a terminal under such a home would stop matching its path.
export const systemPs = (argv, timeout) => run('/bin/ps', argv, timeout, { ...process.env, LC_ALL: 'C' });
/** The file a process actually runs. ps takes comm and args from argv[0], which `exec -a` sets to anything, so a terminal is
 *  confirmed by its mapped executable: lsof lists it first among the txt entries. */
export const systemExecutable = (pid, timeout) =>
  /^n(.+)$/m.exec(run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], timeout))?.[1];
const TIMEOUT = Symbol('timeout');
const homeFolder = () => { try { return userInfo().homedir; } catch { return undefined; } };

/** An allow-list walk from `pid` (the launcher's parent) up to launchd, one ps call per level, at most `levels` levels within
 *  `budgetMs` for every call together. Only shells and their starters may sit below a GUI terminal app, the terminal's own
 *  processes above it (each confirmed by its executable), then launchd. The session leader of the launcher's controlling tty
 *  (`self`) must be one of those shells, started `freshMs` or more ago. ps(argv, msLeft) returns ps's output, executable(pid, msLeft) the running file.
 *  Returns { ok: true } or { ok: false, reason }; anything it can't read fails closed. */
export function walkAncestors({ pid = process.ppid, self = process.pid, ps = systemPs, executable = systemExecutable, home = homeFolder(),
  levels = 32, budgetMs = 1000, now = Date.now, freshMs = 10000 } = {}) {
  const deadline = now() + budgetMs, bundles = terminalBundles(home);
  const timed = (fn, value) => {
    const left = deadline - now();
    if (left <= 0) throw TIMEOUT;
    const result = fn(value, left);
    if (now() > deadline) throw TIMEOUT;
    return result;
  };
  const call = argv => { const text = timed(ps, argv); return typeof text === 'string' ? text : ''; };
  try {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'orphaned' }; // a person's shell is always the parent
    const tty = call(['-o', 'tty=', '-p', String(self)]).trim();
    if (!/^[\w/]{1,32}$/.test(tty)) return { ok: false, reason: 'no tty' };
    const chain = [];
    let terminal, terminalAt;
    for (let level = 0; ; level++) {
      if (level >= levels) return { ok: false, reason: 'too deep' };
      const match = /^\s*(\d+) (.+)$/.exec(call(['-o', 'ppid=,comm=,args=', '-p', String(pid)]).split('\n').find(line => line.trim()) ?? '');
      if (!match) return { ok: false, reason: 'unreadable' };
      const args = rowArgs(match[2]), agent = agentProcess(args);
      if (agent) return { ok: false, reason: agent };
      if (MULTIPLEXERS.has(command(args))) return { ok: false, reason: 'multiplexer' };
      const bundle = bundles.find(prefix => args.startsWith(prefix));
      if (terminal ? bundle !== terminal : !bundle && !PASS_THROUGH.has(command(args))) return { ok: false, reason: 'unknown ancestor' };
      if (bundle) {
        const file = timed(executable, pid);
        if (typeof file !== 'string' || !file.startsWith(bundle)) return { ok: false, reason: 'unknown ancestor' };
        if (!terminal) { terminal = bundle; terminalAt = chain.length; }
      }
      chain.push(pid);
      pid = Number(match[1]);
      if (pid <= 1) break;
    }
    if (!terminal) return { ok: false, reason: 'no terminal app' };
    // macOS prints 0 for sess, so the leader is the process on this tty whose stat has the s flag.
    const leaders = call(['-t', tty, '-o', 'pid=,stat=']).split('\n').map(line => /^\s*(\d+)\s+(\S+)/.exec(line))
      .filter(m => m && m[2].includes('s')).map(m => Number(m[1]));
    const at = leaders.length === 1 ? chain.indexOf(leaders[0]) : -1;
    if (at < 0 || at >= terminalAt) return { ok: false, reason: 'session' };
    // A speed bump, not a guarantee: an agent that opens a fresh terminal and types at once meets a session under 10 s old.
    // etime has no month or day names, so no locale changes it; anything that isn't etime fails closed.
    if (freshMs > 0) {
      const age = elapsedMs(call(['-o', 'etime=', '-p', String(leaders[0])]));
      if (!Number.isFinite(age)) return { ok: false, reason: 'unreadable' };
      if (age < freshMs) return { ok: false, reason: 'fresh session' };
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error === TIMEOUT ? 'timeout' : 'ps failed' }; }
}
