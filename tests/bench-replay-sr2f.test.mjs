// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { TargetMapper, divergence, comparisonResult } = await import('../bench/replay/mapping.mjs');
const { replayCalls } = await import('../bench/replay/engine.mjs');

// Complete PNGs with different pixels, without a host decoder or app.
function png(width = 2, height = 1, color = 0) {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), tail = Buffer.alloc(4);
    size.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, color);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const image = (data = png(), mimeType = 'image/png') => ({ type: 'image', data, mimeType });
const storedImage = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png() } });
const text = value => ({ content: [{ type: 'text', text: value }] });
const shot = (block = image(), header = 'Window: "fixture.txt", App: TextEdit.', value = 'alpha') => ({
  content: [{ type: 'text', text: `${header}\n0 window fixture\n  2 text entry area, Value: ${value}` }, block],
});

test('replay accepts different pixels and image transport shapes for the same window and size', () => {
  const expected = shot(storedImage()), actual = shot(image(png(2, 1, 255)));
  assert.equal(divergence(expected, actual), null);
  assert.deepEqual(comparisonResult(expected, new TargetMapper()), comparisonResult(actual, new TargetMapper()));
});

test('image window identity permits fixture substitutions only', () => {
  const mapper = new TargetMapper(); mapper.addString('/tmp/recorded', `${MAC_TMP}/fresh`);
  assert.equal(divergence(shot(image(), 'Window: "/tmp/recorded/file.txt", App: TextEdit.'),
    shot(image(png(2, 1, 7)), `Window: "${MAC_TMP}/fresh/file.txt", App: TextEdit.`), mapper), null);
});

test('JPEG metadata and PNG pixels can differ while each ordered image keeps its dimensions', () => {
  const jpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const changed = Buffer.from(jpeg, 'base64'); changed[13] = 2; // JFIF density metadata.
  const expected = shot(image(jpeg, 'image/jpeg'));
  expected.content.push(image());
  const actual = shot({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: changed.toString('base64') } });
  actual.content.push(image(png(2, 1, 255)));
  assert.equal(divergence(expected, actual), null);
  actual.content.reverse();
  assert.equal(divergence(expected, actual), 'non-text evidence changed; visual interpretation required');
  for (const data of ['ffd8ff', 'ffd8ffe00001', 'ffd8ffc00008080000', 'ffd8ffda0002']) {
    assert.equal(divergence(shot(image(jpeg, 'image/jpeg')), shot(image(Buffer.from(data, 'hex').toString('base64'), 'image/jpeg'))),
      'non-text evidence changed; visual interpretation required');
  }
});

for (const [name, change] of [
  ['count', r => r.content.push(image())],
  ['type', r => { r.content[1] = { type: 'audio', data: png(), mimeType: 'image/png' }; }],
  ['mime', r => { r.content[1].mimeType = 'image/jpeg'; }],
  ['width', r => { r.content[1] = image(png(3, 1)); }],
  ['height', r => { r.content[1] = image(png(2, 2)); }],
  ['window', r => { r.content[0].text = r.content[0].text.replace('fixture.txt', 'other.txt'); }],
  ['app', r => { r.content[0].text = r.content[0].text.replace('TextEdit', 'Chess'); }],
  ['missing header', r => { r.content[0].text = 'tree only'; }],
  ['ambiguous header', r => { r.content[0].text += '\nWindow: "other.txt", App: TextEdit.'; }],
  ['unknown dimensions', r => { r.content[1].data = 'invalid'; }],
  ['zero dimensions', r => { const data = Buffer.from(png(), 'base64'); data.writeUInt32BE(0, 16); r.content[1].data = data.toString('base64'); }],
]) test(`replay refuses an image with changed ${name}`, () => {
  const actual = shot(); change(actual);
  assert.equal(divergence(shot(), actual), 'non-text evidence changed; visual interpretation required');
});

