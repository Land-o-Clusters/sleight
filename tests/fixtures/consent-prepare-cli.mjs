// Offline one-shot caller. No native compiler or host is launched.
import { writeFileSync } from 'node:fs';
import { prepareHandHost } from '../../plugins/sleight/lib/direct-browser/host.mjs';
const [sourceRoot, cacheRoot, mode] = process.argv.slice(2);
const ready = await prepareHandHost({ sourceRoot, cacheRoot, tools: async () => true,
  scheduleUpgrade: task => { const timer = setTimeout(task, 1); timer.unref(); },
  compile: async ({ name, binary, recipe }) => {
    process.stdout.write(recipe + ':' + name + '\n');
    if (recipe === 'optimized') await new Promise(resolve => setTimeout(resolve, 60000));
    writeFileSync(binary, 'fixture ' + name, { mode: 0o700 });
  } });
if (ready.status !== 'ready') throw Error(ready.code);
// Stay past the scheduled callback, as an import prompt can, before returning or Ctrl-C.
await new Promise(resolve => setTimeout(resolve, 25));
process.stdout.write('ready\n');
if (mode === 'interrupt') setInterval(() => {}, 1000);
