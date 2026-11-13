import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyChord, keyboardArguments, keyPlan, textPlan } from '../plugins/sleight/lib/mac-driver/keys.mjs';

// Deliberately non-US: a and q occupy each other's US positions.
const layout = new Map([
  ['a', { keyCode: 12, modifiers: [] }], ['A', { keyCode: 12, modifiers: ['shift'] }],
  ['q', { keyCode: 0, modifiers: [] }], ['s', { keyCode: 1, modifiers: [] }],
  ['g', { keyCode: 5, modifiers: [] }], ['+', { keyCode: 24, modifiers: ['shift'] }],
  ['@', { keyCode: 19, modifiers: ['alt'] }],
]);
const event = (type, keyCode, flags = 0, unicode) => ({ type, keyCode, flags, ...(unicode === undefined ? {} : { unicode }) });

test('chords canonicalize aliases and modifier order without changing letter case', () => {
  assert.deepEqual(parseKeyChord('Command+Option+Control+Shift+A'), { modifiers: ['control', 'alt', 'shift', 'meta'], key: 'A' });
  assert.deepEqual(parseKeyChord('Super_L+s'), { modifiers: ['meta'], key: 's' });
  assert.deepEqual(parseKeyChord('CTRL+Page_Down'), { modifiers: ['control'], key: 'PageDown' });
  assert.deepEqual(parseKeyChord('shift+ctrl'), { modifiers: ['control', 'shift'], key: null });
});

for (const chord of ['', ' ', 'ctrl++s', 'ctrl+s+a', 'a+shift', 'ctrl+ctrl+s', 'meta+super+s', 'NoSuchKey', 's t', 'ctrl+', 'constructor', '__proto__', 'toString']) {
  test(`invalid chord ${JSON.stringify(chord)} refuses`, () => assert.throws(() => parseKeyChord(chord), { code: 'INVALID_PARAMS' }));
}

test('named keys and punctuation aliases resolve independently of a US character table', () => {
  assert.deepEqual(keyPlan('ctrl+Page_Down', layout), [event('flagsChanged', 59, 262144), event('keyDown', 121, 262144), event('keyUp', 121, 262144), event('flagsChanged', 59)]);
  assert.deepEqual(keyPlan('plus', layout), [event('flagsChanged', 56, 131072), event('keyDown', 24, 131072), event('keyUp', 24, 131072), event('flagsChanged', 56)]);
  assert.deepEqual(keyPlan('F12', layout), [event('keyDown', 111), event('keyUp', 111)]);
});

test('character keys use the supplied active layout including required modifiers', () => {
  assert.throws(() => keyPlan('super+A', layout), { code: 'ACTION_UNSUPPORTED' }); // Physical Q remains refused on this layout.
  assert.deepEqual(keyPlan('super+plus', layout), [event('flagsChanged', 56, 131072), event('flagsChanged', 55, 1179648), event('keyDown', 24, 1179648), event('keyUp', 24, 1179648), event('flagsChanged', 55, 131072), event('flagsChanged', 56)]);
  assert.deepEqual(keyPlan('q', layout), [event('keyDown', 0), event('keyUp', 0)]);
  assert.throws(() => keyPlan('z', layout), { code: 'KEY_UNMAPPABLE' });
});

test('bare modifier chords press then release in reverse order', () => {
  assert.deepEqual(keyPlan('control+alt', layout), [event('flagsChanged', 59, 262144), event('flagsChanged', 58, 786432), event('flagsChanged', 58, 262144), event('flagsChanged', 59)]);
});

test('the experimental ladder selects one strategy without replaying a chord', () => {
  assert.deepEqual(keyPlan('super+s', layout, { strategy: 'flags-only' }), [event('keyDown', 1, 1048576), event('keyUp', 1, 1048576)]);
  assert.deepEqual(keyPlan('super+s', layout, { strategy: 'key-events' }), [event('keyDown', 55, 1048576), event('keyDown', 1, 1048576), event('keyUp', 1, 1048576), event('keyUp', 55)]);
  assert.throws(() => keyPlan('s', layout, { strategy: 'retry-all' }), { code: 'INVALID_PARAMS' });
});

test('text maps characters and carries their Unicode payload without inheriting owner flags', () => {
  assert.deepEqual(textPlan('aA@', layout), [event('keyDown', 12, 0, 'a'), event('keyUp', 12, 0, 'a'), event('flagsChanged', 56, 131072), event('keyDown', 12, 131072, 'A'), event('keyUp', 12, 131072, 'A'), event('flagsChanged', 56), event('flagsChanged', 58, 524288), event('keyDown', 19, 524288, '@'), event('keyUp', 19, 524288, '@'), event('flagsChanged', 58)]);
});

test('Unicode fallback chunks never split a surrogate pair or exceed 32 UTF-16 units', () => {
  const text = '界'.repeat(31) + '🪄' + '界'.repeat(34);
  const plan = textPlan(text, layout), downs = plan.filter(e => e.type === 'keyDown');
  assert.deepEqual(downs.map(e => e.unicode.length), [31, 32, 4]);
  assert.equal(downs.map(e => e.unicode).join(''), text);
  assert.equal(plan.length, 6);
  assert.deepEqual(textPlan('', layout), []);
});

