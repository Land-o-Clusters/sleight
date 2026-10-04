import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { captureEngineDocs } from '../scripts/engine-docs.mjs';

const server = fileURLToPath(new URL('./fixtures/engine-docs-server.mjs', import.meta.url));
const capture = mode => captureEngineDocs({
  command: process.execPath,
  args: [server, mode],
  env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'dialog' },
  timeoutMs: mode === 'hang' ? 300 : 3000,
});

test('captures first-call text after declining approval, including an isError reply', async () => {
  assert.equal(await capture('docs'), '# Runtime API\n\ncua.getApp(name) → app\n\nCalculator approval declined.\n');
});

for (const [mode, error] of [
  ['rpc-error', /engine unavailable/],
  ['tool-error', /no API docs.*kernel reset/],
  ['empty', /no text/],
  ['malformed', /JSON/],
  ['exit', /exited/],
  ['hang', /timed out/],
]) {
  test(`rejects ${mode} rather than saving an empty or partial snapshot`, async () => {
    await assert.rejects(capture(mode), error);
  });
}

test('reports failure to start the server', async () => {
  await assert.rejects(captureEngineDocs({ command: '/no-such-sleight-server' }), /ENOENT/);
});
