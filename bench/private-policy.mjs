import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_LOGGING_OVERRIDES } from './driver.mjs';

const authKeys = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

// Managed policy outranks flag settings. A private pass refuses its presence
// rather than executing policy helpers or guessing whether it logs mail.
export function assertPrivateClaudePolicy({ home = homedir(), username = userInfo().username,
  stat = lstatSync, read = readFileSync, list = readdirSync,
  configDirs = [join(home, 'Library', 'Caches', 'sleight-bench', 'claude-config')] } = {}) {
  try {
    const metadata = path => {
      try { const value = stat(path); if (value.isSymbolicLink()) throw new Error(); return value; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    for (const path of ['/Library/Application Support/ClaudeCode/managed-settings.json',
      `/Library/Managed Preferences/${username}/com.anthropic.claudecode.plist`,
      '/Library/Managed Preferences/com.anthropic.claudecode.plist']) {
      if (metadata(path)) throw new Error();
    }
    // claude.ai writes remote-settings.json even when the account has no managed settings, as `{}`
    // (here and in the benchmark's config folder, 2026-10-11). Only an empty one passes.
    for (const path of [join(home, '.claude', 'remote-settings.json'), ...configDirs.map(dir => join(dir, 'remote-settings.json'))]) {
      const remote = metadata(path);
      if (!remote) continue;
      if (!remote.isFile() || remote.size > 65536) throw new Error();
      const value = JSON.parse(read(path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error();
    }
    const directory = '/Library/Application Support/ClaudeCode/managed-settings.d';
    const directoryInfo = metadata(directory);
    if (directoryInfo && (!directoryInfo.isDirectory() || list(directory).some(name => !name.startsWith('.') && name.endsWith('.json')))) throw new Error();
    const globalFile = join(home, '.claude.json'), info = metadata(globalFile);
    if (!info) return;
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error();
    const config = JSON.parse(read(globalFile, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    if (['hooks', 'processWrapper', 'policyHelper', 'policyHelpers'].some(key => key in config)) throw new Error();
    if (config.env != null && (typeof config.env !== 'object' || Array.isArray(config.env) ||
      Object.entries(config.env).some(([key, value]) => typeof value !== 'string' ||
        !authKeys.has(key) && !Object.hasOwn(PRIVATE_LOGGING_OVERRIDES, key)))) throw new Error();
  } catch { throw new Error('PRIVATE_MAIL_POLICY_UNPROVED'); }
}
