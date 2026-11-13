// Authored for sleight. Delivered as result text through the relay's first-call path.
import { readFileSync } from 'node:fs';

export const MAC_REPL_DOCS = readFileSync(new URL('./docs-mac.md', import.meta.url), 'utf8');
export function replDocumentation(platform) {
  if (platform === 'darwin') return MAC_REPL_DOCS;
  if (platform === 'win32') return WINDOWS_REPL_DOCS;
  throw Error('PLATFORM');
}
export const WINDOWS_REPL_DOCS = `## Computer Use

Sleight's Windows driver uses UI Automation and window messages in the background.
It never launches, raises or restores a target window. Foreground fallback and hover are unavailable.
Use await for each operation. Keep app handles between js calls. Node 25 or later is required.

Acquire by app name, executable path, AUMID or exact window title:
let app = await cua.getApp("Notepad");
Choose one window with await cua.getApp({ windowId: "101" }). HWNDs are decimal strings.
await cua.getState() returns apps and windows. await cua.listApps() returns the app array.

App reads: await app.getAXState({ disableDiffing: true }), await app.getScreenshot(),
await app.getAXStateAndScreenshot(). The combined result has state and screenshot fields.
Reads and screenshots emit their output. Pass { emit: false } to retain it without displaying it.
Trees start with Window: and contain numbered, indented elements. Protected fields show <redacted>.

Input methods: click(target), doubleClick(target), rightClick(target), setValue(target, text),
performSecondaryAction(target, action), scroll(target, { direction: "down", amount: 3 }), selectText(target, text),
drag(from, to), typeText(text), paste(text, options), pressKey(key).
A target is a current element number, { id: "AutomationId" }, { label: "Exact label" },
or [x, y] in physical client pixels from that window's screenshot, multiplier 1.
Prefer setValue for text and advertised menu actions for shortcuts. pressKey("Return") is a plain key.
Secondary actions use Invoke, Toggle, Select, Expand, Collapse, ScrollIntoView or DoDefaultAction.
CHORD_NEEDS_FOREGROUND refuses a chord. Limited posted chords can act as a bare key.
Actions return a tree and confirmation: "unconfirmed". Inspect the outcome before repeating input.
Paste uses focused writable native Edit/RichEdit controls, without clipboard access. Other targets, tabs and
newlines refuse before input. Check partial text before retrying.
Capture uses PrintWindow for one client area. Black, minimized, cloaked and other-virtual-desktop notes contain no image.
Actions and capture require session approval, a valid input lease and the same process and window identity.
Elevated apps and unresolved frame hosts refuse. Forbidden targets follow the user's override; their settings stay refused.
Minimized packaged apps refuse. Only the user may restore or reopen them.
OLE drags, IME composition and some Chromium input are unsupported. Browser turbo is unavailable here.
Follow payment, flow and document-scope refusals. Stop on declined approval or lease refusal.

nodeRepl.write(value) displays text. await nodeRepl.emitImage({ data: base64, mimeType: "image/png" })
displays an image; bytes may replace data. Top-level await, let and const persist between calls.
js_reset clears bindings and app handles. A timeout also clears the worker. Read and acquire again afterward.
await cua.rewriteDocumentation() displays this API text again.
`;

export function windowsReplTools() {
  return [
    { name: 'js', description: 'Run persistent JavaScript for Windows apps in the background. Start with let app = await cua.getApp("Notepad") for a named running app. cua.getState() lists apps and windows. Await each operation and reuse handles. The first result includes the Windows API and skill. Foreground fallback and hover are unavailable. Coordinates are physical client pixels, multiplier 1. App access requires session approval, an input lease and identity checks. Follow safety refusals.',
      inputSchema: { type: 'object', properties: { code: { type: 'string' }, title: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 1, maximum: 120000 } }, required: ['code'], additionalProperties: false } },
    { name: 'js_reset', description: 'Clear the Windows JavaScript session, app handles and pending driver work. The next js result includes the API again.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'turn_ended', description: 'End the current computer-use turn.', inputSchema: { type: 'object', properties: {} } },
  ];
}
