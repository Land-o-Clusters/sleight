import test from 'node:test';
import assert from 'node:assert/strict';
import { WINDOWS_DRIVER_ERRORS, formatWindowsDriverError, isWindowsDriverError } from '../plugins/sleight/lib/windows-driver/errors.mjs';
import { MAC_DRIVER_SENTENCES, formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { windowsClipboardError } from '../plugins/sleight/lib/windows-driver/clipboard.mjs';

test('the five Windows codes and their recovery match UC3F section 7', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(WINDOWS_DRIVER_ERRORS).map(([code, { next }]) => [code, next])), {
    PERSON_TOOK_OVER: 'stop-tell-user', SCREEN_LOCKED: 'ask-user', SECURE_DESKTOP_ACTIVE: 'ask-user',
    USER_STOPPED: 'stop-tell-user', BROWSER_TARGET_REFUSED: 'stop-tell-user',
  });
  // Shared codes keep the Mac's sentence, so the model's recovery table is one table.
  assert.equal(WINDOWS_DRIVER_ERRORS.PERSON_TOOK_OVER.message, MAC_DRIVER_SENTENCES.PERSON_TOOK_OVER);
  assert.equal(WINDOWS_DRIVER_ERRORS.USER_STOPPED.message, MAC_DRIVER_SENTENCES.USER_STOPPED);
});

for (const code of Object.keys(WINDOWS_DRIVER_ERRORS)) test(`${code} formats without falling back to DRIVER_PROTOCOL`, () => {
  const line = formatWindowsDriverError({ code, delivery: 'not-sent', retry: 'safe' }, { action: true });
  assert.ok(line.startsWith(`sleight: ${code}: ${WINDOWS_DRIVER_ERRORS[code].message}`), line);
  assert.match(line, /delivery=not-sent; retry=safe;/);
  assert.match(line, new RegExp(`next=${WINDOWS_DRIVER_ERRORS[code].next}: `));
  assert.doesNotMatch(line, /DRIVER_PROTOCOL|Read the app state before/);
});

test('reason and typed are carried only in their fixed shapes', () => {
  assert.match(formatWindowsDriverError({ code: 'SCREEN_LOCKED', delivery: 'not-sent', reason: 'session-locked' }), /reason=session-locked;/);
  assert.match(formatWindowsDriverError({ code: 'PERSON_TOOK_OVER', delivery: 'sent-unverified', typed: 64 }), /typed=64;/);
  for (const reason of ['Session Locked', 'x; next=none', 'a'.repeat(41), 7]) {
    assert.doesNotMatch(formatWindowsDriverError({ code: 'SCREEN_LOCKED', delivery: 'not-sent', reason }), /reason=/);
  }
  for (const typed of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    assert.doesNotMatch(formatWindowsDriverError({ code: 'USER_STOPPED', delivery: 'sent-unverified', typed }), /typed=/);
  }
});

test('only proven non-delivery allows a safe retry', () => {
  for (const delivery of ['sent-unverified', 'sent-verified', 'unknown', 'bogus', undefined]) {
    const line = formatWindowsDriverError({ code: 'PERSON_TOOK_OVER', delivery, retry: 'safe' }, { action: true });
    assert.match(line, /retry=read-first;/, String(delivery));
    assert.match(line, /Read the app state before repeating any input\.$/);
  }
  assert.match(formatWindowsDriverError({ code: 'SCREEN_LOCKED', delivery: 'not-sent', retry: 'read-first' }), /retry=read-first;/);
});

test('other codes keep the Mac formatter, so CLIPBOARD_CHANGED reads as before', () => {
  const clipboard = { code: 'CLIPBOARD_CHANGED', delivery: 'sent-unverified', retry: 'read-first', clipboard: 'untouched' };
  assert.equal(formatWindowsDriverError(clipboard, { action: true }), formatMacDriverError(clipboard, { action: true }));
  assert.match(formatWindowsDriverError({ code: 'NO_SUCH_CODE' }), /^sleight: DRIVER_PROTOCOL: /);
  assert.equal(isWindowsDriverError({ code: 'CLIPBOARD_CHANGED' }), false);
  assert.equal(isWindowsDriverError({ error: { code: 'SCREEN_LOCKED' } }), true);
});

test('windowsClipboardError rewrites the clipboard and Windows codes and leaves others alone', () => {
  const clipboard = Object.assign(new Error('raw'), { code: 'CLIPBOARD_CHANGED', delivery: 'sent-unverified' });
  assert.equal(windowsClipboardError(clipboard).message, formatMacDriverError({ code: 'CLIPBOARD_CHANGED', delivery: 'sent-unverified' }, { action: true }));
  const locked = Object.assign(new Error('raw'), { code: 'SCREEN_LOCKED', delivery: 'not-sent', reason: 'screensaver' });
  assert.match(windowsClipboardError(locked).message, /^sleight: SCREEN_LOCKED: .*reason=screensaver;/);
  const other = Object.assign(new Error('raw'), { code: 'WINDOW_NOT_FOUND' });
  assert.equal(windowsClipboardError(other).message, 'raw');
});

test('identity diagnostics carry only fixed failing steps into error text', () => {
  for (const code of ['TARGET_UNAVAILABLE', 'HOSTED_APP_UNRESOLVED']) {
    for (const step of ['image', 'integrity', 'desktop-owner', 'frame-class', 'frame-pid', 'frame-child', 'frame-scan', 'frame-limit', 'frame-package']) {
      const source = { code, message: code + ': step=' + step, delivery: 'not-sent', retry: 'safe' };
      assert.match(formatWindowsDriverError(source), new RegExp(' step=' + step + ';$'));
      assert.match(formatWindowsDriverError({ error: source }), new RegExp(' step=' + step + ';$'));
    }
    for (const detail of ['private-title', 'C:\\private\\fixture', 'https://fixture.invalid/', 'person-name'])
      assert.doesNotMatch(formatWindowsDriverError({ code, message: 'step=' + detail }), /step=/);
  }
});
