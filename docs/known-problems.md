# Known problems

## Lean prompt

`SLEIGHT_PROMPT=lean` has 0 live runs as of 2026-10-11. Its static instruction inventory is
30.25% smaller, but task success, turns, model time and actual session context use are unmeasured.
The inventory substitutes `<value>` for runtime data, counts notice templates once and excludes
engine-provided docs, UI trees, images and native helper output. It cannot predict a session's
token total or repeated-notice cost. Blocked-app names remain in verbatim safety text. The
[design and live handoff](design/prompt-budget.md) specify the pending 36-run A/B.

## Parity battery

The 31-app battery passed 41/41 offline tests (2026-10-11). Office and iWork
saves and Notion's local-file support remain unchecked. The Notes, Reminders and Calendar scripting descriptors have not run
against their dictionaries. Local fixture IDs and the `local: true` declaration come from the owner;
the runner cannot independently prove that a supplied container is outside an account.

Self-message checks match a marker and require nonempty sender and time fields. They do not verify
those two fields against an independent account read. A marker already appears in the search prompt,
so matching it alone does not prove the message was read. App-state checks prove that one engine read
contained the marker, without proving which UI field held it. Model-created fixtures have no scripted
reset, so an earlier arm's item can remain visible. Created items remain for the owner to review.

Codex's CLI stream does not report isolated model API time. Battery results record null for that field
and keep model-gap time separate, since it includes host scheduling. Calls that arrive without a
start event have incomplete wall timing. The CPU sampler can miss short processes between its
one-second samples, as in the existing benchmark. Account apps may use windows whose document URL
is absent, or open a fixture in an existing tab. The generic cleanup then cannot claim that window
and stops the pass with the live lock retained.

The focus observer requests 200 ms samples, but native calls can delay them. The saved timestamps
show actual gaps. No live cadence has been measured. Windows on other Spaces and windows excluded
by macOS's on-screen list are absent. A changed frontmost bundle or overlapping target window is
recorded evidence, without establishing whether the owner or the benchmark caused the change.
Raw streams are not published. Codex may write private rollouts in its existing benchmark home, and
normal arms can load user plugins with their own logging policies. The runner's read-only task
instructions depend on the driver following them, as in the existing benchmark.

Generic benchmark arms accept only the existing benchmark approval messages and empty forms or a
`choice` field offering `session` or `once`. Other competitors' approval schemas stop with an
unsupported-approval result. Remote MCP servers and installer commands are unsupported. The initial
plain-MCP Calculator proof finished 0/1. Calculator was off-screen in all 15 samples. Acquisition
returned `cgWindowNotFound`. Permission observation later failed. The driver stopped and its process group
was collected. The later retained-fixture setup has unit coverage and dry discovery evidence, but no
live qualification. The committed generic-MCP plus sleight comparison stopped before either driver
because another run held the shared live lock. Plugins declaring hooks, LSP servers or agents are refused,
as are plugin settings that select an agent or agent status command. App-dialog
classification and periodic observation cannot prevent a competitor's single tool call from acting
before the next observation. Competitor code runs as the user with full file and network access.
Its scrubbed environment is a forwarding control. This harness is not a sandbox for untrusted plugins.

What doesn't work, or works only partly, with the measurements behind it. We found all of these in
our own runs. Dates and engine versions are given where they matter.

## Turn study

The [2026-10-11 offline study](benchmarks/2026-10-11-turn-study.md) covered 90 cached transcripts
and 386 calls. The cache supplied no transcripts before 2026-10-10 EDT in the selected range.
Another 367 result rows had no matching transcript there. Those missing runs have no measured turn cost.
Call timestamps cover the host round trip. The preceding gap includes model time and host
scheduling. It does not isolate model API time. A class charges the whole call,
including useful actions in that call, so 397.021 attributed seconds do not establish savings.
Classes overlap. Parallel call wall times can overlap too. The analyzer charges a shared gap once.

Read-only, menu, save-wait and filtering classes use literal method patterns and observed menu
lines. Dynamic calls and other syntax can be missed. Consecutive reads can be necessary to check
changing UI. A refusal can be a required guard. Missing spill files leave only preview byte counts,
and missing timestamps remain null. The sample resolved 13 of 13 spill files and measured 386 of
386 calls. There has been no live comparison of a change based on these classifications.

## Approvals and guards

- On bestbuy.com in Safari (real-site smoke, 2026-10-10), the input lease refused every click
  and kept refusing after Claude acquired Safari again and reset the session
  ([report](benchmarks/2026-10-10-away-2.md)). The traced rerun (2026-10-11,
  [raw](benchmarks/2026-10-11-real-shop-bestbuy-traced.json), 2 refusals in 14 calls) did the same.
  The window title started with Safari's profile name, Personal, and contained a raw inch mark
  (`23.8"`). The header parser accepted only a JSON string, so that read never leased a bundle ID.
  The header had no URL line. One `cua.getApp` of that window now leases it in a fake-engine test,
  and a click whose fresh read shows a different title is refused before it runs. No live Best Buy
  run has repeated this since the parser change.
- The "Always allow" button on sleight's app approval prompt (unreleased) adds the app to your
  pre-approved list with its risk level and the date, only from your own click. Unit-tested only:
  nobody has pressed it in a live session, so the panel, the list it writes and a later session's
  no-prompt behavior haven't been checked together.
- Routines accept only literal app acquisition, named-element clicks, native value replacement,
  typing and full AX reads. They refuse arbitrary code, shortcuts, paste, drags, focus and positions.
  Crash locks recover after the former process and its recorded relay groups are gone, or when a
  live PID's start time no longer matches the stored receipt. Damaged records, leftover launch
  markers and matching live owners need `routine unlock` (typed `unlock` in a
  terminal). An active session at start, or a person returning during replay, logs a skip and tries
  at the next interval. Other stops pause the job until a successful explicit `run-now`.
- Demonstration recording accepts a selected bundle ID with one window. It requires existing
  Accessibility and Input Monitoring access and never requests either permission. It depends on
  app notifications for native text and menu changes. Drags, gestures, keyboard shortcuts, web-view
  typing, typing outside editable native text fields and file dialogs are unsupported. A field without a unique ID or label
  stops the capture. The source needs Xcode command-line tools to compile its passive observer.
  A menu notification that arrives before its matching mouse observation also stops capture.
  Text capture needs an empty baseline from before observation. The observer's Swift source
  typechecks, but recording in an app other than Calculator or TextEdit has no live proof.
- CPU parity with Codex is unverified after the guard setup and native app-probe changes. The
  [no-model profile](benchmarks/2026-10-10-footprint-parity.md) covers two small native trees and
  changing Space visibility. Full AX reads remain, and no large-tree scaling result is available.
  A reset discards the retained setup. If the runtime loses it without notice, the next compact call
  stops before input and requires a standalone app acquisition. Input is never retried automatically.
- Turn receipts recognize literal native actions. Arbitrary JavaScript remains opaque. A returned
  batch doesn't prove that each action ran. Review compares accessibility reads, so a changed tree
  doesn't prove saved or unsaved state. Missing, failed, overlapping or omitted observations show
  unknown state. The 2,000-call limit makes a longer turn's review partial. Window titles are
  hidden by default. Explicitly keeping them can expose private computed input. Document file
  names remain visible after owner-name scrubbing. The host doesn't forward its mod-hook origin
  over MCP, so pane snapshots remain included rather than trusting a title to hide calls.
  Native Undo and Revert controls are named for the user to use in the app;
  sleight doesn't activate them. The recorded October trace corpus truncated every code field
  before its input literals. That audit can't verify input redaction. Synthetic tests cover
  known inputs. [The design](design/review-receipts.md) describes the scope.
  The full-name scrub matches the name as `id -F` gives it, exact case, and fails open if `id -F`
  fails. A turn's read text is kept until its receipt is built (13.1 MB at 200 reads of 64 KiB,
  measured by the branch). Typed text is also removed from the app, window and document names, but
  only where it is the whole name or a whole word in one: typing "x" leaves "TextEdit" intact, and
  a document named "opulently.txt" keeps its name when "opulent" was typed (a unit test,
  2026-10-10).
- Unsaved field review (`SLEIGHT_STATE_REVIEW=1`) compares the first and last full observations
  for windows with attempted input. A baseline may come from the previous turn; it is not a
  fresh read before each action. Other people's edits can appear. Text and popup values and
  selected text are length markers. A same-length replacement shows equal lengths with a
  change reported. Checkbox states and selection flags are shown. Labels and AX identifiers
  are omitted from display. Secure, password and protected nodes and descendants are excluded
  before hashing. A native selected-text footer is excluded whenever a secure node is present,
  since the footer has no field identity. An absent footer doesn't prove an empty selection.
  Rootless, truncated or malformed observations have no field comparison. An app that doesn't
  mark a secure field cannot be recognized. Raw engine
  replies and an independently enabled raw trace remain outside this redaction.
  Canvases, pixels-only apps such as iPhone Mirroring and unsupported controls have no field
  review. Added, removed or ambiguous fields make review partial. At most 100 changed fields
  per window are shown, with a count of omitted changes. Window identity still depends on the
  app, title and URL. Windows with identical headers cannot be distinguished. Window numbers
  distinguish redacted titles in one receipt only. The guard runs in Claude's JavaScript and
  is not a security boundary. The user uses any observed native Undo or Revert control in the
  app. sleight doesn't send undo input. Live behavior is unverified.
  [Design and live checklist](design/unsaved-review.md).
- [Verified results](design/verified-results.md) add a line to native `js` replies from reads the
  relay already has. A changed value or window is an observation after input, and a person's own
  activity can cause it too. Missing or degraded reads leave the result unverified. A save is
  confirmed only by the same file URL, or the exact path the call named in a Save panel, together
  with a cleared modified state, and that still doesn't prove the bytes were written. Autosave can
  clear an Edited title. The line then gives the cause as unknown. Browser calls, local pointer tools
  and computed method names don't get a line. The compactor's cache grows with each distinct window.
  In the idle run, unchanged and one-value cases added at most 0.196 ms a call, and changing every
  label added 1.169 to 3.571 ms ([memory and CPU report](benchmarks/2026-10-10-verified-results-lifetime.md)).
- In 3/3 traced textedit-save runs on 2026-10-11, Claude used two or three calls inside the Save
  sheet, 6 to 9 s a run ([design](design/save-then-close-2026-10-11.md)). Go to Folder through the
  final Return shared one call in 0 of 3. The call that opened the sheet appends that sequence
  with the sheet's `saveAsNameTextField` id. Unit tests cover those recorded trees. Compliance, turns
  and model time after the note are unverified until sleight-arch reruns textedit-save x3 with
  `SLEIGHT_TRACE_CODE=1`.
