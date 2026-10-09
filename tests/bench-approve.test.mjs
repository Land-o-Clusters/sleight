import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const approve = (message, suite = 'default') => {
  const input = { mcp_server_name: 'plugin:sleight:computer', message };
  const output = execFileSync(process.execPath, ['bench/approve.mjs'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, BENCH_SUITE: suite }, input: JSON.stringify(input), encoding: 'utf8' });
  return output ? JSON.parse(output).hookSpecificOutput.action : null;
};
test('benchmark menu approvals cover the original apps and exclude unapproved targets', () => {
  for (const app of ['Calculator', 'TextEdit', 'Chess']) assert.equal(approve(`Allow Claude to use ${app}'s menu bar item?`), 'accept');
  for (const app of ['System Settings', 'ChatGPT', 'TextEdit copy']) assert.equal(approve(`Allow Claude to use ${app}'s menu bar item?`), null);
  assert.equal(approve('Allow Claude to read and use your notifications?'), null);
});
test('benchmark drags approve the three apps by bundle ID too, exact case only', () => {
  for (const app of ['com.apple.Chess', 'com.apple.TextEdit', 'com.apple.calculator', 'Chess']) {
    assert.equal(approve(`Allow Claude to drag in ${app}? It moves the pointer.`), 'accept');
  }
  for (const app of ['com.apple.chess', 'com.apple.Safari.copy', 'com.apple.Chess.evil']) {
    assert.equal(approve(`Allow Claude to drag in ${app}? It moves the pointer.`), null);
  }
});
test('real tasks approve only the four added apps and their exact bundle IDs', () => {
  for (const app of ['Safari', 'com.apple.Safari', 'Preview', 'com.apple.Preview', 'Finder', 'com.apple.finder', 'Helium', 'net.imput.helium']) {
    assert.equal(approve(`Allow Computer Use to use "${app}"?`), null);
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'real'), 'accept');
  }
  for (const app of ['Google Chrome', 'net.imput.helium.copy', 'com.apple.preview']) {
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'real'), null);
  }
});
test('benchmark runs approve Simulator and DeviceHub by name and bundle ID', () => {
  for (const app of ['Simulator', 'com.apple.iphonesimulator', 'DeviceHub', 'Device Hub', 'com.apple.dt.Devices']) assert.equal(approve(`Allow Computer Use to use "${app}"?`), 'accept');
  assert.equal(approve('Allow Computer Use to use "Xcode"?'), null);
});
