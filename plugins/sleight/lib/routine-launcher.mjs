// Copied to a stable user-data path at explicit installation; no versioned imports.
import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function resolveInstall(home = userInfo().homedir) {
  const registry = JSON.parse(readFileSync(join(home, '.claude/plugins/installed_plugins.json'), 'utf8'));
  const entries = (registry.plugins?.['sleight@sleight'] ?? []).filter(entry => entry.scope === 'user');
  if (entries.length !== 1 || typeof entries[0].installPath !== 'string') throw new Error('current user Sleight install is missing or ambiguous in the plugin registry');
  const root = entries[0].installPath;
  if (resolve(root) !== root) throw new Error('plugin install path must be absolute');
  for (const candidate of [join(root, 'bin/sleight-mcp'), join(root, 'plugins/sleight/bin/sleight-mcp')]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('current Sleight install has no launcher');
}
async function notifyFailure(message) {
  await promisify(execFile)('/usr/bin/osascript', ['-e',
    `display notification ${JSON.stringify(message)} with title "sleight routine could not start"`], { timeout: 5000 });
}
export async function launchRoutine(id, { home = userInfo().homedir, notify = notifyFailure, spawnChild = spawn } = {}) {
  try {
    if (!/^[a-f0-9]{20}$/.test(id ?? '')) throw new Error('invalid routine ID');
    const bin = resolveInstall(home);
    const child = spawnChild(bin, ['routine', 'run-now', id, '--scheduled'], { stdio: 'inherit' });
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
  } catch (error) {
    process.stderr.write(`sleight: current plugin install or registry unavailable: ${error.message}\n`);
    try { await notify(`Current plugin install or registry unavailable: ${error.message}`); }
    catch (failure) { process.stderr.write(`sleight: notification failed: ${failure.message}\n`); }
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await launchRoutine(process.argv[2]);
