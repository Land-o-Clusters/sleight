import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../bench/chess-launch.mjs').catch(() => ({}));
const absent = () => Object.assign(new Error('no Chess process'), { status: 1 });
test('fresh launch waits for Chess to exit after quit rather than trusting a sent signal', () => {
  assert.equal(typeof module.restartChess, 'function');
  const calls = []; let polls = 0;
  module.restartChess({ quit: () => calls.push('quit'), run: (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === '/usr/bin/pgrep' && ++polls === 3) throw absent();
  } });
  assert.equal(calls[0], 'quit');
  assert.equal(polls, 3);
  assert.deepEqual(calls.at(-1), ['/usr/bin/open', ['-g', '-a', 'Chess', '--args', '-ApplePersistenceIgnoreState', 'YES']]);
});
test('LaunchServices error -600 retries the same launch at most three times', () => {
  assert.equal(typeof module.restartChess, 'function');
  let opens = 0;
  module.restartChess({ quit() {}, run: cmd => {
    if (cmd === '/usr/bin/pgrep') throw absent();
    if (cmd === '/usr/bin/open' && ++opens < 3) throw Object.assign(new Error('open failed'), { stderr: 'NSOSStatusErrorDomain Code=-600' });
  } });
  assert.equal(opens, 3);
});
test('a lingering Chess process, an inspection failure and other launch errors stop without a retry', () => {
  assert.equal(typeof module.restartChess, 'function');
  let opens = 0;
  assert.throws(() => module.restartChess({ quit() {}, run: cmd => { if (cmd === '/usr/bin/open') opens++; } }), /did not exit/);
  assert.equal(opens, 0);
  assert.throws(() => module.restartChess({ quit() {}, run: () => { throw Object.assign(new Error('denied'), { status: 2 }); } }), /denied/);
  assert.throws(() => module.restartChess({ quit() {}, run: cmd => {
    if (cmd === '/usr/bin/pgrep') throw absent();
    if (cmd === '/usr/bin/open') { opens++; throw new Error('permission denied'); }
  } }), /permission denied/);
  assert.equal(opens, 1);
});
