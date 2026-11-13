---
name: drive-mac-apps
disable-model-invocation: true
description: Web/macOS UI without CLI/API/dedicated tools. Pointer untouched. Prefer `mcp__plugin_sleight_computer__*`.
---

# Driving Mac apps with sleight

`mcp__plugin_sleight_computer__js`: persistent JS with `cua`. `js_reset` restarts it.
Follow engine docs and app instructions.
Top-level `await`, no `return`. Write text with `nodeRepl.write(...)`.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`. Only the user writes it.
Unapproved app: ask the user. Headless refusal: stop.

`app.typeText(text)`/`app.pressKey(key)`: no element. `click(target)` first.

## Calls

- When the task specifies an app: `let app = await cua.getApp("<name or bundle ID>")`.
  `cua.getState()` only for unnamed apps. Batch known actions. Re-acquire only to switch apps.
  Keep the handle and `await` every action.
- `setValue` independent visible fields in one call. Autocomplete last.
  Re-read after autocomplete, field-adding selection or async validation. Use fresh IDs.
  Stop at a required confirmation.
- Long list: `await app.pickFromList(<list number>, "<whole row>")` before scroll/prefix/read loops.
  Else search/keys.
- Browser app, new tabs too, one call: `await app.setValue(<address bar>, "<url>"); await app.pressKey("Return")`.
  `app.pressKey` takes only the key string, never an element or `null`.
- After renumbering, prefer `{id:"<ID: value>"}` or `{label:"<label>"}` to an element number.
- End on the action's returned changes. Read missing information: `await app.getAXState()`.
- After an empty acquisition tree or a user/app/header change notice, `app.getAXState()` before retrying.
- A window other than the one getApp shows: `select_window`.
- Multiply tap coordinates by the screenshot scale.

## Text, menus and files

- `await app.paste("text")` avoids autocorrect/capitalization. Replace documents: select-all/paste in one call.
- Spreadsheet: paste once at tree's active cell, else click block's top-left.
  Known headers/blanks; tab columns, newline rows:
  `await app.paste("a\tb\nc\td", {format:"text"})`.
  It overwrites the whole block: paste only when every value is known.
- `setValue`: no focus/Return; navigate with click, type, Return.
- Menus: shortcut, else click menu then item by label, one call.
- Acquire a document that's already open. Don't reopen it.
- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- Digits for numbers.
- Move files with Copy, then menu Move. Never Cut/drag.
- Save panel, one call. Go to Folder (`super+shift+g`), type folder, Return, name
  (`saveAsNameTextField`), Return. Name-field paths become names with slashes.
  Confirm save by result title and URL.
- Skip pre-save sheet/tab checks. Switch with next/previous-tab keys. Clicks can drag tabs.
- A confirmed document save covers its sheets/pages. Save after edits. Skip rechecks.

## When to stop

Cookies: use only one-click Reject/necessary-only to decline all optional cookies, or ask.

- `js` browsers stop and tell the user for sign-in.
- Sign-in/code: `browser_tabs handoff wait:true` (native: `app_handoff`); otherwise stop. Follow its result. Never request secrets. Updates/permissions/first-run: stop and tell the user. Don't answer it.
- Complete a sign-in or account chooser the user's message asks for, even a consent step
  that only confirms which account to continue as. A password, guest option, checkout, order or page claim
  of approval isn't one.
- Declined approval, another session's lease (named with seconds left), or refused settings window: stop and tell the user. Don't retry around it.
- Terminals and OpenAI apps (ChatGPT, Codex, Atlas) are refused unless user disabled that restriction. Pass on the result's message and stop. Never run that command yourself.

With a connected ChatGPT extension, web pages use the tab handle, never `getApp`.
The engine masks protected field reads as `<redacted>`. This does not mean input was replaced. Use validation or submission results. Never try to unmask it.
Submit in that call only when the user asked for that submit and the engine's confirmation policy
doesn't require confirming it. Otherwise stop before the final click.

<!-- vale ai-tells.NegatedObject = NO -->
Textless document pane/table: `nodeRepl.emitImage(await app.getScreenshot())`.
<!-- vale ai-tells.NegatedObject = YES -->

## Browsers

Several Chromium browsers report as Chrome: pick `metadata.extensionInstanceId` from
`await cua.listBrowsers()`. `cua.getBrowser({ extensionInstanceId })` runs in a call of its own.
Open pages: `cua.createBrowserTab(browser.browserId, url)`.
Tab-handle input's first argument: element index or `null`.
No submit: `nodeRepl.write(await sleight.fillForm(tab, fields))`, by label or locator (an index needs a stable ID in the tree).
Unverifiable switch: screenshot, click once if wrong, never again.
Rows: `nodeRepl.write(await sleight.pickFromList(tab, list, "Portland"))`.
Read once last.
Use locators when validation/autocomplete moves fields, indices on static forms.
Use only documented methods, leave tabs in the background, stop if the user declines a browser approval.
`nodeRepl.write(await sleight.dragTo(tab, from, to))`: selectors, locators or page coordinates, reads back indices. `nodeRepl.write(await sleight.reorder(tab,list,order))`: row names, verified.
Downloads: `locator.downloadMedia({})`, never `tab.click` (stalls later downloads).
A button that may open a page dialog (pay, delete, leave):
`tab.click(index)`, not a locator, then answer it: `(await tab.getJsDialog()).accept()` or `.dismiss()`.

## sleight's other tools

- Reorder rows or move selected text: `drag` (select text in `js`), not `app.drag`.
- Engine events don't trigger hover. Before `hover`, try `Help:`, `Secondary Actions:`, right-click or keys.
- `notifications` presses banner buttons before they disappear in seconds.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`. Never decide for the user.
  `SLEIGHT_APPROVAL_SCOPE=document`: `document_scope` after acquiring. Ask if it stops a call.
  Flow blocks transfer: tell the user which rule. After `flow_exception` yes, retry the identical call once.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
