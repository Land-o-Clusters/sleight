// AX references are meaningful only inside their helper epoch. The shared lease key remains
// conservative (same app/title), so separate helpers can never grant competing same-title input.
export function verifyWindowIdentity(expected, observed) {
  // This function is also serialized into the engine guard, so keep it self-contained.
  const fieldStep = key => ({ appId: 'bundle-id', processStart: 'process-start', windowNumber: 'window-number' }[key] ?? key);
  // Only a select_window pin needs reselection. Other sources keep their read advice.
  // Inventory the conditional tool name so its advice stays within the prompt budget.
  const read = typeof expected?.appId === 'string' && expected.appId && expected.appId.length <= 256
    ? expected.windowNumberSource === 'selection'
      ? /* notice */ 'select_window'
      : `await cua.getApp(${JSON.stringify(expected.appId)})`
    : 'await cua.getState()';
  const stop = (reason, category = 'Unconfirmed target identity', step = 'native-identity') => {
    throw Object.assign(new Error('Input lease: step=' + step + ' ' + reason + `. ${category}. Read the intended window again before acting. Next: ${read}.`), { identityStep: step });
  };
  if (!expected) stop('native window identity is unavailable', 'Unconfirmed target identity', 'expected-missing');
  if (observed?.status === 'mismatch') stop('the native window changed', 'Unconfirmed target identity',
    ({ 'Known window number disappeared': 'window-number', 'Focused window differs': 'window-root',
      'Window owner process changed': 'window-metadata', 'Window owner process changed during inspection': 'window-metadata' }[observed.error] ?? 'native-identity'));
  if (observed?.status !== 'ok' || !observed.epoch || !Number.isSafeInteger(observed.window) ||
      !Number.isSafeInteger(observed.pid) || !Number.isFinite(observed.processStart) ||
      ('windowNumber' in observed && (!Number.isSafeInteger(observed.windowNumber) || observed.windowNumber <= 0))) {
    const missing = [observed?.status !== 'ok' && 'status=ok', !observed?.epoch && 'epoch',
      !Number.isSafeInteger(observed?.window) && 'window', !Number.isSafeInteger(observed?.pid) && 'pid',
      !Number.isFinite(observed?.processStart) && 'processStart',
      observed && 'windowNumber' in observed && (!Number.isSafeInteger(observed.windowNumber) || observed.windowNumber <= 0) && 'windowNumber'].filter(Boolean);
    stop('native window identity is unavailable', 'Missing target identity: ' + missing.join(', '));
  }
  if (observed.matches !== 1) stop('window identity is ambiguous', 'Unconfirmed target identity', 'window-inventory');
  for (const key of ['appId', 'title', 'url']) if (expected[key] !== observed[key])
    stop('native window and engine header differ', 'Unconfirmed target identity', fieldStep(key));
  if (expected.windowNumber !== undefined && expected.windowNumber !== observed.windowNumber) stop('the selected window number changed', 'Changed target identity', 'window-number');
  if (expected.nativeIdentity) for (const key of ['epoch', 'window', 'windowNumber', 'pid', 'processStart'])
    if (expected.nativeIdentity[key] !== observed[key]) stop('the native window or its process changed', 'Changed target identity', fieldStep(key));
  return observed;
}
