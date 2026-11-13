// Read the benchmark helper as source. Its live entry point must never run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(join(root, 'bench/startup-costs.mjs'), 'utf8');
const start = source.indexOf('function snapshotCodeFromFile('), end = source.indexOf('\nasync function sectionSnapshot()', start);
assert.ok(start >= 0 && end > start);
const snapshotCodeFromFile = runInNewContext('(' + source.slice(start, end).trim() + ')', { readFileSync, join, root, randomBytes });

for (const app of ['Calculator', '$& __TOKEN__', 'a"b __COLS__'])
  test('startup snapshot fills a fresh frame token and preserves app data: ' + app, async () => {
    const first = snapshotCodeFromFile(app, 2, 1, false), second = snapshotCodeFromFile(app, 2, 1, false);
    const token = code => /FRAME_TOKEN = "([a-f0-9]{32})"/.exec(code)?.[1];
    assert.match(token(first) ?? '', /^[a-f0-9]{32}$/);
    assert.notEqual(token(first), token(second));
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(20, 16); png.writeUInt32BE(10, 20);
    let captured, output;
    await runInNewContext('(async () => { ' + first + ' })()', {
      Buffer,
      cua: { getApp: async name => { captured = name; return { getScreenshot: async () => png }; } },
      nodeRepl: { write: text => { output = text; } },
    });
    assert.equal(captured, app);
    assert.ok(output.startsWith('SLEIGHT_FRAME ' + token(first) + ' '));
    const frame = JSON.parse(output.slice(('SLEIGHT_FRAME ' + token(first) + ' ').length));
    assert.equal(frame.app, app);
    assert.equal(frame.width, 20); assert.equal(frame.height, 10);
    assert.equal(frame.columns, 2); assert.equal(frame.rows, 1);
  });
