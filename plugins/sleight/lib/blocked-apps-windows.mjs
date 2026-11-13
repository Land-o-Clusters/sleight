// User-owned policy, evaluated in the relay process, never in the REPL worker.
import { win32 } from 'node:path';
import { isSettingsTitle } from './blocked-apps.mjs';
import { WINDOWS_DRIVER_ERRORS } from './windows-driver/errors.mjs';

const terminals = new Set(['windowsterminal', 'wt', 'conhost', 'openconsole', 'powershell', 'pwsh', 'powershell_ise',
  'cmd', 'mintty', 'bash', 'git-bash', 'wsl', 'ubuntu', 'debian', 'kali', 'conemu', 'conemu64', 'cmder',
  'alacritty', 'wezterm', 'wezterm-gui', 'hyper', 'tabby']);
const ai = new Set(['chatgpt', 'codex', 'atlas']);
const browsers = new Set(['chrome', 'chromium', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi', 'iexplore', 'helium', 'arc',
  'microsoft edge', 'google chrome', 'mozilla firefox']);
const approvalHosts = new Set(['claude', 'cursor', 'copilot', 'code', 'code-insiders', 'visual studio code']);
export const WINDOWS_FORBIDDEN_NOTICES = Object.freeze({
  settings: 'Settings windows of forbidden Windows apps stay refused.',
  target: 'This Windows target is refused. Only the user may set SLEIGHT_ALLOW_FORBIDDEN_TARGETS=1.',
  terminal: 'This app could be dangerous: it is a terminal, and Claude could type and run commands in it.',
  openai: 'This app could be dangerous: it is another AI app, and Claude could approve its actions.',
  host: 'This app can show approval cards, and Claude could approve its own later actions in it.',
});
const identities = window => [window?.image, window?.originalFilename, window?.productName].filter(v => typeof v === 'string')
  .map(v => win32.basename(v).replace(/\.exe$/i, '').toLowerCase());
export function matchBlockedWindowsApp(window) {
  const names = identities(window);
  const aumid = typeof window?.aumid === 'string' ? window.aumid.toLowerCase() : '';
  // Browser driving is unavailable in this release, independently of the user's forbidden-app override.
  // Chrome_WidgetWin_1 alone also belongs to Electron apps, so it provides no browser proof.
  if (names.some(image => browsers.has(image)) || aumid.startsWith('microsoft.microsoftedge') ||
      typeof window?.className === 'string' && window.className.toLowerCase() === 'mozillawindowclass') return { browser: true };
  if (names.some(image => terminals.has(image)) || window?.className === 'ConsoleWindowClass' ||
      /^microsoft\.windowsterminal(?:preview)?_/.test(aumid)) return { terminal: true };
  if (names.some(image => ai.has(image)) || /^openai\.(?:chatgpt|codex|atlas)(?:[._!-]|$)/.test(aumid)) return { openai: true };
}

export function forbiddenWindowsTarget(window, { allowForbidden = false } = {}) {
  const blocked = matchBlockedWindowsApp(window);
  if (!blocked) return;
  if (blocked.browser) return { code: 'BROWSER_TARGET_REFUSED', ...WINDOWS_DRIVER_ERRORS.BROWSER_TARGET_REFUSED };
  const title = String(window.title ?? '').trim();
  if (isSettingsTitle(title) || /^(?:settings|preferences)(?:\s*[-:|]\s*.+)?$/i.test(title) ||
      /^(?:.+?\s*[-:|]\s*)(?:settings|preferences)$/i.test(title) ||
      /^(?:general|profiles|startup|interaction|appearance|rendering|compatibility|actions|defaults)$/i.test(title))
    return { code: 'FORBIDDEN_SETTINGS', message: WINDOWS_FORBIDDEN_NOTICES.settings };
  if (!allowForbidden) return { code: 'FORBIDDEN_TARGET',
    message: WINDOWS_FORBIDDEN_NOTICES.target };
}

export function windowsForbiddenWarning(window) {
  const blocked = matchBlockedWindowsApp(window);
  if (blocked?.browser) return;
  return blocked?.terminal ? WINDOWS_FORBIDDEN_NOTICES.terminal : blocked?.openai ? WINDOWS_FORBIDDEN_NOTICES.openai
    : identities(window).some(name => approvalHosts.has(name)) ? WINDOWS_FORBIDDEN_NOTICES.host : undefined;
}
