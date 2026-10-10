---
name: drive-mac-apps
disable-model-invocation: true
description: Use when a task needs a web page or native macOS app operated through its UI (clicking, typing, dragging, reading what is on screen) and no CLI, API or dedicated tool covers it. sleight drives the app in the background through the computer-use engine bundled with the ChatGPT desktop app, without moving the user's pointer.
---

# Driving Mac apps with sleight

`mcp__plugin_sleight_computer__js` runs JavaScript in a persistent session that holds the `cua` API, and
`js_reset` restarts it. UI automation is the slowest option: use an app's CLI, API or a dedicated
tool first. For a public web page, a built-in browser tool is usually faster.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`; only the user writes
it. If an app needs approval, ask the user, or stop when a headless run refuses it.

## Calls

- `let app = await cua.getApp("TextEdit")` returns the app's UI state (and, on the first call, the
  API docs). When you know the first actions without seeing the UI, put them in the same call:
  `let app = await cua.getApp("TextEdit"); await app.pressKey("super+n")`. sleight acquires first,
  checks the window, then runs the rest. Keep the same handle between actions.
- If `getApp` with a bundle ID is ambiguous (two copies), pass the `.app` path. To find a name:
  `(await cua.listApps()).map(a => a.id + " " + a.displayName).join("\n")`.
- Act by element number (`await app.click(12)`), or by ID or label (`{ id: "Seven" }`,
  `{ label: "Multiply" }`), which stays right when an earlier action in the call renumbers the
  window. Coordinates only for elements without one. Batch actions you're sure of in one call, and
  `await` every action: an un-awaited failure can end the session and every handle.
- Each result shows what changed since the last full tree you saw of that window. A full read is
  `await app.getAXState({ disableDiffing: true })`. Use `await app.getScreenshot()` for canvases and
  images. It shows the picture itself. Don't sleep before a read, which waits on its own.
- To choose among several windows, call `select_window` with `app` and an exact file `url` (or
  `title`), then acquire the app in a call of its own and check its Window and URL.
- If a result says the user changed the app, read it again. They may be using it. A changed or
  missing header after an action means "outcome unconfirmed": read before retrying.

## Text, menus and saving

- For exact text in a Mac app, use `await app.paste("text")`. `typeText` goes through macOS
  auto-capitalization: TextEdit saved "sleight is here. it works" as "Sleight is here. It works".
  Use one `typeText` instead of a `pressKey` per character when exact case doesn't matter, and in
  the iOS simulator, where paste can insert the Mac's clipboard instead.
- For an exact whole-document replacement in a Mac app (excluding the iOS simulator), select all
  then `app.paste("text")` in one call. Read the same document and compare its text before saving.
  If the read is incomplete or differs, stop and read again. A select-all shortcut alone doesn't
  confirm replacement.
- Don't set a TextEdit document's text with `setValue`. Saving right after it hung TextEdit 3/3 times.
- Use an app's menus by their shortcut (`super+shift+t` is TextEdit's Make Plain Text), or click
  the menu and its item in one call. `menu_bar` is only for icons at the right end of the menu bar.
- Save to a path in one call once the save dialog shows, including the final Return:

  ```js
  await app.pressKey("super+shift+g"); await app.typeText("/path/to/folder"); await app.pressKey("Return");
  await app.setValue({ id: "saveAsNameTextField" }, "name.txt"); await app.pressKey("Return");
  ```

  The result's window title and URL name the saved file. That is the confirmation: don't run `ls`
  or `cat` on it afterwards. A full path
  in the name field becomes a file name with slashes. In TextEdit, `super+shift+s` is Duplicate:
  use `super+s` for an untitled document.

## Approvals and refused apps

The user gets an approval prompt the first time you touch an app, unless their list pre-approved it. If a result says the app
wasn't approved, stop and tell the user. Don't retry around it.

The engine refuses terminals and OpenAI's apps (ChatGPT, Codex, Atlas). Tell the user what you need
and use `blocked_app`, which asks them: `read` returns numbered elements and a screenshot path,
`click` takes an `element` or a window-relative `point`, `type` sends `text`, `key` a key or chord,
`scroll` an `amount`. Every terminal send that could run a command is shown to the user first; never
repeat a declined send in another form. A refused settings window is final. If `--doctor` says the
user turned the engine's refusal off, those apps work through `js`. Never set or suggest that setting.

## Leases

sleight leases the window before acting. If another session holds it, the refusal names it and the
seconds left: stop and tell the user. Leases don't coordinate with Codex or tools that don't take them.

## Browser pages

With a connected ChatGPT extension, start with `await cua.listBrowsers()` and read its docs. Several
Chromium browsers report as Chrome, Helium among them: match `metadata.extensionInstanceId`, then
`let browser = await cua.getBrowser({ extensionInstanceId: "…" })` in a call of its own, and open
pages with `await cua.createBrowserTab(browser.browserId, url)`. Read with `tab.getAXState()` or
`tab.playwright.domSnapshot()`, and use only documented methods. Leave tabs in the background.
Browser approvals are the user's, and a decline stops the task. Close probe tabs before releasing a
live-check lock.

## Drags and hover

- `app.drag` works for things that move at once, like Chess pieces. Chess's tree names each square
  but doesn't give its position, so take squares from a screenshot. If a drag moved nothing, press
  another visible part of the piece. Repeating the same point, or switching to sleight's `drag`,
  misses the same way.
- Selected text needs the mouse held first: select it with `js`, then call sleight's `drag` with
  `app`, `windowId`, and `from` and `to` read off the latest engine screenshot of that window (sleight
  converts its pixels to points), both inside the window's visible content
  (in TextEdit, the same text area, a non-blank selection). For a line end, use the last glyph's
  bounds plus a small offset. If it reports the text disappeared, press Cmd+Z in that window and
  read it. If the user declines, cut and paste instead.
- Engine events don't trigger hover. Read tooltips from `Help:` fields, use `Secondary Actions:`
  (`performSecondaryAction(i, "ShowMenu")`), a right-click or a key equivalent. Only then use
  sleight's `hover` with `app` and `at: [x, y]`: tell the user first that it moves their pointer and
  brings the app forward for about two seconds. It refuses covered points.

## Clipboard, notifications and opt-ins

- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve`; then use one clipboard
  shortcut per call. Never clear or replace the user's clipboard to work around a refusal.
- `notifications` `list` shows banners on screen and `press` presses a button. Banners leave after a
  few seconds, so act at once. `menu_bar` `apps`, `open`, `choose` (a `path` of titles) and `press`
  reach menu bar icons. The user approves each icon, and notifications, once per session.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire the app in a call of its own before editing a document, save
  before `review_changes`, and never decide for the user or restore the file another way.
- `SLEIGHT_APPROVAL_SCOPE=document`: acquire, then call `document_scope` for the user's approval.
  If document scope stops a call, read the window again and ask. Don't retry.
- If a flow rule stops a transfer, tell the user which rule. `flow_exception` asks for one exception;
  after a yes, retry the identical call once. Never rebuild the data another way.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
