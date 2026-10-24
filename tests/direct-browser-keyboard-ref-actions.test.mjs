import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';

function fixture() {
  const page = new EventEmitter();
  page.getByRef = () => assert.fail('ref must be refused before resolution');
  const run = createActionRunner({ check: () => ({ verdict: 'allow' }), snapshot: async () => ({ text: '', number: 1 }) });
  return { page, run: steps => run({ page, state: {} }, steps, {}) };
}

for (const step of [
  { do: 'click', ref: 'x1' }, { do: 'hover', ref: 'x1' }, { do: 'scroll', ref: 'x1', dy: 10 },
  { do: 'check', ref: 'x1' }, { do: 'uncheck', ref: 'x1' }, { do: 'select', ref: 'x1', values: ['a'] },
  { do: 'upload', ref: 'x1', paths: ['fixture.txt'] }, { do: 'navigate', ref: 'x1' },
  { do: 'drag', ref: 'x1', to: 'e2' }, { do: 'drag', ref: 'e2', to: 'x1' },
]) test(`keyboard-only refs refuse ${step.do} before resolving a target (${step.ref} to ${step.to ?? '-'})`, async () => {
  await assert.rejects(fixture().run([step]), /keyboard-only refs support only type, paste and press/);
});

for (const step of [{ do: 'type', ref: 'x1', text: 'hello' }, { do: 'paste', ref: 'x1', text: 'hello' }, { do: 'press', ref: 'x1', key: 'ArrowLeft' }])
  test(`keyboard-only ${step.do} requires the trusted context before resolving a target`, async () => {
    const result = await fixture().run([step]);
    assert.match(result.lines[0], /not run:.*keyboard-only refs require a trusted context/);
  });

test('keyboard-only form filling requires a trusted context before target resolution', async () => {
  const { page } = fixture();
  const fill = createFillFields({ check: () => 'allow', runSteps: () => assert.fail('must refuse before delegation') });
  const result = await fill({ page, state: {} }, [{ ref: 'x1', value: 'hello' }], {}, {});
  assert.equal(result.rows[0].status, 'failed');
  assert.match(result.rows[0].reason, /keyboard-only refs require a trusted context/);
});

test('keyboard-only refs cannot be a form submit target or a non-text field', async () => {
  const { page } = fixture();
  const fill = createFillFields({ check: () => 'allow', runSteps: () => assert.fail('must refuse before delegation') });
  for (const value of [true, false, ['option']])
    await assert.rejects(fill({ page, state: {} }, [{ ref: 'x1', value }], {}, {}), /keyboard-only fields need text or a number/);
  await assert.rejects(fill({ page, state: {} }, [{ ref: 'e1', value: 'hello' }], { submit: 'x1' }, {}), /keyboard-only ref cannot submit/);
});
