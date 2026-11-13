// Private optimized diagnostic build. The product source changes only by installing a read-only observer.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { helperCompileArgs } from '../../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { checkBuiltinCharacter, installCharacter, loadCharacter, STAGE_STATES } from '../../plugins/sleight/lib/hand/character.mjs';
import { createCharacterStageCache } from '../../plugins/sleight/lib/hand/character-stage.mjs';
import { privateStageHome } from './private-stage-home.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
export const HOST = join(root, 'plugins/sleight/lib/direct-browser/native/consent-host.swift');
export function observerSource(text) {
  const marker = 'let app = NSApplication.shared\nif arguments.isEmpty';
  const hand = '    let hand = HandHost()\n    hand.settingsMenu = settingsMenu';
  if (text.split(marker).length !== 2 || text.split(hand).length !== 2) throw Error('Check 4 host observation seam changed');
  return text.replace(marker, 'check4StartObserver()\n' + marker)
    .replace(hand, '    let hand = HandHost()\n    hand.perch.stage.trace = check4MakeTrace()\n    hand.settingsMenu = settingsMenu');
}
export async function buildCheck4(work, execute) {
  const main = join(work, 'main.swift'), host = join(work, 'consent-host'), sampler = join(work, 'check4-sampler'), area = join(work, 'check4-area');
  writeFileSync(main, privateStageHome(observerSource(readFileSync(HOST, 'utf8')), work), { mode: 0o600 });
  const modules = join(work, 'modules');
  await execute('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', ...helperCompileArgs('consent-host', {
    sources: [main, join(root, 'bench/hand/check4-host.swift')], binary: host, moduleCache: modules,
    settingsFlags: ['-D', 'SLEIGHT_STAGE_BENCH'], recipe: 'optimized',
  })], { timeout: 600000, maxBuffer: 8 << 20 });
  await execute('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', ...helperCompileArgs('benchmark-helper', {
    sources: [join(root, 'bench/hand/check4-sampler.swift')], binary: sampler, moduleCache: modules,
  })], { timeout: 300000, maxBuffer: 4 << 20 });
  await execute('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', ...helperCompileArgs('benchmark-helper', {
    sources: [join(root, 'bench/hand/check4-area.swift')], binary: area, moduleCache: modules,
  })], { timeout: 300000, maxBuffer: 4 << 20 });
  return { host, sampler, area };
}
export async function prepareMabel(work, { original = checkBuiltinCharacter('mabel'),
  cache = createCharacterStageCache({ root: join(work, 'stage-cache') }) } = {}) {
  const cached = await cache.ensure(original);
  if (!cached) throw Error('Mabel stage generation failed; medium fallback cannot qualify check 4');
  const files = new Map(cached.files), manifest = { ...cached.manifest, id: 'stage-bench-art' };
  // Cached built-ins keep their generated strips in stageFolder, outside the base pack's files snapshot.
  for (const [name, pin] of Object.entries(cached.stagePins ?? {})) {
    const bytes = readFileSync(join(cached.stageFolder, name));
    if (createHash('sha256').update(bytes).digest('hex') !== pin) throw Error('Mabel stage strip changed during private copy');
    files.set(name, bytes);
  }
  files.set('character.json', Buffer.from(JSON.stringify(manifest)));
  const bank = join(work, 'characters'); mkdirSync(bank, { mode: 0o700 });
  const folder = installCharacter({ files }, { root: realpathSync(bank) });
  const installed = loadCharacter(folder);
  if (!installed.stage.available || Object.values(installed.stage.states).filter(s => s.own).length !== Object.keys(STAGE_STATES).length)
    throw Error('Private Mabel pack is missing stage art; medium fallback cannot qualify check 4');
  const hash = createHash('sha256'); for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name + '\0').update(bytes);
  return { folder, identity: { id: 'mabel', privateId: manifest.id, sha256: hash.digest('hex') } };
}
