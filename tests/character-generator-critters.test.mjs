import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIPS, PERCH_CLIPS } from '../plugins/sleight/skills/make-character/tool/lib/poses.mjs';

for (const id of ['mabel', 'biscuit', 'rudy', 'mo']) {
  test(`${id}: every sprite, perch and stage frame is finite SVG`, async () => {
    const { renderCritter, critterPose, stageClips } = await import('../plugins/sleight/skills/make-character/tool/rigs/critter.mjs');
    const D = (await import(`../plugins/sleight/skills/make-character/tool/cast/${id}.mjs`)).default;
    const clips = [...CLIPS, ...PERCH_CLIPS, ...stageClips()];
    for (const c of clips) for (let i = 0; i < c.frames; i++) {
      const p = critterPose(D, c, i);
      const svg = renderCritter(D, p);
      assert.match(svg, /^<svg /);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
      assert.match(svg, /data-rig="critter"/);
    }
    assert.equal(stageClips().length, 21);
  });
}

test('Rudy stays still, Mo uses half-speed cells, four-legged poses retain four feet', async () => {
  const { critterPose, renderCritter, durationFor } = await import('../plugins/sleight/skills/make-character/tool/rigs/critter.mjs');
  const rudy = (await import('../plugins/sleight/skills/make-character/tool/cast/rudy.mjs')).default;
  const mo = (await import('../plugins/sleight/skills/make-character/tool/cast/mo.mjs')).default;
  const cat = (await import('../plugins/sleight/skills/make-character/tool/cast/mabel.mjs')).default;
  const run = CLIPS.find(c => c.name === 'running-right');
  assert.equal(critterPose(rudy, run, 2).lean, 0);
  assert.equal(critterPose(rudy, run, 2).y, 0);
  assert.equal(durationFor(mo, 110), 220);
  assert.equal(durationFor(mo, 1500), 2000);
  assert.equal(new Set(renderCritter(cat, critterPose(cat, run, 2)).match(/data-foot="[^"]+"/g)).size, 4);
});

test('toon delegation, pack timings and cell guardrails', async () => {
  const { manifestForCritter, checkCells } = await import('../plugins/sleight/skills/make-character/tool/stage.mjs');
  const { renderToon } = await import('../plugins/sleight/skills/make-character/tool/styles/toon.mjs');
  const { critterPose } = await import('../plugins/sleight/skills/make-character/tool/rigs/critter.mjs');
  const D = (await import('../plugins/sleight/skills/make-character/tool/cast/mo.mjs')).default;
  assert.match(renderToon(D,critterPose(D,CLIPS[0],0)), /data-rig="critter"/);
  const m=manifestForCritter(D);
  for(const s of Object.values(m.states).filter(s=>s.ms)) {
    const ms=Array.isArray(s.ms)?s.ms:Array(s.frames).fill(s.ms);
    assert.ok(ms.reduce((a,b)=>a+b,0)<=4000);
  }
  const img={width:192,height:208,data:Buffer.alloc(192*208*4)};
  assert.equal(checkCells(img,[{row:0,col:0}]).problems.length,1);
  for(let y=30;y<50;y++) for(let x=30;x<50;x++) img.data[(y*192+x)*4+3]=255;
  assert.deepEqual(checkCells(img,[{row:0,col:0}]).problems,[]);
  img.data[3]=255;
  assert.equal(checkCells(img,[{row:0,col:0}]).warnings.length,1);
});

test('Rudy has no carry prop and his error ends after 800 ms; Mo rests hanging', async () => {
  const { critterPose, renderCritter, clipTiming } = await import('../plugins/sleight/skills/make-character/tool/rigs/critter.mjs');
  const duck = (await import('../plugins/sleight/skills/make-character/tool/cast/rudy.mjs')).default;
  const mo = (await import('../plugins/sleight/skills/make-character/tool/cast/mo.mjs')).default;
  const carry = CLIPS.find(c=>c.name==='drag-carry');
  assert.doesNotMatch(renderCritter(duck,critterPose(duck,carry,0)), /#cfac7b/);
  const error=CLIPS.find(c=>c.name==='error');
  assert.equal(clipTiming(duck,error).reduce((a,b)=>a+b,0),800);
  assert.equal(critterPose(mo,CLIPS[0],0).hanging,true);
});
