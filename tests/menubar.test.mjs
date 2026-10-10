import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugins/sleight/lib/menubar.js', import.meta.url), 'utf8');
function fixture(idle) {
  const calls = [], saved = { x: 400, y: 500 };
  let time = 0;
  const native = {
    CGEventSourceSecondsSinceLastEventType: (state, type) => {
      calls.push(['idle', time, state, type]);
      return idle(time);
    },
    CGPointMake: (x, y) => ({ x, y }),
    CGEventCreate: () => 'snapshot',
    CGEventGetLocation: () => saved,
    CGEventCreateMouseEvent: (_source, type, point, button) => ({ type, point, button }),
    CGEventPost: (tap, event) => calls.push(['post', time, tap, event]),
    CGWarpMouseCursorPosition: point => calls.push(['restore', point]),
    kCGEventLeftMouseDown: 1, kCGEventLeftMouseUp: 2, kCGHIDEventTap: 0, kCGMouseButtonLeft: 0,
  };
  const item = {
    position: () => { calls.push(['position']); return [100, 20]; },
    size: () => { calls.push(['size']); return [30, 10]; },
  };
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => ({}), $: native,
    delay: seconds => { calls.push(['wait', seconds]); time += seconds; } });
  vm.runInContext(source, context);
  return { calls, saved, click: () => context.realClick(item), elapsed: () => time };
}

test('menu bar real click accepts exactly two idle seconds, posts one click and restores the pointer', () => {
  const f = fixture(() => 2);
  f.click();
  assert.equal(f.elapsed(), 0);
  const posts = f.calls.filter(c => c[0] === 'post');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(c => [c[1], c[2], c[3].type, c[3].point.x, c[3].point.y, c[3].button]),
    [[0, 0, 1, 115, 25, 0], [0, 0, 2, 115, 25, 0]]);
  assert.deepEqual(f.calls.at(-1), ['restore', f.saved]);
  assert.deepEqual(f.calls[0], ['idle', 0, 1, 0xFFFFFFFF]);
});

test('menu bar waits for continuous idle after intervening input before reading the click coordinates', () => {
  const f = fixture(time => time < 1 ? time + 1 : time - 1);
  f.click();
  assert.equal(f.elapsed(), 3);
  assert.equal(f.calls.filter(c => c[0] === 'wait').length, 6);
  assert.equal(f.calls.find(c => c[0] === 'post')[1], 3);
  const position = f.calls.findIndex(c => c[0] === 'position');
  assert.equal(f.calls[position - 1][0], 'idle');
  assert.equal(f.calls[position - 1][1], 3);
});

test('menu bar refuses after ten busy seconds without reading coordinates or posting any event', () => {
  const f = fixture(() => 1.999);
  assert.throws(f.click, /kept typing or using the mouse for 10 s.*nothing was clicked/);
  assert.equal(f.elapsed(), 10);
  assert.equal(f.calls.filter(c => c[0] === 'wait').length, 20);
  assert.ok(f.calls.every(c => ['idle', 'wait'].includes(c[0])));
});

test('menu bar allows a quiet interval reached at the ten-second boundary', () => {
  const f = fixture(time => time === 10 ? 2 : 0);
  f.click();
  assert.equal(f.elapsed(), 10);
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 2);
});

test('menu bar does not click if reading recent human input fails', () => {
  const f = fixture(() => { throw new Error('input state unavailable'); });
  assert.throws(f.click, /input state unavailable/);
  assert.deepEqual(f.calls.map(c => c[0]), ['idle']);
});
