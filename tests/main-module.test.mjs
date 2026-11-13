// Entry points start when their script path reaches the module through a symlink (a symlinked ~/.claude, or /tmp on macOS).
// Before 1.4.2 a plain path comparison made them exit 0 with no output there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../plugins/sleight/lib/main-module.mjs';

const plugin = fileURLToPath(new URL('../plugins/sleight', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'main-module-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('isMainModule matches the script through a symlink and nothing else', t => {
  const dir = scratch(t);
  const real = join(dir, 'real.mjs'), other = join(dir, 'other.mjs');
  writeFileSync(real, ''); writeFileSync(other, '');
  symlinkSync(dir, join(dir, 'link'));
  const url = pathToFileURL(real).href;
  assert.equal(isMainModule(url, real), true);
  assert.equal(isMainModule(url, join(dir, 'link', 'real.mjs')), true);
  assert.equal(isMainModule(url, other), false);
  assert.equal(isMainModule(url, join(dir, 'missing.mjs')), false);
  assert.equal(isMainModule(url, undefined), false);
});

test('the launcher answers a command when its plugin folder is reached through a symlink', t => {
  const dir = scratch(t);
  symlinkSync(plugin, join(dir, 'sleight'));
  const home = join(dir, 'home');
  const run = spawnSync(process.execPath, [join(dir, 'sleight', 'lib', 'launch.mjs'), 'turbo-state'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(typeof JSON.parse(run.stdout).enabled, 'boolean');
});
