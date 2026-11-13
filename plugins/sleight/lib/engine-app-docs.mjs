import { selectedTabShown } from './menu-continuation.mjs';

// The engine delivers per-app instructions with a getApp tree. For a browser they read "prefer opening a new tab",
// and Haiku opened the tab in a call of its own in 12 of 42 openings (about 3.5 s each, b3 2026-10-18).
// One sentence appended to that block puts the one-call rule where the model reads it last.
export const TAB_URL_SENTENCE = 'Open the tab and send its URL in the same call.';
// That sentence doesn't say how. In 7 of 36 Firefox runs (b10, 2026-10-19) Haiku clicked the "+" button and read the 40 KB
// New Tab page for the address field's number, 4.4 to 6.0 s a run; 25 sent Cmd+T and the URL in one call. Cmd+T focuses the
// new tab's address field, and the tab continuation carries the call there when the window's strip shows its selected tab
// (selectedTabShown, the earlier-tree half of tabRefusal; the stop and the native checks can still refuse). Safari's one-tab
// window shows no strip, its Cmd+T stopped 6 of 6 times, and its new-tab button and address field by ID ran in one call in
// 15 of 21 openings, so a tree without that strip keeps the plain sentence. Default since the race A/B (2026-10-19): Firefox
// rounds with it took 474.2, 450.8 and 440.1 s against 517.8, 488.5 and 512.0 s, all 12/12. Every Safari `browser-instructions`
// trace said `plain` (36 of 36), so Safari's text didn't change. Only a browser's instructions block carries it, so native sessions never
// read it. `tree` is the result's text after this item, for an engine that sends the tree as an item of its own.
export const KEYBOARD_TAB_SENTENCE = 'Open the tab and send its URL in the same call: `app.pressKey("super+t")`, then `app.typeText(url)` and `app.pressKey("Return")`; the new tab focuses its address field.';

const BLOCK = /(<app_specific_instructions>\r?\n## Browser Computer Use\b[\s\S]*?)(\r?\n<\/app_specific_instructions>)/;

export function rewriteBrowserInstructions(text, trace = () => {}, { tree = '' } = {}) {
  const m = BLOCK.exec(text);
  if (!m || m[1].includes(TAB_URL_SENTENCE) || m[1].includes(KEYBOARD_TAB_SENTENCE)) return text;
  const keyboard = selectedTabShown(text.slice(m.index + m[0].length) + '\n' + tree);
  trace('browser-instructions', { status: 'rewritten', route: keyboard ? 'keyboard' : 'plain' });
  return text.slice(0, m.index) + m[1].trimEnd() + ' ' + (keyboard ? KEYBOARD_TAB_SENTENCE : TAB_URL_SENTENCE) + m[2] + text.slice(m.index + m[0].length);
}

// The native getState lists apps without windows, and 26 of 36 runs then called listWindows, listBrowsers or listTabs
// (8 paid a separate refused call, 1.0 to 1.5 s each).
export const WINDOWS_LINE = "Windows: a window's title is the `Window:` header of `cua.getApp(...)`'s tree; there is no listWindows or listBrowsers here.";
// That line arrives after the turn is spent. Engine-path browser tasks that name a window opened with getState in
// 37 of 58 race runs (2026-10-18), a mean 2.75 s turn, so SLEIGHT_TS3=1 says it in the js description, before call one.
export const FIRST_CALL_WINDOWS = "cua.getState() lists no windows: to find a window by its title, start with getApp and read the result's `Window:` header.";
const GETSTATE_SENTENCE = "Use cua.getState() only to find an app or browser you can't name. ";

// The race prompt asks Claude to identify the dedicated window, and the engine's inventory sentence, followed by the
// getState block, reads as the way to do that: 39 of 72 b10 runs opened with getState (Firefox 27 of 36, Safari 12 of 36),
// a median 2.2 s detour, though the task named the browser. SLEIGHT_FS=1 adds a note where that choice is made, and turns
// on FIRST_CALL_WINDOWS (SLEIGHT_TS3) at the top. Rewritten only while the engine's sentence is exactly this.
export const INVENTORY_SENTENCE = 'When you need an inventory of available apps, browsers, and tabs, get a snapshot of all enabled surfaces.';
export const INVENTORY_NOTE = 'It lists apps, not windows: for a window of an app you can name, start with getApp.';
export function withInventoryNote(text) {
  if (typeof text !== 'string' || !text.includes(INVENTORY_SENTENCE) || text.includes(INVENTORY_NOTE)) return text;
  return text.replace(INVENTORY_SENTENCE, INVENTORY_SENTENCE + ' ' + INVENTORY_NOTE);
}

// After the description's getState sentence, else after its first sentence.
export function withFirstCallWindows(text) {
  if (typeof text !== 'string' || text.includes(FIRST_CALL_WINDOWS)) return text;
  const at = text.includes(GETSTATE_SENTENCE) ? text.indexOf(GETSTATE_SENTENCE) + GETSTATE_SENTENCE.length : text.indexOf('. ') + 2;
  return at < 2 ? text : text.slice(0, at) + FIRST_CALL_WINDOWS + ' ' + text.slice(at);
}

export function isNativeGetState(code, result) {
  if (typeof code !== 'string' || !/(?<![\w$.])cua\s*\.\s*getState\s*\(/.test(code)) return false;
  if (!result || result.isError || result._meta?.['codex/toolSurface']?.kind === 'browserUse') return false;
  return (result.content ?? []).some(c => c.type === 'text' && /^\s*\{\s*"apps"\s*:/.test(c.text ?? ''));
}
