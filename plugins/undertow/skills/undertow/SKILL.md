---
name: undertow
description: Use when a task needs a native macOS app operated through its UI (clicking, typing, dragging, reading what is on screen) and no CLI, API or dedicated tool covers it. undertow drives the app in the background through the computer-use engine bundled with the ChatGPT desktop app, without moving the user's pointer.
---

# Driving Mac apps with undertow

undertow's tools are `mcp__plugin_undertow_computer__js` and `mcp__plugin_undertow_computer__js_reset`.
`js` runs JavaScript in a persistent session that holds the `cua` API.

## Before you reach for it

Prefer, in order: a CLI or API for the app, a dedicated MCP tool or connector, browser tools for web pages,
then undertow. UI automation is the slowest and most fragile option.

## How to use it

1. Make the first `js` call exactly one API call, such as `let app = await cua.getApp("Calculator")`.
   Its result carries the full API documentation and the app's current UI state. Read both before acting.
2. Act by element index from the UI state (`app.click(12)`) when you can, and by coordinates only when an
   element has no index. Batch several actions in one call when you're sure of them.
3. The first time you touch an app, the user gets an approval prompt. If the result says the app was not
   approved, stop and tell the user. Don't retry around it.
4. If a result says the user changed the app, re-read its state before acting again. The person may be
   using it.
5. Use `app.getScreenshot()` with `nodeRepl.emitImage(...)` when the accessibility tree doesn't show what
   you need, such as canvases or images.

## What it can't do

- **Hover.** Events go to the app, not through the real pointer, so tooltips and hover menus never appear.
  For those, use a pointer-moving computer-use tool if one is available, and tell the user it will take
  over their screen.
- **Web pages.** The browser surface is off by default; use browser tools.

If `js` fails to start, ask the user to run `bin/undertow-mcp --doctor` from the plugin folder and share
the output.
