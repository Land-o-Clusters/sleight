// Keep selection independent of the own runtime's module graph.
export function selectRuntime(env = process.env) {
  const value = env.SLEIGHT_RUNTIME ?? 'engine';
  if (value !== 'engine' && value !== 'own') throw Error('SLEIGHT_RUNTIME must be engine or own.');
  return value;
}
