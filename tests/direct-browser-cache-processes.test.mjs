import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('kernel cache inventory returns usable executable paths on this host', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-cache-processes-'))));
  t.after(() => removeTemp(root));
  const modules = join(root, 'modules'), binary = join(root, 'peer-host'); mkdirSync(modules);
  execFileSync('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', '-fmodules-cache-path=' + modules,
    new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url).pathname, '-lbsm', '-o', binary], { timeout: 30000, killSignal: 'SIGKILL' });
  const scan = spawnSync(binary, ['--cache-processes'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' });
  assertChildStatus(scan, 0, `inventory stderr: ${scan.stderr}`);
  const rows = JSON.parse(scan.stdout);
  assert.ok(rows.some(row => row.pid === process.pid && row.path === realpathSync(process.execPath)));
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['path', 'pid']);
  t.diagnostic(`real host scan: exit ${scan.status}, ${rows.length} usable executable paths, ${Buffer.byteLength(scan.stdout)} output bytes`);
  if (scan.stderr.trim()) t.diagnostic(scan.stderr.trim());
  const row = JSON.parse(execFileSync(binary, ['--process-pid', String(process.pid), realpathSync(process.execPath)], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }));
  assert.equal(row.pid, process.pid);
});

test('native process scan handles escaped paths, vanished processes and uncertainty', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-cache-processes-'))));
  t.after(() => removeTemp(root));
  const header = join(root, 'process-fixture.h'), binary = join(root, 'peer-host');
  writeFileSync(header, `
#include <libproc.h>
#include <sys/proc.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
static int fixture_list(uint32_t type, uint32_t info, void *buffer, int size) {
  if (type != PROC_ALL_PIDS || info != 0) return -1;
  if (!strcmp(getenv("CACHE_SCENARIO"), "list-failed")) { errno = EPERM; return -1; }
  if (!buffer) return 3 * sizeof(pid_t);
  if (!strcmp(getenv("CACHE_SCENARIO"), "list-read-failed")) { errno = EIO; return -1; }
  if (!strcmp(getenv("CACHE_SCENARIO"), "overflow")) return size;
  pid_t ids[] = {101, 102, 103}; memcpy(buffer, ids, sizeof(ids)); return sizeof(ids);
}
static int fixture_path(int pid, void *buffer, uint32_t size) {
  if (size != PROC_PIDPATHINFO_MAXSIZE - 1) { errno = EINVAL; return 0; }
  const char *scenario = getenv("CACHE_SCENARIO");
  if (pid == 102 && strcmp(scenario, "paths")) {
    errno = !strcmp(scenario, "enoent") ? ENOENT : !strcmp(scenario, "esrch") ? ESRCH
      : !strcmp(scenario, "eio") ? EIO : !strcmp(scenario, "eacces") ? EACCES
      : !strcmp(scenario, "no-errno") ? 0 : EPERM;
    return 0;
  }
  const char *path = pid == 101 ? "/cache/quote\\\"slash\\\\line\\n/consent-host" : "/fixture/node";
  size_t length = strlen(path) + 1; if (length > size) return 0;
  memcpy(buffer, path, length); return (int)length;
}
static int fixture_info(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)pid; (void)flavor; (void)arg;
  if (!strcmp(getenv("CACHE_SCENARIO"), "unknown-uid")) { errno = ESRCH; return 0; }
  if (size != sizeof(struct proc_bsdinfo)) return 0;
  struct proc_bsdinfo info; memset(&info, 0, sizeof(info));
  info.pbi_status = !strcmp(getenv("CACHE_SCENARIO"), "zombie") ? SZOMB : SRUN;
  info.pbi_uid = getuid() + (!strcmp(getenv("CACHE_SCENARIO"), "other-uid-eperm") ? 1 : 0);
  errno = EBUSY; /* proc_pidinfo must not overwrite the proc_pidpath error used by policy. */
  memcpy(buffer, &info, sizeof(info)); return sizeof(info);
}
#define proc_listpids fixture_list
#define proc_pidpath fixture_path
#define proc_pidinfo fixture_info
`);
  execFileSync('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', '-include', header,
    new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url).pathname, '-lbsm', '-o', binary], { timeout: 30000, killSignal: 'SIGKILL' });
  for (const scenario of ['paths', 'enoent', 'esrch', 'other-uid-eperm', 'same-uid-eperm', 'eio', 'eacces',
    'no-errno', 'unknown-uid', 'zombie', 'list-failed', 'list-read-failed', 'overflow']) await t.test(scenario, () => {
    const scan = spawnSync(binary, ['--cache-processes'], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, CACHE_SCENARIO: scenario }, killSignal: 'SIGKILL' });
    const refuses = !['paths', 'enoent', 'esrch', 'other-uid-eperm'].includes(scenario);
    assertChildStatus(scan, refuses ? 65 : 0);
    if (refuses) assert.equal(scan.stdout, '');
    else {
      const rows = JSON.parse(scan.stdout);
      assert.equal(rows[0].path, '/cache/quote"slash\\line\n/consent-host');
      assert.deepEqual(rows.map(row => row.pid), scenario === 'paths' ? [101, 102, 103] : [101, 103]);
    }
    if (['enoent', 'esrch', 'other-uid-eperm', 'same-uid-eperm', 'eio', 'eacces'].includes(scenario)) {
      const errno = { enoent: 2, esrch: 3, 'other-uid-eperm': 1, 'same-uid-eperm': 1, eio: 5, eacces: 13 }[scenario];
      const uid = process.getuid() + (scenario === 'other-uid-eperm' ? 1 : 0);
      assert.match(scan.stderr, new RegExp(`pid 102, uid ${uid}, errno ${errno}\\b`));
    }
  });
});
