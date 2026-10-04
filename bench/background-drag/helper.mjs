// Standalone prototype, deliberately separate from the foreground MCP drag.
// Compiles its Swift helper on first use in this process.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const modes = ['pid', 'window', 'key-window', 'nsevent', 'nsevent-command', 'window-location', 'key-window-location'];
export function validateBackgroundDrag(input) {
  if (!input || typeof input.app !== 'string' || !input.app.trim()) throw new Error('app is required');
  for (const key of ['from', 'to']) {
    if (!Array.isArray(input[key]) || input[key].length !== 2 || !input[key].every(Number.isFinite)) throw new Error(`${key} must contain two finite coordinates`);
  }
  const result = { app: input.app, from: input.from, to: input.to,
    holdMs: input.holdMs ?? 500, steps: input.steps ?? 25, settleMs: input.settleMs ?? 1500, mode: input.mode ?? 'window-location' };
  for (const [key, min, max] of [['holdMs', 0, 5000], ['settleMs', 0, 5000], ['steps', 1, 100]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} must be ${min}..${max}`);
  }
  if (!modes.includes(result.mode)) throw new Error('unknown event mode');
  if (input.abortAfterStep !== undefined) {
    if (!Number.isInteger(input.abortAfterStep) || input.abortAfterStep < 1 || input.abortAfterStep > result.steps) throw new Error('abortAfterStep outside drag');
    result.abortAfterStep = input.abortAfterStep;
  }
  if (input.windowTitle !== undefined) {
    if (typeof input.windowTitle !== 'string' || !input.windowTitle) throw new Error('windowTitle must be a nonempty string');
    result.windowTitle = input.windowTitle;
  }
  if (input.windowId !== undefined) {
    if (!Number.isInteger(input.windowId) || input.windowId < 1 || input.windowId > 0xffffffff) throw new Error('invalid windowId');
    result.windowId = input.windowId;
  }
  return result;
}
let helper;
async function compile() {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-background-drag-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const exe = join(dir, 'background-drag');
  await exec('/usr/bin/swiftc', ['-O', '-o', exe, fileURLToPath(new URL('./background-drag.swift', import.meta.url))], { timeout: 180000 });
  return exe;
}
export async function runBackgroundDrag(input) {
  const request = validateBackgroundDrag(input);
  helper ??= compile();
  const exe = await helper;
  try {
    const { stdout } = await exec(exe, [JSON.stringify(request)], { maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout?.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await runBackgroundDrag(JSON.parse(process.argv[2]));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