test('full text and positional arguments validate before planning', () => {
  for (const text of ['\ud800', '\udfff', 'a\0b', '\u001b', 'a'.repeat(16385)]) assert.throws(() => textPlan(text, layout), { code: 'INVALID_PARAMS' });
  for (const [method, args] of [['typeText', [1, 'x']], ['typeText', ['a', {}]], ['pressKey', ['s', { durationMs: 2 }]], ['pressKey', []], ['modifiers', [{ keys: ['shift', 'shift'], state: 'down' }]], ['modifiers', [{ keys: ['super'], state: 'down' }]], ['modifiers', [{ keys: ['shift'], state: 'hold' }]], ['modifiers', [{ keys: [], state: 'down' }]]]) {
    assert.throws(() => keyboardArguments(method, args), { code: 'INVALID_PARAMS' });
  }
  assert.deepEqual(keyboardArguments('modifiers', [{ keys: ['shift', 'control'], state: 'down' }]), { keys: ['control', 'shift'], state: 'down' });
  assert.deepEqual(keyboardArguments('pressKey', ['cmd+s']), { modifiers: ['meta'], key: 's' });
});

test('a malformed layout cannot inject key codes or arbitrary modifiers', () => {
  for (const mapping of [{ keyCode: -1, modifiers: [] }, { keyCode: 65536, modifiers: [] }, { keyCode: true, modifiers: [] }, { keyCode: 1, modifiers: ['meta'] }]) {
    assert.throws(() => keyPlan('s', new Map([['s', mapping]])), { code: 'KEY_UNMAPPABLE' });
  }
});

test('sparse modifier arrays refuse instead of silently dropping missing entries', () => {
  assert.throws(() => keyboardArguments('modifiers', [{ keys: Array(1), state: 'down' }]), { code: 'INVALID_PARAMS' });
  assert.throws(() => keyPlan('s', new Map([['s', { keyCode: 1, modifiers: Array(1) }]])), { code: 'KEY_UNMAPPABLE' });
});

test('quit-key policy uses both the physical key and the supplied layout', () => {
  assert.throws(() => keyPlan('super+q', layout), { code: 'ACTION_UNSUPPORTED' });
  assert.throws(() => keyPlan('super+a', layout), { code: 'ACTION_UNSUPPORTED' });
});

for (const [name, copy, copyCode, cut, cutCode] of [
  ['US', 'c', 8, 'x', 7], ['Dvorak', 'c', 34, 'x', 11], ['Cyrillic', 'с', 8, 'ч', 7],
]) {
  const boardLayout = new Map([
    [copy, { keyCode: copyCode, modifiers: [] }], [cut, { keyCode: cutCode, modifiers: [] }],
    ['v', { keyCode: 9, modifiers: [] }],
  ]);
  for (const [key, code] of [[copy, copyCode], [cut, cutCode]]) for (const shift of [false, true]) {
    const chord = `ctrl+${shift ? 'shift+' : ''}${key}`;
    test(`CB1M JS ${name} ${chord} posts Control-only input`, () => {
      const expected = shift ? [event('flagsChanged', 59, 0x40000), event('flagsChanged', 56, 0x60000),
        event('keyDown', code, 0x60000), event('keyUp', code, 0x60000),
        event('flagsChanged', 56, 0x40000), event('flagsChanged', 59)]
        : [event('flagsChanged', 59, 0x40000), event('keyDown', code, 0x40000),
          event('keyUp', code, 0x40000), event('flagsChanged', 59)];
      assert.deepEqual(keyPlan(chord, boardLayout), expected);
    });
  }
  for (const prefix of ['cmd+', 'cmd+ctrl+', 'cmd+shift+', 'cmd+ctrl+alt+shift+', 'ctrl+alt+']) {
    test(`CB1M JS ${name} ${prefix}Copy/Cut remains refused`, () => {
      for (const key of [copy, cut]) assert.throws(() => keyPlan(prefix + key, boardLayout),
        { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' });
    });
  }
  test(`CB1M JS ${name} held Control posts, held Command refuses`, () => {
    for (const strategy of ['flags-changed', 'flags-only', 'key-events']) for (const [key, code] of [[copy, copyCode], [cut, cutCode]]) {
      assert.throws(() => keyPlan('ctrl+' + key, boardLayout, { strategy, held: ['meta'] }), { code: 'ACTION_UNSUPPORTED' });
      assert.deepEqual(keyPlan(key, boardLayout, { strategy, held: ['control'] }),
        [event('keyDown', code, 0x40000), event('keyUp', code, 0x40000)]);
    }
  });
  test(`CB1M JS ${name} Control Paste remains refused`, () => {
    assert.throws(() => keyPlan('ctrl+v', boardLayout), { code: 'ACTION_UNSUPPORTED' });
  });
}

test('UC2F Unicode plan refuses embedded control keys without changing the default planner', () => {
  for (const text of ['\r', '\n', '\t']) {
    assert.throws(() => textPlan(text, layout, { unicodeOnly: true }), { code: 'ACTION_UNSUPPORTED' });
    assert.equal(textPlan(text, layout).length, 2);
  }
});
