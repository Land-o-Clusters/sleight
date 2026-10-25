# Settings

You don't need any of these. They change approvals, guards, receipts, review or experimental behavior.

## Front app after launch

Front restoration is on by default. Set `SLEIGHT_FRONT_RESTORE=0` to turn it off for an A/B.
When a literal `cua.getApp(...)` acquisition launches an app and it takes the front, sleight gives
the front back to the user's earlier app once, if that process is still running. It leaves the
pointer alone. A focus change before dispatch, a click during the call, a different front app
afterward or a failed call cancels restoration. Typing during the launch doesn't, since that typing is
what the restore protects. The result and trace say when restoration happened.

## Receipts and unsaved review

Set `SLEIGHT_RECEIPTS=1` to write a private JSON receipt after each used turn to
`~/Library/Logs/sleight/receipts/`. The pane shows the latest receipt's path. It lists the observed app
and window, recognized actions and targets, the call's outcome and changes in the returned reads.
Typed and pasted text and literal values become length markers. Raw code, accessibility trees,
screenshots and error text stay out of the file. A computed input has an unknown length.

Receipts are off by default. Window titles become length markers by default; the app name and
a document's file name from its `file://` URL remain, with the account's username and full name scrubbed.
`SLEIGHT_RECEIPT_REDACT_TITLES=0` keeps scrubbed titles, which can contain other private data.
Single printable keys become length markers too. Named keys and shortcuts with modifiers remain.
Each write prunes writer-owned receipt files to seven days or 200 files, whichever is fewer.
The directory is private to your account (0700), and each
file is readable and writable only by you (0600).

Set `SLEIGHT_STATE_REVIEW=1` to show changed or modified windows at turn end. This is off by
default and independent of saved-file change review. It uses reads the relay already received.
You can leave the window as it is, or use a native Undo or Revert To Saved control when one was
observed. The review tells you which control was available. You use it in the app yourself.
Missing reads, failed or overlapping calls, and turns over 2,000 calls report uncertainty.
An accessibility change doesn't prove that a file is saved or unsaved. See the
[design and limits](design/review-receipts.md).

## Action outcomes and the action log

Set `SLEIGHT_OUTCOMES=1` to add one line per native action to each result, such as
`1 click 12: sheet "Save" opened` or `3 pressKey "Return": no visible change`. sleight compares its
own read before the action with its read after it. It looks only at the window, its sheets and menus,
focus, and the acted-on control's role, name and value line. A name shows only when it's a generic
control word such as Save, Cancel or OK. Any other name or window title shows as its length, as in
receipts. Typed text never appears, and neither does a text area's value. An action on a secure field
says `ran, unverified`. Actions with no read between them share one line. It's off by default until
its A/B.

Set `SLEIGHT_ACTION_LOG` to a file name, or to a path under `~/Library/Logs/sleight/`, to append one
JSON line per action to that file in that folder. Any other path is ignored. A line has these fields
and no others:

