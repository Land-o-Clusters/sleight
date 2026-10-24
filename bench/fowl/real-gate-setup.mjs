import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBrowserSetup, windowPrompt, turboWindowPrompt } from './native-setup.mjs';
import { turboSetup } from '../turbo/setup.mjs';
import { codexExecPlan } from '../codex-arm.mjs';
import { modelId } from './accounting.mjs';
import { worldAgentSetup, browserArmSetup, defaultArmRoot } from '../world/arms/browser.mjs';
import { genericSettings } from '../plugin-arm.mjs';
import { withManifestBackup } from '../world/arms/chrome.mjs';
import { claudeHostManifest } from './real-browser.mjs';

// The sleight arm's MCP server gets an explicit env, so a trace the launching shell asked for stopped at the harness
// (no relay trace in the 36 Firefox b3 runs, 2026-10-18). SLEIGHT_TRACE goes through, and SLEIGHT_TS3=1, SLEIGHT_FS=1 and
// SLEIGHT_BROWSER_CORE=1 for their A/Bs, SLEIGHT_MC1=0|1, SLEIGHT_RS (including invalid values so they stay strict),
// and SLEIGHT_WORKFLOW_DOCS=0 (CC6's baseline); no other host variable does.
const AB_FLAGS = ['SLEIGHT_TS3', 'SLEIGHT_FS', 'SLEIGHT_BROWSER_CORE'];
export function traceEnv(host = process.env) {
  return { ...(typeof host.SLEIGHT_TRACE === 'string' && host.SLEIGHT_TRACE ? { SLEIGHT_TRACE: host.SLEIGHT_TRACE } : {}),
    ...Object.fromEntries(AB_FLAGS.filter(key => host[key] === '1').map(key => [key, '1'])),
    ...(host.SLEIGHT_RS !== undefined ? { SLEIGHT_RS: host.SLEIGHT_RS } : {}),
    ...(['0', '1'].includes(host.SLEIGHT_MC1) ? { SLEIGHT_MC1: host.SLEIGHT_MC1 } : {}),
    ...(host.SLEIGHT_WORKFLOW_DOCS === '0' ? { SLEIGHT_WORKFLOW_DOCS: '0' } : {}) };
}
// The effective A/B modes for engine-arm metadata. MC1 and RS default on; the opt-in flags default off.
export const abFlags = (host = process.env) => ({ ...Object.fromEntries(AB_FLAGS.map(key => [key, host[key] === '1'])),
  SLEIGHT_RS: host.SLEIGHT_RS === undefined || host.SLEIGHT_RS === '1', SLEIGHT_MC1: host.SLEIGHT_MC1 !== '0' });
// AS-3: with SLEIGHT_BROWSER_CORE=1 the server lists browser_open, and a user's install can call it, so the arm allows it.
const ENGINE_TOOLS = ['js', 'js_reset', 'open_file', 'drag', 'select_window'];
export const engineAllowed = (host = process.env) => [...ENGINE_TOOLS, ...(host.SLEIGHT_BROWSER_CORE === '1' ? ['browser_open'] : [])]
  .map(tool => `mcp__plugin_sleight_computer__${tool}`).join(',');
