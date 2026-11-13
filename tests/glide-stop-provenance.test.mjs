import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('INT22D Stop provenance names the measured CLI version and the unmeasured desktop', () => {
  let source = readFileSync(new URL('../docs/known-problems.md', import.meta.url), 'utf8');
  const prefix = "- Stop's mod attribution reads `claudecode/toolUseId` `toolu_plugin_` ids, measured under `claude -p` on Claude Code 2.1.309 (2026-11-01).";
  const expected = prefix + ' Glide Stop lasts the session in the Claude desktop app and on hosts without the mod.' +
    " In Claude Code with attributed mod prompts, the person's next typed composer or bridge message clears Stop. `/sleight <text>` does not." +
    ' The desktop app is unmeasured.';
  if (process.env.INT22D_MUTANT === 'h') source = source.replace('Claude Code 2.1.309 (2026-11-01)', 'Claude Code');
  const audit = text => {
    const line = text.split('\n').find(line => line.startsWith(prefix));
    assert.equal(line, expected, 'Stop attribution measurement and host limits must be explicit');
  };
  audit(source);
  assert.throws(() => audit(source.replace('The desktop app is unmeasured.', '')), assert.AssertionError);
  assert.throws(() => audit(source.replace('The desktop app is unmeasured.', 'The desktop app is unmeasured. All hosts clear Stop.')), assert.AssertionError);
  assert.throws(() => audit(source.replace('Glide Stop lasts the session in the Claude desktop app and on hosts without the mod.', '')
    .replace('The desktop app is unmeasured.', 'The desktop app is unmeasured. Glide Stop lasts the session in the Claude desktop app and on hosts without the mod.')), assert.AssertionError);
});
