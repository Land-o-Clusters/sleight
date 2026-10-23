// Shared by the patched runner and admission. Unsupported tasks remain in the
// runner's input so it can write their not-supported rows without agent setup.
const BROWSER_ARMS = ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu', 'browser-use'];
export const REAL_BROWSER_ARMS = ['sleight-turbo', 'sleight', 'lcu', 'cua', 'peekaboo', 'codex', 'codex-sol', 'codex-sleight', 'codex-sleight-sol', 'fowlbrowser', 'claude-in-chrome', 'cursor-cu'];
// The Codex arms are one arm on two models (LAWS, 2026-10-18): codex = gpt-6-luna, codex-sol = gpt-6.1-sol, both at effort high
// with the same CODEX_HOME and approvals. The surface name is the row's arm label, so the scorer keeps the two apart.
export const CODEX_ARM_MODELS = { codex: 'gpt-6-luna', 'codex-sol': 'gpt-6.1-sol' };
export const isCodexSurface = surface => Object.hasOwn(CODEX_ARM_MODELS, surface);
// Two more arms run sleight itself inside Codex as its MCP plugin (LAWS, 2026-10-18), on the same two models at effort high:
// codex-sleight = gpt-6-luna, codex-sleight-sol = gpt-6.1-sol. They are not the Codex arms above (those drive the engine's own
// computer-use server from ~/.codex-bench); they use their own CODEX_HOME (bench/codex-sleight.mjs).
export const CODEX_SLEIGHT_ARM_MODELS = { 'codex-sleight': 'gpt-6-luna', 'codex-sleight-sol': 'gpt-6.1-sol' };
export const isCodexSleightSurface = surface => Object.hasOwn(CODEX_SLEIGHT_ARM_MODELS, surface);
// Every arm that runs `codex exec`, and the model each one is asked for.
export const runsCodexExec = surface => isCodexSurface(surface) || isCodexSleightSurface(surface);
export const codexModelFor = surface => CODEX_ARM_MODELS[surface] ?? CODEX_SLEIGHT_ARM_MODELS[surface];
// A sleight arm inside Codex races as sleight does in each browser: turbo in Chromium browsers, the engine path in Firefox and Safari.
export const sleightKind = (surface, browser) => isCodexSleightSurface(surface) ? (['chrome', 'helium'].includes(browser) ? 'sleight-turbo' : 'sleight') : surface;
// The apps a competitor arm may be approved for in a real-window round: the round's own browser plus the hand-off tasks'
// native apps, the same ones sleight's hook (origin-hook.mjs) accepts. All are on the benchmark's allowlist (bench/tasks.mjs).
const RACE_BROWSERS = { chrome: ['Google Chrome', 'com.google.Chrome'], helium: ['Helium', 'net.imput.helium'],
  firefox: ['Firefox', 'org.mozilla.firefox'], safari: ['Safari', 'com.apple.Safari'] };
export function raceApps(browser) {
  if (!RACE_BROWSERS[browser]) throw Error(`No race apps for ${browser}`);
  return [...RACE_BROWSERS[browser], 'Preview', 'com.apple.Preview', 'TextEdit', 'com.apple.TextEdit'];
}
export const raceBundles = browser => raceApps(browser).filter(app => /^[a-z]+\.[\w.-]+$/i.test(app));
export function taskSupport(task, surface, { world = false, remote = null, realBrowser } = {}) {
  if (realBrowser) {
    surface = sleightKind(surface, realBrowser);
    if (remote) return 'Real browser gate is local only';
    if (!REAL_BROWSER_ARMS.includes(surface)) return `Real browser gate uses ${REAL_BROWSER_ARMS.join(', ')}`;
    if (surface === 'cursor-cu' && realBrowser !== 'chrome') return 'Cursor desktop qualification is Chrome only';
    if (!['chrome', 'helium', 'firefox', 'safari'].includes(task.browser)) return 'Real browser gate supports browser tasks only';
    if (surface === 'claude-in-chrome' && realBrowser !== 'chrome') return 'Claude in Chrome runs in Chrome only';
    if (surface === 'fowlbrowser' && !['chrome', 'helium'].includes(realBrowser)) return 'FowlBrowser runs in Chrome or Helium only';
    if (realBrowser === 'safari') {
      if (surface === 'sleight-turbo') return 'Safari has no turbo surface; use sleight on the engine computer surface';
      if (task.viewport) return 'Safari computer arms have no qualified device viewport and restoration path';
      if (task.downloads) return 'Safari AX tab inventory cannot observe completed downloads';
      if (task.takeover) return 'Takeover requires the separate user-takeover test protocol';
      return null;
    }
    if (realBrowser === 'firefox' && surface === 'sleight-turbo') return 'Firefox has no turbo surface; use sleight on the engine computer surface';
    if (realBrowser !== 'firefox' && surface === 'sleight') return 'Use sleight-turbo for Chrome/Helium real-browser gates';
    if (realBrowser === 'firefox' && task.viewport) return 'Firefox computer arms have no qualified device viewport and restoration path';
    if (realBrowser === 'firefox' && task.downloads) return 'Firefox sessionstore cannot observe completed downloads';
    if (realBrowser === 'firefox' && task.takeover) return 'Takeover requires the separate user-takeover test protocol';
    return null;
  }
  if (['lcu', 'cua', 'peekaboo'].includes(surface)) return 'Native browser arms require --real-browser';
  if (surface === 'sleight-turbo' && remote) return 'Turbo bench is local only';
  if (world && surface === 'codex-agent') return 'codex-agent does not run Claude Code';
  if (world && remote) return 'Isolated world arms do not support remote configuration';
  if (BROWSER_ARMS.includes(surface) && remote) return 'This browser arm does not support remote configuration';
  if (BROWSER_ARMS.includes(surface) && !['chrome', 'helium'].includes(task.browser)) return 'This arm supports browser tasks only';
  if (surface === 'claude-in-chrome' && task.browser !== 'chrome') return 'Claude in Chrome requires the benchmark Chrome device';
  return null;
}
export const runnableTasks = (tasks, options) => tasks.filter(task => !taskSupport(task, task.surface, options));
