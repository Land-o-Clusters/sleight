// Model-free page watches use routine scheduling and locks, with a closed read-only query.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RoutineStore, schedulePlan, ordinary, intervalSeconds } from './routines.mjs';
import { watchQuery, readWatch } from './watch-read.mjs';
import { notification } from './notification.mjs';
import { transcriptPath } from './replay.mjs';
import { terminalConfirm } from './terminal-confirm.mjs';
import { randomUUID } from 'node:crypto';
import { processStartTime } from './routine-lock.mjs';
import { claimWatchNotice, queueWatchNotice, retireWatch, sweepRetiredWatches, withWatchLifecycle } from './routine-launcher.mjs';

export function watchPlan(query, every, options = {}) {
  return schedulePlan(watchQuery(query), every, { ...options, kind: 'watch' });
}
const readJSON = path => JSON.parse(readFileSync(ordinary(path), 'utf8'));
function save(path, value) {
  ordinary(path);
  const temporary = ordinary(path + '.' + randomUUID() + '.tmp');
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temporary, path);
  } finally { if (created) rmSync(temporary, { force: true }); }
}
const safeError = error => /^WATCH_[A-Z_]+$/.test(error?.message) ? error.message : 'WATCH_READ_FAILED';
const notifyWatch = ({ id, status }) => notification(`sleight watch ${id}`, status);
const validBinding = value => value && Object.keys(value).sort().join(',') === 'browser,incarnation,target' &&
  Object.values(value).every(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(item));
const noteFor = (id, state) => `Watch ${id}: ${state.matched ? 'matching' : 'not matching'} main-document accessibility names at ${state.at}.`;
const isoTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const pauseNotice = error => ({
  WATCH_PROTECTED_FIELDS: 'Watch refused: the page has password or protected fields. Account pages need the user present; unattended account watching is unsupported.',
  WATCH_PUBLIC_HOST_REQUIRED: 'Watch refused: the page or an embedded origin was not marked public at creation, or an embedded document cannot be checked. Account pages need the user present; reinstall only for a public page.',
  WATCH_NEEDS_ONE_EXISTING_TAB: 'Watch needs one existing tab at its saved URL. Three consecutive missing-tab results remove the watch.',
  WATCH_INSTALL_MISSING: 'Watch paused: the current sleight plugin install is unavailable. Check the installation, then use watch run-now.',
})[error] ?? `Watch paused (${error}); check the page and use watch run-now.`;

