import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as module from '../plugins/sleight/lib/read-failure.mjs';
test('app hang diagnosis requires a fresh successful control read', () => {
  assert.equal(typeof module.classifyReadFailure, 'function');
  assert.equal(module.classifyReadFailure({ target: { status: 'timeout' }, control: { status: 'responding' }, read: { status: 'responding' } }), 'app-hung');
  assert.equal(module.classifyReadFailure({ target: { status: 'timeout' }, control: { status: 'responding' }, read: { status: 'timeout' } }), 'unknown');
});
test('helper advice requires two responsive AX processes and a failed engine control read', () => {
  assert.equal(typeof module.classifyReadFailure, 'function');
  assert.equal(module.classifyReadFailure({ target: { status: 'responding', windows: 1 }, control: { status: 'responding', windows: 1 }, read: { status: 'timeout' } }), 'helper-stuck');
  for (const status of ['denied', 'absent', 'unknown', 'timeout']) {
    assert.equal(module.classifyReadFailure({ target: { status }, control: { status: 'responding' }, read: { status: 'timeout' } }), 'unknown');
  }
});
test('a responsive control with missing target windows identifies an app window fault', () => {
  assert.equal(typeof module.classifyReadFailure, 'function');
  assert.equal(module.classifyReadFailure({ target: { status: 'responding', windows: 0 }, read: { status: 'responding' } }), 'app-windows');
  assert.equal(module.classifyReadFailure({ target: { status: 'responding', windows: 1 }, read: { status: 'responding' } }), 'app-read');
});
test('unknown diagnosis never instructs a ChatGPT restart or an app quit', () => {
  assert.equal(typeof module.readFailureAdvice, 'function');
  const advice = module.readFailureAdvice('textedit', { kind: 'unknown' });
  assert.doesNotMatch(advice, /(?:restart|quit) ChatGPT|quit textedit/i);
  assert.match(advice, /not determined|could not distinguish/i);
});
test('app hang advice points at the app and preserves unsaved work', () => {
  assert.equal(typeof module.readFailureAdvice, 'function');
  const advice = module.readFailureAdvice('textedit', { kind: 'app-hung', control: 'calculator' });
  assert.match(advice, /calculator.*respond|respond.*calculator/i);
  assert.match(advice, /quit.*textedit/i); assert.match(advice, /unsaved/i);
  assert.doesNotMatch(advice, /restart ChatGPT/);
});
test('independent probe failures and absent control apps stay unknown', async () => {
  assert.equal(typeof module.diagnoseReadFailure, 'function');
  const failure = await module.diagnoseReadFailure('textedit', 'calculator', {
    probeApp: async () => { throw new Error('denied'); }, readControl: async () => ({ status: 'timeout' }),
  });
  assert.equal(failure.kind, 'unknown');
  const absent = await module.diagnoseReadFailure('textedit', undefined, {
    probeApp: async () => ({ status: 'timeout' }), readControl: async () => { throw new Error('must not acquire an unapproved app'); },
  });
  assert.equal(absent.kind, 'unknown');
});
test('an app whose windows are all on another Space is diagnosed without a control app', async () => {
  // On another Space an app's windows leave AXWindows, so only CGWindowList counts them.
  const away = { status: 'responding', windows: 0, minimized: 0, hidden: false, onScreen: 0, allWindows: 2, fullScreenSpace: true };
  assert.equal(module.offSpace(away), true);
  assert.equal(module.offSpace({ status: 'timeout', hidden: false, onScreen: 0, allWindows: 1, fullScreenSpace: true }), true);
  for (const health of [{ ...away, onScreen: 1 }, { ...away, hidden: true }, { ...away, minimized: 2 }, { ...away, allWindows: 0 },
    { ...away, fullScreenSpace: false }, { ...away, fullScreenSpace: undefined }, { status: 'absent' }]) {
    assert.equal(module.offSpace(health), false, JSON.stringify(health));
  }
  const diagnosis = await module.diagnoseReadFailure('TextEdit', undefined, { probeApp: async () => away });
  assert.equal(diagnosis.kind, 'app-off-space');
  const advice = module.readFailureAdvice('TextEdit', diagnosis);
  assert.match(advice, /none of TextEdit's windows are on it/); assert.match(advice, /full-screen or Split View/);
  assert.doesNotMatch(advice, /quit|restart ChatGPT/i);
});
