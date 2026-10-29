import { codeInspectionRefusal } from './flow-rules.mjs';
import { literalValue, UNKNOWN } from './code-ast.mjs';
import { inspectCalls, unsafeHandleUse, unsafeHandleRefusal } from './call-inspection.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createClipboardSnapshotStore, clipboardContains, restoreClipboardSnapshot, recoverClipboardSnapshots, memoryOnlyClipboard } from './clipboard-recovery.mjs';

// Cooperative guard for native Copy/Cut/Paste shortcuts. Native app.paste already
// restores all readable formats and refuses a changed generation (live probe).
// Like the window guard, this shares the model's mutable JS realm.
export function installClipboardGuard(cua, io, notice = () => {}) {
  const key = Symbol.for('sleight.clipboard');
  if (cua[key] || typeof cua.getApp !== 'function') return;
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
export function createNativeClipboardIO(helper, { timeoutMs = 10000, snapshotStore = createClipboardSnapshotStore(),
  spawnHelper = () => spawn('/usr/bin/osascript', ['-l', 'JavaScript', helper, '--serve'], { stdio: ['pipe', 'pipe', 'ignore'] }) } = {}) {
  let coordinator;
  let child, nextId = 0, closed = false;
  const pending = new Map(), limit = 96 * 1024 * 1024;
  const ascii = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  function fail(error) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }
  function stop(error, forceMs = 500) {
    if (!child) { fail(error); return; }
    if (child.stopping) return;
    // Keep the caller and its SQLite reservation pending until the old helper
    // cannot finish a staged write. A stopping flag fences only this session.
    const current = child;
    current.failure = error;
    current.stopping = true;
    for (const p of pending.values()) clearTimeout(p.timer);
    current.stdin.end(); current.kill();
    const force = setTimeout(() => current.kill('SIGKILL'), forceMs);
    current.collected.finally(() => clearTimeout(force));
  }
  function start() {
    const current = child = spawnHelper();
    current.collected = new Promise(resolve => current.once('close', () => {
      if (child === current) { child = undefined; fail(current.failure ?? new Error('Clipboard guard: helper closed; input was not retried.')); }
      resolve();
    }));
    current.once('error', () => stop(new Error('Clipboard guard: helper failed; input was not retried.')));
    current.stdin.on('error', () => stop(new Error('Clipboard guard: helper input failed; input was not retried.')));
    current.stdout.on('error', () => stop(new Error('Clipboard guard: helper output failed; input was not retried.')));
    current.unref?.(); current.stdin.unref?.(); current.stdout.unref?.();
    let fragments = [], bytes = 0;
    current.stdout.setEncoding('utf8').on('data', chunk => {
      if (child !== current || current.stopping) return;
      // Scan and count only new segments; flatten each frame once at its delimiter.
      let offset = 0;
      while (offset < chunk.length) {
        const at = chunk.indexOf('\n', offset), end = at < 0 ? chunk.length : at;
        const part = chunk.slice(offset, end);
        bytes += Buffer.byteLength(part) + (at < 0 ? 0 : 1);
        if (bytes > limit) { stop(new Error('Clipboard guard: helper reply too large.')); return; }
        fragments.push(part);
        if (at < 0) break;
        const line = fragments.join(''); fragments = []; bytes = 0; offset = at + 1;
        let result;
        try { result = JSON.parse(line); } catch { stop(new Error('Clipboard guard: invalid reply from helper.')); return; }
        const p = pending.get(result?.id);
        if (!p || typeof result.ok !== 'boolean') { stop(new Error('Clipboard guard: invalid reply from helper.')); return; }
        pending.delete(result.id); clearTimeout(p.timer); delete result.id;
        if (result.ok) p.resolve(result);
        else p.reject(Object.assign(new Error(result.error), { clipboardCount: result.count, clipboardMutation: result.mutated }));
      }
    });
  }
  const io = async request => {
    if (closed) throw new Error('Clipboard guard: session closed.');
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
    if (child?.stopping) throw new Error('Clipboard guard: helper stopping; retry only after it has closed.');
    if (!child) start();
    const { timeoutMs: requestTimeoutMs = timeoutMs, ...payload } = request;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) throw Error('Invalid clipboard IO deadline.');
    const id = nextId++, line = ascii({ ...payload, id }) + '\n';
    if (Buffer.byteLength(line) > limit) throw new Error('Clipboard guard: request too large.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(Object.assign(new Error('Clipboard guard: helper timed out; input was not retried.'), { clipboardTimeout: true })), Math.min(requestTimeoutMs, timeoutMs));
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(line);
    });
  };
  io.snapshotStore = snapshotStore;
  io.restart = async ({ timeoutMs: restartTimeoutMs = timeoutMs } = {}) => {
    const current = child;
    if (!current) return;
    stop(new Error('Clipboard guard: helper replaced for restoration.'), Math.min(500, restartTimeoutMs));
    await current.collected;
  };
  io.close = async ({ timeoutMs: closeTimeoutMs = timeoutMs } = {}) => {
    closed = true;
    const current = child;
    if (current) {
      current.failure ??= new Error('Clipboard guard: session closed.');
      current.stopping = true;
      for (const p of pending.values()) clearTimeout(p.timer);
      current.stdin.end();
      const timer = setTimeout(() => current.kill(), closeTimeoutMs);
      const force = setTimeout(() => current.kill('SIGKILL'), closeTimeoutMs + 500);
      try { await current.collected; } finally { clearTimeout(timer); clearTimeout(force); }
    } else fail(new Error('Clipboard guard: session closed.'));
    coordinator?.release();
  };
  return io;
}

