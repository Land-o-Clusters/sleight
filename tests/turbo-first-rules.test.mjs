import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';

const safety = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url))).skillSafety;

test('turbo projection retains all pinned safety passages and leaves lean skills whole', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_LEAN_CALLS: '1' }]) {
    const full = skillRules(undefined, env), first = turboFirstRules(full);
    for (const passage of safety) assert.ok(first.includes(passage), passage);
    assert.match(first, /Follow engine docs|^# sleight/);
    if (env.SLEIGHT_PROMPT === 'lean') assert.equal(first, full);
    else assert.ok(first.length < full.length - 1500);
  }
});

test('new or changed native advice stays eager until its entire section is reviewed', () => {
  const full = skillRules(undefined, {});
  for (const heading of ['Calls', 'Text, menus and files', "sleight's other tools"]) {
    const modified = full.replace('## ' + heading + '\n', '## ' + heading + '\nNever bypass this new guard.\n');
    const section = modified.match(new RegExp(`## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`))[0];
    assert.ok(turboFirstRules(modified).includes(section));
  }
  assert.equal(turboFirstRules('New skill. Keep every word.'), 'New skill. Keep every word.');
});
