import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

// Inspect only macOS's authorization process. frontmost-window enumerates all
// windows of the active app, which would expose unrelated Helium windows.
export async function observePermission({ inspector = join(homedir(), '.codex/bin/codex-macos-inspect'), run = execute } = {}) {
  if (!existsSync(inspector)) throw new Error('macOS permission observer unavailable: install codex-macos-inspect');
  let pids;
  try { pids = (await run('/usr/bin/pgrep', ['-x', 'UserNotificationCenter'], { timeout: 10000 })).stdout.trim().split(/\s+/); }
  catch (error) { if (error.code === 1) return false; throw error; }
  if (!pids.length || pids.length > 64 || pids.some(pid => !/^[1-9]\d*$/.test(pid))) throw new Error('invalid authorization process identity');
  for (const pid of pids) {
    const apps = JSON.parse((await run(inspector, ['app-info', pid], { timeout: 10000 })).stdout);
    if (!Array.isArray(apps)) throw new Error('invalid authorization app observation');
    if (!apps.some(app => app.bundleIdentifier === 'com.apple.UserNotificationCenter')) continue;
    const windows = JSON.parse((await run(inspector, ['windows-for-pid', pid, '--scope', 'on-screen'], { timeout: 10000 })).stdout);
    if (!Array.isArray(windows)) throw new Error('invalid authorization window observation');
    if (!windows.some(window => window.ownerPID === Number(pid))) continue;
    const details = JSON.parse((await run('/usr/bin/osascript', ['-l', 'JavaScript',
      fileURLToPath(new URL('./real-permission.js', import.meta.url)), pid], { timeout: 10000 })).stdout);
    if (!Array.isArray(details.titles) || details.titles.some(title => typeof title !== 'string')) throw new Error('invalid authorization titles');
    if (!details.titles.length) throw new Error('visible authorization window has no readable title; live run stopped');
    const titles = details.titles.filter(title => !/quit unexpectedly/i.test(title));
    if (titles.length) return { process: 'UserNotificationCenter', title: titles[0] || '(untitled)' };
  }
  return false;
}
