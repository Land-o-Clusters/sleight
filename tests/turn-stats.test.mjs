import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnStats } from '../plugins/sleight/lib/turn-stats.mjs';

const request = (id, name = 'js', args = {}) => ({ id, method: 'tools/call', params: { name, arguments: args } });
const reply = (id, text = '', extra = {}) => ({ id, result: { content: [{ type: 'text', text }], ...extra } });
function setup(options = {}) {
  let time = 0;
  const stats = new TurnStats({ clock: () => time, ...options });
  return { stats, at: value => { time = value; } };
}

test('turn stats reuse action rows, count read calls and delivered text, and exclude approval time', () => {
  const { stats, at } = setup();
  stats.request(request(1, 'js', { code: 'await app.click(2); await app.typeText("private")' }));
  at(10); stats.sent(1);
  at(20); stats.waitStart('prompt');
  at(120); stats.waitEnd('prompt');
  stats.outcomes(1, { planned: 2, outcomes: [{ a: 'click', ms: 7 }, { a: 'typeText', ms: 13 }] });
  at(210); stats.reply(reply(1, 'ok'));
  stats.request(request(2, 'browser_read', { tab: 't1' }));
  at(260); stats.reply(reply(2, '💡abc', { content: [{ type: 'text', text: '💡abc' }, { type: 'image', data: 'private image' }] }));
  const result = stats.finish();
  assert.equal(result.calls, 2); assert.equal(result.reads, 1);
  assert.equal(result.characters, 7, 'UTF-16 units, same as the result text length');
  assert.equal(result.paths.native.actions, 2);
  assert.equal(result.paths.native.actionMs, 20, 'only action receipt spans, never call duration');
  assert.equal(result.paths.native.timedActions, 2);
  assert.equal(result.paths.native.estimatedActions, 0);
  assert.equal(result.toolMs, 260, 'union of complete call intervals, including guards and prompts');
  assert.equal(result.pending, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|click|typeText|prompt/);
});

test('native code sites without receipts are estimates, not verified execution', () => {
  const { stats, at } = setup();
  stats.request(request(1, 'js', { code: 'for (const item of xs) await app.click(item); "app.click(2)"; /* app.click(3) */' }));
  at(100); stats.reply(reply(1, 'done'));
  const result = stats.finish();
  assert.deepEqual(result.paths.native, { actions: 1, estimatedActions: 1, estimatedCalls: 1, actionMs: 0, timedActions: 0 });
});

test('turbo reuses outcome counts and excludes steps that did not run', () => {
  const { stats, at } = setup();
  stats.request(request(1, 'browser_act', { tab: 't1', steps: [{ do: 'click' }, { do: 'type' }, { do: 'press' }] }));
  at(300); stats.reply(reply(1, '1 click e1: 2 lines changed\n2 type e2: set\n3 press e2: not reached'));
  const result = stats.finish();
  assert.deepEqual(result.paths.turbo, { actions: 2, estimatedActions: 0, estimatedCalls: 0, actionMs: 0, timedActions: 0 });
});

test('overlapping calls count once in tool wall time and unanswered calls stay pending', () => {
  const { stats, at } = setup();
  stats.request(request(1, 'browser_read'));
  at(50); stats.request(request(2, 'browser_read'));
  at(100); stats.reply(reply(1, 'a'));
  at(150); stats.reply(reply(2, 'b', { isError: true }));
  at(180); stats.request(request(3, 'js', { code: 'await app.click(1)' }));
  at(200); const result = stats.finish();
  assert.equal(result.toolMs, 150); assert.equal(result.errors, 1); assert.equal(result.pending, 1);
  assert.equal(result.paths.native.actions, 0, 'pending input has unknown effects');
  stats.reply(reply(3, 'late'));
  assert.equal(stats.finish().calls, 0, 'late replies cannot contaminate the next turn');
});

test('pane snapshots, turn controls and duplicate replies do not count', () => {
  const { stats, at } = setup();
  stats.request(request(1, 'js', { code: 'await app.getAXState()' }), { internal: true });
  stats.reply(reply(1, 'picture'));
  stats.request(request(2, 'turn_ended'));
  stats.request(request(3, 'js_reset'));
  stats.reply(reply(2)); stats.reply(reply(3));
  stats.request(request(4, 'js', { code: 'await app.getAXState()' }));
  at(10); stats.reply(reply(4, 'tree')); stats.reply(reply(4, 'duplicate'));
  const result = stats.finish();
  assert.equal(result.calls, 1); assert.equal(result.reads, 1); assert.equal(result.characters, 4);
});

