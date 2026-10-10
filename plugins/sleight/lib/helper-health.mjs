// Doctor reads inventory and optionally one running app, never actions or approval.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// Labels of the helper's launchd jobs with no running process, from
// `launchctl list`. On 2026-10-05 such a job made every launch fail with
// "Operation already in progress" until `launchctl remove` cleared it.
export function staleHelperJobs(listing) {
  return listing.split('\n').map(line => line.trim().split(/\s+/))
    .filter(([pid, , label]) => pid === '-' && /^application\.com\.openai\.sky\.CUAService\.[\w.]+$/.test(label ?? ''))
    .map(([, , label]) => label);
}

// The errors a getState result lists, from any text item that is its JSON.
export function stateErrors(result) {
  const errors = [];
  for (const item of result?.content ?? []) {
    if (item.type !== 'text' || !item.text.trimStart().startsWith('{')) continue;
    let state;
    try { state = JSON.parse(item.text); } catch { continue; }
    if (Array.isArray(state?.errors)) errors.push(...state.errors.map(String));
  }
  return errors;
}

export async function probeHelper(server, { app, timeoutMs = 5000, startupTimeoutMs = 10000, cleanupGraceMs = 2000, cleanupForceMs = 5000 } = {}) {
  const child = spawn(server.command, server.args, {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...server.env },
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const input = createInterface({ input: child.stdout });
  let nextId = 0;
  let pending;
  let stderr = '';
  let reading = false;
  let inventoryOk = false;
  let appStarted;
  let approvalDeclined = false;
  const metadata = { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) };
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  const fail = err => { if (pending) { clearTimeout(pending.timer); pending.reject(err); pending = undefined; } };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.once('exit', (code, signal) => fail(new Error(`computer-use server exited (${signal || code}): ${stderr.trim()}`)));
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params, ms, timeoutMessage) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending = { id, resolve, reject, timer: setTimeout(() => fail(new Error(timeoutMessage)), ms) };
    send({ id, method, params });
  });
  input.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { fail(new Error('computer-use server returned invalid JSON')); return; }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'elicitation/create') approvalDeclined = true;
      send({ id: msg.id, ...(msg.method === 'elicitation/create' ? { result: { action: 'decline' } }
        : { error: { code: -32601, message: 'Method not found' } }) });
    } else if (!msg.method && pending?.id === msg.id) {
      const reply = pending; pending = undefined; clearTimeout(reply.timer);
      msg.error ? reply.reject(new Error(msg.error.message)) : reply.resolve(msg.result);
    }
  });
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'sleight-doctor', version: '1' } }, startupTimeoutMs, 'computer-use server startup timed out');
    send({ method: 'notifications/initialized' });
    reading = true;
    const result = await request('tools/call', { name: 'js', arguments: { code: 'await cua.getState()', timeout_ms: timeoutMs },
      _meta: metadata },
    timeoutMs + 500, 'helper live read timed out');
    const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result?.isError) throw new Error(text || 'helper live read failed');
    if (!text.trim()) throw new Error('helper live read returned no state');
    // getState reports a helper that can't start inside its result, not as an
    // error: {"apps":[],"errors":["Native apps: Error: Sky Computer Use service
    // startup request failed"]} (2026-10-05).
    const errors = stateErrors(result);
    if (errors.length) throw new Error(errors.join('; '));
    inventoryOk = true;
    if (app === undefined) return { ok: true };
    const apps = (result.content ?? []).filter(c => c.type === 'text').flatMap(c => {
      try { const state = JSON.parse(c.text); return Array.isArray(state.apps) ? state.apps : []; }
      catch { return []; }
    });
    const same = value => typeof value === 'string' && value.toLowerCase() === app.toLowerCase();
    const matches = apps.filter(a => a && [a.id, a.displayName].some(same));
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) {
      return { ok: true, appRead: { status: 'skipped', reason: matches.length > 1 ? 'ambiguous running app' : 'app not running in helper inventory' } };
    }
    if (matches[0].isRunning !== true) return { ok: true, appRead: { status: 'skipped',
      reason: matches[0].isRunning === false ? 'app not running' : 'running status unknown in helper inventory' } };
    // Use only the inventory's exact ID. A missing app is never acquired or launched.
    approvalDeclined = false;
    appStarted = performance.now();
    const read = await request('tools/call', { name: 'js', arguments: {
      code: `await cua.getApp(${JSON.stringify(matches[0].id)})`, timeout_ms: timeoutMs,
    }, _meta: metadata }, timeoutMs + 500, 'app read timed out');
    const ms = Math.round(performance.now() - appStarted);
    if (approvalDeclined) return { ok: true, appRead: { status: 'skipped', reason: 'approval required (declined without a prompt)', ms } };
    const appText = (read?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const hasWindowHeader = /^Window: "(?:[^"\\\n]|\\.)*", App: [^\n]+/m.test(appText);
    const ok = !read?.isError && hasWindowHeader;
    return { ok, inventoryOk, appRead: { status: ok ? 'ok' : 'failed', ms, hasWindowHeader,
      ...(!ok ? { error: read?.isError ? appReadError(appText) : 'app read returned no window header' } : {}) } };
  } catch (err) {
    if (appStarted !== undefined) return { ok: approvalDeclined, inventoryOk, appRead: {
      status: approvalDeclined ? 'skipped' : 'failed', ms: Math.round(performance.now() - appStarted),
      ...(approvalDeclined ? { reason: 'approval required (declined without a prompt)' } : { error: appReadError(err.message), hasWindowHeader: false }),
    } };
    const stuck = reading && /timeoutReached|timed out|timeout/i.test(err.message);
    return { ok: false, stuck, error: err.message };
  } finally {
    child.stdin.end();
    const signalOwned = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (err) { if (err.code !== 'ESRCH') fail(err); }
    };
    const gentle = setTimeout(() => signalOwned('SIGTERM'), cleanupGraceMs);
    const force = setTimeout(() => signalOwned('SIGKILL'), cleanupForceMs);
    let deadline;
    const collected = await Promise.race([closed.then(() => true), new Promise(resolve => {
      deadline = setTimeout(() => resolve(false), cleanupForceMs + 1000);
    })]);
    clearTimeout(gentle); clearTimeout(force); clearTimeout(deadline); input.close();
    if (!collected) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      throw new Error('doctor could not collect its owned engine process group');
    }
  }
}

// Engine errors may contain a partial accessibility tree. Report only a class.
function appReadError(message) {
  if (/timeoutReached/.test(message)) return 'app read failed: timeoutReached';
  if (/timed out|timeout/i.test(message)) return 'app read timed out';
  return 'app read failed (engine error)';
}