test('identical image bytes do not excuse missing window identity or unreadable dimensions', () => {
  assert.equal(divergence({ content: [image()] }, { content: [image()] }), 'non-text evidence changed; visual interpretation required');
  assert.equal(divergence(shot(image('bad')), shot(image('bad'))), 'non-text evidence changed; visual interpretation required');
});

test('matching images keep text, values, structured data and other media strict', () => {
  assert.equal(divergence(shot(), shot(image(png(2, 1, 7)), undefined, 'beta')), 'observable text changed');
  assert.equal(divergence({ ...shot(), structuredContent: { value: 1 } },
    { ...shot(image(png(2, 1, 7))), structuredContent: { value: 2 } }), 'structured result changed');
  assert.equal(divergence({ content: [{ type: 'audio', data: 'a' }] }, { content: [{ type: 'audio', data: 'b' }] }),
    'non-text evidence changed; visual interpretation required');
});

test('later numeric actions use fresh full trees, compact diffs and mapping reads', async () => {
  const source = { server: 'plugin:sleight:computer', name: 'js' };
  const tree = (root, id) => `Window: "fixture.txt", App: TextEdit.\n${root} window fixture\n  ${id} button Save`;
  const diff = (root, id) => `Window: "fixture.txt", App: TextEdit.\n${root} window fixture\nsleight: lines changed since the last full tree\n+   ${id} button Save`;
  const calls = [
    { name: 'open_file', arguments: { app: 'TextEdit', path: '/tmp/fixture.txt' }, result: shot(storedImage()) },
    { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit");' }, result: text(tree(0, 2)) },
    { name: 'js', arguments: { code: 'await app.click(2)' }, result: text(diff(0, 2)) },
    { name: 'js', arguments: { code: 'await app.click(2)' }, result: text(tree(0, 2)) },
    { name: 'js', arguments: { code: 'await app.click(2)' }, result: text(tree(0, 2)) },
  ].map((c, i) => ({ ...source, ...c, id: String(i) }));
  const sent = [], responses = [shot(image(png(2, 1, 7))), text(tree(10, 22)), text(diff(10, 32)), text(tree(10, 32)), text(tree(10, 42)), text(tree(10, 42))];
  const replay = await replayCalls(calls, { call: async (_server, _name, args) => { sent.push(args); return responses.shift(); } });
  assert.equal(replay.verdict, 'pass', replay.reason);
  assert.deepEqual(sent.slice(2).map(a => a.code), ['await app.click(22)',
    'await app.getAXState({ disableDiffing: true });', 'await app.click(32)', 'await app.click(42)']);
  assert.equal(replay.calls.length, 5);
});

const evidence = join(homedir(), 'Projects/sleight-wt/race-1017/evidence-replay-dp1b');
test('retained DP1 first-call images match structurally while changed notices still diverge', {
  skip: !existsSync(join(evidence, '1-A/trace.jsonl')) && 'Retained DP1 evidence is not installed',
}, () => {
  for (let iteration = 1; iteration <= 5; iteration++) for (const variant of ['A', 'B']) {
    const folder = `${2 * iteration - (variant === 'A' ? 1 : 0)}-${variant}`;
    const row = readFileSync(join(evidence, `${folder}/trace.jsonl`), 'utf8').trim().split('\n')
      .map(JSON.parse).find(r => r.event === 'call');
    const mapper = new TargetMapper();
    mapper.addString(row.recordedArguments.path.replace(/\/[^/]+$/, ''), row.arguments.path.replace(/\/[^/]+$/, ''));
    mapper.addString('/private' + row.recordedArguments.path.replace(/\/[^/]+$/, ''), row.arguments.path.replace(/\/[^/]+$/, ''));
    assert.equal(divergence(row.expected, row.result, mapper), 'observable text changed', `${iteration}-${variant}`);
    const expectedImage = row.expected.content.find(b => b.type === 'image');
    const actualImage = row.result.content.find(b => b.type === 'image');
    assert.equal(divergence(shot(expectedImage), shot(actualImage)), null, `${iteration}-${variant} image`);
  }
});
});
