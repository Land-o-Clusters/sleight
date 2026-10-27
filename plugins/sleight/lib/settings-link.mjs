// The optional PATH command resolves Claude Code's current install on every invocation.
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const install = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = '# sleight managed settings shim v1';
const shimName = '.sleight-shim-v1';
// Self-contained because a plugin update may remove the version that wrote the shim.
export function resolveShimLauncher({ fs, path, home, config, recorded }) {
  const usable = root => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) return;
    const bin = path.join(root, 'bin/sleight-mcp');
    try { if (fs.statSync(bin).isFile()) { fs.accessSync(bin, fs.constants.X_OK); return bin; } } catch {}
  };
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(config || path.join(home, '.claude'), 'plugins/installed_plugins.json'), 'utf8')).plugins?.['sleight@sleight'];
    const users = Array.isArray(entries) ? entries.filter(e => e.scope === 'user') : [];
    const current = users.length ? users : Array.isArray(entries) ? entries : [];
    if (current.length === 1) { const bin = usable(current[0].installPath); if (bin) return bin; }
  } catch {}
  const fallback = usable(recorded);
  if (fallback) return fallback;
  throw Error('sleight: no installed sleight launcher found. Reinstall sleight, then run its bin/sleight-mcp link in your terminal.');
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function shimText(recorded) {
  const script = `const fs=require('node:fs'),path=require('node:path'),home=require('node:os').userInfo().homedir;try{console.log((${resolveShimLauncher.toString()})({fs,path,home,config:process.env.CLAUDE_CONFIG_DIR,recorded:${JSON.stringify(recorded)}}))}catch(e){console.error(e.message);process.exit(1)}`;
  return `#!/bin/sh\n${marker}\n# installPath: ${JSON.stringify(recorded)}\nAPP_NODE="\${SLEIGHT_CHATGPT_APP:-/Applications/ChatGPT.app}/Contents/Resources/cua_node/bin/node"\nif [ -x "$APP_NODE" ]; then NODE="$APP_NODE"; elif command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; else echo 'sleight: install ChatGPT.app or Node.js to run sleight.' >&2; exit 1; fi\nTARGET="$("$NODE" -e ${quote(script)})" || exit 1\nexec "$TARGET" "$@"\n`;
}
export function managedShim(home = userInfo().homedir) {
  const file = join(home, '.local/bin/sleight');
  try {
    const link = lstatSync(file);
    if (!link.isSymbolicLink() || link.uid !== process.getuid() || readlinkSync(file) !== shimName) return false;
    const target = join(home, '.local/bin', shimName);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > 16384 || !(stat.mode & 0o100) || (stat.mode & 0o022)) return false;
    const text = readFileSync(target, 'utf8');
    const recorded = JSON.parse(text.split('\n')[2]?.replace(/^# installPath: /, ''));
    return typeof recorded === 'string' && text === shimText(recorded);
  } catch { return false; }
}
export const settingsDoctorLine = (home = userInfo().homedir) => `Settings: ${managedShim(home) ? 'sleight menu' : 'sleight-mcp menu'} opens the menu without a session.`;
async function askPerson(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(?:y|yes)$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}
function folders(home) {
  for (const part of ['.local', '.local/bin']) {
    const folder = join(home, part);
    try { mkdirSync(folder, { mode: 0o755 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = lstatSync(folder);
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o022)) throw Error('the link folder must be an ordinary directory owned by you, without group or other write access');
  }
}
export async function linkCommand(op, args, { home = userInfo().homedir, recorded = install, env = process.env,
  ask = askPerson, out = text => process.stdout.write(text) } = {}) {
  if (args.length || !['link', 'unlink'].includes(op)) { out('usage: sleight-mcp link|unlink\n'); return 2; }
  const file = join(home, '.local/bin/sleight');
  if (op === 'unlink') {
    if (!managedShim(home)) { out('No sleight-managed command to remove.\n'); return 0; }
    // Validate parent directories too, before removing anything through them.
    folders(home); unlinkSync(file); unlinkSync(join(home, '.local/bin', shimName)); out('Removed ~/.local/bin/sleight and its managed shim.\n'); return 0;
  }
  if (!managedShim(home)) {
    try { lstatSync(file); out('~/.local/bin/sleight already exists and was not made by sleight. Nothing changed.\n'); return 1; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!await ask('Create ~/.local/bin/sleight so you can run sleight menu? [y/N] ')) { out('No command created.\n'); return 0; }
    folders(home);
    const target = join(home, '.local/bin', shimName);
    // Never replace an unrelated file, including a leftover that cannot be authenticated as our shim.
    writeFileSync(target, shimText(recorded), { mode: 0o700, flag: 'wx' });
    try { symlinkSync(shimName, file); }
    catch (error) { unlinkSync(target); throw error; }
  }
  out('sleight is linked at ~/.local/bin/sleight.\n');
  if (!(env.PATH ?? '').split(':').includes(join(home, '.local/bin'))) out('export PATH="$HOME/.local/bin:$PATH"\n');
  return 0;
}
