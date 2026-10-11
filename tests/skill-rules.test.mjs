import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('the shipped skill becomes the first-call rules without its front matter', () => {
  const rules = skillRules();
  assert.match(rules, /^# Driving Mac apps with sleight/);
  assert.doesNotMatch(rules, /^---|disable-model-invocation/m);
});

test('a missing or empty skill gives no rules', t => {
  const dir = trackTemp(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-skill-'))));
  assert.equal(skillRules(join(dir, 'missing.md')), undefined);
  writeFileSync(join(dir, 'empty.md'), '---\nname: x\n---\n');
  assert.equal(skillRules(join(dir, 'empty.md')), undefined);
});

test('the skill names no app and keeps the safety rules', () => {
  const rules = skillRules();
  assert.doesNotMatch(rules, /TextEdit|Calculator|Chess|Safari|Helium|iPhone|Simulator|Slack/);
  for (const rule of [/preapproved\.json/, /blocked_app/, /Never set or suggest that setting/, /flow_exception/, /lease/]) assert.match(rules, rule);
});
