import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { HELPER_REL, NODE_REL, REPL_REL } from '../plugins/sleight/lib/setup.mjs';

// The exact cua_repl entry Codex wrote to ~/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1103.41825/
// .mcp.json on this Mac (file dated 2026-11-06, unpacked 2026-11-10): the engine now lives in the ChatGPT app.
const CODEX_STUB = {
  command: 'node', args: [], enabled: false, enabled_tools: ['js', 'js_reset', 'turn_ended'],
  omit_tools_from: ['code_mode', 'deferred'], startup_timeout_sec: 120, tools: { js: { output_token_limit: 25000 } }, env: [],
};

function world(t, { server = CODEX_STUB, app = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'eng1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex');
  const dir = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/26.1103.41825');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: server } }));
  const chatgpt = join(root, 'ChatGPT.app');
  if (app) for (const rel of [NODE_REL, REPL_REL, HELPER_REL]) {
    mkdirSync(join(chatgpt, rel, '..'), { recursive: true });
    writeFileSync(join(chatgpt, rel), '');
  }
  return { CODEX_HOME: codexHome, SLEIGHT_CHATGPT_APP: chatgpt, chatgpt };
}

test('a disabled Codex stub with a bare "node" falls back to the ChatGPT app engine', t => {
  const env = world(t);
  const s = resolveServer(env);
  assert.equal(s.error, undefined);
  assert.equal(s.fromChatGPTApp, true);
  assert.equal(s.command, join(env.chatgpt, NODE_REL));
  assert.deepEqual(s.args, [join(env.chatgpt, REPL_REL)]);
});

test('the stub with no ChatGPT app engine names the unrunnable command and the fix', t => {
  const env = world(t, { app: false });
  const s = resolveServer(env);
  assert.match(s.error, /names no runnable "cua_repl" server \(command "node"\)/);
  assert.match(s.error, /Install the ChatGPT desktop app/);
});

test('an enabled entry with a bare command falls back; a missing absolute command keeps its old handling', t => {
  const bare = world(t, { server: { command: 'node', args: ['/x/cua-repl.mjs'] } });
  assert.equal(resolveServer(bare).fromChatGPTApp, true);
  const missing = world(t, { server: { command: '/nonexistent/cua_node/bin/node', args: ['/nonexistent/cua-repl.mjs'] } });
  const s = resolveServer(missing);
  assert.equal(s.fromChatGPTApp, undefined);
  assert.equal(s.command, '/nonexistent/cua_node/bin/node');
});

test('a runnable cached entry is still used as before', t => {
  const env = world(t, { server: { command: process.execPath, args: ['/x/cua-repl.mjs'], env: { A: '1' } } });
  const s = resolveServer(env);
  assert.equal(s.fromChatGPTApp, undefined);
  assert.equal(s.command, process.execPath);
  assert.equal(s.env.A, '1');
});
