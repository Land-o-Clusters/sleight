// The optional PATH command resolves Claude Code's current install on every invocation.
import * as fs from 'node:fs';
import { userInfo } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const install = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const marker = '# sleight managed settings shim v1';
const shimName = '.sleight-shim-v1';
const receiptName = 'settings-link.json';
const privateFolder = home => path.join(home, 'Library/Application Support/sleight');
// Self-contained because a plugin update may remove the version that wrote the shim. All components from the user's
// home to the executable must be ordinary, owned by that user and not writable by a group or anyone else.
export function resolveShimLauncher({ fs, path, home, config, recorded, uid = process.getuid() }) {
  const within = (file, root) => file.startsWith(root + path.sep);
  const safe = file => {
    if (!path.isAbsolute(file) || path.normalize(file) !== file || !within(file, home)) return false;
    for (let part = home;;) {
      const st = fs.lstatSync(part);
      if (st.isSymbolicLink() || st.uid !== uid || st.mode & 0o022 || (part === file ? !st.isFile() || st.nlink !== 1 : !st.isDirectory())) return false;
      if (part === file) return fs.realpathSync(file) === file;
      const next = path.relative(part, file).split(path.sep)[0];
      part = path.join(part, next);
    }
  };
  const cache = path.join(config || path.join(home, '.claude'), 'plugins/cache');
  const usable = (root, current = false) => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) return;
    if (current && (!within(root, cache) || path.relative(cache, root).split(path.sep)[1] !== 'sleight')) return;
    const bin = path.join(root, 'bin/sleight-mcp'), manifest = path.join(root, '.claude-plugin/plugin.json');
    try {
      if (!safe(bin) || !safe(manifest) || fs.lstatSync(manifest).size > 65536 ||
          JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== 'sleight') return;
      fs.accessSync(bin, fs.constants.X_OK); return bin;
    } catch {}
  };
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(config || path.join(home, '.claude'), 'plugins/installed_plugins.json'), 'utf8')).plugins?.['sleight@sleight'];
    const users = Array.isArray(entries) ? entries.filter(e => e?.scope === 'user') : [];
    if (users.length === 1) { const bin = usable(users[0].installPath, true); if (bin) return bin; }
  } catch {}
  const fallback = usable(recorded);
  if (fallback) return fallback;
  throw Error('sleight: no installed sleight launcher found. Reinstall sleight, then run its bin/sleight-mcp link in your terminal.');
}
// Shared by recognition and the installed script. HOME cannot redirect this receipt: link records the OS home in the shim.
export function verifyShim({ fs, path, createHash, home, self, uid = process.getuid() }) {
  const folder = path.join(home, 'Library/Application Support/sleight');
  const target = path.join(home, '.local/bin/.sleight-shim-v1');
  const receipt = path.join(folder, 'settings-link.json');
  try {
    for (const directory of [home, path.join(home, 'Library'), path.join(home, 'Library/Application Support'), folder, path.join(home, '.local'), path.join(home, '.local/bin')]) {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.uid !== uid || st.mode & 0o022 || fs.realpathSync(directory) !== directory ||
          directory === folder && (st.mode & 0o7777) !== 0o700) throw Error();
    }
    if (fs.realpathSync(self) !== target) throw Error();
    const read = (file, mode, limit) => {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || (before.mode & 0o7777) !== mode || before.size > limit) throw Error();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode || opened.uid !== uid ||
            opened.nlink !== 1 || bytes.length > limit || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw Error();
        return bytes;
      } finally { fs.closeSync(fd); }
    };
    const record = JSON.parse(read(receipt, 0o600, 4096));
    if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.sha256) ||
        createHash('sha256').update(read(target, 0o700, 32768)).digest('hex') !== record.sha256) throw Error();
    return true;
  } catch { throw Error('sleight: shim integrity check failed. Relink sleight from its installed launcher in your terminal.'); }
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function shimText(recorded, home = userInfo().homedir) {
  const script = `const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),home=${JSON.stringify(home)};try{(${verifyShim.toString()})({fs,path,createHash,home,self:process.argv[1]});console.log((${resolveShimLauncher.toString()})({fs,path,home,config:process.env.CLAUDE_CONFIG_DIR,recorded:${JSON.stringify(recorded)}}))}catch(e){console.error(e.message);process.exit(1)}`;
  return `#!/bin/sh\n${marker}\n# installPath: ${JSON.stringify(recorded)}\nAPP_NODE="\${SLEIGHT_CHATGPT_APP:-/Applications/ChatGPT.app}/Contents/Resources/cua_node/bin/node"\nif [ -x "$APP_NODE" ]; then NODE="$APP_NODE"; elif command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; else echo 'sleight: install ChatGPT.app or Node.js to run sleight.' >&2; exit 1; fi\nTARGET="$("$NODE" -e ${quote(script)} "$0")" || exit 1\nexec "$TARGET" "$@"\n`;
}
export function managedShim(home = userInfo().homedir) {
  const file = path.join(home, '.local/bin/sleight');
  try {
    const link = fs.lstatSync(file);
    if (!link.isSymbolicLink() || link.uid !== process.getuid() || fs.readlinkSync(file) !== shimName) return false;
    verifyShim({ fs, path, createHash, home, self: file });
    const text = fs.readFileSync(path.join(home, '.local/bin', shimName), 'utf8');
    const recorded = JSON.parse(text.split('\n')[2]?.replace(/^# installPath: /, ''));
    // The private receipt authenticates the installed bytes. Comparing against this version's generator would stop
    // recognizing a valid shim as soon as a plugin update changed the embedded resolver.
    return text.split('\n')[1] === marker && typeof recorded === 'string' && path.isAbsolute(recorded) && path.normalize(recorded) === recorded;
  } catch { return false; }
}
export const settingsDoctorLine = (home = userInfo().homedir, env = process.env) =>
  `Settings: ${managedShim(home) && (env.PATH ?? '').split(':').includes(path.join(home, '.local/bin')) ? 'sleight menu' : 'sleight-mcp menu'} opens the menu without a session.`;
function askPerson(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once('close', () => resolve(false));
    rl.question(question, answer => { resolve(/^(?:y|yes)$/i.test(answer.trim())); rl.close(); });
  });
}
function folders(home, privateSettings = false) {
  const parts = privateSettings ? ['Library', 'Library/Application Support', 'Library/Application Support/sleight'] : ['.local', '.local/bin'];
  for (const part of parts) {
    const folder = path.join(home, part), mode = privateSettings ? 0o700 : 0o755;
    try { fs.mkdirSync(folder, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(folder);
    if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o022 || fs.realpathSync(folder) !== folder ||
        folder === privateFolder(home) && (st.mode & 0o7777) !== 0o700) throw Error('the link folder must be an ordinary directory owned by you, without group or other write access');
  }
}
export async function linkCommand(op, args, { home = userInfo().homedir, recorded = install, env = process.env,
  ask = askPerson, out = text => process.stdout.write(text) } = {}) {
  if (args.length || !['link', 'unlink'].includes(op)) { out('usage: sleight-mcp link|unlink\n'); return 2; }
  const file = path.join(home, '.local/bin/sleight'), target = path.join(home, '.local/bin', shimName), receipt = path.join(privateFolder(home), receiptName);
  if (op === 'unlink') {
    if (!managedShim(home)) { out('No sleight-managed command to remove.\n'); return 0; }
    // Remove the executable first so a partial unlink cannot leave an executable orphan that blocks relinking.
    folders(home); fs.unlinkSync(target); fs.unlinkSync(file); fs.unlinkSync(receipt);
    out('Removed ~/.local/bin/sleight and its managed shim.\n'); return 0;
  }
  if (!managedShim(home)) {
    try { fs.lstatSync(file); out('~/.local/bin/sleight already exists and was not made by sleight. Nothing changed.\n'); return 1; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { fs.lstatSync(target); out('The shim already exists at ~/.local/bin/.sleight-shim-v1. Remove it in your terminal before relinking. Nothing changed.\n'); return 1; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { fs.lstatSync(receipt); out('The integrity receipt already exists at ~/Library/Application Support/sleight/settings-link.json. Remove it in your terminal before relinking. Nothing changed.\n'); return 1; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!await ask('Create ~/.local/bin/sleight so you can run sleight menu? [y/N] ')) { out('No command created.\n'); return 0; }
    folders(home); folders(home, true);
    const text = shimText(recorded, home);
    fs.writeFileSync(target, text, { mode: 0o700, flag: 'wx' });
    let saved = false;
    try {
      fs.writeFileSync(receipt, JSON.stringify({ version: 1, sha256: createHash('sha256').update(text).digest('hex') }) + '\n', { mode: 0o600, flag: 'wx' });
      saved = true; fs.symlinkSync(shimName, file);
    } catch (error) { fs.unlinkSync(target); if (saved) fs.unlinkSync(receipt); throw error; }
  }
  out('sleight is linked at ~/.local/bin/sleight.\n');
  if (!(env.PATH ?? '').split(':').includes(path.join(home, '.local/bin'))) out('export PATH="$HOME/.local/bin:$PATH"\n');
  return 0;
}