// Called by both installed entry points before accepting input. A missing bank
// needs no helper. Log only a fixed code and a JSON-escaped snapshot path.
export async function recoverNativeClipboard({ io = createNativeClipboardIO(fileURLToPath(new URL('./clipboard.js', import.meta.url))),
  notice = (code, path) => process.stderr.write(code + ' ' + JSON.stringify(path) + '\n') } = {}) {
  const log = code => { try { notice(code, io.snapshotStore?.directory); } catch {} };
  try { await recoverClipboardSnapshots(io, { notice }); }
  catch { log('CLIPBOARD_SNAPSHOT_RECOVERY_FAILED'); }
  finally { try { await io.close?.(); } catch { log('CLIPBOARD_SNAPSHOT_CLOSE_FAILED'); } }
}

// Browser input uses the same cross-process reservation and generation-checked
// byte IO as native preservation. Never paste the old clipboard on a read failure.
export function createClipboardPasteSession(io) {
  const limit = 32 * 1024 * 1024, stagedLimitMs = 500, restoreReserveMs = 50;
  let active, closed = false, stagedMs;
  const read = () => io({ op: 'read', maxBytes: limit });
  const restorationFailure = detail => Object.assign(Error('Clipboard restoration unconfirmed: ' + detail +
    ' The clipboard was not restored. Paste effect unconfirmed; read before retrying.'), { clipboardRestoreFailure: true });
  return Object.freeze({
    get stagedMs() { return stagedMs; },
    async paste(text, execute, prepare = stage => stage()) {
      if (closed || active) throw Error('Clipboard paste busy or closed; nothing was sent.');
      if (typeof text !== 'string' || !text.length || text.length > 65536 || typeof execute !== 'function') throw Error('Nonempty bounded paste text required.');
      stagedMs = undefined;
      active = (async () => {
        let acquired = false, transactionFailure;
        try {
          await io({ op: 'acquire' }); acquired = true;
          await recoverClipboardSnapshots(io, { acquired: true });
          const before = await read();
          if (before.items.reduce((size, reps) => size + reps.reduce((n, rep) => n + Buffer.byteLength(rep.data, 'base64'), 0), 0) > limit)
            throw Error('Clipboard exceeds 32 MiB; nothing was staged.');
          const staged = [[{ type: 'public.utf8-plain-text', data: Buffer.from(text, 'utf8').toString('base64') },
            ...['TransientType', 'ConcealedType', 'AutoGeneratedType'].map(name => ({ type: 'org.nspasteboard.' + name, data: '' }))]];
          const record = { original: before.items, staged };
          let used = false, token;
          const recover = async (written, start) => {
            const { state, cleared, empty } = await restoreClipboardSnapshot(io, record, { written, clearStaged: true,
              initialTimeoutMs: Math.max(1, Math.floor(stagedLimitMs - (performance.now() - start))) });
            if (state !== 'exhausted') { if (token) io.snapshotStore.remove(token); token = undefined; }
            if (state === 'restored') return;
            if (state === 'changed') throw restorationFailure('Another app changed the clipboard; its contents were left alone.');
            const bound = 'Recovery reached 5 attempts or 30 s. ' + (token ? 'Snapshot retained. ' : '');
            throw restorationFailure(bound + (cleared ? 'The staged text was cleared.' : empty ? 'The pasteboard is empty.' : 'Current contents could not be verified.'));
          };
          return await prepare(async (...args) => {
            if (used || closed) throw Error('Clipboard paste closed or already sent.');
            used = true;
            // Sync the private file and directory before the first stage write.
            if (!memoryOnlyClipboard(before.items)) token = io.snapshotStore?.save(record);
            let written, stageWrite, reading, attempted = false, failure, running, timer, expired = false, inputStarted = false, stageFailedCleanly = false;
            const start = performance.now();
            const capError = () => Error('Clipboard staging reached its 500 ms budget for input and restoration; input was not retried.');
            const remaining = () => {
              const ms = stagedLimitMs - restoreReserveMs - (performance.now() - start);
              if (expired || ms <= 0) throw capError();
              return Math.max(1, Math.floor(ms));
            };
            const verify = async () => {
              const timeoutMs = remaining();
              reading = io({ op: 'read', maxBytes: limit, timeoutMs });
              const current = await reading;
              remaining();
              if (current.count !== written.count || !clipboardContains(current.items, staged))
                throw Error('Clipboard ownership changed before paste; nothing was sent.');
            };
            verify.remaining = remaining;
            // Restore on the watchdog even if a page read or frame-lock wait is
            // still pending. Collect that callback before releasing ownership.
            const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
              expired = true; reject(capError());
            }, stagedLimitMs - restoreReserveMs); });
            running = (async () => {
              attempted = true;
              stageWrite = io({ op: 'write', expectedCount: before.count, localOnly: true, items: staged, timeoutMs: remaining() });
              try { written = await stageWrite; }
              catch (error) {
                stageFailedCleanly = error.clipboardMutation === false && !error.clipboardTimeout;
                throw error;
              }
              remaining();
              if (closed) throw Error('Clipboard paste closed before input.');
              await verify();
              inputStarted = true;
              await execute(verify, ...args);
              remaining();
            })();
            try { await Promise.race([running, deadline]); }
            catch (error) { failure = error; }
            finally {
              clearTimeout(timer);
              // Fence any callback still awaiting a page read or a key reply.
              expired = true;
              // A helper still publishing the stage must close before recovery.
              await stageWrite?.catch(() => {});
              await reading?.catch(() => {});
              if (stageFailedCleanly) {
                if (token) io.snapshotStore.remove(token); token = undefined;
                failure = Error('Paste not attempted; your clipboard is unchanged.');
              } else if (attempted) try { await recover(written, start); }
              catch (error) {
                failure = error.clipboardRestoreFailure ? error
                  : restorationFailure('Clipboard IO failed; current contents could not be verified.');
              }
              stagedMs = stageFailedCleanly ? undefined : performance.now() - start;
              await running.catch(() => {});
            }
            if (!failure && stagedMs > stagedLimitMs) failure = capError();
            if (failure) {
              // Only assert restoration when no recovery failure replaced the
              // input error. Never hide a failed restoration behind a timeout.
              if (!failure.clipboardRestoreFailure && !stageFailedCleanly) failure.message += ' Clipboard restored.';
              if (inputStarted) failure.message += ' The paste may have landed; read before retrying.';
              if (Number.isFinite(stagedMs)) failure.message += ' Clipboard staged for ' + stagedMs.toFixed(1) + ' ms (500 ms limit).';
              throw failure;
            }
            return 'clipboard restored';
          });
        } catch (error) { transactionFailure = error; throw error; }
        finally {
          if (acquired) try { await io({ op: 'release' }); }
          catch {
            if (transactionFailure) transactionFailure.message += ' Clipboard reservation cleanup unconfirmed.';
            else throw Error('Clipboard reservation cleanup unconfirmed. Paste effect unconfirmed; read before retrying.');
          }
        }
      })();
      try { return await active; } finally { active = undefined; }
    },
    async close() { closed = true; await active?.catch(() => {}); await io.close?.(); },
  });
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
    async close() { closed = true; await active?.catch(() => {}); cua[Symbol.for('sleight.clipboard')].copy = undefined; await io.close?.(); },
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

