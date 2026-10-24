import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CURSOR_PIN, BENCHMARK_APPS, approvalDecision } from './contract.mjs';

export const HELPER_BUNDLE = 'co.anysphere.cursor-computer-use';
export function sameLaunch(a, b) {
  return Number.isSafeInteger(a?.pid) && a.pid > 0 && typeof a.executable === 'string' && a.executable.startsWith('/') &&
    Number.isFinite(a.launchAt) && a.launchAt > 0 && !!a.bundleId &&
    ['pid', 'bundleId', 'executable', 'launchAt'].every(k => a[k] === b?.[k]);
}
export function assertNoForeignCursor(processes, paths, owned) {
  const executable = paths.app + '/Contents/MacOS/Cursor';
  if (!Array.isArray(processes) || processes.some(p =>
    (p.bundleId === CURSOR_PIN.bundleId || p.executable === executable) && !sameLaunch(p, owned)))
    throw Error('Cursor benchmark refused: quit your own Cursor first (foreign or unproved Cursor launch)');
}
export async function answerCards(plan, owners, ax, requests = []) {
  const cards = await ax.read(owners);
  // Decide the whole snapshot before any input, as on claude-cu's allowlist card.
  for (const card of cards) {
    const decision = approvalDecision(card, { ownerApproved: plan.allowBenchmarkAppPrompts, allowedApps: plan.allowedApps });
    const matches = requests.filter(r => r.name === card.name && r.bundleId === card.bundleId && r.toolCallId && r.generationId);
    if (!owners.some(owner => sameLaunch(owner, card.owner)) || !decision.allow || matches.length > 1)
      throw Error('Cursor approval stop: unknown, unbound or disallowed card');
    if (!matches.length) throw Object.assign(Error('Cursor approval stop: unbound card'), { code: 'CURSOR_CARD_UNBOUND' });
  }
  for (const card of cards) await ax.press(card, owners);
  return cards.length;
}

const execute = promisify(execFile), source = fileURLToPath(new URL('./macos.swift', import.meta.url));
let compiled;
async function hostExecutable() {
  // Compile once during admission, before an agent starts. Polls invoke the small binary,
  // rather than starting a Swift compiler for every permission and identity read.
  compiled ??= (async () => {
    const dir = mkdtempSync('/private/tmp/sleight-cursor-host-'), binary = join(dir, 'cursor-host');
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    try {
      await execute('/usr/bin/xcrun', ['swiftc', source, '-module-cache-path', join(dir, 'modules'), '-o', binary], { timeout: 60000, maxBuffer: 1024 * 1024 });
      return binary;
    } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  })();
  return compiled;
}
// Never invoked by dry plans. The repository owns this fixed host interface.
export async function hostCall(operation, data = {}) {
  const result = await execute(await hostExecutable(), [operation, JSON.stringify(data)], { timeout: 20000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}
export const inventory = paths => hostCall('inventory', { executable: paths.app + '/Contents/MacOS/Cursor' });
export const accessibility = {
  read: (owners, expectedExecutable) => hostCall('cards', { owners, expectedExecutable, apps: BENCHMARK_APPS }),
  press: (card, owners, expectedExecutable) => hostCall('press', { owners, expectedExecutable, apps: BENCHMARK_APPS, card }),
};