- On 2026-10-11, `/private/tmp` held 305 `sleight-*` folders and `$TMPDIR` held 6252, left by
  tests and probes. TextEdit's Save sheet lists `/private/tmp`, and that listing made trees of up
  to 87,740 characters and engine reads of about 1.4 s each. A leftoverAfter run of the old
  open-file, skill-rules and preapproved-always tests left 5 folders. One later `npm test` of
  those plus relay, compact-reads and forbidden-targets left 18 after process exit (lease
  coordinators still open). After cleanup, `npm test` (1764/1764) and `npm run check` (same unit
  tests, plugin validate, 30/30 mod) each added 0. `scripts/temp-leftovers.mjs`
  lists folders older than 6 hours and removes them only with `--remove`. It skips names without
  the `sleight-` prefix, `$TMPDIR/sleight-bench`, folders a process still holds, and git worktrees.
  A probe keeps its folder only when `SLEIGHT_KEEP_TEMP=1`. `demonstration.mjs` still writes
  `sleight-observer-*` (3 on this Mac) and is outside this lane. `lsof` can miss a hold that is
  not an open file.
- Browser call text never turns off native guards. The engine must confirm `browserUse` on its reply
  before sleight learns browser handles. Candidates attempt the known native window lease and
  saved-file checks; when native access is unavailable, their runtime guard denies native access
  while browser operations remain usable. These guards remain cooperative, not JavaScript isolation.
  Flow rules accept site selectors from window and tab URL headers, with literal fills, typing and
  navigation URLs checked. Saved browser tabs retain separate site observations, while native
  browsers share one window observation per app. Missing or conflicting headers clear the current
  site. A person's navigation between calls can still leave a stale site. The site checks have
  recorded-header unit coverage, with live checks held on 2026-10-09. Clipboard transfers and runtime
  strings remain outside those checks. LaunchServices registration discovery has offline coverage
  for a browser outside the old list, but no live flow-rule proof there. Lookup failures keep the
  old list. New registrations need a new session. Native
  document scope and saved-file change review do not cover browser tabs. Automatic mode uses a
  connected-extension result cached for six hours, or a negative for 24 hours. Every automatic
  session refreshes it after initialization. A newly connected extension leaves the current session
  on `computer`. Browser control starts in a new session after a successful background refresh.
  For up to six hours after the extension goes, sessions still start with browser control. What a
  browser call does then isn't measured.
  Discovery has a four-second reply deadline and up to 2.5 seconds for process collection. A timeout
  leaves the prior timestamp unchanged, so under load there is no guaranteed discovery delay.
  Existing sessions keep their description. If refresh fails, later sessions may use a positive
  result for up to six hours. An installed
  extension can be absent from the engine's inventory. Browser approvals still use their normal route.
- [Input leases](design/input-lease.md) let one sleight session act on a window at a time.
  Another session gets the holder's name and time left, while reads remain available. Leases expire
  after 30 seconds without renewal and end with the turn or session. Local drag and hover reserve the app,
  while menu and notification actions reserve the desktop. The
  [broker CLI](design/lease-broker.md) (unreleased) lets outside clients acquire,
  inspect, renew and release the same reservations. Codex still takes no lease
  automatically. An owner-approved AGENTS.md instruction or skill must make it
  call the CLI before input. This is a convention that an agent can ignore,
  and arbitrary JavaScript can bypass the injected guard. App approvals stay in
  their own runtime. The broker cannot grant or copy them. Offline broker
  and lease tests passed 51/51; Codex participation and independent approval
  prompts remain unverified live. Exact bundle IDs and URL or title spellings
  must match across clients. Clock jumps, separate store directories and pending
  input that continues after expiry can break coordination. A lost acquire reply can
  leave a reservation until expiry. Status omits its token. The broker
  doesn't install an observer and cannot attribute outside input from diffs or shared
  helper activity. Status may include private document titles and URLs.
  Never delete the SQLite coordinator during live use. Replacement between transactions is detected
  and reopened, but metadata checks cannot prevent arbitrary filesystem replacement during an action.
- Multiple equal-title candidates without a URL need one matching native AX window. The relay
  uses the selected or acquired window number, or the app's focused window number, and retains
  its AX reference with the app's PID and launch time. When AX omits a number, exact AX bounds
  can identify one CG window. Single windows and sheets skip the check. Inconclusive identity falls back to the
  engine header and existing guards, with one warning. If titles are missing from both the engine
  inventory and health result, candidate count is unknown and the native check is skipped.
  Same-title replacement detection is unavailable on these paths and during an action.
  The [third follow-up](benchmarks/2026-10-10-waits-targeting-3.md) left TextEdit Save, equal titles
  and the CPU comparison pending under a live hold. The hold is gone. The identity check's
  cost with one window, where it is skipped, was the same as no check: median 482 to 484 ms an
  action with it against 492 to 515 without, loaded, warm CPU 231 to 240 against 250 to 285 ms
  ([fourth follow-up](benchmarks/2026-10-10-waits-targeting-4.md)). The idle CPU run, which needs
  load under 3, and the equal-title live check haven't run. Live attempts from 16:11 to 16:14 UTC on
  2026-10-10 failed setup before a stop or a save: the recorded Chess points were for a 1223 by 949
  board and the open one was 667 by 532. The TextEdit waits check then passed with the owner away (a
  new document, `waitFor` on the Save sheet, the save), and its cleanup follows a saved document's
  rename ([2026-10-10-away-2.md](benchmarks/2026-10-10-away-2.md)).
- `/sleight stop` collects its owned engine and helpers before checking pointer button state,
  keyboard filter taps and owned lease records. A pressed button has no reliable owner, so it
  leaves cleanup unconfirmed. A remaining tap or failed scan also prevents a clear receipt.
  The shared computer-use helper stays running. These are observations at stop time, rather than
  proof about future input from a shared service. Stop retains the relay and session approvals.
  After the next user message, the next call starts and initializes a fresh engine. Acquire the app again.
  The protocol and owned-process checks have unit coverage,
  but the host observations have not been qualified live.
  Esc keeps the engine and relay alive. After an unconfirmed explicit stop, the next user message
  clears closing and invalidates old handles. If collection closed stdin, requests answer with
  reconnect advice. Existing in-flight reservations stay held until their work finishes; delayed
  input, approvals and Undo decisions from before stop cannot resume.
- Change review covers saved files observed before `js` actions. A file first seen after an action
  needs a fresh standalone read before editing. Undo then starts at that later copy.
  Unsaved buffers, Save As targets,
  menu bar and pointer tools have no before copy. Undo changes the saved file, so reopen it before
  editing again. Autosave or a user edit after an action makes undo refuse. Arbitrary JavaScript can
  bypass the window guard or forge headers. [The design](design/change-review.md) lists the limits.
- Flow rules check literals and text values observed earlier. Runtime-built strings, encoded values,
  clipboard shortcuts, screenshots and coordinate drags can pass without a match. Source attribution
  and UI parsing can miss values or block harmless text. This guards mistakes; arbitrary JavaScript
  can bypass it. [The design](design/flow-rules.md) lists the limits.
