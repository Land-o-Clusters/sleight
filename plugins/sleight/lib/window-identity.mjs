// AX references are meaningful only inside their helper epoch. The shared lease key remains
// conservative (same app/title), so separate helpers can never grant competing same-title input.
export function verifyWindowIdentity(expected, observed) {
  const stop = reason => { throw new Error('Input lease: ' + reason + '. Read the intended window again before acting.'); };
  if (observed?.status !== 'ok' || !observed.epoch || !Number.isSafeInteger(observed.window) ||
      !Number.isSafeInteger(observed.pid) || !Number.isFinite(observed.processStart)) stop('native window identity is unavailable');
  if (observed.matches !== 1) stop(`window identity is ambiguous (${observed.matches ?? 'unknown'} matching windows)`);
  if (['appId', 'title', 'url'].some(key => expected[key] !== observed[key])) stop('native window and engine header differ');
  if (expected.nativeIdentity && ['epoch', 'window', 'pid', 'processStart'].some(key => expected.nativeIdentity[key] !== observed[key])) {
    stop('the native window or its process changed');
  }
  return observed;
}
