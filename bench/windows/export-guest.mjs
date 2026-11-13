import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifest, MANIFEST_NAME, safePath, sha256 } from './guest-integrity.mjs';
import { isMain } from './kit.mjs';

// Include source and fixtures needed by both sitting runbooks. No host state or ledger.
export const EXPORT_PATHS = Object.freeze(['bench/windows', 'plugins/sleight/lib', 'plugins/sleight/bin',
  'plugins/sleight/hooks/narration.mjs', 'plugins/sleight/hooks/stop-notice.mjs',
  // Dependencies imported by the sitting tools and the exported character-stage worker.
  'bench/engine-version.mjs', 'bench/live-lock.mjs', 'bench/rt31-probe.mjs', 'bench/sitting-process.mjs',
  'scripts/windows-plan-compat.mjs',
  ...['stage.mjs', 'lib/atomic-private-file.mjs', 'lib/fx.mjs', 'lib/png.mjs', 'lib/poses.mjs',
    'lib/stage-rig.mjs', 'lib/svg.mjs', 'lib/toon-stage.mjs', 'lib/webp.mjs', 'rigs/critter.mjs',
    'styles/anime.mjs', 'styles/paper.mjs', 'styles/pixel.mjs', 'styles/toon.mjs']
    .map(name => 'plugins/sleight/skills/make-character/tool/' + name),
  'plugins/sleight/vendor', 'plugins/sleight/THIRD-PARTY-NOTICES.md', 'plugins/sleight/.claude-plugin', 'plugins/sleight/.codex-plugin',
  'tests', 'scripts/temp-leftovers.mjs', 'scripts/windows-planner-source.mjs', 'examples/cursor-renderer',
  'package.json', 'LICENSE']);
const git = (root, args, options = {}) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
  maxBuffer: 128 * 1024 * 1024, timeout: 60000, killSignal: 'SIGKILL', ...options,
});
export function exportGuest({ root, revision, output }) {
  root = resolve(root); output = resolve(output);
  if (!revision || !/^[a-f0-9]{7,40}$/.test(revision)) throw Error('Supply a hexadecimal commit SHA');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim()) throw Error('Dirty tree refused, including untracked files');
  if (existsSync(output) || !lstatSync(dirname(output)).isDirectory()) throw Error('Output must be absent with an existing parent');
  const commit = git(root, ['rev-parse', '--verify', revision + '^{commit}'], { encoding: 'utf8' }).trim();
  const entries = git(root, ['ls-tree', '-rz', commit, '--', ...EXPORT_PATHS], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!entries.length) throw Error('No kit files at the selected commit');
  const names = new Set();
  for (const entry of entries) {
    const [header, path] = entry.split('\t'); safePath(path);
    if (!/^100(?:644|755) blob [a-f0-9]{40}$/.test(header) || names.has(path.toLowerCase())) throw Error('Symlink, submodule or case-colliding archive entry refused');
    names.add(path.toLowerCase());
  }
  const stage = mkdtempSync(join(tmpdir(), 'lane-win-export-'));
  try {
    const archive = join(stage, 'source.tar'), kit = join(stage, 'kit'); mkdirSync(kit);
    git(root, ['archive', '--format=tar', '--output=' + archive, commit, '--', ...EXPORT_PATHS]);
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', kit], { timeout: 60000, killSignal: 'SIGKILL' });
    const manifest = createManifest(kit, commit);
    if (manifest.files.length !== entries.length) throw Error(`Extracted file count ${manifest.files.length} does not match ls-tree count ${entries.length}`);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(kit, MANIFEST_NAME), bytes, { flag: 'wx', mode: 0o600 });
    // Recheck cleanliness before publishing. The archive itself is immutable commit data.
    if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim()) throw Error('Tree became dirty during export');
    // Reserve exclusively, then create files exclusively. Preserve partial output on copy failure.
    mkdirSync(output);
    for (const name of readdirSync(kit)) cpSync(join(kit, name), join(output, name), { recursive: true, force: false, errorOnExist: true });
    return { schema: 'sleight.windows-guest-export/1', commit, files: manifest.files.length,
      bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0), manifestSha256: sha256(bytes) };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
export function parseExportArgs(args) {
  if (args.length !== 4 || args[0] !== '--commit' || args[2] !== '--output') throw Error('Usage: export-guest.sh --commit SHA --output NEW_FOLDER');
  return { revision: args[1], output: args[3] };
}
if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(exportGuest({ root: fileURLToPath(new URL('../..', import.meta.url)), ...parseExportArgs(process.argv.slice(2)) }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
