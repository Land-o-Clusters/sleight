// Model-free page watches use routine scheduling and locks, with a closed read-only query.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RoutineStore, schedulePlan, ordinary } from './routines.mjs';
import { watchQuery, readWatch } from './watch-read.mjs';
import { notification } from './notification.mjs';
import { transcriptPath } from './replay.mjs';
import { terminalConfirm } from './terminal-confirm.mjs';
import { randomUUID } from 'node:crypto';

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

export class WatchStore extends RoutineStore {
  constructor({ read = readWatch, notify = notifyWatch,
    confirm = word => terminalConfirm(word === 'install' ? 'install-public-watch' : word), ...options } = {}) {
    super({ ...options, confirm, notify });
    this.kind = 'watch';
    this.root = join(this.home, 'Library/Application Support/sleight/watches');
    this.read = read;
  }
  plan(query, every) { return watchPlan(query, every, this); }
  approve(query) { watchQuery(query); }
  async add(query, every, { print = () => {} } = {}) {
    const existed = existsSync(ordinary(this.plan(query, every).directory));
    const plan = await super.add(query, every, { print: text => print(
      `Read-only watch of ${JSON.stringify(query.url)}; find ${JSON.stringify(query.find)}.\n` +
      'Only public pages. Account pages need the owner watching. Keep the existing tab open; checks never reload it.\n' + text) });
    // super.add returns the plan on a declined preview too. Never observe before terminal installation.
    if (!existed && existsSync(plan.directory)) {
      const result = await this.run(plan.id);
      print(JSON.stringify({ id: plan.id, ...result }));
      return { ...plan, initial: result };
    }
    return plan;
  }
  notes() {
    return this.list().flatMap(({ id, directory, paused }) => {
      const file = ordinary(join(directory, 'state.json'));
      if (!existsSync(file)) return [];
      const state = readJSON(file);
      return typeof state.matched === 'boolean' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.at)
        ? [{ id, paused, note: noteFor(id, state) }] : [];
    });
  }
  async run(id, { scheduled = false } = {}) {
    const paths = this.paths(id), paused = ordinary(join(paths.directory, 'paused.json'));
    if (scheduled && existsSync(paused)) return { ok: false, paused: true };
    const lock = this.lock(paths.directory, id);
    if (!lock) return { ok: false, busy: true };
    let collected = true;
    try {
      let result;
      try {
        const plan = this.load(id), statePath = ordinary(join(plan.directory, 'state.json'));
        const before = existsSync(statePath) ? readJSON(statePath) : undefined;
        if (before && (typeof before.matched !== 'boolean' || !validBinding(before.binding) ||
            before.pending && (typeof before.pending.matched !== 'boolean' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(before.pending.at))))
          throw Error('WATCH_STATE_INVALID');
        const observed = await this.read(plan.script, before?.binding);
        if (typeof observed?.matched !== 'boolean' || !validBinding(observed.binding)) throw Error('WATCH_READ_INCOMPLETE');
        const changed = before !== undefined && before.matched !== observed.matched;
        const at = new Date().toISOString();
        // Retain a pending change until delivery succeeds. No page text enters notes, logs or notifications.
        const state = { matched: observed.matched, binding: observed.binding, at,
          pending: changed ? { matched: observed.matched, at } : before?.pending ?? null };
        save(statePath, state);
        let notificationError = false;
        if (state.pending) {
          try {
            await this.notify({ id, status: `Condition changed: ${state.pending.matched ? 'matching' : 'not matching'} main-document accessibility names (${state.pending.at}).` });
            save(statePath, { ...state, pending: null });
          } catch { notificationError = true; }
        }
        result = { ok: true, matched: observed.matched, baseline: !before, changed, notificationError };
        rmSync(paused, { force: true });
      } catch (error) {
        collected = !error.cleanupUnconfirmed;
        result = { ok: false, error: safeError(error), ...(collected ? {} : { cleanupUnconfirmed: true }) };
        save(paused, result);
      }
      await this.receipt(id, result, { notify: !result.ok, status: 'Watch paused; read its log and run-now after checking the page.' });
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
    print(JSON.stringify(store.list().map(({ id, seconds, paused }) => ({ id, seconds, paused })), null, 2)); return 0;
  }
  if (operation === 'notes' && !value) { print(JSON.stringify(store.notes())); return 0; }
  if (['remove', 'unlock'].includes(operation) && value && !options.length) { await store[operation](value, { print }); return 0; }
  if (operation === 'run-now' && value && (options.length === 0 || options.length === 1 && options[0] === '--scheduled')) {
    const result = await store.run(value, { scheduled: options.length === 1 }); print(JSON.stringify(result)); return result.ok ? 0 : 1;
  }
  if (operation === 'record' && value && options.length === 2 && options[0] === '--every') {
    const entries = readFileSync(transcriptPath(value), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const plan = await store.add(recordWatchRead(entries), options[1], { print }); return plan?.initial?.ok === false ? 1 : 0;
  }
  if (args.length === 5 && args[1] === '--find' && args[3] === '--every') {
    if (/[\u0000-\u0020\u007f]/.test(operation)) throw Error('watch URL must not contain whitespace or control characters');
    const url = new URL(operation).href;
    const plan = await store.add(watchQuery({ sleightWatch: 1, url, find: args[2] }), args[4], { print }); return plan?.initial?.ok === false ? 1 : 0;
  }
  throw Error('usage: sleight-mcp watch <url> --find <text> --every <interval>; watch record <transcript> --every <interval>; watch list|notes|run-now|remove|unlock');
}
