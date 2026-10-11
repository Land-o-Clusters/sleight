# Settings

You don't need any of these. They change approvals, guards, receipts, review or experimental behavior.

## Receipts and unsaved review

Set `SLEIGHT_RECEIPTS=1` to write a private JSON receipt after each used turn to
`~/Library/Logs/sleight/receipts/`. The pane links the latest receipt. It lists the observed app
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

## Rich TextEdit moves

Set `SLEIGHT_RICH_TEXT_MOVE=1` in the relay's environment to try rich text preservation for
covered TextEdit moves. Only the exact value `1` enables it. It is off until live qualification
passes. Without it, covered rich moves use the existing Accessibility text edits, which can
lose formatting. The opt-in stages RTF on the clipboard and verifies the pasted text and
attributes before removing the source.

After an unconfirmed Paste, the shared clipboard reservation lasts at most ten seconds. Recovery
restores the original only while the clipboard still has the exact staged bytes and generation;
otherwise it leaves the current contents alone. The relay reports restoration or contents left,
then discards its private snapshot. A queued Paste can still run after restoration, so read the
document before continuing. See the [third review](benchmarks/2026-10-10-textedit-fixes-3.md).

## Clipboard

Set `SLEIGHT_CLIPBOARD=preserve` to keep Copy and Cut in a session-private clipboard that sleight
puts back after the action, so sleight never leaves your clipboard replaced. Off by default: a copy
meant for you can't reach menu Paste, `pbpaste` or a browser paste from sleight's private copy, and
each preserved call takes about 230 ms longer. [The design](design/clipboard.md).

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

Apps you marked "Always allow" in Codex or ChatGPT are the exception. The engine keeps that list in
`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`
and approves those apps itself, so sleight never sees a prompt for them: TextEdit, listed there,
opened with no prompt, while Calculator asked (2026-10-08). sleight doesn't change that file. To be
asked again, remove the app from "Always allow" in ChatGPT's computer-use settings.

To get asked on every action instead, set `SLEIGHT_APPROVAL_SCOPE=once` in Claude Code's environment.
The `env` block of `~/.claude/settings.json` works.

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
This bounds retries. It cannot confirm that an engine which rejects cleanup released its resources.

## Simulator focus note

Simulator and Device Hub screenshots can exceed what Claude Code shows unresized. Such a screenshot's
reply states the engine's pixel frame, the shown size and the exact multiplier between them, and asks
Claude to check visible focus before typing and leave Capture Keyboard unchanged. The note is on by
default. Set `SLEIGHT_SIM_FOCUS_NOTE=0` to turn it off. Coordinates are unchanged. The affected
`simulator-form` task must pass with it while the owner is away before release.

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
It reads this fixed path once at startup. Edits take effect in a new session. No environment variable,
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

Before an action, sleight reads the app's window to check it's the one Claude saw. A read right
after an action waits for the app to settle, about 400 ms and much longer on a busy Mac, and Codex
doesn't make that read. So by default, keys, typing, paste and clicks or drags at coordinates that
come after typing, pasting or a plain key in the same call go straight to the engine, and so does a
Return that follows `setValue` (in a Save sheet that read took 1.85 s a save). After a click, a
shortcut, Return, Escape, Tab or Space, the next action still reads, since that read also waits for
a panel or sheet the action opened. The first action of each call is checked, and so is every action on an element number, ID or label, which is what catches a window
that renumbered mid-call. A first action that sends keys, text or coordinates uses Claude's full
read from the call just before when that read is less than 10 s old, however slow it was (owner,
2026-10-10, about 0.35 s a run). Under load a new read took 17 to 57 s. Otherwise the guard reads
again, about 50 ms on a settled app, and stops if an element Claude is about to act on changed since
Claude read the window.
Set `SLEIGHT_GUARD=careful` to read before every action. Document scope
(`SLEIGHT_APPROVAL_SCOPE=document`) always reads.

## First-call batching