const defaultMcpRoot = () => join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
// The two extension arms run in the round's own browser, which is the whole browser process: no window prompt.
// FowlBrowser keeps the previous gate's world prompt and Stop hook; Claude in Chrome keeps its world arm's device pin.
export function extensionArmSetup({ task, surface, dir, realBrowser, env, mcpRoot = defaultMcpRoot(), armRoot = defaultArmRoot(), chromeFiles }) {
  if (surface === 'claude-in-chrome') {
    if (realBrowser.browser !== 'chrome' || realBrowser.profileMode !== 'benchmark-copy') throw Error('Claude in Chrome needs Chrome with --real-profile benchmark');
    const arm = browserArmSetup({ surface, task: { ...task, browser: 'chrome' }, dir, armRoot, hostEnv: env, chromeFiles });
    const { launch, ...chrome } = arm.chrome; // the gate launches its own copy, never `open` on the default folder
    return { ...arm, chrome, args: [...arm.args.filter((arg, i, all) => arg !== '--tools' && all[i - 1] !== '--tools'), '--no-session-persistence'],
      promptPrefix: arm.promptPrefix + arm.setupPrefix, metadata: { ...arm.metadata, surface, connectionMode: 'extension (Claude Code --chrome)' } };
  }
  const common = worldAgentSetup({ surface: 'fowlbrowser', dir, armRoot, hostEnv: env });
  const label = `🧪 ${task.name}`;
  return { ...common, args: [...common.args, '--no-session-persistence'],
    mcpServers: { fowlbrowser: { command: join(mcpRoot, 'mcp/bin/fowlbrowser-mcp'), env: { FOWLBROWSER_LABEL: label, FOWLBROWSER_RECORD: dir } } },
    allowed: 'mcp__fowlbrowser',
    settings: { ...common.settings, hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${join(mcpRoot, 'mcp/bin/turn-ended.mjs')}"`, timeout: 5 }] }] } },
    promptPrefix: common.promptPrefix + `When cua.createBrowserTab is available, open tabs with cua.createBrowserTab(browserId, url, { sessionName: '${label}' }). Other tools accepting sessionName use the same label.\n\n`,
    metadata: { ...common.metadata, surface, mcpRoot, connectionMode: 'extension (FowlBrowser native host)' } };
}

// Claude Code writes its native-host manifest under Chrome's default folder on every --chrome start and, when none was
// there, opens its reconnect page in the running Chrome (the round's window). An existing manifest stops that page; the
// world arm's backup puts the folder back as it was afterwards.
export async function withClaudeManifest(plan, run, { backup = withManifestBackup } = {}) {
  const { manifest, backupDir } = plan.chrome;
  return backup(manifest, backupDir, async () => {
    if (!existsSync(manifest)) {
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify(claudeHostManifest(join(plan.env.CLAUDE_CONFIG_DIR, 'chrome/chrome-native-host')), null, 2), { mode: 0o644, flag: 'wx' });
    }
    return run();
  });
}

