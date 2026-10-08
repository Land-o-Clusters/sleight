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
  return request.bundle === 'net.imput.helium'
    ? { command: await heliumHelper(signal), args: [] }
    : { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', script] };
}

// The child retains its AX window reference through cleanup. It never needs a
// window inventory, a saved window title as authority, or an Apple Event.
export async function openFixture(ctx, request, { run = runOwned, open = execute, launch, helper = fixtureHelper } = {}) {
  ctx.windowLeases ??= [];
  const control = join(ctx.dir, `window-${ctx.windowLeases.length}-control.json`);
  const signal = ctx.signal;
  const controller = new AbortController();
  // Ordinary cancellation still needs this child's retained window reference.
  // A permission stop ends all AX activity immediately instead.
  const helperSignal = AbortSignal.any([controller.signal, ctx.cleanupSignal].filter(Boolean));
  const stages = new Map();
  const stage = name => {
    if (!stages.has(name)) stages.set(name, Promise.withResolvers());
    return stages.get(name);
  };
  let buffer = '', response, completed;
  const untouched = result => result.groupClean === true && result.stdout?.split('\n').some(line => {
    try { return JSON.parse(line).stage === 'untouched'; } catch { return false; }
  });
  const lease = {
    async close() {
      if (completed && untouched(completed)) return;
      if (ctx.cleanupSignal?.aborted) { await lease.dispose(); throw new Error('Fixture cleanup stopped by a permission window'); }
      writeFileSync(control, JSON.stringify({ command: 'close' }), { mode: 0o600 });
      let timer;
      const result = await Promise.race([response, new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ error: 'Fixture cleanup timed out', groupClean: false });
      }, 15000); })]).finally(() => clearTimeout(timer));
      if (!result.groupClean || result.error || result.exit.code !== 0 ||
        !result.stdout.split('\n').some(line => { try { return JSON.parse(line).stage === 'closed'; } catch { return false; } })) {
        throw new Error('Owned fixture window cleanup unconfirmed');
      }
    },
    async dispose() { controller.abort(); return (await response).groupClean === true; },
  };
  const command = await helper(request, signal);
  ctx.windowLeases.push(lease);
  response = run(command.command, [...command.args, JSON.stringify({ ...request, control })], {
    signal: helperSignal, timeoutMs: 600000, graceMs: 1000,
    onStdout: data => {
      buffer += String(data);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
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
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture setup readiness timed out')), 20000); })]);
    } finally { clearTimeout(timer); }
  };
  await waitStage('armed');
  signal?.throwIfAborted();
  if (launch) await launch();
  else {
    const args = request.app === 'Helium'
      ? ['-n', '-g', '-a', request.app, '--args', '--new-window', request.target]
      : ['-g', '-a', request.app, ...(request.target ? [request.target] : [])];
    await open('/usr/bin/open', args, { signal, timeout: 15000 });
  }
  writeFileSync(control, JSON.stringify({ command: 'opened' }), { mode: 0o600 });
  await waitStage('ready');
  return lease;
}

export async function closeFixtures(ctx) {
  const errors = [];
  for (const lease of [...ctx.windowLeases ?? []].reverse()) {
    try { await lease.close(); } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}