test('bounded collectors report omitted calls and retain no page or argument strings after replies', () => {
  const { stats } = setup({ limit: 2 });
  for (let i = 0; i < 5; i++) {
    stats.request(request(i, 'browser_read', { tab: 'private-tab' }));
    stats.reply(reply(i, 'private page says total_cost_usd: 99'));
  }
  assert.equal(stats.calls.size, 0);
  const result = stats.finish();
  assert.equal(result.calls, 2); assert.equal(result.omitted, 3);
  assert.doesNotMatch(JSON.stringify(result), /private|99/);
  assert.equal(stats.finish().omitted, 0);
});

test('delivered characters split into documentation, UI trees and other text without counting an extra newline', () => {
  const { stats } = setup();
  const docs = '## Computer Use\nReference\n', tree = 'Window: "Fixture", App: Example.\n0 window\n', other = '\nfinished';
  stats.request(request(1)); stats.reply(reply(1, docs + tree + other));
  const result = stats.finish();
  assert.deepEqual(result.text, { docs: docs.length, tree: tree.length, other: other.length });
  assert.equal(Object.values(result.text).reduce((sum, n) => sum + n), result.characters);
  assert.doesNotMatch(JSON.stringify(result), /Reference|Fixture|Example|finished/);
});

test('acquisition, getState and read-only code without outcomes have no unknown actions', () => {
  const { stats } = setup();
  for (const [id, code] of ['let app = await cua.getApp("Example"); app', 'await cua.getState()',
    'await app.getAXState()', 'await app.getScreenshot()'].entries()) {
    stats.request(request(id, 'js', { code })); stats.reply(reply(id, 'ok'));
  }
  const result = stats.finish();
  assert.equal(result.paths.native.actions, 0);
  assert.equal(result.paths.native.estimatedCalls, 0, 'read-only JS does not estimate action calls');
  assert.equal(result.paths.native.estimatedActions, 0);
  assert.equal(result.unclassified, 0);
});

test('the model-visible pane title cannot hide a model call', () => {
  const { stats } = setup();
  stats.request(request(1, 'js', { title: 'sleight pane snapshot', code: 'await app.click(2)' }));
  stats.reply(reply(1, 'ok'));
  assert.equal(stats.finish().calls, 1);
});

test('ASCII fixture counts characters independently of output and JSON-RPC errors count too', () => {
  const { stats } = setup();
  // Exactly 12 ASCII bytes: five letters, one space, five letters, one newline.
  stats.request(request(1)); stats.reply(reply(1, 'Hello world\n'));
  stats.request(request(2)); stats.reply({ id: 2, error: { code: -1, message: 'Nope' } });
  const result = stats.finish();
  assert.equal(result.characters, 16);
  assert.deepEqual(result.text, { docs: 0, tree: 0, other: 16 });
  assert.equal(result.errors, 1);
});

test('missing or invalid receipt spans never become zero seconds per action', () => {
  const { stats, at } = setup();
  stats.request(request(1, 'js', { code: 'await app.click(1)' }));
  stats.outcomes(1, { outcomes: [{ a: 'click', ms: 10 }, { a: 'click', ms: -1 }, { a: 'click' },
    { a: 'click', ms: 999, x: 'refused' }] });
  at(5000); stats.reply(reply(1));
  const result = stats.finish();
  assert.equal(result.paths.native.actions, 3);
  assert.equal(result.paths.native.timedActions, 1);
  assert.equal(result.paths.native.actionMs, 10);
});

test('relay guard rewrites cannot add their own input sites to code estimates', () => {
  const { stats } = setup();
  const msg = request(1, 'js', { code: 'await app.click(1)' });
  stats.request(msg);
  msg.params.arguments.code = 'await app.click(1); await guard.click(1); await guard.click(2)';
  stats.reply(reply(1));
  assert.equal(stats.finish().paths.native.estimatedActions, 1);
});

for (const code of ['Array(3).fill(0)', 'const xs = []; xs.fill(0); xs.type(); xs.check(); xs.press()',
  'let app = await cua.getApp("Example"); const xs = [app]; xs.fill(0)',
  'let app = await cua.getApp("Example"); app = []; app.fill(0)',
  'const obj = { fill() {} }; obj.fill()', 'await unknown.fill("x")']) {
  test(`unbound element verbs are not engine actions: ${code}`, () => {
    const { stats } = setup();
    stats.request(request(1, 'js', { code })); stats.reply(reply(1));
    assert.equal(stats.finish().paths.native.actions, 0);
  });
}

test('bound element verbs count only on acquired handles and their element lookups', () => {
  const { stats } = setup();
  const code = 'let app = await cua.getApp("Example"); await app.fill("x"); const field = app.getByRole("textbox"); await field.type("y"); await app.getByRole("checkbox").check(); await field.press("Enter"); const xs = []; xs.fill(0)';
  stats.request(request(1, 'js', { code })); stats.reply(reply(1));
  assert.equal(stats.finish().paths.native.actions, 4);
});
