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

## How to use it

1. Make the first `js` call exactly one API call, such as `let app = await cua.getApp("Calculator")`.
   Its result contains the full API documentation and the app's current UI state. Read both before acting.
   When two copies of an app share a bundle ID (an installed app and a dev build), `getApp` with the ID
   fails as ambiguous. Pass the full path to the `.app` instead.
2. Act by element index from the UI state (`app.click(12)`) when you can, and by coordinates only when an
   element has no index. Batch several actions in one call when you're sure of them.
3. The first time you touch an app, the user gets an approval prompt. If the result says the app was not
   approved, stop and tell the user. Don't retry around it.
4. If a result says the user changed the app, re-read its state before acting again. The person may be
   using it.
5. Use `app.getScreenshot()` with `nodeRepl.emitImage(...)` when the accessibility tree doesn't show what
   you need, such as canvases or images.

## Hover: what to do instead

Events go to the app, not through the real pointer, so nothing ever hovers. Most hover needs have a
background equivalent. Try these in order:

1. Tooltips: read them from the UI state, where an element's tooltip is its `Help:` field, e.g.
   `button Description: Delete, Help: Delete the last digit…`.
2. Hover-revealed menus and controls: look at the element's `Secondary Actions:` in the UI state
   (such as `ShowMenu`) and call `app.performSecondaryAction(index, "ShowMenu")`. A right-click,
   `app.click(index, { mouseButton: "right" })`, often opens the same menu.
3. Keyboard: many hover menus have a key equivalent (a menu bar item, a shortcut, Tab to focus then
   Space). Use `app.pressKey(...)`.
4. UI that only reacts to the pointer (a canvas that reacts to the pointer, a preview that only shows on hover):
   use a pointer-moving computer-use tool if one is available, for that step only, and tell the user
   first that it will take over their screen.

## Moving text

`app.drag` can't move selected text: the engine's drag lasts about 14 ms and jumps straight to the end
point, and text views only move a selection after the mouse stays down for a moment. Drags that pick
something up at once, like Chess pieces, work fine with `app.drag`.

When the mouse has to stay down first, use sleight's `drag` tool: select the text with `js` first, then call
`drag` with the app and the same `from` and `to` coordinates you'd give `app.drag`. It brings the app
to the front and moves the user's pointer for about two seconds, so prefer `app.drag` when that works.
Cut and paste (`super+x`, click, `super+v`) is the fallback when the user declines. A word dropped at
the end of a line lands without a space before it, so check the result and fix the spacing if needed.

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

## Saving to a path

In a save dialog, `app.pressKey("super+shift+g")` opens Go to Folder. Set the folder there and press
Return, then set the file name. A full path set into the name field with `app.setValue` doesn't move
the dialog anywhere. The slashes end up in the file name.

## What it can't do

- Real pointer hover, beyond the workarounds above.
- Web pages. sleight's Chrome control is off by default, so use browser tools.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder and share
the output.
