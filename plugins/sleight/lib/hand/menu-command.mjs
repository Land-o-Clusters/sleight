// The own-terminal gate runs in launch.mjs before this command is dispatched.
import { fork } from 'node:child_process';
import { handHostBuilt, prepareHandHost } from '../direct-browser/host.mjs';

export const menuMessage = "sleight's menu is in the menu bar. Choose Quit Menu to close it.\n";
export async function menuCommand(args, { out = text => process.stdout.write(text), built = handHostBuilt,
  prepare = prepareHandHost, start = startMenuWorker, platform = process.platform } = {}) {
  if (args.length) { out('usage: sleight-mcp menu\n'); return 2; }
  if (platform !== 'darwin') { out('sleight menu requires macOS.\n'); return 1; }
  if (!built()) out('Compiling sleight\'s menu host for first use.\n');
  const result = await prepare();
  if (result.status !== 'ready') { out(`sleight menu could not start: ${result.code ?? 'HOST_UNAVAILABLE'}.\n`); return 1; }
  try {
    const existing = await start();
    out(existing ? "sleight's menu is already in the menu bar.\n" : menuMessage);
    return 0;
  } catch (error) { out(`sleight menu could not start: ${error.message}.\n`); return 1; }
}
export function startMenuWorker() {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./menu-worker.mjs', import.meta.url), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    let done = false;
    const finish = (error, existing) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error); else resolve(existing);
    };
    const timer = setTimeout(() => finish(Error('MENU_START_TIMEOUT')), 15000);
    child.once('error', error => finish(error));
    child.once('exit', () => finish(Error('MENU_HOST_EXITED')));
    child.on('message', message => {
      if (message?.ready === true && typeof message.existing === 'boolean') finish(undefined, message.existing);
      else finish(Error('MENU_HOST_UNAVAILABLE'));
    });
  });
}