export function clipboardActions(code, inspection = {}) {
  const { ast, calls, error } = inspectCalls(code), actions = [];
  if (error) throw new Error(codeInspectionRefusal);
  const unsafe = unsafeHandleUse(ast, undefined, { code, ...inspection });
  if (unsafe) throw new Error(unsafeHandleRefusal(unsafe));
  for (const { call } of calls) {
    if (!call) continue;
    if (call.method === UNKNOWN) {
      Object.defineProperty(actions, 'unknown', { value: (actions.unknown ?? 0) + 1, configurable: true });
      continue; // The runtime permit checks the resolved method and shortcut.
    }
    if (call.method === 'paste') actions.push('paste');
    else if (call.method === 'pressKey') {
      const key = literalValue(call.args[0]);
      // UNKNOWN keys have no literal plan. installClipboardPermit refuses a
      // computed clipboard shortcut before input, while ordinary keys pass.
      if (key === UNKNOWN) Object.defineProperty(actions, 'unknown', { value: (actions.unknown ?? 0) + 1, configurable: true });
      if (typeof key !== 'string') continue;
      const parts = key.toLowerCase().split('+');
      if (parts.some(p => ['super', 'cmd', 'command', 'meta'].includes(p)) && ['c', 'x', 'v'].includes(parts.at(-1))) actions.push(parts.at(-1));
    }
  }
  return actions;
}

export function clipboardPlan(code, inspection = {}) {
  const actions = clipboardActions(code, inspection);
  if (actions.length > 1) throw new Error('Clipboard: use one clipboard action per js call. Split the call and retry each action separately.');
  return actions[0];
}

export function installClipboardPermit(cua) {
  const symbol = Symbol.for('sleight.clipboardPermit');
  if (cua[symbol]) return cua[symbol];
  const state = { action: undefined, used: false, wrapped: new WeakMap() };
  Object.defineProperty(cua, symbol, { value: state, configurable: true });
  if (typeof cua.getApp !== 'function') return state;
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
