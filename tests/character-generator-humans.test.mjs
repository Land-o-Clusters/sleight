import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToon } from '../plugins/sleight/skills/make-character/tool/styles/toon.mjs';
import { STAGE_TOON_CLIPS } from '../plugins/sleight/skills/make-character/tool/lib/toon-stage.mjs';
import { CLIPS, PERCH_CLIPS } from '../plugins/sleight/skills/make-character/tool/lib/poses.mjs';
const ids = ['dennis', 'nana', 'hal'];
for (const id of ids) test(`${id}: every sprite, perch and stage frame renders finite original vector art`, async () => {
  const D = (await import(`../plugins/sleight/skills/make-character/tool/cast/${id}.mjs`)).default;
  const shapes = new Set();
  for (const c of [...CLIPS, ...PERCH_CLIPS, ...STAGE_TOON_CLIPS]) for (let i = 0; i < c.frames; i++) {
    const svg = renderToon(D, { ...c.pose(i, { E: D.E }), clip: c.name, frame: i });
    assert.match(svg, /^<svg/); assert.doesNotMatch(svg, /NaN|Infinity|<image|<filter|<script|<text|<foreignObject/);
    assert.match(svg, /viewBox="0 0 192 208"/); shapes.add(svg);
  }
  assert.ok(shapes.size > 70, `${shapes.size} distinct frames`);
});
test('stage clips fit the study strip limits and cover every seat and reaction', () => {
  assert.equal(STAGE_TOON_CLIPS.length, 21); // Section 2.2 lists 20 rows (its prose says 19); ST3's loader adds stage-think.
  for (const c of STAGE_TOON_CLIPS) {
    assert.ok(c.frames >= 1 && c.frames <= 8);
    assert.equal(c.ms.length, c.frames); assert.ok(c.ms.every(n => n >= 40));
    assert.ok(c.ms.reduce((a, b) => a + b, 0) <= 4000);
  }
  for (const name of ['lie', 'sit', 'hang', 'climb', 'stand', 'carry', 'paused', 'leap', 'startle']) assert.ok(STAGE_TOON_CLIPS.some(c => c.name === `stage-${name}`));
});
test('each human has 45 safe lines over all nine moments', () => {
  const lines = JSON.parse(readFileSync(new URL('../plugins/sleight/skills/make-character/tool/lines.json', import.meta.url)));
  for (const id of ids) {
    assert.equal(lines[id].lang, 'en');
    const moments = Object.keys(lines[id]).filter(k => k !== 'lang');
    assert.deepEqual(moments.sort(), ['start', 'first-click', 'typing', 'long-wait', 'approval', 'error', 'done', 'handback', 'wake'].sort());
    const all = moments.flatMap(k => lines[id][k]); assert.equal(all.length, 45); assert.equal(new Set(all).size, 45);
    for (const line of all) {
      assert.ok(line.length > 0 && line.length <= 60, line);
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>{}`*_\[\]|\u2014]|:\/\/|www\.|\/[a-z]|~\//iu);
      assert.doesNotMatch(line, /\b(system|assistant|ignore|tool)\b/i);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(lines[id])) <= 4096);
  }
});
test('the human posture contract keeps perch seated and lying art purpose drawn', async () => {
  for (const id of ids) {
    const D = (await import(`../plugins/sleight/skills/make-character/tool/cast/${id}.mjs`)).default;
    const c = PERCH_CLIPS.find(c => c.name === 'perch');
    assert.ok(/data-posture="sit"/.test(renderToon(D, { ...c.pose(0, { E: D.E }), clip: 'perch' })));
    const lie = STAGE_TOON_CLIPS[0];
    const svg = renderToon(D, lie.pose(0, { E: D.E }), { width: id === 'nana' ? 192 : 320 });
    assert.ok(new RegExp(`data-posture="${id === 'nana' ? 'sit' : 'lie'}"`).test(svg));
    assert.doesNotMatch(svg, /rotate\(82/);
  }
});
