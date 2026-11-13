// WIN5. Native observations are data, not authority supplied by an environment variable.
import { win32 as path } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { win32Paths } from './paths.mjs';

const failure = reason => ({ ok: false, reason });
const image = value => {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || /[\x00-\x1f/]/.test(value) || path.normalize(value) !== value) return;
  return value.toLowerCase();
};
const pidOk = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const birthOk = value => typeof value === 'string' && /^[1-9][0-9]{15,18}$/.test(value);
const under = (file, root) => file.startsWith(root + '\\');
function kind(file, roots) {
  const name = path.basename(file);
  if (/^(claude|codex|chatgpt)(?:[.-].*)?\.exe$/.test(name) || /\\(?:claude-code|@anthropic-ai|@openai|chatgpt|codex)\\/.test(file)) return 'agent';
  if (/^(?:tmux|screen|zellij|abduco|dtach|wezterm-mux-server|wsl|bash|mintty|sshd|warp|conemu(?:64)?|cmder)\.exe$/.test(name)) return 'multiplexer';
  if (/^(?:code|cursor)(?:[ -].*)?\.exe$/.test(name) || /\\(?:microsoft vs code|cursor)\\/.test(file)) return 'editor';
  const system = roots.system32;
  if (file === system + '\\cmd.exe' || file === system + '\\windowspowershell\\v1.0\\powershell.exe') return 'shell';
  if (file === system + '\\conhost.exe') return 'console';
  if (file === system + '\\svchost.exe') return 'activation';
  if (file === roots.programFiles + '\\powershell\\7\\pwsh.exe') return 'admin-shell';
  const apps = roots.programFiles + '\\windowsapps';
  if (under(file, apps)) {
    const relative = file.slice(apps.length + 1);
    if (/^microsoft\.windowsterminal(?:preview)?_[0-9.]+_(?:x64|x86|arm64)__8wekyb3d8bbwe\\windowsterminal\.exe$/.test(relative)) return 'terminal';
    if (/^microsoft\.windowsterminal(?:preview)?_[0-9.]+_(?:x64|x86|arm64)__8wekyb3d8bbwe\\openconsole\.exe$/.test(relative)) return 'console';
    if (/^microsoft\.powershell(?:preview)?_[0-9.]+_(?:x64|x86|arm64)__8wekyb3d8bbwe\\pwsh\.exe$/.test(relative)) return 'shell';
  }
  if (file === path.dirname(system) + '\\explorer.exe') return 'desktop';
  return 'unknown';
}

/** Evaluate one native snapshot. Births are exact FILETIME strings: JSON numbers lose PID-incarnation precision.
 * Rows have birth reads before and after Toolhelp and held-handle user/session proof, except the session-zero activation boundary.
 * A console host is often a sibling, so it is bound independently through AttachConsole(self), GetConsoleWindow and
 * GetConsoleProcessList. Unknown ConPTY topologies refuse until the VM matrix proves them. */
export function evaluateWindowsAncestors(table, { self = process.pid, pid = process.ppid, freshMs = 10000, levels = 32 } = {}) {
  try {
    if (!pidOk(self) || !pidOk(pid) || !Number.isFinite(freshMs) || freshMs < 0 || !Number.isInteger(levels) || levels < 1 || levels > 64) return failure('unreadable');
    if (table?.schema !== 'sleight.person-snapshot/1' || table.self !== self || !Array.isArray(table.rows) || table.rows.length > 66 ||
        !Number.isSafeInteger(table.session) || table.session < 1 || typeof table.sid !== 'string' || !/^S-1-5-\d+(?:-\d+)+$/.test(table.sid) ||
        !birthOk(table.now)) return failure('unreadable');
    const roots = { system32: image(table.system32), programFiles: image(table.programFiles) };
    if (!roots.system32 || !roots.programFiles || path.basename(roots.system32) !== 'system32') return failure('unreadable');
    const rows = new Map();
    for (const row of table.rows) {
      if (!pidOk(row?.pid) || !Number.isInteger(row.parent) || row.parent < 0 || row.parent > 0xffffffff || rows.has(row.pid) ||
          !birthOk(row.birth) || row.birth !== row.after || BigInt(row.birth) > BigInt(table.now) ||
          !image(row.image)) return failure('unreadable');
      const activation = kind(image(row.image), roots) === 'activation';
      if (activation ? !['S-1-5-18', null].includes(row.sid) || row.session !== 0 : row.sid !== table.sid || row.session !== table.session) return failure('unreadable');
      rows.set(row.pid, row);
    }
    const own = rows.get(self), console = rows.get(table.console?.pid);
    if (!own || own.parent !== pid || !console || kind(image(console.image), roots) !== 'console' ||
        !Array.isArray(table.console.members) || table.console.members.length > 256 ||
        table.console.members.some(p => !pidOk(p)) || new Set(table.console.members).size !== table.console.members.length ||
        !table.console.members.includes(self) || !table.console.members.includes(pid)) return failure('session');
    let child = own, shell, terminal = false;
    const seen = new Set([self]);
    for (let depth = 0; depth < levels; depth++) {
      if (seen.has(pid)) return failure('unreadable');
      seen.add(pid);
      const row = rows.get(pid);
      if (!row || BigInt(row.birth) > BigInt(child.birth)) return failure('unreadable');
      const type = kind(image(row.image), roots);
      if (type === 'agent') return failure('agent');
      if (type === 'multiplexer') return failure('multiplexer');
      if (type === 'editor' || type === 'unknown') return failure('unknown ancestor');
      if (type === 'admin-shell' && row.adminWritableOnly !== true) return failure('unreadable');
      if (type === 'shell' || type === 'admin-shell') {
        if (terminal) return failure('unknown ancestor');
        shell = row; // outermost shell is the console session's age bar
      } else if (type === 'terminal') terminal = true;
      else if (type === 'console') return failure('unknown ancestor'); // console evidence must be out of band
      else if (type === 'desktop' || type === 'activation') {
        if (type === 'activation' && kind(image(child.image), roots) !== 'terminal') return failure('unknown ancestor');
        if ([...rows.values()].some(observation => observation.sid === null && observation.pid !== row.pid)) return failure('unreadable');
        if (!shell || BigInt(console.birth) > BigInt(own.birth)) return failure('session');
        if (BigInt(table.now) - BigInt(shell.birth) < BigInt(Math.ceil(freshMs * 10000))) return failure('fresh session');
        return { ok: true };
      }
      child = row; pid = row.parent;
      if (!pid) return failure('no terminal app');
    }
    return failure('too deep');
  } catch { return failure('unreadable'); }
}

