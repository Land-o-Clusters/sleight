import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in `codex` on PATH that prints `codex exec --json` events, then waits with a child of its own.
function fakeCodex(events, { hang = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fake-codex-'));
  const script = join(dir, 'codex');
  writeFileSync(script, `#!/bin/sh\n${events.map(e => `echo '${JSON.stringify(e)}'`).join('\n')}\n${hang ? 'sleep 60 &\nwait\n' : ''}`);
  chmodSync(script, 0o755);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('runCodex reads the answer, counts engine calls and flags a shell', async () => {
  const fake = fakeCodex([{ type: 'thread.started', thread_id: 'none' },
    { type: 'item.completed', item: { type: 'mcp_tool_call', result: { _meta: { 'codex/nodeReplExecutionDurationMs': 120 } } } },
    { type: 'item.completed', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }]);
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const { runCodex } = await import('../bench/codex-arm.mjs');
    const run = await runCodex('task', { cwd: fake.dir, model: 'm', effort: 'medium', timeoutMs: 10000 });
    assert.equal(run.code, 0); assert.equal(run.groupClean, true);
    assert.equal(run.out.result, 'Done.'); assert.equal(run.toolCalls, 1); assert.equal(run.engineMs, 120);
    assert.deepEqual(run.forbidden, ['command_execution']);
    assert.equal(run.out.usage.input_tokens, 10);
  } finally { process.env.PATH = path; fake.done(); }
});

test('an abort stops Codex and the processes it started, and says the group is gone', async () => {
  const fake = fakeCodex([{ type: 'thread.started', thread_id: 'none' }], { hang: true });
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const { runCodex } = await import('../bench/codex-arm.mjs');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 300);
    const run = await runCodex('task', { cwd: fake.dir, model: 'm', effort: 'medium', timeoutMs: 10000, signal: controller.signal });
    assert.equal(run.cancelled, true); assert.equal(run.groupClean, true); assert.notEqual(run.code, 0);
  } finally { process.env.PATH = path; fake.done(); }
});