The engine's tool description tells Claude to send only the app's acquisition in its first call.
sleight rewrites that sentence so Claude can put the first actions after the acquisition in the
same call, since the guard checks the window before they run. It also names `cua.getApp` for an app
Claude can name, which took the first-call `getState` from 8 of 11 runs to 0 of 12 (2026-10-11). Set
`SLEIGHT_FIRST_CALL_BATCH=0` to keep the engine's wording. `SLEIGHT_FIRST_CALL_BATCH=merge` also
asks Claude to chain later calls such as save and close into one; it is under A/B, and got save and
close into one call in 0 of 24 runs, so the default wording doesn't ask for it.

## Result size

`SLEIGHT_RESULT_TRIM=1` (under A/B) sends a Save or Open panel's file list past 10 rows as a count,
and leaves a split acquisition's tree out of a result when the same call returned a newer full one.
Off by default: in the A/B's textedit-save runs it took spilled results from about 56k to 16k
characters.

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
[The design](design/flow-rules.md) explains the gaps in literal checks and source attribution.

## Driving apps the engine refuses

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex,
Atlas, and their beta builds) before any approval prompt. That refusal is OpenAI's code, and sleight
never modifies or wraps it. The `blocked_app` tool is sleight's own. It drives those apps through
macOS Accessibility, the same path as `menu_bar` and `drag`, and its prompt is the whole opt-in.
When Claude reaches a refused app, the relay says so in the result and offers `blocked_app`;
nothing happens until you approve the app, and Allow puts it on the session allowlist like any other
app.

Once you approve, Claude can read the app's window (numbered elements plus a screenshot), click,
type, press keys and scroll in it for the rest of the session. The prompt says what a yes means. For
OpenAI's apps, it says the yes covers clicks in ChatGPT, approval buttons included. A yes for the
session lets Claude answer Codex's approval dialogs by itself. Declines are never remembered.

In a terminal, every key or text that can run a command (any typing, Return, paste, most chords) is
shown to you first, exactly as it will be sent. The prompt offers Allow Once and Don't Allow, like
Claude Code's Bash prompt. Those asks are never remembered and can't be pre-approved. Settings and
preferences windows of these apps are refused, so Claude can't change their own approval or safety
settings. Every action goes through the input leases and flow rules like sleight's other tools, and
is logged to stderr and the trace. Actions that need the app in front (typing, keys, point clicks)
bring it forward, check that the switch worked, and put your front app and pointer back, as `drag`
does.

One limit to keep in mind: the gate is your consent. It does not isolate the app. The engine still
refuses these apps, and its own approvals, badges and background typing don't apply here. sleight's
own code does the driving, with the limits above (Accessibility and Screen Recording permissions
for the app that runs Claude Code, settings refusal by window title, toolbar and foreground typing).
[The design](design/blocked-apps.md) has the details.

### Fewer prompts: let the engine drive them

If a prompt for every terminal command is too much, you can turn off the helper's refusal yourself.
The setting belongs to OpenAI's helper, so Codex loses the refusal too. sleight never sets it.

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

The helper reads it when it starts, and `--doctor` shows whether it's on. Then these apps go
through the engine like any other app, with one approval per app for the session, and Claude types
in the background without bringing the app forward. sleight's prompt tells you that a yes lets
Claude run commands in a terminal for the rest of the session without asking again.

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

`SLEIGHT_BENCH_API_CAP_USD` caps a benchmark pass's model spend for the month in dollars; the pass
refuses to start at the cap (default 200). `SLEIGHT_ARM_DIR` moves the benchmark's sleight arm
folder (default `~/Library/Caches/sleight-bench/sleight-arm`). `SLEIGHT_STUB_OSASCRIPT=1` stubs
`osascript` and `open` in the startup-cost measurement scripts. A measurement then doesn't run a
real app. `SLEIGHT_CHATGPT_APP` points `bin/sleight-mcp` and `sleight-mcp setup` at another ChatGPT copy
(default `/Applications/ChatGPT.app`).
