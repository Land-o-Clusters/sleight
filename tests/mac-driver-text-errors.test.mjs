import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMacDriverError, personWaitNotice, PERSON_POINTER_NOTICE } from '../plugins/sleight/lib/mac-driver/errors.mjs';

test('default keyboard failure text adds fixed recovery without experiment diagnostics', () => {
  const expected = 'sleight: KEY_FOCUS_UNAVAILABLE: The target app did not enter or leave the required keyboard focus state.' +
    ' delivery=sent-unverified; retry=read-first; personTookOver=false;' +
    ' next=read-again: Read the current app state and choose the next step from that read.' +
    ' Read the app state before repeating any input.' +
    ' Read the window again; ask the user to restore its keyboard focus if needed. sleight never takes focus.';
  for (const method of ['pressKey', 'typeText', 'modifiers']) {
    for (const focusChanged of [false, true]) {
      const failure = { code: 'KEY_FOCUS_UNAVAILABLE', delivery: 'sent-unverified', retry: 'read-first',
        personTookOver: false, focusChanged, focusRestored: focusChanged,
        ...(method === 'typeText' ? { charactersDelivered: 32 } : {}) };
      assert.equal(formatMacDriverError(failure, { action: true }), expected, method);
    }
  }
});

test('only experiment receipts add text delivery and focus diagnostics', () => {
  for (const textBeliefFallback of [false, true]) {
    const text = formatMacDriverError({ code: 'ACTION_UNCONFIRMED', delivery: 'sent-unverified',
      charactersDelivered: 32, charactersPosted: 64, focusChanged: false, focusRestored: false,
      compositionBypassed: true, textBeliefFallback }, { action: true });
    assert.ok(text.includes(' charactersDelivered=32; charactersPosted=64; focusChanged=false; focusRestored=false;' +
      ` compositionBypassed=true; textBeliefFallback=${textBeliefFallback};`));
  }
});

test('experiment diagnostics preserve the person wait and pointer notices', () => {
  const text = formatMacDriverError({ code: 'PERSON_TOOK_OVER', delivery: 'sent-unverified', retry: 'read-first',
    personTookOver: true, reason: 'person-pointer', waitedForPersonMs: 1200,
    charactersDelivered: 32, charactersPosted: 64, textBeliefFallback: false }, { action: true });
  assert.ok(text.includes(' charactersDelivered=32; charactersPosted=64; textBeliefFallback=false;'));
  assert.ok(text.includes(PERSON_POINTER_NOTICE));
  assert.ok(text.endsWith('\n' + personWaitNotice(1200)));
});
