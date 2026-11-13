// Benchmark builds keep menu locks, display slots and decoded strips in their owned temporary bank.
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
export function privateStageHome(source, work) {
  if (resolve(work) !== work) throw Error('Stage benchmark home needs an ordinary private temporary bank');
  const canonical = realpathSync(work), roots = ['/private/tmp', realpathSync(tmpdir())];
  if (!roots.some(root => canonical.startsWith(root + '/')) || !/^[/a-zA-Z0-9_.-]+$/.test(canonical))
    throw Error('Stage benchmark home needs an ordinary private temporary bank');
  const home = join(canonical, 'host-home'); mkdirSync(home, { mode: 0o700 });
  return `let stageBenchHome = URL(fileURLWithPath: "${home}")\n` +
    source.replaceAll('FileManager.default.homeDirectoryForCurrentUser', 'stageBenchHome')
      .replaceAll('NSHomeDirectory()', 'stageBenchHome.path');
}
