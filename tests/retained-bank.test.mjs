import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { retainedBank } from './helpers/retained-bank.mjs';

test('retained banks require explicit opt-in and print the unset reason', () => {
  assert.deepEqual(retainedBank('race-1017', [], ''), {
    path: '', skip: 'SLEIGHT_RETAINED_BANKS is unset; retained evidence test skipped',
  });
});

test('retained banks resolve the named root and identify missing evidence', () => {
  const root = join(import.meta.dirname, 'fixtures');
  assert.deepEqual(retainedBank('prompt-default.json', [], root), { path: join(root, 'prompt-default.json'), skip: false });
  const missing = retainedBank('absent-retained-bank', ['trace.jsonl'], root);
  assert.match(missing.skip, /SLEIGHT_RETAINED_BANKS lacks absent-retained-bank\/trace\.jsonl/);
});