export class WatchStore extends RoutineStore {
  constructor({ read = readWatch, notify = notifyWatch, now = Date.now, boot = () => processStartTime(1),
    confirm = word => terminalConfirm(word === 'install' ? 'install-public-watch' : word), ...options } = {}) {
    super({ ...options, confirm, notify });
    this.kind = 'watch';
    this.root = join(this.home, 'Library/Application Support/sleight/watches');
    this.read = read;
    this.now = now;
    this.boot = boot;
  }
  plan(query, every) { return watchPlan(query, every, this); }
  approve(query) { watchQuery(query); }
  metadata(query, plan, { expires = '7d' } = {}) {
    const boot = this.boot(), created = this.now();
    if (typeof boot !== 'string' || !boot) throw Error('WATCH_BOOT_UNAVAILABLE');
    return { seconds: plan.seconds, publicOrigin: new URL(query.url).origin, boot,
      created: new Date(created).toISOString(), expires: new Date(created + intervalSeconds(expires) * 1000).toISOString() };
  }
  async install(plan, query, options) {
    ordinary(this.root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = this.lock(this.root, 'install');
    if (!lock) throw Error('watch install busy; try again after the other installer finishes');
    try {
      await this.sweep();
      return await withWatchLifecycle(this.home, plan.id, async () => {
        if (existsSync(this.retirementPath(plan.id))) throw Error('watch removal is unconfirmed; use run-now to retry bootout before reinstalling');
        this.checkCapacity();
        return super.install(plan, query, options);
      });
    } finally { lock.release(); }
  }
  checkCapacity() {
    if (this.list().filter(row => !row.corrupt && !row.retired).length >= 5)
      throw Error('watch limit is 5; remove an installed watch first');
  }
  sweep() { return sweepRetiredWatches(this); }
  async add(query, every, { print = () => {}, expires = '7d' } = {}) {
    intervalSeconds(expires);
    await this.sweep();
    this.checkCapacity();
    const existed = existsSync(ordinary(this.plan(query, every).directory));
    const plan = await super.add(query, every, { expires, print: text => print(
      `Read-only watch of ${JSON.stringify(query.url)}; find ${JSON.stringify(query.find)}.\n` +
      `Only public pages. Installing marks ${new URL(query.url).origin} public for this watch, for ${expires}.\n` +
      'Account pages need the user present; unattended account watching is unsupported. Password or protected fields refuse the whole page.\n' +
      'Keep the existing tab open; checks never reload it. Scheduled ticks show no connection window.\n' + text) });
    // super.add returns the plan on a declined preview too. Never observe before terminal installation.
    if (!existed && existsSync(plan.directory)) {
      const result = await this.run(plan.id);
      print(JSON.stringify({ id: plan.id, ...result }));
      return { ...plan, initial: result };
    }
    return plan;
  }
  list(id) {
    if (id !== undefined) return [this.load(id)];
    ordinary(this.root);
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).flatMap(file => {
      const retired = /^\.retiring-([a-f0-9]{20})\.json$/.exec(file)?.[1];
      if (retired) {
        let error;
        try { error = readJSON(this.retirementPath(retired))?.error; } catch { /* Still show and sweep damaged records. */ }
        error = /^WATCH_[A-Z_]+$/.test(error) ? error : 'WATCH_REMOVED';
        return [{ id: retired, retired: true, status: `retired (${error})` }];
      }
      if (!/^[a-f0-9]{20}$/.test(file) || existsSync(this.retirementPath(file))) return [];
      try { return [this.load(file)]; }
      catch { return [{ id: file, corrupt: true, status: 'corrupt' }]; }
    });
  }
  async listings() {
    const rows = this.list().map(({ id, seconds, paused, script, created, expires, corrupt, retired, status }) =>
      corrupt || retired ? { id, status } : ({ id, seconds, paused,
      origin: new URL(script.url).origin, find: script.find,
      ageSeconds: isoTime(created) ? Math.max(0, Math.floor((this.now() - Date.parse(created)) / 1000)) : null,
      expires: isoTime(expires) ? expires : null }));
    // Report the retirement reason once even when this list request completes the sweep.
    await this.sweep();
    return rows;
  }
  async notice(id, error) {
    const directory = this.paths(id).directory, pending = ordinary(join(directory, 'notice-pending.json'));
    try {
      if (error) queueWatchNotice(directory, error);
      if (!existsSync(pending)) return false;
      const code = safeError(Error(readJSON(pending).error));
      if (claimWatchNotice(directory, this.now())) {
        await this.notify({ id, status: pauseNotice(code) });
        rmSync(pending, { force: true });
      }
      return false;
    } catch { return true; }
  }
  retirementPath(id) { return ordinary(join(this.root, `.retiring-${this.paths(id).id}.json`)); }
  async retire(id, result) {
    return retireWatch(id, { home: this.home, result, launchctl: this.launchctl, now: this.now,
      notify: status => this.notify({ id, status }) });
  }
  notes() {
    return this.list().filter(row => !row.corrupt && !row.retired).flatMap(({ id, directory, paused }) => {
      const file = ordinary(join(directory, 'state.json'));
      if (!existsSync(file)) return [];
      const state = readJSON(file);
      return typeof state.matched === 'boolean' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.at)
        ? [{ id, paused, note: noteFor(id, state) }] : [];
    });
  }
  async run(id, { scheduled = false } = {}) {
    const paths = this.paths(id), paused = ordinary(join(paths.directory, 'paused.json'));
    const retiring = this.retirementPath(id);
    const wasRetiring = existsSync(retiring);
    await this.sweep();
    if (existsSync(retiring)) return { ok: false, error: 'WATCH_REMOVAL_UNCONFIRMED', installationRemoved: true, removed: false };
    if (wasRetiring) return { ok: false, removed: true };
    if (!existsSync(paths.directory)) return { ok: false, error: 'WATCH_NOT_FOUND' };
    const lock = this.lock(paths.directory, id);
    if (!lock) return { ok: false, busy: true };
    let collected = true;
    try {
      let result;
      try {
        const plan = this.load(id), statePath = ordinary(join(plan.directory, 'state.json'));
        if (plan.publicOrigin !== new URL(plan.script.url).origin) throw Error('WATCH_PUBLIC_HOST_REQUIRED');
        if (!isoTime(plan.created) || !isoTime(plan.expires) || Date.parse(plan.expires) <= Date.parse(plan.created) ||
            Date.parse(plan.expires) - Date.parse(plan.created) > 31 * 86400000) throw Error('WATCH_EXPIRY_INVALID');
        if (this.now() >= Date.parse(plan.expires)) return await this.retire(id, { ok: false, error: 'WATCH_EXPIRED' });
        const boot = this.boot();
        if (!boot || !plan.boot) throw Error('WATCH_BOOT_UNAVAILABLE');
        if (boot !== plan.boot) return await this.retire(id, { ok: false, error: 'WATCH_REBOOTED' });
        if (scheduled && existsSync(paused)) {
          await this.notice(id);
          return { ok: false, paused: true };
        }
        const before = existsSync(statePath) ? readJSON(statePath) : undefined;
        if (before && (typeof before.matched !== 'boolean' || !validBinding(before.binding) ||
            before.pending && (typeof before.pending.matched !== 'boolean' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(before.pending.at))))
          throw Error('WATCH_STATE_INVALID');
        let observed;
        try { observed = await this.read(plan.script, before?.binding, { publicOrigin: plan.publicOrigin }); }
        catch (error) {
          if (error.message !== 'WATCH_TARGET_CHANGED' || error.cleanupUnconfirmed) throw error;
          // Re-run the complete install-time identity, unique URL, origin and permission checks.
          observed = await this.read(plan.script, undefined, { publicOrigin: plan.publicOrigin });
        }
        if (typeof observed?.matched !== 'boolean' || !validBinding(observed.binding)) throw Error('WATCH_READ_INCOMPLETE');
        const changed = before !== undefined && before.matched !== observed.matched;
        const at = new Date(this.now()).toISOString();
        // Coalesce against the last delivered state, so A -> B -> A has no net notice.
        const announced = typeof before?.announced === 'boolean' ? before.announced : before?.matched ?? observed.matched;
        const state = { matched: observed.matched, binding: observed.binding, at,
          announced, pending: observed.matched !== announced
            ? before?.pending?.matched === observed.matched ? before.pending : { matched: observed.matched, at } : null };
        save(statePath, state);
        save(join(plan.directory, 'health.json'), { missingTabs: 0 });
        rmSync(ordinary(join(plan.directory, 'notice-pending.json')), { force: true });
        let notificationError = false;
        if (state.pending) {
          try {
            if (claimWatchNotice(plan.directory, this.now())) {
              await this.notify({ id, status: `Condition changed: ${state.pending.matched ? 'matching' : 'not matching'} main-document accessibility names (${state.pending.at}).` });
              save(statePath, { ...state, announced: observed.matched, pending: null });
            }
          } catch { notificationError = true; }
        }
        result = { ok: true, matched: observed.matched, baseline: !before, changed, notificationError };
        rmSync(paused, { force: true });
      } catch (error) {
        collected = !error.cleanupUnconfirmed;
        result = { ok: false, error: safeError(error), ...(collected ? {} : { cleanupUnconfirmed: true }) };
        const healthPath = ordinary(join(paths.directory, 'health.json'));
        const health = existsSync(healthPath) ? readJSON(healthPath) : {};
        const missingTabs = ['WATCH_NEEDS_ONE_EXISTING_TAB', 'WATCH_TARGET_CHANGED'].includes(result.error) && collected
          ? (Number.isSafeInteger(health.missingTabs) && health.missingTabs >= 0 ? health.missingTabs : 0) + 1 : 0;
        save(healthPath, { missingTabs });
        if (missingTabs) result.missingTabs = missingTabs;
        if (missingTabs >= 3) return await this.retire(id, result);
        if (!missingTabs) save(paused, result);
      }
      if (!result.ok) await this.notice(id, result.error);
      await this.receipt(id, result);
      return result;
    } finally { if (collected) lock.release(); else lock.preserve(); }
  }
}

