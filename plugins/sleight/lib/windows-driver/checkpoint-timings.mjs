// Sitting-only telemetry. The constructor controls admission, never tool args.
export const CHECKPOINT_NAMES = Object.freeze(['session-probe', 'lock-check', 'desktop-check',
  'person-input', 'budget-check', 'hook-install', 'hook-remove', 'hook-callback']);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const duration = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const count = n => Number.isInteger(n) && n >= 0 && n <= 2147483647;

export function validCheckpointTimings(result) {
  const first = result?.checkpointTimings, buffers = result?.checkpointTimingSamples;
  if (!first || typeof first !== 'object' || Array.isArray(first) ||
      Object.keys(first).some(key => !CHECKPOINT_NAMES.includes(key)) ||
      !exact(buffers, ['checks', 'hookLifecycle'])) return false;
  const observed = {};
  for (const [name, capacity, allowed] of [
    ['checks', 65536, CHECKPOINT_NAMES.slice(0, 5)],
    ['hookLifecycle', 256, ['hook-install', 'hook-remove']],
  ]) {
    const buffer = buffers[name];
    if (!exact(buffer, ['capacity', 'start', 'sampled', 'omitted', 'samples']) || buffer.capacity !== capacity ||
        !count(buffer.start) || !count(buffer.sampled) || !count(buffer.omitted) ||
        buffer.start > buffer.sampled || buffer.sampled > capacity ||
        buffer.omitted > 0 && buffer.sampled !== capacity ||
        !Array.isArray(buffer.samples) || buffer.samples.length !== buffer.sampled - buffer.start) return false;
    for (const sample of buffer.samples) {
      if (!exact(sample, ['checkpoint', 'elapsedMs']) || !allowed.includes(sample.checkpoint) || !duration(sample.elapsedMs)) return false;
      observed[sample.checkpoint] ??= sample.elapsedMs;
    }
  }
  for (const name of CHECKPOINT_NAMES) {
    if (name === 'hook-callback') {
      if (Object.hasOwn(first, name) && (!exact(first[name], ['elapsedUs']) || !duration(first[name].elapsedUs))) return false;
    } else if (Object.hasOwn(observed, name)) {
      if (!exact(first[name], ['elapsedMs']) || first[name].elapsedMs !== observed[name]) return false;
    } else if (Object.hasOwn(first, name)) return false;
  }
  return true;
}
