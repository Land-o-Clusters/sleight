import { tokens } from './flow-rules.mjs';
import { execFile } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Cooperative guard for native Copy/Cut/Paste shortcuts. Native app.paste already
// restores all readable formats and refuses a changed generation (live probe).
// Like the window guard, this shares the model's mutable JS realm.
export function installClipboardGuard(cua, io, notice = () => {}) {
  const key = Symbol.for('sleight.clipboard');
  if (cua[key]) return;
  const state = { getApp: cua.getApp.bind(cua), wrapped: new WeakMap(), busy: false, copy: undefined };
  Object.defineProperty(cua, key, { value: state, configurable: true });
  const transaction = async action => {
    if (state.busy) throw new Error('Clipboard guard: another clipboard action is pending.');
    state.busy = true;
    let acquired = false;
    try {
      await io({ op: 'acquire' }); acquired = true;
      return await action();
    } finally {
      try { if (acquired) await io({ op: 'release' }); }
      finally { state.busy = false; }
    }
  };
  const write = async (items, expectedCount, original) => {
    try { return await io({ op: 'write', expectedCount, items }); }
    catch (error) {
      if (error.clipboardMutation && error.clipboardCount === expectedCount + 1) {
        try { await io({ op: 'write', expectedCount: error.clipboardCount, items: original }); }
        catch (recovery) { throw new Error(error.message + '; original clipboard recovery also failed: ' + recovery.message); }
      }
      throw error;
    }
  };
  const wrap = raw => {
    if (state.wrapped.has(raw)) return state.wrapped.get(raw);
    const proxy = new Proxy(raw, { get(target, name) {
      const value = Reflect.get(target, name);
      if (name === 'paste' && typeof value === 'function') return (...args) => transaction(() => value.apply(target, args));
      if (name !== 'pressKey' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args) => {
        const [key] = args;
        const parts = typeof key === 'string' ? key.toLowerCase().split('+') : [];
        const command = parts.some(p => ['super', 'cmd', 'command', 'meta'].includes(p));
        const action = command && ['c', 'x', 'v'].includes(parts.at(-1)) ? parts.at(-1) : undefined;
        if (!action) return value.apply(target, args);
        return transaction(async () => {
          if (action === 'v' && !state.copy) return value.apply(target, args);
          let before;
          try { before = await io({ op: 'read' }); }
          catch (error) {
            state.copy = undefined;
            notice('Clipboard not preserved: ' + error.message + '. Running the native shortcut. Never modify the user\'s clipboard to get around this fallback.');
            return value.apply(target, args);
          }
          if (action === 'v') {
            const written = await write(state.copy, before.count, before.items);
            try { return await value.apply(target, args); }
            finally { await write(before.items, written.count, before.items); }
          }
          // On an engine failure, a changed clipboard cannot be attributed to
          // this shortcut. Leave it alone and surface the failure.
          const result = await value.apply(target, args);
          let after;
          try { after = await io({ op: 'read' }); }
          catch (error) {
            state.copy = undefined;
            if (error.clipboardCount === before.count + 1) {
              await write(before.items, error.clipboardCount, before.items);
            }
            throw error;
          }
          if (after.count === before.count) return result;
          if (after.count !== before.count + 1) throw new Error('Clipboard guard: ownership changed during Copy/Cut; current contents were left alone.');
          await write(before.items, after.count, before.items);
          state.copy = after.items;
          notice('Clipboard preservation: Copy/Cut is in sleight\'s private session clipboard only. The user\'s prior contents were restored. Menu Paste, pbpaste and browser pastes cannot use this copy. A copy intended for the user needs a session without SLEIGHT_CLIPBOARD=preserve.');
          return result;
        });
      };
    } });
    state.wrapped.set(raw, proxy);
    state.wrapped.set(proxy, proxy);
    return proxy;
  };
  cua.getApp = async (...args) => wrap(await state.getApp(...args));
}

// SQLite releases this reservation on process death. No stale lock stealing or
// waiting while another session has temporary clipboard data installed.
export function createClipboardCoordinator(DatabaseSync, path) {
  let db;
  return {
    acquire() {
      if (db) throw new Error('Clipboard guard: Clipboard busy in this session.');
      const candidate = new DatabaseSync(path);
      try { candidate.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
      catch (error) { candidate.close(); throw new Error('Clipboard guard: Clipboard busy or unavailable; retry after the other action ends. ' + error.message); }
      db = candidate;
    },
    release() {
      if (!db) return;
      const owned = db; db = undefined;
      try { owned.exec('ROLLBACK'); } finally { owned.close(); }
    },
  };
}

// The engine can read files but cannot write files, open SQLite or reach a
// loopback service. Keep byte IO and the session copy in the local relay.
export function createNativeClipboardIO(helper) {
  let coordinator;
  return async request => {
    if (request.op === 'acquire') {
      if (!coordinator) {
        const directory = join(homedir(), 'Library', 'Application Support', 'sleight');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        coordinator = createClipboardCoordinator(DatabaseSync, join(directory, 'clipboard.sqlite'));
      }
      coordinator.acquire();
      try { chmodSync(join(homedir(), 'Library', 'Application Support', 'sleight', 'clipboard.sqlite'), 0o600); }
      catch (error) { coordinator.release(); throw error; }
      return;
    }
    if (request.op === 'release') { coordinator?.release(); return; }
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', helper],
        { timeout: 10000, maxBuffer: 96 * 1024 * 1024 }, (error, stdout) => {
          if (error) { reject(new Error('Clipboard guard: helper failed: ' + error.message)); return; }
          try {
            const result = JSON.parse(stdout);
            if (!result.ok) throw Object.assign(new Error(result.error), { clipboardCount: result.count, clipboardMutation: result.mutated });
            resolve(result);
          } catch (error) { reject(error); }
        });
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(request));
    });
  };
}