import { REAL_BROWSER_ARMS, CODEX_ARM_MODELS, isCodexSurface, isCodexSleightSurface, sleightKind, codexModelFor } from './support.mjs';
import { composerPlan as cursorComposerPlan } from '../world/arms/cursor-cu/contract.mjs';
import { CODEX_SLEIGHT_HOME, codexSleightServers, codexSleightToml } from '../codex-sleight.mjs';
import { CODEX_HOME } from '../codex-arm.mjs';
export const REAL_SURFACES = REAL_BROWSER_ARMS;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const codexHome = () => join(homedir(), '.codex-bench');
export function codexBrowserSetup({ dir, prompt, realBrowser, surface = 'codex' }) {
  prompt = windowPrompt(realBrowser) + prompt;
  const model = CODEX_ARM_MODELS[surface];
  if (!model) throw Error(`Unknown Codex arm: ${surface}`);
  return { command: 'codex', args: codexExecPlan(prompt, { cwd: dir, model, effort: 'high' }),
    prompt, mcpConfig: null, mcpConfigFile: join(codexHome(), 'config.toml'), env: { CODEX_HOME: codexHome() }, metadata: { model, effort: 'high',
      configDir: codexHome(), browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot,
      profileMode: realBrowser.profileMode || 'fresh', browserVersion: realBrowser.version ?? null, headless: false, focus: 'not measured' } };
}
// sleight inside Codex (LAWS, 2026-10-18): the sleight / sleight-turbo arm's servers, tools and prompt for this browser, run by
// `codex exec` from a Codex home of its own. The sleight server sits behind the benchmark proxy (bench/codex-sleight-proxy.mjs),
// which answers its approval forms from origin-hook.mjs (the race's allowlist) and applies the same select_window and
// engine-browser guards the Claude arms get as hooks. config.toml is written into the home just before the run.
export function codexSleightBrowserSetup({ arm, prompt, surface, kind, dir, realBrowser, home = CODEX_SLEIGHT_HOME }) {
  const model = codexModelFor(surface), turbo = kind === 'sleight-turbo';
  const servers = codexSleightServers({ mcpServers: arm.mcpServers, allowed: arm.allowed, dir, policy: 'race',
    gateWindow: !turbo, turboBrowser: turbo ? 'bbench' : undefined,
    extraEnv: arm.env.FOWL_GATE_WINDOW ? { FOWL_GATE_WINDOW: arm.env.FOWL_GATE_WINDOW } : {} });
  const toml = codexSleightToml({ model, effort: 'high', servers, comment: `${surface} on ${realBrowser.browser}, ${kind} configuration` });
  return { command: 'codex', args: codexExecPlan(prompt, { cwd: dir, model, effort: 'high' }), prompt, mcpConfig: null,
    codexConfig: { home, file: join(home, 'config.toml'), toml, servers: Object.keys(servers), sleightMcp: arm.mcpServers['plugin:sleight:computer'].command }, env: { CODEX_HOME: home },
    metadata: { model, effort: 'high', host: 'codex exec', surface, sleightAs: kind, configDir: home, loginSource: CODEX_HOME,
      connectionMode: turbo ? 'turbo (bench v3 server) plus engine companion, under Codex' : 'engine-computer under Codex',
      approvals: 'benchmark proxy (race allowlist, origin-hook.mjs); preapproved.json and the engine list untouched',
      codexServers: Object.keys(servers), browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot,
      profileMode: realBrowser.profileMode || 'fresh', browserVersion: realBrowser.version ?? null, headless: false,
      focus: turbo ? 'host monitor' : 'not measured' } };
}
// The names select_window may use for the round's own browser (origin-hook.mjs gateWindow), and its marker title.
export function gateWindowApps(realBrowser) {
  const names = { firefox: ['Firefox', 'org.mozilla.firefox'], safari: ['Safari', 'com.apple.Safari'] }[realBrowser.browser];
  if (!names || !realBrowser.marker) throw Error('Gate window selection needs Firefox or Safari with a marker');
  const app = /^(\/.+?\.app)\//.exec(realBrowser.executable ?? '')?.[1];
  return { apps: [...names, ...(app ? [app] : [])], title: realBrowser.marker };
}
export function realAgentSetup({ task, surface, dir, realBrowser, armHome, dryRun = false, allowBenchmarkAppPrompts = true, repo = repoRoot,
  model = 'haiku', effort = 'high', settings = join(dir, 'settings.json'), mcpRoot, armRoot, chromeFiles }) {
  if (!REAL_SURFACES.includes(surface)) throw Error(`Unknown real-browser arm: ${surface}`);
  const browserName = { chrome: 'Chrome', helium: 'Helium', firefox: 'Firefox', safari: 'Safari' }[realBrowser.browser];
  const prompt = task.prompt.replaceAll('{browser}', browserName).replaceAll('{repo}', repo).replaceAll('{out}', dir) +
    `\n\nEnd your answer with one line starting with RESULT: that states ${task.result}.`;
  if (surface === 'cursor-cu') {
    if (realBrowser.browser !== 'chrome') throw Error('Cursor desktop qualification is Chrome only');
    const cursorPlan = cursorComposerPlan({ prompt, allowedApps: task.allowedApps ?? ['com.google.Chrome'],
      timeoutMs: (task.budgetSeconds || 600) * 1000, allowBenchmarkAppPrompts });
    return { command: null, args: [], env: {}, prompt, mcpConfig: null, cursorPlan,
      metadata: { arm: 'cursor-cu', route: 'desktop', cursorVersion: '3.27.12', model: 'Grok 4.7 High', effort: 'high', speed: 'normal',
        configDir: cursorPlan.paths.userData, browser: 'chrome', headless: false, qualificationOnly: true } };
  }
  if (isCodexSurface(surface)) return codexBrowserSetup({ dir, prompt, realBrowser, surface });
  // The sleight-in-Codex arms build the sleight / sleight-turbo arm for this browser, then run it under Codex.
  const kind = sleightKind(surface, realBrowser.browser);
  const env =Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'TERM'].flatMap(key =>
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
  const engine = kind === 'sleight';
  const as3WindowPrompt = engine && process.env.SLEIGHT_BROWSER_CORE === '1' && process.env.AS3_WINDOW_PROMPT === '1';
  const extension = ['fowlbrowser', 'claude-in-chrome'].includes(surface);
  const computer = ['firefox', 'safari'].includes(realBrowser.browser);
  if ((engine && !computer) || (kind === 'sleight-turbo' && computer)) throw Error('Firefox/Safari use plain sleight; Chrome/Helium use sleight-turbo');
  const common = engine ? worldAgentSetup({ surface: 'sleight', dir, hostEnv: env }) : null;
  const arm = extension ? extensionArmSetup({ task, surface, dir, realBrowser, env, mcpRoot,
    ...(armRoot ? { armRoot } : {}), ...(chromeFiles ? { chromeFiles } : {}) })
    : engine ? { ...common,
    settings: { ...common.settings, ...genericSettings({ servers: ['plugin:sleight:computer'] }, repo) },
    // Turbo off: the round's Firefox or Safari is reachable only on the engine path, and a turbo.json in HOME would add
    // browser_* tools that point at the owner's Chrome or Helium (real round 2026-10-17: 5 of 12 tasks stopped on them).
    mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'), env: { SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0', SLEIGHT_HAND: '0', ...traceEnv() } } },
    env: { ...common.env, SLEIGHT_TURBO: '0', FOWL_GATE_WINDOW: JSON.stringify(gateWindowApps(realBrowser)) },
    allowed: engineAllowed(),
    metadata: { ...common.metadata, surface, connectionMode: 'engine-computer', abFlags: abFlags(), as3WindowPrompt } }
    : kind === 'sleight-turbo' ? turboSetup({ task: { ...task, browser: realBrowser.browser }, repo, dir, prompt, realBrowser,
      env: { ...env, ...traceEnv(), ...(process.env.SLEIGHT_LB12 === '0' || process.env.SLEIGHT_LB12 === '1' ? { SLEIGHT_LB12: process.env.SLEIGHT_LB12 } : {}),
        ...(process.env.SLEIGHT_MT === '0' || process.env.SLEIGHT_MT === '1' ? { SLEIGHT_MT: process.env.SLEIGHT_MT } : {}) } })
    : nativeBrowserSetup({ surface, repo, dir, realBrowser, armHome, dryRun, env });
  // The engine arm identifies the window natively. The turbo arm cannot (its tools show tabs, not windows), so it gets its own tools' truth.
  const fullPrompt = arm.promptPrefix + (engine ? windowPrompt(realBrowser, { browserCore: as3WindowPrompt }) : kind === 'sleight-turbo' ? turboWindowPrompt(realBrowser) : '') + prompt;
  if (isCodexSleightSurface(surface)) return codexSleightBrowserSetup({ arm, prompt: fullPrompt, surface, kind, dir, realBrowser });
  // Pinned: the same login reported "default" at 17:03 and "auto" from 20:05 on 2026-10-17, and under auto Claude in
  // Chrome sent every page action to a prompt in Chrome that nobody answers. allowedTools still lists each arm's tools.
  const args = ['-p', '--model', modelId(model), '--effort', effort, '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'), '--settings', settings,
    '--allowedTools', arm.allowed, '--tools', '', ...(surface === 'claude-in-chrome' ? [] : ['--no-chrome']), ...arm.args,
    ...(engine || surface === 'sleight-turbo' ? ['--plugin-dir', join(repo, 'plugins/sleight')] : [])];
  return { command: arm.command, args, prompt: fullPrompt, mcpConfig: { mcpServers: arm.mcpServers },
    settingsOverrides: engine || surface === 'sleight-turbo' ? { ...arm.settings, hooks: { ...arm.settings.hooks,
      Elicitation: [{ matcher: 'plugin:sleight:computer', hooks: [{ type: 'command', timeout: 5,
        command: `node "${join(repo, 'bench/fowl/origin-hook.mjs')}"` }] }],
      ...(engine ? { PreToolUse: [{ matcher: 'mcp__plugin_sleight_computer__select_window', hooks: [{ type: 'command', timeout: 5,
        command: `node "${join(repo, 'bench/fowl/origin-hook.mjs')}"` }] }] } : {}) } } : arm.settings, env: { ...arm.env, ANTHROPIC_SMALL_FAST_MODEL: modelId(model) }, allowed: arm.allowed,
    ...(arm.chrome ? { chrome: arm.chrome } : {}),
    metadata: { ...arm.metadata, browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot,
      profileMode: realBrowser.profileMode || 'fresh', ...(realBrowser.profileFolder ? { profileFolder: realBrowser.profileFolder } : {}),
      browserVersion: realBrowser.version ?? null, permissionMode: 'default', headless: false, focus: surface === 'sleight-turbo' ? 'host monitor' : 'not measured' } };
}