// Record only the last successful demonstrated browser_read.find and its explicitly opened URL.
// Returned page text never chooses a URL, a predicate, a command or an approval.
export function recordWatchRead(entries) {
  const calls = new Map(), tabs = new Map();
  let query;
  for (const entry of entries) for (const block of Array.isArray(entry?.message?.content) ? entry.message.content : []) {
    if (block?.type === 'tool_use' && /^mcp__.*__browser_(open|read)$/.test(block.name ?? '')) {
      calls.set(block.id, { name: block.name, input: block.input });
    } else if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
      const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
      if (block.is_error || !call.input) continue;
      if (call.name.endsWith('__browser_open')) {
        const content = typeof block.content === 'string' ? block.content
          : block.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
        const tab = /^(t[A-Za-z0-9_-]{1,64})\s/.exec(content ?? '')?.[1];
        if (tab) tabs.set(call.name.replace(/browser_open$/, '') + tab, call.input.url);
      } else {
        const url = tabs.get(call.name.replace(/browser_read$/, '') + call.input.tab);
        if (url && typeof call.input.find === 'string' && call.input.ref === undefined)
          query = watchQuery({ sleightWatch: 1, url, find: call.input.find });
      }
    }
  }
  if (!query) throw Error('watch record needs a successful browser_open then browser_read with find and no ref in that transcript');
  return query;
}

