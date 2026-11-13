import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-outcome-chars-')));
after(() => removeTemp(dir));

for (const [field, length] of [['text area Description: Card number', false], ['text entry area Description: Passport', false],
  ['text field Description: Name', false], ['secure text field', false], ['text area Description: Notes', true], ['text entry area', true]]) {
  test(`the offline character analyzer follows the engine length rule for ${field}`, () => {
    const tree = `Window: "fixture", App: Fixture.\n0 standard window fixture\n\t1 ${field}\n\nThe focused UI element is 1 ${field}`;
    const file = join(dir, 'events.jsonl');
    const event = (id, code) => ({ message: { content: [
      { type: 'tool_use', id, name: 'sleight__js', input: { code } },
      { type: 'tool_result', tool_use_id: id, content: tree },
    ] } });
    writeFileSync(file, [event('read', 'await app.getAXState()'), event('type', 'await app.typeText("1234")')].map(JSON.stringify).join('\n'));
    const output = execFileSync(process.execPath, [new URL('../bench/outcome-chars.mjs', import.meta.url).pathname, '--show', file], { encoding: 'utf8' });
    assert.equal(/1 typeText 4 chars/.test(output), length);
    assert.doesNotMatch(output.split('\n').find(line => line.startsWith('1 typeText')), /1234/);
  });
}
