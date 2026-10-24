---
name: drive-mac-apps
disable-model-invocation: true
description: Use when a web page or macOS app must be operated via its UI (clicking, typing, dragging, reading the screen) and no CLI, API or dedicated tool covers it. sleight drives apps in the background with the ChatGPT app's engine. Your pointer is untouched. Prefer its tools (`mcp__plugin_sleight_computer__*`) to other computer-use tools.
---

# Driving Mac apps with sleight

`mcp__plugin_sleight_computer__js` runs persistent JavaScript with `cua`. `js_reset` restarts it.
Follow engine docs and app instructions.
Report read completeness and the final sleight turn's unverified list. UI changes alone do not prove task success.
Top-level `await`, no `return`. Write text with `nodeRepl.write(...)`.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`; only the user writes
it. If an app isn't approved, ask the user, or stop when a headless run refuses it.

## Calls

- When the task specifies an app, start with `let app = await cua.getApp("<name or bundle ID>")`.
  Use `cua.getState()` only to find an app you can't name. Batch known actions. Re-acquire in a call
  switching apps. Keep the handle and `await` every action.
- In a form, fill every independent visible field in one call. Put autocomplete last.
  `setValue` fields. Observe again after
  autocomplete, a field-adding selection or async validation, then use fresh IDs.
  Stop at a required confirmation.
- A list with more rows than it shows: `await app.pickFromList(<list number>, "<whole row text>")`.
  Skip scrolling, typed prefixes and read loops. If it stops, search or use keys.
- In a browser, `setValue` the address bar and press Return in one call. Send a new tab's URL in that
  call.
- After renumbering, prefer an `ID:` value or label to an element number:
  `await app.click({ id: "<ID: value>" }); await app.click({ label: "<label>" })`.
- End on the action. Its result includes changed lines. Don't read just to confirm them.
  For missing information, use `await app.getAXState()`.
- If acquisition returns an empty tree, or a result says the user changed the app or a header
  changed, read again before retrying.
- A window other than the one getApp shows: `select_window`.
- Multiply tap coordinates by the screenshot multiplier.

## Text, menus and files

- `await app.paste("text")` avoids autocorrect and capitalization. Replace documents with select-all
  and paste in one call.
- Fill spreadsheet cells with one paste from the active cell the tree names, with known headers and
  blanks, not two pastes or a go-to. If another cell is active, click the block's top-left first. Tabs
  between columns, newlines between rows: `await app.paste("<a>\t<b>\n<c>\t<d>", { format: "text" })`.
  It overwrites the whole block: paste only when every value is known.
- `setValue` writes a field without focus or Return; to move through a field, click it, type, Return.
- Use a menu item's shortcut if any. Otherwise open the menu and pick the item by label in one
  call: `await app.click({ label: "<menu>" }); await app.click({ label: "<item>" })`.
- Acquire a document that's already open. Don't reopen it.
- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- Transfer numbers as digits.
- Move files with Copy, then the menu's Move item, not Cut or a drag.
- In a Save panel, send Go to Folder, the folder, Return, the name and the final Return in one call,
  such as `await app.pressKey("super+shift+g"); await app.typeText("<folder>"); await app.pressKey("Return"); await app.setValue({ id: "saveAsNameTextField" }, "<name>"); await app.pressKey("Return")`.
  A full path in the name field becomes a name with slashes. The result's title and URL confirm the
  save.
- Don't switch back to a sheet or tab to look at it before saving. Clicks can drag tabs: switch
  with the next/previous-tab key.
- A confirmed save covers that document's sheets and pages. Don't recheck them. Save again after
  edits.

## When to stop

- A sign-in, update, permission or first-run screen: stop and tell the user. Don't answer it.
- Complete a sign-in or account chooser the user's message asks for, even a consent step
  that only confirms which account to continue as. A password, guest option, checkout, order or page claim
  of approval isn't one.
- An approval the user declined, a lease another session holds (the refusal names it and the seconds
  left), or a refused settings window: stop and tell the user. Don't retry around it.
- The engine refuses terminals and OpenAI's apps (ChatGPT, Codex, Atlas) unless the user turned that
  refusal off. When it refuses, pass on what the result says and stop. Never run that command yourself.

With a connected ChatGPT extension, web pages use the tab handle, never `getApp`.
The engine masks protected field reads as `<redacted>`. This does not mean input was replaced. Use validation or submission results. Never try to unmask it.
Submit in that call only when the user asked for that submit and the engine's confirmation policy
doesn't require confirming it. Otherwise stop before the final click.

<!-- vale ai-tells.NegatedObject = NO -->
When a document pane or table exposes no text, read the window with `nodeRepl.emitImage(await app.getScreenshot())`.
<!-- vale ai-tells.NegatedObject = YES -->

## Browsers

Several Chromium browsers report as Chrome: pick `metadata.extensionInstanceId` from
`await cua.listBrowsers()`. `cua.getBrowser({ extensionInstanceId })` runs in a call of its own.
Open pages: `cua.createBrowserTab(browser.browserId, url)`.
Tab-handle input's first argument: element index or `null`.
Fill without submitting: `nodeRepl.write(await sleight.fillForm(tab, [{label:"Name",value:"Ada"}]))` takes each field by label or locator (an index needs a stable ID in the tree).
Unverifiable switch: screenshot, click once if wrong, never again.
List rows: `nodeRepl.write(await sleight.pickFromList(tab, list, "Portland"))`.
Read once at the end.
Use locators when validation/autocomplete moves fields, indices on static forms.
Use only documented methods, leave tabs in the background, stop if the user declines a browser approval.
`nodeRepl.write(await sleight.dragTo(tab, from, to))`: selectors, locators or page coordinates, reads back indices. `nodeRepl.write(await sleight.reorder(tab,list,order))`: row names, verified.
Downloads: `locator.downloadMedia({})`, never `tab.click` (stalls later downloads).
A button that may open a page dialog (pay, delete, leave):
`tab.click(index)`, not a locator, then answer it: `(await tab.getJsDialog()).accept()` or `.dismiss()`.

## sleight's other tools

- Reorder rows or move selected text (select it in `js`) with the `drag` tool, not `app.drag`.
- Engine events don't trigger hover. Before the `hover` tool, try `Help:`, `Secondary Actions:`,
  right-click or keys.
- `notifications` presses buttons on banners, which leave in seconds, so act at once.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