export function windowsPresent(observation) {
  return observation?.schema === 'sleight.person-presence/1' && observation.active === true && observation.unlocked === true &&
    Number.isSafeInteger(observation.idleMs) && observation.idleMs >= 0 && observation.idleMs < 120000;
}

let gateHost;
export async function prepareWindowsPerson({ platform = process.platform, prepare, run = spawn, sync = execFileSync, ...options } = {}) {
  if (platform !== 'win32') return { status: 'unavailable', code: 'PLATFORM' };
  try {
    const build = prepare ?? (async opts => (await import('../direct-browser/windows-host.mjs')).prepareWindowsHandHost(opts));
    const host = await build({ ...options, platform, kind: 'person', cacheRoot: options.cacheRoot ?? win32Paths().helperCache });
    if (host?.status !== 'ready' || typeof host.personCopy !== 'function') return host;
    const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' };
    const copy = host.personCopy(); // one checked copy for this launcher, including confirmation
    let disposed = false, prompted = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true; process.removeListener('exit', dispose);
      try { copy.cleanup(); } catch {} // a terminated process can leave a locked exe for the next prepare
    };
    process.once('exit', dispose);
    const runSync = (args, timeout) => {
      if (disposed) throw Error('PERSON_RUN_CLOSED');
      try {
        copy.verify(); // snapshot and presence must use the same verified bytes as confirmation
        return sync(copy.path, args, { timeout, maxBuffer: 131072, windowsHide: true, env,
          cwd: path.dirname(copy.path), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], killSignal: 'SIGKILL' });
      }
      catch (error) { dispose(); throw error; }
    };
    return {
      status: 'ready', dispose,
      snapshot: (self, timeout) => JSON.parse(runSync(['--person-snapshot', String(self)], timeout)),
      presence: () => windowsPresent(JSON.parse(runSync(['--person-presence'], 1500))),
      spawn(key, subject) {
        if (disposed || prompted) throw Error('PERSON_CONFIRM_ALREADY_ATTEMPTED');
        prompted = true;
        try {
          copy.verify(); // narrow the same-user replacement window immediately before confirmation
          const child = run(copy.path, ['--confirm-person', key, ...subject === undefined ? [] : [subject]], {
            windowsHide: true, cwd: path.dirname(copy.path), stdio: ['ignore', 'pipe', 'ignore'], env });
          child.sleightExpected = { path: copy.path, sha256: copy.sha256 };
          let cleaned = false;
          const stop = () => { try { child.kill('SIGTERM'); } catch {} };
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) process.removeListener(signal, stop);
            dispose();
          };
          for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) process.once(signal, stop);
          child.once('close', cleanup); child.once('error', cleanup);
          return child;
        } catch (error) { dispose(); throw error; }
      },
    };
  } catch { return { status: 'unavailable', code: 'PERSON_HELPER_UNAVAILABLE' }; }
}
export async function prepareWindowsGate(options) {
  gateHost?.dispose?.();
  gateHost = await prepareWindowsPerson(options);
  return gateHost;
}
export async function prepareWindowsConfirmation(options) {
  return gateHost ?? prepareWindowsGate(options);
}
export function walkWindowsAncestors({ self = process.pid, pid = process.ppid, snapshot = gateHost?.snapshot,
  now = Date.now, budgetMs = 10000, ...options } = {}) {
  const start = now();
  if (typeof snapshot !== 'function') return failure('check failed');
  try {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) return failure('timeout');
    const table = snapshot(self, budgetMs);
    if (now() - start > budgetMs) return failure('timeout');
    return evaluateWindowsAncestors(table, { ...options, self, pid });
  } catch (error) { return failure(error?.code === 'ETIMEDOUT' ? 'timeout' : 'check failed'); }
}
export async function windowsPersonPresence() {
  try { return gateHost?.status === 'ready' && gateHost.presence() === true; } catch { return false; }
}
