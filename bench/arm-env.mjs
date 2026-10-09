// Keep surface selection explicit in real trials, including arm preflight.
export function benchmarkArm(suite, arm, { root, base = process.env, extra = {} } = {}) {
  const env = { ...base, BENCH_ROOT: root, SLEIGHT_APPROVAL_PROMPT: 'client', ...arm.env, ...extra,
    ...(suite === 'real' ? { SLEIGHT_SURFACES: 'computer' } : {}),
  };
  return { env, resultMetadata: suite === 'real' ? { suite, surfaces: env.SLEIGHT_SURFACES } : {} };
}
