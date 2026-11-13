// Compile/cache preparation only. Never spawn a driver, registrar or renderer.
import { prepareMacDriver } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export function glidePreparationSummary(preparation) {
  const p = preparation ?? {}, cache = p.compileCount > 0 || p.compileMs > 0 ? 'cold' : p.compileCount === 0 ? 'warm' : 'unknown';
  return [`GLIDE_PREPARATION: status=${p.status ?? 'unknown'} origin=${p.origin ?? 'unknown'} compileMs=${p.compileMs ?? 'unknown'} compileCount=${p.compileCount ?? 'unknown'} cache=${cache}.`,
    'Preparation is outside attempt timing. Attempts target a warm helper cache; a first call after an update pays compileMs before these timings.'];
}
export function glideBuildCheck(preparation, row) {
  const receipt = row.runtimeReceipt, valid = value => /^[a-f0-9]{64}$/.test(value ?? '');
  // prepareMacDriver.build and ping.build identify source, driverBuild hashes binary bytes.
  const preparedSourceBuild = preparation?.build, attemptSourceBuild = receipt?.driverSourceBuild,
    preparedBinarySha256 = preparation?.binarySha256, attemptBinarySha256 = receipt?.driverBuild;
  const pairs = [[preparedSourceBuild, attemptSourceBuild],
    ...(preparedBinarySha256 ? [[preparedBinarySha256, attemptBinarySha256]] : []),
    ...(receipt?.ping?.build ? [[preparedSourceBuild, receipt.ping.build]] : [])];
  const status = pairs.some(([a, b]) => valid(a) && valid(b) && a !== b) ? 'mismatch'
    : pairs.every(([a, b]) => valid(a) && valid(b)) ? 'match' : 'unverified';
  return { status, preparedSourceBuild, attemptSourceBuild, preparedBinarySha256, attemptBinarySha256 };
}
export function glideBuildSummary(rows) {
  return rows.filter(row => row.glideBuildCheck).map(row => {
    const c = row.glideBuildCheck;
    return `GLIDE_BUILD_${c.status === 'match' ? 'MATCH' : c.status === 'mismatch' ? 'MISMATCH' : 'UNVERIFIED'}: ${row.arm ?? row.runtime}/${row.task} #${row.run}: ` +
      `prepared source=${c.preparedSourceBuild ?? 'unknown'} attempt source=${c.attemptSourceBuild ?? 'unknown'}; ` +
      `prepared binary=${c.preparedBinarySha256 ?? 'unknown'} attempt binary=${c.attemptBinarySha256 ?? 'unknown'}.`;
  });
}

export async function prepareGlide({ signal, prepare = prepareMacDriver, now = () => performance.now() } = {}) {
  const started = now();
  let compileStart, compileMs = 0, compileCount = 0;
  const progress = event => {
    const at = now();
    if (compileStart !== undefined) compileMs += at - compileStart;
    compileStart = event.stage === 'compile' && !event.status ? at : undefined;
    if (compileStart !== undefined) compileCount++;
  };
  const timing = () => ({ elapsedMs: now() - started,
    compileMs: compileMs + (compileStart === undefined ? 0 : now() - compileStart), compileCount });
  try {
    signal?.throwIfAborted();
    const host = await prepare({ signal, onProgress: progress });
    progress({ stage: 'complete' });
    return { status: host.status, ...(host.code && { code: host.code }),
      ...(host.origin && { origin: host.origin }), ...(host.build && { build: host.build }),
      ...(host.binary && existsSync(host.binary) && { binarySha256: createHash('sha256').update(readFileSync(host.binary)).digest('hex') }), ...timing() };
  } catch (error) {
    progress({ stage: 'complete' });
    error.preparation = { status: 'unavailable', ...timing() };
    throw error;
  }
}