export function createClipboardSession(io) {
  let dispatch, busy = false, closed = false, active, resetting = false, notices = [];
  const invoke = () => {
    if (closed || resetting) throw new Error('Clipboard: session closed or reset before input. Read the app again and retry.');
    return dispatch();
  };
  const cua = { getApp: async () => ({ pressKey: invoke, paste: invoke }) };
  installClipboardGuard(cua, io, message => notices.push(message));
  return { get pending() { return busy || resetting; },
    async reset() {
      resetting = true;
      try { await active?.catch(() => {}); cua[Symbol.for('sleight.clipboard')].copy = undefined; }
      finally { resetting = false; }
    },
    async close() { closed = true; await active?.catch(() => {}); cua[Symbol.for('sleight.clipboard')].copy = undefined; },
    async run(action, execute) {
    if (busy || closed || resetting) throw new Error('Clipboard guard: another clipboard action is pending or the session closed.');
    busy = true; dispatch = execute; notices = [];
    try {
      active = (async () => {
        const app = await cua.getApp();
        return await (action === 'paste' ? app.paste() : app.pressKey('super+' + action));
      })();
      const result = await active;
      return { result, notices };
    } catch (error) { error.clipboardNotices = notices; throw error;
    } finally { busy = false; dispatch = undefined; active = undefined; }
  } };
}

export function clipboardActions(code) {
  const ts = tokens(code), actions = [];
  for (let i = 0; i < ts.length; i++) {
    if (!['pressKey', 'paste'].includes(ts[i].v)) continue;
    const bracket = ts[i].string && ts[i - 1]?.v === '[' && ts[i + 1]?.v === ']';
    if (!bracket && ts[i - 1]?.v !== '.') continue;
    const open = i + (bracket ? 2 : 1);
    if (ts[open]?.v !== '(') continue;
    if (ts[i].v === 'paste') actions.push('paste');
    else if (ts[open + 1]?.string && [')', ','].includes(ts[open + 2]?.v)) {
      const parts = ts[open + 1].v.toLowerCase().split('+');
      if (parts.some(p => ['super', 'cmd', 'command', 'meta'].includes(p)) && ['c', 'x', 'v'].includes(parts.at(-1))) actions.push(parts.at(-1));
    }
  }
  return actions;
}

export function clipboardPlan(code) {
  const actions = clipboardActions(code);
  if (actions.length > 1) throw new Error('Clipboard: use one clipboard action per js call. Split the call and retry each action separately.');
  return actions[0];
}

export function installClipboardPermit(cua) {
  const symbol = Symbol.for('sleight.clipboardPermit');
  if (cua[symbol]) return cua[symbol];
  const state = { action: undefined, used: false, wrapped: new WeakMap() };
  Object.defineProperty(cua, symbol, { value: state, configurable: true });
  const getApp = cua.getApp.bind(cua);
  const take = action => {
    if (state.used) throw new Error('Clipboard: use one clipboard action per js call. Split the call and retry each action separately.');
    if (state.action !== action) throw new Error('Clipboard: use a literal clipboard shortcut or app.paste. Split the call and retry with one clipboard action per js call.');
    state.used = true;
  };
  cua.getApp = async (...args) => {
    const raw = await getApp(...args);
    if (state.wrapped.has(raw)) return state.wrapped.get(raw);
    const proxy = new Proxy(raw, { get(target, name) {
      const value = Reflect.get(target, name);
      if (name === 'paste' && typeof value === 'function') return async (...args) => { take('paste'); return value.apply(target, args); };
      if (name === 'pressKey' && typeof value === 'function') return async (...args) => {
        const [key] = args;
        const parts = typeof key === 'string' ? key.toLowerCase().split('+') : [];
        if (parts.some(p => ['super', 'cmd', 'command', 'meta'].includes(p)) && ['c', 'x', 'v'].includes(parts.at(-1))) take(parts.at(-1));
        return value.apply(target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    state.wrapped.set(raw, proxy); state.wrapped.set(proxy, proxy);
    return proxy;
  };
  return state;
}

export function clipboardCode(code, action) {
  return `(() => { const state = (${installClipboardPermit.toString()})(cua); state.action = ${JSON.stringify(action) ?? 'undefined'}; state.used = false; })();\n${code}`;
}
