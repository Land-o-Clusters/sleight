// Gated Windows diagnostic. A checkout edits its source manifest; plugin updates replace cached edits.
import { readFileSync, writeFileSync, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { win32Environment } from './platform/paths.mjs';
import { windowsSettingsRefusal } from './windows-settings.mjs';

export function windowsManifest(manifest, { root, node, version = process.versions.node } = {}) {
  if (manifest?.name !== 'sleight' || !manifest.mcpServers?.computer ||
      !/^\d+\.\d+\.\d+$/.test(version) || Number(version.split('.')[0]) < 24 ||
      [root, node].some(value => typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || /[\x00-\x1f]/.test(value)) ||
      win32.basename(node).toLowerCase() !== 'node.exe') throw Error('WINDOWS_REGISTRATION_INVALID');
  return { ...manifest, mcpServers: { ...manifest.mcpServers, computer: {
    command: win32.normalize(node), args: [win32.join(root, 'lib', 'launch.mjs')],
    env: { NODE_OPTIONS: '', NODE_PATH: '' },
  } } };
}

export function inspectWindowsNode(node, { platform = process.platform, run = execFileSync, environment } = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  const env = environment ?? win32Environment();
  const source = '$sleightInspect = $true\n' + readFileSync(new URL('windows-node.ps1', import.meta.url), 'utf8');
  const reply = run(win32.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { input: JSON.stringify({ node }), encoding: 'utf8', timeout: 20000, maxBuffer: 4096, windowsHide: true, env,
      cwd: win32.join(env.SystemRoot, 'System32'), stdio: ['pipe', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  return JSON.parse(reply.replace(/^\uFEFF/, '')).ok === true;
}

export async function registerWindowsPlugin({ platform = process.platform, root = fileURLToPath(new URL('../', import.meta.url)),
  node = process.execPath, out = text => process.stdout.write(text), refuse = windowsSettingsRefusal,
  inspectNode = inspectWindowsNode, ...options } = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  try {
    const refusal = await refuse(['register'], options);
    if (refusal) { out(refusal + '\n'); return 3; }
    if (inspectNode(node, { platform }) !== true) throw Error('WINDOWS_REGISTRATION_UNSAFE');
    const file = win32.join(root, '.claude-plugin', 'plugin.json');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        realpathSync.native(file).toLowerCase() !== win32.normalize(file).toLowerCase()) throw Error('WINDOWS_REGISTRATION_UNSAFE');
    const manifest = windowsManifest(JSON.parse(readFileSync(file, 'utf8')), { root, node });
    const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      renameSync(temp, file);
    } finally { try { unlinkSync(temp); } catch {} }
    out('Registered this sleight copy for Windows diagnosis. Start a new Claude Code session. Plugin updates replace this edit.\n');
    return 0;
  } catch (error) {
    out(error.message === 'WINDOWS_REGISTRATION_INVALID'
      ? 'Registration refused: use Node 24 or later and an absolute Windows plugin folder.\n'
      : 'Registration refused: the Node location or plugin manifest is unsafe or unreadable. Use a regular node.exe in Program Files, outside a project and with no reparse points.\n');
    return 1;
  }
}
