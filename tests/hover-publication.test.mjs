import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoverRedactor, publishHoverImage } from '../bench/hover-publication.mjs';

test('publication removes Chess titles and player names even inside nested transcript JSON', () => {
  const clean = createHoverRedactor({ home: '/Users/exampleuser', username: 'exampleuser' });
  const title = 'abc123.game | Example Player - Computer   (White to Move)';
  const input = { player: 'Example Player', plan: [{ app: 'Chess', windowTitle: title }],
    text: JSON.stringify({ nested: `Window: "${title}"\nApp: Chess\nPlayer: Example Player` }) };
  const output = clean(input);
  assert.equal(output.plan[0].windowTitle, '<chess-window-title>');
  assert.equal(output.player, '<chess-player>');
  assert.equal(JSON.stringify(output).includes('Example Player'), false);
  assert.equal(JSON.parse(output.text).nested, 'Window: "<chess-window-title>"\nApp: Chess\nPlayer: <chess-player>');
  assert.equal(clean('Example Player'), '<chess-player>');
});
test('publication hides home paths and Save sheet home labels, including truncated labels', () => {
  const clean = createHoverRedactor({ home: '/Users/exampleuser', username: 'exampleuser' });
  const output = clean({ path: '/Users/exampleuser/Projects/sleight',
    text: '13 row Description: home, Value: example…\n14 row Value: Macintosh HD',
    username: 'exampleuser' });
  assert.equal(output.path, '~/Projects/sleight');
  assert.equal(output.username, '<home-folder>');
  assert.equal(output.text, '13 row Description: home, Value: <home-folder>\n14 row Value: Macintosh HD');
});
test('Chess title redaction covers renamed windows as well as generated game titles', () => {
  const clean = createHoverRedactor({ home: '/Users/exampleuser', username: 'exampleuser' });
  const title = 'Private study by Example Player';
  const output = clean({ plan: [{ app: 'Chess', windowTitle: title }],
    text: JSON.stringify({ state: `Window: "${title}", App: Chess.\n0 standard window ${title}` }) });
  assert.equal(output.plan[0].windowTitle, '<chess-window-title>');
  assert.equal(JSON.stringify(output).includes(title), false);
  const onlyRead = clean(`Window: "Another private title", App: Chess.\n0 standard window Another private title`);
  assert.equal(onlyRead.includes('Another private title'), false);
});
test('Chess and TextEdit PNGs are omitted before publication, while Calculator PNGs are written', async () => {
  const writes = [];
  for (const app of ['Chess', 'TextEdit', 'Calculator']) {
    const block = { type: 'image', data: Buffer.from('pixels').toString('base64') };
    await publishHoverImage(app, block, 'step.png', async (name, bytes) => writes.push([name, bytes.toString()]));
    if (app === 'Calculator') assert.equal(block.data, 'step.png');
    else { assert.match(block.data, /omitted/); assert.match(block.sha256, /^[0-9a-f]{64}$/); }
  }
  assert.deepEqual(writes, [['step.png', 'pixels']]);
});
