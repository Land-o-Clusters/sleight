// The launcher's second check behind the guard hook: a command that changes sleight's settings runs only when a person
// started it in a terminal. Replay and record use the same check so an agent cannot start a relay outside Stop.
// The hook reads command text; this reads the process itself. Read-only forms run anywhere.
// Tests inject the ancestor walk as a function. Nothing in the environment turns this off.
import { getPlatform } from './platform/index.mjs';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { platformPaths } from './platform/paths.mjs';

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
  runs: a => a.length === 1 && a[0] === 'list' || a.length === 2 && a[0] === 'open' && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{32}$/.test(a[1]),
  replay: () => false, record: () => false,
  menu: () => false, link: () => false, unlink: () => false,
};
export const GATED_COMMANDS = Object.keys(READS);

/** The command's name for the refusal line when args (the launcher's argv after the script) change settings. */
export function settingsCommand(args) {
  const [family, ...rest] = args;
  if (!Object.hasOwn(READS, family) || READS[family](rest)) return undefined;
  // These permission arguments change the effect. Keep every flag, but bound
  // printed origins so a large site limit still fits in a terminal notice.
  if (family === 'permissions' && ['repair', 'sites', 'unblock'].includes(rest[0])) {
    let origins = 0, omitted = 0;
    const words = [family, ...rest].map(word => {
      const text = String(word).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
      if (/^https?:\/\//i.test(text.trim()) && ++origins > 8) { omitted++; return undefined; }
      return /^[A-Za-z0-9_.:/@*-]+$/.test(text) ? text : JSON.stringify(text);
    }).filter(word => word !== undefined);
    if (omitted) words.push('and', String(omitted), 'more');
    return words.join(' ');
  }
  const words = [family, ...rest.slice(0, family === 'turbo' && rest[0] === 'app' || family === 'permissions' && rest[0] === 'memory' ? 2 : 1)];
  return words.map(word => String(word).replace(/[^\w.:/@-]/g, '').slice(0, 40)).filter(Boolean).join(' ');
}

// The refusal's reason, from the walk's reason code.
const REASONS = { 'no terminal': 'no terminal', claude: 'started under an agent', openai: 'started under an agent', agent: 'started under an agent',
  multiplexer: 'inside a terminal multiplexer', timeout: 'check timed out', 'fresh session': 'the terminal opened less than 10 s ago, so try again' };
const NOT_FROM_TERMINAL = ['no tty', 'no terminal app', 'unknown ancestor', 'session', 'orphaned', 'too deep'];
export const reasonText = code => REASONS[code] ?? (NOT_FROM_TERMINAL.includes(code) ? 'not started from a terminal app' : 'check failed');
export const refusalLine = (command, code = 'check failed') => {
  if (/^(?:replay|record)(?: |$)/.test(command))
    return `sleight: ${command} starts a separate recording or replay, so run it yourself in a terminal. Reason: ${reasonText(code)}.`;
  return `sleight: ${command} changes sleight's settings, so run it yourself in a terminal (or use the menu bar). Reason: ${reasonText(code)}.`;
};

export { rowArgs, agentProcess, terminalBundles, elapsedMs, systemPs, systemExecutable } from './platform/darwin-ancestry.mjs';
export const walkAncestors = ({ platform = process.platform, ...options } = {}) =>
  getPlatform(platform).person.walkAncestors(options);
const homeFolder = () => { try { return userInfo().homedir; } catch { return undefined; } };

// The real path of `value`, or of its nearest existing folder with the rest appended.
const canonicalPath = (value, real = realpathSync.native, pathApi = { resolve, join, dirname, basename }) => { let at = pathApi.resolve(value), rest = []; for (;;) {
  try { return pathApi.join(real(at), ...rest); } catch (error) { if (error?.code !== 'ENOENT' || pathApi.dirname(at) === at) throw error; }
  rest.unshift(pathApi.basename(at)); at = pathApi.dirname(at);
} };
// Whether a real path is sleight's settings folder or inside it. APFS ignores case by default, so the comparison does too.
function underSettings(realPath, home, real = realpathSync.native, platform = process.platform, pathApi) {
  const folder = platformPaths({ home, platform }).settings;
  const fold = value => (platform === 'win32' ? value.replace(/\\/g, '/') : value).toLowerCase().replace(/\/$/, '');
  const target = fold(realPath), roots = [folder, canonicalPath(folder, real, pathApi)].map(fold);
  return roots.some(root => target === root || target.startsWith(root + '/'));
}

/** Whether writing `path` would land in sleight's settings folder (~/Library/Application Support/sleight), after links:
 *  the file's own real path when it exists, else its nearest existing folder's real path with the rest appended. A file
 *  with another hard link could be a settings file under a second name, so it counts as inside. This is a courtesy check
 *  before a long recording; writeOutsideSettings is the one that holds. */
export function insideSettings(path, { home = homeFolder(), real = realpathSync.native, stat = lstatSync, platform = process.platform,
  pathApi = platform === 'win32' ? win32 : undefined } = {}) {
  if (typeof path !== 'string' || !path || !home) return true;
  try {
    try { if (stat(path).nlink > 1) return true; } catch (error) { if (error?.code !== 'ENOENT') return true; }
    return underSettings(canonicalPath(path, real, pathApi), home, real, platform, pathApi);
  } catch { return true; }
}

const outsideRefusal = () => Object.assign(Error("record doesn't write into sleight's settings folder; pick another output path"), { code: 'SETTINGS_OUT' });
/** Write `text` to `path` unless it lands in sleight's settings folder, with nothing checked ahead of the write. The process
 *  changes into path's folder first: its working folder then holds that folder's inode, so a parent swapped for a link
 *  afterwards (`between`, a test seam) can't redirect the write. The folder's real location is read from that inode and
 *  checked, the file is opened relative to it without following a link, and a file with another hard link is refused
 *  before anything is truncated. exclusive adds O_EXCL. Throws an Error with code SETTINGS_OUT on a refusal. */
export function writeOutsideSettings(path, text, { home = homeFolder(), exclusive = false, mode = 0o644, between = () => {}, platform = process.platform } = {}) {
  // The held-working-directory/O_NOFOLLOW proof is POSIX-only. A Windows writer needs held handles and reparse checks.
  if (platform === 'win32') throw outsideRefusal();
  if (typeof path !== 'string' || !path || !home) throw outsideRefusal();
  const name = basename(path);
  if (!name || name === '.' || name === '..' || path.endsWith('/')) throw outsideRefusal();
  const previous = process.cwd();
  process.chdir(dirname(resolve(path)));
  try {
    between();
    const here = realpathSync.native('.'), held = statSync('.'), named = statSync(here);
    if (held.dev !== named.dev || held.ino !== named.ino || underSettings(here, home, undefined, platform)) throw outsideRefusal();
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
    let fd;
    try { fd = openSync(name, O_WRONLY | O_CREAT | O_NOFOLLOW | (exclusive ? O_EXCL : 0), mode); }
    catch (error) {
      if (error?.code === 'ELOOP') throw Object.assign(Error("record doesn't write through a link at the output path; pick another output path"), { code: 'SETTINGS_OUT' });
      throw error;
    }
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.nlink > 1) throw outsideRefusal();
      ftruncateSync(fd, 0); writeFileSync(fd, text);
    } finally { closeSync(fd); }
  } finally { process.chdir(previous); }
}

