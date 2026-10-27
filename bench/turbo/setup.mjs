import { requestedSubmitRules } from '../../plugins/sleight/lib/requested-submit.mjs';
import { turboFirstRules } from '../../plugins/sleight/lib/turbo-first-rules.mjs';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { browserTools } from '../../plugins/sleight/lib/direct-browser/tools.mjs';
import { worldAgentSetup } from '../world/arms/browser.mjs';
import { benchHand } from '../hand/bench-hand.mjs';
import { screenshotGuidance } from '../../plugins/sleight/lib/screenshot-guidance.mjs';

export const SURFACE = 'sleight-turbo';
export const MEASUREMENT = 'v3 tools and worker boundary plus engine companion; V10 runtime join excluded';
export function fixturePolicy(origins) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const u = new URL(origin); return u.origin !== origin || u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' || !u.port || u.username || u.password; } catch { return true; }
  })) throw Error('Runner fixture origins required');
  const allowed = new Set(origins);
  return url => {
    try { const u = new URL(url); return u.protocol === 'http:' && !u.username && !u.password && allowed.has(u.origin); }
    catch { return false; }
  };
}
export function fixtureOrigins(task) {
  const urls = [...String(task.prompt).matchAll(/https?:\/\/[^\s"'<>),]+/g)].map(match => match[0]);
  if (task.grade) urls.push(task.grade);
  if (task.site?.log) urls.push(task.site.log);
  return [...new Set(urls.flatMap(value => {
    try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' &&
      u.port && !u.username && !u.password ? [u.origin] : []; } catch { return []; }
  }))];
}
export function turboSetup({ task, repo, dir, prompt, env = process.env, realBrowser }) {
  const origins = fixtureOrigins(task); if (origins.length) fixturePolicy(origins);
  // Like the installed surface, show an opaque browser id plus the application name.
  // Legacy rounds launch headless Chromium; the real gate supplies its visible browser.
  const browser = 'bbench', application = ' (' + ((realBrowser?.browser ?? task.browser) === 'helium' ? 'Helium' : 'Google Chrome') + ')';
  // Keep setup synchronous for the pinned runner's require(). launch.mjs has
  // top-level await, so read its same skill body without importing the launcher.
  const rules = requestedSubmitRules(screenshotGuidance(readFileSync(new URL('../../plugins/sleight/skills/drive-mac-apps/'
    + (env.SLEIGHT_PROMPT === 'lean' ? 'SKILL.lean.md' : 'SKILL.md'), import.meta.url), 'utf8')
    .replace(/^---\n[\s\S]*?\n---\n+/, '').trim(), env.SLEIGHT_SCREENSHOT_READS !== '0'), env);
  const section = /## Browsers\n[\s\S]*?(?=\n## |$)/;
  const browserRules = readFileSync(new URL('../../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8')
    .trimEnd().replace('{browser}', browser).replace('{application}', application);
  if (!section.test(rules)) throw Error('Installed browser skill is missing');
  const installed = rules.replace(section, browserRules + '\n');
  const common = worldAgentSetup({ surface: 'fowlbrowser', dir, hostEnv: env });
  // Off unless the runner's SLEIGHT_BENCH_HAND=1, read from the runner's env (env here is the arm's filtered host env).
  const hand = benchHand(process.env);
  const configDir = join(dirname(dirname(common.env.CLAUDE_CONFIG_DIR)), SURFACE, 'claude-config');
  const guard = { matcher: 'mcp__plugin_sleight_computer__js', hooks: [{ type: 'command', timeout: 5,
    command: `node "${join(repo, 'bench/turbo/engine-browser-guard.mjs')}" ${browser}` }] };
  return { command: common.command, args: common.args, settings: { ...common.settings, hooks: { PreToolUse: [guard] } },
    mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'),
      // Native how-to is deferred from the turbo prefix, and arrives on native acquisition.
      env: { SLEIGHT_SURFACES: 'browser,computer', SLEIGHT_SKILL: 'default', SLEIGHT_HAND: hand, ...(env.SLEIGHT_RS !== undefined ? { SLEIGHT_RS: env.SLEIGHT_RS } : {}) } },
      // The worker's hand (H8) follows the same switch, and its hand-skipped and hand-shown events reach SLEIGHT_TRACE.
      'sleight-turbo': { command: process.execPath, args: [join(repo, 'bench/turbo/v3-server.mjs')],
      // SLEIGHT_TRACE comes from the arm's env (the real gate passes its traceEnv) or else the runner's own.
      env: { ...(realBrowser ? { SLEIGHT_TURBO_REAL_BROWSER: JSON.stringify(realBrowser) } : {}),
        ...(env.SLEIGHT_LB12 === '0' || env.SLEIGHT_LB12 === '1' ? { SLEIGHT_LB12: env.SLEIGHT_LB12 } : {}),
        ...(env.SLEIGHT_MC1 === '0' || env.SLEIGHT_MC1 === '1' ? { SLEIGHT_MC1: env.SLEIGHT_MC1 } : {}),
        ...(env.SLEIGHT_MT === '0' || env.SLEIGHT_MT === '1' ? { SLEIGHT_MT: env.SLEIGHT_MT } : {}),
        SLEIGHT_TURBO_ORIGINS: JSON.stringify(origins), SLEIGHT_TURBO_TASK: prompt, SLEIGHT_TURBO_METRICS: join(dir, 'turbo-metrics.jsonl'),
        SLEIGHT_HAND: hand, ...(env.SLEIGHT_TRACE ? { SLEIGHT_TRACE: env.SLEIGHT_TRACE }
          : typeof process.env.SLEIGHT_TRACE === 'string' && process.env.SLEIGHT_TRACE ? { SLEIGHT_TRACE: process.env.SLEIGHT_TRACE } : {}) } } },
    allowed: [...browserTools(browser).map(tool => 'mcp__sleight-turbo__' + tool.name),
      'mcp__plugin_sleight_computer__js', 'mcp__plugin_sleight_computer__js_reset', 'mcp__plugin_sleight_computer__open_file'].join(','),
    promptPrefix: turboFirstRules(installed) + '\n\n',
    env: { ...common.env, CLAUDE_CONFIG_DIR: configDir },
    metadata: { ...common.metadata, configDir, surface: SURFACE, measurement: MEASUREMENT,
      path: 'model-selected', turboVersion: 3, standsInFor: application.slice(2, -1), runtime: 'V10 join required', playwright: '1.64.0', profile: 'owned-temporary', headless: true,
      safety: 'turbo drives its own headless Chromium (public web reachable, the product guards on top); engine approvals and guards; engine browser calls refused by a bench hook', focus: 'host monitor', ...(realBrowser ? { browser: realBrowser.browser, profile: realBrowser.profileRoot, headless: false,
        connectionMode: 'product-remote-debugging', safety: 'isolated visible benchmark profile; product connection checks and guards; confirmation remains unconfirmed' } : {}) } };
}
