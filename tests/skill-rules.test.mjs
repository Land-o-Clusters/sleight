import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';

test('the shipped skill becomes the first-call rules without its front matter', () => {
  const rules = skillRules();
  assert.match(rules, /^# Driving Mac apps with sleight/);
  assert.doesNotMatch(rules, /^---|disable-model-invocation/m);
});

test('a missing or empty skill gives no rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-skill-'));
  assert.equal(skillRules(join(dir, 'missing.md')), undefined);
  writeFileSync(join(dir, 'empty.md'), '---\nname: x\n---\n');
  assert.equal(skillRules(join(dir, 'empty.md')), undefined);
});

test('the skill routes iPhone Mirroring past scroll to Settings search', () => {
  const rules = skillRules();
  assert.match(rules, /iPhone Mirroring/);
  assert.match(rules, /search field/);
  assert.match(rules, /app\.scroll/);
  assert.match(rules, /0\.3, 0\.6 or 1 page/);
});
