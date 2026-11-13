// Install effect traps before importing the CLI, so dry-run cannot hide writes or subprocesses in its dependencies.
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let processes = 0, writes = 0;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = () => { processes++; throw Error('dry-run launched a process'); };
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'unlinkSync', 'rmSync']) fs[key] = () => { writes++; throw Error('dry-run wrote a file'); };
const originalOpen = fs.openSync;
fs.openSync = (path, flags, ...args) => {
  if (flags !== 'r' && flags !== fs.constants.O_RDONLY) { writes++; throw Error('dry-run opened a file for writing'); }
  return originalOpen(path, flags, ...args);
};
syncBuiltinESMExports();
const { main } = await import('../../bench/hand/check4.mjs');
const plan = await main(['--dry-run'], { print: () => {} });
process.stdout.write(JSON.stringify({ processes, writes, tasks: plan.tasks.length }) + '\n');
