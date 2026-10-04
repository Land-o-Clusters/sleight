// Driving the apps the engine refuses (terminals, OpenAI's own apps) through
// sleight's own Accessibility path — the one menu_bar and drag use (owner
// decision, docs/status/LAWS.md, 2026-10-04). OpenAI's helper and engine are
// never modified, patched or wrapped here; their refusal list is only
// recognized, and sleight's own code does the driving.
//
// Off unless both are true: SLEIGHT_BLOCKED_APPS=1 in Claude Code's
// environment, and the user's flag file next to the preapproved list. No
// project or plugin setting can turn it on.
import { homedir, userInfo } from 'node:os';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FLAG_FILE = join(homedir(), 'Library', 'Application Support', 'sleight', 'blocked-apps.json');

const error = message => new Error(`Blocked apps: ${message}`);

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
// Claude cannot change the apps' own approval or safety settings. Titles
// beyond these English forms are a known gap (README).
export const SETTINGS_TITLE = /^(?:settings|preferences|réglages|einstellungen|impostazioni|configuración|ajustes|preferencias|設定|设置|偏好设置)(?:…|\.{3})?$/i;
export const isSettingsTitle = title => typeof title === 'string' && SETTINGS_TITLE.test(title.trim());

// A click on a button named like these is named in the result, so the
// transcript shows that Claude clicked, say, an approval button in Codex.
export const APPROVAL_BUTTON = /^(approve|allow|run|accept)\b/i;
export function approvalButton(label) {
  return APPROVAL_BUTTON.exec(String(label ?? '').trim())?.[1].toLowerCase();
}

// Sends that can run a command in a terminal: typed text (newlines included),
// and the keys that execute or paste. Other keys, reads and scrolling never
// ask. The exact text goes to the user first, every time, and nothing about
// this is ever remembered or pre-approved.
const SEND_KEYS = new Set(['return', 'enter', 'super+v', 'cmd+v', 'command+v']);
export function terminalSend(args = {}) {
  if (args.op === 'type') return typeof args.text === 'string' ? args.text : undefined;
  if (args.op === 'key') {
    const key = String(args.key ?? '').trim().toLowerCase().replace(/\s+/g, '');
    return SEND_KEYS.has(key) ? `key ${args.key}` : undefined;
  }
  return undefined;
}

