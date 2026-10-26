// The launcher's second check behind the guard hook: a command that changes sleight's settings runs only when a person
// started it in a terminal. The hook reads command text; this reads the process itself. Read-only forms run anywhere.
// Tests inject the ancestor walk as a function. Nothing in the environment turns this off.
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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

// The refusal's reason, from the walk's reason code.
const REASONS = { 'no terminal': 'no terminal', claude: 'started under an agent', openai: 'started under an agent', agent: 'started under an agent',
  multiplexer: 'inside a terminal multiplexer', timeout: 'check timed out', 'fresh session': 'the terminal opened less than 10 s ago, so try again' };
const NOT_FROM_TERMINAL = ['no tty', 'no terminal app', 'unknown ancestor', 'session', 'orphaned', 'too deep'];
export const reasonText = code => REASONS[code] ?? (NOT_FROM_TERMINAL.includes(code) ? 'not started from a terminal app' : 'check failed');
export const refusalLine = (command, code = 'check failed') =>
  `sleight: ${command} changes sleight's settings, so run it yourself in a terminal (or use the menu bar). Reason: ${reasonText(code)}.`;

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
const PASS_THROUGH = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', 'sudo', 'su', 'env', 'nice']);
const command = args => base(args.trim().split(/\s+/)[0] ?? '').replace(/^-/, '');
// GUI terminals by bundle path, never by name alone. Editors and terminals that host their own agents (VS Code, Cursor, Warp)
// aren't listed: their agents run commands in those terminals.
const TERMINAL_BUNDLES = ['iTerm.app', 'Ghostty.app', 'WezTerm.app', 'kitty.app', 'Alacritty.app'];
export const terminalBundles = home => ['/System/Applications/Utilities/Terminal.app/Contents/', '/Applications/Utilities/Terminal.app/Contents/',
  ...TERMINAL_BUNDLES.flatMap(bundle => [`/Applications/${bundle}/Contents/`, ...home ? [`${home.replace(/\/$/, '')}/Applications/${bundle}/Contents/`] : []])];

const run = (file, argv, timeout) => execFileSync(file, argv,
  { encoding: 'utf8', timeout: Math.max(1, Math.ceil(timeout)), stdio: ['ignore', 'pipe', 'ignore'] });
export const systemPs = (argv, timeout) => run('/bin/ps', argv, timeout);
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
    // ps prints lstart to the second in local time ("Mon Oct 26 11:56:00 2026"); anything else fails closed.
    const started = Date.parse(call(['-o', 'lstart=', '-p', String(leaders[0])]).trim());
    if (!Number.isFinite(started)) return { ok: false, reason: 'unreadable' };
    if (now() - started < freshMs) return { ok: false, reason: 'fresh session' };
    return { ok: true };
  } catch (error) { return { ok: false, reason: error === TIMEOUT ? 'timeout' : 'ps failed' }; }
}

/** Whether writing `path` would land in sleight's settings folder (~/Library/Application Support/sleight), after links:
 *  the file's own real path when it exists, else its nearest existing folder's real path with the rest appended. APFS
 *  ignores case by default, so the comparison does too. A file with another hard link could be a settings file under a
 *  second name, so it counts as inside. `record <source> <out>` refuses such an out. */
export function insideSettings(path, { home = homeFolder(), real = realpathSync.native, stat = lstatSync } = {}) {
  if (typeof path !== 'string' || !path || !home) return true;
  const folder = join(home, 'Library/Application Support/sleight');
  const canonical = value => { let at = resolve(value), rest = []; for (;;) {
    try { return join(real(at), ...rest); } catch (error) { if (error?.code !== 'ENOENT' || dirname(at) === at) throw error; }
    rest.unshift(basename(at)); at = dirname(at);
  } };
  try {
    try { if (stat(path).nlink > 1) return true; } catch (error) { if (error?.code !== 'ENOENT') return true; }
    const target = canonical(path).toLowerCase(), roots = [folder, canonical(folder)].map(root => root.toLowerCase().replace(/\/$/, ''));
    return roots.some(root => target === root || target.startsWith(root + '/'));
  } catch { return true; }
}

// Claude Code sets these in every shell it starts, and a daemon started there inherits them. One more signal on top of the walk.
const AGENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/** undefined when the person may run args, else the refusal line. All must hold: stdin and stdout are terminals, the
 *  environment carries no agent marker, and the walk reaches a GUI terminal app through shells alone (a pseudo-terminal
 *  started from an agent's shell sits under the agent, and a multiplexer server sits under launchd, so both refuse). */
export function settingsRefusal(args, { stdin = process.stdin, stdout = process.stdout, env = process.env, ancestors = walkAncestors } = {}) {
  const command = settingsCommand(args);
  if (command === undefined) return undefined;
  try {
    if (stdin?.isTTY !== true || stdout?.isTTY !== true) return refusalLine(command, 'no terminal');
    if (AGENT_ENV.some(name => env?.[name])) return refusalLine(command, 'agent');
    const walked = ancestors();
    if (walked?.ok !== true) return refusalLine(command, walked?.reason);
  } catch { return refusalLine(command); }
  return undefined;
}
