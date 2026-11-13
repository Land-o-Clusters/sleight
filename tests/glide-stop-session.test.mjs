import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlideStopSession } from '../plugins/sleight/lib/mac-driver/stop.mjs';

test('a stepped-helper stop blocks every parent input path and cannot resume mid-call', async () => {
  let click, helperResets = 0;
  const session = createGlideStopSession({ control: { async beginGlideStop(window, stop) { click = stop; return () => {}; } },
    resetHelper: () => { helperResets++; return true; } });
  const end = await session.begin({ windowId: '7', pid: 42 }, () => {});
  click();
  assert.throws(session.check, { code: 'USER_STOPPED', delivery: 'not-sent' });
  await assert.rejects(session.begin({ windowId: '7', pid: 42 }, () => {}), { code: 'USER_STOPPED' });
  assert.equal(session.userPrompt(), false); assert.equal(helperResets, 0);
  await end(); assert.equal(session.userPrompt(), true); assert.equal(helperResets, 1);
  click(); assert.doesNotThrow(session.check, 'a stale control cannot stop a new prompt');
});

test('failed control preparation releases its reservation and sends no input', async () => {
  let inputs = 0;
  const session = createGlideStopSession({ control: { async beginGlideStop() { throw Error('unavailable'); } } });
  await assert.rejects(session.begin({}, () => { inputs++; }), /unavailable/);
  assert.equal(session.userPrompt(), true); assert.equal(inputs, 0);
});

test('Stop between actions releases retained input before a later prompt can reset', async () => {
  let release, stops = 0;
  const session = createGlideStopSession({ stopHelper: () => {
    stops++; return new Promise(resolve => { release = resolve; });
  } });
  session.stop(); await Promise.resolve();
  assert.equal(stops, 1);
  assert.equal(session.userPrompt(), false);
  assert.equal(session.turnEnded, undefined, 'turn end has no Stop-clear API');
  assert.throws(session.check, { code: 'USER_STOPPED' });
  release(); await session.settled();
  assert.throws(session.check, { code: 'USER_STOPPED' }, 'release alone leaves Stop latched');
  assert.equal(session.userPrompt(), true);
  assert.doesNotThrow(session.check);
});


test('a stepped helper waits for retained native modifiers to release before ending Stop', async () => {
  let click, release;
  const session = createGlideStopSession({ control: { async beginGlideStop(window, stop) { click = stop; return () => {}; } },
    stopHelper: () => new Promise(resolve => { release = resolve; }) });
  const end = await session.begin({}, () => {});
  click();
  const ended = end();
  await Promise.resolve();
  assert.equal(session.userPrompt(), false);
  release(); await ended;
  assert.equal(session.userPrompt(), true);
});
