import test from 'node:test';
import assert from 'node:assert/strict';
import * as poses from '../plugins/sleight/skills/make-character/tool/lib/poses.mjs';
import { stageRig } from '../plugins/sleight/skills/make-character/tool/lib/stage-rig.mjs';
import { renderAnime } from '../plugins/sleight/skills/make-character/tool/styles/anime.mjs';
import { renderPaper } from '../plugins/sleight/skills/make-character/tool/styles/paper.mjs';
import { renderPixel } from '../plugins/sleight/skills/make-character/tool/styles/pixel.mjs';
import { stageManifest, stageBlock, renderPose, isCritter, checkStagePixels } from '../plugins/sleight/skills/make-character/tool/stage.mjs';

// Catches missing stage art and timing drift from ST1 section 2.2, including ST3's front-sit state.
test('all 21 stage states have complete, bounded animation keys', () => {
  assert.ok(Array.isArray(poses.STAGE_CLIPS), 'STAGE_CLIPS must exist');
  const want = {
    lie: 6, 'lie-reach': 4, 'lie-peek': 2, sleep: 2, sit: 4, 'sit-notes': 6,
    think: 4, wait: 4, cheer: 3, hang: 4, 'hang-peek': 2, climb: 6, stand: 6,
    point: 3, carry: 4, wince: 4, handoff: 4, paused: 5, leap: 5, run: 8, startle: 2,
  };
  assert.deepEqual(Object.fromEntries(poses.STAGE_CLIPS.map(c => [c.name.slice(6), c.frames])), want);
  for (const c of poses.STAGE_CLIPS) {
    assert.equal(c.ms.length, c.frames, c.name);
    assert.ok(c.ms.every(ms => ms >= 40 && ms <= 2000), c.name);
    assert.ok(c.ms.reduce((n, ms) => n + ms, 0) <= 8000, c.name);
    for (let i = 0; i < c.frames; i++) {
      const p = c.pose(i, { E: 1 });
      assert.equal(p.stage.name, c.name);
      assert.equal(p.stage.frame, i);
    }
  }
});

