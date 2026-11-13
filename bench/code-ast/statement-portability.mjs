// Run parity from a temporary source tree with no .git directory or history.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = join(homedir(), 'Projects/sleight-wt/ledger/vc/night/lanes-may-test');
while (!existsSync(gate) || existsSync('/tmp/sleight-hold')) await new Promise(resolve => setTimeout(resolve, 60000));
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'lane-ps3-portability-'));
const copied = new Set();
function copy(url) {
  const sourcePath = fileURLToPath(url);
  const path = relative(root, sourcePath);
  if (path.startsWith('..')) throw Error('module escaped repository');
  if (copied.has(path)) return;
  copied.add(path);
  const source = readFileSync(url, 'utf8'), destination = join(directory, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
  for (const match of source.matchAll(/\b(?:from|import)\s*['"](\.[^'"]+)['"]/g)) copy(new URL(match[1], url));
}
try {
  copy(new URL('../../tests/statement-parity.test.mjs', import.meta.url));
  copy(new URL('../../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/statement-parity.test.mjs'],
    { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20 });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  console.log(JSON.stringify({ copiedFiles: copied.size, gitDirectory: existsSync(join(directory, '.git')), exit: child.status }));
  process.exitCode = child.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
