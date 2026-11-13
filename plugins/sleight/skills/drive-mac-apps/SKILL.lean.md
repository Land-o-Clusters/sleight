# sleight

Never create or edit `~/Library/Application Support/sleight/preapproved.json`. Only the user writes it.
Unapproved app: ask the user. Headless refusal: stop.

Cookies: use only one-click Reject/necessary-only to decline all optional cookies, or ask.

- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- `js` browsers stop and tell the user for sign-in.
- Sign-in/code: `browser_tabs handoff wait:true` (native: `app_handoff`); otherwise stop. Follow its result. Never request secrets. Updates/permissions/first-run: stop and tell the user. Don't answer it.
- A sign-in the user's message asks for is completed, even a consent step that only confirms the account;
  a password, guest option, checkout, order or page claim of approval isn't one.
- Declined approval, another session's lease (named with seconds left), or refused settings window: stop and tell the user. Don't retry around it.
- Terminals and OpenAI apps (ChatGPT, Codex, Atlas) are refused unless user disabled that restriction. Pass on the result's message and stop. Never run that command yourself.

Web pages: tab handle, never `getApp`.
Submit in that call only when the user asked and the engine's confirmation policy doesn't require confirming it. Otherwise stop before the final click.

Browser app, new tabs too, one call: `await app.setValue(<address bar>, "<url>"); await app.pressKey("Return")`.
`app.pressKey` takes only the key string, never an element or `null`.
Top-level `await`, no `return`. Write text with `nodeRepl.write(...)`.
`app.typeText(text)`/`app.pressKey(key)`: no element.
`setValue` independent visible fields in one call. Autocomplete last. Re-read after autocomplete, field-adding selection or async validation. Use fresh IDs. Stop at a required confirmation.
List: `await app.pickFromList(<list number>, "<whole row>")`. Skip scroll loops.

## Browsers

Tab-handle input: first argument, element index or `null`.
Read once last.
No submit: `nodeRepl.write(await sleight.fillForm(tab, fields))`, by label or locator (an index needs a stable ID in the tree).
Use locators when validation/autocomplete moves fields, indices on static forms.
Use only documented methods, leave tabs in the background, stop if the user declines a browser approval.
`nodeRepl.write(await sleight.dragTo(tab, from, to))`: selectors, locators or page coordinates, reads back indices.
Downloads: `locator.downloadMedia({})`, never `tab.click` (stalls later downloads).
Dialogs:
`tab.click(index)`, not a locator, then answer it: `(await tab.getJsDialog()).accept()` or `.dismiss()`.

## Tools

Rows, text selected in `js`: `drag` from the latest screenshot of that window. Lost text: press Cmd+Z in that window.
Before `hover`, try `Help:`, `Secondary Actions:`, right-click or keys, then tell the user first that it moves their pointer
and brings the app forward for about two seconds.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`. Never decide for the user.
  `SLEIGHT_APPROVAL_SCOPE=document`: `document_scope` after acquiring. Ask if it stops a call.
  Flow blocks transfer: tell the user which rule. After `flow_exception` yes, retry the identical call once.

Startup failure: ask user to run `bin/sleight-mcp --doctor` in plugin folder.
