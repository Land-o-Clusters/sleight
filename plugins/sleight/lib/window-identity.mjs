// AX references are meaningful only inside their helper epoch. The shared lease key remains
// conservative (same app/title), so separate helpers can never grant competing same-title input.
export function verifyWindowIdentity(expected, observed) {
  const read = typeof expected?.appId === 'string' && expected.appId && expected.appId.length <= 256
    ? `await cua.getApp(${JSON.stringify(expected.appId)})` : 'await cua.getState()';
  const stop = (reason, category = 'Unconfirmed target identity') => {
    throw new Error('Input lease: ' + reason + `. ${category}. Read the intended window again before acting. Next: ${read}.`);
  };
  if (observed?.status === 'mismatch') stop(observed.error || 'the native window changed');
  if (observed?.status !== 'ok' || !observed.epoch || !Number.isSafeInteger(observed.window) ||
      !Number.isSafeInteger(observed.pid) || !Number.isFinite(observed.processStart)) {
    const missing = [observed?.status !== 'ok' && 'status=ok', !observed?.epoch && 'epoch',
      !Number.isSafeInteger(observed?.window) && 'window', !Number.isSafeInteger(observed?.pid) && 'pid',
      !Number.isFinite(observed?.processStart) && 'processStart'].filter(Boolean);
    stop('native window identity is unavailable', 'Missing target identity: ' + missing.join(', '));
  }
  if (observed.matches !== 1) stop(`window identity is ambiguous (${observed.matches ?? 'unknown'} matching windows)`);
  if (['appId', 'title', 'url'].some(key => expected[key] !== observed[key])) stop('native window and engine header differ');
  if (expected.windowNumber !== undefined && expected.windowNumber !== observed.windowNumber) stop('the selected window number changed', 'Changed target identity');
  if (expected.nativeIdentity && ['epoch', 'window', 'pid', 'processStart'].some(key => expected.nativeIdentity[key] !== observed[key])) {
    stop('the native window or its process changed', 'Changed target identity');
  }
  return observed;
}
