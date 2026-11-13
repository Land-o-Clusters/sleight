// Windowless process-group stand-in for Chromium. stdin EOF is its normal exit.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
if (process.argv.includes('--leaf')) {
  // Bound the test fixture even if a regression stops collecting the group.
  setTimeout(() => process.exit(0), 4000);
  process.send('ready');
  process.disconnect();
} else {
  if (process.argv.includes('--tree') || process.argv.includes('--exited-leader')) {
    const leaf = spawn(process.execPath, [import.meta.filename, '--leaf'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await once(leaf, 'message');
  }
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdout.write('ready\n');
  if (process.argv.includes('--exited-leader')) process.exit(0);
}
