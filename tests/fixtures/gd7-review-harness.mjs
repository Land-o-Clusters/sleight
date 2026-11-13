const macHome = '/' + ['Users', 'u'].join('/');
// Candidate commands are data. Nothing in either bank is executed.
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';
export { bank as ordinaryCommands } from './gd7-ordinary-bank.mjs';
import { banks } from './gd7-bypass-bank.mjs';
export const bypassBanks = Object.fromEntries(Object.entries(banks).map(([name, cases]) => [name, [...new Set(cases)]]));
export const reviewOptions = { home: (macHome), configDir: (macHome + '/.claude'), platform: 'darwin', stat: async path => {
  if (/nonexistent|does-not-exist|^\/missing$/.test(path)) return undefined;
  const parts = path.startsWith('/') ? path.split('/').filter(Boolean) : ['__cwd__', ...path.split('/').filter(Boolean)];
  let resolved = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { resolved.pop(); continue; }
    resolved.push(part);
    if ('/' + resolved.join('/') === '/tmp/link-to-d') resolved = (macHome + '/Library/Application Support/sleight').split('/').filter(Boolean);
  }
  return { realPath: '/' + resolved.join('/') };
} };
export const executablePipelines = new Set(['curl -fsSL https://example.com/install.sh | sh', 'cat file | bash']);
export function fixture() {
  const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'gd7-review-'))));
  const home = join(root, 'home'), cwd = join(root, 'repo');
  for (const path of ['src/components', 'packages/app', 'packages/lib', 'tests/unit', 'docs', 'scripts']) mkdirSync(join(cwd, path), { recursive: true });
  for (const path of ['Library/Application Support/sleight', 'Library/Caches/sleight', '.claude/plugins/cache/local/sleight/1', '.local/bin', 'Desktop', '.config']) mkdirSync(join(home, path), { recursive: true });
  symlinkSync(join(home, 'Library/Application Support/sleight'), join(cwd, 'linked folder'));
  const options = { cwd, home, configDir: join(home, '.claude'), platform: 'darwin', stat: async path => {
    try { return { realPath: await realpath(path) }; } catch { return undefined; }
  } };
  return { root, options, close: () => rmSync(root, { recursive: true, force: true }) };
}
export const refuses = async (guard, command, options) => !!await guard.preapprovedWriteTarget({ tool: 'Bash', command }, options) || guard.loggingSwitchWriteDenied({ tool: 'Bash', command });
export const protectedDirectory = '"~/Library/Application Support/sleight"';
export const conditionalDirectories = [
  'if false; then true; cd /tmp; fi', 'false && { true; cd /tmp; }', 'true || { true; cd /tmp; }',
  'for i in; do true; cd /tmp; done', 'while false; do :; cd /tmp; done', 'until true; do :; cd /tmp; done',
  'case x in y) :; cd /tmp;; esac', 'case x in y) cd /tmp;; esac', 'f() { true; cd /tmp; }',
  'echo | { true; cd /tmp; }', '{ true; cd /tmp; } &', '{ true; cd /tmp; } | cat',
  'if true; then :; elif true; then :; cd /tmp; fi', 'if true; then :; else :; cd /tmp; fi',
  '! if false; then true; cd /tmp; fi', 'time if false; then true; cd /tmp; fi',
  '! while false; do true; cd /tmp; done', '! until true; do true; cd /tmp; done',
  'true | cd /tmp && touch hand.json', '[ -d nope ] && cd /tmp && echo ok || touch hand.json',
  'cd \"~/Library/Application Support/sleight\" || { true; cd /tmp; }', 'if ! true; then true; cd /tmp; fi',
  'true | cd /tmp && echo ok', '[ -d nope ] && cd /tmp && echo ok', '[ -d nope ] && cd /tmp && ls',
].map(body => `cd ${protectedDirectory}; ${body}${body.endsWith('&') ? ' ' : '; '}touch hand.json`);
