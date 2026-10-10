// Module hooks for bench/startup-costs-count.mjs: count child processes and
// SQLite opens without running real osascript or touching a real app. Loaded
// only in that bench child (bench/startup-costs-hooks.mjs registers this file).
// node:child_process and node:sqlite are replaced; every other specifier and
// all real operations pass through unchanged.

const CHILD_SOURCE = `
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const realSpawn = cp.spawn, realExecFile = cp.execFile, realExecFileSync = cp.execFileSync;
const bump = () => { globalThis.__childSpawns = (globalThis.__childSpawns ?? 0) + 1; };
const stub = file => process.env.SLEIGHT_STUB_OSASCRIPT === '1' && (/(^|\\/)osascript$/.test(String(file)) || String(file).endsWith('/open'));
const scriptName = args => (args ?? []).map(String).find(a => a.endsWith('.js'))?.split('/').at(-1);
const stubStdout = (script, args) => {
  const byScript = {
    'drag-focus.js': { ok: true, app: 'Calculator', bundleId: 'com.apple.calculator', frontApp: 'Calculator', frontBundleId: 'com.apple.calculator' },
    'drag.js': { ok: true, path: 'background', ms: 1 },
    'menubar.js': { ok: true },
    'blocked-app.js': { ok: true },
    'input-state.js': { ok: true, buttons: [] },
  };
  if (script === 'ask.js') return 'accept\\n';
  if ((args ?? []).includes('-e')) return 'com.apple.calculator\\n';
  return JSON.stringify(byScript[script] ?? { ok: true }) + '\\n';
};
const reply = request => {
  const { id } = request;
  if (request.op === 'lease-target') {
    const ids = { iterm2: 'com.googlecode.iterm2', terminal: 'com.apple.Terminal' };
    const appId = ids[String(request.app).toLowerCase()] ?? 'com.apple.calculator';
    return { id, ok: true, target: { app: request.app, appId, pid: 4242 } };
  }
  if (request.op === 'keyboard-taps') return { id, ok: true, taps: [] };
  if (request.op === 'window-identity') return { id, status: 'unknown' };
  if (request.app !== undefined) return { id, status: 'responding', pid: 4242, windows: 1, onScreen: 1, allWindows: 1, hidden: false };
  if (request.op === 'read') return { id, ok: true, count: 1, items: [{ type: 'public.utf8-plain-text', value: 'x' }] };
  return { id, ok: true };
};
const fakeSessionChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.pid = 4242;
  child.unref = () => child; child.ref = () => child;
  child.kill = () => { queueMicrotask(() => child.emit('close', null, null)); return true; };
  child.end = () => true;
  child.stdin.setEncoding('utf8');
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { child.stdout.write(JSON.stringify(reply(JSON.parse(line))) + '\\n'); } catch {}
    }
  });
  return child;
};
export function spawn(file, args, options) {
  bump();
  if (stub(file)) return fakeSessionChild();
  return realSpawn(file, args, options);
}
export function execFile(file, args, options, callback) {
  bump();
  if (stub(file)) {
    if (typeof options === 'function') { callback = options; }
    const stdout = stubStdout(scriptName(args), args);
    queueMicrotask(() => callback?.(undefined, stdout, ''));
    return { pid: 4242, kill: () => true, once: () => {}, on: () => {}, stdin: { end: () => {}, on: () => {} }, stdout: { on: () => {} } };
  }
  return realExecFile(file, args, options, callback);
}
export function execFileSync(file, args, options) {
  bump();
  if (stub(file)) return '0\\n';
  return realExecFileSync(file, args, options);
}
export default cp;
`;

const SQLITE_SOURCE = `
import sqlite from 'node:sqlite';
const Real = sqlite.DatabaseSync;
class CountingDatabaseSync extends Real {
  constructor(...args) {
    super(...args);
    globalThis.__sqliteOpens = (globalThis.__sqliteOpens ?? 0) + 1;
  }
}
export { CountingDatabaseSync as DatabaseSync };
export * from 'node:sqlite';
`;

export function resolve(specifier, context, next) {
  // The synthetic modules re-export the real builtins; do not intercept again.
  if (context.parentURL?.startsWith('sleight-count:')) return next(specifier, context);
  if (specifier === 'node:child_process' || specifier === 'node:sqlite') {
    return { specifier, url: 'sleight-count:' + specifier, shortCircuit: true };
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url === 'sleight-count:node:child_process') return { format: 'module', shortCircuit: true, source: CHILD_SOURCE };
  if (url === 'sleight-count:node:sqlite') return { format: 'module', shortCircuit: true, source: SQLITE_SOURCE };
  return next(url, context);
}
