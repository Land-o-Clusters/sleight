import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineLaunchPaths } from '../plugins/sleight/lib/launch.mjs';

const SCRIPT = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';

test('the script is args[0] in engines before 26.1023', () => {
  assert.deepEqual(engineLaunchPaths([SCRIPT]), { script: SCRIPT, others: [] });
});

test('engine 26.1023.50603 puts --import and a file URL before the script', () => {
  const hook = '/Users/x/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1023.50603/require-browser-access.mjs';
  assert.deepEqual(engineLaunchPaths(['--import', `file://${hook}`, SCRIPT]), { script: SCRIPT, others: [hook] });
});

test('options without a separate value, and --opt=value, are skipped', () => {
  assert.deepEqual(engineLaunchPaths(['--no-warnings', '--import=file:///x.mjs', SCRIPT, '--flag', '/abs/arg']),
    { script: SCRIPT, others: ['/abs/arg'] });
});

test('no script leaves it undefined, so the existence check fails', () => {
  assert.deepEqual(engineLaunchPaths(['--import', 'file:///x.mjs']), { script: undefined, others: ['/x.mjs'] });
});
