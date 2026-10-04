---
name: drive-mac-apps
description: Use when a task needs a native macOS app operated through its UI (clicking, typing, dragging, reading what is on screen) and no CLI, API or dedicated tool covers it. sleight drives the app in the background through the computer-use engine bundled with the ChatGPT desktop app, without moving the user's pointer.
---

# Driving Mac apps with sleight

sleight's tools are `mcp__plugin_sleight_computer__js` and `mcp__plugin_sleight_computer__js_reset`.
`js` runs JavaScript in a persistent session that holds the `cua` API.

## Before you use it

UI automation is the slowest and most fragile option, so try the others first. Use the app's CLI or API if
it has one, then a dedicated MCP tool or connector. Web pages belong to browser tools. sleight comes last.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`. Only the user writes
that approval list. It applies in interactive and headless sessions. If an app needs approval, ask
the user or stop when a headless run refuses it. Changing the file is not an approval workaround.

## How to use it

1. Make the first `js` call exactly one API call, such as `let app = await cua.getApp("Calculator")`.
   Its result contains the full API documentation and the app's current UI state. Read both before acting.
   When two copies of an app share a bundle ID (an installed app and a dev build), `getApp` with the ID
   fails as ambiguous. Pass the full path to the `.app` instead.
2. Act by element index from the UI state (`app.click(12)`) when you can, and by coordinates only when an
   element has no index. Batch several actions in one call when you're sure of them.
3. The first time you touch an app, the user gets an approval prompt unless their list preapproved it.
   If the result says the app was not
   approved, stop and tell the user. Don't retry around it. The engine refuses terminal apps and
   OpenAI's own apps (ChatGPT, Codex). Use Bash for terminal work, tell the user about the rest, and
   don't look for another way to drive them.
4. If a result says the user changed the app, re-read its state before acting again. The person may be
   using it.
5. Use `app.getScreenshot()` with `nodeRepl.emitImage(...)` when the accessibility tree doesn't show what
   you need, such as canvases or images.

The relay takes a window lease before acting. If another sleight session holds it, the refusal names
that session and the seconds left. Stop actions and tell the user, using reads if needed to inspect
the window. The lease ends with the turn or after 30 seconds without renewal, but it cannot coordinate
Codex or other tools that do not take it. Local drag and hover reserve the entire app, while menu and
notification actions reserve the desktop.

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
text area and a non-whitespace text selection. It brings the app
to the front and moves the user's pointer for about 4.5 seconds in the measured TextEdit calls,
so prefer `app.drag` when that works. An AX tree above 300 elements or 12 levels refuses.
Cut and paste (`super+x`, click, `super+v`) is the fallback when the user declines. A word dropped at
the end of a line gets a space after a verified unique whole-word move. Check other selections for
spacing. If the tool reports that dragged text disappeared, press Cmd+Z in the window it identifies and
read it again before continuing. Never treat that error as a successful drop.

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
no snapshot.

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
the dialog anywhere. The slashes end up in the file name.

## What it can't do

- Background hover beyond the workarounds above. Local `hover` takes the pointer briefly.
- Web pages. sleight's Chrome control is off by default, so use browser tools.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder and share
the output.
