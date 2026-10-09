import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runOwned } from './preapproved-process.mjs';
import { heliumHelper } from './real-helium.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./real-fixture.js', import.meta.url));
async function fixtureHelper(request, signal) {
  return ['net.imput.helium', 'com.apple.Safari'].includes(request.bundle)
    ? { command: await heliumHelper(signal), args: [] }
    : { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', script] };
}

// The child retains its AX window reference through cleanup. It never needs a
// window inventory or an Apple Event. Only a retained reference permits closing
// a window; a missing reference leaves cleanup unconfirmed.
export async function openFixture(ctx, request, { run = runOwned, open = execute, launch, helper = fixtureHelper } = {}) {
  if (request.bundle === 'com.apple.Safari' && ctx.ownerAway !== true) {
    throw Object.assign(new Error('Safari blank-window setup requires an explicit owner-away boundary'), { noMutation: true });
  }
  request = { ...request, ownerAway: ctx.ownerAway === true };
  ctx.signal?.throwIfAborted();
  ctx.cleanupSignal?.throwIfAborted();
  const startedAtMs = Date.now();
  ctx.windowLeases ??= [];
  const control = join(ctx.dir, `window-${ctx.windowLeases.length}-control.json`);
  const signal = ctx.signal;
  const controller = new AbortController();
  // Ordinary cancellation still needs this child's retained window reference.
  // A permission stop ends all AX activity immediately instead.
  const helperSignal = AbortSignal.any([controller.signal, ctx.cleanupSignal].filter(Boolean));
  const stages = new Map();
  const diagnostics = { app: request.app, bundle: request.bundle, retries: [], totalWaitMs: 0, actionTaken: false };
  (ctx.fixtureDiagnostics ??= []).push(diagnostics);
  const stage = name => {
    if (!stages.has(name)) stages.set(name, Promise.withResolvers());
    return stages.get(name);
  };
  let buffer = '', response, completed;
  const untouched = result => result.groupClean === true && result.stdout?.split('\n').some(line => {
    try {
      const event = JSON.parse(line);
      return event.stage === 'untouched' || (event.stage === 'setup-failure' &&
        ['nothing created', 'closed retained fixture', 'unconfirmed'].includes(event.cleanup) && !event.cleanupError);
    } catch { return false; }
  });
  const lease = {
    app: request.app,
    launched: false,
    async quit({ final = false } = {}) {
      if (lease.running !== false || !lease.launched || request.app === 'Finder' || diagnostics.appQuit) return;
      const collected = await lease.dispose();
      diagnostics.helperCollectionConfirmed = collected;
      if (!collected && !final) throw new Error('Fixture helper collection unconfirmed; app quit refused');
      // Final native termination cannot answer a permission dialog or perform AX
      // actions. It still requires the exact PID and bundle this run launched.
      if (!final) { await ctx.beforeFixtureCleanup?.(); ctx.cleanupSignal?.throwIfAborted(); }
      if (!lease.pid) throw new Error('Launched app identity unconfirmed; quit refused');
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', script,
        JSON.stringify({ bundle: request.bundle, mode: 'quit', pid: lease.pid })], {
        signal: final ? undefined : ctx.cleanupSignal, timeoutMs: 15000,
      });
      if (!result.groupClean || result.exit?.code !== 0) throw new Error(`Launched ${request.app} quit unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
      diagnostics.appQuit = true;
    },
    async close() {
      if (completed && untouched(completed)) return;
      if (ctx.cleanupSignal?.aborted) { await lease.dispose(); throw new Error('Fixture cleanup stopped by a permission window'); }
      writeFileSync(control, JSON.stringify({ command: 'close' }), { mode: 0o600 });
      let timer;
      const result = await Promise.race([response, new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ error: 'Fixture cleanup timed out', groupClean: false });
      }, 15000); })]).finally(() => clearTimeout(timer));
      if (untouched(result)) return;
      if (!result.groupClean || result.error || result.exit.code !== 0 ||
        !result.stdout.split('\n').some(line => { try { return JSON.parse(line).stage === 'closed'; } catch { return false; } })) {
        diagnostics.closeFailure = result.stderr?.trim() || result.error;
        throw new Error(`Owned fixture window cleanup unconfirmed${diagnostics.closeFailure ? ': ' + diagnostics.closeFailure : ''}`);
      }
    },
    async dispose() { controller.abort(); return (await response).groupClean === true; },
  };
  let command;
  const beginLaunch = (launched = true) => {
    lease.launched = launched;
    diagnostics.launched = launched;
    writeFileSync(control, JSON.stringify({ command: 'launching' }), { mode: 0o600 });
  };
  try { command = await helper(request, signal); }
  catch (error) { if (error.noMutation === true) diagnostics.cleanup = 'nothing created'; throw error; }
  ctx.windowLeases.push(lease);
  response = run(command.command, [...command.args, JSON.stringify({ ...request, control, startedAtMs })], {
    signal: helperSignal, timeoutMs: 600000, graceMs: 1000,
    onStdout: data => {
      buffer += String(data);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (typeof event.running === 'boolean') { lease.running = event.running; diagnostics.running = event.running; }
        if (event.pid) { lease.pid = event.pid; diagnostics.pid = event.pid; }
        if (event.stage === 'retry') diagnostics.retries.push({ code: event.code, waitMs: event.waitMs, totalWaitMs: event.totalWaitMs });
        for (const key of ['fresh', 'totalWaitMs', 'actionTaken', 'cleanup', 'cleanupError', 'menuCancelled', 'menuCancelMethod', 'menuItems', 'menuCommands', 'readiness', 'navigation', 'creation', 'foregroundFallback']) {
          if (event[key] !== undefined) diagnostics[key] = event[key];
        }
        if (event.stage) stage(event.stage).resolve(event);
      }
    },
  }).catch(error => ({ error: error.message, groupClean: false })).then(result => { completed = result; return result; });
  const waitStage = async name => {
    let timer;
    try {
      return await Promise.race([stage(name).promise, response.then(result => {
        throw Object.assign(new Error(`Fixture setup failed: ${result.stderr?.trim() || result.error || 'helper exited before readiness'}`),
          { noMutation: untouched(result) });
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture setup readiness timed out')), 40000); })]);
    } finally { clearTimeout(timer); }
  };
  try {
  if (request.bundle === 'com.apple.Safari') {
    await waitStage('launch');
    beginLaunch();
    await open('/usr/bin/open', ['-g', '-a', 'Safari'], { signal, timeout: 15000 });
  }
  await waitStage('armed');
  signal?.throwIfAborted();
  if (launch) await launch(beginLaunch);
  else if (request.bundle !== 'com.apple.Safari') {
    beginLaunch();
    const args = request.app === 'Helium'
      ? ['-n', '-g', '-a', request.app, '--args', '--new-window', request.target]
      : ['-g', '-a', request.app, ...(request.target ? [request.target] : [])];
    await open('/usr/bin/open', args, { signal, timeout: 15000 });
  }
  writeFileSync(control, JSON.stringify({ command: 'opened' }), { mode: 0o600 });
  await waitStage('ready');
  return lease;
  } catch (error) {
    // LaunchServices errors and readiness deadlines can precede the helper's
    // recovery receipt. Await that receipt before deciding acquisition status.
    try { await ctx.beforeFixtureCleanup?.(); await lease.close(); error.noMutation = true; } catch {}
    throw error;
  }
}

export async function closeFixtures(ctx) {
  const errors = [];
  for (const lease of [...ctx.windowLeases ?? []].reverse()) {
    try { await lease.close(); } catch (error) { errors.push(error.message); }
    try {
      if (lease.running === false && lease.launched) {
        if (!await lease.dispose()) throw new Error('Fixture helper collection unconfirmed; app quit refused');
        await lease.quit();
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}