export async function watchCommand(args, { store = new WatchStore(), print = console.log } = {}) {
  const [operation, value, ...options] = args;
  if (operation === 'list' && !value) {
    print(JSON.stringify(await store.listings(), null, 2)); return 0;
  }
  if (operation === 'notes' && !value) { print(JSON.stringify(store.notes())); return 0; }
  if (['remove', 'unlock'].includes(operation) && value && !options.length) { await store[operation](value, { print }); return 0; }
  if (operation === 'run-now' && value && (options.length === 0 || options.length === 1 && options[0] === '--scheduled')) {
    const result = await store.run(value, { scheduled: options.length === 1 }); print(JSON.stringify(result)); return result.ok ? 0 : 1;
  }
  const lifetime = values => values.length === 2 && values[0] === '--expires' ? values[1] : undefined;
  if (operation === 'record' && value && options[0] === '--every' &&
      (options.length === 2 || options.length === 4 && lifetime(options.slice(2)))) {
    const entries = readFileSync(transcriptPath(value), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const plan = await store.add(recordWatchRead(entries), options[1], { print, expires: lifetime(options.slice(2)) }); return plan?.initial?.ok === false ? 1 : 0;
  }
  if ((args.length === 5 || args.length === 7 && lifetime(args.slice(5))) && args[1] === '--find' && args[3] === '--every') {
    if (/[\u0000-\u0020\u007f]/.test(operation)) throw Error('watch URL must not contain whitespace or control characters');
    const url = new URL(operation).href;
    const plan = await store.add(watchQuery({ sleightWatch: 1, url, find: args[2] }), args[4], { print, expires: lifetime(args.slice(5)) }); return plan?.initial?.ok === false ? 1 : 0;
  }
  throw Error('usage: sleight-mcp watch <url> --find <text> --every <interval> [--expires <duration>]; watch record <transcript> --every <interval> [--expires <duration>]; watch list|notes|run-now|remove|unlock');
}
