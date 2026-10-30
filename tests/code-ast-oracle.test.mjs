import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { readCorpus } from '../bench/code-ast/corpus.mjs';
import { astCalls, typescriptCalls, oracle } from '../bench/code-ast/oracle.mjs';
import { parseCell } from '../plugins/sleight/lib/code-ast.mjs';

test('TypeScript and Meriyah inventories agree on nested, optional and computed literal calls', { skip: parserSkip }, () => {
  const code = 'await app.typeText("PAYLOAD"); `${app.click(3)}`; app["paste"]?.(); app.setValue(1,{x:[true,null,3]});';
  assert.deepEqual(astCalls(parseCell(code).ast), typescriptCalls(code));
});
test('oracle counts syntax refusals and inventories without executing code', { skip: parserSkip || typeof vm.SourceTextModule !== 'function' && 'needs --experimental-vm-modules' }, () => {
  const run = oracle({ reportFailure: () => {} });
  run.check('throw new Error("would execute"); app.typeText("PAYLOAD")', null);
  run.check('const = 1', null);
  assert.equal(run.counts.tested, 2); assert.equal(run.counts.nodeAccepted, 1);
  assert.equal(run.counts.meriyahAccepted, 1); assert.equal(run.counts.bothRefuse, 1);
  assert.equal(run.counts.failOpen, 0); assert.equal(run.counts.falseRefusal, 0);
});
test('corpus reader deduplicates repeated call events, honors the date and omits other tools', async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-code-ast-corpus-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, 'claude'), codex = join(dir, 'codex');
  mkdirSync(claude); mkdirSync(join(codex, 'codex-r1'), { recursive: true });
  const call = { type: 'tool_use', id: 'one', name: 'mcp__plugin_sleight_computer__js', input: { code: 'await app.click(3)' } };
  const message = timestamp => ({ timestamp, message: { model: 'claude-haiku-5-5', content: [call] } });
  writeFileSync(join(claude, 'transcript.jsonl'), [message('2026-10-27T00:00:00Z'), message('2026-10-27T00:00:01Z'),
    { ...message('2026-10-29T00:00:00Z'), message: { model: 'claude-haiku-5-5', content: [{ ...call, id: 'later' }] } }].map(JSON.stringify).join('\n'));
  const item = { type: 'mcp_tool_call', id: 'two', tool: 'js', arguments: { code: 'app.typeText("PAYLOAD")' } };
  writeFileSync(join(codex, 'codex-r1/events.jsonl'), [{ type: 'item.started', item }, { type: 'item.completed', item },
    { item: { ...item, id: 'other', tool: 'js_reset' } }].map(JSON.stringify).join('\n'));
  const corpus = await readCorpus({ claude, codex });
  assert.equal(corpus.records.length, 2);
  assert.deepEqual(corpus.counts, { claudeFiles: 1, codexFiles: 1, claude: 1, codex: 1, malformed: 0 });
  assert.match(corpus.manifest, /^[a-f0-9]{64}$/);
});
