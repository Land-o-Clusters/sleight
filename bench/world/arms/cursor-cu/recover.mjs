// Explicit attended recovery. Normal starts always refuse an existing journal.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armPaths } from './contract.mjs';
import { DesktopDriver } from './desktop.mjs';
import { scrubCursor } from './scrub.mjs';

export async function recover(args, driver = new DesktopDriver()) {
  if (args.length !== 2 || new Set(args).size !== 2 || args.some(a => !['--owner-says-cursor-free', '--previous-run-stopped'].includes(a)))
    throw Error('Cursor recovery requires --owner-says-cursor-free and --previous-run-stopped; verify the old harness is stopped first');
  const clean = await driver.recover({ paths: armPaths(), ownerSaysCursorFree: true }, { previousRunStopped: true });
  if (!clean) throw Error('Cursor journal recovery unverified; journal and enclosing live lock retained');
  return { clean, restoration: scrubCursor(driver.restoration), liveLock: 'unchanged' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let interrupted = false;
  const noteInterrupt = () => { interrupted = true; };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, noteInterrupt);
  try { console.log(JSON.stringify(await recover(process.argv.slice(2)), null, 2)); if (interrupted) process.exitCode = 130; }
  catch (error) { console.error(scrubCursor(error.message)); process.exitCode = 1; }
  finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, noteInterrupt); }
}
