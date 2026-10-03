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

## What it can't do

- Real pointer hover, beyond the workarounds above.
- Web pages. sleight's Chrome control is off by default, so use browser tools.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder and share
the output.
