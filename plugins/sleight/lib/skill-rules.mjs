// Both launchers load one skill without importing each other's executable entry point.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formTargetRules } from './form-target-rules.mjs';
import { requestedSubmitRules } from './requested-submit.mjs';
import { leanCallRules } from './lean-calls.mjs';
import { screenshotGuidance } from './screenshot-guidance.mjs';

const macSkill = fileURLToPath(new URL('../skills/drive-mac-apps/SKILL.md', import.meta.url));
// Keep the Windows source outside the hosts' auto-discovered plugin skills directory.
const windowsSkill = fileURLToPath(new URL('./windows-repl/skills/drive-windows-apps/SKILL.md', import.meta.url));
// The relay defers the Mac Browsers section until a browser result. Windows has its own
// private skill. Missing or unreadable means none, without a cross-platform fallback.
export function skillRules(path, env = process.env, platform = process.platform) {
  if (env.SLEIGHT_SKILL === 'none') return undefined;
  path ??= platform === 'win32' ? windowsSkill : macSkill;
  if (platform !== 'win32' && env.SLEIGHT_PROMPT === 'lean') path = join(dirname(path instanceof URL ? fileURLToPath(path) : path), 'SKILL.lean.md');
  try {
    let text = readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '').trim() || undefined;
    if (platform === 'win32') return text;
    text = requestedSubmitRules(screenshotGuidance(formTargetRules(text, env), env.SLEIGHT_SCREENSHOT_READS !== '0'), env);
    return env.SLEIGHT_LEAN_CALLS === '1' ? leanCallRules(text) : text;
  } catch { return undefined; }
}
