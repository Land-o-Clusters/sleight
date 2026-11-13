import { macIdentityError, identityFieldStep } from '../repl/identity-steps.mjs';
// Decimal identities stay strings across IPC. FILETIME is already above JS's safe integer range.
import { win32 } from 'node:path';

const fail = code => { throw Object.assign(Error(code), { code }); };
const decimal = (value, max) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.exec(value)?.[0] === value && BigInt(value) <= max;
export function windowBinding(value) {
  const windowId = value?.windowId ?? value?.window;
  if (!decimal(windowId, 18446744073709551615n) || !decimal(value?.processStart, 9223372036854775807n)) fail('INVALID_PARAMS');
  if (Object.hasOwn(value, 'bindingId') && (typeof value.bindingId !== 'string' || !/^[a-f0-9]{32}$/.test(value.bindingId))) fail('INVALID_PARAMS');
  return { windowId, processStart: value.processStart, ...Object.hasOwn(value, 'bindingId') ? { bindingId: value.bindingId } : {} };
}
export function verifyWindowIdentity(expected, observed, platform = 'win32') {
  if (platform === 'darwin') {
    const valid = value => value && typeof value.windowId === 'string' && /^[1-9][0-9]*$/.test(value.windowId) &&
      typeof value.processStart === 'string' && value.processStart.length > 0 &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.bundleId === 'string' &&
      value.identityVerified === true;
    if (!valid(expected) || !valid(observed)) fail('IDENTITY_UNVERIFIED');
    for (const key of ['windowId', 'processStart', 'pid', 'bundleId']) {
      if (expected[key] !== observed[key]) throw macIdentityError(identityFieldStep(key));
    }
    return observed;
  }
  if (platform !== 'win32') fail('PLATFORM');
  if (!observed) fail('IDENTITY_CHANGED');
  if (win32.basename(observed.image ?? '').toLowerCase() === 'applicationframehost.exe' ||
      /^(?:ApplicationFrameWindow|Windows\.UI\.Core\.CoreWindow)$/i.test(observed.className ?? ''))
    fail('HOSTED_APP_UNRESOLVED');
  if (observed.refused) fail(observed.refused);
  const binding = windowBinding(expected);
  // Keep the High ceiling even when the driver runs elevated. The native
  // relative-RID check also refuses Medium targets above a Low driver.
  if (['high', 'system'].includes(observed.integrity)) fail('ELEVATED_TARGET');
  if (!['low', 'medium'].includes(observed.integrity)) fail('TARGET_UNAVAILABLE');
  if (binding.windowId !== observed.windowId || binding.processStart !== observed.processStart ||
      !Number.isSafeInteger(observed.pid) || observed.pid <= 0 || typeof observed.image !== 'string' || !observed.image) fail('IDENTITY_CHANGED');
  for (const key of ['pid', 'image', 'imageIdentity', 'originalFilename', 'productName', 'aumid', 'threadId', 'className',
    'coreWindowId', 'framePid', 'frameProcessStart', 'frameThreadId', 'bindingId', 'windowGeneration', 'topologyGeneration', 'desktopId', 'onCurrentDesktop']) {
    if (Object.hasOwn(expected, key) && expected[key] !== observed[key]) fail('IDENTITY_CHANGED');
  }
  return observed;
}

const tuple = (value, n) => Array.isArray(value) && value.length === n && value.every(x => Number.isFinite(x) && Math.abs(x) <= 100000);
const rectangle = value => tuple(value, 4) && value[2] > 0 && value[3] > 0;
const inside = (point, rect) => point[0] >= rect[0] && point[1] >= rect[1] && point[0] < rect[0] + rect[2] && point[1] < rect[1] + rect[3];
// A privacy projection for the hand seam. Unknown facts suppress the point entirely.
// The full desktop rect remains separate from screenshot/client pixel dimensions.
export function cursorGeometry(window, geometry, clientPoint) {
  if (!geometry || !tuple(clientPoint, 2) || !tuple(geometry.clientOrigin, 2) || !tuple(geometry.clientSize, 2) ||
      geometry.clientSize.some(n => n <= 0) || !rectangle(geometry.rect) ||
      !['exposed', 'covered', 'offscreen', 'other-space', 'minimized'].includes(geometry.exposure) ||
      !Array.isArray(geometry.covers) || !geometry.covers.every(rectangle) ||
      !Array.isArray(geometry.monitors) || !geometry.monitors.length || !geometry.monitors.every(rectangle) ||
      !Number.isInteger(geometry.dpi) || geometry.dpi < 48 || geometry.dpi > 768 ||
      !inside(clientPoint, [0, 0, ...geometry.clientSize])) return;
  let binding;
  try { binding = windowBinding(window); verifyWindowIdentity(window, window); } catch { return; }
  // Cursor v1's id is a safe integer. Never round an HWND to fit it.
  if (BigInt(binding.windowId) > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(window.pid) || window.pid <= 0) return;
  const point = clientPoint.map((n, i) => n + geometry.clientOrigin[i]);
  if (!tuple(point, 2)) return;
  const exposure = ['exposed', 'covered'].includes(geometry.exposure)
    ? !geometry.monitors.some(rect => inside(point, rect)) ? 'offscreen'
      : geometry.covers.some(rect => inside(point, rect)) ? 'covered' : 'exposed' : geometry.exposure;
  const result = { point, window: { id: Number(binding.windowId), pid: window.pid,
    rect: [...geometry.rect], exposure }, display: { scale: geometry.dpi / 96 } };
  if (typeof window.image === 'string' && window.image) result.window.app = win32.basename(window.image);
  if (typeof window.aumid === 'string' && window.aumid && !/[/\\\x00-\x1f\x7f]/.test(window.aumid)) result.window.appUserModelId = window.aumid;
  return result;
}
