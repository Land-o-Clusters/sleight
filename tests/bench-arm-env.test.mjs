import test from 'node:test';
import assert from 'node:assert/strict';

test('real trials force the computer surface over inherited and per-run browser settings', async () => {
  const { benchmarkArm } = await import('../bench/arm-env.mjs').catch(() => ({}));
  assert.equal(typeof benchmarkArm, 'function');
  const result = benchmarkArm('real', { env: { SLEIGHT_SURFACES: 'browser' } }, {
    root: '/fixture', base: { SLEIGHT_SURFACES: 'computer,browser', KEEP: 'inherited' },
    extra: { SLEIGHT_SURFACES: 'browser', SLEIGHT_TRACE: '/evidence' },
  });
  assert.equal(result.env.SLEIGHT_SURFACES, 'computer');
  assert.equal(result.env.SLEIGHT_TRACE, '/evidence');
  assert.equal(result.env.KEEP, 'inherited');
  assert.equal(result.env.SLEIGHT_APPROVAL_PROMPT, 'client');
  assert.deepEqual(result.resultMetadata, { suite: 'real', surfaces: 'computer' });
});

test('default trials preserve the caller surface selection and original result metadata', async () => {
  const { benchmarkArm } = await import('../bench/arm-env.mjs').catch(() => ({}));
  assert.equal(typeof benchmarkArm, 'function');
  const result = benchmarkArm('default', { env: {} }, {
    root: '/fixture', base: { SLEIGHT_SURFACES: 'computer,browser' },
  });
  assert.equal(result.env.SLEIGHT_SURFACES, 'computer,browser');
  assert.deepEqual(result.resultMetadata, {});
});
