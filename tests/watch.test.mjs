import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const run = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// watch.sh is a thin launchd wrapper: the logic lives in bench/compat.mjs (tests/compat-mac.test.mjs).
async function harness(t) {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-watch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'bench', '.local/bin']) await mkdir(join(root, dir), { recursive: true });
  await copyFile(new URL('../scripts/watch.sh', import.meta.url), join(root, 'scripts/watch.sh'));
  await writeFile(join(root, '.local/bin/node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  await writeFile(join(root, 'bench/compat.mjs'), "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync(process.env.HOME + '/args.json', JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH }));\n" +
    "process.exitCode = Number(process.env.SLEIGHT_TEST_EXIT || 0);\n");
  return {
    root,
    run: (args = [], exit = '0') => run('/bin/sh', [join(root, 'scripts/watch.sh'), ...args], { env: { ...process.env, HOME: root, PATH: '/usr/bin:/bin', SLEIGHT_TEST_EXIT: exit } }),
    args: async () => JSON.parse(await readFile(join(root, 'args.json'), 'utf8')),
  };
}

test('watch.sh runs the compatibility watch with launchd\'s missing PATH entries and passes flags through', async t => {
  const h = await harness(t);
  await h.run();
  const first = await h.args();
  assert.deepEqual(first.args, ['--watch']);
  assert.match(first.path, new RegExp(`^${h.root}/\\.local/bin:/opt/homebrew/bin:/usr/local/bin:`));
  assert.ok((await stat(join(h.root, 'Library/Logs/sleight'))).isDirectory());
  await h.run(['--force']);
  assert.deepEqual((await h.args()).args, ['--watch', '--force']);
});

test('watch.sh exits with the check\'s status', async t => {
  const h = await harness(t);
  await assert.rejects(h.run([], '1'), err => err.code === 1);
});
