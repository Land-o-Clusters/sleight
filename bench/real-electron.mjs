import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function appRunning(bundle, { exec = execute } = {}) {
  const script = 'ObjC.import("AppKit"); const want = ' + JSON.stringify(bundle)
    + '; const running = $.NSWorkspace.sharedWorkspace.runningApplications; let n = 0;'
    + ' for (let i = 0; i < running.count; i++) { const id = running.objectAtIndex(i).bundleIdentifier;'
    + ' if (!id.isNil() && ObjC.unwrap(id) === want) n++; } String(n);';
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8000 });
  return Number(String(stdout).trim()) > 0;
}

export async function openBackground(bundle, target, { exec = execute } = {}) {
  const args = ['-g', '-b', bundle];
  if (target) args.push(target);
  await exec('/usr/bin/open', args, { timeout: 15000 });
}

export async function quitBundle(bundle, { exec = execute, running = appRunning } = {}) {
  try {
    await exec('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(bundle)} to quit`], { timeout: 15000 });
  } catch {}
  for (let i = 0; i < 20; i++) {
    if (!await running(bundle, { exec })) return;
    await sleep(250);
  }
  throw new Error('Launched app quit unconfirmed');
}

export function prepareEditor(ctx) {
  ctx.document = join(ctx.dir, `${ctx.nonce}-edit.txt`);
  writeFileSync(ctx.document, 'alpha beta gamma\n');
}

export function checkEditor(ctx) {
  try {
    const text = readFileSync(ctx.document, 'utf8');
    return text.trim() === 'alpha delta gamma' || 'saved document does not contain the replaced word';
  } catch { return 'edit document is missing'; }
}

export async function openElectron(ctx, { app, bundle, target }, {
  running = appRunning, open = openBackground, quit = quitBundle,
} = {}) {
  ctx.signal?.throwIfAborted();
  const wasRunning = await running(bundle);
  const lease = {
    app, bundle, launched: !wasRunning, running: wasRunning,
    async close() {},
    async dispose() { return true; },
    async quit() {
      if (!lease.launched) return;
      await quit(bundle);
    },
  };
  (ctx.windowLeases ??= []).push(lease);
  ctx.electronLease = lease;
  if (target !== undefined) await open(bundle, target);
  return lease;
}

export async function setupEditor(ctx, { app, bundle }, options = {}) {
  prepareEditor(ctx);
  await openElectron(ctx, { app, bundle }, { ...options, open: async () => {} });
}

export async function cleanupElectron(ctx) {
  const errors = [];
  for (const lease of [...ctx.windowLeases ?? []].reverse()) {
    try { await lease.close?.(); } catch (error) { errors.push(error.message); }
    try {
      if (lease.running === false && lease.launched) {
        if (lease.dispose && await lease.dispose() !== true) throw new Error('Electron helper collection unconfirmed');
        await lease.quit();
      }
    } catch (error) { errors.push(error.message); }
  }
  try {
    if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; }
  } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(errors.join('; '));
}
