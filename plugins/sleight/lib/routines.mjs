// Unattended replay accepts only literal app calls. No eval, prompts, global input or model.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, lstatSync, renameSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreapproved } from './preapproved.mjs';
import { replay, relayServer } from './replay.mjs';
import { createDemoHelper, sessionIdleSeconds } from './demonstration.mjs';
import { terminalConfirm } from './terminal-confirm.mjs';
import { acquireRoutineLock, clearRoutineLock, processStartTime, aliveProcess, sameProcessStart } from './routine-lock.mjs';
import { notification as showNotification } from './notification.mjs';
import { windowFromText, windowMatches } from './document-scope.mjs';

const execute = promisify(execFile);
const LAUNCHER = fileURLToPath(new URL('./routine-launcher.mjs', import.meta.url));
const ID = /^[a-f0-9]{20}$/;
const SELECTORS = new Set(['id', 'label', 'line']);
const FORBIDDEN = /(?:terminal|iterm|ghostty|warp|alacritty|wezterm|chatgpt|codex|atlas|com\.openai)/i;

export function intervalSeconds(value) {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value);
  const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's']) : 0;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 2678400) throw new Error('interval must be whole seconds, minutes, hours or days, from 60s to 31d');
  return seconds;
}

// Claude writes object arguments as JavaScript, `{ id: "AllClear" }`, and so do the scripts `record`
// makes from its sessions, so no recorded script could become a routine (2026-10-10). Quote a bare
// key after { or , outside strings. Values must still be JSON literals.
function quoteKeys(text) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { out += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; out += c; continue; }
    out += c;
    if (c === '{' || c === ',') {
      const key = /^(\s*)([A-Za-z_$][\w$]*)(\s*:)/.exec(text.slice(i + 1));
      if (key) { out += `${key[1]}"${key[2]}"${key[3]}`; i += key[0].length; }
    }
  }
  return out;
}

// Consume a call's JSON arguments without mistaking punctuation inside strings for syntax.
function jsonCall(code, start) {
  let quoted = false, escaped = false, depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ')' && depth === 0) {
      return { args: JSON.parse(`[${quoteKeys(code.slice(start, i))}]`), end: i + 1 };
    }
  }
  throw new Error('routine call has incomplete JSON arguments');
}

