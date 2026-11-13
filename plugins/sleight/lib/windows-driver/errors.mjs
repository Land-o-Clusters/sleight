// Windows driver refusals the model sees (UC3F section 7). Codes shared with the Mac keep the Mac's sentence and
// recovery. Windows-only conditions get their own sentence here. They never go through normalizeMacDriverError,
// which maps codes outside the Mac's table to DRIVER_PROTOCOL.
import { MAC_DRIVER_NEXT, MAC_DRIVER_SENTENCES, formatMacDriverError } from '../mac-driver/errors.mjs';

const entry = (message, next) => Object.freeze({ message, next });
export const WINDOWS_DRIVER_ERRORS = Object.freeze({
  PERSON_TOOK_OVER: entry(MAC_DRIVER_SENTENCES.PERSON_TOOK_OVER, 'stop-tell-user'),
  SCREEN_LOCKED: entry('The Windows session is locked or inactive, so this request cannot run.', 'ask-user'),
  SECURE_DESKTOP_ACTIVE: entry('Windows is showing a secure prompt, such as a User Account Control prompt. ' +
    'Ask the user to answer it before continuing.', 'ask-user'),
  USER_STOPPED: entry(MAC_DRIVER_SENTENCES.USER_STOPPED, 'stop-tell-user'),
  BROWSER_TARGET_REFUSED: entry('This window belongs to a web browser. sleight does not drive browsers on Windows in this ' +
    'release, and browser turbo is unavailable on Windows.', 'stop-tell-user'),
});

const deliveryValues = new Set(['not-sent', 'sent-unverified', 'sent-verified', 'unknown']);
// Reasons are fixed driver words such as session-locked or screensaver, never text from an app or a page.
const reasonPattern = /^[a-z][a-z-]{0,39}$/;
const identitySteps = new Set(['identity', 'process', 'birth', 'image', 'version', 'session', 'integrity', 'catalog',
  'desktop', 'desktop-owner', 'frame', 'frame-scan', 'frame-class', 'frame-pid', 'frame-child', 'frame-limit', 'frame-package']);
export const windowsIdentityStep = value => identitySteps.has(value) ? value : undefined;

export const isWindowsDriverError = failure => {
  const code = (failure?.error ?? failure)?.code;
  return typeof code === 'string' && Object.hasOwn(WINDOWS_DRIVER_ERRORS, code);
};

// One line: `sleight: CODE: sentence delivery=…; retry=…; reason=…; typed=…; next=…: directive`. Any other code keeps
// the Mac formatter's line, so CLIPBOARD_CHANGED reads exactly as before.
export function formatWindowsDriverError(failure, { action = false } = {}) {
  if (!isWindowsDriverError(failure)) {
    const source = failure?.error ?? failure;
    const step = ['TARGET_UNAVAILABLE', 'HOSTED_APP_UNRESOLVED'].includes(source?.code)
      ? windowsIdentityStep(/\bstep=([a-z-]+)\b/.exec(source?.message ?? '')?.[1]) : undefined;
    const formatted = formatMacDriverError(failure, { action });
    return formatted + (step ? ` step=${step};` : '');
  }
  const source = failure?.error ?? failure;
  const { message, next } = WINDOWS_DRIVER_ERRORS[source.code];
  const hasDisposition = action || source.delivery !== undefined || source.retry !== undefined;
  const delivery = deliveryValues.has(source.delivery) ? source.delivery : 'unknown';
  // Only explicit proof of non-delivery permits a safe retry, as on the Mac.
  const retry = delivery === 'not-sent' && (source.retry === undefined || source.retry === 'safe') ? 'safe' : 'read-first';
  const fields = [];
  if (hasDisposition) fields.push(`delivery=${delivery}`, `retry=${retry}`);
  if (typeof source.reason === 'string' && reasonPattern.test(source.reason)) fields.push(`reason=${source.reason}`);
  if (Number.isSafeInteger(source.typed) && source.typed >= 0) fields.push(`typed=${source.typed}`);
  const shown = fields.length ? ` ${fields.join('; ')};` : '';
  const beforeRetry = hasDisposition && retry === 'read-first' ? ' Read the app state before repeating any input.' : '';
  return `sleight: ${source.code}: ${message}${shown} next=${next}: ${MAC_DRIVER_NEXT[next]}${beforeRetry}`;
}
