import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';

const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));
test('host-discovered Mac skill has no Windows section', () => {
  const mac = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(mac).digest('hex'), '28ad25bf3b90a1754635ab8c8c90199a4a46824cd8643efd276937e6a56464c3', 'INT27W raw Mac source, Windows leaves it unchanged');
  assert.doesNotMatch(mac, /Windows only|Driving Windows|CHORD_NEEDS_FOREGROUND|physical client pixels/);
});

test('Windows rules come from a private skill outside host discovery', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/windows-repl/skills/drive-windows-apps/SKILL.md', import.meta.url), 'utf8');
  assert.equal(skillRules(undefined, {}, 'win32'), source.replace(/^---\n[\s\S]*?\n---\n+/, '').trim());
});

test('Windows rules stay out of every macOS skill variant', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_LEAN_CALLS: '1' }, { SLEIGHT_SCREENSHOT_READS: '0' }]) {
    const mac = skillRules(undefined, env, 'darwin');
    assert.ok(mac.startsWith(env.SLEIGHT_PROMPT === 'lean' ? '# sleight\n' : '# Driving Mac apps with sleight\n'));
    assert.doesNotMatch(mac, /Windows only|Driving Windows|CHORD_NEEDS_FOREGROUND|physical client pixels/);
  }
  assert.equal(createHash('sha256').update(skillRules(undefined, { SLEIGHT_RS: '0' }, 'darwin')).digest('hex'), baseline.skill);
});

test('Windows selects the same bounded skill in default and lean modes', () => {
  const skill = skillRules(undefined, {}, 'win32');
  assert.match(skill, /# Driving Windows apps/);
  assert.match(skill, /windowId: "101"/);
  assert.match(skill, /`paste` sends characters to a focused writable native Edit\/RichEdit control without accessing the clipboard\./);
  assert.match(skill, /Other targets, C0 controls \(including tabs and newlines\) and DEL refuse before input\./);
  assert.match(skill, /`paste` and `typeText` allow at most 4,000 UTF-16 units per call\./);
  assert.match(skill, /`typeText` sends Return for a newline, as on Mac\. `paste` refuses controls\./);
  assert.doesNotMatch(skill, /PASTE_UNCONFIRMED_CLIPBOARD_HELD/);
  assert.match(skill, /App access requires session approval, an input lease/);
  assert.match(skill, /Follow payment, flow and document-scope refusals/);
  assert.match(skill, /Stop on declined approval or lease refusal/);
  assert.match(skill, /Browsers refuse with `BROWSER_TARGET_REFUSED`, by name or HWND\. Browser turbo is unavailable on Windows\./);
  assert.doesNotMatch(skill, /native browser handles must never bypass/);
  assert.doesNotMatch(skill, /will come with|currently refuses with/);
  assert.match(skill, /Protected values are `<redacted>`/);
  assert.doesNotMatch(skill, /super\+shift\+g|app_handoff|open_file|Cmd\+|ChatGPT app's engine/);
  assert.equal(skillRules(undefined, { SLEIGHT_PROMPT: 'lean' }, 'win32'), skill);
  assert.equal(skillRules(undefined, { SLEIGHT_LEAN_CALLS: '1' }, 'win32'), skill);
  assert.equal(skillRules(undefined, { SLEIGHT_SKILL: 'none' }, 'win32'), undefined);
});
