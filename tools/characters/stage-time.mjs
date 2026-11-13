// Offline cold-render measurement. All cache writes stay in this owned temporary bank.
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { createCharacterStageCache, spawnStageRender } from '../../plugins/sleight/lib/hand/character-stage.mjs';
import { checkBuiltinCharacter, BUILTIN_CHARACTER_IDS, resolveCharacterStates } from '../../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../../plugins/sleight/lib/hand/character-frame.mjs';
const base = fs.realpathSync(fs.mkdtempSync('/private/tmp/sleight-stage-timing-'));
try {
  for (const id of process.argv[2] === '--all' ? BUILTIN_CHARACTER_IDS : ['tsugi', 'dennis']) {
    const start = performance.now(), logs = [];
    const result = await createCharacterStageCache({ root: join(base, id), log: x => logs.push(x), render: async options => {
      try { await spawnStageRender(options); } catch (error) { console.error(error.diagnostic ?? error.message); throw error; }
    } }).ensure(checkBuiltinCharacter(id));
    if (!result) throw Error(logs.join('\n'));
    const coldMs = Math.round(performance.now() - start);
    const bytes = Object.values(result.stage.states).reduce((n, s) => n + fs.statSync(join(result.stageFolder, s.file)).size, 0);
    const frameBytes = Buffer.byteLength(JSON.stringify(characterFrame(result, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates })));
    console.log(JSON.stringify({ id, coldMs, states: Object.keys(result.stage.states).length, bytes, frameBytes, key: result.stageKey }));
  }
} finally { fs.rmSync(base, { recursive: true, force: true }); }
