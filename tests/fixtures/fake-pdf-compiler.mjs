import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, mode, behavior] = process.argv.slice(2);
if (mode === 'exit') {
  process.stderr.write('fixture compiler diagnostic\n'); process.exitCode = 3;
} else if (mode === 'child') {
  writeFileSync(join(root, 'ready.json'), JSON.stringify({ pid: process.pid, parent: process.ppid }));
  if (behavior === 'stdout' || behavior === 'stderr') process[behavior].write('x'.repeat(65537));
  // A leaked child holds the compiler pipes and leaves evidence before exiting.
  setTimeout(() => { writeFileSync(join(root, 'survived'), 'child survived'); process.exit(0); }, 4000);
} else {
  spawn(process.execPath, [import.meta.filename, root, 'child', behavior], { stdio: ['ignore', 'inherit', 'inherit'] });
  setInterval(() => {}, 1000);
}