// Claude Code sets these in every shell it starts, and a daemon started there inherits them. One more signal on top of the walk.
const AGENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/** undefined when the person may run args, else the refusal line. All must hold: stdin and stdout are terminals, the
 *  environment carries no agent marker, and the walk reaches a GUI terminal app through shells alone (a pseudo-terminal
 *  started from an agent's shell sits under the agent, and a multiplexer server sits under launchd, so both refuse). */
// freshMs: the session-age bar, 10 s by default. The launcher passes 0 for forms that only take access away or change looks,
// so a person stopping sleight from a terminal they just opened isn't held up.
export function settingsRefusal(args, { stdin = process.stdin, stdout = process.stdout, env = process.env, platform = process.platform,
  ancestors = options => walkAncestors({ ...options, platform }), freshMs = 10000 } = {}) {
  const command = settingsCommand(args);
  if (command === undefined) return undefined;
  try {
    if (stdin?.isTTY !== true || stdout?.isTTY !== true) return refusalLine(command, 'no terminal');
    if (AGENT_ENV.some(name => env?.[name])) return refusalLine(command, 'agent');
    const walked = ancestors({ freshMs });
    if (walked?.ok !== true) return refusalLine(command, walked?.reason);
  } catch { return refusalLine(command); }
  return undefined;
}

// A first Windows call may need to build WIN5's helper. Keep that asynchronous build outside the synchronous walk.
// macOS retains its existing walk and performs no new imports, builds or process reads here.
export async function settingsRefusalAsync(args, { platform = process.platform, stdin = process.stdin, stdout = process.stdout,
  env = process.env, stderr = process.stderr, prepare = options => getPlatform(platform).person.prepareGate(options), ...options } = {}) {
  // These exact forms only remove access. Run the walk when available, with no session-age delay.
  const removal = args.length === 2 && args[0] === 'hand' && args[1] === 'off' ||
    args[0] === 'turbo' && (args.length === 2 && args[1] === 'off' ||
    args.length === 4 && args[1] === 'app' && args[2] === 'off') ||
    args[0] === 'permissions' && args.length === 3 && ['block', 'revoke'].includes(args[1]);
  if (platform === 'win32' && removal) options.freshMs = 0;
  if (platform === 'win32' && settingsCommand(args) !== undefined && stdin?.isTTY === true && stdout?.isTTY === true &&
      !AGENT_ENV.some(name => env?.[name]) && !options.ancestors) {
    let host;
    try { host = await prepare({ platform }); } catch {}
    if (host?.status !== 'ready') {
      if (!removal || host?.status !== 'unavailable' || host.code !== 'WINDOWS_COMPILER_MISSING') return refusalLine(settingsCommand(args));
      // A missing compiler/helper must not prevent a person from withdrawing access.
      // Unknown failures and ACL/package-integrity failures retain the ordinary refusal.
      // Reuse the terminal and marker checks; never replace a completed refusing walk.
      const refusal = settingsRefusal(args, { ...options, platform, stdin, stdout, env, ancestors: () => ({ ok: true }) });
      if (!refusal) stderr.write("sleight: could not verify the terminal's ancestry; this form only removes access, so it ran on the terminal and agent-marker checks.\n");
      return refusal;
    }
  }
  return settingsRefusal(args, { ...options, platform, stdin, stdout, env });
}
