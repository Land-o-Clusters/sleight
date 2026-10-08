---
name: drive-mac-apps
description: Use when a task needs a web page or native macOS app operated through its UI (clicking, typing, dragging, reading what is on screen) and no CLI, API or dedicated tool covers it. sleight drives the app in the background through the computer-use engine bundled with the ChatGPT desktop app, without moving the user's pointer.
---

# Driving Mac apps with sleight

sleight's tools are `mcp__plugin_sleight_computer__js` and `mcp__plugin_sleight_computer__js_reset`.
`js` runs JavaScript in a persistent session that holds the `cua` API.

## Before you use it

UI automation is the slowest and most fragile option, so try the others first. Use the app's CLI or API if
it has one, then a dedicated MCP tool or connector. Use sleight's browser surface for web pages when an extension browser is connected, and its native
surface for macOS apps. For a public page, a built-in browser tool is usually faster. sleight's
browser surface fits pages that need the user's own logged-in browser. Use another browser tool if
browser control is unavailable.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`. Only the user writes
that approval list. It applies in interactive and headless sessions. If an app needs approval, ask
the user or stop when a headless run refuses it. Changing the file is not an approval workaround.

## How to use it

1. Make the first `js` call exactly one API call, such as `let app = await cua.getApp("Calculator")`.
   Its result contains the full API documentation and the app's current UI state. Read both before acting.
   When two copies of an app share a bundle ID (an installed app and a dev build), `getApp` with the ID
   fails as ambiguous. Pass the full path to the `.app` instead. If you don't know the app's name, look
   it up in one expression: `(await cua.listApps()).map(a => a.id + " " + a.displayName).join("\n")`.
   To choose among several windows, call `select_window` with `app` and an exact file `url`,
   or an exact `title` when no URL is known. It uses AXRaise/AXMain without activating the app.
   Then acquire the app in a standalone `js` call and check its Window and URL before acting.
   Missing or duplicate matches stop selection. After a guard stop, follow the relay's selection
   recovery hint and check the header again. A changed or missing action header means
   "outcome unconfirmed", so read the document before retrying.
2. Act by element index from the UI state (`await app.click(12)`) when you can, and by coordinates only
   when an element has no index. Batch several actions in one call when you're sure of them. Await every
   action: one that fails without `await` can end the engine's session and lose every handle.
   In a native app you can address an element by its ID or label instead of its number:
   `await app.click({ id: "Seven" })` for a line with `ID: Seven`, or `{ label: "Multiply" }` for its
   description or title. sleight finds it in a fresh read just before the action. A batch addressed
   this way keeps working when an earlier action in it renumbers the window (Calculator's All Clear
   does). The name must match one element exactly, or the
   action stops. The same works for `scroll`, `selectText`, `setValue` and `performSecondaryAction`.
3. The first time you touch an app, the user gets an approval prompt unless their list preapproved it.
   If the result says the app was not
   approved, stop and tell the user. Don't retry around it. The engine refuses terminal apps and
   OpenAI's own apps (ChatGPT, Codex) before any prompt; for those, sleight's `blocked_app` tool is
   the path (see below), and the user's approval of its prompt is what allows it. Tell the user what
   you're asking for and why. If the user turned that refusal off themselves (`--doctor` says so),
   `cua.getApp("com.apple.Terminal")` asks like any other app, and `js` drives it in the
   background. Never set or suggest that setting yourself, and never act in these apps' settings.
4. If a result says the user changed the app, re-read its state before acting again. The person may be
   using it.
5. Use `await app.getScreenshot()` when the accessibility tree doesn't show what you need, such as
   canvases, images or iPhone Mirroring. It already shows you the picture, so don't pass it to
   `nodeRepl.emitImage(...)` too. Keep using the same handle between actions instead of acquiring the
   app again before each one.

The relay takes a window lease before acting. If another sleight session holds it, the refusal names
that session and the seconds left. Stop actions and tell the user, using reads if needed to inspect
the window. The lease ends with the turn or after 30 seconds without renewal, but it cannot coordinate
Codex or other tools that do not take it. Local drag and hover reserve the entire app, while menu and
notification actions reserve the desktop.

## Browser pages

Browser control turns on when startup discovery finds a connected ChatGPT extension. Without one,
only native apps are enabled. `SLEIGHT_SURFACES` overrides discovery. Use `computer` to keep
browser control off. The in-app browser needs ChatGPT host context and is excluded from automatic mode.

Start with one call: `await cua.listBrowsers()`. Read the returned documentation. Several Chromium
browsers can report as Chrome, including Helium. Match `metadata.extensionInstanceId` to the owner's
chosen browser, then select it with a standalone call:

```javascript
let browser = await cua.getBrowser({ extensionInstanceId: "the observed instance ID" });
```

Open the page directly with `let tab = await cua.createBrowserTab(browser.browserId, url)`.
The instance ID selects the browser. `browser.browserId` is the ID used to open tabs.
A raw instance ID passed to `createBrowserTab` failed in our live trial.
Read the page with `tab.getAXState()` or the documented `tab.playwright.domSnapshot()`.
Click observed links with the documented Playwright locators when native element actions are unavailable.
Use only methods in the returned documentation. Leave tabs in the background in the owner's profile.

Browser approvals go to the owner's prompt. Never accept them yourself or change an approval file.
A decline stops the task. The relay does not remember or preapprove browser requests.
Browser handles do not take native window leases. Separate sessions can act on the same
page. Flow rules use `browser` for every tab's source and destination; they cannot distinguish
sites, browsers or tabs. Literal typing, fills and navigation URLs are checked. Clipboard transfers,
runtime strings and other DOM actions have the existing flow-rule limits.
Document scope and saved-file change review apply to native apps, not tabs.

Finish the Claude turn so the mod sends `turn_ended`. Without the mod, idle or session cleanup does it.
Do not mark a probe tab as a deliverable or handoff. The measured extension removed its ordinary tab
at turn end. Close any probe tabs left open before releasing a live-check lock.

## Hover

Engine events go to the app, not through the real pointer, so they do not trigger hover. Most hover needs have a
background equivalent. Try these in order:

1. Tooltips: read them from the UI state, where an element's tooltip is its `Help:` field, e.g.
   `button Description: Delete, Help: Delete the last digit…`.
2. Hover-revealed menus and controls: look at the element's `Secondary Actions:` in the UI state
   (such as `ShowMenu`) and call `app.performSecondaryAction(index, "ShowMenu")`. A right-click,
   `app.click(index, { mouseButton: "right" })`, often opens the same menu.
3. Keyboard: many hover menus have a key equivalent (a menu bar item, a shortcut, Tab to focus then
   Space). Use `app.pressKey(...)`.
4. Only after those background options fail, use sleight's `hover` tool for that step. Tell the user
   first that it will move their pointer and bring the app forward for about N seconds, the dwell
   plus capture and restoration (about two seconds with the default dwell). Call it with
   `app` and `at: [x, y]`, relative to the selected window's top-left corner. Supply an exact
   `windowTitle` when the app has more than one on-screen window. Missing or duplicate title matches
   refuse before activation. It waits
   1500 ms by default (`waitMs`, 100 to 4000), takes a screenshot while hovered, and restores the
   pointer and the front app. The result reports `takeoverMs`. Tell the user that duration.
   Screen Recording permission is required before takeover. It refuses a point another app's window
   or a different window of the same app covers. Do not retry unchanged; inspect the window layout
   and choose an uncovered point in the intended window. Inspect the screenshot for the tooltip or menu,
   since the hover UI may disappear when the pointer goes back. If the user declines, stop.

## Moving text

`app.drag` can't move selected text: the engine's drag lasts about 14 ms and jumps straight to the end
point, and text views only move a selection after the mouse stays down for a moment. Drags that pick
something up at once, like Chess pieces, work fine with `app.drag`.

When the mouse has to stay down first, use sleight's `drag` tool: select the text with `js` first, then call
`drag` with the app, `windowId` from the window read, and window-relative `from` and `to` coordinates.
Without `windowId`, multiple possible windows refuse and return their IDs, titles and bounds.
Both endpoints must be in that window's visible content. TextEdit requires both inside the same
text area and a non-whitespace text selection. For a line-end drop, use the final visible glyph's
bounds plus a small right offset. Never use a zero-length end-of-line range, whose bounds may sit
above the text. It tries PID posting with a 500 ms hold, without activating the app or warping the
pointer. Product TextEdit trials passed 3/3 with the target inactive and the front app unchanged.
It falls back to foreground only when TextEdit text is unchanged, or the private window-local API
is unavailable before posting. Foreground takes the pointer briefly and restores it and the front
app. The result names `path` and `fallbackReason`. Changed or unreadable text never permits a second
drag. Other apps report unverified delivery: read the window to verify the move before continuing.
Prefer `app.drag` when that works. An AX tree above 300 elements or 12 levels refuses.
Cut and paste (`super+x`, click, `super+v`) is the fallback when the user declines. A word dropped at
the end of a line gets a space after a verified unique whole-word move. Check other selections for
spacing. If the tool reports that dragged text disappeared, press Cmd+Z in the window it identifies and
read it again before continuing. Never treat that error as a successful drop.

Copy/Cut use
native clipboard behavior by default, so copies are available to the user outside sleight.
`SLEIGHT_CLIPBOARD=preserve` keeps a private copy instead. The result explains which behavior ran.
In preservation mode use one clipboard action per js request with a literal shortcut key. Split a
stopped call and retry the actions separately. Menu Paste, `pbpaste` and browser pastes cannot use
that private copy. If the user needs a copy there, explain that they need a native session.
If the result says the clipboard was not preserved, the native shortcut already ran. Never clear,
replace or otherwise modify the user's clipboard to get around that fallback. Check the app result
before continuing. Use `app.paste(text)` to insert explicit text.

## Apps the engine refuses

The engine refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex, Atlas) before
any approval. sleight's `blocked_app` tool drives them through Accessibility instead, and the user's
approval of its prompt is the only opt-in. If a `js` result says the engine refused an app, tell the
user what you need and call `blocked_app` with `app` set the way you'd call `cua.getApp`; sleight
asks them. If the user declines, stop and tell them.

- `read` returns the app's main window as numbered elements and saves a window screenshot; view it
  with your Read tool. `click` presses an `element` (background), or a window-relative `point`, which
  brings the app to the front and puts your previous front app back. `type` sends `text`, `key`
  presses one key or chord ("Return", "super+v"), `scroll` moves `amount` lines, positive up.
- The user approves each app once per session, and the prompt says what that covers: for OpenAI's
  apps, the yes covers clicks on their approval buttons. In a terminal, every key or text that can
  run a command (any typing, Return, paste, most chords) is shown to the user first, every time.
  Never repeat a send the user declined in another form.
- A result that says a settings or preferences window was refused is final. Claude cannot change
  these apps' own approval or safety settings. Tell the user to change them by hand.
- Results name clicks on buttons like Approve, Allow, Run or Accept. The transcript then shows the
  click.

## Menu bar icons and notifications

The `js` tool can't reach an app's icon at the right end of the menu bar, or notification banners.
sleight's `menu_bar` and `notifications` tools can:

- `menu_bar` with op `apps` lists the apps that have an icon. `open` with `app` clicks it and returns
  its menu, which is closed again right after, or the window it opened. To pick a menu item, call
  `choose` with `path`, the titles from the top menu down, such as `["Debug", "Simulate 8%"]`. In a
  window, `press` an `element` number from `open`, then `close` when done.
- An element with empty text is an icon-only button. Its number still works with `press`, but say
  which one you guessed.
- `notifications` with op `list` returns the banners on screen with their button names, and `press`
  presses one, such as `Snooze 1 day`. Banners leave the screen after a few seconds, so list and press
  without delay.
- The user approves each app's icon, and notifications as a whole, once per session. If they don't,
  stop and tell them.

## Review saved changes

This applies only when the user has set `SLEIGHT_CHANGE_REVIEW=1`.
Before editing a document, use a standalone `let app = await cua.getApp("App")` call to identify its
Window and URL. sleight snapshots a `file://` document before the first possible edit. Save changes
before review. `review_changes` with `op: "list"` shows before/after diffs or size/date summaries.
With `op: "review"`, the user chooses Keep, Undo or Later for each document. Never supply a decision
yourself or restore the file through another tool. If undo succeeds, stop editing that app buffer
until the document has been reopened. A conflict means the file changed after the last agent action.
Tell the user and stop rather than overwriting it. Unsaved buffers and documents without files have
no snapshot. Same-app Open dialogs and sheets can proceed. If sleight first saw a file after an
action, read it again in a standalone call before editing. Review will show that undo starts at
the later copy.

