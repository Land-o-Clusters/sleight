// Exercise the real CLI/module graph and stop at a synthetic driver import.
// No host subprocess, socket, fixture or cooperative live-lock access is allowed.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

Object.defineProperty(process, 'platform', { value: 'darwin' });
const denied = () => { throw Error('CLI_HOST_ACCESS_FORBIDDEN'); };
const existsSync = fs.existsSync;
fs.existsSync = path => {
  if (path === '/tmp/sleight-hold') return false;
  if (String(path).includes('sleight-live.lock')) denied();
  return existsSync(path);
};
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = denied;
net.connect = denied; net.createConnection = denied; net.Server.prototype.listen = denied;
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.env.RT30_CLI_SCENARIO && context.parentURL?.endsWith('/bench/runtime-probe.mjs') &&
        specifier === './runtime-probe-live.mjs') return {
      url: new URL('./runtime-probe-cli-backend.mjs', import.meta.url).href, shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/plugins/sleight/lib/mac-driver/client.mjs')) return {
      format: 'module', shortCircuit: true,
      source: `export function createMacDriverClient() {}\nthrow Error('FAKE_DRIVER_REFUSED');`,
    };
    if (url.endsWith('/bench/live-lock.mjs')) return {
      format: 'module', shortCircuit: true, source: process.env.RT30_CLI_SCENARIO
        ? `export const acquireLiveLock = async () => async () => {};`
        : `export const acquireLiveLock = () => { throw Error('CLI_LOCK_ACCESS_FORBIDDEN'); };`,
    };
    return nextLoad(url, context);
  },
});