// The user's flag file, held to the same standard as the preapproved list:
// a regular file, owned by the OS user, not group- or world-writable, no
// symlinks, content exactly {"version": 1}. Missing is off; invalid fails
// startup loudly rather than silently ignoring what the user wrote.
export function loadBlockedAppsFlag(io = { lstatSync, readFileSync, statSync }) {
  let before;
  try { before = io.lstatSync(FLAG_FILE); }
  catch (err) {
    if (err.code === 'ENOENT') return false;
    throw error(err.message);
  }
  if (before.isSymbolicLink()) throw error('the flag file must not be a symlink');
  if (!before.isFile()) throw error('the flag file must be a regular file');
  if (before.uid !== userInfo().uid) throw error('the flag file must be owned by the current user');
  if (before.mode & 0o022) throw error('group- or world-writable flag files are refused');
  let config;
  try { config = JSON.parse(io.readFileSync(FLAG_FILE, 'utf8')); }
  catch (err) { throw error(`could not read the flag file: ${err.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).length !== 1 || config.version !== 1) {
    throw error('expected {"version": 1} and nothing else');
  }
  try { io.statSync(FLAG_FILE); }
  catch (err) { throw error(`the flag file changed while reading: ${err.message}`); }
  return true;
}

export const BLOCKED_APP_TOOL = {
  name: 'blocked_app',
  description: 'Drive an app the engine refuses (Terminal, iTerm2, ChatGPT, Codex, Atlas) through macOS ' +
    'Accessibility, which the js tool cannot reach. op "read" returns the window as numbered elements plus a ' +
    'screenshot file; "click" presses `element` (or a window-relative `point`, which brings the app to the front); ' +
    '"type" sends `text`; "key" presses `key` ("Return", "super+v"); "scroll" moves `amount` lines, positive up. ' +
    'The user approves the app once per session. In a terminal, every command send (typing, Return, Enter, paste) ' +
    'is shown to the user first and never remembered. Settings windows are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['read', 'click', 'type', 'key', 'scroll'] },
      app: { type: 'string', description: 'App name, bundle ID or path' },
      element: { type: 'integer', description: 'click: the element number from read' },
      point: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'click: window-relative [x, y]' },
      text: { type: 'string', description: 'type: the exact text to send' },
      key: { type: 'string', description: 'key: Return, Tab, Escape, super+v, …' },
      amount: { type: 'integer', description: 'scroll: lines, positive up' },
    },
    required: ['op', 'app'],
    additionalProperties: false,
  },
};

const text = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

// Runs one blocked_app op. `target` is the resolved lease target (app name and
// bundle ID), `approve` is the relay's once-per-session approval with options
// (the app consent is remembered; terminal sends pass once: true, which is
// never remembered), `run` executes the driver script, and `shot` is the file
// a window screenshot is saved to. Everything the user must decide happens
// before `run`, and every executed action is logged with app, element and text.
export async function callBlockedApp(args, { approve, run, target, shot, trace = () => {}, stderr = process.stderr }) {
  const entry = matchBlockedApp(args.app, target?.appId);
  if (!entry) {
    return text('blocked_app only drives the apps the engine refuses (Terminal, iTerm2, ChatGPT, Codex, Atlas and beta builds). ' +
      'For other apps use the js tool. Nothing was driven.', true);
  }
  const name = target?.app ?? entry.name;
  const consent = entry.terminal
    ? `Claude will be able to read, click and type in ${name}, including running commands, for the rest of this session. ` +
      'Every command send is shown to you first.'
    : `Claude will be able to click in ${name}, including approval buttons, for the rest of this session.`;
  if (!await approve(['blocked_app', target?.appId ?? entry.name],
    `Allow Claude to drive ${name} through Accessibility?`, { kind: 'blocked', detail: consent })) {
    return text(`The user didn't allow Claude to drive ${name}. Stop and tell them; don't work around it.`, true);
  }
  if (entry.terminal) {
    const send = terminalSend(args);
    if (send !== undefined) {
      const allowed = await approve(['blocked_app_send', target?.appId ?? entry.name],
        `Allow Claude to send this to ${name} once?`, { once: true, kind: 'flow',
          detail: `Exact text sent to ${name}:\n${JSON.stringify(send)}` });
      if (!allowed) {
        return text(`The user didn't allow this send to ${name}. Stop and tell them; don't work around it.`, true);
      }
    }
  }
  const logged = {
    app: target?.appId ?? args.app, op: args.op,
    ...(args.element !== undefined ? { element: args.element } : {}),
    ...(typeof args.text === 'string' ? { text: args.text } : {}),
    ...(args.key !== undefined ? { key: args.key } : {}),
    ...(Array.isArray(args.point) ? { point: args.point } : {}),
  };
  stderr.write(`sleight: blocked_app ${args.op} ${name}` +
    (args.element !== undefined ? ` element ${args.element}` : '') +
    (typeof args.text === 'string' ? ` text ${JSON.stringify(args.text)}` : '') +
    (args.key !== undefined ? ` key ${args.key}` : '') + '\n');
  trace('blocked-app-action', logged);
  const result = await run({ ...args, settings: SETTINGS_TITLE.source, shot });
  if (!result.ok) return text(result.settings ? `${result.error} sleight never drives these apps' settings windows.` : result.error, true);
  const { ok, ...rest } = result;
  const notes = [];
  // In Codex/ChatGPT a click on an approval-like button is named in the result,
  // so the transcript shows it even when the pane doesn't.
  const approval = approvalButton(rest.clickedLabel);
  if (approval) notes.push(`Clicked a button named "${approval}" (element ${rest.clicked}).`);
  if (rest.note) notes.push(rest.note);
  if (rest.fronted) notes.push(`${name} came to the front for this action${rest.putBack ? ` and ${rest.putBack} went back` : ''}.`);
  if (rest.shot) notes.push(`Window screenshot saved at ${rest.shot}; view it with your Read tool.`);
  return text(notes.length ? `${notes.join(' ')}\n${JSON.stringify(rest, null, 1)}` : rest);
}
