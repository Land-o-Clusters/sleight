import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTargetPolicy } from '../plugins/sleight/lib/local-tool-policy.mjs';

// sa1q review SHOULD-FIX: an empty resolved bundle id must not blank the app name in the refusal.
test('local tool refusal names the app when the resolved bundle id is empty', () => {
  for (const app of ['Terminal', 'iTerm', 'Codex']) {
    const { refusal } = localTargetPolicy('hover', { app }, { app, appId: '' });
    assert.ok(refusal, `${app} is refused`);
    assert.match(refusal, new RegExp(app), `${app} named in: ${refusal}`);
    assert.doesNotMatch(refusal, /refuses {2}/);
  }
});
