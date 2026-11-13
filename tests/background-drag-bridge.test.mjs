import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';

test('production JXA builder round-trips private coordinates without posting or app access', { skip: macCommandSkip('osascript') }, () => {
  const source = readFileSync('plugins/sleight/lib/drag.js', 'utf8') + `
    function run() {
      const main = { id: 1, bounds: { X: 100, Y: 100, Width: 600, Height: 400 } };
      const build = backgroundBuilder();
      const events = [1, 2, 6].map(type => {
        const item = build(type, { x: 120, y: 130 }, main);
        return { type: $.CGEventGetType(item.event), screen: $.CGEventGetLocation(item.event),
          local: $.CGEventGetWindowLocation(item.event), flags: $.CGEventGetFlags(item.event),
          window: $.CGEventGetIntegerValueField(item.event, 91), subtype: $.CGEventGetIntegerValueField(item.event, 7) };
      });
      return JSON.stringify(events);
    }`;
  const probe = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(probe.status, 0, probe.stderr);
  const events = JSON.parse(probe.stdout);
  for (const [index, e] of events.entries()) {
    assert.equal(e.type, [1, 2, 6][index]); assert.deepEqual(e.screen, { x: 120, y: 130 });
    assert.deepEqual(e.local, { x: 20, y: 30 }); assert.equal(Number(e.window), 1); assert.equal(Number(e.subtype), 3);
  }
  assert.ok(events.every(e => Number(e.flags) === 0));
});
