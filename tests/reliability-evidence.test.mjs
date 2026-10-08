import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reliabilityEvidence } from '../bench/reliability-evidence.mjs';

test('Chess owner titles in AX records and nested errors are scrubbed with home paths', () => {
  const title = 'Game 2 | Owner "Name" \\ White';
  let nested = title;
  for (let depth = 0; depth < 3; depth++) nested = JSON.stringify(nested);
  const serialized = reliabilityEvidence({ windows: [{ title }], error: nested,
    text: title + '\n/home/example/private', content: [{ type: 'image', data: 'pixels' }] }, [title], '/home/example');
  assert.doesNotMatch(serialized, /Owner|Name|\/home\/example|pixels/);
  assert.match(serialized, /\[Chess window\]/);
  assert.deepEqual(JSON.parse(serialized).content, [{ type: 'image', omitted: true }]);
});

test('untitled Chess dialogs preserve receipt fields while owner titles are scrubbed', () => {
  const value = { mode: 'chess-inspect', windowId: 123, text: 'Window: "", App: Chess.\n0 standard window',
    game: 'Window: "Game 2 | Owner Name", App: Chess.\n0 standard window' };
  const result = JSON.parse(reliabilityEvidence(value, ['', 'Game 2 | Owner Name']));
  assert.equal(result.mode, 'chess-inspect');
  assert.equal(result.windowId, 123);
  assert.equal(result.text, value.text);
  assert.doesNotMatch(result.game, /Owner Name/);
});
