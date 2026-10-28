import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineLaunchPaths } from '../plugins/sleight/lib/launch.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const SCRIPT = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';
const HOOK = '/Users/x/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1023.50603/require-browser-access.mjs';

test('the script is args[0] in engines before 26.1023', () => {
  assert.deepEqual(engineLaunchPaths([SCRIPT]), { script: SCRIPT, others: [], optionFiles: [] });
});

test('engine 26.1023.50603 puts --import and a file URL before the script', () => {
  assert.deepEqual(engineLaunchPaths(['--import', `file://${HOOK}`, SCRIPT]), { script: SCRIPT, others: [HOOK], optionFiles: [HOOK] });
});

test('--opt=value files are checked too, and flags without a value are skipped', () => {
  assert.deepEqual(engineLaunchPaths(['--no-warnings', `--import=file://${HOOK}`, '--title=x', SCRIPT, '--flag', '/abs/arg']),
    { script: SCRIPT, others: [HOOK, '/abs/arg'], optionFiles: [HOOK] });
});

test('relative option files are checked, bare package names are left to node', () => {
  assert.deepEqual(engineLaunchPaths(['--import', './hook.mjs', '--require', 'tsx', SCRIPT]),
    { script: SCRIPT, others: ['./hook.mjs'], optionFiles: ['./hook.mjs'] });
});

test('a malformed file URL stays as typed, so its existence check fails', () => {
  assert.deepEqual(engineLaunchPaths(['--import', 'file://host/x.mjs', SCRIPT]),
    { script: SCRIPT, others: ['file://host/x.mjs'], optionFiles: ['file://host/x.mjs'] });
});

test('no script leaves it undefined, so the existence check fails', () => {
  assert.deepEqual(engineLaunchPaths(['--import', 'file:///x.mjs']), { script: undefined, others: ['/x.mjs'], optionFiles: ['/x.mjs'] });
});

test('doctor checks the script and the --import hook of an engine that starts with --import', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { doctor } = await import('../plugins/sleight/lib/launch.mjs');
  const home = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ec1-')));
  try {
    const dir = join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1023.50603');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'require-browser-access.mjs'), script = join(home, 'cua-repl.mjs');
    writeFileSync(hook, ''); writeFileSync(script, '');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: process.execPath,
      args: ['--import', pathToFileURL(hook).href, script], env: { CUA_REPL_NODE_REPL_PATH: join(home, 'missing-node-repl') } } } }));
    const lines = [];
    const none = () => [];
    const rc = await doctor({ env: { CODEX_HOME: home, SLEIGHT_SURFACES: 'computer' }, log: line => lines.push(line), app: undefined,
      turbo: none, hand: none, permissions: none, codex: none, cursor: none, grok: none, grokbot: none, forbiddenTargets: () => '0' });
    assert.equal(rc, 1); // node_repl is missing on purpose, so doctor stops before its live read
    assert.ok(lines.includes(`ok        server script: ${script}`), lines.join('\n'));
    assert.ok(lines.includes(`ok        server file: ${hook}`), lines.join('\n'));
    assert.ok(lines.some(line => line.startsWith('MISSING   node_repl')), lines.join('\n'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
