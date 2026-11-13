import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachPointerPlacement } from '../plugins/sleight/lib/hand/pointer-placement.mjs';
import { macCommandSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

// A Foundation-only helper exercises the real Darwin pipe and JXA lexical scope.
// It performs no app lookup, UI work, screenshot or input.
for (const answer of [true, false, null, 'stop']) test(`CH-4 real helper placement receipt ${answer}`, { skip: macCommandSkip('osascript') }, async t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-placement-pipe-'))));
  const helper = join(root, 'drag.js'), token = 'a'.repeat(32);
  writeFileSync(helper, `function run() {
    const before = Date.now();
    try {
      const placed = sleightPlaceHand({kind:'drag',pid:42,windowId:7,at:[10,20],path:[[10,20],[50,60]],delayMs:0,beats:1});
      return JSON.stringify({placed, elapsed:Date.now()-before, inputs:1});
    } catch(error) { return JSON.stringify({stopped:error.code, elapsed:Date.now()-before, inputs:0}); }
  }`);
  let child, detach, frames = 0;
  const completed = new Promise((resolve, reject) => {
    child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', new URL('../plugins/sleight/lib/hand/pointer-placement.js', import.meta.url).pathname,
      helper, '{}', token], { timeout: 10000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      detach?.(); if (error) reject(Object.assign(error, { message: stderr || error.message })); else resolve(JSON.parse(stdout));
    });
    if (answer !== null) detach = attachPointerPlacement(child, { token, place: () => {
      frames++; if (answer === 'stop') throw Error('stopped'); return answer;
    }, hide() {} });
  });
  const row = await completed;
  if (answer === 'stop') { assert.equal(row.stopped, 'USER_STOPPED'); assert.equal(row.inputs, 0); }
  else assert.equal(row.placed, answer === true);
  assert.equal(frames, answer === null ? 0 : 1);
  assert.ok(row.elapsed < 500, `bounded helper elapsed ${row.elapsed} ms`);
  t.diagnostic(`elapsed=${row.elapsed} ms, windows=0, input=0`);
});