- `time`, `call` (the call's id), `tool`, and `app` for a native app or `origin` (scheme and host) for a browser.
- `kind`: the action, such as `click`, `typeText` or `pressKey`, or the tool and its operation.
- `target`: the control's `role`, its `name` only when it's one of those generic control words,
  `secure: true` for a password field, or a browser element's `ref`.
- `chars`: the length of typed, pasted or set text, only for a plain text field whose line names
  nothing like a password, card, account, government or tax ID, bank code, PIN, expiry or birth date,
  in English or a common other language. When in doubt it's left out.
- `key`: a named key such as Return or Tab, or a shortcut with Command or Control. Other keys stay out.
- `result`: `ok`, `refused`, `failed`, `not run` or `not logged`, with an `outcome` in structure words
  such as `sheet opened` or `no visible change`, or a `reason` category such as `window changed` or
  `input lease`.
- `count`, on a `rest` line: actions that didn't run, or that ran past one call's 30-record cap.
- `ms`: milliseconds from when sleight sent the call on to the engine or turbo (from its request, for
  sleight's own tools) to its reply, less the approval prompts open meanwhile. Every line of the call has it.
- `pid`: the relay's process id, which tells sessions sharing one log apart.
- `saved`, on a call's first line: reads Claude's code asked for that went out as changed lines or not at
  all, and turbo's diffs. The guard's own read after an action never counts. A read-only call that saved
  reads gets one `read` line for this.
- `surface: "browser"` and `actions`, on the one `call` line for the engine's browser path: the guard
  doesn't record actions there, so `actions` counts the input calls the code names, such as `click(` or `fill(`.
  That's an estimate: a call in a loop counts once, and one in a branch that didn't run still counts.

Typed text, set values, a secure field's value or length, window and sheet titles, page text and
screenshots stay out. The file is private to your account: sleight writes only a regular file with
one link and mode 0600, in a folder that only your account can write. It rotates at 5 MB, keeping two
old files. Claude's code can change what the guard records. The log is an audit aid and can't prove
what happened. The `env` block of
`~/.claude/settings.json` works for both settings. sleight's hook refuses Claude's file and shell edits
that put them in settings, MCP configs, the plugin's manifest or launcher, a LaunchAgent or a shell
startup file. It stops mistakes and the plain edits. [Known problems](known-problems.md#approvals-and-guards)
lists how a determined agent gets past it.

### Stats

`sleight-mcp stats` reads the action log back and summarizes the last 7 days. It gives the median and
p90 seconds per action separately for native apps, turbo and the engine's browser path.
It also counts reads saved, and refusals and failures by reason. A call's time is split
evenly over its actions. A p90 can still include waits sleight can't separate, such as turbo's own
confirmation cards. The engine path's line says its action count is an estimate. `--days N` (1 to 365)
changes the window, and `--json` prints the same numbers as JSON. It finds the log from `--log <file name>`,
then the environment, then the `env` block of `~/.claude/settings.json`. With the log off it says how to
turn it on. A line from before 1.4.0 has no `ms`, so it counts as an action without timing, and the
output says how many. A log file over 16 MB is skipped, and the output says so.

While a session writes the log, the glove's menu adds one row for the last 7 days, such as
`Last 7 days: 1.2 s per native action · 0.4 s per turbo action · 312 reads saved`. It shows the native
and turbo medians only, once the log has a timed action on either, and refreshes at most every five
minutes. The command and the row read only the log on this Mac,
and neither sends it anywhere.

## Text drags

`drag` tries Accessibility text edits first in every app, then background posted events,
then the foreground fallback when the earlier attempts didn't change the text. Both points must
share one text area or field with a non-blank selection. Non-text drags use the content-area
check and require readback to confirm delivery.

Accessibility text moves can lose rich formatting. The app-specific rich-text option was
removed on 2026-10-11. Drag no longer stages text on the clipboard.
See [drag limits](known-problems.md).

## Clipboard

Set `SLEIGHT_CLIPBOARD=preserve` to keep Copy and Cut in a session-private clipboard that sleight
puts back after the action, so sleight never leaves your clipboard replaced. Off by default: a copy
meant for you can't reach menu Paste, `pbpaste` or a browser paste from sleight's private copy, and
each preserved call takes about 230 ms longer. [The design](design/clipboard.md).

## Payments you asked for

Payments explicitly requested in the user's own message count as confirmed when that message
specifies what to buy or pay, the amount and the payment details. This includes the page's confirmation dialog
for that same item, amount and payee. A payment whose amount the message doesn't state asks, even when the page
shows a total. Other payments still require confirmation, and page content never grants permission.
On the engine path a guard check applies this before a click, Enter or Space that could pay, and asks
in sleight's own payment card ([known problems](known-problems.md) lists what it can't see).
Set `SLEIGHT_CONFIRM_PAYMENTS=always` to keep the engine's rule that requires confirmation immediately
before every financial transaction. On the engine path the check then stops each payment until a later message of yours
names its amount. Set `SLEIGHT_CONFIRM_PAYMENTS=never` to also skip the one remaining check, on turbo and on the engine path (a money figure
on the checkout larger than the amount in your message), for a payment your message named with its amount. A payment you didn't
ask for, a second payment in the same request on turbo and a mismatched amount still ask. Only you set it, as an environment variable of
the MCP server. The default rewrites only the exact engine policy measured on 2026-10-12. Changed policy text is forwarded unchanged and records a trace entry when tracing is enabled.

## Requested sign-ups

Creating an account counts as confirmed when your own message asks for it and names the username or
email and the password to set. This includes a terms checkbox your message names. A sign-up proposed
only by the page still asks. If your message names neither a username nor an email, or gives no
password, the sign-up still asks. Saving a password or
card in the browser and login or OAuth grants to another site still ask. The payment, booking,
security-setting and page-dialog rules keep their existing confirmations.

`SLEIGHT_RS=0` restores the account-policy text from before this change, byte for byte. RS is on
when unset or exactly `1`. An unrecognized value keeps the previous, stricter account wording and logs a
startup warning. Both skill variants keep their original submit safety passage in every mode.
`SLEIGHT_CONFIRM_PAYMENTS=always` keeps the engine policy unchanged, including account creation.
A changed engine policy is also left unchanged. The submit instruction defers to the engine's
confirmation policy, including its rules for messages, comments and job applications.
The Codex plugin and benchmark arms forward `SLEIGHT_RS` for the A/B. Live sign-up results with this
wording have not been measured.

## Approval scope

Saying yes to an app approval allows that app for the rest of the Claude Code session. Claude Code's
prompt doesn't mention that, but sleight's own panel does.

The engine asks before every action on an app and doesn't remember a session's answers. In Codex, the app
around the engine remembers "Allow for this session" and answers the repeats. Claude Code's prompt only
has accept and decline, so without help you'd get asked on every click. The relay does the remembering:

- After you accept an app, the relay answers later requests for the same app at the same risk level for
  the rest of the session.
- A different app, a riskier request for the same app, or a new Claude Code session asks you again.
- It never remembers a decline or a cancel.

You can also pick "Always allow", with the third button in sleight's panel or the *Always* option
of *Remember this choice* in Claude Code's form. It adds the app, at that risk level and with the date, to your
pre-approved list, so later sessions don't ask. Terminals and OpenAI's apps never offer it.
`sleight-mcp allow list` shows the list and `sleight-mcp allow remove <app>` takes an app off.
[Permissions](#permissions) shows it beside everything else sleight may do.

Apps you marked "Always allow" in Codex or ChatGPT are the exception. The engine keeps that list in
`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`
and approves those apps itself, so sleight never sees a prompt for them: TextEdit, listed there,
opened with no prompt, while Calculator asked (2026-10-08). sleight doesn't change that file. To be
asked again, remove the app from "Always allow" in ChatGPT's computer-use settings.

To get asked on every action instead, set `SLEIGHT_APPROVAL_SCOPE=once` in Claude Code's environment.
The `env` block of `~/.claude/settings.json` works.

Away from the Mac (a prompt from the phone, a locked screen or 120 s without input), an app card ends the
waiting call at once and says what to type. A first line `allow <app>` in your own prompt approves that
app's low-risk cards for the session. `SLEIGHT_REMOTE_APPROVALS=0` keeps every card waiting at the Mac
instead, as in 1.4.2.

Set `SLEIGHT_APPROVAL_SCOPE=document` to approve a document or window for the session instead.
First call `js` with only `let app = await cua.getApp("TextEdit")`, then call `document_scope`:
the prompt specifies the observed window
and document URL. A different window stops further actions until you read it and ask the user again;
`drag`, `hover`, `menu_bar`, `notifications`, `open_file` and resets are unavailable in this mode.
`cua.getApp({ windowId: 123 })` does not work on macOS, so it cannot select a document here.
For several windows, call `select_window` with `app` and an exact file `url` or `title`,
then acquire the app and check its full Window and URL before `document_scope`.
`SLEIGHT_SELECT_WINDOW=0` leaves the selection tool out.
`SLEIGHT_OPEN_FILE=0` leaves out `open_file`, which opens a file in an approved app in the background.
This guards mistakes in cooperative code. [The design](design/document-scope.md) lists what
the relay enforces and how arbitrary JavaScript can bypass the checks.

In the desktop app's Code tab, sleight asks with its own prompt instead: a small panel with
sleight's icon, Allow and Don't Allow. It plays a sound and opens on the display under the pointer,
over full-screen apps too. The Code tab (Claude 2.19675.0) declines MCP prompts without
showing them, so a forwarded prompt would always come back as no. Return does nothing in sleight's
panel, Escape means no, and it gives up after five minutes. Session memory works the same way.
`SLEIGHT_APPROVAL_PROMPT=dialog` or `client` overrides the choice.

In other MCP clients, sleight reads `initialize.params.capabilities.elicitation`. Form support
(`form: {}`, or the older empty elicitation object) uses the client's prompt. Missing elicitation
or URL-only support uses sleight's panel for app and browser approvals and its own tools' prompts.
The relay tells the engine it can answer forms itself. It remembers accepted apps with the same
risk and session limits. A failed panel never approves an app. A forced `client` setting without
form support cancels the request without opening a panel. Put these environment settings in your
client's server configuration.

The panel keeps Claude wording when `initialize.params.clientInfo.name` is `claude-code`. If
`clientInfo` is absent, `CLAUDE_CODE_ENTRYPOINT` supplies that identity. Other hosts get generic
wording. If the panel cannot be shown, the call reports that failure rather than a user decline.
Forms generated by the relay for local tools, documents, flow exceptions and change review expire
after five minutes without granting approval. A late answer cannot change that decision.

## Permissions

`sleight-mcp permissions` lists what sleight may do, and where you told it never to act:

- Your pre-approved apps, the Electron debugger grants and turbo's browser, with when sleight last used each one.
  An app's time comes from the grant audit (its newest 24 files). For a debugger grant and turbo, sleight sets the time
  of an empty file in `~/Library/Application Support/sleight/used/` when it uses them, so that folder holds times only.
- Your blocks and, when set, the only sites sleight may act on.
- ChatGPT's own Always allow list, read-only. Only ChatGPT's computer-use settings change it. The command reads it only
  when it runs in a terminal, so Claude's shell gets a pointer instead.

`sleight-mcp permissions revoke <app>` takes the app off the pre-approved list and removes its debugger grants.
`revoke turbo` turns turbo off, and `revoke all` does both for everything listed and leaves the blocks. A revoke asks
nothing, since it only removes access, and running sessions see it at their next action.

`sleight-mcp permissions block <bundle id>` or `block <origin>` (such as `https://example.com`) stops sleight in that
app or on that site, in every session, from its next action. Claude gets one line it can pass on, such as "You blocked
sleight in Example (sleight-mcp permissions unblock com.example.app lifts it)". An engine approval for a blocked app is
declined without asking you, and blocking the browser turbo drives stops turbo too. `unblock` lifts a block. A block by
bundle id also stores the names macOS gives the app, so `getApp("Example")` and `open_file` with that name stop too.

`sleight-mcp permissions sites only <origin...>` limits sleight to those sites, in turbo and in browser windows on the
engine path. It is off by default. `sites all` lifts the limit, and `revoke <origin>` takes one site off. Revoking the
last site is refused, because an empty list would mean no limit.

Sites compare by host, in any case, with a trailing dot and a leading `www.` ignored (`www.com` keeps its `www.`). A
block covers its subdomains on any scheme and port. An allow-only site matches its own scheme and port only, and
`https://www.example.com` there also allows `https://example.com`.

Turbo checks the site of every page before it reads, and again before each step's input. Under a site limit it refuses
a tab whose address isn't http(s), except a blank tab. On the engine path (Safari, Firefox, or Chrome without turbo) the
relay takes the site from the window's URL field and the web areas' URL attribute, never from the title or other page
text. Under a site limit, an action in a browser window needs a read that proves one site. Until sleight knows which
apps are browsers, that holds for every app. It also refuses calls through the engine's browser surface, because those
don't say which page they act on. An app is a browser when macOS lists it as a handler for https.

The glove's menu has a Permissions submenu with the same list. Each app row has Revoke, and below them are Revoke All,
Never Act in the app sleight last acted in, your blocks, and a line pointing to ChatGPT's settings for its own list.
Turbo's row has no Revoke. It points to Turn Turbo Off…, which asks first. Revoke All leaves turbo on. Turbo's menu
has Never Act on the site turbo last worked on. The menu never grants or lifts a block: granting stays on each app's
approval card, and only `unblock` lifts a block.

The blocks live in `~/Library/Application Support/sleight/permissions.json`, written only by your clicks in that menu
and by the command. sleight's hook refuses Claude's file edits there and the common shell routes to that folder: redirects,
`rm`, `mv`, `cp`, `chmod`, `find -delete`, unpacked archives, downloads, globs, and inline code that mentions the files or
loads sleight's writers. It also refuses `block`, `unblock`, `revoke`, `sites` and `repair`. The hook reads command text,
so a script Claude writes and then runs, or a path built from variables, gets past it. `open_file` never opens files in
that folder. Plain `sleight-mcp permissions`, which only lists, stays allowed. A `permissions.json` that is a link or has
another owner, mode or format stops every action, and so does one that is gone after a session read it. `sleight-mcp
permissions repair` replaces it with a private file that keeps every valid block, and `sleight-mcp --doctor` names that
fix. When repair can't read the old file, or none of its allowed sites, it changes nothing until you run `repair
--discard`, which writes an empty file.

No tool acts on sleight's own glove or its approval and payment cards, which belong to its consent host. The `menu_bar`
tool refuses that status item and leaves it out of `apps`, and `js`, `drag`, `hover`, `open_file`, `select_window` and
the engine's approval prompt refuse its process and its windows. Only your click answers them.

## Turns without a hook

The Claude Code mod ends the engine's turn when Claude finishes. Other clients can omit the mod
and `turn_ended`: after 30 seconds with no pending tool call, the relay ends a used turn itself.
It keeps the session's accepted approvals and gives the next call a new turn ID. Disconnecting
also ends the open turn. This releases engine turn resources; it does not cancel a running call
or quit an app.

`SLEIGHT_IDLE_TURN_END_MS` changes that wait in milliseconds, and `0` disables it. Keep the default
when your client has no turn hook. The wait restarts on each completed call, so several model turns
can share one engine turn. Approvals last for the server process,
so a client that keeps one server across conversations also keeps its approval session.

Rejected turn cleanup retries at that interval, with three total attempts per turn. After the third
rejection, sleight logs one warning and drops that turn's cleanup. A later turn has its own budget.
sleight cannot confirm that an engine which rejects cleanup released its resources.

## Screenshot scale note

Any app's screenshot with a long edge over 2000 pixels gets a note with the engine's pixel frame,
the shown size and the multiplier between them. The 2000-pixel size comes from one observation on
2026-10-10: 2200 × 1600 shown at 2000 × 1455. The note is on by default; its existing setting,
`SLEIGHT_SIM_FOCUS_NOTE=0`, turns it off. Coordinates are unchanged. A large window in an app other
than Simulator or Device Hub still needs a live check.

## Demonstration recording

`sleight-mcp record --watch org.example.editor task.json` selects an app by bundle ID. Open one
window yourself before recording. Editable native text areas and fields need an empty baseline
before observation. Existing text is never recorded. Replay keeps its app approval checks.

## Local tools

The `menu_bar` and `notifications` tools, the `drag` and `hover` fallbacks, `select_window` and
`open_file` are sleight's own, outside the engine. All are on by default. `SLEIGHT_MENU_BAR=0`
leaves the menu bar and notification tools out, `SLEIGHT_DRAG=0` the drag tool, and
`SLEIGHT_HOVER=0` the hover tool. `SLEIGHT_SELECT_WINDOW=0` and `SLEIGHT_OPEN_FILE=0` are under
[Approval scope](#approval-scope).

## Browser surface

`SLEIGHT_SURFACES` picks what the engine gets. Unset, the default, it is automatic: `computer` plus
`browser` when a cached discovery less than six hours old reports a connected ChatGPT browser
extension, otherwise `computer` only. Set it to `computer` or `browser,computer` to fix the choice.
An engine started from ChatGPT.app, when there's no Codex plugin, is computer-only unless you set
it. [How it works](how-it-works.md#browser-surface).

`SLEIGHT_BROWSER_CORE=1` (off by default, waiting on an A/B) adds a `browser_open` tool for a
browser turbo doesn't drive, such as Safari or Firefox. It takes `{ url, browser }`, the fields of
turbo's tool. sleight acquires the browser and checks that it is a web browser whose front window
has a tab strip and no sheet or dialog. It then sends Cmd+T, the URL and Return as an ordinary js
call, so leases, app and site blocks and flow rules apply as they do to your own js. The result
gives the window's js handle for the next steps. With turbo on, a call naming turbo's browser still
goes to turbo.

## Turbo

Turbo, the direct Chrome DevTools path for browsers, is on by default. At startup sleight writes
`~/Library/Application Support/sleight/turbo.json` when it is missing, and rewrites it when the plugin
files or the node version no longer match it. The file records the browser, its profile folder and a
hash of the installed plugin. A file with `enabled: false` is your opt-out, and sleight never
overwrites it. Claude's own file edits and shell commands can't write the file or run `turbo on` and
`turbo off`.

- `sleight-mcp turbo status` prints whether turbo is on, the browser, its profile folder and whether
  remote debugging is on (the profile's `DevToolsActivePort` file exists while the browser runs with it).
- `sleight-mcp turbo off` writes the opt-out. Turbo stays off until you run `turbo on`.
- sleight's glove sits in the menu bar when turbo is connected, paused or waiting for cleanup, or when a request waits
  for you. The menu shows the state and browser beside a coloured dot, the host the session runs in with its version (as
  the MCP client introduced itself, and never a model, since no host reports one), how the payment check is set, Pause (or how a pause
  ends), Disconnect, Never Act on the site turbo last worked on, Turn Turbo Off…, Settings & Help… and the version. Turn Turbo Off asks once, then writes the same
  opt-out as `turbo off`, and every session's turbo stops within a minute. With turbo disconnected and nothing waiting,
  the icon is hidden unless the ghost hand keeps it. When turbo connects, the glove's dabs flow into place (0.8 s).
- `SLEIGHT_TURBO=0` in the MCP server's environment keeps that one server on the engine path without touching the file.
  It can only turn turbo off. The Firefox and Safari benchmark arms set it.
- `sleight-mcp turbo on` turns turbo on. `--browser chrome` or `--browser helium` picks the browser.
  Without it, Google Chrome is first and Helium second. A browser whose executable others can write is
  skipped, because the connection refuses it. The exception is Chrome or Helium with a group-writable
  executable (mode 775, the result of a drag install), which turbo accepts when its code signature
  checks out as Google's or imput's. Mode 777 is always refused.
- Without a supported browser the launcher doesn't write the file and prints one line with the reason.
- Remote debugging stays your step: turn it on at `chrome://inspect/#remote-debugging`. The browser
  asks you to allow each connection.

`sleight-mcp --doctor` starts with a turbo section. It reports the config state, the browser and whether
the receipt is current, then whether the native helpers are compiled and whether remote debugging is on,
each with the one fix. It only reads.

## Ghost hand

When sleight acts in a background window, a translucent glove glides to the spot, flourishes and fades. It only draws:
it never moves the pointer, takes focus or catches a click, and it shows only over the window sleight is driving. It is off
by default in 1.3.1. With no saved setting, sleight doesn't start a hand host or install hand hooks.
The host compiles in the background on its first use after you enable it. That session has no hand.

- `sleight-mcp hand on` writes `enabled: true` to `~/Library/Application Support/sleight/hand.json`. A saved on setting
  keeps working. You can also edit that file yourself (`version: 1`, a boolean `enabled`, mode `0600`).
  Start a new sleight session if it started with the hand off. `sleight-mcp hand off` hides the hand in running sessions at once.
- The glove's menu has a Ghost Hand row with a checkmark, which writes the same setting. The glove is in the menu bar
  while turbo is in use, and for five minutes after sleight last acted while the hand is on. Without turbo its menu holds
  only the Ghost Hand row, [Permissions](#permissions), the [usage row](#stats) when the action log is on, Settings & Help
  and the version.
- `sleight-mcp hand capture hidden|visible` sets whether captures show the hand. `hidden`, the default, keeps it out of
  every capture, your own screenshots and recordings included. `visible` lets your screenshots and recordings show it.
  `SLEIGHT_HAND_CAPTURE=hidden|visible` in the server's environment takes precedence over the file.
- `sleight-mcp hand status` prints the state, the capture mode and whether the host is compiled. `sleight-mcp --doctor`
  prints the same after its turbo section.
- `SLEIGHT_HAND=0` in the MCP server's environment turns that server's hand off. `SLEIGHT_HAND=1` forces it on for benchmarks, even with a saved off setting.
- Without `SLEIGHT_HAND=1`, a `hand.json` that is a link or has another owner, mode or format keeps the hand off until you delete it.

Claude's own file edits and shell commands can't write `hand.json` or run `hand on`, `hand off` or `hand capture`.

## Preapproved apps

Write `~/Library/Application Support/sleight/preapproved.json` yourself to allow selected apps without
an approval prompt. This applies to interactive sessions too, including the desktop app's Code tab.
Sample file:

```json
{
  "version": 1,
  "apps": [
    { "app": "com.apple.calculator", "riskLevel": "low" },
    { "app": "Calculator", "riskLevel": "low" }
  ]
}
```

Create the parent folder first and set the file's permissions to `600`. sleight refuses symlinks,
files owned by someone else, and group- or world-writable files. Invalid files stop startup.
It reads this fixed path at startup and again whenever the file changes, so running sessions apply a revoke or an edit
at their next approval. A file that turns invalid mid-session allows nothing from the list. No environment variable,
project `settings.json` or plugin setting can select another file or add apps.

App identifiers match exactly, including case. List the bundle ID in the engine's prompt and the name
or path you use with local tools separately. There are no wildcards or inferred aliases.
`riskLevel` is a ceiling: `low`, `medium`, then `high`. Higher, missing or unknown request levels still
ask. `high` accepts every engine approval request for that app at a known risk level.
Local `drag` and `menu_bar` approvals require `high`, since they can move the real
pointer. This list does not approve notifications, document scope, change reviews or flow exceptions,
and it cannot override the engine's app blocks.

The list also applies with `SLEIGHT_APPROVAL_SCOPE=once`. Each grant goes to stderr and a grant audit,
and the tool result tells Claude that the app was pre-approved by the user's list, even if the action
fails. Each relay's audit at `~/Library/Logs/sleight/preapproved-<pid>.jsonl` contains grant fields only.
It rotates at 64 KiB and keeps one prior file per process.
Full relay tracing is separate and off by default: set `SLEIGHT_TRACE` to `1` (which writes
`trace-<pid>.jsonl` under `~/Library/Logs/sleight/`) or to a directory path. It cuts long strings to
300 characters; `SLEIGHT_TRACE_CUT` changes that length, and `SLEIGHT_TRACE_CODE=1` adds Claude's
code, up to 4,000 characters.
An audit write failure falls back to asking. List grants never send an engine persistence setting.

## Review changes

Set `SLEIGHT_CHANGE_REVIEW=1` to turn this on. It's off by default: with it on, both benchmark tasks that open a
TextEdit file through the Open dialog were refused before editing (0/2 on 2026-10-03 and again on 2026-10-04).
Read the intended window with a standalone `let app = await cua.getApp("TextEdit")` before editing.
For a document with a `file://` URL, sleight saves a private copy before the first possible edit.
Open dialogs and same-app sheets can proceed without a copy. If a file was first seen after an
action, a fresh standalone read takes a later copy, and review shows where undo starts.
Call `review_changes` with `op: "list"` to see text diffs or size/date summaries, or `op: "review"`
to choose Keep, Undo or Later for each document in sleight's prompt. Only your prompt response can
decide. Undo restores the saved copy if the file still matches the last agent action, then you
must reopen it in the app. Snapshots last until the session ends.

## Careful guard

The native guard skips the first read for keys, text and coordinates, lets typing follow edit shortcuts or field clicks without
another read, and uses one capture's element numbers until an opener or explicit read replaces it. It still reads for the first
element lookup, after actions that can open a panel, and at the end of an acting call. In the 2026-10-14 A/B this default passed
15/15 against 14/15, with tool time 35% less and guard-read time 5.7 s against 17.3 s.
Set `SLEIGHT_GUARD=careful` to read before every action. Document scope (`SLEIGHT_APPROVAL_SCOPE=document`) and change review keep
their reads.

Set `SLEIGHT_GUARD_LIGHT_RETURN=1` to replace the full read before typing right after Return, Enter, Tab, Escape or Space with
a native check of the leased window (see [guard reads](design/guard-reads.md#light-check-after-return-2026-10-17)). It is off by
default and hasn't run live: we haven't measured how late alerts and sheets appear after Return.

`SLEIGHT_TAB_CONTINUATION=0` (A/B baseline) stops a call at a tab its own Cmd+T opened as before, instead of typing the
rest there ([input leases](design/input-lease.md#windows-a-call-opens-itself)).

The checkout guard switches are on by default. Each `0` setting restores its earlier behavior:

- `SLEIGHT_CK1=0` leaves setValue binding decisions out of the trace. Binding after another setValue still reads;
  native AX metadata cannot prove what the engine's element number currently targets.
- `SLEIGHT_CK2=0` keeps the earlier plain-line remap rules. With CK2 on, a moved plain line can also match by its exact
  text and parent when unique in both captures. After setValue, the added recovery accepts only a plain text field,
  with unchanged ancestors and the same settable-field inventory in a fresh engine read. Card fields and payment-worded
  targets keep their stops on this path, as do sheets, duplicate parents and new settable fields.
- `SLEIGHT_CK3=0` keeps the earlier reads around Cmd+T and inside tab continuations. With CK3 on, an awaited Cmd+T,
  literal HTTP(S) URL and Return chain can use native tab-strip certificates. Each certificate checks the retained window
  and process, tab membership, selected tab, editable address-field focus and absence of chrome transients. The address
  field must have a recognized `AXIdentifier`, or `AXDOMIdentifier` when `AXIdentifier` is empty, and sit in a browser
  toolbar outside page content. Firefox address fields and Safari tab strips use this same proof. Unknown identifiers,
  partial metadata, a changed field or a failed probe take the full engine read. The final read and page-landing reads
  remain. Careful mode, document scope and change review keep their earlier paths.

CK3 requests each native sample by opening a relay-owned FIFO for reading. The engine doesn't write files or use sockets
for this channel. Each call has eight private, single-use FIFOs; both ends reject symlinks and check that the
opened descriptor is a FIFO. The relay publishes observations and removes the channel at call end. A missing or failed
sample keeps the full-read fallback. Traces record FIFO creation time and failed operations with their errno codes;
an observation file that has not arrived is ordinary polling, so a plain timeout has no failure step.

The supplied live Firefox smoke passed. Broader native browser coverage and post-input timing still need live A/B
qualification. CK1 read elimination needs an engine-owned element mapping.

`SLEIGHT_POPOVER_CONTINUATION=0` (A/B baseline) restores the earlier behavior. When the call closes a dialog, sheet, palette,
gallery or floating window, the rest of the call still goes to the window under it. A popover stops it, and an untitled
palette closed by a button isn't refused. `SLEIGHT_PARENT_LEASE=0` (A/B baseline) keeps the "window changed
since the last call" refusal when a dialog closed between calls ([input leases](design/input-lease.md#dialogs-and-palettes)).

When two results in a row show a menu-bar item selected with no menu open, sleight posts one Escape to the leased app's
process to close it. It does this once per stuck menu, only after half a second with no key or mouse input, and the result says
so. `SLEIGHT_STUCK_ESCAPE=0` turns it off.

## First-call batching

The engine's tool description tells Claude to send only the app's acquisition in its first call.
sleight rewrites that sentence so Claude can put the first actions after the acquisition in the
same call, since the guard checks the window before they run. It also names `cua.getApp` for an app
Claude can name, which took the first-call `getState` from 8 of 11 runs to 0 of 12 (2026-10-11). Set
`SLEIGHT_FIRST_CALL_BATCH=0` to keep the engine's wording. `SLEIGHT_FIRST_CALL_BATCH=merge` also
asks Claude to chain later calls such as save and close into one, which happened in 0 of 24 runs.
`SLEIGHT_FIRST_CALL_BATCH=nosavestop` (for an A/B, not yet run) drops the instruction to end a call
after Cmd+S and says sleight waits for the sheet a shortcut opens.

`SLEIGHT_FS=1` (under A/B, off by default) replaces the engine's current js description with sleight's shorter text and
says `cua.getState()` doesn't list windows. Every engine session reads it. On 10 native held-out tasks, three runs a side
(2026-10-19), it passed 24 of 27 against 25 of 27 (word-memo 2/3, textedit-notes-table 1/3 against 2/3; textedit-window-drag, 0 of 6, left out) and word-brief went from 67.2 to
100.2 s, so it stays off. The browser's keyboard new-tab sentence, once behind the same switch, is on for everyone.

## Result size

`SLEIGHT_RESULT_TRIM=1` (under A/B) leaves a split acquisition's tree out of a result when the same
call returned a newer full one. It tied the default (24.8 s against 23.8 s a run, 2026-10-11). It
also drops runs of 20 or more sibling rows from a result over 25,000 characters, keeping selected
rows, folders and rows matching the window title or file name (unit-tested, not yet measured live).

A call that reads one window more than twice shows only its last read of that window, plus a line
saying how many were left out. The code still gets every read, and errors, notices and other windows'
trees stay. Travel's 40-read airport search in Firefox (2026-10-17) returned 140,778 characters and
spilled to a file; replayed, it is 3,620. `SLEIGHT_CALL_TREES=all` (A/B baseline) shows every read.
A sheet, dialog or menu read under the same title stays. When three calls in a row scroll the same list
the same way and none uses a loop, a note suggests searching it in one call with a capped
loop that checks for progress and verifies the selection. In a live probe without a model, one such call
found and selected the airport in 33 s, against 88.7 s over 15 calls. `SLEIGHT_SCROLL_NOTE=0` (A/B baseline) leaves the note out. Neither
is measured end to end yet.

`SLEIGHT_COMPACT_REACQUIRE=1` (opt-in) compacts the tree of a window Claude acquires again after
seeing it whole, sending "no change" or the changed lines as a read does. It cut
prompt tokens 9% but lost its 2026-10-17 A/B on excel-edit and word-edit (156.3 s against 149.4 s
over 5 rounds, 9/10 against 10/10 passes).

`SLEIGHT_RULES_FIRST=0` (A/B baseline) puts the skill's rules after the first window tree in a
result instead of before it. `SLEIGHT_TEXTLESS_HINT=0` (A/B baseline) leaves out the note that a
document area doesn't show text values and should be read with a screenshot.

When the engine runs with `CUA_REPL_ENABLED_SURFACES=computer`, its Workflow lines that ask for a
`getAXState()` after actions say instead that the result already shows the window header and changed lines.
A call that ends on its action also shows renumbered elements on `+` lines with their current numbers,
as a call that ends on a read does. Both forms make the same engine reads (3 operations for a one-action
call in the race-1017 traces). The docs get 120 characters shorter, and the effect on time isn't
measured yet. `SLEIGHT_WORKFLOW_DOCS=0` (A/B baseline) keeps the engine's lines and the old numbering.

When the window `open_file` opened is such a document (a sheet with no cell values, a page with no
body text, from a file that isn't empty), its result includes the window's screenshot in place of that note. When the open-shot A/B
switch leaves the initial screenshot out, the fallback takes one more engine read. It comes only where the note would, and only when the
window's URL is the opened file, so `SLEIGHT_TEXTLESS_HINT=0` leaves it out too. In 10 of 10 excel-edit and word-edit runs (2026-10-17),
Claude spent two turns on a second read and a screenshot before its first edit.
`open_file` includes a screenshot by default. Its held-out A/B totaled 60.0 s against 65.8 s without
(SE 5.2 s), with no lost pass. `SLEIGHT_OPEN_SHOT=0` is the A/B off switch; it leaves the textless
fallback above active. `SLEIGHT_OPEN_AUTO_SHOT=0` disables that fallback for A/Bs.

The default skill includes the measured screenshot sentence. The lean skill keeps its previous text.
On word-memo and word-brief, the screenshot A/B totaled 162.0 s against 196.2 s without
(34.2 s faster, SE 22.7 s), with no lost pass. `SLEIGHT_SCREENSHOT_READS=0` removes that sentence
and disables standalone screenshot reads for A/Bs. The relay's textless hint stays on unless
`SLEIGHT_TEXTLESS_HINT=0`, as in the measured baseline. `SLEIGHT_SKILL=none` omits the skill for A/Bs.

`SLEIGHT_COMPACT_TOOLBARS=1` stays opt-in. Textedit-replace-all took 26.9 s against 23.2 s
(+16.2%, SE 2.4 s), despite the gain on Word. The full confirmation policy remains unchanged.
See the [four flag A/Bs](benchmarks/2026-10-19-flag-ab.md) for the method and every task.

`SLEIGHT_OPEN_RULES=short` (for an A/B, off by default) gives an `open_file` result the skill's rules
without the lines about acquiring an app, choosing a window, tap coordinates, the drag, hover and
banner tools, and the doctor (4,897 characters down to 3,605). It keeps every safety passage word for
word. The whole skill comes with Claude's first `js` result. Haiku thought before its answer in 18/18
sleight preview-read runs, each given the whole skill in its first result, against 2/5 Peekaboo runs (2026-10-17).
That is a correlation, and the A/B has not run.

## Launch re-read

`SLEIGHT_LAUNCH_REREAD=1` is for an A/B that has not run yet. When an acquisition launched the app and its
tree has 1 to 19 elements, sleight waits 2.5 s, reads once more and keeps the fuller tree if it shows
the same window. Electron apps build their tree seconds after launch. This setting is off by default.

## Doctor app reads

`sleight-mcp --doctor` checks the helper's inventory. Add a running app name or bundle ID, such as
`sleight-mcp --doctor Calculator`, to check that app's accessibility read too. Doctor reports elapsed
milliseconds and whether it received a window header. It skips missing or ambiguous apps and declines
approval requests without showing a prompt, except when the user's pre-approved list covers that
app and risk. It uses the same fixed list and grant audit as a session, without engine persistence.
Doctor only reads. A failed app read exits 1; a skipped
app read leaves a successful inventory check at exit 0.

## Flow rules

Write `~/Library/Application Support/sleight/flow-rules.json` yourself, outside the project, then set
`SLEIGHT_FLOW_RULES=1` in Claude Code's environment. An absolute path selects another user-owned file.
The relay reads it once before starting. Edits take effect in the next session. A sample file:

```json
{
  "version": 1,
  "rules": [
    { "id": "contacts-mail", "kind": "source", "sources": ["Contacts"], "destinations": ["Mail"] },
    { "id": "private-site", "kind": "source", "sources": ["site:*.internal.example.com"], "destinations": ["site:public.example.com"] },
    { "id": "ssns", "kind": "pattern", "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b", "destinations": ["*"], "except": ["1Password"] },
    { "id": "cards", "kind": "pattern", "pattern": "\\b(?:\\d[ -]?){13,19}\\b", "destinations": ["*"], "except": ["1Password"] }
  ]
}
```

Rules stop matching literal transfers before forwarding and tell Claude which rule matched.
`flow_exception` shows the exact stopped call for your decision. Allow Once permits one identical
retry. Another call cancels it. Claude cannot grant an exception through tool arguments. Pattern
rules accept optional regex `flags` (i/m/s/u). App names and observed bundle IDs ignore case.
Source rules remember text fields and emitted values, then match exact substrings sent later.
Use `site:example.com` in `sources`, `destinations` or `except` to select one HTTP or HTTPS host,
across schemes and ports. `site:*.example.com` selects subdomains, excluding the bare host. Site
names ignore case and use ASCII DNS labels (or punycode) or canonical IPv4 addresses. Other wildcard
forms, URLs, paths and ports in selectors are refused. App names, bundle IDs, `browser` and `*` keep
their existing meaning.

Sites come from the engine's window or tab URL header. Saved tab handles keep separate observations,
and source text keeps the host where it was read. Unknown browser sites remain subject to site
destination rules and cannot use a site exception. Missing or conflicting headers clear the current
site. A navigation call clears its earlier site until the next header arrives. Native browsers share
one observed window per app. A person's navigation between reads can leave an observation stale.
At startup, enabled flow rules read LaunchServices registrations for both HTTP and HTTPS. The
registered bundle IDs and app names identify browsers even before a URL header arrives. The
existing browser list is the fallback when registration lookup fails. Registrations are read once
per session. Relaunch sleight after installing a browser.
[The design](design/flow-rules.md) explains the gaps in literal checks and source attribution.

## Driving apps the engine refuses

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex,
Atlas, and their beta builds) before any approval prompt. That refusal is OpenAI's code, and sleight
never modifies or wraps it. When Claude reaches one of these apps, the result says so and names the
one setting that lifts the refusal. Only you can turn it on, and sleight never sets it:

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

The setting belongs to OpenAI's helper, so Codex loses the refusal too. The helper reads it when it
starts (it quits after about 20 seconds idle), and `--doctor` shows whether it's on. Then these apps
get the same approval card as any other app (Always allow, Allow, Decline), with one added line
saying the app could be dangerous: a terminal runs commands, and another AI app has its own approval
buttons Claude could press.

sleight still refuses actions in these apps' settings windows. The relay checks the title of the
window Claude last read against Terminal's pane names (General, Profiles and others) and the words
Settings and Preferences. Like the other window guards, this check runs in cooperative code
and is not a security boundary. To turn the setting back off:

```bash
defaults delete -g ComputerUseAllowForbiddenTargets
```

We tested it live on 2026-10-05 with engine 26.930.31730. Terminal ran an `echo` in the background
2/2 and never came to the front. The prompt included the warning above. An action in Terminal's
settings window was refused 1/1. OpenAI's apps reached the engine's approval prompt instead of its
refusal, but driving them this way is untested. The setting is undocumented, so an engine update
can remove it.

## Benchmark and development settings

`SLEIGHT_MC1=0` disables turbo's own-label click handling and settled click retry. Both are on by default.
A retry needs the signed page hook to confirm that it cancelled every press, release and click, then the same node must
settle with its original classification and a clear centre. Submit and payment targets never retry.
Removed, replaced or covered targets still refuse. Clipped controls can also fail the clear-centre check.
The retry runs the trusted rules again, and the action result includes a retry notice. The race harness and
Codex plugin pass `SLEIGHT_MC1` through. Use `1` and `0` for the two A/B arms.

`SLEIGHT_BENCH_API_CAP_USD` caps a benchmark pass's model spend for the month in dollars; the pass
refuses to start at the cap (default 200). `SLEIGHT_ARM_DIR` moves the benchmark's sleight arm
folder (default `~/Library/Caches/sleight-bench/sleight-arm`). `SLEIGHT_STUB_OSASCRIPT=1` stubs
`osascript` and `open` in the startup-cost measurement scripts. A measurement then doesn't run a
real app. `SLEIGHT_CHATGPT_APP` points `bin/sleight-mcp` and `sleight-mcp setup` at another ChatGPT copy
(default `/Applications/ChatGPT.app`).

## Model-time A/B switch

`SLEIGHT_MT=0` restores the earlier turbo wording and 33-character tab handles for an A/B.
The default uses shorter popup and refusal lines, explains field values, batch boundaries and tab actions,
and explains viewport markers. Browser and Electron tab handles use nine random base32 characters after `t` (45 random bits),
with collision checks against registered handles. Payments, confirmations and approvals follow the same rules.
## Drag A/B switches

`SLEIGHT_DP7=0` restores the previous drop-index and cross-window posting behavior. By default,
text drops can use an empty final line when AX geometry proves its row. A failed cross-window
Accessibility move refuses with its reason, since posted drags between documents can copy text.

`SLEIGHT_DP2=0` restores the raise and settle wait before an Accessibility move, which otherwise
runs first. Same-app overlap still requires a raise and another exposure check, and
posted presses keep the raise and settle wait.

`SLEIGHT_DP4=0` leaves the drag result alone. By default, a changed-text result gets one engine
read of its leased native window and appends the compactor's changed lines when a prior tree exists.
The read waits up to 5 s. A failed read leaves the drag result alone. These switches are on by default
and have not had live A/B qualification.

## Close-read and handle API A/B switches

`SLEIGHT_DP1=0` keeps the guard's final read after a close shortcut. By default, the guard can skip
that read after Cmd+W, Cmd+Shift+W or Cmd+Q when a fresh native observation matches the leased bundle ID,
PID and process start. Both the window count and modal count must be 0. Missing identity, unknown metadata,
remaining windows or modal children keep the read. The native relay must supply the call's private mark.
This switch is on by default and needs live checks of unsaved TextEdit and Word close dialogs before release.

`SLEIGHT_DP3=0` omits the engine app API list from confirmed `open_file` results. The list is on
by default. Use sleight's `drag` tool for selected text moves.
