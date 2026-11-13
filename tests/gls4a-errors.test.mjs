import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { MAC_JS_DESCRIPTION } from '../plugins/sleight/lib/runtime-api.mjs';
import { MAC_REPL_DOCS } from '../plugins/sleight/lib/repl/docs.mjs';

test('GLS4-4 keyboard focus refusal states a fixed recovery without raising or focusing', () => {
  const result = formatMacDriverError({ code: 'KEY_FOCUS_UNAVAILABLE', message: 'KEY_FOCUS_UNAVAILABLE step=frontmost', delivery: 'not-sent', retry: 'safe' });
  assert.match(result, /Ask the user to make this window frontmost, then read again\./);
  assert.match(result, /sleight never takes focus\./);
  assert.doesNotMatch(result, /secondary action|AXRaise|raise the window/);
  const other = formatMacDriverError({ code: 'KEY_FOCUS_UNAVAILABLE', message: 'step=belief-read', delivery: 'not-sent' });
  assert.match(other, /Read the window again/);
});
test('GLS4-5 menu title refusal and both references name the callable number route', () => {
  const advice = "click the item's number; the menu need not be open";
  const result = formatMacDriverError({ code: 'ACTION_UNSUPPORTED', menuRefusal: 'menu-compound', delivery: 'not-sent', retry: 'safe' });
  assert.ok(result.includes(advice), result);
  assert.ok(MAC_JS_DESCRIPTION.includes(advice)); assert.ok(MAC_REPL_DOCS.includes(advice));
  assert.doesNotMatch(result, /menu compound|menu\(/);
  assert.doesNotMatch(result, /next=none/);
});
test('GLS4-5 terminal refusal never advertises retry=safe', () => {
  const result = formatMacDriverError({ code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
  assert.match(result, /next=none/); assert.doesNotMatch(result, /retry=safe/);
});
test('GLS4-4 native select_window missing-title refusal explains the existing 12-code-point rule', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/DriverTools.swift', import.meta.url), 'utf8');
  assert.match(source, /No exact title: unique ending after whitespace; 12\+ code points after trim\(\), excluding Cf\/M\./);
});
