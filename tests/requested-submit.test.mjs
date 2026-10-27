// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestedSubmitRules } from '../plugins/sleight/lib/requested-submit.mjs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';
import { traceEnv, abFlags } from '../bench/fowl/real-gate-setup.mjs';
import { turboSetup } from '../bench/turbo/setup.mjs';
import { codexSleightRunConfig, codexSleightServers } from '../bench/codex-sleight.mjs';

test('legacy RS2 skill text regains the original submit safety passage in every mode', () => {
  const shortened = "Submit in that call when requested and the engine's confirmation policy permits it. Otherwise stop before the final click.";
  for (const prompt of [undefined, 'lean']) for (const rs of [undefined, '0', '1', '', 'off']) {
    const original = skillRules(undefined, { SLEIGHT_PROMPT: prompt, SLEIGHT_RS: '0' })
      .match(/Submit in that call[\s\S]*?Otherwise stop before the final click\./)[0];
    assert.equal(requestedSubmitRules(shortened, { SLEIGHT_PROMPT: prompt, SLEIGHT_RS: rs }), original);
  }
});

test('the race preserves invalid RS settings so they cannot become the enabled default', () => {
  for (const value of ['0', '1', '', 'false', '00', 'off']) {
    assert.deepEqual(traceEnv({ SLEIGHT_RS: value, HOME: '/h' }), { SLEIGHT_RS: value });
    assert.equal(abFlags({ SLEIGHT_RS: value }).SLEIGHT_RS, value === '1');
  }
  assert.equal(abFlags({}).SLEIGHT_RS, true);
  assert.deepEqual(traceEnv({}), {});
  const shell = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  assert.ok(shell.includes('${SLEIGHT_RS+SLEIGHT_RS="$SLEIGHT_RS"}'));
});

test('the turbo skill loader agrees with the installed loader for both RS sides and both prompts', () => {
  const task = { name: 'fixture', browser: 'chrome', prompt: 'Read http://127.0.0.1:5431/form' };
  for (const prompt of [undefined, 'lean']) for (const rs of ['0', '1', '', 'off', 'false', '00']) {
    const env = { SLEIGHT_PROMPT: prompt, SLEIGHT_RS: rs };
    const setup = turboSetup({ task, repo: '/repo', dir: `${MAC_TMP}/rs-unit/out`, prompt: task.prompt, env });
    const native = turboFirstRules(skillRules(undefined, env)).split('## Browsers')[0];
    assert.ok(setup.promptPrefix.startsWith(native));
    assert.equal(setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_RS, rs);
    // The Codex browser arm wraps the same generated server specification.
    const servers = codexSleightServers({ dir: `${MAC_TMP}/rs-unit`, mcpServers: setup.mcpServers, allowed: setup.allowed });
    assert.equal(servers.plugin_sleight_computer.env.SLEIGHT_RS, rs);
  }
});

test('Codex native and claim arms forward the RS switch into their explicit MCP environment', () => {
  for (const rs of ['0', '1', '', 'off', 'false', '00']) {
    const setup = codexSleightRunConfig({ model: 'gpt-6.1-sol', dir: `${MAC_TMP}/rs-unit`, suite: 'world', hostEnv: { SLEIGHT_RS: rs } });
    assert.ok(setup.toml.includes(`SLEIGHT_RS = "${rs}"`));
  }
});
