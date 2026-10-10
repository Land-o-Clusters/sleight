import { existsSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { runOwned } from './preapproved-process.mjs';

export async function assertCalculatorReady({ held = () => existsSync('/tmp/sleight-hold'), loads = loadavg,
  inspector = join(homedir(), '.codex/bin/codex-macos-inspect'), run = runOwned, signal } = {}) {
  const checkLoad = () => {
    if (held()) throw new Error('Calculator live run stopped: /tmp/sleight-hold exists');
    const load = loads();
    if (!Number.isFinite(load[0]) || load[0] >= 20) throw new Error(`Calculator live run stopped: one-minute load ${load[0]} is not under 20`);
    return load;
  };
  checkLoad();
  const inspect = async (command, args) => {
    const result = await run(command, args, { timeoutMs: 15000, signal });
    if (result.exit.code !== 0 || !result.groupClean) throw new Error('Calculator live observation failed; no app input allowed');
    return result.stdout;
  };
  const pid = (await inspect('/usr/bin/pgrep', ['-x', 'Calculator'])).trim();
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('Calculator requires one running process on the current Space');
  const apps = JSON.parse(await inspect(inspector, ['app-info', pid]));
  if (!apps.some(app => app.pid === Number(pid) && app.bundleIdentifier === 'com.apple.calculator')) throw new Error('Calculator process identity changed');
  const windows = JSON.parse(await inspect(inspector, ['windows-for-pid', pid, '--scope', 'on-screen']));
  const visible = windows.filter(window => window.ownerPID === Number(pid) && window.onScreen && window.layer === 0 &&
    window.alpha > 0 && window.bounds?.height > 40 && window.bounds?.width > 40);
  if (!visible.length) throw new Error('Calculator has no visible window on the current Space');
  return { load: checkLoad(), calculatorPid: Number(pid), onScreenWindows: visible.length };
}
