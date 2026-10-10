#!/usr/bin/env node
// Sets up the benchmark's LCU arm folder, outside any git repo (LAWS), from the
// LCU runtime already installed on this Mac. Never downloads or installs
// anything: it runs `lcu setup` from the installed runtime and verifies the
// registration with LCU's own `lcu doctor`, which drives no app and opens no
// Settings pane.
//
//   node bench/lcu-arm-setup.mjs [--project <dir>]
//
// The folder is --project, else LCU_ARM_DIR, else the default bench/run.mjs
// expects (~/Library/Caches/sleight-bench/lcu-arm). LCU's binary is LCU_BIN,
// else the standard prefix's current release (~/.local/share/lcu/current/bin/lcu).
// Python 3.12+ goes first on PATH for the child, LCU_PATH_PREFIX (default
// .dev/py), the same env bench/run.mjs gives the arm.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The git repo a folder belongs to, if any. Checked against the nearest
// existing ancestor, so a not-yet-created folder inside a repo is refused too.
export function assertOutsideRepo(dir) {
  let existing = resolve(dir);
  while (!existsSync(existing)) existing = dirname(existing);
  let repo;
  try {
    repo = execFileSync('/usr/bin/git', ['-C', existing, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return; }
  throw new Error(`${dir} is inside the git repo ${repo}, so the arm's runs would load that repo's CLAUDE.md and project memory. Use a folder outside any repo.`);
}

export function projectDir(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--project');
  return resolve(i >= 0 ? argv[i + 1]
    : process.env.LCU_ARM_DIR || join(homedir(), 'Library', 'Caches', 'sleight-bench', 'lcu-arm'));
}

export function lcuBin() {
  return process.env.LCU_BIN || join(homedir(), '.local', 'share', 'lcu', 'current', 'bin', 'lcu');
}

export function setupArgs(dir) {
  return ['setup', '--agent', 'claude-code', '--scope', 'project', '--project', dir, '--no-chrome', '--no-audio', '--yes'];
}

export function childEnv() {
  const prefix = process.env.LCU_PATH_PREFIX || join(ROOT, '.dev', 'py');
  return { ...process.env, PATH: `${prefix}:${process.env.PATH}` };
}

export function main(argv = process.argv.slice(2)) {
  const dir = projectDir(argv);
  const lcu = lcuBin();
  if (!existsSync(lcu)) throw new Error(`no LCU runtime at ${lcu}. Install LCU first; this script never downloads anything.`);
  assertOutsideRepo(dir);
  mkdirSync(dir, { recursive: true });
  const setup = execFileSync(lcu, setupArgs(dir), { env: childEnv(), encoding: 'utf8' });
  if (setup.trim()) console.log(setup.trim());
  // bench/run.mjs starts the arm with --mcp-config <dir>/.mcp.json and looks
  // for its `lcu` server, so the registration must name it.
  const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
  if (!config.mcpServers?.lcu) throw new Error(`${join(dir, '.mcp.json')} registers no lcu server, which bench/run.mjs needs`);
  execFileSync(lcu, ['doctor'], { env: childEnv(), encoding: 'utf8', stdio: 'inherit' });
  const version = execFileSync(lcu, ['--version'], { env: childEnv(), encoding: 'utf8' }).trim();
  console.log(`LCU arm ready at ${dir}: ${version}`);
  return { dir, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
