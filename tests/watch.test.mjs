import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'sleight-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'plugins/sleight/bin', 'bench', '.local/bin']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['watch.sh', 'engine-docs.mjs']) await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  const server = fileURLToPath(new URL('./fixtures/engine-docs-server.mjs', import.meta.url));
  await writeFile(join(root, 'plugins/sleight/bin/sleight-mcp'), `#!/bin/sh\nif [ "$1" = --doctor ]; then\n  echo "Codex computer-use $SLEIGHT_TEST_VERSION"\nelse\n  exec ${quote(process.execPath)} ${quote(server)} "$SLEIGHT_TEST_MODE"\nfi\n`, { mode: 0o755 });
  await writeFile(join(root, '.local/bin/node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  await writeFile(join(root, '.local/bin/osascript'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.SLEIGHT_TEST_NOTIFICATIONS, process.argv.slice(2).join(' ') + '\\n');\n`, { mode: 0o755 });
  await writeFile(join(root, 'bench/run.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.SLEIGHT_TEST_BENCH_LOG, 'bench\\n');\nconsole.log('PASS calculator-click');\n");
  const logs = join(root, 'Library/Logs/sleight');
  const read = name => readFile(join(logs, name), 'utf8');
  return {
    logs, read,
    run: (version, mode = 'docs', force = '') => run('/bin/sh', [join(root, 'scripts/watch.sh')], { env: {
      ...process.env, HOME: root, SLEIGHT_TEST_VERSION: version, SLEIGHT_TEST_MODE: mode,
      SLEIGHT_WATCH_FORCE: force, SLEIGHT_TEST_CAPTURE_LOG: join(root, 'captures'),
      SLEIGHT_TEST_NOTIFICATIONS: join(root, 'notifications'), SLEIGHT_TEST_BENCH_LOG: join(root, 'benchmarks'),
    } }).catch(async err => {
      err.message += '\n' + await read('watch.log');
      throw err;
    }),
    captures: () => readFile(join(root, 'captures'), 'utf8'),
    benchmarks: () => readFile(join(root, 'benchmarks'), 'utf8'),
    notifications: () => readFile(join(root, 'notifications'), 'utf8'),
  };
}

test('watch saves a baseline, skips unchanged versions, and notifies with the new API diff', async t => {
  const h = await harness(t);
  await h.run('1.0');
  assert.match(await h.read('engine-api-1.0.md'), /Version 1\.0/);
  assert.equal(await h.read('watch-engine-version'), '1.0\n');
  await assert.rejects(h.benchmarks(), /ENOENT/);
  await h.run('1.0');
  assert.equal(await h.captures(), 'capture\n');
  await h.run('2.0');
  const diff = await h.read('engine-api-2.0.diff');
  assert.match(diff, /^--- .*engine-api-1\.0\.md/m);
  assert.match(diff, /^\+\+\+ .*engine-api-2\.0\.md/m);
  assert.match(diff, /^-Version 1\.0/m);
  assert.match(diff, /^\+Version 2\.0/m);
  assert.match(await h.notifications(), /API diff: .*engine-api-2\.0\.diff/);
  assert.equal(await h.benchmarks(), 'bench\n');
  assert.equal(await h.read('watch-engine-version'), '2.0\n');
});

test('failed docs capture preserves the previous version and snapshot for retry', async t => {
  const h = await harness(t);
  await h.run('1.0');
  await assert.rejects(h.run('2.0', 'rpc-error'), err => err.code === 1);
  assert.equal(await h.read('watch-engine-version'), '1.0\n');
  assert.match(await h.read('engine-api-1.0.md'), /Version 1\.0/);
  assert.deepEqual((await readdir(h.logs)).sort(), ['engine-api-1.0.md', 'watch-engine-version', 'watch.log']);
  assert.match(await h.notifications(), /API docs capture failed/);
  await assert.rejects(h.benchmarks(), /ENOENT/);
  await h.run('2.0');
  assert.match(await h.read('engine-api-2.0.diff'), /^\+Version 2\.0/m);
});

test('upgrading an older watch reports an unavailable previous snapshot', async t => {
  const h = await harness(t);
  await mkdir(h.logs, { recursive: true });
  await writeFile(join(h.logs, 'watch-engine-version'), '0.9\n');
  await h.run('1.0');
  assert.match(await h.notifications(), /previous API snapshot unavailable/);
  assert.match(await h.read('engine-api-1.0.md'), /Version 1\.0/);
});

test('force runs the benchmark without replacing the current API snapshot', async t => {
  const h = await harness(t);
  await h.run('1.0');
  await h.run('1.0', 'docs', '1');
  assert.equal(await h.captures(), 'capture\n');
  assert.equal(await h.benchmarks(), 'bench\n');
});
