import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const approve = message => {
  const input = { mcp_server_name: 'plugin:sleight:computer', message };
  const output = execFileSync(process.execPath, ['bench/approve.mjs'], { cwd: new URL('..', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
  return output ? JSON.parse(output).hookSpecificOutput.action : null;
};
test('focused menu benchmarks approve only the three benchmark apps', () => {
  for (const app of ['Calculator', 'TextEdit', 'Chess']) assert.equal(approve(`Allow Claude to use ${app}'s menu bar item?`), 'accept');
  for (const app of ['System Settings', 'ChatGPT', 'TextEdit copy']) assert.equal(approve(`Allow Claude to use ${app}'s menu bar item?`), null);
  assert.equal(approve('Allow Claude to read and use your notifications?'), null);
});