function parseRoutine(script) {
  if (script?.sleightReplay !== 1 || !Array.isArray(script.steps) || !script.steps.length || script.allowPositions) throw new Error('routine needs a nonempty replay script without allowPositions');
  const handles = new Map();
  const steps = [];
  for (const [index, step] of script.steps.entries()) {
    try { parseStep(step); } catch (error) { throw new Error(`routine step ${index + 1}: ${error.message}`); }
  }
  function parseStep(step) {
    if (step?.tool !== 'js' || typeof step.args?.code !== 'string' || (step.positions?.length ?? 0)) throw new Error('routine refuses positional steps, drags and non-js tools');
    let code = step.args.code.trim();
    while (code) {
      const acquisition = /^(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\(/.exec(code);
      const action = /^await\s+([A-Za-z_$][\w$]*)\.(click|setValue|typeText|getAXState)\(/.exec(code);
      const match = acquisition ?? action;
      if (!match) throw new Error('routine permits only literal background app acquisition, click, setValue, typeText and getAXState calls');
      const { args, end } = jsonCall(code, match[0].length);
      if (acquisition) {
        if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].trim() || FORBIDDEN.test(args[0]) || handles.has(match[1])) throw new Error('routine app must be a literal native app name or bundle ID on a new handle; blocked apps are refused');
        handles.set(match[1], args[0]);
      } else {
        if (!handles.has(match[1])) throw new Error('routine action has no acquired app handle');
        const method = match[2], spec = args[0];
        const selector = spec && typeof spec === 'object' && !Array.isArray(spec) && Object.keys(spec).length === 1 &&
          SELECTORS.has(Object.keys(spec)[0]) && typeof Object.values(spec)[0] === 'string' && Object.values(spec)[0].length;
        const valid = method === 'click' ? args.length === 1 && selector
          : method === 'setValue' ? args.length === 2 && selector && typeof args[1] === 'string'
          : method === 'typeText' ? args.length === 1 && typeof args[0] === 'string'
          : args.length === 0 || args.length === 1 && JSON.stringify(args[0]) === '{"disableDiffing":true}';
        if (!valid) throw new Error(`routine ${method} needs literal JSON arguments and an ID, label or line selector`);
      }
      steps.push({ tool: 'js', args: { code: code.slice(0, end) + ';', ...(step.args.title ? { title: step.args.title } : {}) }, positions: [] });
      code = code.slice(end).trimStart();
      if (code && !code.startsWith(';')) throw new Error('routine calls must be separated by semicolons');
      code = code.replace(/^;\s*/, '');
    }
  }
  return { apps: [...new Set(handles.values())], steps };
}
export function routineApps(script) { return parseRoutine(script).apps; }

export async function routineBeforeCall(name, args, call) {
  const handle = name === 'js' && /^await\s+([A-Za-z_$][\w$]*)\.(?:click|setValue|typeText)\(/.exec(args.code)?.[1];
  if (!handle) return;
  const snapshot = await call('js', { code: `await ${handle}.getAXState({ disableDiffing: true });`, title: 'Check unattended window before input' });
  const text = snapshot.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
  if (snapshot.error || snapshot.result?.isError || !/^Window:/m.test(text) ||
      /^\s*\d+\s+(?:(?:system|standard)\s+)?(?:dialog|sheet)\b|AX(?:SystemDialog|Dialog|Sheet)\b/im.test(text)) {
    throw new Error('routine stopped before input: window unavailable or an app dialog or sheet is present');
  }
  return text;
}

function windowInfo(window) {
  const info = window && typeof window === 'object' && !Array.isArray(window) ? window : undefined;
  if (typeof info?.title !== 'string') return;
  return { title: info.title, url: info.url || null };
}

export function routineGuard(apps, state) {
  const targets = new Map(), handles = new Map();
  const check = async (starting = false) => {
    const current = await state();
    if (!Number.isFinite(current.idleSeconds) || current.idleSeconds < 120) {
      throw Object.assign(new Error('routine stopped: user is active; two minutes idle required'), { idle: true, interrupted: !starting });
    }
    for (const name of apps) {
      const matches = current.apps.filter(app => app.bundle === name || app.name === name);
      if (matches.length !== 1 || matches[0].windows.length !== 1) throw new Error(`routine app ${JSON.stringify(name)} is not running with exactly one existing window`);
      const app = matches[0], window = windowInfo(app.windows[0]);
      if (!window) throw new Error(`routine app ${JSON.stringify(name)} window has no title`);
      const previous = targets.get(name);
      if (previous && (previous.pid !== app.pid || previous.title !== window.title || previous.url !== window.url)) {
        throw new Error('routine app or window changed; stopped before input');
      }
      const bound = { pid: app.pid, bundle: app.bundle, title: window.title, url: window.url };
      targets.set(name, bound);
      if (app.bundle) targets.set(app.bundle, bound);
      if (app.name) targets.set(app.name, bound);
    }
  };
  return {
    start: () => check(true),
    window() {
      const unique = [...new Set(targets.values())];
      return unique.length === 1 ? { title: unique[0].title, url: unique[0].url, app: unique[0].bundle } : undefined;
    },
    async beforeCall(name, args, call) {
      await check();
      const acquisition = name === 'js' && /^(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\(("(?:[^"\\]|\\.)*")\);$/.exec(args.code);
      if (acquisition) {
        const target = targets.get(JSON.parse(acquisition[2]));
        handles.set(acquisition[1], target);
        args.code = `let ${acquisition[1]} = await cua.getApp(${JSON.stringify(target.bundle)});`;
      }
      const text = await routineBeforeCall(name, args, call);
      if (text !== undefined) {
        const handle = /^await\s+([A-Za-z_$][\w$]*)\.(?:click|setValue|typeText)\(/.exec(args.code)[1];
        const unique = [...new Set(targets.values())];
        const expected = handles.get(handle) ?? (unique.length === 1 ? unique[0] : undefined);
        if (!windowMatches(expected, windowFromText(text))) throw new Error('routine stopped before input: window title or URL does not match');
      }
      await check();
    },
  };
}

const xml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function routinePlan(script, every, { home = userInfo().homedir, node = process.execPath } = {}) {
  routineApps(script);
  const seconds = intervalSeconds(every);
  const id = createHash('sha256').update(JSON.stringify({ script, seconds })).digest('hex').slice(0, 20);
  const directory = join(resolve(home), 'Library/Application Support/sleight/routines', id);
  const label = `com.landoclusters.sleight-routine-${id}`;
  const plistPath = join(resolve(home), 'Library/LaunchAgents', `${label}.plist`);
  const logPath = join(resolve(home), 'Library/Logs/sleight/routines', `${id}.jsonl`);
  const launcherPath = join(resolve(home), 'Library/Application Support/sleight/routine-launcher.mjs');
  const args = [resolve(node), launcherPath, id];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>StartInterval</key><integer>${seconds}</integer>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>StandardErrorPath</key><string>${xml(logPath + '.stderr')}</string>\n</dict></plist>\n`;
  return { id, seconds, directory, label, plistPath, logPath, launcherPath, plist };
}

// Existing symlinks in private storage are refused before any reads or writes.
function ordinary(path) {
  let at = resolve(path);
  while (dirname(at) !== at) {
    try { if (lstatSync(at).isSymbolicLink()) throw new Error('routine storage refuses symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    at = dirname(at);
  }
  return path;
}
function privateDir(path) { ordinary(path); mkdirSync(path, { recursive: true, mode: 0o700 }); }
const json = value => JSON.stringify(value) + '\n';

async function notification({ id, logPath, status = 'stopped' }) {
  await showNotification(`sleight routine ${id} ${status}`, `Read ${logPath}`);
}

export class RoutineStore {
  constructor({ home = userInfo().homedir, node = process.execPath, launchctl = args => execute('/bin/launchctl', args, { timeout: 10000 }),
    preapproved = loadPreapproved, replay: runReplay = replay, notify = notification, server = relayServer,
    confirm = terminalConfirm, host = createDemoHelper, idle = sessionIdleSeconds,
    started = processStartTime, alive = aliveProcess } = {}) {
    Object.assign(this, { home: resolve(home), node, launchctl, preapproved, runReplay, notify, server, confirm, host, idle, started, alive });
    this.root = join(this.home, 'Library/Application Support/sleight/routines');
  }
  load(id) {
    if (!ID.test(id)) throw new Error('invalid routine ID');
    const directory = ordinary(join(this.root, id));
    const saved = JSON.parse(readFileSync(ordinary(join(directory, 'routine.json')), 'utf8'));
    const script = JSON.parse(readFileSync(ordinary(join(directory, 'script.json')), 'utf8'));
    const plan = routinePlan(script, `${saved.seconds}s`, this);
    if (plan.id !== id) throw new Error('saved routine changed; remove it and add the reviewed script again');
    return { ...plan, script, paused: existsSync(join(directory, 'paused.json')) };
  }
  paths(id) {
    if (!ID.test(id)) throw new Error('invalid routine ID');
    const label = `com.landoclusters.sleight-routine-${id}`;
    return { id, label, directory: ordinary(join(this.root, id)),
      plistPath: ordinary(join(this.home, 'Library/LaunchAgents', `${label}.plist`)),
      logPath: join(this.home, 'Library/Logs/sleight/routines', `${id}.jsonl`) };
  }
  list(id) {
    if (id !== undefined) return [this.load(id)];
    ordinary(this.root);
    return existsSync(this.root) ? readdirSync(this.root).filter(id => ID.test(id)).map(id => this.load(id)) : [];
  }
  approve(script) {
    const grants = this.preapproved();
    for (const app of routineApps(script)) if (!grants.allows(app, 'medium')) throw new Error(`routine app ${JSON.stringify(app)} must be preapproved at medium risk in the user's fixed list`);
  }
  async add(script, every, { print = () => {} } = {}) {
    const plan = routinePlan(script, every, this);
    this.approve(script);
    print(`Install ${plan.label}\nScript: ${join(plan.directory, 'script.json')}\nLog: ${plan.logPath}\nLauncher: ${plan.launcherPath}\nPlist: ${plan.plistPath}\n${plan.plist}`);
    if (!await this.confirm('install')) return plan;
    ordinary(plan.directory); ordinary(plan.plistPath); ordinary(plan.logPath);
    if (existsSync(plan.directory) || existsSync(plan.plistPath)) throw new Error('routine already exists; remove it explicitly before reinstalling');
    privateDir(dirname(plan.directory)); privateDir(dirname(plan.plistPath)); privateDir(dirname(plan.logPath));
    mkdirSync(plan.directory, { mode: 0o700 });
    try {
      ordinary(plan.launcherPath);
      const temporary = ordinary(`${plan.launcherPath}.${process.pid}.tmp`);
      try {
        writeFileSync(temporary, readFileSync(LAUNCHER), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, plan.launcherPath);
      } finally { rmSync(temporary, { force: true }); }
      writeFileSync(join(plan.directory, 'script.json'), json(script), { flag: 'wx', mode: 0o600 });
      writeFileSync(join(plan.directory, 'routine.json'), json({ seconds: plan.seconds }), { flag: 'wx', mode: 0o600 });
      writeFileSync(plan.plistPath, plan.plist, { flag: 'wx', mode: 0o600 });
      await this.launchctl(['bootstrap', `gui/${process.getuid()}`, plan.plistPath]);
    } catch (error) {
      // A failed bootstrap cannot be assumed not to have registered the job. Preserve evidence
      // if bootout cannot confirm removal; never silently erase a possibly live job's script.
      try { await this.launchctl(['bootout', `gui/${process.getuid()}/${plan.label}`]); }
      catch (cleanup) { if (cleanup.code !== 3) throw new Error(`${error.message}; cleanup unconfirmed: ${cleanup.message}`); }
      rmSync(plan.plistPath, { force: true }); rmSync(plan.directory, { recursive: true, force: true });
      throw error;
    }
    return plan;
  }
  lock(directory, id) {
    const coordinator = ordinary(join(this.root, '.locks', `${id}.sqlite`));
    privateDir(dirname(coordinator));
    ordinary(join(directory, 'running/owner.json'));
    return acquireRoutineLock({ directory, coordinator, started: this.started, alive: this.alive });
  }
  async unlock(id, { print = () => {} } = {}) {
    const plan = this.paths(id);
    const file = ordinary(join(plan.directory, 'running/owner.json'));
    let owner;
    try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { owner = undefined; }
    if (owner && this.alive(owner.pid) && sameProcessStart(owner.startTime, this.started(owner.pid))) {
      throw new Error('routine is running; wait for it to finish');
    }
    print(`Clear leftover run lock for ${id}\nDelete ${join(plan.directory, 'running')}\nThe routine stays installed. Type unlock if the owning process cannot be matched.`);
    if (!await this.confirm('unlock')) return plan;
    const coordinator = ordinary(join(this.root, '.locks', `${id}.sqlite`));
    privateDir(dirname(coordinator));
    if (!clearRoutineLock({ directory: plan.directory, coordinator })) {
      throw new Error('routine lock is held; try again after the other process exits');
    }
    return plan;
  }
  async receipt(id, result, { notify = false, status = 'stopped' } = {}) {
    const logPath = ordinary(this.paths(id).logPath);
    privateDir(dirname(logPath));
    appendFileSync(logPath, json({ at: new Date().toISOString(), id, result }), { mode: 0o600 });
    if (notify) {
      try { await this.notify({ id, logPath, status }); }
      catch (error) { appendFileSync(logPath, json({ at: new Date().toISOString(), notificationError: error.message }), { mode: 0o600 }); }
    }
  }
  async remove(id, { print = () => {} } = {}) {
    const plan = this.paths(id);
    print(`Remove ${plan.label}\nUnload gui/${process.getuid()}/${plan.label}\nDelete ${plan.plistPath}\nDelete ${plan.directory}\nKeep ${plan.logPath}`);
    if (!await this.confirm('remove')) return plan;
    const lock = this.lock(plan.directory, id);
    if (!lock) throw new Error('routine is running; verify it stopped before removal');
    try {
      try { await this.launchctl(['bootout', `gui/${process.getuid()}/${plan.label}`]); }
      catch (error) { if (error.code !== 3) throw error; }
      rmSync(ordinary(plan.plistPath), { force: true }); rmSync(ordinary(plan.directory), { recursive: true });
    } finally { lock.release(); }
    return plan;
  }
  async run(id, { scheduled = false } = {}) {
    // Resolve trusted paths independently so edited scripts still get a logged stop.
    if (!ID.test(id)) throw new Error('invalid routine ID');
    const directory = ordinary(join(this.root, id));
    if (scheduled && existsSync(join(directory, 'paused.json'))) return { ok: false, paused: true };
    const lock = this.lock(directory, id);
    if (!lock) {
      const result = { ok: false, busy: true };
      await this.receipt(id, result, { notify: true, status: 'skipped: busy' });
      return result;
    }
    let collected = true, host;
    try {
      const logPath = ordinary(join(this.home, 'Library/Logs/sleight/routines', `${id}.jsonl`));
      let result;
      try {
        const plan = this.load(id);
        this.approve(plan.script);
        const safeScript = { ...plan.script, steps: parseRoutine(plan.script).steps };
        const idleSeconds = await this.idle();
        if (!Number.isFinite(idleSeconds) || idleSeconds < 120) {
          result = { ok: false, skipped: 'active' };
        } else {
          host = await this.host();
          const guard = routineGuard(routineApps(plan.script), () => host.state());
          await guard.start();
          result = await this.runReplay(safeScript, { server: () => {
            lock.noteLaunching();
            return this.server(undefined, { onSpawn: pid => lock.addGroup(pid) });
          },
            ask: async () => false, allowPositions: false, window: guard.window(), beforeCall: guard.beforeCall });
        }
      } catch (error) {
        collected = !error.cleanupUnconfirmed;
        result = error.idle ? { ok: false, skipped: 'active', interrupted: error.interrupted } : { ok: false, error: error.message, ...(collected ? {} : { cleanupUnconfirmed: true }) };
      }
      privateDir(dirname(logPath));
      // Keep task content and AX snapshots out of routine logs. The private saved script has them.
      const receipt = { ok: result.ok, skipped: result.skipped, steps: result.steps, step: result.step, error: result.error, waits: result.waits, cleanupUnconfirmed: result.cleanupUnconfirmed };
      appendFileSync(logPath, json({ at: new Date().toISOString(), id, result: receipt }), { mode: 0o600 });
      const paused = ordinary(join(directory, 'paused.json'));
      if (result.ok) rmSync(paused, { force: true });
      else if (result.skipped === 'active' && result.interrupted) {
        try { await this.notify({ id, logPath, status: 'skipped: active' }); }
        catch (error) { appendFileSync(logPath, json({ at: new Date().toISOString(), notificationError: error.message }), { mode: 0o600 }); }
      } else if (!result.skipped) {
        writeFileSync(paused, json(receipt), { mode: 0o600 });
        try { await this.notify({ id, logPath }); }
        catch (error) { appendFileSync(logPath, json({ at: new Date().toISOString(), notificationError: error.message }), { mode: 0o600 }); }
      }
      return result;
    } finally {
      try { await host?.close?.(); }
      finally { if (collected) lock.release(); else lock.preserve(); }
    }
  }
}

export async function routineCommand(args, { store = new RoutineStore(), print = console.log } = {}) {
  const [operation, value, ...options] = args;
  if (operation === 'list' && value === undefined) { print(JSON.stringify(store.list().map(({ id, seconds, paused }) => ({ id, seconds, paused })), null, 2)); return 0; }
  if (operation === 'add' && value) {
    const every = options.indexOf('--every');
    if (every < 0 || !options[every + 1] || options.length !== 2 || every !== 0) throw new Error('usage: routine add <script.json> --every <interval>');
    await store.add(JSON.parse(readFileSync(value, 'utf8')), options[every + 1], { print }); return 0;
  }
  if (['remove', '--remove'].includes(operation) && value && !options.length) { await store.remove(value, { print }); return 0; }
  if (operation === 'unlock' && value && !options.length) { await store.unlock(value, { print }); return 0; }
  if (operation === 'run-now' && value && options.every(v => v === '--scheduled')) {
    const result = await store.run(value, { scheduled: options.includes('--scheduled') }); print(JSON.stringify(result)); return result.ok ? 0 : 1;
  }
  throw new Error('usage: sleight-mcp routine add|list|remove|unlock|run-now; installation, removal and unlock ask in an interactive terminal');
}
