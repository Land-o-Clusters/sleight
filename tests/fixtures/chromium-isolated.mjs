import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { protectLaunchedTestChromium } from './chromium-close.mjs';
export { closeTestChromium } from './chromium-close.mjs';

const launcher = fileURLToPath(new URL('./chromium-no-apps.sh', import.meta.url));

export const chromiumShellName = 'chrome-headless-shell';
export const chromiumAppExecutable = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

// All test and bench executable paths live here so a source scan can reject
// new raw launch paths without maintaining a per-test exception list.
export function testChromiumExecutable({ headless = true, home = homedir(), revision,
  platform = process.platform, arch = process.arch } = {}) {
  const name = headless ? 'chromium-headless-shell' : 'chromium';
  revision ??= JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
    .browsers.find(browser => browser.name === name).revision;
  const cache = join(home, 'Library/Caches/ms-playwright');
  return headless
    ? join(cache, 'chromium_headless_shell-' + revision, chromiumShellName + '-' + (platform === 'darwin' ? 'mac-' + arch : 'linux64'), chromiumShellName)
    : join(cache, 'chromium-' + revision, platform === 'darwin' ? 'chrome-mac-' + arch : 'chrome-linux64',
      platform === 'darwin' ? chromiumAppExecutable : 'chrome');
}

// Raw spawn callers use the same wrapper as Playwright, with identical args.
export function isolatedChromiumSpawn(executablePath, args, options = {}, platform = process.platform) {
  if (platform !== 'darwin') return { executablePath, args, options };
  return { executablePath: launcher, args, options: { ...options,
    env: { ...process.env, ...options.env, SLEIGHT_TEST_CHROMIUM_EXECUTABLE: executablePath } } };
}

function executable(chromium, options) {
  if (options.executablePath) return options.executablePath;
  const full = chromium.executablePath();
  if (options.channel === 'chromium') return full;
  if (options.channel) throw Error('Test Chromium needs an explicit executable for this channel');
  // Playwright's default headless launch uses the shell, while its public
  // executablePath() returns full Chromium. Preserve that original selection.
  const shell = full.replace(/\/chromium-(\d+)\/chrome-mac-(arm64|x64)\/.*$/, '/chromium_headless_shell-$1/chrome-headless-shell-mac-$2/chrome-headless-shell');
  if (shell === full) throw Error('Test Chromium headless shell path is unavailable');
  return shell;
}

// Test-owned browsers only. Headless Chrome still sends mailto to Launch
// Services. Keep that OS boundary outside the page and the product guard so
// tests can detect a missed refusal without opening an app on the test host.
export function isolatedChromiumOptions(chromium, options = {}, platform = process.platform) {
  if (options.headless === false) throw Error('Test Chromium must be headless');
  if (platform !== 'darwin') return { ...options, headless: true };
  return { ...options, headless: true, executablePath: launcher,
    env: { ...process.env, ...options.env,
      SLEIGHT_TEST_CHROMIUM_EXECUTABLE: executable(chromium, options) } };
}

export async function launchTestChromium(chromium, options) {
  return protectLaunchedTestChromium(await chromium.launch(isolatedChromiumOptions(chromium, options)));
}
export async function launchTestChromiumContext(chromium, profile, options) {
  const context = await chromium.launchPersistentContext(profile, isolatedChromiumOptions(chromium, options));
  protectLaunchedTestChromium(context.browser());
  return context;
}

// Chromium can expose its first page before this two-line file is complete.
export async function readTestDevToolsPort(profile, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  do {
    try {
      const lines = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (/^[1-9]\d{0,4}$/.test(lines[0]) && Number(lines[0]) <= 65535 &&
          /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1] ?? '')) return lines;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  throw Error('Test Chromium DevTools endpoint did not become ready');
}