const rig=(name,frame=0)=> {
  const c=poses.STAGE_CLIPS.find(c=>c.name===`stage-${name}`);
  return stageRig({},c.pose(frame),{shY:113,hipY:150,headY:70,shoulder:18,hipW:9,limb:1,head:1});
};
test('lie stretches along the edge; sit dangles; hang grips above the head; climb spreads four limbs',()=>{
  const lie=rig('lie');
  assert.equal(lie.width,320);
  assert.ok(lie.head[0]-lie.legs.l.foot[0]>190,'lying figure must stretch along the edge');
  assert.ok(Math.abs(lie.sh[1]-lie.hip[1])<15,'torso lies horizontally');
  const sit=rig('sit');
  assert.ok(sit.legs.l.knee[0]<sit.legs.l.hip[0]-15,'visible seated thigh');
  assert.ok(sit.legs.l.foot[1]>sit.hip[1]+35,'shin dangles below the edge');
  const hang=rig('hang');
  assert.ok(hang.arms.l.hc[1]<hang.head[1]-55,'hand grips above the head');
  assert.ok(hang.arms.r.hc[1]<hang.head[1]-55);
  assert.ok(Math.abs(hang.legs.l.foot[0]-hang.legs.r.foot[0])<30,'legs dangle together');
  const climb=rig('climb');
  assert.ok(climb.arms.r.hc[0]-climb.arms.l.hc[0]>120,'hands spread');
  assert.ok(climb.legs.r.foot[0]-climb.legs.l.foot[0]>120,'feet spread');
  assert.notEqual(climb.arms.l.hc[1],climb.arms.r.hc[1],'staggered grips');
});
test('leap has five distinct full-body keys and the run has a long stride',()=>{
  const keys=Array.from({length:5},(_,i)=>rig('leap',i));
  assert.equal(new Set(keys.map(r=>JSON.stringify([r.hip,r.arms,r.legs]))).size,5);
  assert.ok(keys[2].hip[1]<keys[0].hip[1]-15,'air key lifts the hips');
  assert.ok(keys[2].arms.r.hc[0]-keys[2].arms.l.hc[0]>120,'air key spreads the arms');
  const run=rig('run');assert.ok(run.legs.r.foot[0]-run.legs.l.foot[0]>100);
});
test('every stage frame renders finite SVG in the character style',async()=>{
  for(const id of ['tsugi','shizu','bit','kit','yori','tab']) {
    const D=(await import(`../plugins/sleight/skills/make-character/tool/cast/${id}.mjs`)).default,render={anime:renderAnime,paper:renderPaper,pixel:renderPixel}[D.style];
    for(const c of poses.STAGE_CLIPS) for(let i=0;i<c.frames;i++) {
      const svg=render(D,c.pose(i,{E:D.E}));
      assert.match(svg,new RegExp(`viewBox="0 0 ${c.wide?320:192} 208"`),`${id}/${c.name}/${i}`);
      assert.doesNotMatch(svg,/NaN|undefined|Infinity/,`${id}/${c.name}/${i}`);
      if(id==='bit') {assert.doesNotMatch(svg,/<path|<ellipse|rotate\(/);assert.match(svg,/shape-rendering="crispEdges"/);}
    }
  }
});
test('stage reactions honor the character expression map after choosing the reaction',async()=>{
  const D=(await import('../plugins/sleight/skills/make-character/tool/cast/tsugi.mjs')).default;
  const cheer=poses.STAGE_CLIPS.find(c=>c.name==='stage-cheer').pose(1);
  assert.ok(renderAnime(D,cheer)!==renderAnime({...D,expr:{grin:'flat'}},cheer),'reaction ignores design expression mapping');
});
test('Kit keeps the anime fox rig when dispatched through the unified generator', async () => {
  const D = (await import('../plugins/sleight/skills/make-character/tool/cast/kit.mjs')).default;
  assert.equal(isCritter(D), false); assert.deepEqual(stageBlock(D), stageManifest(D));
  for (const c of [...poses.CLIPS, ...poses.PERCH_CLIPS, ...poses.STAGE_CLIPS]) {
    assert.equal(renderPose(D, c, 0, c.wide ? 320 : 192), renderAnime(D, c.pose(0, { E: D.E })), c.name);
  }
});
test('the p170 anime hair masks and isolated shine proof survive the stage integration', async () => {
  for (const id of ['tsugi', 'shizu', 'yori']) {
    const D = (await import(`../plugins/sleight/skills/make-character/tool/cast/${id}.mjs`)).default;
    const pose = poses.CLIPS[0].pose(0, { E: D.E });
    const base = renderAnime(D, pose), proof = renderAnime(D, pose, { proof: 'shine' });
    assert.match(base, /<mask /, id); assert.match(proof, /mask="url\(#/, id); assert.notEqual(proof, base, id);
    assert.match(renderPose(D, poses.STAGE_CLIPS[0], 0, 320), /<mask /, `${id} stage`);
  }
});
test('format uses wide 2x lying strips and nearest filtering for Bit',()=>{
  const stage=stageManifest({style:'pixel'});
  assert.deepEqual(stage.cell,{w:384,h:416});assert.deepEqual(stage.lie.cell,{w:640,h:416});
  assert.equal(stage.filter,'nearest');assert.equal(Object.keys(stage.states).length,21);
  assert.deepEqual(stage.states['stage-hang'].anchor,{x:192,y:44});
  assert.deepEqual(stage.states['stage-sit'].anchor,{x:192,y:284});
});
test('pixel checks reject an empty cell, a solid cell, wrong geometry, and warn on clipped ink',()=>{
  const img={width:10,height:10,data:Buffer.alloc(400)};
  assert.equal(checkStagePixels(img,1,10,10).problems.length,1);
  img.data.fill(255);assert.equal(checkStagePixels(img,1,10,10).problems.length,1);
  assert.equal(checkStagePixels(img,1,10,10).warnings.length,1);
  assert.deepEqual(checkStagePixels(img,2,10,10).problems,['wrong strip geometry']);
});
