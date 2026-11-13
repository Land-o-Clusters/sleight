import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createCharacterStageCache } from '../../plugins/sleight/lib/hand/character-stage.mjs';
import { checkBuiltinCharacter } from '../../plugins/sleight/lib/hand/character.mjs';
import { fixtureRender } from './character-stage-render.mjs';
const [root, count, mode, release] = process.argv.slice(2);
// Widen the real owner's write window without adding a production test hook. In the atomic writer,
// openSync supplies the temporary file's descriptor; at the old writer, writeFileSync gets owner.json.
if (mode === 'slow-owner') {
  const open = fs.openSync, write = fs.writeFileSync, descriptors = new Map();
  fs.openSync = function (path, ...args) {
    const fd = open.call(this, path, ...args); descriptors.set(fd, String(path)); return fd;
  };
  fs.writeFileSync = function (target, data, options) {
    const path = typeof target === 'number' ? descriptors.get(target) : String(target);
    if (!path?.includes('owner.json')) return write.call(this, target, data, options);
    const bytes = Buffer.from(data), half = Math.floor(bytes.length / 2);
    write.call(this, target, bytes.subarray(0, half), options);
    process.send({ event: 'owner-writing' });
    const deadline = Date.now() + 5000, wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release)) {
      if (Date.now() >= deadline) throw Error('Slow owner was not released');
      Atomics.wait(wait, 0, 0, 5);
    }
    return write.call(this, target, bytes.subarray(half), typeof target === 'number' ? options : { flag: 'a' });
  };
  syncBuiltinESMExports();
} else if (mode === 'watch-owner') {
  const stat = fs.lstatSync; let sent = false;
  fs.lstatSync = function (path, ...args) {
    try { return stat.call(this, path, ...args); }
    finally {
      if (!sent && String(path) === join(root, 'tsugi', `.${'c'.repeat(64)}.lock`, 'owner.json')) {
        sent = true; process.send({ event: 'owner-read' });
      }
    }
  };
  syncBuiltinESMExports();
}
const cache = createCharacterStageCache({ root, fingerprint: () => 'c'.repeat(64), render: async options => {
  fs.appendFileSync(count, 'render\n', { mode: 0o600 });
  await new Promise(done => setTimeout(done, 200)); await fixtureRender(options);
} });
const loaded = await cache.ensure(checkBuiltinCharacter('tsugi'));
console.log(JSON.stringify({ key: loaded?.stageKey, states: Object.keys(loaded?.stage.states ?? {}).length }));
if (process.connected) process.disconnect();
