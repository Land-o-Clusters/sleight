import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeArm } from '../world/native-arms.mjs';
import { worldAgentSetup } from '../world/arms/browser.mjs';
import { genericSettings } from '../plugin-arm.mjs';
import { mergeArmHooks } from '../arm-hooks.mjs';
import { raceApps } from './support.mjs';

export const NATIVE_SURFACES = ['lcu', 'cua', 'peekaboo'];
const browserNames = { chrome: 'Chrome', helium: 'Helium', firefox: 'Firefox', safari: 'Safari' };
function isolatedBrowser(browser) {
  if (!browser?.marker || !browser.profileRoot || !Object.hasOwn(browserNames, browser.browser)) throw Error('Isolated real browser required');
  return browserNames[browser.browser];
}
// The turbo arm's tools show tabs by handle and origin, never a window title or PID, and its arm may not call the engine
// (engine-browser-guard.mjs), so "identify the window" asks for something it cannot do. This states what its tools do:
// setup binds browser_open to the round's browser process (BENCH_BROWSER_PROCESS_MISMATCH in v3-worker.mjs refuses
// any other) and the round's profile. The isolation checks themselves are unchanged.
export function turboWindowPrompt(browser) {
  const name = isolatedBrowser(browser);
  return `Use only the dedicated ${name} browser, profile ${browser.profileName || browser.profileRoot}. Setup has bound browser_open to that browser's process and refuses a connection to any other, so open task pages with browser_open and keep them in your own tabs. ` +
    `These tools show tabs by handle and origin, not window titles, so there is no window to identify first, and engine js is not allowed in this arm for finding one. Never use any other browser or profile.\n\n`;
}
// "never use any other browser window" with no word on pop-ups lost demoid for every Sol run of sleight inside Codex (6 of 6,
// race-1017 b16): "Sign in with DemoID" opens a separate window, and Sol called it "your window restriction" and stopped.
// The pop-up clause is the same for every arm that gets this prompt (engine, Codex, sleight inside Codex, native arms).
export function windowPrompt(browser, { browserCore = false } = {}) {
  const name = isolatedBrowser(browser);
  return `Use only the dedicated ${name} window initially titled "${browser.marker}"` +
    `${browser.pid ? `, browser PID ${browser.pid}` : ''}, profile ${browser.profileName || browser.profileRoot}. ` +
    (browserCore ? 'browser_open opens the page in a new tab of that window and returns its title and tabs, which is the check. ' : '') +
    'Identify that window before acting, keep task pages in it, and never use any other browser window or profile, except a pop-up window of that same browser and profile, opened by a page in that window as a result of a step the task asked for (a sign-in window, say). Once that pop-up closes, the dedicated window is the browser\'s window again. Never act in a window that was already open, another profile, another browser, or another app. If the dedicated window cannot be identified, stop. User activity still ends the input lease.\n\n';
}
export function nativeBrowserSetup({ surface, repo, dir, realBrowser, dryRun = false,
  armHome = join(homedir(), 'Library/Caches/sleight-bench'), env = process.env }) {
  if (!NATIVE_SURFACES.includes(surface)) throw Error('Unknown native browser arm');
  const common = worldAgentSetup({ surface: 'fowlbrowser', dir, hostEnv: env });
  // The native claim's world suite approves only its desktop apps, so in the first Firefox round every LCU approval for
  // Firefox was declined (2026-10-17, "Computer Use was not approved to use Firefox"). A round approves its own apps.
  common.env.BENCH_SUITE = 'browser-race';
  common.env.BENCH_RACE_APPS = JSON.stringify(raceApps(realBrowser.browser));
  common.env.BENCH_HOOK_LOG = join(dir, 'approvals.jsonl');
  common.env.BENCH_ARM_SERVERS = JSON.stringify([surface]);
  let mcp, settings, identity;
  if (surface === 'lcu') {
    const cwd = join(armHome, 'lcu-arm');
    mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    if (JSON.stringify(Object.keys(mcp.mcpServers || {})) !== '["lcu"]') throw Error('LCU arm must contain only lcu');
    settings = mergeArmHooks(genericSettings({ servers: ['lcu'] }, repo), join(cwd, '.claude/settings.local.json'));
    common.env.PATH = `${join(repo, '.dev/py')}:${common.env.PATH ?? ''}`;
    common.env.CLAUDE_CONFIG_DIR = join(cwd, 'claude');
    identity = { kind: 'lcu', config: join(cwd, '.mcp.json'), ownHooks: join(cwd, '.claude/settings.local.json') };
  } else {
    const arm = prepareNativeArm(surface, { root: repo, armHome, env: common.env, dryRun });
    mcp = dryRun ? arm.mcp : JSON.parse(readFileSync(join(arm.cwd, 'mcp.json'), 'utf8'));
    settings = genericSettings({ servers: [surface] }, repo);
    Object.assign(common.env, arm.env);
    identity = arm.identity;
  }
  return { ...common, mcpServers: mcp.mcpServers, allowed: surface === 'lcu' ? 'mcp__lcu__js' : `mcp__${surface}`,
    args: [...common.args, '--no-chrome', '--no-session-persistence'], settings: { ...common.settings, ...settings },
    promptPrefix: common.promptPrefix + windowPrompt(realBrowser),
    metadata: { ...common.metadata, surface, identity, configDir: common.env.CLAUDE_CONFIG_DIR,
      browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot, headless: false, focus: 'not measured' } };
}
