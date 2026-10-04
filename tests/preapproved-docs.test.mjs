import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = readme.split('### Preapproved apps\n')[1].split('\n## ')[0];
test('documented sample permits low risk only and explains high and interactive use', () => {
  const config = JSON.parse(section.match(/```json\n([\s\S]*?)```/)[1]);
  const list = new PreapprovedApps(config);
  for (const entry of config.apps) {
    assert.equal(entry.riskLevel, 'low');
    assert.equal(list.allows(entry.app, 'low'), true);
    assert.equal(list.allows(entry.app, 'medium'), false);
  }
  assert.match(section, /high.*accepts every engine approval request for that app/);
  assert.match(section, /interactive sessions too/);
  assert.doesNotMatch(section, /`hover`/);
  assert.doesNotMatch(readFileSync(new URL('../docs/design/preapproved-apps.md', import.meta.url), 'utf8'), /`hover`/);
});
test('skill forbids Claude writing the approval file and README states the ownership gap', () => {
  const skill = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Never create or edit.*preapproved\.json/);
  const problems = readme.split('## Known problems\n')[1].split('### Approval scope')[0];
  assert.match(problems, /process running as you/);
  assert.match(problems, /Claude/);
});
