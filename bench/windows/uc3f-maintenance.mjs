// Headless VM kit maintenance. Own the SSH child, guard and cooperative lock.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLiveLock } from '../live-lock.mjs';
import { startGuard, noHold } from '../sitting-process.mjs';
import { verifyNetwork } from './uc3f-sitting.mjs';
import { runChild, isMain } from './kit.mjs';

function readFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('MAINTENANCE_FILE_REFUSED');
  return readFileSync(path, 'utf8');
}
export async function runMaintenance(options, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin' || !(dependencies.env ?? process.env).CLAUDE_CONFIG_DIR)
    throw Error('ISOLATED_MAC_HOST_REQUIRED');
  if (!!options.script === !!options.copyKit) throw Error('MAINTENANCE_OPERATION_REQUIRED');
  const read = dependencies.readFile ?? readFile, hold = dependencies.noHold ?? noHold;
  const address = verifyNetwork(read(options.sshConfig), 'vm');
  const input = options.script ? read(options.script) : '';
  if (options.copyKit) read(join(options.copyKit, 'guest-manifest.json'));
  let unlock, guard, reason, result, failure;
  const controller = new AbortController();
  const check = async () => {
    hold(); if (reason) throw Error(reason);
    const sample = await guard.check();
    if (!Number.isFinite(sample.hidIdleMs) || sample.hidIdleMs < 30000) throw Error('PERSON_ACTIVE');
    hold(); if (reason) throw Error(reason);
  };
  try {
    hold();
    unlock = await (dependencies.acquireLiveLock ?? acquireLiveLock)();
    // SSH and SCP only. No Mac key or click is posted, so a banner cannot ride an input step.
    guard = (dependencies.startGuard ?? startGuard)(join(options.tools, 'guard'), { kind: 'uc3f-away', blockSeconds: 9000,
      exemptSystemOverlay: true, onStop: code => { reason ??= code; controller.abort(); } });
    await guard.start(); await check();
    const pinned = [`HostName=${address}`, 'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no',
      'ClearAllForwardings=yes', 'RemoteCommand=none', 'StrictHostKeyChecking=yes', 'BatchMode=yes', 'ConnectTimeout=10'].flatMap(value => ['-o', value]);
    const args = ['-F', options.sshConfig, ...pinned,
      ...options.copyKit ? ['-q', '-r', options.copyKit, 'vm:C:/sleight'] : ['vm', 'powershell -NoProfile -NonInteractive -Command -']];
    const child = dependencies.runChild ?? runChild;
    if (options.copyKit) {
      const absent = await child('/usr/bin/ssh', ['-F', options.sshConfig, ...pinned, 'vm', 'powershell -NoProfile -NonInteractive -Command -'],
        { input: "& { if (Test-Path -LiteralPath 'C:\\sleight') { exit 1 }; [Console]::Out.WriteLine('DESTINATION_ABSENT') }\n\n",
          timeout: 30000, maxBytes: 4096, signal: controller.signal });
      if (absent.status !== 0 || absent.signal || absent.reason || !absent.stdout.includes('DESTINATION_ABSENT')) throw Error('MAINTENANCE_FAILED');
      await check();
    }
    result = await child(options.copyKit ? '/usr/bin/scp' : '/usr/bin/ssh', args,
      { input, timeout: 120000, maxBytes: 1024 * 1024, signal: controller.signal });
    await check();
    if (result.status !== 0 || result.signal || result.reason) throw Object.assign(Error('MAINTENANCE_FAILED'), { result });
  } catch (error) {
    failure = error;
  } finally {
    // A rejected guard close must not skip the lock release.
    try { await guard?.close(); } catch (error) { failure ??= error; }
    try { await unlock?.(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr,
    systemOverlays: (guard.records ?? []).filter(r => r.record === 'system-overlay').map(r => ({
      state: r.state, pid: r.pid, window: r.window, layer: r.layer, timeUtcMs: r.timeUtcMs, onscreenMs: r.onscreenMs,
    })) };
}
export function parseMaintenanceArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--ssh-config': 'sshConfig', '--tools': 'tools', '--script': 'script', '--copy-kit': 'copyKit' }[args[i]];
    if (!key || !args[i + 1] || options[key]) throw Error('MAINTENANCE_ARGUMENTS');
    options[key] = args[i + 1];
  }
  if (!options.sshConfig || !options.tools || !!options.script === !!options.copyKit) throw Error('MAINTENANCE_ARGUMENTS');
  return options;
}
if (isMain(import.meta.url)) runMaintenance(parseMaintenanceArgs(process.argv.slice(2)))
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); if (error.result) console.error(JSON.stringify(error.result)); process.exitCode = 1; });
