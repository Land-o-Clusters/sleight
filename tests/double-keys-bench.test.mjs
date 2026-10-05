import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { benchmarkApproval, probeClient, probeReadCode, probeInputCode, probeCleanupPath } from '../bench/double-keys-client.mjs';

test('cleanup accepts only a normalized temporary probe document', () => {
  const path = '/private/tmp/sleight-double-keys-Zk4nfu/double-keys.txt';
  assert.equal(probeCleanupPath(path), path);
  for (const wrong of ['/private/tmp/other/double-keys.txt', path + '/../other.txt',
    '/private/tmp/sleight-double-keys-Zk4nfu/other.txt', '~/Documents/notes.txt']) {
    assert.throws(() => probeCleanupPath(wrong), /probe document/);
  }
});

test('keypress trials send characters once then dismiss suggestions; text trials send one string', async () => {
  for (const keysOnly of [false, true]) {
    const sent = [];
    await runInNewContext(`(async () => { ${probeInputCode('ab', keysOnly)} })()`, {
      app: { typeText: async text => sent.push(['text', text]), pressKey: async key => sent.push(['key', key]) },
    });
    assert.deepEqual(sent, keysOnly ? [['key', 'a'], ['key', 'b'], ['key', 'Escape']] : [['text', 'ab']]);
  }
});

test('probe app acquisition declares its handle in a strict engine session', async () => {
  const target = { name: 'owned fixture' };
  const acquired = [];
  const result = await runInNewContext(`(async () => { "use strict"; ${probeReadCode('TextEdit')}; return app; })()`,
    { cua: { getApp: async name => { acquired.push(name); return target; } } });
  assert.equal(result, target);
  assert.deepEqual(acquired, ['TextEdit']);
});

// Removing the existing allowlist delegation would allow a fourth app or a
// differently worded prompt. These run the real hook without touching an app.
test('the typing probe uses only the benchmark app allowlist', async () => {
  for (const app of ['Calculator', 'TextEdit', 'Chess']) {
    assert.deepEqual(await benchmarkApproval({ message: `Allow Computer Use to use "${app}"?` }),
      { action: 'accept', content: {} });
  }
  for (const message of ['Allow Computer Use to use "Mail"?',
    'Allow Computer Use to use "com.apple.textedit"?', 'Allow one flow-rule exception?']) {
    assert.deepEqual(await benchmarkApproval({ message }), { action: 'decline' });
  }
});

test('the direct probe sends one request per call and rotates turn metadata', async t => {
  const records = [];
  const client = await probeClient({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/double-keys-engine.mjs', import.meta.url))], env: {} },
  { relay: false, record: entry => records.push(structuredClone(entry)) });
  t.after(() => client.close());
  const params = result => JSON.parse(result.content[0].text);
  const meta = result => JSON.parse(params(result)._meta['x-codex-turn-metadata']);
  const before = await client.call('js', { code: 'await app.typeText("A1|")' });
  const ended = await client.call('turn_ended', {});
  const after = await client.call('js', { code: 'await app.typeText("A2|")' });
  assert.equal(meta(before).session_id, meta(after).session_id);
  assert.equal(meta(before).turn_id, params(ended).arguments.turn_id);
  assert.equal(meta(before).session_id, params(ended).arguments.session_id);
  assert.notEqual(meta(before).turn_id, meta(after).turn_id);
  assert.deepEqual(records.filter(r => r.direction === 'submitted' && r.msg.params?.name === 'js')
    .map(r => r.msg.params.arguments.code), ['await app.typeText("A1|")', 'await app.typeText("A2|")']);
  await client.close();
  assert.deepEqual(records.filter(r => r.event === 'engine-close').map(r => [r.code, r.signal]), [[0, null]]);
});
