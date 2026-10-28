import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { MODULES_REL } from '../plugins/sleight/lib/setup.mjs';
import { replayInstalledDocumentation } from './helpers/documentation-replay.mjs';

const app = process.env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app';
test('nine offline replays use real installed docs and keep the joined confirmation policy', {
  skip: !existsSync(join(app, MODULES_REL, '@oai/cua')),
}, async t => {
  const replay = await replayInstalledDocumentation(createRelay, app);
  assert.equal(Object.keys(replay.results).length, 9);
  assert.ok(replay.nativeChars > 15000);
  assert.ok(replay.browserChars > 20000);
  const separate = replay.results['native separate'].wire;
  const joined = replay.results['native joined'].wire;
  assert.deepEqual(joined, separate, 'joined documents receive the same required policy as separate documents');
  assert.deepEqual(replay.results['lean joined'].wire, replay.results['lean separate'].wire);
  for (const name of ['browser first', 'browser first large tree']) {
    const result = replay.results[name];
    assert.ok(result.docs.length > 0, `${name}: the browser-first native reference is delivered later`);
    assert.ok(result.wire.some(msg => msg.result?.content?.some(c => c.text?.includes('# Selected Browser\n'))), name);
  }
  const grok = replay.results['grok browser'].wire;
  assert.ok(grok.some(msg => msg.result?.content?.some(c => c.text?.includes('# Selected Browser\n'))));
  assert.ok(grok.some(msg => msg.result?.isError && msg.result.content?.some(c => /20000-byte limit/.test(c.text))));
  t.diagnostic(JSON.stringify({ ...replay, results: Object.fromEntries(Object.entries(replay.results).map(([name, { wire, ...summary }]) => [name, summary])) }));
});