- The engine refuses some apps outright ("not allowed … for safety reasons"): terminals (Terminal,
  iTerm2) and OpenAI's own apps (ChatGPT, Codex, Atlas, with their beta builds). The list is built
  into the engine's helper, so no approval changes it. It also respects any app blocks your
  organization sets. To stop Codex asking for approvals, change Codex's own approval setting. With
  your opt-in, sleight can drive these apps through its own Accessibility path (see
  [Driving apps the engine refuses](settings.md#driving-apps-the-engine-refuses)); the engine's refusal itself
  stays. On that path, settings refusal keeps the title and toolbar filters and now inspects
  `AXIdentifier` on window containers, `AXModal`, dialog subroles and nested toolbars, independent
  of the displayed language. Unreadable trees and scans over 300 nodes or 12 levels refuse.
  Unit tests passed 7/7 on recorded ChatGPT content-window roles and constructed attribute cases
  (2026-10-10), including the old title, toolbar collection and direct-child toolbar rules.
  The recording lacks settings attributes, so localized settings still need live
  qualification. An app that exposes neither a recognized identifier nor dialog or toolbar metadata
  can still pass with an unknown title. The engine path used when the user disables its refusal
  still has only title checks. Changing its guard needs a separate relay change.
  Background scroll reaches the app's focused view. System Events' keystroke
  doesn't act on
  an embedded newline in Terminal, so blocked_app sends one Return key press per newline instead.
  The window screenshot needs Screen Recording for the app that runs Claude Code, on top of the
  Accessibility permission `menu_bar` and `drag` already need, and it captures only a window that is
  on screen. In the live check the Codex app's window exposed only its window-control buttons to the
  driver's walk (its UI is web content), so a harmless click there had no target; Claude refused the
  window controls and reported, which is the intended behavior.
- `claude -p` can't answer approval prompts. List apps in the user's [preapproval file](settings.md#preapproved-apps)
  before starting. Unlisted apps and requests above their listed risk still need a person.
- `sleight-mcp setup` (unreleased) runs OpenAI's helper installer when its status isn't OK, opens
  the Accessibility and Screen Recording panes and runs the doctor, and starts the engine from
  ChatGPT.app directly when there's no Codex plugin. A full setup run hasn't been tried live: macOS
  permissions always need the user's click, and the live run left is in a fresh macOS user. In a
  macOS user that never signed in to ChatGPT, the engine started and listed apps (2026-10-10).
- The preapproval loader proves file ownership, not who wrote it. Any process running as you,
  Claude included, can write the file. The skill tells Claude never to create or edit it, but this
  rule depends on Claude following the instruction.
- Document scope checks the last observed window before forwarding a call and stops on changed or
  missing Window/URL headers. Its injected action guard checks again, but arbitrary JavaScript can
  bypass it or forge observations. Result checks cannot undo actions already taken. Discovery reads
  can expose other windows' contents. The engine's equal titles without URLs are indistinguishable,
  so native admission refuses multiple matches.

## The pointer, drags and hover

- Anything moving your real pointer in the app interrupts it. The engine watches real mouse and keyboard
  input to notice a person taking over, then makes Claude re-read the app. Another agent driving in the
  foreground counts too. Background sessions share the helper, with leases coordinating sleight's actions.
  In one test where Codex was also driving in the foreground, keystrokes typed
  during the run showed up twice, and we still don't know why. A
  [two-engine probe](benchmarks/2026-10-04-double-keys.md) didn't reproduce it in 30/30 trials
  (engine 26.930.31730, 2026-10-04).
- The engine's `app.drag` failed TextEdit text moves 9/9. Local `drag` passed the benchmark 3/3
  before the window/content guards. Later [two-window checks](benchmarks/2026-10-04-drag-window-guards.md)
  passed 8/8 (four refusals, four exact moves), with about 4.5 s of foreground pointer use per call.
  Ambiguous windows require `windowId`. Text endpoints must share one text area or field with a
  non-blank selection in every app. AX scans refuse
  above 300 elements or 12 levels ([review fixes](benchmarks/2026-10-04-drag-round-2.md)).
  Lost-text errors require Cmd+Z; whitespace-only selections refuse.
  [Spacing repair](benchmarks/2026-10-04-drag-polish.md) covers unique whole words at line ends.
  Other selections need a spacing check, and concurrent edits can confuse snapshot comparisons.
  The old-helper live reproduction was blocked by another session's larger window.
  Both drag paths set AXMain and raise the window selected by `windowId`, then require it above same-app windows
  at both endpoints. Foreground fallback also refuses covering apps.
  Off-screen windows must be brought to the current desktop for drag or hover.
  [Stacked Chess checks](benchmarks/2026-10-04-drag-raise.md) moved the selected pawn 1/3
  submitted drags; two posts left both boards unchanged, and one later setup failed before posting.
  Screenshot points were used because AX square coordinates are reversed. Fixture cleanup was verified.
  Calculator content guards remain unmeasured.
  The [background prototype](benchmarks/2026-10-04-background-text-drag.md) moved TextEdit text
  4/4 after correcting its drop geometry, but joined `gammaalpha`. Posted events repair the verified
  space after a text move. Posting only works when no other app's window covers the drag
  points, because macOS picks the drop target from what's on screen there: 3/3 TextEdit moves with
  the window uncovered, 0/3 with this Claude window over it (2026-10-05). Since 2026-10-11, the tool
  tries Accessibility first for selected text in every app, with no pointer or focus change.
  If it doesn't change the text, uncovered points may use posted events,
  then the guarded foreground fallback. It maps the drop point to a character, puts
  the word there and takes it out at the source, adjusting one adjacent space for word moves,
  then checks the whole text.
  After an Accessibility text write, TextEdit's next Cmd+S deadlocked on the document's save lock in 10
  of 13 probe trials with the file opened through the Open panel (0 of 3 opened with `open -g`), the
  same hang as `setValue` on 2026-10-05. One Shift press and release posted to TextEdit's process after
  the write prevents it: 0 hangs in 10 trials that edited, against 5 in 8 without it, and then 10
  `drag` moves in a row saved with no hang (2026-10-09). We don't know why the event helps, or what
  held the lock. A review of the evidence (2026-10-10) favors the event giving TextEdit's main loop a
  turn that finishes the Accessibility edit before Cmd+S blocks: idle time didn't help, since 10 s
  waits still hung. NSDocument's autosave event monitor, whose mask covers flags-changed, and the
  Shift modifier itself aren't ruled out. The same press can't follow a `setValue`, which runs
  in the engine: the engine refuses a key press with only modifiers (`-10005
  keyPressIncludedNoNonModifierKeys`, 2/2 live, 2026-10-11). In a background TextEdit opened with
  `open -g`, `setValue` then the engine's Cmd+S saved 3/3 without it. A rewritten experiment on 2026-10-10 stalled in every
  variant, Shift included, and the saves finished at about 30 s, which points at its own harness
  ([report](benchmarks/2026-10-10-away-2.md)). The night rerun (30 of 30 runs with AppKit
  serialization logging on, then 10 of 10 without) stalled again in every variant, and a `sample`
  14 s after Cmd+S showed TextEdit's main thread idle in its event loop and the helper idle on its
  input pipe rather than blocked, so the save never started. The files written at about 30 s were
  autosave ([raw](benchmarks/2026-10-10-save-lock-experiment-1791679933967.json),
  [evidence](benchmarks/2026-10-11-evidence.md)). The helper had posted one S key-down with the
  Command flag and an S key-up with none. It now posts Command down, S down, S up with Command still
  held, and Command up. `node bench/textedit-save-lock.mjs --delivery-check` types one character (no
  Accessibility write) and requires the file to change within 2 s. Live on 2026-10-11 (2 runs) the
  typed character arrived but that Cmd+S didn't save either, and AXEdited read false throughout.
  A Cmd+S posted to a background TextEdit's PID doesn't start a save. The 2026-10-08 hangs came
  through the engine's `pressKey("super+s")`, so the experiment can't measure them until it sends
  Cmd+S that way, and whether the Shift event helps is still unknown.
  The [2026-10-10 follow-up](benchmarks/2026-10-10-save-lock.md) stopped before
  editing: the existing background TextEdit process returned `AXWindows -25204`. A new instance
  restored extra windows, then exact-fixture cleanup returned `AXRole -25204`. A later read-only
  check confirmed zero Accessibility windows in that same launch and released the retained live
  lock without app input. The event comparison has no new causal result.
  A bold red word lost both attributes in 1/1 covered RTF trials of the old move.
  The app-specific RTF clipboard path was removed on 2026-10-11. Accessibility moves still
  write plain text: on 2026-10-11, 3/3 background moves of a bold red word in a covered TextEdit
  window came out plain black Helvetica, with the text, spacing, front app and pointer right (about
  6.6 s a drag). Uncovered windows now take the same path. Whether the posted drag they used before
  kept formatting was never measured. Undoing a completed move takes two Cmd+Z.
  Safari's web text areas ignored Accessibility text writes (1/1 on 2026-10-09), so the mouse
  paths remain necessary when an app ignores the edits. The Command modifier was removed:
  the [2026-10-04 probe](benchmarks/2026-10-04-background-text-drag.md) moved text without it,
  and no measured benefit was found in the benchmark reports or drag history.
  The new regression cases failed 10/10 against the old code. The mocked window suite passes 122/122,
  with identical text-area and window geometry under TextEdit and a constructed editor bundle ID
  (61 each).
  Live checks of the shared path remain with sleight-arch: selected-text moves in background
  TextEdit and one other native text app must conserve the full text and spacing. The front app
  and pointer must be unchanged. The document must save without a hang. Chess must still move the intended
  piece, with readback confirming its source and destination and no repeated uncertain drag.
  The shared path has not been qualified live in another native text app. The foreground drag is
  the last resort. On 2026-10-08 it took the owner's focus mid-sentence
  during a pass, and a typed space went into TextEdit, so it now waits for 2 s without any input (up
  to 10 s), and stops if keys are typed once it has taken focus. Before the
  named-window raise guard,
  [product trials](benchmarks/2026-10-04-background-drag-product.md)
  passed 3/3 TextEdit moves, with TextEdit inactive and the front app unchanged. The owner moved the
  pointer during one trial; it was unchanged throughout the other two.
  `CGEventSetWindowLocation` is a private macOS API. Missing symbols, invalid events or coordinates that fail the
  round trip skip background posting and select foreground. Future macOS updates may
  break this path. A changed, unreadable or lost text snapshot never permits a second drag.
  Apps without a text snapshot report unverified background delivery and need a read to verify the
  move. They do not repeat the drag automatically. Calculator content guards remain unmeasured.
  Chess AX square coordinates were vertically reversed: two local posts and an engine control
  at those points left e2 unchanged. Screenshot coordinates moved e2 to e4 through the product's
  background path. Pointer and front app varied during that trial, so quiet Chess delivery remains
  unmeasured. Use the engine's `app.drag` first for Chess, and read the board after any local post.
  With the Claude app's window over the board (2026-10-09), the engine's `app.drag` moved a pawn
  (1/1) where `drag`'s background posts at the same points didn't (0/2). `drag` now refuses a covered
  drag that has no selected text and points to `app.drag`. On that board `drag` took 11 to 14 s, 9.4 s
  of it reading the window's elements through System Events before it could press anything.
  Chess save/close recovery selected another session's game even after the owned window's
  `AXMain` and `AXRaise`. It refused further engine input. The last native read still found the
  product fixture (window 240864) open on e4. Its save and close remain unverified.
- There's no background hover, since engine events go to the app and the real pointer never moves. The skill covers
  most cases: tooltips are readable as `Help:` text in the UI state, and hover menus usually open through
  an element's secondary actions, a right-click or a key. Mouse-moved events posted to a background app
  arrive, but they don't trigger hover: no enter or exit fired on the probe app's hover area, and a
  GitHub Desktop button looked the same pixel for pixel (2026-10-04). UI that only reacts to a real
  pointer can use sleight's local `hover`. The locked trials on 2026-10-04 support its 1500 ms default.
  Calculator's sidebar tooltip was absent in 1/1 capture at 400 ms and 1/1 at 1000 ms, then readable
  in 1/1 at 1500 ms. Chess's green-button hover menu was visible in 1/1 capture at 400 ms and 1/1
  at 1500 ms in the final trial. These small samples support the default. Exact onset remains unmeasured.
  Successful 1500 ms trials reported 1786 to 1798 ms for takeover. [All attempts](benchmarks/2026-10-04-local-hover.md)
  include the setup and capture failures too. Hover captures screen pixels in the selected window's rectangle.
  A window spanning displays can include another app in that rectangle, as a Chess trial showed.
  The point check does not guard the whole capture. Keep the window within one display and inspect
  screenshots before sharing them. The affected trial's PNGs were withheld after privacy review.
  Chess titles and TextEdit home-folder labels identified the user in published evidence. Those strings
  are now placeholders, and the four affected PNGs were removed. Future hover trials redact text on
  write and omit Chess and TextEdit PNGs. Historical Chess plans need a current title before reuse.
  A tooltip or menu outside the rectangle is clipped. Hover requires Screen Recording permission
  before takeover. It refuses coverage by another app or a different window of the same app;
  do not retry unchanged.
  Cleanup attempts to restore the pointer and front app on ordinary failures; forced helper termination
  can interrupt it. Hover's own pointer and front-app restoration has not been measured separately in
  live trials. The fixture also restores both, so its successful checks do not prove hover's restoration.
  It does not restore the full window order. Earlier fixture pointer mismatches remain unresolved.
  Since 0.16.0, hover and the `menu_bar` real click wait like the foreground drag for 2 s without
  input (up to 10 s), and hover fails if keys are typed while it holds focus. Hover's guard has unit
  tests. The `menu_bar` guard now has five fake-clock tests (2026-10-09): the 2 s threshold,
  input during the wait, refusal at 10 s, quiet at exactly 10 s and an unavailable input clock.
  They verify that refusal doesn't post mouse events and success restores the pointer. Neither guard
  has had a live run; no `menu_bar` approval was requested for these tests.
- When you work in a full-screen or Split View Space, apps sleight drives in the background are on
  another Space. Clicks and typing still reach them, but the engine's `app.drag` answers
  `noWindowsAvailable`, sleight's `drag` refuses the off-screen window, and TextEdit's reads timed
  out. A pass with the Claude app in Split View failed 8 of 21 runs, all in TextEdit, Chess and the
  simulator (`docs/benchmarks/2026-10-08-await-split-view.json`). Moving a window into a full-screen
  Space needs private macOS APIs, so leave full screen while sleight drags. After 1.1.0 (unreleased)
  an app read tells Claude, once per app per turn, when the front window is in full screen and none
  of the app's windows are on screen, and a read that times out twice gets the same advice instead of
  "cause unknown". This was checked live with a fixture app in full screen, in front of Calculator
  (the note arrived with a 1,063 ms read) and in front of TextEdit in one textedit-drag run, where
  Claude stopped after 12 turns and asked the user to leave full screen. On another Space an app's windows drop out of
  its Accessibility window list. The check counts them through CGWindowList instead. It can't tell a
  window on another Space from one that's ordered out, so an app with only hidden panels left would
  get the note too, but only while the user is in full screen.

## Clipboard

- Native `app.paste` temporarily changed the clipboard, then restored all measured bytes in 4/4
  fixtures. Text entry and engine drag left it unchanged in 4/4 each. Local drag did in 2/2.
  Copy/Cut use the user's clipboard by default, so deliberate copies remain available to menu Paste,
  `pbpaste` and browser pastes. Preservation is opt-in with `SLEIGHT_CLIPBOARD=preserve`. In that mode,
  Copy/Cut save a private session copy and restore the prior bytes. Their results say the copy is
  private. [The measurements](benchmarks/2026-10-04-clipboard.md) include every attempt and failure.
- Opt-in preservation added median call times of 236 ms for Copy, 205 ms for Cut and 226 ms for Paste
  in three trials each on this Mac. Clipboard helper and coordination time accounted for about
  180, 177 and 179 ms respectively. Separate runs include engine timing variation; larger payloads
  may cost more. Native sessions skip this work. The helper now starts once per preserving session
  and handles later byte requests over the same pipes. Unit and relay checks passed 43/43 on
  2026-10-10, including failed writes, generation conflicts, malformed replies, delayed process
  collection and frame-size boundaries. Quadratic buffering found in review was removed. With a
  synthetic 40 MiB payload in 64 KiB chunks, reply framing fell from 5,115 to 88 ms and request
  framing from 5,331 to 31 ms under mocks. These exclude AppKit and process costs.
  A new live helper timing and four-fixture byte check is prepared, but the shared live hold
  prevented execution. The earlier timings and 4/4 result remain the latest live measurements.
  [The helper report](benchmarks/2026-10-09-clipboard-helper.md) records this qualification gap.
- Preservation cannot snapshot unreadable formats, file promises or more than 64 MiB. It falls back
  to the native shortcut and tells Claude the clipboard was not preserved. Claude must never modify
  the user's clipboard to get around that fallback. Menu actions and browser handles are outside
  preservation, so those pastes cannot use the private copy. Use a native session to copy for the user.
  In preservation mode use literal shortcut keys and one clipboard action per JavaScript request.
  Split calls and retry when the clipboard message asks. Ordinary native sessions have no such limit.
- A failed Copy/Cut cannot attribute new clipboard data, so preservation leaves that data alone.
  Two or more generations stop restoration. One generation could be an outside copy if the app did
  not copy. macOS has no atomic compare-and-restore, and arbitrary JavaScript can bypass the proxy.
  Private copies end with a successful reset or session exit. A process crash during private Paste
  can leave temporary data on the clipboard. File URLs preserve references, not deleted files or
  file-promise providers. Native sessions and other tools do not take the preservation lock.

## The engine and its helper

- The engine keeps two keyboard event taps ("ChatGPT Computer Use") from its first key action until
  its process exits. Measured 2026-10-10 on engine 26.1007.21159 with Calculator: a turn end didn't
  remove them within 30 s, with or without `js_reset` before it, both through sleight's relay and
  straight to the engine. They went when the engine exited, which for sleight is when the Claude Code
  session ends. LCU 0.11.2 ends turns before `js_reset` because it found taps left after a reset;
  here a turn end didn't remove them either way, so sleight doesn't copy that yet. Whether they
  explain the doubled or dead keyboard seen on 2026-10-09 is unknown.
- Exact window selection is unavailable on macOS. Engine 26.1002.52244's docs say `getApp({ windowId })`
  is for Linux and Windows and macOS takes an app name, path or bundle ID (not retested live). On
  26.930.31730 the API listed
  `cua.getApp({ windowId })`, but it rejects that selector with "macOS getApp requires an app name,
  path, or bundle ID." `cua.getState()` also omits window IDs. With two temporary TextEdit documents,
  3/3 exact selections were rejected before editing. `select_window` uses AXRaise/AXMain instead:
  3/3 with the plugin tool, plus 6/6 with the same approach in prototypes.
  The intended TextEdit document was edited and sampled foreground state was unchanged. This depends on the app supporting those Accessibility operations and
  exposing a unique title or AXDocument URL. Other apps remain untested. During an active selection, the relay marks changed or missing action
  window headers as "outcome unconfirmed". [Attempt results](benchmarks/2026-10-04-window-targeting.md) include the failures.
- The native guard still needs full AX reads after preceding actions. Engine 26.1007.21159's
  `getAXState` options are still only `emit` and `disableDiffing` (same as 26.1002.52244). The bound
  App forwards those to Sky `get_app_state({ app, disableDiff? })`. Clicks take `element_index` or
  coordinates, not an AX ID. The helper's reply does not split AX, settling, capture and transfer time.
  On 2026-10-08, Calculator reads after Escape took median 413 to 437 ms, against 29 to 48 ms idle.
  Even waiting 700 ms first left a 413 ms read. The [engine timing study](design/engine-time.md)
  points to a wait on the next capture, without separating the native phases. Screenshots now reuse
  the AX observation captured with the image. Each of two Chess sequences saved one read.
  Click-only and typing batches keep their existing read counts. The product retains every
  intermediate identity and selector check.
- The 2026-10-09 [guard speed experiment](benchmarks/2026-10-09-guard-speed.md) did not replace
  per-action reads. The engine refused the native observer socket with `connect EPERM`; at load
  62 to 67, 14/20 native observations also failed after the AX messaging deadline. Another run
  at load 43 produced 0/20 usable observations, including 17 busy refusals. A 100 ms read
  race still took 516 to 563 ms to return, with the read complete by the next call. No bounded
  post-call read or fast native guard is enabled. The compactor emits less text for degraded
  buttons with unique IDs. The engine's settling wait remains.
- After every `js` action without a later reusable observation, sleight's window guard reads the whole tree again so the input lease can
  check the window header. Since 0.9.0 Claude gets only the lines that changed since the last full
  tree it saw for that window ([measurements](benchmarks/2026-10-05-compact-reads.md)). A first
  read, a new window or dialog, or a page that re-renders and renumbers its elements still comes
  through whole. On TextEdit and Chess the result text per run fell 1 to 23%. In Helium, a click on
  a local page with a 120-item sidebar sent 428 characters instead of 35,532, and five scrolls on
  the CNN front page sent 39,655 instead of 203,160. When loaded content renumbers elements, Claude
  gets the count instead of the lines. A number Claude took from the older tree is now sent as the
  line of the element Claude saw there, which the guard finds again, when exactly one line in the
  current tree matches it. Otherwise the relay refuses the action until Claude reads again (8
  refusals, 6 correct passes and none wrong in CNN trials, before the line lookup). Since the
  renumbered-click change (unreleased), a numbered click in a batch that an earlier click renumbered
  goes to the same element at its new number, with a note, when its line is in the new tree exactly
  once; it used to stop, and Claude rewrote the batch over several calls. The line lookup and the
  remap have unit tests only. Literal
  numbers only: a call that computes an element number is refused in that state. If Claude Code summarizes the conversation, Claude can lose the tree a diff refers
  to, as with the engine's own diffs. A read with `disableDiffing: true` comes through whole.
- An action called without `await` that fails used to end the engine's JavaScript session, and every
  handle with it (`app.click(1); "x"` on a disabled Calculator element, 3/3 on 2026-10-07). The guard
  now attaches a handler to each action's promise and tells Claude which action failed. With
  `const p = app.click(99999)` and more code after it, 1.0.0 reset the session (1/1) and the fix
  kept it with the failure reported (3/3, Chess, 2026-10-09). A promise chained off an action
  (`app.click(1).then(f)` assigned and not awaited) still rejects unhandled. The relay also refuses
  a call whose action is a statement without `await` with more code after it.
- The engine's helper can stop answering. On 2026-10-04 every `cua.getApp` timed out
  (`-10005 timeoutReached`) for about 25 minutes, with the Mac unlocked and in use, until ChatGPT was
  restarted. We don't know the cause. It started right after a test that kills engine processes.
  In 18 completed SIGKILL trials, reads passed before and after cleanup. Killing a responding helper
  relaunched it, but no wedge was reproduced, so helper-only recovery from a wedge remains unproven.
  After two consecutive `timeoutReached` failures on standalone reads of one app, the relay checks
  target AX, another acquired app's AX and a fresh engine read of that control app. A responding
  control points to the target app. ChatGPT restart advice requires both AX processes to respond
  with windows and an actual engine control timeout. Missing evidence stays unknown.
  In [owned fixture trials](benchmarks/2026-10-08-reliability.md), the original relay misdiagnosed
  1/1 completed hang runs (two actual read timeouts). Revised diagnosis identified the app in 6/6
  runs (twelve timeouts), with no ChatGPT restart advice. The last three runs also verified full visible
  control and recovered fixture reads. The first three exposed a compactor defect now covered by tests.
  One earlier harness deadline failure remains in the receipts. No shared helper wedge was induced.
  Claude stops retrying. sleight retries by itself.
  For that app, `js` reads are refused between recovery attempts (at most one every 20 seconds),
  and `js` actions using its known handles are refused until a read succeeds. After hidden recovery,
  actions wait for a visible app read, which sleight makes a full read. Other apps, documentation,
  `js_reset`, and turn cleanup remain available. Inventory failures have their own retry counter.
  App identity comes from literal acquisitions, known handles and learned bundle aliases. Arbitrary
  JavaScript can bypass this advisory check. Independent checks establish evidence for the advice,
  not the native cause of a shared helper fault.
  Doctor probes inventory by default, which does not prove that every app's accessibility read works.
  `sleight-mcp --doctor Calculator` also checks that running app's read, reporting its time and window
  header. It uses the user's pre-approved list and writes the session's grant audit before accepting
  a covered app approval. Other approvals are declined without a prompt. It skips apps missing or
  ambiguous in inventory. The app probe
  has stand-in engine coverage. Initial live checks on 2026-10-09 were held by `/tmp/sleight-hold`,
  and a later user-list check timed out during inventory, before the app read. A live run on
  2026-10-10 read Calculator in 156 ms with a header; that figure is recorded in the changelog
  only, with no results file. Before
  0.7.0 it also reported "ok" when the helper couldn't start at all.
  [The investigation](benchmarks/2026-10-04-helper-health.md) records each live attempt.
- On a busy Mac the guard can stop a call that clicks several element numbers. With 20 CPU-bound
  workers running, it stopped 5 of 5 calls of eight Calculator clicks, saying an earlier click had
  changed what the next number was, against 0 of 5 without them. Without load the guard's reads
  took 3.0 s of those eight clicks' 3.6 s, against 0.6 s for the clicks alone
  ([load-cost](benchmarks/2026-10-09-load-cost.json)). Each stop came from a read that dropped the
  element's attributes, `button Two` where the first read had `button Description: 2, ID: Two`, at
  the same number. After 1.1.0 (unreleased) the guard takes such a bare line as the same element when
  its role matches and its name is the fuller line's ID or label. That fix has unit tests and no
  live run under load yet. The read compactor compares lines too, so a degraded read may also show
  Claude a large diff or a stale-number stop. We haven't measured that.
- The AX check of the target app waits 0.5 s, which a busy Mac can miss. On 2026-10-09, with a load
  average of 101 from other processes, TextEdit, Safari and Calculator missed it in 5 of 5 probes and
  answered in 0.27 to 0.52 s with a 6 s deadline. A read failure then can be diagnosed as a hung app,
  with advice to quit and reopen it. Not fixed yet.
- The 29.475 s first Calculator acquisition on 2026-10-09 spent 27.683 s inside the engine after
  approval. Browser discovery had already ended, so its removal does not explain or fix that wait.
  On 2026-10-10 a follow-up engine acquisition failed with ScreenCaptureKit error `-3811`;
  the historical delay's native cause remains unknown. Separate target and tap helper probes passed.
  The [third footprint report](benchmarks/2026-10-09-footprint-spawns-3.md) records both.
  [The footprint probes](benchmarks/2026-10-09-footprint-spawns.md) separate startup and acquisition.
  Terminal pane snapshots and desktop images over the embedding limit still decode all pixels.
  Small desktop images can skip decoding, though these probes do not establish Codex footprint parity.
- The helper quits about 20 seconds after it goes idle and relaunches on the next call. A call
  during that restart can fail with "native pipe startup failed" before it reaches any app; another
  session hit it three times in a row on 2026-10-05 while doctor passed, and we don't know why it
  repeated. sleight now sends such a call again once, a second later, without Claude, and tells Claude
  to call `js_reset` and retry if that fails too. The resend has unit tests only: we haven't caught a
  restart race since adding it.
- The helper can also fail to start. On 2026-10-05 it quit normally when doctor's session ended, and
  every later launch failed with "Sky Computer Use service startup request failed" for at least five
  minutes: launchd still held the old job and answered "Operation already in progress". Removing that
  job with `launchctl remove` fixed it at once, without restarting ChatGPT, and the next four helper
  launches worked. We don't know what left the job behind. Doctor now detects this and prints the
  command.
- ChatGPT updates can break it. The version lookup handles the folder moving around, but not the API
  changing. Run `--doctor` first when something stops working.
- The engine has no access to an app's icon in the menu bar or to notification banners: its inventory has
  no Control Center or Notification Center, and `getApp("com.apple.controlcenter")` times out (engine
  26.930.31730, 2026-10-03). sleight's `menu_bar` and `notifications` tools cover those instead (see
  [How it works](how-it-works.md)). They work in the foreground: an open menu shows on screen and takes
  the keyboard until sleight closes it. Icons that open a SwiftUI window (`MenuBarExtra` in window
  style) ignore the accessibility press, so sleight clicks them for real and puts the pointer back.
  Controls without a label, tooltip or identifier get names such as `Button at (10, 20)`, measured
  from the window's top-left corner, or `Button 3` if AX has no position. Their element numbers
  remain the arguments to `press`. The fallback names and press mapping have unit tests; an
  unnamed live popover button has not been checked with an approved app.

## Specific apps

- Slack, Firefox and WhatsApp expose thin engine trees (2026-10-10, one read each, no input):
  Slack 15 elements and 483 characters, Firefox 24 / 898, WhatsApp 19 / 940. None of those three
  had a text field. Slack's 3 buttons had neither IDs nor labels. Discord was not thin (251
  elements, 1 labeled text field, 46 buttons). VS Code and Cursor had 116 and 139 elements, 0
  text fields, and no button IDs. Chat tasks keep authors out of published results. The separate
  chat AX observer has zero live runs as of 2026-10-11. Slack's native AX count is unmeasured,
  Discord's is unmeasured and WhatsApp's is unmeasured. The engine counts above do not measure
  native AX after enabling its app-level switches. [Chromium documents the accessibility switch](https://www.chromium.org/developers/design-documents/accessibility/);
  whether either switch expands these three apps' trees is unverified. The helper attempts only
  readable, settable switches whose earlier values it can restore, and records unsupported or
  unreadable switches. Its conversation, list, message and author identifiers have fake-tree
  coverage, but no app's identifier schema is qualified. A missing identifier, an authorless
  grouped message, multiple lists or windows, or missing scrollbar proof stops setup. Bodies and
  generic static text never substitute for author evidence. A new incoming message can make the
  pre-action author stale. Dialog classification uses English window titles and modal roles;
  embedded sign-in or update pages without those signals may stop on missing baseline evidence
  instead. Frontmost samples cover before and after launch, not a transient change between them.
  The native launch step rechecks the process table and preserves a process started before its
  dispatch timestamp. A simultaneous owner launch during `open -g -b` cannot be attributed with
  certainty to the benchmark. PID and launch timestamp checks refuse a replacement at cleanup.
  A permission stop, unknown launch ownership or failed AX restoration leaves cleanup unconfirmed
  for sleight-arch to inspect. No dialog is answered and no process is force-quit. During offline
  regression work, one test invoked the default Slack open command before its fake launch adapter
  was attached. It returned `CHAT_LAUNCH_FAILED`. Whether an app launched is unverified. The test
  now supplies both launch adapters. No app was quit to undo that attempt without ownership proof.
- A Save or Open sheet showing a folder with many items reads as a very large tree: 198 file rows
  made one read of TextEdit's Save sheet 57,000 characters (2026-10-10), past Claude Code's tool
  output limit, so Claude saw only a pointer to a file, and every guard read of it took 1.4 to
  2.3 s. The benchmark now moves runs older than 6 hours out of its folder. Engine 26.1007.21159
  still has no root, depth, filter or element-query on `getAXState`, so a read that leaves out the
  browser rows is unbuilt. Filtering the text after a full walk would not cut the walk.
- Go to Folder in a background TextEdit's Save panel puts TextEdit's windows over the user's window
  for about 0.4 s (owner's report and a window-order capture, 2026-10-11: 05:23:13.249 to 13.680 UTC,
  during the call that sends Cmd+Shift+G, the folder and Return). The front app didn't change, so
  typing stays in the user's window, but the sheet visibly flashes over it. Every textedit-save run
  uses Go to Folder, so it runs only with the owner away until a save path that doesn't flash is found.
- Slack comes to the front when it launches, with no click from the user, both through `cua.getApp`
  and through `open -g -b` (2026-10-11, owner watching). The user's typing then goes to Slack. Codex
  launches apps the same way. The read that launched it returned 161 elements, with channels,
  messages and the composer.
- Electron apps build their Accessibility tree some seconds after launch: a raw walk of Discord 12 s
  after `open -g` found 11 nodes, and one after the engine's read found 509, with
  AXManualAccessibility and AXEnhancedUserInterface still off (2026-10-11). A read right after a
  launch can see an almost empty window.
- Finishing a File > Open panel brought TextEdit to the front for about a second in 3 of about 21
  textedit-edit runs while the owner worked (2026-10-10, WindowServer log), each time just after the
  panel opened the document. The engine's actions themselves didn't. The skill now sends Claude to
  `open_file`, which opens a file with the app in the background; a task that still uses the panel
  can take focus the same way. Whether Codex sees it too isn't checked.
- In a TextEdit typing probe on 2026-10-08, select-all followed by `typeText("engine01")` and save
  left `Engine01engine01` instead of replacing the text. Part of it is macOS auto-capitalization,
  which `typeText` goes through: a later probe typed "sleight is here. it works" and TextEdit saved
  "Sleight is here. It works", while `paste` saved it exactly. Why select-all didn't replace the old text isn't confirmed. Tree sizes suggest a pending
  capitalization suggestion took Cmd+A, so nothing was selected (2026-10-10).
  A separate digit probe passed all five key-by-key and five bulk replacements. The skill says to
  paste exact text and to read the result. [All attempts](benchmarks/2026-10-08-engine-time.json)
  include the failure and later fixture cleanup. A background probe now compares direct engine
  input with default and careful relay guards, and records selected text, the document buffer and
  saved bytes. The shared live hold prevented it from running on 2026-10-09. The cause remains
  unconfirmed. The skill now requires checking an exact pasted replacement before saving.
  It excludes the iOS simulator, where paste can insert the Mac's clipboard.
  sleight-arch runs the affected `textedit-save` and `textedit-edit` tasks before release.
  [The probe report](benchmarks/2026-10-09-exact-text.md) includes the stopped attempt.
- TextEdit hung 3 times on 2026-10-05, each time after Claude set a document's text with `setValue`
  and then pressed a save shortcut (Cmd+Shift+S, which is Duplicate, twice and Cmd+S once). Its main
  thread waits forever on the document's save lock. Every read then times out, and the relay's
  message named a stuck helper. Quitting TextEdit recovered it every time. The relay now checks
  target AX and a fresh engine read of another acquired app before advising an app quit or helper
  restart. The skill tells Claude to select and type in TextEdit
  instead of using `setValue`, and to use Cmd+S or File > Save As. That advice still applies, since a
  `setValue` in a document opened through the Open panel hasn't been retried.
- On 2026-10-06 TextEdit timed out every engine read after an AppleScript `close every document
  saving no`. It still answered AppleScript, but its only window was an orphan "Save Panel Accessory
  View" that Accessibility didn't list. The relay's message again named a stuck helper, while
  `--doctor` passed. Quitting TextEdit fixed it. A read now identifies a possible orphan when macOS
  lists only `Save Panel Accessory View` and the probed app has zero AX windows. The note takes
  the app name and pid from that probe, and is deduplicated by app, process and panel. It asks the user to
  close a visible panel with Cancel or Escape, or save other work and quit and reopen that app
  if the panel is hidden or will not close. Normal document windows and failed AX reads prevent
  that diagnosis. It also depends on Screen Recording permission: macOS otherwise omits the CG
  window names used to recognize the panel. Missing names prevent the orphan note. A second
  AppKit app has offline coverage only. Its orphan-panel diagnosis still needs a live check.
  Reproduced on 2026-10-11 through the engine: a background TextEdit with one temporary file,
  `pressKey("super+alt+shift+s")` (the Save As sheet opened), then `close every document saving no`
  left 0 AX windows and 0 documents while CoreGraphics still listed `Save Panel Accessory View`.
  The next engine read didn't time out: TextEdit showed its Open panel and the read returned it, so
  the orphan alone doesn't explain the 2026-10-06 timeouts, and the cause of those is unknown.
  `bench/textedit-fixes.mjs --orphan` can't reproduce it, because Save As keys posted to a
  background TextEdit's process don't open the sheet
  ([raw](benchmarks/2026-10-11-textedit-fixes-1791691833392.json)). Localized titles remain
  unchecked.
- A benchmark run can act on a TextEdit document it didn't open. In a head-to-head on 2026-10-10,
  Claude typed into two leftover iCloud documents and a Save sheet moved one of them, empty, into
  the task's folder ([report](benchmarks/2026-10-10-h2h-guard.md)). The owner-away head-to-heads
  that night hit it again: TextEdit restored leftover iCloud documents ("Untitled 6" and "Untitled 9"
  in one run, "Untitled 9" in another) when the engine launched it, and Claude worked in those
  instead of the task's file ([2026-10-10-away-2.md](benchmarks/2026-10-10-away-2.md)). TextEdit
  tasks refuse to start while TextEdit has a document the pass didn't open, and the benchmark now
  clears TextEdit's saved windows before its first TextEdit task; the owner moved the two files to
  the Trash. Each new document Claude makes is autosaved to iCloud as the next "Untitled N", so a
  failed run leaves one there. A user's own session has no such guard, and Claude can act on any
  document in an approved app.
- simulator-form failed setup in both Haiku passes after the round-12 fixture code (2026-10-10,
  owner away). The first pass stopped on a DeviceHub handoff while the original was still exiting.
  The second ended "readiness unconfirmed" with one DeviceHub process, which never reported a
  focused window after `open -g`. Cleanup then refused to quit the launched DeviceHub both times,
  and sleight-arch quit it by hand. Setup now counts a finished launch with any window as ready,
  or a finished launch once the simulator has booted, and records which held. Quit names the
  expected and observed PID and bundle. A process with an empty bundle ID is quit only when it
  runs from the expected app's own bundle on disk, so a reused PID is never quit. Unit-tested,
  with no owner-away rerun yet ([round 13](benchmarks/2026-10-10-real-use-tasks-13.md)).
  The reruns on 2026-10-10 evening failed earlier, at `simctl openurl` (POSIX error 60, 3 times),
  and cleanup again refused to quit DeviceHub, whose launched PID it recorded as -1. By hand, with
  the same device, `openurl` took 0.4 to 6.5 s after a fresh boot, with DeviceHub running and
  freshly launched. A blocked event loop isn't the cause: with a live server in the same process, `openurl`
  returned in 0.45 s blocking and 0.21 s async. We don't know yet which step of the task makes it time out
  ([report](benchmarks/2026-10-10-away.md)). The evidence runs of 2026-10-11 failed setup twice with
  "Fixture application readiness unconfirmed"
  ([raw](benchmarks/2026-10-11-simulator-form-poll-1.json),
  [raw](benchmarks/2026-10-11-simulator-form-poll-2.json)): a poller saw the device booted at
  00:54:43 and DeviceHub start at 00:54:47 as one process that never changed, setup waited 34 s and
  gave up, and it recorded the PID as -1, so cleanup again refused to quit the DeviceHub it had
  launched.
- DeviceHub replaced its launch process during `simulator-flow` setup on 2026-10-10. Setup now
  accepts one same-bundle handoff after the recorded PID exits, and cleanup quits only a viewer
  the run launched. The owner-away rerun is pending
  ([round 12](benchmarks/2026-10-10-real-use-tasks-12.md)).
- Writing `launched` into the fixture control file made every Helium setup time out (7 of 7 with
  the field, 4 of 4 without, 2026-10-10). The Helium helper read the file as text-only values, so
  a boolean `launched` dropped the whole file and the helper never saw `opened`. Each failed
  setup left a Form window open. The helper now reads `command` alone, and closes a created window
  that matches the fixture even when setup times out. Live Helium hasn't run with the fix.
- In six simulator runs on 2026-10-09 with shrunk screenshots, the first tap missed the Safari
  field and a second tap hit it. Claude also second-guessed the screenshot's scale, dividing
  or multiplying its own coordinates.
  [Offline inspection](benchmarks/2026-10-10-simulator-focus.md) found the first pointer outside
  the phone in all six resized runs. The parked scaling branch associated its factors only with
  image replies containing a Window header. A first standalone screenshot had none. The original
  image was 2200 × 1600 pixels and the resized image 1568 × 1140. This explains those stored misses,
  but a fresh reproduction and Safari focus timing remain pending. The screenshot reply now includes a
  scale note, on by default, whenever the engine's screenshot is larger than Claude Code shows
  unresized. Claude Code showed a 2200 × 1600 engine screenshot at 2000 × 1455 with a 1.10
  multiplier (2026-10-10, one observation, so the 2000-pixel ceiling is unconfirmed at other sizes).
  The note states the engine's pixel frame, the shown size and the exact multiplier for any app.
  It no longer gives Safari focus or Capture Keyboard advice. `SLEIGHT_SIM_FOCUS_NOTE=0` turns it off.
  A large non-simulator window has offline coverage only. The note has unit proof
  only and changes what Claude does, so `simulator-form` must pass with it before release: 3 runs,
  each first tap inside the phone and on the Message field, with turns per run against the
  2026-10-09 base runs (7, 6 and 7 turns,
  [raw](benchmarks/2026-10-09-shots-base.json)). Coordinates remain unchanged.
- In the 1.0.0 pass, Claude's first tap in the simulator missed the Message field, and four later
  taps on the field followed by `typeText`, one with Device Hub's Capture Keyboard on, left it empty
  (1 of 3 runs). We don't know why the later taps didn't focus it.
- In the iPhone simulator (2026-10-07), Claude's first `typeText` into a Safari field once came out
  garbled and uppercased, and its paste fallback inserted other text: the simulator shares the
  Mac's clipboard. Claude cleared the field both times and typed it right, so 3/3 runs passed, but a
  paste there can put whatever is on your clipboard into the app.
- On 2026-10-08 two calculator-click runs took 16 and 10 turns instead of 5. Right after Calculator
  launched, its first read took 7.1 s, the IDs `AllClear` and `Seven` were missing and then came
  back, and one button's line changed from `Description: 7, ID: Seven` to `Seven` between reads.
  Each change stopped an action and cost Claude a turn. The Mac was under heavy load from other
  processes that day. We don't know whether the load or Calculator's launch caused it. In the next
  full pass that evening, all 6 Calculator runs took 3 or 4 turns. In the 0.16.0 pass, the first run
  after Calculator launched took 10 turns and 99.5 s, 31 s of it in guard reads. Its trace shows
  where: the acquisition launched Calculator and its first read took 15.3 s, then the guard's read
  before the next call's first action took 16.7 s more. Later guard reads took about 0.4 s. Since then
  the guard reuses an acquisition's read for the next call's first action when the app's windows, as
  the engine's inventory lists them (about 11 ms), are exactly what they were before the acquisition,
  or the acquisition launched the app and its one window is the read's. That check took 11 to 30 ms in
  3 live runs, where the full read took about 450 ms. It can't tell if a window of the app changed its
  contents in the seconds between, which the full read couldn't either. On 2026-10-09 we found that
  engine 26.1002.52244 doesn't list windows for any app, before or after an acquisition, so in 1.0.0 and
  1.1.0 the check compared two empty lists and always passed: the first action after an acquisition
  ran on that read, up to 10 s old, unchecked. After 1.1.0 (unreleased) the guard reuses the read only
  when the inventory lists the app's windows, which on this engine means never. A settled full read
  before an action took about 50 ms in 10 trials at loads of 42 to 53, so this adds about 50 ms except
  right after a launch. Within a call, the engine has no faster way to check the window, since `listWindows`
  doesn't exist on macOS.
- Calculator button indices changed during a [preapproval trial](benchmarks/2026-10-04-preapproved-apps.md),
  producing the wrong expression. A filtered read then lost the window header, and the input lease
  stopped the retry. Use current indices from full UI reads, and preserve their window headers.
  Since 0.13.0, `{ id }` and `{ label }` address Calculator's buttons without indices.
- On 2026-10-07 `drag` once refused a Chess window launched in the background seconds earlier,
  because it couldn't find that window among Chess's accessibility windows. It matches by the window's AX number, or by bounds and
  title, and neither matched. The same kind of window matched in another run. Why is unknown.
  On 2026-10-08 (engine 26.1002.52244) it happened again in 1 of 3 runs, in a new game's window: the
  engine's drag answered `-10005 noWindowsAvailable` while reads of the window still worked, and
  `drag` reported the window off screen. The screen was unlocked and the display on. Later that day
  the benchmark's relaunch of Chess, right after quitting it, failed with LaunchServices error -600.
  The [2026-10-08 investigation](benchmarks/2026-10-08-reliability.md) completed ten fresh launches
  through each drag path after the operator authorized closing the leftover game. The engine's
  reads showed e4 in 10/10 calls. Independent AX verified 6/10. Local `drag` acknowledged 8/10 calls,
  with 3/10 moves independently verified. One local call refused a covered source point without
  input. Another ended in a command failure near its 30 s deadline. Native AX omitted e4 in nine
  further move checks, leaving their outcomes unconfirmed. The historical availability refusals occurred 0/20 times.
  In the covered-drags pass that evening, chess-drag passed 3/3 with no window refusal.
  In the 0.16.0 pass, chess-drag's failed run started with Cmd+N on a Chess that already had a fresh
  game, which opened a New Game dialog as a separate, untitled window over the board. It stopped 3
  engine drags and 6 of sleight's until Claude confirmed it 14 calls in. `drag` now names an untitled
  window of the same app over a drag point as a likely dialog to finish or close first.
  Every selected window was on screen at layer 0 with matching CG/AX bounds. All twenty launches
  succeeded after confirmed process absence, without a -600 retry. Space, the historical window
  state and the native command failure's cause remain unknown. Some window captures returned black
  pixels. Clear captures confirmed that Chess's AX square Y positions were inverted; this does not
  explain a window-availability refusal.
  Chess opened at 667 by 532 and 897 by 705 points on 2026-10-10/11. The engine's screenshot is that
  window size, so the 1223 by 949 drag points miss. Live checks now take e2 and e4 from the board's
  AX frames, or scale those 2026-10-08 points by the current window. Unit tests cover both later
  sizes. A live drag with the computed points has not run. An off-screen refusal now tells Claude to have the user show that exact window,
  reacquire the app, and take a fresh screenshot before using current window IDs and coordinates.
  It never retries the old drag or substitutes another window. In a separate minimized-window control,
  the refusal left the board unchanged, and restoring and reacquiring the same window led to a verified
  move (1/1). Recovery from another Space remains untested.
  The benchmark's force-quit fallback
  could return before process exit. Launch now waits for absence and retries only -600, at most
  three times. Unit boundaries pass. The historical -600 cause remains unproved.
- On 2026-10-09 the owner's keyboard stopped working, while the trackpad still did, after a
  head-to-head pass ran the simulator task on both arms. Device Hub, left open after those runs,
  held a keyboard event filter tap whose last key had taken 40 s, and a filter tap holds up every
  key on the Mac. Quitting Device Hub fixed it at once. We don't know what stalled it. Codex's
  simulator run had sent it 24 tool calls in 123 s, sleight's 7 turns in 35 s. The benchmark now
  quits the simulator app after each simulator run, and stops a pass if any benchmark app still
  holds a keyboard filter tap after a run. A user driving a simulator through sleight could hit the
  same stall. When a turn ends, sleight now names any app it acted on in the session that holds a keyboard filter tap,
  once per session, in a notice from its mod: quit that app if keys stop working. That check has unit
  tests, and its tap listing matched the benchmark's on this Mac, but no live session has shown the
  notice yet.

## The real-use benchmark harness

- The away-sitting runner has 8 passing tests and no live run (2026-10-11). Its 13-step plan
  refuses both Codex comparisons: `bench/run.mjs` writes ChatGPT's approval list for that arm,
  which this runner must leave alone. A no-write Codex command is missing. No dedicated quiet-box
  comparison command is recorded either. `.dev/passes/front-watch.sh` is untracked and absent
  from a new worktree; live mode stops unless sleight-arch supplies that existing watcher and the
  precompiled keyboard-tap lister. Any foreground change or enabled keyboard filter tap stops the
  sitting, including unrelated activity. Polling every half second allows input before the
  next report. The foreground watcher compares app names and misses changes between windows of
  the same app. Cancellation and collection of the real harnesses' children are unverified.
  The stale-number and menu-bar harnesses have no SIGINT handler. Signal termination marks their
  app and detached engine cleanup unconfirmed, even when the process group is gone.
  Existing harnesses still handle their own benchmark approvals and permission refusals. The runner
  cannot prevent an inherited harness from reaching a macOS prompt. The owner handles prompts.
  A retained live lock stops the sequence for inspection. Timing estimates include old setup
  failures and exclude some cleanup, so they do not establish a 75 to 90 min completion time.
  Private child logs can contain window titles and need review before publication.

- Shop smoke tasks `real-shop-target` and `real-shop-bestbuy` are Safari-only, `--runs 1`, and
  excluded from default real passes and the head-to-head. They stop at a CAPTCHA or bot check and
  never sign in or start checkout. Ran once each on 2026-10-10, owner away
  ([raw](benchmarks/2026-10-10-real-shop-smoke.json)). On Target, Claude stopped at a "Press &
  hold" human check, as the task's prompt directs. Best Buy failed on sleight's input lease (the
  first bullet under Approvals and guards), not a CAPTCHA. The check then scored the first as a
  plain failure and the second as a CAPTCHA stop. Since 2026-10-11 it records the Target stop as
  `outcome: "human-check"` and the lease refusal as a refusal, in unit tests against those two
  answers. Live cart-page screenshots and store-ZIP UI on those sites are unverified. The local
  Harbor Market tasks ran live on 2026-10-10: helium-shop passed both arms, and safari-shop failed
  fixture setup on both in [shop-1](benchmarks/2026-10-10-shop-1.json) and passed both in
  [shop-2](benchmarks/2026-10-10-shop-2.json) after the title-nonce fix.
- The smoke checks' human-check outcome (2026-10-11) comes from unit tests against the two
  recorded answers. No live run has produced it yet. Whether the cart screenshot attaches on a
  real stop is unverified, and without it the verdict falls back to the missing-screenshot
  failure. The rule reads the answer as one string: a negated CAPTCHA mention anywhere
  ("no CAPTCHA appeared") suppresses the stop verdict, and an answer that discusses leases scores
  as a refusal failure even if it also stopped at a human check. Both errors fail the run with a
  reason that says what the check saw, so no refusal is ever called a CAPTCHA.
- sleight-arch's owner-away Office qualification at `76cf880` passed Excel 1/1 (100.4 s, 29 turns) and
  PowerPoint 1/1 on its second try (51.7 s, 16 turns), with confirmed quits (2026-10-09, load average
  25 to 55 from other projects). PowerPoint's first try failed setup. A first-launch Microsoft 365
  notice ("You're all set", one "Start Using PowerPoint" button) was in front, and every AXTitle read
  returned `-25205` for 30 s, so the fixture's dialog check never named it. The runner's quit then
  stayed unconfirmed while the notice was up. sleight-arch pressed the button through Accessibility
  and quit that PowerPoint. Whether the `-25205` came from the notice or the load isn't known. Raw
  results: [first](benchmarks/2026-10-09-office-qual-1.json), [second](benchmarks/2026-10-09-office-qual-2.json).
- The owner-away Office rerun after brief 10 passed Word once in 42.2 s and 10 turns. Excel's model
  reported saved edits, then AXFocusedWindow returned `-25204` and cleanup remained unconfirmed.
  PowerPoint didn't run. Cleanup reads now have a shared 15-second wait for that error, with
  fake-clock proof. The [brief-11 report](benchmarks/2026-10-09-real-use-tasks-11.md) retains the pass.
- The Office rerun after `b8f4b3f` failed Word's first AXFocusedWindow read with `-25204` and zero
  retries because Word was already running. It remained running after an earlier unconfirmed cleanup.
  Excel correctly stopped on “Start Using Excel”. PowerPoint did not run. The
  [brief-10 report](benchmarks/2026-10-09-real-use-tasks-10.md) traces Word's retained process and
  records the fix: both running cases receive bounded initial-read retries. Live proof is pending.
- The owner-away native web pass at 14:19 UTC on 2026-10-11 passed `safari-validation`
  on sleight in 18.4 s, then stopped after Codex failed it and cleanup reported an owned
  Helium window still open (`bench/results/2026-10-11T14-19-10-653Z.json`). The shared helper
  named the wrong app. Cleanup now uses the request's app name. Each observed new window
  has an indexed record. Cleanup confirms removal by reference from the app's window list. It uses
  File > Close Window so an extra tab does not turn cleanup into a tab close. Attached app
  dialogs receive only AXCancel; unsupported cancellation, system dialogs, access prompts,
  disabled or ambiguous Close Window commands and unconfirmed reads stop cleanup. A second
  created window is recorded and left open because its creation alone does not prove ownership.
  An unconfirmed close or a remaining second window keeps the pass stopped and the live lock held.
  App quit is refused until created-window cleanup is confirmed, including final pass cleanup.
  The focused offline suite passed 98/98 tests. No live run has checked this change.
  English File and Close Window menu titles are required.
  sleight-arch must run `safari-validation` and `helium-validation` once on both arms, then all
  40 native web IDs once on both arms. Traces and rows must confirm owned-window removal,
  preserved pre-existing windows, app-correct errors and per-window reasons on any refusal.
- The browser-depth pass at 13:46 UTC on 2026-10-11 stopped after 5 result rows
  (`bench/results/2026-10-11T13-46-12-844Z.json`). Safari's validation fixture failed on both arms
  before a model call because the JXA New Window menu item was unavailable or ambiguous.
  Helium validation passed on sleight in 19.3 s and failed Codex's state check in 28.5 s; that
  check is unchanged. Helium's extension task stopped on its browser site-permission prompt
  after 18.6 s. The hook used for benchmark approvals cannot answer that prompt. Extension selections
  now refuse before driver preflight unless `--extension-sites-allowed` is present. The owner
  must first allow `127.0.0.1` in the extension's site settings. The flag does not verify those
  settings or answer prompts. A permission refusal still stops the pass.
  The 10 new page kinds have offline
  server-state and generated-handler coverage, including wrong rows, a drop one slot off, wrong
  tabs and values entered on the reference tab. Those tests do not render a browser, exercise a
  native date popup, dispatch pointer input or measure the 1 to 3 s delay against a real clock.
  Safari and Helium now select their earlier helper and launch paths from browser table data;
  the correction has 0 live runs. Chrome, Firefox and Arc retain the JXA New Window path. Their
  setup and retained-window cleanup need live proof. Extension variants require a connected, identifiable
  Helium, Google Chrome or Arc extension. The runner's `surface` field records the API choice. Traces must
  confirm the API actually used. Extension turn-end cleanup and reference-tab closure also need
  live proof. sleight-arch must run the 40 native IDs without Arc on both arms once, then the
  20 extension IDs without Arc on both arms once after the owner allows the loopback site,
  and publish all 120 runs. Arc's 20 new IDs remain unqualified. The older six
  page kinds keep their checks, and Firefox's older grid and SPA keep their earlier setup.
- sleight-arch's owner-away pass at `b284b05` passed 11 web tasks once each (2026-10-09).
  Word made its edits and saved, but its ZIP entry was rejected without identifying it. The file
  was removed during cleanup. Its rejection remains unexplained. Excel setup ended on `-25205` after
  15,002 ms of AX retries, then normal quit remained unconfirmed after five seconds. PowerPoint
  did not run. The [brief-9 report](benchmarks/2026-10-09-real-use-tasks-9.md) retains both passes.
  ZIP compatibility, startup polling and longer quit waits have unit proof and await live qualification.
- sleight-arch's earlier owner-away qualification passed round 6's Helium, Preview, Finder and TextEdit tasks
  3/3 each (2026-10-09). Safari failed setup 3/3, then failed address selection after a Start Page fix.
  Round 7 reached the correct dense article but stopped when cleanup rejected its navigation.
  Word stopped mid-task on an unrecognized dialog, leaving its unsaved fixture open. Excel and
  PowerPoint did not run. The later brief-9 pass supplies browser and Word result-dialog proof.
  The [brief-8 report](benchmarks/2026-10-09-real-use-tasks-8.md) retains all five architect result files.
  Finder averaged 112.5 s versus round 5's 57.2 s, chiefly from extra Claude turns and drag attempts.
- Mail import and export still need live proof. Mail and Mimestream wait until the owner can watch them.
  Mail requires an already-running app and stops when local ownership or mutation coverage is
  unavailable. Its native export path lacks an independent current flag/read receipt and stops
  before a model task. Import controls and folder topology remain unmeasured.
  [Round-7 results](benchmarks/2026-10-09-real-use-tasks-7.json) retain both dry attempts.
  Brief 7b adds five Mimestream navigation slots on the owner's Gmail. They require explicit AX
  read-state, count and window ownership proof. Their desktop qualification is also unstarted.
  Sandbox probes lacked Accessibility access, and a host retry couldn't find a running Mimestream process.
  They stopped before mailbox reads or input. Native app behavior remains unqualified.
- The earlier [round-6 diagnostics](benchmarks/2026-10-09-real-use-tasks-6.json) retain the setup
  failures preceding the architect's qualification.
- Real-use round 2 completed 3 of 18 requested model trials, with 1 pass (2026-10-08).
  Helium failed twice after dismissed browser permission requests that the system observer missed.
  [Round-2 results](benchmarks/2026-10-08-real-use-tasks-2.json) retain every attempt.
- Real-use round 3 stopped before a model trial when Safari launched, but an AX read failed with
  `-25204` and cleanup was unconfirmed (2026-10-08). sleight-arch later found only its start page.
  [Round-3 results](benchmarks/2026-10-08-real-use-tasks-3.json) retain the failed setup.
- Real-use round 4 opened Safari's File menu, then failed to find “New Window” (2026-10-08).
  Its title-based recovery claimed nothing was created, and the pass stopped with 17 slots unstarted.
  [Round-4 results](benchmarks/2026-10-08-real-use-tasks-4.json) retain that attempt. Title-based
  recovery has since been removed. A missing owned reference leaves cleanup unconfirmed.

## Tests

- On a heavily loaded Mac, two tests can fail on timing: the one where a timeout collects a process
  group (`tests/preapproved-process.test.mjs`), and the one where a stuck probe restarts the
  app-health helper. At load averages of 102
  to 107 (2026-10-10), the first failed 1 of 3 runs alone and both failed in a full check. At load 23
  the full check passed. Rerun `npm run check` when the load drops before reading a failure there as
  a bug.
- Rich-text preservation through the removed TextEdit clipboard path never completed a qualified
  background move. On 2026-10-11, 2/2 runs stopped at a disabled Paste item with text unchanged
  and clipboard restored. A throwaway Cocoa app showed that AppKit disables Paste during menu
  validation without a key or main window, and AXPress then returns status 0 without pasting.
  [Recorded failures](benchmarks/2026-10-11-textedit-fixes-1791679610865.json) and
  [review](benchmarks/2026-10-10-textedit-fixes-3.md) retain the earlier attempts.
  There is no rich-text preservation option in `drag` as of 2026-10-11.
- On 2026-10-11 the engine's read of the owner's Helium (one process since 2026-10-10, about ten
  windows) timed out twice with `-10005 timeoutReached`, 30 s and 60 s. The input lease needs that read
  before `cua.getBrowser`. The extension's tabs couldn't be opened from that session. Whether the
  window count causes it is unmeasured.
- Driving Helium's Claude Console tab from a session that had used the engine (2026-10-11), the input
  lease refused `browser.nameSession(...)` and later `tab.goto(...)` on a tab from `cua.getTab` with
  the native "bundle ID and full window header" refusal, after `cua.getState()`.
  `cua.createBrowserTab(browser.browserId, url)` went through. Some of those calls were in parallel,
  so that live trace is unclean. A fake engine reproduces it. After the session has seen the engine's
  Computer Use docs, a later browser reply that includes those docs again cleared every handle,
  including the `getBrowser` and `getTab` bindings that reply had confirmed. A second binding in the
  same call was never recorded. The relay now records every such binding from a `browserUse` reply
  after that clear. A native `app.click` in that session still gets the native refusal. No live
  Helium Console run has checked this.
- iPhone Mirroring (2026-10-11, one owner-present run): `app.scroll` at 0.3, 0.6 and 1 page left
  the Settings list unmoved (3 tries). The skill tells Claude to use Settings' search field when a
  list does not move. A tap during a page animation opened Personal Hotspot instead of General.
  The tree is the Mac window and menu bar, so the engine's settle wait cannot see the iPhone screen.
  After an action in an app whose tree is window chrome only, the relay waits for two matching
  screenshots, up to 1.5 s, and records the wait in the trace. Unverified: live
  `iphone-mirroring-settings` ×3 with no tap outside Settings > General > About.
- With every test file running at once, the app-health restart test and the doctor's pipe test each
  failed one full check at load 9 to 11 (2026-10-10) and passed 5 of 5 and 3 of 3 runs alone.
  `npm test` now runs 4 files at a time.

## Hosts and platform

- The desktop app's Code tab runs Claude Code 2.1.293 (2026-10-08), new enough for the mod. The owner
  checked it in Auto mode twice. On 0.15.2 the pane drew no picture, because Auto mode refused its
  snapshot. On `0.15.3-pane.2` it worked: `/sleight` opened the pane and sent the prompt, Claude
  used sleight from its first call, the pane showed Calculator's picture and 6 actions, and the
  status line showed `Calculator · 6 actions`. The desktop's own command picker still says
  "/sleight isn't a command here", though the mod handles it. `/sleight stop` hasn't been checked
  there.
- Without the mod, the relay ends the engine's turn once no sleight call has run for 30 seconds, which
  releases the app the engine was holding (its badge on the app's window). Before 0.3.1 nothing ended
  the turn until the session closed. Desktop sessions twice showed as busy after Claude had finished,
  and ending the turn cleared it once, so the open turn is the likely cause.
  `SLEIGHT_IDLE_TURN_END_MS` changes the wait, and 0 turns it off.
  A rejected `turn_ended` previously forgot its original turn. The relay now retries it after the
  configured idle interval, with fake-engine proof for explicit and idle cleanup errors. Lost
  replies, calls that never finish and hook delays remain unconfirmed. The
  [turn investigation](benchmarks/2026-10-10-turn-lifecycle.md) does not connect this error path to
  either historical desktop incident.
- It's macOS on Apple Silicon only. The engine's JavaScript has Linux and Windows instructions, but
  the helper that clicks and types comes only with the Mac ChatGPT app, and there's no ChatGPT desktop
  app for Linux (checked 2026-10-04). We haven't checked the Windows app.
- Cursor and generic MCP clients can use sleight's native approval panel and idle turn cleanup
  (unreleased). The panel still names Claude under Claude Code, and it is unit-tested only: no live
  approval in another host has been checked. Unanswered relay forms expire after five minutes.

## Battery reports

The 2026-10-11 13:14 UTC battery stopped after 1/34 planned rows. Its TextEdit row took 23.4 s
and 5 turns and saved the fixture marker with DONE replacing PENDING, but the fixture window stayed
open. Cleanup returned `CLEANUP_UNCONFIRMED` and retained the live lock. sleight-arch closed the
exact fixture document and released the lock. The old row's `passed: false` included cleanup;
rows now preserve the task check in `passed` and `checkCode` and report cleanup separately.

Cleanup diagnostics record each retained window's AXDocument URL, expected URL, read status,
close-button outcome, sheets and closure after 10 s. A scripting fallback closes only the run's
temporary fixture, after its retained window's exact URL is checked again, and records the path.
An unmatched window, failed window read, sheet, unsupported scripting or launched app that stays
running stops the pass and retains the lock.

After `d421e0c` cast the close-button Ref, sleight-arch measured TextEdit passing 4/4 runs with cleanup
confirmed and AXPress status 0 (2026-10-11). The next full battery stopped on its third row.
Codex's Word run failed in 1.08 s with `RUN_FAILED` and `HOST_NOT_STARTED`. The row omitted the error
message and preceded any model call. Word had launched with a restored document from an older benchmark folder beside the fixture.
sleight-arch closed both windows and quit Word.

Startup failures now record `cleanupDetails.startError` with the host's message, stage and window
count. The count is null when unavailable. The application Ref is cast before reading AXWindows.
Only an app the run launches receives `--args -ApplePersistenceIgnoreState YES` on its `open` command.
A foreign document observed during that startup is recorded with `retained: false`. The host leaves
its window open and stops before a model call. The pass retains the lock. An absent document URL
also stops that startup because fixture ownership is unconfirmed.

These changes passed 8/8 new offline regressions, each failing with the original code,
and 41/41 battery tests. This branch has had zero live runs. Native casting, persistence suppression,
Word saves, scripting fallback and launched-app termination still need live checks. sleight-arch must
run `node bench/run.mjs --suite battery --owner-away --tasks word --runs 1`, then the full no-seed
battery, and publish every run. Both Word arms must start, save the expected fixture and confirm
cleanup. Every launched app must exit before lock release. Any restored foreign window must remain
unclaimed and open, with its document recorded and the pass stopped with the lock kept. A startup
failure must include its message, stage and window count in the published row.

The offline battery reporter has no live qualification yet. Codex model API time can be unavailable;
its model and host scheduling gap is not a substitute. Sampled focus and window overlap count
observed episodes and can miss events between samples. They cannot identify whether the agent or
the owner caused a focus change. Shared engine helper CPU may include another session's work.

The fixed bundle hash assigns approximately half the apps to each group, without forcing equal
group sizes. The reporter requires matching run coordinates, completion times, flag values and setup
metadata for a later flag A/B and leaves candidates unproven when evidence is missing. It compares the held-out sample
without a statistical significance test, which limits claims about a population effect.
Harness rows without bundle IDs need a saved task catalog. Calls without unique transcript links
use harness metrics when present, and otherwise remain unmatched. Transcript call counts that
disagree with the harness use the measured harness counts. Mixed setup or load reports are refused.
The reporting lane supplies an
unfilled [report template](benchmarks/battery-report-template.md).

## Desktop replay

Routines have qualified live in part ([first live run](benchmarks/2026-10-10-routines-live.md)):
`record` built a 2-step Calculator script, `replay` ran it 2/2, `routine add` printed the launchd
job after the argument-grammar fix (`8904dcc`), `run-now` passed 10/10 steps behind the idle gate,
and `remove` waited for typed confirmation. A launchd-scheduled run still needs a release that
contains routines: the installed 1.1.0 copy has none, and its scheduled run exited 1. Demonstration
recording remains unqualified live: the native preflight on 2026-10-10 didn't have Accessibility or
Input Monitoring access, and `record --watch` hasn't run. We didn't request or answer a permission
prompt.
Routines acquire by bundle ID and confirm the window title (and URL when present) from the read
before input. A name lookup can still launch an app that exited between the native check and
`getApp`. Title and URL matching is unit-tested. Live Calculator and TextEdit confirmation is not.
Recording only supports initially empty TextEdit fields, and checks using constructed events do not
prove app notification delivery. The installer and notification tests use simulated transports.

The pane logs replay step outcomes when the replay tool returns, showing a running entry and Stop
until then. Desktop button delivery and automatic handoff still need the owner's check in the Code tab.
A recorded script over
4 MiB exceeds the mod's process-output limit. Use the CLI with an output filename for that script.
Refresh gets its replay target from a literal `getApp` name. A script that acquires only an object
or window ID may leave Refresh targeting the earlier app.
A pane replay is untested in Auto mode, where the classifier may refuse the mod's `replay` call
because the mod doesn't approve it (the classifier refused the pane's snapshot on 2026-10-08).
The same literal `getApp` names decide which apps the next prompt asks Claude to read in full after
a replay.
