import * as fs from 'node:fs';
import { join } from 'node:path';
import { encodePNG } from '../../plugins/sleight/skills/make-character/tool/lib/png.mjs';
import { STAGE_STATES } from '../../plugins/sleight/lib/hand/character.mjs';

export async function fixtureRender({ output }) {
  fs.mkdirSync(join(output, 'stage'), { mode: 0o700 });
  const data = Buffer.alloc(384 * 416 * 4);
  for (let y = 50; y < 70; y++) for (let x = 50; x < 70; x++) data.set([180, 90, 10, 255], (y * 384 + x) * 4);
  const png = encodePNG({ width: 384, height: 416, data });
  const stage = { cell: { w: 384, h: 416 }, anchor: { x: 192, y: 392 }, states: {} };
  for (const name of Object.keys(STAGE_STATES)) {
    const file = `stage/${name.slice(6)}.png`;
    fs.writeFileSync(join(output, file), png, { mode: 0o600 });
    stage.states[name] = { file, frames: 1, ms: 100, loop: true };
  }
  fs.writeFileSync(join(output, 'stage.json'), JSON.stringify(stage), { mode: 0o600 });
}
