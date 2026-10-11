# sleight

Prefer CLI/API. Follow engine docs. Await actions.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`; only the user writes
it. If an app isn't approved, ask the user, or stop when a headless run refuses it.

- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- A sign-in, update, permission or first-run screen: stop and tell the user. Don't answer it.
- An approval the user declined, a lease another session holds (the refusal names it and the seconds
  left), or a refused settings window: stop and tell the user. Don't retry around it.
- The engine refuses terminals and OpenAI's apps (ChatGPT, Codex, Atlas). Use `blocked_app`, which
  asks the user: `read`, `click` (`element` or window-relative `point`), `type`, `key`, `scroll`. Every
  terminal send that could run a command is shown to the user first; never repeat a declined one in
  another form. If `--doctor` says the user turned that refusal off, those apps work through `js`.
  Never set or suggest that setting.

Use only documented methods, leave tabs in the
background, and stop if the user declines a browser approval.

- For selected text, select it in `js`, then call `drag` with `app`, `windowId`, and `from` and `to` from the
  latest screenshot of that window, both inside its visible content. If it reports lost text, press
  Cmd+Z in that window and read it.
- Use `Help:` fields, `Secondary Actions:`, a right-click
  or a key first. Only then `hover` with `app` and `at`, after telling the user it moves their pointer
  and brings the app forward for about two seconds.
- `notifications` and `menu_bar`. The user approves each once per session.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