## Document scope

When the user has set `SLEIGHT_APPROVAL_SCOPE=document`, approvals cover one window or document. Start
with a `js` call that only gets the app, then call `document_scope` so the user can approve that
document. If a result says document scope stopped, don't retry: read the intended window again and
ask with `document_scope`.

## Flow rules

If a result says a flow rule stopped a transfer, tell the user which rule matched and stop.
Use `flow_exception` with no arguments only to ask for one exception. After the user accepts,
retry the identical stopped call once. Never construct strings differently, use clipboard shortcuts,
switch tools or alter the rules file to get around a refusal. Another call cancels the exception.

## Saving to a path

In a save dialog, `app.pressKey("super+shift+g")` opens Go to Folder. Set the folder there and press
Return, then set the file name. A full path set into the name field with `app.setValue` doesn't move
the dialog anywhere. The slashes end up in the file name. Once the save dialog shows, the whole save
fits in one call, which saves several turns:

```js
await app.pressKey("super+shift+g"); await app.typeText("/path/to/folder"); await app.pressKey("Return");
await app.setValue({ id: "saveAsNameTextField" }, "name.txt"); await app.pressKey("Return");
```

In TextEdit and other apps with autosave, `super+shift+s` is Duplicate, not Save As. Use
`super+s` for an untitled document, or File > Save As from the menu.

Don't set a TextEdit document's text with `setValue`. Select and type instead. Saving or
duplicating right after `setValue` hung TextEdit 3/3 times (2026-10-05), and only quitting it
recovered.

## What it can't do

- Background hover beyond the workarounds above. Local `hover` takes the pointer briefly.
- Browser pages without a connected extension, unless `SLEIGHT_SURFACES` enables another backend.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder and share
the output.
