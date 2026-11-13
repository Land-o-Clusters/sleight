import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('INT22D a flagsChanged down survives in the hold record until its up is posted', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/drag-via-driver.mjs', import.meta.url), 'utf8');
  let body = source.slice(source.indexOf('function installDragGuards('), source.indexOf('\nfunction guardedOptions(')).trim();
  if (process.env.INT22D_MUTANT === 'd') {
    assert.ok(body.includes('[10, 11, 12]'));
    body = body.replace('[10, 11, 12]', '[10, 11]');
  }
  let recorded;
  const bridge = value => ({ writeToFileAtomicallyEncodingError() { recorded = JSON.parse(value); return true; } });
  Object.assign(bridge, { NSFileManager: { defaultManager: { fileExistsAtPath: () => false } }, NSUTF8StringEncoding: 4,
    CGEventGetType: event => event.type, CGEventGetFlags: event => event.flags,
    CGEventGetIntegerValueField: (event, field) => field === 9 ? event.key : event.button,
    CGEventGetLocation: () => ({ x: 0, y: 0 }) });
  const context = { $: bridge, dragHeldInput: null, dragStopChannel: null, findApp() {}, resolveWindow() {}, settleAfterTextWrite() {} };
  vm.runInNewContext('(' + body + ')', context)({ pid: 42 }, null, 'identity changed', 'fixture/stop');
  const down = { type: 12, key: 56, flags: 131072 }, up = { ...down, flags: 1048576 };
  context.dragHeldInput(down, 42, false);
  assert.deepEqual(recorded, [{ key: 56 }], 'record Shift before the fallible down post');
  context.dragHeldInput(down, 42, true);
  context.dragHeldInput(up, 42, false);
  assert.deepEqual(recorded, [{ key: 56 }], 'an attempted up cannot prove release');
  context.dragHeldInput(up, 42, true);
  assert.deepEqual(recorded, [], 'Shift up with Command still held is a release');
});

test('INT22D a flagsChanged up reaches the caller transport after Stop while downs stay blocked', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8');
  let body = source.slice(source.indexOf('function dragPostToPid('), source.indexOf('\nfunction dragPost('));
  if (process.env.INT22D_MUTANT === 'd-caller') {
    const anchor = ' || Number($.CGEventGetType(event)) === 12 && Number($.CGEventGetFlags(event)) === 0';
    assert.ok(body.includes(anchor)); body = body.replace(anchor, '');
  }
  const posted = [], held = [];
  const post = vm.runInNewContext('(' + body + ')', { dragStopChannel: true,
    dragStopCheck() { throw Object.assign(Error('stopped'), { code: 'USER_STOPPED' }); },
    dragHeldInput: (event, pid, done) => held.push([event.flags, pid, done]),
    $: { CGEventGetType: event => event.type, CGEventGetFlags: event => event.flags,
      CGEventPostToPid: (pid, event) => posted.push([pid, event.flags]) } });
  assert.doesNotThrow(() => post(42, { type: 12, flags: 0 }));
  assert.deepEqual(posted, [[42, 0]]);
  assert.deepEqual(held, [[0, 42, false], [0, 42, true]]);
  assert.throws(() => post(42, { type: 12, flags: 131072 }), { code: 'USER_STOPPED' });
  assert.equal(posted.length, 1);
});
