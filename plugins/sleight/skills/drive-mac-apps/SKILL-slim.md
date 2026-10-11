---
name: drive-mac-apps
disable-model-invocation: true
description: Use when a task needs a web page or native macOS app operated through its UI (clicking, typing, dragging, reading what is on screen) and no CLI, API or dedicated tool covers it. sleight drives the app in the background through the computer-use engine bundled with the ChatGPT desktop app, without moving the user's pointer.
---

# Driving Mac apps with sleight

`mcp__plugin_sleight_computer__js` runs JavaScript in a persistent session that holds the `cua` API,
and `js_reset` restarts it. The engine's docs and any app instructions it adds to a result come
first. This adds what sleight changes. UI automation is the slowest option: use a CLI, API or
dedicated tool when one covers the task.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`; only the user writes
it. If an app isn't approved, ask the user, or stop when a headless run refuses it.

## Calls

- `let app = await cua.getApp("<name or bundle ID>")` returns the app's UI state. When you already
  know the first actions, put them in the same call: sleight acquires the app, checks the window,
  then runs them. Keep the handle between calls, and `await` every action.
- Act by element number, or by `{ id }` or `{ label }`, which stays right when an earlier action in
  the call renumbers the window. Batch the actions you're sure of in one call.
- Each result shows what changed since the last full tree you saw. A full read is
  `await app.getAXState({ disableDiffing: true })`.
- An app that just launched can show an almost empty tree for a few seconds. Read it once more
  before you decide it has nothing.
- If a result says the user changed the app, or a header changed or disappeared after an action,
  read again before retrying. The user may be working in it.
- To choose among several windows, call `select_window` with the app and an exact `url` or `title`,
  then acquire the app in a call of its own and check its Window line.
- If a sleight note gives a screenshot multiplier, multiply each x and y by it before you tap.

## Text, menus and files

- For exact text, `await app.paste("text")`: typing goes through autocorrect and capitalization. To
  replace a whole document, select all and paste in one call, then read it back and compare.
- Use a menu item's shortcut when it has one. Otherwise open the menu and choose the item by label
  in the same call: `await app.click({ label: "Format" }); await app.click({ label: "Make Plain Text" })`.
  `menu_bar` is only for status icons at the right end of the menu bar.
- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- In a Save panel, send Go to Folder, the folder, Return, the name and the final Return in one call,
  such as `await app.pressKey("super+shift+g"); await app.typeText("<folder>"); await app.pressKey("Return"); await app.setValue({ id: "saveAsNameTextField" }, "<name>"); await app.pressKey("Return")`.
  A full path in the name field becomes a name with slashes. The result's title and URL confirm the
  save, without checking the file.
- If a list doesn't move when you scroll, use the app's search field or keyboard navigation instead.

## When to stop

- A sign-in, update, permission or first-run screen: stop and tell the user. Don't answer it.
- An approval the user declined, a lease another session holds (the refusal names it and the seconds
  left), or a refused settings window: stop and tell the user. Don't retry around it.
- The engine refuses terminals and OpenAI's apps (ChatGPT, Codex, Atlas). Use `blocked_app`, which
  asks the user: `read`, `click` (`element` or window-relative `point`), `type`, `key`, `scroll`. Every
  terminal send that could run a command is shown to the user first; never repeat a declined one in
  another form. If `--doctor` says the user turned that refusal off, those apps work through `js`.
  Never set or suggest that setting.

## Browsers

With a connected ChatGPT extension, start with `await cua.listBrowsers()` and read its docs. Several
Chromium browsers report as Chrome: pick one by `metadata.extensionInstanceId`, get it with
`cua.getBrowser({ extensionInstanceId })` in a call of its own, and open pages with
`cua.createBrowserTab(browser.browserId, url)`. Use only documented methods, leave tabs in the
background, and stop if the user declines a browser approval.

## sleight's other tools

- `app.drag` moves things that follow the pointer at once. Moving selected text needs the button
  held first: select it in `js`, then call `drag` with `app`, `windowId`, and `from` and `to` from the
  latest screenshot of that window, both inside its visible content. If it reports lost text, press
  Cmd+Z in that window and read it.
- Engine events don't trigger hover. Use `Help:` fields, `Secondary Actions:`, a right-click
  or a key first. Only then `hover` with `app` and `at`, after telling the user it moves their pointer
  and brings the app forward for about two seconds.
- `notifications` lists banners on screen and presses their buttons. Banners leave in seconds, so act
  at once. `menu_bar` reaches status icons. The user approves each once per session.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
