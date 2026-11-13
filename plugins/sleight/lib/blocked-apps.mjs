// The apps the engine refuses (terminals, OpenAI's own apps). OpenAI's helper
// and engine are never modified, patched or wrapped here; their refusal list is
// only recognized. A user who turns the refusal off themselves gets the engine's
// per-app approval with sleight's warning, and settings windows stay refused.

// The apps the engine's helper refuses before any approval prompt (README,
// "Known problems"): terminals, and OpenAI's own apps with their beta builds.
// The ChatGPT desktop app now identifies as com.openai.codex, so OpenAI's apps
// match on the bundle prefix, which also covers betas and future suites.
const TERMINAL_BUNDLES = new Map([['com.apple.terminal', 'Terminal'], ['com.googlecode.iterm2', 'iTerm2']]);
const TERMINAL_NAMES = new Map([['terminal', 'com.apple.terminal'], ['iterm2', 'com.googlecode.iterm2'], ['iterm', 'com.googlecode.iterm2']]);
const OPENAI_NAMES = new Map([['chatgpt', 'ChatGPT'], ['codex', 'Codex'], ['atlas', 'Atlas']]);
const NAME_KEY = value => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/^.*\//, '').replace(/\.app$/, '').replace(/\s+beta$/, '')
  : '';

// Matches one of the refused apps by bundle ID, name or app path. The bundle
// ID decides when one is known; a name alone matches only the known list.
export function matchBlockedApp(app, bundleId) {
  const bundle = typeof bundleId === 'string' ? bundleId.trim().toLowerCase() : '';
  const name = NAME_KEY(app);
  if (bundle) {
    if (TERMINAL_BUNDLES.has(bundle)) return { name: TERMINAL_BUNDLES.get(bundle), terminal: true };
    if (bundle.startsWith('com.openai.')) return { name: OPENAI_NAMES.get(name) ?? bundleId, openai: true };
    return undefined;
  }
  if (TERMINAL_NAMES.has(name)) return { name: TERMINAL_BUNDLES.get(TERMINAL_NAMES.get(name)), terminal: true };
  if (OPENAI_NAMES.has(name)) return { name: OPENAI_NAMES.get(name), openai: true };
  return undefined;
}

// The engine's refusal, verbatim (bench/blocked-refusal.mjs, engine
// 26.930.31730): "Computer Use is not allowed to use the app '…' for safety
// reasons." It arrives as an error result before any approval prompt.
export function refusedApp(text) {
  return /Computer Use is not allowed to use the app '([^']+)' for safety reasons/.exec(text ?? '')?.[1];
}

// Settings and preferences windows of the refused apps are never driven, so
// Claude cannot change the apps' own approval or safety settings. Engine
// window headers carry only the title, so the title decides.
export const SETTINGS_TITLE = /^(?:settings|preferences|réglages|einstellungen|impostazioni|configuración|ajustes|preferencias|設定|设置|偏好设置)(?:…|\.{3})?$/i;
export const isSettingsTitle = title => typeof title === 'string' && SETTINGS_TITLE.test(title.trim());
// Terminal names its settings window after the open pane.
const TERMINAL_SETTINGS_PANES = /^(?:general|profiles|window groups|encodings|advanced)$/i;

// The user can turn off the helper's refusal themselves with
// `defaults write -g ComputerUseAllowForbiddenTargets -bool YES` (OpenAI's
// helper reads it; sleight never writes it). Then these apps go through the
// engine with the same approval card as any app (Always allow included), with
// one warning line added, and their settings windows are refused.
export function forbiddenTargetsAllowed(read) {
  try { return /^(?:1|true|yes)$/i.test(String(read()).trim()); } catch { return false; }
}
export function forbiddenTargetWarning(app) {
  if (typeof app !== 'string') return undefined;
  const bundleLike = /^[\w-]+(?:\.[\w-]+)+$/.test(app.trim());
  const match = (bundleLike && matchBlockedApp(app, app)) || matchBlockedApp(app);
  if (!match) return undefined;
  return match.terminal
    ? `This app could be dangerous: ${match.name} is a terminal, and Claude could type and run commands in it.`
    : `This app could be dangerous: ${match.name} is another AI app, and Claude could approve its actions.`;
}
export function isForbiddenSettingsWindow(window) {
  const match = window && matchBlockedApp(window.app, window.appId);
  if (!match) return false;
  return isSettingsTitle(window.title) || (match.terminal && TERMINAL_SETTINGS_PANES.test(String(window.title ?? '').trim()));
}

// What Claude tells the user when the engine refuses one of these apps: the
// one setting that turns the refusal off, which only the user may run.
export const ALLOW_FORBIDDEN_COMMAND = 'defaults write -g ComputerUseAllowForbiddenTargets -bool YES';
export function refusalNotice(app) {
  return `The engine refuses ${app} before any approval (OpenAI's rule for terminals and its own apps), ` +
    "so sleight can't drive it. Don't work around this. Tell the user they can lift that refusal themselves " +
    `by running \`${ALLOW_FORBIDDEN_COMMAND}\` in Terminal. It applies to every app that uses the engine, Codex ` +
    "included. After that, sleight asks once per session before driving the app, and its settings windows stay refused.";
}
