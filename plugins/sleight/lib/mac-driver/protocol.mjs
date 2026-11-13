import { readFileSync } from 'node:fs';

export const DRIVER_API_VERSION = 2;
export const MAC_DRIVER_READ_NOTICES = Object.freeze({
  selection: 'sleight: the selection may identify the content the user means.',
  noFocus: 'sleight: no element in this read reports focus.',
  rendererRetained: 'sleight: renderer attribute may remain enabled; quit the app to clear it.',
});
export const DRIVER_CODES = Object.freeze(Object.fromEntries(Object.entries(
  JSON.parse(readFileSync(new URL('./protocol-codes.json', import.meta.url), 'utf8'))).map(([code, row]) => [code, Object.freeze(row)])));
export const DRIVER_ACTION_METHODS = Object.freeze(['click', 'doubleClick', 'rightClick', 'scroll', 'drag',
  'typeText', 'pressKey', 'modifiers', 'setValue', 'selectText', 'performSecondaryAction', 'paste']);
// Metadata-only methods are the entire exemption set. All other names require session admission.
export const DRIVER_SESSION_EXEMPT_METHODS = Object.freeze(['ping', 'health', 'getState', 'listApps', 'listWindows', 'resolveApp']);
export const DRIVER_CORE_METHODS = Object.freeze(['ping', 'health', 'getState', 'listApps', 'listWindows',
  'resolveApp', 'getApp', 'getAXState', 'verifyWindowIdentity', 'resolveElement', 'getScreenshot', 'getAXStateAndScreenshot']);

export function driverContext(value) {
  if (value === undefined) return;
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => !['session', 'turn', 'call'].includes(key)) ||
      Object.values(value).some(item => typeof item !== 'string' || [...item].length > 128 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(item))) {
    throw Object.assign(new Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' });
  }
  return { ...value };
}
