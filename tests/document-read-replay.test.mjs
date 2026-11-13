import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { classifyDocumentScreenshot, recordedCalls, frozenRecordedCalls, replayDocumentReads } from '../scripts/document-read-replay.mjs';

const textedit = 'Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 text entry area Value: alpha delta gamma';
const word = 'Window: "Memo", App: Microsoft Word.\n0 standard window Memo\n\t1 layout area\n\t\t2 text entry area Description: Page 1 content, Value: # Memo copper order';
const safari = 'Window: "Shipping", App: Safari.\n0 standard window Shipping\n\t1 web area\n\t\t2 heading Shipping\n\t\t3 text Copper shipped';
for (const [app, tree] of [['TextEdit', textedit], ['Microsoft Word', word], ['Safari', safari]]) {
  test(`recorded ${app} document text is a conditional structured-read candidate`, () => {
    assert.deepEqual(classifyDocumentScreenshot({ code: 'await app.getScreenshot()', tree }),
      { app, answered: true, reason: 'recorded-document-content' });
  });
}
test('an empty Word pane and a control tree still need pixels', () => {
  for (const tree of [word.replace(/Value: .*/, ''), 'Window: "Calc", App: Calculator.\n0 standard window Calc\n\t1 button Seven'])
    assert.equal(classifyDocumentScreenshot({ code: 'await app.getScreenshot()', tree }).answered, false);
});
test('documentation examples cannot supply document evidence for an empty real window', () => {
  const tree = textedit + '\n# API example ends\nWindow: "Empty", App: Microsoft Word.\n0 standard window Empty\n\t1 text entry area';
  assert.equal(classifyDocumentScreenshot({ code: 'await app.getScreenshot()', tree }).answered, false);
});
test('a recorded document above the read cap stays in the pixel class', () => {
  const tree = textedit + 'x'.repeat(4000);
  assert.deepEqual(classifyDocumentScreenshot({ code: 'await app.getScreenshot()', tree }),
    { app: 'TextEdit', answered: false, reason: 'document-over-cap' });
});
test('secure descendants and spatial requests cannot count as answered', () => {
  for (const patch of [{ tree: textedit + '\n\t\t2 secure text field <redacted>' },
    { code: 'await app.drag([1,2], [3,4]); await app.getScreenshot()' }, { task: 'sleight-chess-drag' }])
    assert.equal(classifyDocumentScreenshot({ code: 'await app.getScreenshot()', tree: textedit, ...patch }).answered, false);
});
test('a refused or failed screenshot call cannot count as a structured-text answer', () => {
  assert.equal(classifyDocumentScreenshot({ code: 'await app.getScreenshot()', tree: textedit, isError: true }).answered, false);
});
test('recorded call parsing links replies by id without retaining image bytes', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__plugin_sleight_computer__js', input: { code: 'await app.getScreenshot()' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: textedit }, { type: 'image', data: 'SECRET_IMAGE' }] }] } },
  ];
  const calls = recordedCalls(lines.map(JSON.stringify).join('\n'));
  assert.equal(calls.length, 1); assert.equal(calls[0].text, textedit); assert.equal(calls[0].tool, 'js');
  assert.equal(JSON.stringify(calls).includes('SECRET_IMAGE'), false);
  assert.equal(recordedCalls(JSON.stringify(lines[0]))[0].isError, true, 'an incomplete reply cannot establish an answer');
});
test('the frozen manifest excludes later calls and matches long code by its stored prefix and full length', () => {
  const code = 'x'.repeat(450), call = { tool: 'js', code, at: 10 };
  const declared = [{ tool: 'sleight:js', code: code.slice(0, 400), codeChars: code.length, at: 10 }];
  assert.deepEqual(frozenRecordedCalls([call, call, { ...call, at: 11 }], declared), [call]);
});
test('end-to-end recorded replay verifies its screenshot set and exports no document marker', async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-document-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'sleight-fixture-1'); await mkdir(folder);
  const file = join(folder, 'transcript.jsonl'), manifest = join(root, 'manifest.json');
  const code = '// ' + 'x'.repeat(450) + '\nawait app.getScreenshot()', timestamp = '2026-01-01T00:00:00.000Z';
  const lines = [
    { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__plugin_sleight_computer__js', input: { code } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: textedit + ' REPLAY_PRIVATE_MARKER' }] }] } },
  ];
  await writeFile(file, lines.map(JSON.stringify).join('\n'));
  const sessions = [{ arm: 'sleight', file, task: 'sleight-fixture', calls: [{ tool: 'sleight:js', at: Date.parse(timestamp),
    code: code.slice(0, 400), codeChars: code.length, reads: ['getScreenshot'] }] }];
  await writeFile(manifest, JSON.stringify(sessions));
  const result = await replayDocumentReads(manifest);
  assert.equal(result.productionParserRun, false); assert.equal(result.classification, 'regex-upper-bound');
  assert.equal(result.screenshots, 1); assert.equal(result.manifestScreenshots, 1); assert.equal(result.answered, 1);
  assert.equal(JSON.stringify(result).includes('REPLAY_PRIVATE_MARKER'), false);
  await writeFile(file, '');
  await assert.rejects(replayDocumentReads(manifest), /RECORDED_SCREENSHOT_SET_CHANGED/);
});
