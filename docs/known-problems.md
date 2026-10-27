# Known problems

What doesn't work, or works only partly, with the measurements behind it. We found all of these in
our own runs. Dates and engine versions are given where they matter.

## Before you start

New apps need an approval card, and `claude -p` cannot answer it. The [install validation limits](../README.md#install-validation) apply, and the engine
refuses terminals and OpenAI's own apps. See [approvals and guards](#approvals-and-guards) before an unattended session.

- First access can be slow: one Calculator acquisition took 29.475 s, including 27.683 s inside the engine after approval ([engine and helper](#the-engine-and-its-helper)).
- The helper can crash: 4 segfaults were recorded from 2026-10-05 to 2026-10-11 ([engine and helper](#the-engine-and-its-helper)).
- Full screen and Split View can break background drags and reads: 8 of 21 runs failed in a Split View pass ([pointer and drags](#the-pointer-drags-and-hover)).
- A covered window can prevent a drop: TextEdit moves passed 3/3 uncovered and 0/3 covered. `drag` now refuses a covered drag and points to `app.drag` ([pointer and drags](#the-pointer-drags-and-hover)).
- Turbo may ask about an honest checkout: on 2026-10-15, 50/98 honest payment fixtures allowed without asking (83/98 in round 12) ([browsers](#browsers)).
- Safari may stop between opening a tab and typing: 36 of 36 Codex chains and 19 of 19 Claude Code chains stopped. The fix is untested live ([approvals and guards](#approvals-and-guards)).

## Character sharing and creation

- Character discovery relies on observed host records. Claude Code 2.1.309's `version: 2`, `projectPath`
  and `CLAUDE_CONFIG_DIR/plugins`, and Codex 0.164.0's `plugin list --json` shape were measured on 2026-10-26.
  The host contracts don't document these formats, and unsupported records don't expose packs.
- A symlinked Claude config or plugins root must resolve under the user's home and remain owned by
  that user. Child symlinks are refused. Skipped roots and packs appear with reasons in the Cursor
  menu and `cursor list`. A plugin without a readable manifest does not expose its characters.
- Codex installation status is cached for one menu open, with a 3 s CLI deadline. Reopen Cursor after
  installing or removing a plugin. Claude records and pack bytes are rechecked before import.
- The make-character generator needs macOS `sips` and Node 22+. The installed plugin includes it.
  Tested with `cwebp` 1.6.0. Other versions fall back to PNG. A missing encoder or failed encode also uses PNG.
  Built-in rebuilds still require `cwebp` 1.6.0 and refuse failed encodes. The output directory must be new and
  have no symlink ancestors. Review the six light and dark contact sheets before import.
  An offline build does not establish how a character reads in motion over real windows.
- Codex CLI 0.164.0 ignores `disable-model-invocation`, measured on this Mac on 2026-10-26.
  sleight's Codex manifest lists only `"skills": "./skills/drive-mac-apps/"`, keeping make-character out
  of Codex's model-visible skill list in that measurement. This single-skill-folder route is observed,
  not documented upstream. Other Codex versions are unverified. Claude Code keeps make-character
  available through explicit invocation with `disable-model-invocation: true`.

## Release qualification

- Release qualification applies to the final integrated commit. The 1.5.0 manifests, doctor output and unreleased
  CHANGELOG heading must agree in the integrated tree. The full check, release pass and final-build A/B remain required
  on that final commit. Passing offline tests does not qualify a release.
- Finder's recorded setup smoke failed at 21:16Z on 2026-10-20 with `Finder fixture window inventory unconfirmed` before
  creating a window or opening a folder. Cleanup was confirmed, but the failed run retained its live lock until
  the operator removed it at 21:26Z. A later run at 02:58Z on 2026-10-21 refused an unavailable AppKit launch time
  before any AX probe or fixture action. Its helper exited and cleanup completed; the exact empty lock was recovered
  after a durable receipt. Finder identity now uses the kernel's exact process birth time. The 03:09Z retry passed
  that check, then refused one inventory entry as `non-window-or-stale` before any action or relaunch. Cleanup and
  helper collection completed. Its receipt was retained and the exact empty lock recovered. Fixed-string native
  calibration corrected a raw-reference diagnostic error. The 05:15Z retry identified the initial entry as an
  `AXScrollArea`. Setup now retains the baseline references with their exact roles and accepts only new `AXWindow`
  candidates. The 05:33Z smoke reached menu selection but failed before retaining a window identity. Whether the
  New Window command ran is unproved. Helper collection completed; window cleanup is unconfirmed, and its fixture
  remains retained. On 2026-10-21, the owner closed irrelevant windows; a durable owner-release receipt then
  permitted removal of the exact empty lock. This does not establish automated window cleanup. Finder setup, Go to Folder
  ancestry, respawn and cleanup need qualification, including the `cc-list-native` fixture. The `textedit-two-windows` fixture
  remains parked unless its failure recurs. For either fixture, cancellation must stop owned setup work.
  Cleanup must preserve baseline windows and retain the lock when
  ownership or cleanup is uncertain. Receipts must exclude owner text, and timeout evidence must bind the same
  process instance. The offline recovery, ownership and app-absent cleanup changes passed tests and review.
  The owner approved exclusive Finder setup and the remaining window-focus assumption. Failed smokes and lock
  recovery establish no successful live repair.
  Future failures preserve fixed reason categories for setup, cleanup and menu cleanup, plus bounded native
  error metadata. The earlier discarded error remains unknown. The new diagnostics cannot resolve its cleanup.
- Offline portability checks do not establish Linux compatibility. The path guard must pass without exemptions on
  the final tree. Actual Node 24 Linux testing remains a release gate.
  The helper prepares the exact commit with usable Git metadata, mounts that snapshot read-only and tests a writable
  container copy with isolated dependencies. Offline tests cover its shared receipt contract and asynchronous cleanup.
  The Colima wrapper
  isolates VM state and Docker configuration and pins engine commands to its owned socket. VM startup and teardown
  passed in the host attempt, including container removal. The first sandbox and host attempts stopped before npm.
  An exact-commit retry failed during copy preparation with `ERR_FS_CP_EEXIST`.
  Failure receipts now report the stage, bounded error code, Node version and destination state. A recognized copy
  collision reports a normalized relative-path hash and closed path category, never the raw path or stderr.
  A diagnostic retry identified an empty destination-root collision on Node 24.22.0. Docker now starts in `/`,
  leaving the guarded copy to create `/w`. A later test run was interrupted after failures, with child collection,
  container removal and VM teardown confirmed. A diagnostic using Docker's init process completed on 2026-10-21:
  12,283 cases, 11,198 passed, 11 failed and 1,074 skipped. Cleanup was confirmed. The failures exposed environment
  assumptions, a connection-close race and a latency test affected by sample order. These results belong to that tested
  commit. A later candidate preflight at `f7dd9c79` passed on 2026-10-21: 12,297 cases, 11,223 passed,
  1,074 skipped and zero failures, with container and VM cleanup confirmed. Subsequent changes require their own
  complete Linux receipt.
- Candidate and tagged-release preflights must verify the same clean final commit through completion, including
  the Linux receipt. These model-free checks do not require a quota reset. Candidate mode accepts an unreleased
  heading and keeps `releaseReady: false`. Release mode requires a dated heading and the intended tag at that exact
  commit. Private terms need an external file and human review. A generic Linux account's history scan does not
  prove the owner's identity was checked. Publication remains a separate owner decision.
<a id="native-harness-in-141"></a>
- The 1.4.1 benchmark harness makes native tasks slower. The 1.4.0 plugin's mean total on 8 native held-out tasks was
  420.7 s on the 1.4.0 harness (5 runs) and 515.8 s on the 1.4.1 harness (3 runs), with more model calls on
  textedit-two-windows, word-brief and textedit-notes-table. The cause is not found yet. The harness's fixture setup
  changed most (Finder ownership and recovery). Native results from the two harnesses are not comparable until then.
- The final-build driver has only offline proof. It rejected the historical `validation-140-final` bank because
  the task, prompt or harness changed. The architect must select compatible A evidence or collect a fresh A/B,
  then run three new rounds per selected group on the final integrated commit. Later merges require another run.
- Workflow-documentation A/B has offline test and review evidence. Electron live qualification did not complete:
  one host attempt timed out waiting for a card with 0/22 cells complete, and a retry was interrupted after two
  cards were accepted. Recovery quit that exact fixture through its normal Quit. Its host and adapter later
  exited, and repeated process-absence checks permitted release of the exact lock. Recovery preserved the evidence.
  Model-backed release passes, final-build A/B, workflow A/B and the Electron
  arm wait for the planned quota reset and an owner-approved away window. The owner approved a second benchmark
  VS Code window and bounded foreground during its host-loss launch. Electron still needs a turbo startup receipt
  matching the final plugin and Node runtime, plus live qualification. Interrupted Electron runs need separate
  exit and lock-ownership evidence. The repaired runner closes admission on interruption and requires a checked
  drain before cleanup. Unknown effects retain the app and pipe owners. Receipt publication precedes lock release.
  Combined cancellation and recovery checks passed 286 tests. On 2026-10-21, the repaired runner was interrupted
  after the owner rejected the card layout. It collected the fixture and workers, removed its profile and released
  its lock. That run completed 9 of 18 qualification cells. Relaunch did not run. The receipt retains editor
  accessibility failures, unconfirmed second-window setup and a pointer movement of 5 px. The fixture now enables the
  accessible editor and retains bounded setup diagnostics and background failure samples. These changes need a live retry.
- Electron debugger and relaunch requests now use the same automatic styled presenter as shell app approvals.
  Their existing choices and input guards are preserved. The launcher supplies the installed icon path, and the
  presenter plays Glass on initial display. The owner rejected the live Electron layout on 2026-10-21. Its
  replacement uses one button row, a shorter explanation and expandable technical details; ordinary cards also
  remove unused bottom space. The revised layout and Electron sound await the live retry. The owner separately
  reported one normal card and normal sound for a fresh Grok Bot Chess request, with no repeat prompt in that session.
  The helper remains an unbundled accessory process, so styling alone does not
  establish computer-use discovery or input support. Qualification logs distinguish requests and answers from
  uncorrelated observations of a visible matching card.
- The first native reference uses origin captured during the existing isolated startup call. A live relay
  comparison on engine 26.1013.40934 reduced it from 19,743 to 19,542 characters while preserving policy and all
  text outside the API block. Unknown formats, metadata or changed context keep the full reference. The broader
  4,600-character target remains unmet, and latency and token savings have not been measured.

## Flag A/B limits

- Across five alternating rounds with Haiku 5.5 at high effort, open-shot won by about 1.1 SE
  (5.8 s, SE 5.2 s) and the screenshot sentence by 1.5 SE (34.2 s, SE 22.7 s). Those margins
  come from `flags-score.txt`. The error estimate excludes pass-rate uncertainty. The screenshot
  rows measured Word only, word-memo and word-brief. Neither flag's held-out A/B measured Excel
  or Opus. See the [four flag A/Bs](benchmarks/2026-10-19-flag-ab.md) for every task and attempt.
- Both skills restore `60fe1319`, including the original submit safety passage. Only the default skill adds
  the exact measured screenshot sentence. The screenshot A/B never measured lean.
- `SLEIGHT_COMPLETENESS` and `SLEIGHT_OUTCOMES` stay off until an A/B runs (60 attempts planned on three native tasks).
- Page-declared totals can be wrong, and unseen server-side rows stay unknown. A row over 40,000 characters stays cut. The browser picker makes one extra metadata read. Final-answer honesty is unmeasured.

## Approvals and guards

<a id="protected-consent-input"></a>

- Through 1.4.2, the Mac operation-review, session opt-in and resume alerts put Allow first. One physical Return could
  approve without a typed word, and a held Return could repeat into the alert. The 1.5.0 candidate clears protected defaults
  and requires the typed word for keyboard approval. It also refuses repeated key-downs. Protected choices wait 500 ms.
  This fix has headless fixture coverage only. 1.5.0 has not been released.

- The launcher's low-stakes settings commands (`hand`, `cursor`, `turbo off`, `permissions block` and the other ones that
  only narrow what sleight does) check only that a person started them from a terminal app, by reading the process's
  ancestors. A terminal window an agent opens through `open`, AppleScript (`do script`) or a `.command` file starts from
  launchd like any other, and computer use typing into it passes. For high-stakes changes a session under 10 s old is
  refused, which slows an agent that types at once but doesn't stop one that waits. A script an agent starts in a terminal
  it opened can write the settings files directly, past every check. High-stakes changes also need Touch ID or the password (1.5.1). No real
  Touch ID or password sheet has been shown from sleight's helper yet, so that path is unit-tested only.

- Remote approvals (1.5.0): a person at the Mac who hasn't touched the keyboard or pointer for 120 s counts as away, so an app
  card ends the call instead of waiting. A typed `allow <app>` covers only that app's low-risk cards. Medium and high-risk
  cards, Terminal, iTerm2 and OpenAI's apps still need the Mac. Typed grants and the up-front ask work only in the session
  scope (`SLEIGHT_APPROVAL_SCOPE=once` and `document` ask at the Mac). The up-front ask picks apps by matching the prompt's words
  and missed 12 phrasings in a review, such as "email Sam" and "turn this into slides" (2026-10-25). Not yet checked on a
  real capture: whether `@file` content or a transcript-link click ends up in the typed first line, and whether the engine can
  drive apps while the Mac is locked.

- In 1.4.0, Always allow, payment and sleight consent buttons require a person's physical click or key press.
  The native guard rejects Accessibility presses and posted input. VoiceOver, Switch Control, Voice Control and
  screen-sharing users need a physical keyboard or pointer for these cards. 1.5.0 adds a typed word plus Return from a physical
  keyboard. Switch Control's on-screen keyboard still cannot answer. Plain session-only app approvals can still use the host's prompts. Decline and Cancel remain available.
  Mac consent arming has headless fixture coverage, including the first activating click. Real AppKit activation order
  and assistive-input behavior remain unmeasured. When an inactive alert has no click event, sleight checks recent
  hardware mouse-down timing and that the card is the top window under the pointer. A poster at the HID tap could pass that
  timing check too. That only keeps the 500 ms delay from restarting, and approving still needs a real down and up on the
  card. When neither check passes, the first click can show "Too soon: try again", and a second click after 500 ms works.

- When a card or menu-bar alert closes, sleight returns activation to the app that was in front just before the card
  was clicked. This also happens when a card times out or is aborted while the card's own app is in front, even if
  the person switched to that app themselves. The card's app itself is never activated. Only fake-driven tests cover
  this (2026-10-22). No live run has confirmed it yet.

- On the engine path, Haiku 5.5 stopped before Create account in 18 of 24 requested sign-up runs
  (AS-3, 2026-10-19). The engine listed account creation under Always confirm, even if pre-approved,
  while sleight's requested-form rule covered only [9] and [10]. The owner ruled on 2026-10-19 that a
  sign-up the user's own message asks for, naming the username or email and password, is confirmed.
  RS adds that exception to the account policy. Both skills keep their original submit safety
  passage. Focused tests cover the text. The live sign-up A/B has not run. `SLEIGHT_RS=0` restores
  the old account-policy wording.
- The preapproval loader proves file ownership, not who wrote it. The mod refuses Claude's file edits
  and common shell writes to it (unit-tested, 2026-10-12), but any other process running as you can
  write it, and a path built at run time gets past the check.
- The consent-host refusal (2026-10-18) hasn't run against the live engine. It assumes the engine's approval card and read
  header name the host as `consent-host`, its file or its pid. A `getApp` argument computed at run time is checked only at that
  card. We haven't checked whether the engine's `pressKey` to another app can answer a frontmost host card, or whether the
  engine's own clicks at a point under the card press its buttons. Any process named `consent-host` is refused, sleight's or not.
- The form rule decides "safer" from the switch's name and the value the message gives. A setting whose name doesn't say which
  way it goes still asks. `SLEIGHT_CONFIRM_PAYMENTS=always` keeps form and switch confirmations too.
- The hook that keeps `SLEIGHT_OUTCOMES` and `SLEIGHT_ACTION_LOG` the user's choice matches text, so it stops
  mistakes and plain edits only (unit-tested, 2026-10-18). A script Claude writes and then runs, a config file
  reached through a symlink, a name built at run time, a config file it doesn't list, and another MCP server's
  shell tool all get past it. It sees only Claude Code's Write, Edit, MultiEdit, NotebookEdit and Bash.
- `sleight-mcp stats` (1.4.0) splits a call's time evenly over its actions, so one slow action in a batch raises
  the others' times. Approval prompts come off a call's time, but turbo's own confirmation cards don't. On the
  engine's browser path sleight counts the input calls written in the code. A loop counts once and an untaken
  branch counts. That path stays out of the menu row. Reads saved uses the positions of the code's last read and last action
  to decide which reads Claude asked for. Turbo counts one read saved per diff it returns. Unit-tested only: no
  live run has checked these numbers.
- `claude -p` can't answer approval prompts. List apps in the user's [preapproval file](settings.md#preapproved-apps) before starting.
- `sleight-mcp setup` hasn't had a full live run: macOS permissions always need the user's click.
- The engine refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex, Atlas, with
  their beta builds). The list is in the helper; [a setting](settings.md#driving-apps-the-engine-refuses)
  lifts it. sleight's `blocked_app` path was removed on 2026-10-11.
- A call goes on past its own menu, navigation or dialog-close stop only if macOS's HID idle time covers the whole call. The engine's
  background clicks leave it alone (10 of 10 clicks in Calculator, 2026-10-17), but some of its key presses reset it:
  `typeText` 3 of 3, and `pressKey` 3 of 3 right after a click, 0 of 4 right after another key. So a call that opens a menu
  or navigates by key (Cmd+Down in Finder) may stop as before. We don't know why a key after a key doesn't count.
- Only plain action statements split this way. Of the 7 word-edit calls (2026-10-17) that clicked OK on Word's Replace All
  alert and then stopped, 5 now split; the 2 with `.catch()` on an action still stop. None has run live yet. A dialog-close
  continuation also needs HID idle since the document was last seen as a standard window, so any mouse or key input
  after that stops the rest. It also stops when the app has a second window with the same title and URL, when the
  dialog's own native identity couldn't be read before the call, and when a palette closed by a button can't be shown gone.
- The tab continuation (a call's own Cmd+T, or a click on the button among the tabs, going on into the new tab) ran live in
  3 Firefox mdn runs, all Cmd+T: b7-r1, b3-r1 and b3-r3 (2026-10-19). In the 2026-10-18 round it ran 0 of 9 times (6 Cmd+T,
  3 clicks), and the cause wasn't recorded. It no longer needs HID idle over the call, which the engine's key presses reset
  (above). It needs idle since the stop result arrived, so a user typing after the stop still refuses it. The relay trace
  records the refusal reason and the idle sample, but no traced round has run since.
- Safari's tab continuation never fired in race-1017, where Cmd+T followed by typing stopped 36 of 36 runs inside Codex and 19 of 19
  Claude Code chains. It also stopped 6 of 6 times in the b10 to b12 rounds (2026-10-19), a turn each.
  Safari's Start Page has no page content, so the navigation continuation took the stop first and then
  failed its idle check. In 1.4.0 the tab checks run first, a `Value: on` tab counts as selected, and a window that showed
  no tab bar may show two tabs, the old one named as the window was. That case needs Claude's last tree of the window
  whole, so a Cmd+T after a read with folded or trimmed lines still stops. None of this has run live yet. Safari's toolbar New Tab
  button still stops, since it sits apart from the tabs. `SLEIGHT_FS=1` still names the keyboard route only for a window
  whose strip shows a selected tab, so Safari's one-tab window keeps the plain sentence. `SLEIGHT_TABC=0` turns all of it off.
- After a tab continuation's Return, a result whose tree still names the new tab under the page's header reads again,
  every 150 ms for up to 1.5 s (Firefox mdn inside Codex showed the New Tab tree in 2 of 37). It compares only the root's
  title with the header, so a window whose root title never matches its header waits the full 1.5 s. Not run live yet.
- sleight's shorter js description hasn't matched the engine's text since its 2026-10-16 update, and never matched the
  computer-only text most sessions get, so Claude reads the engine's description with only its first-call rule rewritten.
  That text lists `cua.getState()` before `cua.getApp()`, and 39 of 72 b10 race runs opened with getState. `SLEIGHT_FS=1`
  pins both current variants. Every engine session reads it, and its native A/B (2026-10-19) passed 24 of 27 against 25 of
  27 with word-brief 67.2 to 100.2 s, so it stays off until a reworded text passes one.
- A continued call's result reports the second engine call's `codex/nodeReplExecutionDurationMs`, not the sum. In Firefox
  1.13 to 1.70 s per Cmd+T call fell outside it (b10, 2026-10-19): most likely the first call (a plain Cmd+T and read took
  1.20 to 1.29 s) plus two helper probes, whose time isn't measured yet. The relay trace now records the stop's engine
  time (`stopEngineMs`) and each probe's (`probeMs` on `tab-continuation-checked` and `tab-continuation-forwarded`).
- A key call whose window comes back retitled doesn't get a window note when its tab strip is the one Claude last saw for
  that window plus exactly one selected tab (a new tab in Firefox, 12 of 60 b3 and b7 task-runs). A tab switch or a new
  window keeps the note. Another window of the same app also loses it when its strip lists every tab of the last-seen one
  plus one selected tab. The old title must be a whole tab label, plain or Firefox's `Value: <title>, <title>`. Tabs count
  only from the window's own tab group, before any page. Only Firefox's strip is tested, and Safari and Chrome may still
  get the note.
- A read between the menu click and the next action (`const menu = await app.getAXState()`) doesn't split either, so the
  call stops at the menu, as textedit-save-2 did (2026-10-17). The guard doesn't pass a menu's header (title and app, no
  URL) on its own: only the continuation checks the native window behind it.
- The light check before typing after Return (`SLEIGHT_GUARD_LIGHT_RETURN=1`, off by default) hasn't run live. It waits 250 ms
  after the key where the engine's settled read waited about 400 ms, and we don't know how late alerts and sheets appear after
  Return, so one that takes longer can miss it. It stays off until we measure that. Its native
  observer starts on the engine's `press_key` approval, so an engine that stops asking per action leaves only full reads.
  We haven't measured how much the observer's AX polling (every 25 ms for 700 ms after a key) slows the app.
- `open_file` asks for its approval while sleight looks up the app. When that lookup or the input lease fails first,
  sleight counts the approval as declined and asks Claude Code to cancel its prompt (we haven't checked that Claude Code
  closes it). sleight's own panel stays up until answered, the answer grants nothing, and later approvals can show beside it.
- A plain `window` root (a palette, Word's Styles) that its own button closes continues into the standard window it covered
  once the native check shows it gone. That's intended. A popover root does the same; one without a title stops, since the
  helper skips untitled windows and can't show it gone.
- Of the 7 popover stops in the 2026-10-17 office study, 6 ran on the build without palette continuation and 1 (Escape, then
  Cmd+H) was refused for HID input: the engine's own Escape after a click resets HID idle, so an Escape close rarely continues.
  A click close doesn't need a key, so it should continue. Neither has run live.
- The parent lease (the window under a dialog that closed between calls) hasn't run live, and fires only on the relay's
  recovery re-acquisition after the lease dropped. A call whose first action finds the document while the lease still holds
  the dialog stops as before. It never takes the window under an untitled dialog or palette, since the helper can't show one
  gone, so Word's alert (3 of the 7 stale refusals in the study) still stops. A rest with a literal element number stops too,
  since the number may be the dialog's.
- Since `typeText` and `pressKey` can reset HID idle, a dialog-close continuation won't fire after keys sent after the
  document's last standard read. The Word Replace All run sent Escape and Cmd+H after that read.
- Over a window without a URL, a dialog or sheet continues only when that window's native identity was certified at its
  read, so a never-saved document usually stops. A window titled Untitled (or Untitled 2) that a click brings to the
  front passes the guard as one the click opened, so "Don't Save" can still end up in another Untitled window.
- Before the GA1 fix the relay's recovery getApp launched apps nobody asked for (GA1, 2026-10-18, two events in one session).
  A call that began `app = await cua.getApp("Google Chrome")` after the lease dropped got a getApp of the last app in
  front of it, and the engine launched that app, Helium, which had quit. A result that echoed a `Window:` line left the
  old target in place, and a later `h.click` recovered to Chrome and opened its profile picker. The in-engine guard
  refused the actions in both, so no input was sent. Recovery now skips a call that contains its own getApp, takes
  the app from the code's handle, and checks the app is running first. Unmeasured: how many quit-app launches the old
  code caused outside these two events, and whether the 600 ms running check is long enough on a loaded Mac (no answer
  refuses the call, with the usual advice).
- The helper quits after about 20 s idle, and its new epoch may refuse a certified identity read before a long gap.
  We haven't seen it happen. The first live Word trace should show whether it does.
- A standard window counts as covered only if its app's process was known when it was read. The relay probes the
  helper once per app; if that fails, the next dialog close over a window read before any other process note stops.
- A batch of numbered or named actions reuses the call's first read until an opener, so an action that rebuilds the
  elements it holds (a date picker after its first date) makes the engine refuse the next number. We've seen this once
  (Firefox travel, 2026-10-17). That call still stops, and that window, by app and URL or title, then reads before
  each numbered or named action until three of them pass, about 50 to 400 ms an action (the read timings measured
  2026-10-09). The read after the refusal gives up after 5 s, and the note then doesn't list targets. We can't read the
  engine's source, so we don't know for sure that a refused number doesn't send input. The stop doesn't resend it.
- A batch remap after a renumber (1.4.0) follows a line without an ID, description or help only under the parent Claude saw,
  and never under a bare-role parent such as `row` or `group`. With `SLEIGHT_COMPACT_ACQUISITION`, `SLEIGHT_RESULT_TRIM` or
  `SLEIGHT_COMPACT_TOOLBARS` on, the relay takes those parents from the trimmed tree Claude was shown, where omitted groups
  leave the wrong parent (a probe gave `button Next` for days under `group October`). Those batches stop instead of remapping.
  If one of those settings becomes the default, the parents should come from the untrimmed tree.
- With VoiceOver or Switch Control on, any Accessibility client, the engine included, can focus the handoff word field and take key focus from the page. The check reads a system-wide flag that a privileged process can toggle.
- Screen readers cannot pick a cursor style from the menu, the same limit the consent cards have. Use a hardware mouse or Return or Space on a highlighted row.
- Typed confirmation needs a physical keyboard, so cards can't be answered from Switch Control's on-screen keyboard. The mask length is readable over AX. VoiceOver reading and key-window behavior are unverified live.
- Waiting handoff covers owned turbo browser tabs and native apps with a lease. Document-scoped native mode and Electron turbo still stop.
- After a turbo worker is lost, sleight disconnects it and stops using it but doesn't kill it. If the worker's event loop hangs, we haven't verified that its sign-in card goes away.
- A local tool call admitted before a browser handoff begins can still run once its own approval completes, while the handoff waits. The handoff fence doesn't recheck calls it already admitted.
- Turbo reuses a full package verification for up to 1 second. A same-user process writing through a live shared mapping on APFS changes bytes without changing file timestamps. The verifier can accept such bytes in that window. Bytes restored before the next full verification escape detection. A lasting change is refused at the first check after the second ends. Verification isn't atomic with later code loading.
- The card lasts 4 minutes, and a shorter host tool timeout ends the wait earlier. Closed shadow-root login forms and custom auth controls are not checked. A populated text field beside a login form refuses resume.
- The shell guard reads literal commands only. Once any loop uses sleight, it fences launchers for every caller in that mod registration. Each loop's completion removes only its own fence. Codex, Cursor and Grok hosts do not get it.
- Split-pane teammates have separate mod instances. Whether their launch loads the lead's plugin and mod needs a live check. Promptless teammate cleanup has only offline coverage.
- A child prompt cannot lift Stop. Send a new message to the lead to resume sleight. An abandoned child's refresh, record and replay fence expires at the lead's next completion, session start, compaction or Stop. Its shell fence (launcher commands refused) stays until Stop or a new session, and compaction never lifts the shell fence.
- Missing or relative HOME and CLAUDE_CONFIG_DIR values refuse writes that need those roots, with a path-resolution message. Literal paths still get protected-file and alias checks. A plain `ls` passes. Malformed hook envelopes get a generic refusal message.
- Variables, aliases, ANSI-C quoting, ssh, scripts on disk and encoded payloads (`base64 | sh`) get past the shell guard. It can also refuse harmless text, such as a launcher word in interpreter process arguments or any `osascript` or `launchctl submit/load/bootstrap/kickstart`. How the installed host presents a denial is unchecked.
- The optional PATH command is stored in a user-writable folder, so a process with your shell can rewrite or shadow it just
  as it can `git` or a shell startup file. Claude's guards refuse direct writes by name to `~/.local/bin/sleight`, its
  `.sleight-shim-v1` file and `~/Library/Application Support/sleight/settings-link.json`, while globs,
  hard-link tools and aliases can evade the name check. Doctor reports hash mismatches as tamper evidence, and changes that widen access still need Touch ID
  or your account password.
- Uploads refuse group-writable files (including files made under umask 002), writable parents, mutating ACL entries and unreadable metadata. Copy the file to a visible file in Documents. Folder uploads are unsupported. The iCloud and `/Volumes` exceptions ran on synthetic metadata only.
- Cookie handling is model guidance plus a guard on identified containers. A container counts when it's a known CMP root, or a fixed, sticky or dialog element under 1,500 characters with a consent phrase.
- Unknown CMPs in page flow, absolute banners without a dialog role, unrecognized labels, CSS-only labels and wording outside the covered languages pass the cookie guard (CW2 lists missed phrasings). The engine path has no positioning signal. Some ordinary dialogs ask instead of accepting: one headed "Cookie settings", "Please allow cookies and sign in again", or "By using our services you agree to our Terms and Cookie Policy". Model compliance is unmeasured.
- Turn stats need the Claude Code mod. Native action counts without outcome receipts are code-site estimates. Tokens cover the host's whole turn, and cost is the session-ledger delta. Whether the host accepts the late usage update, and the pane layout, are unchecked live.

## The pointer, drags and hover

- Cursor narration is off by default and takes its sentence only from Claude's assistant prose. Tool results and
  thinking blocks are excluded as sources, but Claude can paraphrase screen text in its prose. Names and short secrets
  such as `hunter2` can pass the filter. It strips recognized key shapes, long tokens and Luhn-valid cards, including a
  card beside other digit groups. A matching numeric run is removed whole. This is a partial privacy filter.
- Narration assumes the assistant row's `session.append` fires before its `tool.call`. The first live narration call
  must check that order. A reversed order silently omits the sentence. The response-only matcher excludes tool-result
  rows from the mod hook. Live RPC cost per row and tool call, and the share of real calls with a usable sentence,
  remain unmeasured. Voice skips speech when the output device doesn't expose readable mute or volume metadata. The first
  live voice run must check that no permission prompt appears. Sprite bubble placement, capture exclusion and voice
  on real audio devices remain unverified live.

- The ghost hand is off by default. When an app doesn't send per-action approvals, the hand can run ahead of the field
  being filled. Its frames follow a planned schedule, about 470 ms, then 72 ms per action, instead of the engine's
  writes. GH8 remains blocked: engine-persisted Always allow can consume action requests without exposing supported
  per-action events to the relay, and retries and paste need correct action/attempt correlation. The partial pacing
  candidate stays unmerged. The existing visible-hand behavior is unchanged. Visual qualification and the A/B
  required to change the default have not passed.
  A caller-owned FIFO experiment delivered 16/16 events from fake methods in the engine sandbox on 2026-10-21,
  but failed on uncertain group cleanup. After verified recovery, a new run passed four cases with 40/40 events
  and complete cleanup. Invocation/return delay was 0 to 9 ms with action and retry identity intact. Completion
  could arrive after the next action began, so this proves neither current-action pacing nor native dispatch.

- The sprite cursor style's decode child uses the private `sandbox_init` call with an SBPL string, tested on macOS 27
  only. If it fails, characters show the ring with reason `sandbox`.
- The sprite decode child is bounded by the host's 2 s deadline and 0.5 s reap, and 8 descriptors. It has no memory
  limit (macOS 27 refuses memory rlimits), and its 2 s CPU limit only raises SIGXCPU, which compromised code can ignore.
- The sprite style is checked in the dump mode, an offscreen render and a live host with no window. Its look on screen,
  capture exclusion and live memory are unmeasured.
- Perch mode hides the character on windows with under 40 pt above their top edge, which covers maximized and near-top
  windows. Cast characters peek until the edge is about 100 pt down, and Codex pets until about 123 pt.
- Perch mode notices a minimized, moved or covered window after up to 0.5 s awake and 2 s asleep, not A2's 120 ms.
- Perch mode reserves 80 pt for the traffic-light buttons, plus an 8 pt gap before the legs. Companion window metadata
  on this Mac puts their right ends 72 to 79 pt from the left edge. The first live run must confirm the margin visually.

- DP1 can skip a close shortcut's final read only when fresh native metadata matches the leased
  bundle ID, PID and process start. Both the window count and modal count must be 0. Missing identity or
  unknown metadata keeps the read. Delayed Save sheets and separate dialogs still need live checks. Before release, sleight-arch must
  check Cmd+W on an unsaved TextEdit document with its sheet and an unsaved Word document.

- Anything moving your real pointer in the app interrupts it. The engine watches real mouse and keyboard
  input to notice a person taking over, then makes Claude re-read the app. Another agent driving in the
  foreground counts too. Background sessions share the helper, with leases coordinating sleight's actions.
- Accessibility moves write plain text: on 2026-10-11, 3/3 background moves of a bold red word in a
  covered TextEdit window came out plain black Helvetica. Text whose formatting differs from its
  paragraph's takes the posted or foreground drag within one window (unit-tested, 2026-10-12). With DP7 on,
  cross-window moves of formatted text refuse instead. A paragraph
  formatted the same throughout still goes through the plain write, and whether the posted drag keeps
  formatting is unmeasured.
- With the Claude app's window over the board (2026-10-09), the engine's `app.drag` moved a pawn
  (1/1) where `drag`'s background posts at the same points didn't (0/2). `drag` now refuses a covered
  drag that has no selected text and points to `app.drag`. On that board `drag` took 11 to 14 s, 9.4 s
  of it reading the window's elements through System Events. That scan now uses the Accessibility API
  with a 0.5 s deadline (unit-tested, 2026-10-12). Its live timing is unmeasured.
- In the 2026-10-17 Firefox settings runs, `drag` refused 22 covered endpoints and the engine's
  `app.drag` left the list order unchanged in 13 of 13 retries. `drag` now moves a covered endpoint to an
  exposed point inside the same element and adds one stationary move on the destination before the
  release (raw headless mouse input missed the drop 6/6 without it and landed 6/6 with it). Both are
  unit-tested only. Whether Firefox accepts the drop, and whether Accessibility's hit test answers
  for a point another app covers, are unmeasured. The new point must be on a leaf item (row, cell,
  button, text, or a childless group or image) and on that element itself, 4 points clear of any
  other app's window, so a web row with child elements often refuses. A fully covered row refuses.
  `lib/reorder-plan.mjs` plans the shortest drop sequence and refuses to repeat an ineffective
  method. No tool calls it yet.
- After an Accessibility text write, TextEdit's next Cmd+S deadlocked on the document's save lock in 10
  of 13 probe trials with the file opened through the Open panel (0 of 3 opened with `open -g`), the
  same hang as `setValue` on 2026-10-05. One Shift press and release posted to TextEdit's process after
  the write prevents it: 0 hangs in 10 trials that edited, against 5 in 8 without it, and then 10
  `drag` moves in a row saved with no hang (2026-10-09). We don't know why the event helps, or what
  held the lock. A Cmd+S posted to a background TextEdit's PID doesn't start a save. The 2026-10-08 hangs
  came through the engine's `pressKey("super+s")`.
- Posted events repair the verified space after a text move. Posting only works when no other app's window covers the drag
  points, because macOS picks the drop target from what's on screen there: 3/3 TextEdit moves with
  the window uncovered, 0/3 with this Claude window over it (2026-10-05).
- Safari's web text areas ignored Accessibility text writes (1/1 on 2026-10-09). With DP7 on,
  cross-window moves in apps that ignore those writes refuse instead of falling back to a posted
  or foreground drag. Within one window, the mouse paths remain available.
- DP4's changed-lines read can add up to 5 s to a text-drag result. It appends nothing without
  a prior full tree for that window, or if the read fails or times out. Live timing is unmeasured.
- `CGEventSetWindowLocation` is a private macOS API. Missing symbols, invalid events or coordinates that fail the
  round trip skip background posting and select foreground. Future macOS updates may break this path.
- The foreground drag is the last resort. On 2026-10-08 it took the owner's focus mid-sentence
  during a pass, and a typed space went into TextEdit, so it now waits for 2 s without any input (up
  to 10 s), and stops if keys are typed once it has taken focus.
- There's no background hover, since engine events go to the app and the real pointer never moves.
  Hover captures screen pixels in the selected window's rectangle. A window spanning displays could
  include another app in that rectangle, as a Chess trial showed, so hover now refuses one.
- When you work in a full-screen or Split View Space, apps sleight drives in the background are on
  another Space. Clicks and typing still reach them, but the engine's `app.drag` answers
  `noWindowsAvailable`, sleight's `drag` refuses the off-screen window, and TextEdit's reads timed
  out. A pass with the Claude app in Split View failed 8 of 21 runs, all in TextEdit, Chess and the
  simulator (`docs/benchmarks/2026-10-08-await-split-view.json`). Moving a window into a full-screen
  Space needs private macOS APIs, so leave full screen while sleight drags.
- A menu opened by Accessibility in a background app can remain in its tracking loop. The app then ignores quit and window
  closes. On 2026-10-16 the benchmark's own cleanup did this to TextEdit, Preview and Word (TextEdit's main thread sample showed
  `NSMenuTrackingSession`), and AXCancel on every menu didn't release TextEdit. The cleanup no longer opens menus in apps it
  launched. Claude can still open one through the engine. The relay warns that Escape doesn't always close a background
  menu, and how often a session leaves one open is unmeasured. On 2026-10-17 an A/B run left Word in that loop with its Window
  menu open (main thread sample). AXCancel closed the menu, but Word still ignored Apple events. One Escape key event posted to
  Word's process with `CGEventPostToPid` released it, and Word then closed the fixture and quit by script.
  Safari fixture setup cancels its File menu and polls for clearance after a failure before creating a window. Without a
  profile-proven window it cannot post Escape. If AXCancel leaves the tracking loop stuck, cleanup reports it and may leave
  Safari running. No live check has qualified this failure path yet.
  Safari fixture cleanup also stays unconfirmed if a menu item's AXSelected is unreadable. That attribute still needs live qualification.
- textedit-window-drag has never passed (0 of 12 recorded runs, 2026-10-16 to 2026-10-19). In all 4 transcripts of 2026-10-19,
  `drag` with `toWindowId` first refused the drop as covered by the cascaded source window. The fixture now places the two
  windows side by side in the display's visible frame, which no live run has tested yet. Two more `drag` faults showed up there,
  both fixed on 2026-10-19 and not yet run live. The Accessibility text move failed with "Ref has incompatible type" in all 64
  benchmark transcripts that tried it (2026-10-16 to 2026-10-19): the formatting check passed a malloc'd buffer where JXA
  wants a Ref or null. The cover check also counted two system windows that the window server doesn't send clicks to. One is the
  Dock's tiling backdrop (layer 0, left on screen after Move & Resize). The other is Notification Center's full-display window
  (layer 21), on screen while a banner shows. A Mimestream banner appeared at 15:38:53Z, half a screen from the source point,
  and `drag` refused the source point as covered. Claude then called `notifications`, the arm's approval was refused, and the
  pass stopped. Now a macOS background agent's window (activation policy not regular, bundle under /System/Library) stops
  counting as cover at a point if the system-wide Accessibility hit test there returns an element of the drag's own app.
  Every other window still counts. In a read-only probe on 2026-10-19, that hit test returned the TextEdit window
  under the Dock backdrop. No banner was on screen during the probe. The banner case is untested and assumes the window server
  routes clicks outside the banner to the window below. A banner over the point still stops the drag, and the refusal now says
  to wait about 5 s and retry once.
- `hover` still counts every on-screen window in front of the point as a blocker, and the same two system windows can refuse it.
- In both Firefox settings runs of 2026-10-17, `drag` by element number failed on the web list's rows (3 of 3 tries), so Claude
  used coordinates. Claude then sent 3 drags in the shown image's 2000-pixel frame, while the engine and `drag` read the
  2560-pixel original. Those runs got the frame note late or never. It now comes with the first screenshot of each window
  size, and a `drag` result gives the frame it read (unit-tested). Whether Claude stops sending the shown frame is unmeasured. All 7
  background drags there reported `deliveryVerified: false`, the 6 that moved a row included, since `drag` verifies only text.

- The benchmark's drag audit (`bench/world/method-check.mjs`) credits a drag that follows a nested labeled block whose inner
  `break` targets the outer label (`outer: { inner: { break outer; } await app.drag() }`), though that drag never runs. A peer
  review found it on 2026-10-13. No recorded run wrote such code.

## Browsers

- Turbo's short browser and Electron tab handles have 45 random bits, less guessing resistance than UUID v4's 122.
  An independent guess hits one registered handle with probability 1 in 35,184,372,088,832; with N records the probability is
  N divided by that number. Handles select already owned records and don't grant approval. Allocation checks retained records for
  collisions. `SLEIGHT_MT=0` restores UUID handles. These checks are unit-tested. Live model-time A/Bs remain.

- In 1.3.1, turbo couldn't add a second item to a multi-select list that needs a Command-click. In its Chrome release pass
  (2026-10-19, Haiku 5.5) form-settings stopped before submitting in 2 of 5 rounds because Japanese couldn't join
  Portuguese (Brazil) in its Languages list. Opus passed it. The model stopped and said so, and nothing wrong was submitted.
- A turbo click whose page re-renders under it comes back "page changed during the click" and the model reads and
  retries. On 1.3.1's release-pass checkout that loop ran 6 to 7 times in 4 of 5 Haiku rounds (36 to 42 s against 21 to
  26 s without it), and in 1 of 3 rounds of 1.3.0's pass.

- `app.pickFromList` ran on held-out Safari and Firefox web lists in 1.4.0 validation (2026-10-20), 3 runs a side.
  If Page Down doesn't move the list's accessibility rows, it stops with "no-progress" and Claude falls back to a
  scroll loop.
- The offscreen-row note hasn't run against a live app. It needs the engine's role words to equal the accessibility role
  descriptions and the list's rows to match one for one; otherwise the result reads as before. It covers rows in lists,
  tables, outlines, browsers, collections and grids, not a control below a page's fold.
- The renumbering guard still stops when an element is inserted at the target's own depth right before it. The relay
  rewrites `{ id: "N" }` to element N from the tree Claude saw last, and says so in the result.

- Turbo v3 sends Enter and Space (and Shift+Enter or Control+Enter in a text field) through the page keyboard inside the click
  shield: a hook registered before page scripts is armed with the checked element and its form (action, method, target, enctype,
  default submitter and its formaction and formtarget) before the key goes out. The whole seal must match at the first keydown; from
  then on only those routing facts must, so a handler that disables its own button or changes its label is not a veto. The hook cancels
  any keydown, keypress, keyup, click or submit that lands elsewhere or after the routing changed. The key goes down and up in two
  halves. The other frames are locked, and a deny lock is also put into every document created while the key is in flight, before
  the page's own scripts (a page-session script for frames in the page's process, a script the CDP filter puts into each frame in
  another process before resuming it; Playwright's `addInitScript` is not used, because it also runs at once in a document that has
  already started). A frame in another process (a cross-site or sandboxed iframe) is reached through the filter's own session for
  it, not through Playwright, which often never attaches such a frame. The filter sends the port guard, the child auto-attach, the
  hook script and the resume as one burst, because one extra round trip before the resume of an iframe's first target left the
  frame unattached in 3 of 3 runs, and it turns the Page domain on before adding the script (without it the browser took the
  script and never ran it). It sends `Target.setAutoAttach` once per session, to a page from its first session only, and answers
  a caller's repeat without sending it. Chrome drops the pending load of a cross-site frame nested in a cross-site frame when
  a second one arrives, and the page then stayed "interactive" with `browser_open` waiting its 3 s (22 of 24 loads at depth 2, 23 of 24 at
  depth 3, and `page.goto` on an open depth-3 page hung in 5 of 20; now 0 of 24, 0 of 24 and 0 of 20). The key asks each frame's hook for its tree (the same-origin windows below it, each with a hook
  id and the child count from a getter captured before the page's scripts), a frame reached by two routes counts once, and the key
  goes only when every child the windows count is reached and every hook was there at the start of its document (a hook put in
  later sits behind the page's own listeners, and such a frame paid in 9 of 36 presses in a repro before the check). A
  script-created frame whose first navigation is same-origin reuses the window of its empty document, where the commit leaves the
  hook's listeners registered but dead, so between the halves the key waits (up to 400 ms) for such a navigation to commit and puts
  the listeners back in every frame. The hook also puts them back after `document.open()`, `write()` or `writeln()` on a loaded
  document. The outcome says "the key may have activated; read the page" when something was cancelled, because events before the
  cancelled one were delivered. Enter and Space also go through the click path's popup handling. A link or form that would open a
  new tab opens in the background, and a flip in the page's own click handler is cancelled and rerouted. Once the key's click or
  submit has passed the shield, a later key release is only checked against the field it should reach, since it has nothing left to
  activate and the flip is already handled. Measured on 2026-10-15: 0 payments in 48 inserted-frame presses, 32 same-site navigations,
  24 re-pointed frames, 40 frame-focus presses, 72 cross-site presses with a keyup payer and the document.open repro, and
  the key goes through on 48 of 48 first presses on six ordinary pages with cross-site, nested, lazy and sandboxed iframes (it was
  25 of 48). A keydown handler that changes the default submitter's name or value or a hidden input of the form is vetoed, since
  the seal includes them. The hook's replacements of `addEventListener`, `Document.prototype.open`, `write`
  and `writeln` and of the other natives it wraps keep the native's name, length and `toString` text (through a replaced
  `Function.prototype.toString`), and are methods without a `prototype` property. Every call the key path makes to a
  hook carries a one-use proof and opens the signed answer, like the click path; the script that locks each new document uses one
  proof for the whole key (each document accepts it once) and its answer is not read, so a lock that did not take shows only in the
  later surveys of each frame's tree. A script-less sandboxed frame (a sandbox without `allow-scripts`) fires no listener, so its lock
  is nominal: nothing in it can run, and the key goes through (6 of 6 with the sandbox frame in the key bank); a native form
  submission from such a frame with `allow-forms` and an autofocused field is not vetoed, and we have not tried it. Known gaps: a page can still run a capture listener ahead of the hook on a reused window if it gets
  `addEventListener` from a realm the hook never ran in (a script-less sandboxed frame), registers it before the hook restores its own,
  and creates and focuses that frame in the roughly 1 ms between the last restore and the key release (not tried); a frame with no
  hook from the start of its document (a popup that had loaded before sleight adopted it) makes the key refuse with the engine path.
  A frame that never loads is covered by its empty first document and does not stop the key. A frame
  whose hook cannot be reached within 1 s makes the key refuse with the engine path; Enter on a button
  that opens a modal and focuses inside it, or an inline editor that removes itself on Enter, activates but reports "may have
  activated" because the key is released on another element. A key release that reaches an empty page (the button disabled itself) is
  cancelled without a report. A div, span or custom element with role=textbox (most chat composers) is refused for every key on this
  path when CDP says it hosts a shadow root (a closed one could hide the real receiver), and takes the key when CDP says it hosts none
  (see the closed shadow roots section). The refusal tells the model to use the engine path. Text with a line break typed or filled into a
  single-line input is refused (Chrome submits the form on a bare line break). A textarea takes it. Keys outside a short list
  (Enter spellings, Space, Tab, Escape, arrows, Home/End, PageUp/PageDown, Delete,
  Backspace, F1-F12, one character, with modifiers) are refused on this path; Alt, Meta and other chords with Enter or Space are too.
- `browser_read` scans every frame in another process through a private read session that the CDP filter attaches to an iframe
  target of an owned page (one its own auto-attach chain delivered), with the port guard on it first. It attaches to no other
  target. The filter refuses every other target before any attach goes upstream (other tabs, popups it has not adopted, workers,
  service workers, the browser target). Before this, any page with a cross-site or sandboxed iframe returned "Snapshot unavailable" (12 of 12 reads failed on
  pages with 1, 2 and 5 cross-site iframes at 09c4a4c5). Now 12 of 12 succeed, 40 of 40 reads made right after opening pages with
  five cross-site iframes succeed, and sandboxed iframes (`sandbox`, `allow-same-origin`, `allow-scripts`, both) read 4 of 4
  each, with passwords and card fields redacted as in a same-origin frame. A read of a 5-iframe page takes about 15 ms against
  3 ms for a page with none (medians of 20, three runs). A frame the filter has no iframe route for still makes the read fail
  closed. We have not seen that happen in the runs above, and we don't know how often a slow third-party frame causes it.
- A page that opens a popup from its own script can still take the screen during a browser session. Since 2026-10-13 sleight opens
  links and forms that target a new tab or window as background tabs, but it keeps the page's own click for inline handlers,
  links that need `window.opener`, downloads and anything a script opens, because the engine's read-only page access can't see
  or stop those. The extension's own popup interception sits behind a remote OpenAI flag with no local switch. Before the change,
  sleight's arm took focus 7 times in a 13-task Haiku round on 2026-10-12, against 2 for FowlBrowser's.
  After the change it took focus 9 and 8 times in the two orders of the first 2026-10-13 gate round,
  and 18 times across both orders of the second, against 0 for FowlBrowser.
- Forms failed most in the [2026-10-13 engine-path rounds](benchmarks/2026-10-13-gate.md).
  Across the two gate rounds and one targeted check, 13 of 24 form runs passed, while every other
  task passed 36/36. A custom two-factor switch and checkout failed in each round. These runs
  predate production turbo.

- In a browser started with `--remote-debugging-port`, such as the benchmark's own headless Chromium, a page's speculation rules
  (prefetch, prerender, or rules a script inserts) can request the DevTools HTTP endpoint and close another tab through
  `/json/close`. Turbo's Fetch guards never see those requests, and in a 2026-10-15 probe no per-page control stopped them
  (prerendering off, blocked URLs, cache off, data saver). Turning off Chrome's Preload pages setting stopped all three in Chrome,
  while the headless shell ignored that setting. A browser that turned on debugging through Chrome's own remote debugging consent
  answers 404 on every `/json` endpoint, so there it has nothing to reach. Turbo doesn't check which way the selected browser turned
  debugging on, so a non-default profile started with `--remote-debugging-port` is exposed.
- Turbo relies on Chrome refusing page WebSockets to the debug port by their Origin. A Chrome started with
  `--remote-allow-origins=*` would let a page drive another tab that way. sleight doesn't check for that flag.
- A turbo script click aimed at a frame by its name, after which the page moves that frame out of the document (`appendChild`,
  `insertBefore`, `append`, `prepend`, `before` or `after` into another parent), empties its parent with `innerText`, or deletes it
  with a `Range` or `execCommand`, isn't seen as a re-aim. The new window comes to the foreground and the result says it probably
  did (4 of 4, 2026-10-15). It takes a page written to do this.
- A popup that closes itself while it loads can be missed by turbo's popup discovery. The click that opened it takes about 2 s and
  doesn't report the popup, and the turn's cleanup can list an owned tab as retained. Measured 2026-10-15 with `window.close()` at
  load: 1 of 3 runs before pop round 5, 2 of 3 after. A popup that closes 300 ms after load was handled 9 of 9 times.
- Turbo refuses Enter in a `contenteditable` element with `CHECKED_FOCUS_REQUIRED`, and the steps after it don't run. Typing works
  there. Measured 2026-10-15 on a rich-text editor page.

On FowlBrowser's own 13 tasks (2026-10-12), sleight passed 23/26 in 2,109 s against FowlBrowser's 26/26
in 972 s ([results](benchmarks/2026-10-12-fowlbrowser-h2h.md)). Still open from that list:

- Chrome and Helium both report as "Chrome" in `listBrowsers`.
- An explicit turn end closes finished tabs the session created, but keeps tabs still loading,
  edited forms, tabs handed to the user and deliverables. sleight's arm left 41 tabs open in a
  26-run round on 2026-10-13, down from 74, against 0 for FowlBrowser.
- A payment the user didn't ask for in their own message still stops for confirmation, by design. One the user asked for, naming what to pay and with what, goes through (`SLEIGHT_CONFIRM_PAYMENTS=always` restores the stop). `SLEIGHT_CONFIRM_PAYMENTS=never` also skips the figure check below for such a payment, so a page that hides a larger total behind a matching amount field is not caught. It asks as before for an unrequested payment, a second payment in the same request and an amount that differs from the message.
- Turbo follows a plain `<a href>` to an http(s) URL without asking only when its one payment word is "checkout" and its words contain no money figure. The link also needs to be outside a payment form and free of handler attributes (`on*`, `ping`, `data-method`, Turbo, Stimulus, htmx, Vue, Alpine, Angular). The DevTools protocol must report that nothing on it or inside it listens for click, mousedown, pointerdown, pointerup, auxclick or keydown. A listener on an ancestor or the document doesn't count, because frameworks and analytics listen there on nearly every page (the race's own shop logs pointerdown on the window), so a delegated handler that charges from a checkout-only link isn't caught at the link. The figure check still applies wherever a money figure shows. If the listener list can't be read, the link asks. A page that charges on a plain GET to such a link isn't stopped at the link, and the later "Place order" button still asks. Not measured on a live site.
- On the engine path in Safari and Firefox (the accessibility tree), a guard check holds back the submits on a page that shows a payment:
  card fields, a frame named for card payment, or a money figure above zero beside a control that reads as a submit. Held back are a click
  on a button, link or other row whose words read as a submit, any other button in the card fields' block except turbo's closed list
  (Apply, Remove, a stepper), Enter or a typed line break in any field, and Enter, Space or a click on the confirm dialog. A link to an
  address whose only payment word is "checkout" goes ahead on a page with no card field, as navigation, since the accessibility tree
  can't show the page's click handlers the way turbo checks them. A payment
  goes through when the user's message stated one amount and the page shows it, with no larger figure, once per request. Before it,
  Haiku confirmed an unpriced "Pay $268.00 now?" dialog in Firefox (1 of 1 runs, 2026-10-17), and gpt-6.1-sol inside Codex paid
  the same checkout without asking (1 of 1, 2026-10-19). Live on 2026-10-19, both stopped at Pay now with nothing paid (1 of 1 each),
  and the gate also stopped a cart's "Go to checkout" link, which failed the handoff task (fixed the same night).
- On the engine-path gate's payment page, a control outside the card fields' block whose name has no pay or submit word
  ("Continue", "Next") isn't checked, so a page that charges from such a control gets past the gate (review PG2, 2026-10-19).
  A promo code's Apply, the only button beside the card fields, goes ahead only when an enabled button named for paying
  follows it in the same page, outside any dialog.
- On a payment page, a plain Enter or Return that picks an address suggestion goes ahead (PG3, 2026-10-19): a combo box, or a
  field marked expanded, in the page with no sheet or dialog open, its list beside it, and one selected option without pay words
  that contains the field's value. We tested it on Safari and Firefox tree fixtures only. The gate can't see the page's
  script, so a combo box built this way whose script doesn't cancel Enter submits the form. A button the page gives
  `role=option` and `aria-selected` prints as an option, so Enter on it goes ahead unless its words pay. Card fields are known
  by name, so a card field named "Number" can pass as the combo box. Enter in an address picker inside a dialog is still stopped.
- A click on an element number the tree doesn't print goes ahead on a payment page (review PG3).
- If the engine printed a row's text with a raw line break, the rest of that text would parse as rows with numbers the page
  chose. We haven't checked whether it escapes them.
- Tabs driven through the ChatGPT browser extension (`cua.getBrowser`, `createBrowserTab`), Codex's main browser path, aren't
  checked: the guard doesn't wrap their DOM actions. Covering them remains open work.
- A stopped payment opens sleight's payment card (the consent host turbo uses). Allow once doesn't send the action. Claude sends it
  again, and the allowance covers the one action that matches it (same site, largest figure and control) until a new user message,
  the turn's end or two minutes. A page with no URL row has no site, and no allowance matches it. The relay builds the card's helper
  from the plugin's Swift source, or reuses turbo's build. If the build isn't ready within 20 s, or the host can't start (no window
  server), the payment stops without a card and Claude asks the user.
- Claude's result waits at most 45 s for the card, under Codex's `tool_timeout_sec` default of 60 s (from Codex's config reference,
  not measured here). After that Claude gets the stop with a note to resend after the user answers, and the card remains open up to
  120 s.
- The card's helper accepts any click on its own window, so another automation tool in the session (not sleight's, which refuses that
  process) could press Allow once. turbo's card has the same limit.
- sleight's copy of the user's message comes only from the Claude Code mod, with turbo's turn start. In Codex, and in Claude Code
  with turbo off, every engine-path payment goes to the card.
- The amount is the one money figure with a currency in the message. A message with two figures ("$29 overnight", "$268.00") doesn't
  state one, so it asks. Wording isn't read, so "never more than $300" names $300.
- The words are English only: turbo's pay words plus place (your) order, confirm, submit, complete, reserve, book and buy. A
  control that says only Continue, Next, Finish, Order, Authorize, Approve, Top up or Pledge isn't a submit to the check unless it
  sits in the card fields' block. Card fields labelled only in another language ("Kartennummer") aren't card fields.
- A page counts as a payment page only with card fields, a card-payment frame, or a money figure with a currency sign or code. A
  bare "268.00", a currency in a separate cell from its number, and currencies outside the list (kr, zł, Kč, Ft, lei, RM, CLP) give
  no figure, and a figure split across rows isn't joined. A saved-card or wallet checkout that shows neither isn't a payment page.
  Its Pay button goes through unchecked.
- It doesn't see a figure drawn in an image or canvas, or a payment in a native app window (only a sheet, dialog or alert whose words
  mention a payment and that shows a figure or card words is checked). setValue, typing without a line break and drags aren't gated,
  so a page that submits on an input event isn't caught. A page with no money figure above zero and no card field (a free booking or
  subscription) isn't a payment page.
- On a priced page, Enter in a search or promo field and multi-line text in a text area cause false stops. Enter in
  a field beside card fields counts as the payment, and a later Pay then asks again. A field named "Gift card" or "Business card"
  makes a page a card page. Apply is checked when it is the only button beside the card fields, as on the race checkout. A point
  click anywhere in a window with a payment page stops too.
- The browser's own confirm is told apart by structure alone: a sheet, dialog or alert outside the page, or a second top-level web
  area (Firefox draws its confirm that way). Its 60 s exception after a payment also takes a page's own `confirm()` that shows the same
  figure, so a page could get one extra charge of the message's amount in that window. Cancel, Close, Back, Apply and the rest of the
  closed list exempt only a button with no pay word, so a pay button that labels itself "Back" isn't checked unless it's the only one
  beside the card fields.
- `dragTo` and `pickFromList` aren't checked by the gate. Engine calls in the browser-extension branch can't act on an app at all
  (native input is refused there), so the gate doesn't run on that branch.
- The relay keeps the payment count and resets it with each user message. A link never counts. Codex doesn't send the message, so there
  every later payment in the session asks, and the confirm dialog's exception lasts 60 s. A point click on a payment page stops and
  asks for the element number. The check runs in the engine's JavaScript session like the guard's other checks, so code that edits
  the guard gets past it. With turbo on, a pending card can show a second sleight icon in the menu bar.
- The turbo v3 payment read asks whenever any visible money figure in the payment form or dialog is larger than the amount in the
  user's message, in any currency and with any label or sign (a discount, a was price, a gift card, a late fee, a coverage limit,
  a later total, an estimate, "-$500.00"). It doesn't read wording. Rounds 4 to 12 added label lists that cleared such a figure, and
  every review found wordings that got past them, so round 13 removed them (397 net lines of the read). It also asks for a figure
  in another currency at any size, an image or canvas of 24x8 or more that could show a figure, a number spelled out in words,
  digits with a letter glued on ("$5OO.00"), and a bare number right after a pay word ("Total 500"). Figures in chosen
  controls (a checked box or radio, an aria-checked, aria-pressed or aria-selected element, a selected option) ask when
  their sum, excluding the amount itself, exceeds the amount, because the user pays them on top of the pay figure. The label of an unchecked radio or ARIA option is skipped unless it
  names a total, an amount due or a payment.
- Figures equal to or below the amount never ask, so the read cannot catch a page that hides its total or states a smaller total
  than it charges. Examples that allow now and asked in round 12: "Payment $5.00" beside "Total due $18.00", three fee-type parts
  of $15.00 beside an $18.00 total, "Price: $9.00" with "Qty: 2". 13 earlier fixtures that expected an ask changed to allow for
  this reason. A page can also split a charge into figures that are each at most the amount.
- Honest pages measured 2026-10-15: 50/98 allow (83/98 in round 12), 52/98 with the two hold pages counted as correct asks. Of the
  36 realistic pages, 19 allow; of the round 8 reviewer's 20 pages, 9; of the 12 pages, 7; of the 10 industry pages, 6; of the round
  11 pages, 5; and of the round 12 pages, 4. Every honest page with a figure above the amount asks: a subtotal beside a discount line, a
  was price, an invoice total beside payments received, a coverage limit, a list price, a euro estimate, a free-delivery banner
  with a threshold above the amount, a recommended product. 436 fixture and inline cases that allowed on a label now ask.
- The same read doesn't see a total drawn as a CSS background image, held in a closed shadow root with no text,
  set only in an `aria-label` or `title`, shown in a cross-origin iframe, or placed outside the form element.
  Page text that a person can't read is never accepted as the payment terms, but these are not read at all.
- An Apply, quantity stepper, Remove or "Show order summary" button gives the request's one payment activation back
  at the next payment check, but only if its own name is on the closed list (apply, update, remove, delete, increase,
  decrease, plus, minus, show, hide, edit, change, more, less, +, -) and nothing went out on the network until that
  check. The watch counts requests, WebSocket frames, workers and new pages in all tabs sleight opened in that browser
  context (tested with two). It does not refund when any request was still open at click time (a streaming upload, a long poll, an
  EventSource), or when the browser holds another tab of the page's site that sleight doesn't own (a
  BroadcastChannel or `storage` event reaches it, and nothing watches it). A page with a worker, a service worker, a
  shared worker of its origin or an iframe of another origin is not refunded either, because the connection can't see
  their network. A dedicated worker in any tab the context holds (an earlier popup too) counts the same. A request still
  open when its tab closes or its frame loads a new document stops counting (measured on 11 cases, including 600 hanging
  fetches); one still open after a `pushState`, a hash change, or a 204 or download navigation that never committed
  keeps counting. The watch detaches when the turn ends and after 2 minutes. A charge that waits for a timer longer than
  the gap to the next payment check, or for the next input, is not seen, so a charger that calls itself "Apply" can
  charge once more (measured: a fetch after 6 s and a `sendBeacon` call on the next pointerdown, 2 charges in total).
  A WebRTC data channel or a WebTransport stream opened before the click can also carry a charge, and Playwright
  doesn't expose either. A control with any other name ("Continue", "Next") is never refunded.
- A page with background network traffic (an analytics ping, a chat WebSocket heartbeat, a registered service
  worker, a tax fetch) never gets the refund, so Pay asks once after "Show order summary" there. Measured 2026-10-15:
  2 of 6 such pages allow Pay (the quiet one and one with an already-loaded cross-origin image). Skipping requests to a
  URL the page already sent periodically would let a page hide a charge in its own heartbeat, so it asks.

Fixed since: tab calls no longer take the native input lease, `SLEIGHT_SURFACES=browser` works, a
tab's tree is capped with a note on how to read the rest. Browser-first sessions now defer the
native reference, and oversized first results defer the browser reference while retaining safety text.

- On an unsorted list, `sleight.pickFromList` can pick a prefix match at its scroll limit before
  reaching a later exact row. Its real-tab scroll and searches past index 360 are fixed.
- `app.pickFromList` (native, FM1, 2026-10-18) is unit-tested against a fake list and has no live run. Since CC3
  (2026-10-19) it jumps to the row the labels around it predict, sending at most 16 Page keys between reads. On
  generated and airport-name lists of 1,000 rows it sees the row after 7.9 to 8.8 reads on average and at most 14 to 18,
  against 15.3 to 18.2 and 29 to 36 when it paged four keys a read. A contrived list with 900 rows under one prefix
  takes up to 36 reads. We haven't measured whether Page_Down and Page_Up reach Firefox's list or change its selection.
  It stops, and clicks nothing, when a page key skips every row seen before (a page as long as the rendered window).
- Up to 16 Page keys go out between two reads, so a page script that moves focus mid-burst gets the rest of that burst.
  The next read stops the search. Jumps check the sort order only on the rows they see.
- The focusing click of `app.pickFromList(<list number>, …)` selects a row of that list, which stays selected if the
  search then stops. The list number is checked against the line Claude saw, as a click's is.
- If the focusing click selects a plain list row while focus stays on a passive ancestor, the picker clicks that row once
  more after at least 600 ms. Whether that gives Firefox's list focus is unverified live. If focus stays outside the list,
  the picker stops without sending a key.
- The engine tree may omit actions for a group or cell whose only action is the default press, so the passive-role check is the main protection for nested focus (measured in PL1b review, 2026-10-20).

### Model time in 1.4.0

On four held-out browser tasks (survey-p09 in Safari and Firefox, the ambiguous Firefox calendar and both slow
dropdowns), 1.4.0's model time per turn ran 1 to 7 s above 1.3.1 with equal tool time. The cause isn't established.
The prepared WF3 A/B compares `SLEIGHT_WORKFLOW_DOCS=0` with the default. The flag also changes action-number
compaction, so it cannot isolate wording alone. That A/B has not run live.

### Turbo (on by default)

- Turbo is on by default from 1.3.0, beside the engine's browser tools, with Chrome's remote-debugging consent as the user's step. Its
  [gate](benchmarks/2026-10-16-gate.md) passed on 13 FowlBrowser tasks (547 s against 720 s, 0 errors,
  Haiku 5.5, 5 rounds), but the installed approval flow is not qualified, and no native-app comparison has run.
  The earlier [prototype](benchmarks/2026-10-14-turbo-prototype.md) passed 4/9 with all four forms failing.
- The gate measured turbo on the benchmark's own headless Chromium with a temporary profile, not on a user's Chrome or Helium
  connected through remote-debugging consent. No gate round has run on a real browser window yet.
- Real-window gate smoke rounds, wikipedia only (2026-10-17): FowlBrowser passed on Chrome's per-round copy of the "sleight
  benchmark" profile and on Helium with `--load-extension`, turbo passed on Helium, and Claude in Chrome passed wikipedia and
  mdn on the copy. Claude in Chrome connects from the copy only with Chrome's real keychain key (with the mock keychain it was
  signed out). The gate's Claude Code arms run with `--permission-mode default`: the same login started in auto mode later that day, and
  under auto Claude in Chrome sent each page action to a prompt in Chrome that timed out (3 of 3). Turbo refused this Mac's
  Chrome, whose binary is mode 775, until the signature check below. No gate round has run on that Chrome since.
- Chrome Beta, Dev and Canary, Chromium, Brave, Edge and Vivaldi are in turbo's browser table but unqualified, and turbo stays
  off for them. The operator qualifies one at a time with the owner present. Turn on that browser's remote debugging at its own
  inspect address (`brave://inspect/#remote-debugging`, `edge://…`, `vivaldi://…`, `chrome://…` for the rest), then run
  `SLEIGHT_TURBO_UNQUALIFIED=1 sleight-mcp turbo on --browser <key>` in the operator's shell for that check only. Turbo connects
  to the browser only in a session started with that variable. The check covers DevToolsActivePort in the browser's profile, all
  five tools in an owned background tab, and the input lease stopping on the user's app, tab and focus changes. It also covers
  cleanup of owned tabs. Afterwards, turn turbo off and remove the variable.
- Turbo drives Chrome and Helium only. Safari and Firefox run on the engine's browser path, and neither has been raced. Turbo has
  not been raced against lcu, Cua or Peekaboo on any browser task: they work from screenshots and need a real browser window.
- The native helpers require Apple's command-line tools for their first build. A failed compiler
  leaves the engine path available. Minimum macOS version and Intel builds are unqualified.
- Native consent, selected-profile setup, idle connection longevity, package updates and cleanup
  still need installed checks. Missing or disabled operator configuration keeps turbo off.
- The package check lists every file under the plugin folder. Files Claude Code adds there while sessions run
  (`.in_use/<pid>` and `.claude-plugin/types/`, seen in other plugins' cache folders on 2026-10-16) make the
  receipt stale until the next session start rewrites it. Whether they appear in sleight's installed folder
  mid-session, and so turn turbo off for a running session, hasn't been measured.
- With two sleight copies on one Mac, a 1.4.0 server still rewrites turbo.json's receipt for itself at every start,
  so the other copy fails HOST_PACKAGE_MISMATCH until every running session is on 1.4.1. From 1.4.1 a start leaves
  the receipt alone when its owner copy is still installed and has the same or a higher plugin.json version, and that
  copy's `turbo on` moves it. A start from a newer version takes the receipt over from an older one, whatever
  Claude Code's `.orphaned_at` marker says, so `turbo on` run in the older copy lasts only until the newer copy next
  starts. If turbo-owner.json can't be written, the start result and `turbo on` say so, and a second copy can rewrite
  the receipt at its own start.
- A drag install into /Applications by an admin leaves Chrome's executable mode 775, group admin, and macOS App
  Management blocks `chmod` on another app's bundle. Turbo accepts such a group-writable executable only for qualified
  Chrome (Google's Team ID EQHXZ8M8AV) or Helium (imput's, S4Q33XPHB4) at its place in /Applications or
  ~/Applications, and only when the group is admin (80) or the user's own primary group. Chrome Beta, Dev and Canary
  don't get it, even with `SLEIGHT_TURBO_UNQUALIFIED=1`. The kernel's live status for the running main process must
  show valid code with the kill, library-validation and runtime flags, and the cdhash it runs must match the bundle on
  disk that `codesign --verify` checks against the browser's Developer ID requirement. A world-writable executable, or
  a group-writable one of any other browser or group, is still refused. Setup checks the bundle on disk (54 ms on this
  Mac's Chrome, then cached). The connection checks the process once per browser launch (one codesign call, 20 to 30 ms
  on this Mac's Chrome bundle on disk). The live check hasn't run against a real Chrome yet. Brave, Edge and Vivaldi
  have no Team ID in the table, so they still need mode 755.
- The signature proof covers only the browser's main process. Helpers (renderer, GPU, network) start later from the
  bundle on disk and aren't proven, so someone who can write the bundle after the proof could run code in a helper.
  An older Chrome or Helium with a valid signature from the same team and the same flags also passes, so a downgrade isn't caught. Both
  need write access to the bundle, which macOS App Management limits. A browser update that replaces the bundle while
  the old process runs makes the cdhashes differ, and turbo refuses that process until the browser restarts.
- In the race, 2 of 185 Chrome turbo task starts (2026-10-18 and 2026-10-19, none of 117 on Helium) failed before any
  command reached Chrome, and every later call of those tasks failed too. Nothing kept the real error. Both starts came
  10.39 s after the previous task's first call. Our best guess is Chrome rewriting Local State in its profile folder
  about 10 s after a pref change, during the startup check's codesign call (Helium needs none), while that check
  compared the folder's times. Since 1.3.1 the check compares the folder's identity, owner and permissions, a failed
  start runs once more, and the failed stage and code go to the trace and the task's `turbo-metrics.jsonl`. The cause
  stays a guess until a round records one. A first call that fails to connect after a good start still fails the rest
  of its turn, so a benchmark task, which is one turn, still fails on it.
  Tabs and refs cannot cross paths. Never retry a safety refusal or an uncertain action through
  the other path. Embedded frame hosts are refused for input, while their page reads remain available.
- Screenshots return nothing on pages with protected fields (hidden or offscreen too) or more than 4 separate frame sessions. Taking one pauses the page's scripts for a moment. Motion frames cover click, hover and scroll. Their times are capture requests, not presentation, and fast transitions can be missed.
- Secrets drawn on a canvas cannot be recognized. DPR 2 with 125% zoom is unqualified on installed Chrome and Helium.
- With `SLEIGHT_POINT_INPUT=1`, point input scans element boxes and ignores paint order and `pointer-events`. A backdrop over Subscribe still needs a ref when the button's box contains the point (2/2 refused).
- With point input on, pages over 20,000 node visits, 50 ms of scan or 129 native subjects need refs. So do closed shadow hosts, cross-origin frames and transformed frames. Canvas and video repaints are not detected.
- With point input on, page handlers can still reach a payment control. Both headless fixtures fired payment once, through a forwarding listener and a document-level handler. A `pointerover` handler ran payment twice before the stale-view refusal.
- A page handler that changes `form.action` after the guard is caught only by the navigation notification. A server redirect to `mailto:` or another app scheme is blocked before the browser passes the URL to macOS, in installed Chrome and Helium alike (2026-10-25). A popup the page opens itself with `window.open` can still reach Mail. Each page load pauses once at its response for this check.
- Ready, quiet pages can return before a later timer adds content. A "text gone" wait cannot prove absence over masked content.
- Links mode omits destinations the protected snapshot does not expose, including closed shadow roots. Browser reads write `_ariaRef` on element wrappers in Playwright's isolated world, so they are not strictly DOM-write-free.
- Turbo downloads take observed HTTP(S) links on the page's exact origin, redirects included. They refuse executables, archives, HTML, SVG and unsupported types, and have no blob, scripted or POST-only exports. Files stay until the user removes them. The engine-path download stall remains. Chrome and Helium attachment handling is unverified.
- Exports cover the rendered collection. Virtual rows, spanning cells, redaction and caps (10,000 rows, 256 columns) report incomplete, and a closed shadow root anywhere on the page blocks completeness. Hidden-text omission is best-effort and affects only the file. Native tables stay on the engine.
- PDF reads extract text only. Scans need OCR elsewhere. Locked PDFs refuse, and find and refs are unavailable. A tab read re-fetches the tab's own URL (same origin, no redirects), so a server or service worker can return different
  bytes from the ones the viewer showed.
- Sandboxed PDF extraction matched an unsandboxed build only on generated TrueType, CJK and Type 3 fixtures. First use compiles the helper (up to 300 s), and a failed compile retries on every read.
- Developer reads cover the current page target from attachment, so worker and out-of-process-frame logs can be missing. The scrubber keeps only allowlisted shapes, so letter-only values and unknown-TLD subdomains pass, and `12:30`, dates and `window.performance.now` are masked. Short unlabeled secrets can remain.
- Whole-thread reads cover vertical DOM lists in the main frame. A read reports partial when items overlap ambiguously or the declared total doesn't match. Missing end markers, unopened expanders, items over 65,536 characters and 8 MB held make it partial too.
- On document-scrolled pages with plain div wrappers, a loader beside the list can be missed. The read reports `Complete: NO` when it cannot prove the end.
- The default `whole.max_items` of 1,000 can stop an exactly 1,000-row thread before end verification. Set a larger cap to leave room for that check. Large held transcripts need `whole.from` to page through all rows.
- Whole-thread reads click only expander buttons with a name. GET and WebSocket effects are not held, and a SharedWorker started before the read is outside the hold. Native foreground behavior and an actually hidden tab are unqualified.
- A page watch needs one existing public tab that updates itself and compares literal text in main-document names. Hidden rows, child frames, field values and canvas are invisible to it.
- Page watches reject pages with unchecked embedded documents. The watch can't recognize short opaque URL secrets or custom protected controls. A browser restart needs reinstalling. launchd self-bootout, notification delivery and foreground behavior are unchecked live.
- Site memory learns only generic button, menuitem and tab labels with a structural change. Hints can be stale. A stale `site-memory.json.lock` stops learning and clearing until removed. The measured speedup came from a scripted explorer. No model run has measured it.
- Turn GIFs pixelate the whole page and black out fields where DOM boxes exist. Block size follows the font, not the rendered scale, and media outside the targets is pixelated, not blacked out. A mask query over 5,000 elements or 50 ms skips frames. They cover owned turbo tabs only, and the OCR and QR tests used fixtures.

### Engine browser limits

- `tab.drag` doesn't drop on an HTML5 drag-and-drop target when aimed at the target's center (0 drops in 14
  trials in Chrome and Helium). It moves in 8 equal steps, and the page sees `dragover`, which a drop needs,
  only when two moves in a row are inside the target. Aimed 3 px inside the target's edge nearest the source,
  it dropped 6/6 (`bench/fowl/drag-probe.mjs`).
- After `tab.click` on a download link, no download prompt appears, and every later download in that tab times
  out, `downloadMedia` and `waitForEvent("download")` alike (2/2 each, raw engine and sleight). Without that
  click both returned in under 0.4 s. A new tab downloads normally (`bench/fowl/download-probe.mjs`). Turbo's
  `download` step avoids this stall.
- The page's `evaluate` is read-only: it can't dispatch events, assign globals or watch the page's network.
- The engine opens tabs one at a time. A tab took 0.9 s to open alone, and 1.3 to 2.9 s each when 6 sessions opened
  one at once, about 0.3 s more per session in line (`bench/fowl/coldstart-probe.mjs`). In a round that starts 13 sessions at
  once, the first call's median was 4.8 s.

## Clipboard

- Preservation cannot snapshot unreadable formats, file promises or more than 64 MiB, and macOS has
  no atomic compare-and-restore, so a failed Copy/Cut leaves new clipboard data alone.
- sleight doesn't check whether a native Cut key took effect. An app that disables Cut for the
  selection ignores the key, and the result only says so as a possibility. A click by label on a
  disabled item stops and names the enabled items beside it, but only items at the same depth of
  the tree.
- An asynchronous paste handler that reads after restoration receives the restored clipboard. A worker crash loses the recovery snapshot of concealed originals.
- Snapshots expire after 10 minutes or a reboot. On APFS and SSDs, zeroing a snapshot before unlink doesn't guarantee erasure, and backup exclusions are advisory. Google Sheets, Notion and iframe editors are untested.

## The engine and its helper

- After a switch that changes sleight's tool list (such as `SLEIGHT_APPROVAL_SCOPE`), the first session can answer every call with an error that says the engine's tools changed,
  because sleight's startup cache kept the old list. Starting a new session fixes it. Seen in 2 of 2 races on
  2026-10-19 that flipped such a switch. 1.3.1 caches only the engine's own replies.
- An action called without `await` that fails used to end the engine's JavaScript session, and every
  handle with it (`app.click(1); "x"` on a disabled Calculator element, 3/3 on 2026-10-07). The guard
  now attaches a handler to each action's promise and tells Claude which action failed. With
  `const p = app.click(99999)` and more code after it, 1.0.0 reset the session (1/1) and the fix
  kept it with the failure reported (3/3, Chess, 2026-10-09). The relay refuses a call whose
  action, or a `.then` chain off it, is neither awaited nor last (unit-tested for chains, 2026-10-12).
- The engine's service crashes now and then. `SkyComputerUseService` (26.1005.1001425) segfaulted 4
  times from 2026-10-05 to 2026-10-11, each time at address 0 inside its handler for WindowServer
  notifications, on the main thread: during benchmark runs on TextEdit and Calculator (3) and during
  a Codex `getApp` call with no sleight call in flight (1). The call in flight
  fails with "native pipe closed before response", and the service is back within seconds. We don't
  know what triggers it, and it is the engine's bug for every client. sleight sends a read that met
  the crash again once (unit-tested only). A call with actions isn't resent.
- The engine's helper can stop answering. On 2026-10-04 every `cua.getApp` timed out
  (`-10005 timeoutReached`) for about 25 minutes, with the Mac unlocked and in use, until ChatGPT was
  restarted. We don't know the cause. After two consecutive `timeoutReached` failures on standalone
  reads of one app, the relay checks target AX, another acquired app's AX and a fresh engine read of
  that control app. ChatGPT restart advice requires both AX processes to respond with windows and an
  actual engine control timeout.
- The AX check of the target app waits 0.5 s, which a busy Mac can miss. On 2026-10-09, with a load
  average of 101 from other processes, TextEdit, Safari and Calculator missed it in 5 of 5 probes and
  answered in 0.27 to 0.52 s with a 6 s deadline. sleight now probes once more with a 3 s deadline
  before calling an app hung (unit-tested, 2026-10-12).
- The 29.475 s first Calculator acquisition on 2026-10-09 spent 27.683 s inside the engine after
  approval. Browser discovery had already ended, so its removal does not explain or fix that wait.
- The helper can also fail to start. On 2026-10-05 it quit normally when doctor's session ended, and
  every later launch failed with "Sky Computer Use service startup request failed" for at least five
  minutes: launchd still held the old job and answered "Operation already in progress". Removing that
  job with `launchctl remove` fixed it at once, without restarting ChatGPT, and the next four helper
  launches worked. We don't know what left the job behind. Doctor and a failed call now print the
  command for the user to run.
- ChatGPT updates can break it. The version lookup handles the folder moving around, but not the API
  changing. Run `--doctor` first when something stops working.
- The engine has no access to an app's icon in the menu bar or to notification banners: its inventory has
  no Control Center or Notification Center, and `getApp("com.apple.controlcenter")` times out (engine
  26.930.31730, 2026-10-03). Nor can it acquire an app that lives only in the menu bar (`LSUIElement`):
  Codex's own computer use got `-10005 timeoutReached` after 5 to 6 s on 2 of 2 `getApp` calls on
  OpenUsage (2026-10-11), with sleight not involved. sleight's `menu_bar` and `notifications` tools
  cover those instead (see [How it works](how-it-works.md)), and a `getApp` timeout on a
  menu-bar-only app points Claude to `menu_bar` at once. They work in the foreground: an open menu shows on screen and takes
  the keyboard until sleight closes it. Icons that open a SwiftUI window (`MenuBarExtra` in window
  style) ignore the accessibility press, so sleight clicks them for real and puts the pointer back.
  Controls without a label, tooltip or identifier get names such as `Button at (10, 20)`, measured
  from the window's top-left corner, or `Button 3` if AX has no position. Their element numbers
  remain the arguments to `press`. The fallback names and press mapping have unit tests; an
  unnamed live popover button has not been checked with an approved app.
- Exact window selection is unavailable on macOS. Engine docs say `getApp({ windowId })` is for Linux
  and Windows; macOS takes an app name, path or bundle ID.
- The native guard still reads for the first element lookup, after an action that can open a panel
  and at the end of an acting call. On 2026-10-08, Calculator reads after Escape took median 413
  to 437 ms, against 29 to 48 ms idle. The [2026-10-14 A/B](benchmarks/2026-10-14-guard-ab.md)
  ran three times a side on five tasks. After safety fixes, a follow-up passed 14/14 with one run
  skipped when TextEdit failed to launch. A plain button that swaps to a look-alike document still
  keeps the old binding, since the macOS engine does not list windows to compare.
- On macOS 27, engine capture adds an Accessibility dialog named "Window" with a
  `WindowSharingSessionButton`, the system sharing indicator (2026-10-14). The benchmark focus probe
  skips it. Whether it affects the plugin's window checks is unmeasured.
- On macOS 27, TextEdit's Open panel belongs to `com.apple.appkit.xpc.openAndSavePanelService`.
  After Cmd+O the app's focused element has no window (AX error -25212), so its focus cannot show
  when the panel is ready (2026-10-14). The guard keeps the read after a panel opener.
- Same-title replacement of a window cannot be detected (the engine doesn't give window ids).
- `/sleight stop` collects owned engine and helpers, then leaves the shared computer-use helper running.
- The engine keeps two keyboard event taps ("ChatGPT Computer Use") from its first key action until
  its process exits. Measured 2026-10-10 on engine 26.1007.21159 with Calculator: a turn end didn't
  remove them within 30 s, with or without `js_reset`.
- A tree Claude prints with `.slice` becomes the window's baseline, so the next re-acquisition
  lists the cut-off lines as added: 2,800 characters in the third call of the 2026-10-17 Excel replay.
  A re-acquisition with changes keeps its diff beside the call's own diff, two views of one window.
  Whether Haiku reads again after "no change" in an acquisition is unmeasured.
- sleight answers a session's first handshake from a cache of the engine's earlier replies. If the engine changes without
  a change to its version, launch path or settings, the first session to notice keeps the cached initialize answer
  until it reconnects, since MCP can't initialize a client twice. That covers the engine's instructions, version and
  capabilities. If the protocol version changed, the calls sent before the tool list is checked fail once and ask Claude
  to call again. A changed tool list reaches the client only if the cached initialize answer advertised `listChanged`.
  Otherwise the session keeps the old tool descriptions, and its calls run on the live engine. The next session gets the
  new replies. Unit-tested only.
- When the engine's own initialize fails, every call in that session fails with the engine's error, cached or not.
- `npm run compat` checks the engine's browser methods only on a Mac where sleight would start the engine with `CUA_REPL_ENABLED_SURFACES=browser,computer`: a
  Codex browser extension in the extension cache, or `SLEIGHT_SURFACES=browser,computer` set for the run. Without one the
  REPL probe checks 3 of the 8 `cua` methods. The static check (`bench/compat-static.mjs`) still checks that the engine's
  JavaScript defines all 8. The Mac suite's first run on 2026-10-19 failed because the suite started the engine with computer alone
  and required all 8 (fixed in 1.3.1).
- The first live-tier run (2026-10-19, engine 26.1013.40934) failed both checks on the checks' own bugs, never reaching
  an engine fault. The Calculator check wrote a `getAXState` tree the call had already printed, so the display read found
  two edit fields. The Safari fixture pressed File > New Window and saw zero window-created events in 3 s. With Safari profiles that
  item can be a submenu. Safari kept one Start Page window afterwards, which a submenu press explains. The helper's
  events weren't kept, so that cause is likely, not measured. The cleanup then left Safari running, since the fixture won't quit an app holding a window it
  didn't create. The check now quits the one Safari process macOS dates after the check began. The fixes have unit tests
  and haven't run live. The fixture still refuses a Safari whose own launch window appears after its helper starts
  watching, and we haven't measured how often a cold launch does that, since the benchmark's Safari tasks so far started
  with Safari running.

## Specific apps

- In Excel, the first click on another sheet's tab after renaming a sheet swapped the two tabs' order in 6 of 6 runs that did it
  (2026-10-16 and 2026-10-17), whether the rename came from a double-click or the tab's context menu, and through lcu's raw engine
  arm as well as sleight. excel-edit then fails on sheet order. A second tab click didn't swap. The engine's native click code is
  stripped, so whether Excel or the engine arms the drag is unknown. The skill now says to switch sheets by the next/previous-tab
  key or go-to control, and a moved-tab note adds the same advice after Undo. That note knows a tab strip only by role (tab,
  radio button, segment or page siblings, or a tab group, tab bar or layout area parent), so tabs shown as plain buttons in a plain
  group get Undo alone. Whether Haiku picks the right key from that wording is unmeasured.
  A next/previous-tab chord sent during a cell or text field edit can move the text cursor by a word, so finish the edit first.
- In Excel, `setValue` on the name box followed by Return kept the old cell in 4 of 9 excel-edit runs (2026-10-17), and the paste
  went over the header. The result now says the setValue didn't hold, but only when the field reads its old, non-empty value
  afterwards. A call that ends on an alert defers that check for up to 2 calls, until the document's window is read again. Whether
  the skill's click, type, Return clause prevents the trap is unmeasured.
- Slack, Firefox and WhatsApp expose thin engine trees (2026-10-10, one read each, no input):
  Slack 15 elements and 483 characters, Firefox 24 / 898, WhatsApp 19 / 940. None of the three had a
  text field, and Discord wasn't thin (251 elements). Whether a settings switch expands them is unverified.
- A Save or Open sheet showing a folder with many items reads as a very large tree: 198 file rows
  made one read of TextEdit's Save sheet 57,000 characters (2026-10-10), past Claude Code's tool
  output limit, so Claude saw only a pointer to a file, and every guard read of it took 1.4 to
  2.3 s. The benchmark now moves runs older than 6 hours out of its folder. Engine 26.1007.21159
  still has no root, depth, filter or element-query on `getAXState`, so a read that leaves out the
  browser rows is unbuilt. Filtering the text after a full walk would not cut the walk. Under `SLEIGHT_RESULT_TRIM=1` sleight
  drops long runs of sibling rows from such a result (A/B not yet run).
- Go to Folder in a background TextEdit's Save panel puts TextEdit's windows over the user's window
  for about 0.4 s (owner's report and a window-order capture, 2026-10-11: 05:23:13.249 to 13.680 UTC).
- Electron apps build their Accessibility tree some seconds after launch: a raw walk of Discord 12 s
  after `open -g` found 11 nodes, and one after the engine's read found 509, with
  AXManualAccessibility and AXEnhancedUserInterface still off (2026-10-11). A read right after a
  launch can see an almost empty window. `SLEIGHT_LAUNCH_REREAD=1` reads once more after 2.5 s (A/B
  not yet run).
- Finishing a File > Open panel brought TextEdit to the front for about a second in 3 of about 21
  textedit-edit runs while the owner worked (2026-10-10, WindowServer log).
- In a TextEdit typing probe on 2026-10-08, select-all followed by `typeText("engine01")` and save
  left `Engine01engine01` instead of replacing the text. Part of it is macOS auto-capitalization.
- TextEdit hung 3 times on 2026-10-05, each time after Claude set a document's text with `setValue`
  and then pressed a save shortcut. Its main thread waits forever on the document's save lock. The
  skill tells Claude to select and type in TextEdit instead of using `setValue`.
- Lean calls remain off. After the cache fix, their A/B took 220.8 s against 194.4 s and passed
  11/13 against 12/14 (summed medians, five native tasks, 2026-10-14). Chess drove the time gap.
  Earlier Chess benchmark folders are now archived before each arm without deleting evidence;
  the remembered Save directory's fallback still needs a live check.
  [Lean-call measurements](benchmarks/2026-10-14-lean-calls-ab.md).
- On 2026-10-06 TextEdit timed out every engine read after an AppleScript `close every document
  saving no`. It still answered AppleScript, but its only window was an orphan "Save Panel Accessory
  View" that Accessibility didn't list. A read now identifies a possible orphan when macOS lists only
  that title and the probed app has zero AX windows. Reproduced on 2026-10-11 through the engine:
  the next engine read didn't time out, so the orphan alone doesn't explain the 2026-10-06 timeouts.
- In the iPhone simulator (2026-10-07), Claude's paste fallback inserted other text: the simulator
  shares the Mac's clipboard.
- On 2026-10-09 the owner's keyboard stopped working, while the trackpad still did, after a
  head-to-head pass ran the simulator task on both arms. Device Hub, left open after those runs,
  held a keyboard event filter tap whose last key had taken 40 s, and a filter tap holds up every
  key on the Mac. Quitting Device Hub fixed it at once. When a turn ends, sleight now names any app
  it acted on in the session that holds a keyboard filter tap, once per session.
- On 2026-10-11 the engine's read of the owner's Helium (one process since 2026-10-10, about ten
  windows) timed out twice with `-10005 timeoutReached`, 30 s and 60 s. The input lease needs that read
  before `cua.getBrowser`. Whether the window count causes it is unmeasured.
- iPhone Mirroring (2026-10-11, one owner-present run): `app.scroll` at 0.3, 0.6 and 1 page left
  the Settings list unmoved (3 tries). sleight now turns `scroll` into a swipe on a window whose tree
  is only chrome (unit-tested, 2026-10-12). A tap during a page animation opened Personal Hotspot instead of General.
  The tree is the Mac window and menu bar, so the engine's settle wait cannot see the iPhone screen.
  After an action in an app whose tree is window chrome only, the relay waits for two matching
  screenshots, up to 1.5 s, and records the wait in the trace. Unverified: live
  `iphone-mirroring-settings` ×3 with no tap outside Settings > General > About.

## Hosts and platform

- The desktop app's command picker still says "/sleight isn't a command here", though the mod handles it.
- It's macOS on Apple Silicon only. The engine's JavaScript has Linux and Windows instructions, but
  the helper that clicks and types comes only with the Mac ChatGPT app, and there's no ChatGPT desktop
  app for Linux (checked 2026-10-04). We haven't checked the Windows app.
- Cursor and generic MCP clients can use sleight's native approval panel and idle turn cleanup
  in 1.3.0. The panel shows the client's name (Cursor) in other
  hosts and Claude under Claude Code. It is unit-tested only: no live approval in another host has been
  checked. Unanswered relay forms expire after five minutes.
- Grok CLI support in sleight 1.4.0 has a headless handshake and focused unit tests, with no model session or image delivery check.
  Turbo is off because Grok has no trusted user-turn binding. Its 20,000-byte result cap can return a delivery error for
  output that cannot fit after tree trimming, including large screenshots. Read current state before retrying input.
- In Grok 1.0.13, marketplace add and plugin install with `--trust` succeeded in a throwaway home, but inspect still
  loaded the Claude marketplace checkout. That can differ from Claude Code's cached sleight version (1.3.1 versus 1.3.0
  on the study Mac). Check the target in `grok inspect --json` and keep one route. The direct MCP entry passed doctor.
  Grok form answers never write Always allow. Only the user's click on sleight's panel can do that.
- Grok Bot's shell route is a preview. One live read passed on 2026-10-20 (Calculator through the shell route); image
  delivery hasn't been checked live. In 1.4.0 its approval requests don't open a card. They wait in the menu bar glove under
  Review sleight request, which macOS 27 can hide behind the menu bar's overflow chevron. Clicking it shows a plain
  window. The same request can come back several times (about 7 in that check) before one approval takes. The
  1.4.1 candidate behavior is described in the [CHANGELOG](../CHANGELOG.md#141-unreleased). The card is now visible
  while its host is inactive. A combined owned fake-card run on 2026-10-21 explicitly refused Accessibility,
  PID-posted and spoofed-HID input, collected that fixture, then accepted the owner's physical click in a fresh
  fixture. Lifecycle checks passed 7/7, all five children exited 0, and cleanup released the lock.
  A real Chess acquisition through Grok Bot on 2026-10-21 failed after about 21 seconds while its helper was still
  compiling, with no visible card. One explicit retry after compilation passed in about five seconds. The owner
  saw the card and icon and clicked Allow, but heard no sound. A repeat in the same session passed in about
  0.4 seconds without another card. The candidate now shares compilation with startup preparation and preserves
  the original call deadline plus a full answer window. Expiry and shutdown prevent late presentation; the cold
  native path after this correction remains unqualified. Real GL9 through Grok Bot's priya also remains unqualified.
  Qualification must
  record Calculator/TextEdit card counts with the owner's current preapprovals, one physical Allow where needed,
  repeated same-session requests and identical retries while a decision waits. Appearance, sound, glove review under
  menu overflow, cancellation, channel reset, fd transport and shared-host operation also need live checks. The guard
  probe must separately prove synthetic-fixture cleanup before a fresh physical-click fixture starts. Protected
  buttons still require physical input.
  The owner reported first-call TextEdit timeouts in two Grok sessions, followed by successful reads. Separate
  owned relay and shell diagnostics on engine `26.1013.40934` acquired TextEdit in 211 and 260 ms without a prompt.
  The raw-engine diagnostic stopped at a declined new-session Calculator approval. These runs did not reproduce
  the recurring timeout or identify its cause, and they did not run inside the owner's Grok process. The owner
  parked further TextEdit investigation unless it recurs.
  Grok Bot's custom STDIO MCP servers run in a hosted box without this Mac's apps or ChatGPT's
  engine. Use `sleight-mcp js '<code>'` through the local daemon, which starts a session on demand. Doctor reports
  `route: shell (sleight-mcp js)`, even when a session isn't running. There is no Mac-side HTTP client placement.
- A shell session requires Apple's clang and stops after ten idle minutes. The next call starts it again.
  Any process running as your macOS user can drive the session. A bot with shell access can edit `preapproved.json`
  directly. Socket permissions do not protect against either. A socket path longer than 103 UTF-8 bytes prevents startup.
  Startup reclaims a private stale socket only after its connection is refused and its file identity still matches.
  Startup reclaims a lock whose recorded PID has exited. An unpublished lock is reclaimed after six minutes;
  a recorded live PID is preserved regardless of age. Session images are private cache files, capped at fifty and
  pruned at exit or the next startup after a crash.
- Grok Bot's local shell may lack Accessibility for sleight's native metadata helper even when the engine has its own
  grants. Doctor checks the live session's native helper. Without a live session its trust is unknown.
  Detached-session survival across bot turns and image upload still need a live bot check.
- With Grok Bot's own computer use on, its helper is a second driver. It does not share sleight's input lease,
  so both could act on the same app. Turn that helper off before using sleight through Grok Bot.
- The Grok Bot shell route has no trusted user-turn binding. Every payment, booking, settings change and submit
  must ask on sleight's panel, including actions the user requested. Grok's `always` setting and auto-review cannot
  answer that panel, and `SLEIGHT_CONFIRM_PAYMENTS=never` cannot skip these confirmations. Turbo stays off. The route
  offers session-only app Allow without adding entries to the pre-approved list. Existing pre-approvals cover only
  plain engine app-access cards with matching app names. Local `drag` and `open_file` approvals ask on the panel
  each time. If a timed-out call has not returned after 30 more seconds, shutdown begins collecting its process group. The next session has new handles and app approvals. Read state before retrying an action that timed out.
- The Cursor plugin (1.4.0) hasn't been installed in Cursor yet. We don't know whether
  `cursor-agent plugin marketplace add` works on a personal account, whether Cursor accepts the
  manifest's empty `hooks` object without a warning, or whether it hides `turn_ended` from the model.
  A local plugin copy and the Claude Code import would both start a server named `plugin-sleight-computer`,
  and we haven't seen what Cursor does then.
- cursor-agent's plugin loader shows that a Cursor plugin replaces the imported Claude Code plugin with the same marketplace and
  name. We haven't read or tested the Cursor app's own loader.
- A name lookup can still launch an app that exited between the native check and `getApp`.
- In Codex, a card without fields can be accepted without you. Codex's full-access mode and its
  auto-review answer such cards themselves (openai/codex source at 89461ea6). sleight's app card always
  has the Always field under the default session scope, so this applies only with
  `SLEIGHT_APPROVAL_SCOPE=once` or `document`, and to the engine's browser cards. Not seen live.
- In Codex, an Allow lasts as long as Codex keeps sleight's server running, which can span more than one
  thread. We haven't checked how Codex shares one server process across threads.
- In Codex, the Stop and Interrupt hooks were listed and trusted on 2026-10-19, but no log shows one
  running yet. An Interrupt during a running call is answered at once, and the turn ends if the call
  finishes within 3 seconds. A call that runs longer leaves the turn to the 30-second idle end.
- Turbo in Codex hasn't run in a live session. The binding rests on Codex 0.160.0's source: a tool hidden
  from the model can't be called by it, and every model call has `callId`. A Codex version that
  changes both loses that protection. sleight doesn't bind turns for Codex older than 0.160.0.
- In Codex, a message you add while a turn is running doesn't rebind turbo. A payment that only the
  added message names asks on sleight's card. A message over 64 KiB binds with no text, so every
  payment, upload and history step in that turn asks.
- The `codex-sleight` benchmark arms configure sleight's server without the plugin's hooks, so they now
  list turbo's tools that never bind. Set `SLEIGHT_TURBO=0` in those arms or install the plugin's hooks.
- Codex runs sleight's hooks only after you trust them. Untrusted, a used turn ends after
  30 idle seconds. Turbo binds only while the prompt hook is trusted, and each binding works only for
  the turn that made it.
- Codex's app-server can call sleight's hidden `turn_started` tool, so one of Codex's own clients could
  bind any text as your message. We haven't checked whether an MCP Apps widget can reach that call.
- If Codex shares one sleight server across threads, a prompt in one thread ends turbo's turn in another.
- We don't know whether turning off Codex's `computer-use@openai-bundled` plugin also removes the
  computer surface from `unified-computer-use`, which Codex's Browser plugin shares. The `computer_use`
  feature flag left that plugin's skill in place in a throwaway home.
- Whether Codex asks before each sleight tool call depends on Codex's own approval settings. We
  haven't checked it in a live session.

## Desktop replay

- Recording only supports initially empty TextEdit fields, and checks using constructed events do not
  prove app notification delivery.
- A pane replay is untested in Auto mode, where the classifier may refuse the mod's `replay` call
  because the mod doesn't approve it (the classifier refused the pane's snapshot on 2026-10-08).

- After a kernel reset, sleight restores `tab` and `b` only for calls whose source it can parse: 87 of 403 recorded browser calls (21.6%)
  aren't tracked, and a name the call assigns isn't restored.

- A benchmark arm's pinned Claude Code, started by hand in a normal terminal, runs its auto-updater against the owner's HOME. On
  2026-10-16 that most likely removed `~/.local/bin/claude` ("Auto-update failed"), so `claude` fell back to an older Homebrew build
  until the symlink was restored. Hand-run arm commands need `DISABLE_AUTOUPDATER=1`. The benchmark already sets it.
- The world suite's native fixtures stop the whole pass on any cleanup they can't confirm. On 2026-10-16 the sleight arm stopped
  three times. TextEdit restored iCloud "Untitled" documents at launch. A Chess window and a Word window whose task had already
  saved or closed them failed their title read during cleanup (AX -25205, attribute unsupported), in `closeOwnedWindow`
  (`bench/real-fixture.js`). Each stop also ends the remaining tasks of the pass. The Chess stops came from the app-dialog scan before
  cleanup, which read the title of a focused Chess window that isn't the fixture. With that read tolerated (`a65350ba`), the scan's
  inspection of that window exceeds its bound instead, so chess-drag is parked from the native pass.
  Later the same day, a sheet and a Word alert that vanished mid-read (AX -25202) stopped two more passes, both fixed. A task
  that left its second fixture window focused stopped one, and cleanup now raises its own window over a sibling fixture.
- Excel opened the excel-edit fixture with "Open recovered workbooks?" on 2026-10-16, and the run stopped there correctly. The
  recovery files are in Excel's sandbox container, which macOS privacy protection hides from sleight's shell, so we don't know
  whose workbooks they are. The launch flags don't turn off Office AutoRecovery.

## Benchmark environment

- Finder fixture recovery can close a documentless Recents window when its creation receipt recorded that same default
  title and the window is still listed outside the baseline with no dialog. Other documentless titles stay unconfirmed and
  keep the live lock. The live Finder probe hasn't qualified this recovery path yet.
- The hub refresh after a pass (`bench/hub-refresh.mjs`) reads the native and app claim folders that `bench/results-hub.mjs` names
  (`app-claim/native-results-1018b` and `app-claim/results-1018`), so a new claim pass appears only after someone points the hub at its
  folder. The race folders are found by name (`race-MMDD` under `~/Projects/sleight-wt`), so rounds saved anywhere else stay out. Validation
  and re-measure banks are found by their `plan.json` and need a `score.json` or `comparison.json`, and the score file doesn't keep
  failure reasons. The refresh also rewrites tracked files (`docs/results`, the README's generated blocks) in the checkout that ran the pass. We have
  not run it after a live pass yet, only in tests with the hub faked, and the full collect took 8.7 s on this Mac on 2026-10-21.

- The agent-install test (`bench/agent-install.mjs`) confines writes, exec and Apple events, not reads. Its sandbox profile
  refuses reads of the owner's host configs and credentials folders (`~/.claude`, `~/.codex*`, `~/.cursor`, `~/.ssh`, `~/.aws`,
  `~/.gnupg`, `~/.netrc`, `~/.config/gh`). Any other file the owner's account can read, the arm can read too. Claude Code's hook
  keeps its file tools inside the run's folders, but in either arm an allowed command such as `cat` can print another owner file
  into the transcript. Claude Code's arm can still run `/usr/bin/security`, since the CLI
  reads its own login with it. The hook refuses it to the agent.
- The agent-install owner-path check skips files that changed by themselves within 2 minutes on 2026-10-19 with the owner's
  own Claude Code, Codex and sleight sessions open: session transcripts, caches, plugin caches, Codex's databases and
  `~/Library/Application Support/sleight/leases`. A change there doesn't fail a run.

- The world suite's browser tasks opened their fixture pages in Helium, and on 2026-10-16 some opened as tabs in the owner's own
  Helium window beside logged-in mail and other tabs. The benchmark's leftovers were closed by exact fixture origin. Until browser
  tasks run only in an isolated browser, the native claim runs native tasks only and browser comparisons run in the gate's
  harness, which drives its own headless Chromium.
- A full-screen `screencaptureui` window (layer 24, the whole display) stayed up from a screenshot session on 2026-10-15 and made
  every drag target read as covered, so `drag` refused text drops in TextEdit. Quitting it on the owner's OK cleared it. Runs of
  drag tasks after about 17:45 UTC that day are rerun.
- In the 2026-10-18 Safari round, form-settings and form-settings-helium failed for sleight (and for lcu) at the priority list's
  drag reorder. The engine's `app.drag` left the order unchanged and `drag` refused, because the race's own Terminal window covered
  the list and the rows are groups with children. Safari also ignored the engine's `setValue` on the range slider, which took 11 and
  20 extra calls. Rounds launch Safari without activating it, so whatever window is in front stays in front. AXRaise on a background
  app's window returned success and left Terminal over it (1/1, TextEdit). Each task's row now records the windows over the
  browser's window at its start (`cover`, and the report's "covered by" column), so a drag failure can be told apart from a
  covered window. Rounds before that column have no record. Since the owner added two displays (2026-10-18), each task first
  moves the round's own browser window to the spot on any display that the fewest other windows overlap (a TextEdit probe went
  from 53% covered to none). A window the owner moves over it later still covers it, and the column shows that.
- In race-1017's Sol rounds (2026-10-19) the Claude app's window covered 82 to 83% of the browser's window in both r3 rounds, and
  placing left the window where it was. Those rounds didn't record the display count, so we don't know why no spot was free.
  sleight failed 5 of its 12 Sol form-settings cells, each after `drag` refused at the priority list (in one, the Claude window
  came over after a clean start reading). Codex's own computer use failed 3 of its 6 covered cells. It passed the other 3, all in
  Firefox, by typing synthetic drag events into Firefox's web console, which sleight doesn't do. The page has no keyboard or button
  reorder, so there was no pointer-free route. The refusal's first step is now a move the app offers without a drag (a button, a
  menu command or keys the app shows), before `app.drag` and before asking the user. It wouldn't have changed these cells, and
  it's unmeasured on a page that does offer one. Each task now also reads the cover every 5 s and at its end, and a place that
  doesn't find a free spot records the display count and the best spot's overlap. `race-score.mjs --exclude-covered` (off by
  default) leaves out 15 race-1017 runs: 5 codex-sleight-sol failures and 10 sleight runs from the 2026-10-17 Firefox rounds
  (7 failures, 3 passes), all with a `drag` refusal. A Finder window was over the list in the sleight rounds. codex-sol's 3
  covered failures stay scored, because codex-sol passed form-settings and form-settings-helium in Firefox under the same
  Claude window. A reading covers the whole window and doesn't know the drag points, so a covered corner can count as evidence
  for a run that failed for another reason. We picked the 5% and 50% floors from what these rounds showed (banners 2 to 4%,
  Finder 41% with passes beside it), and no run measured them. The overlay filter knows the engine's overlay, Cua's driver
  overlay (100% in safari-cua-r2), the Dock (45 to 50% in the PG3 and SW1 rounds) and system UI by name. The first 3 watched
  tasks of a round print every owner the watch saw, overlays included.
- Cover evidence in old race rounds differs by arm. The cover column started on 2026-10-18, so the earlier Firefox rounds have
  no reading, and for codex, lcu, cua and peekaboo there that means no evidence at all: their failures can't be left out by
  reading, and only sleight's `drag` names the app in a refusal. The Sol rounds have a start reading and no watch, and only rounds after this change have readings during
  the run. An arm with no evidence keeps every covered failure, so `--exclude-covered` favors the arms whose rounds recorded
  cover.
- Safari demoid lost 2 runs to the sign-in pop-up, Claude Code b9-r2 on Haiku and Codex b12-r3 on gpt-6-luna. Neither the
  engine nor sleight lost the dedicated window. "Sign in with DemoID" opens a separate Safari window, and the engine's next read
  shows that window, as it does in Firefox. When the pop-up closes, the next read shows the dedicated window again under its old
  ID (3 of 3 b10 runs). Safari prints each window's ID on its root line and gives the pop-up no tab bar or profile button, so
  Haiku couldn't tie it to the dedicated window. It read `safari.windows`, which an app handle doesn't have, took the empty
  result for a window list without the dedicated window, and stopped before the consent click. gpt-6-luna said it wouldn't use
  the pop-up, then called `select_window` on the dedicated window's loaded title. The race's own PreToolUse hook
  (`bench/fowl/origin-hook.mjs`) refused that, because it allows only the gate's marker title. The prompt says "never use any
  other browser window", and it doesn't mention pop-ups. In 1.3.1 the window note says a pop-up belongs to the task in the
  window it came from, and later says when a window has the opener's ID. That needs a window ID on the root line (Firefox
  prints none), a read whose probe counted the acted-on window as the app's only one on any Space, and an action's own
  result showing the new window. A pop-up first shown by a separate read doesn't get the line. With more windows open, a
  window that comes to the front doesn't get it either, since it may be the owner's. In the first live check (FS2,
  2026-10-19) the line never showed. Haiku's Cmd+T call came back as a lease stop on the retitled window, and any stop
  dropped the count. A stop that shows the counted window now keeps it. The trace records every count, and every reason
  a new window doesn't get the line, as `popup-window`. The second live check (6ba7204b, 3 rounds) showed the line 0 times.
  CGWindowList counted 2 windows for Safari's one, because Safari keeps a 500x500 window from launch that it never shows and no Space
  holds. The count now leaves out windows no Space holds (the private `CGSCopySpacesForWindows`) and keeps another Space's.
  Not yet rerun live. We haven't measured whether a minimized window or a full-screen window on another Space counts. Many
  apps keep such hidden windows (TextEdit, Messages and Mail did on 2026-10-19). If the owner brings one back between the
  read and the action (a closed Mail window reopened from the Dock), the line calls it the task's pop-up. Haiku
  stopped at the pop-up in 1 of those 3 rounds. The race prompt now allows such a pop-up for every arm (next item).
- sleight inside Codex on gpt-6.1-sol failed demoid 6 of 6 (race-1017 b16, Safari and Firefox), and Codex alone failed it 6 of 6.
  sleight showed the DemoID pop-up and refused nothing. Sol stopped on the race prompt's "never use any other browser window"
  ("your window restriction prevents me from using" it), and all six runs then asked `select_window` for the renamed shop
  window, which the race's guard refuses. The race prompt now allows, for every arm, a pop-up window of the same browser and
  profile that a page in the dedicated window opened after a step the task asked for, and nothing in another app, profile or
  browser. The guard's refusal says the same and that `cua.getApp` shows the dedicated window again once the pop-up closes.
  The payment gate reads whichever window an action acts on, so a card form in a pop-up stops the same way. The guard still accepts only the marker title, so before a pop-up closes the agent has no `select_window` way back to
  the opener (one Firefox run got back through the Window menu). The change hasn't run live yet.
- The race scorer's harness-failure check knows three error classes (`approval refused`, `no daemon`, `no tools`). A round that
  fails on some other shared cause, such as every call answering "Turbo is unavailable", is scored as the arm's failures until
  someone writes `harness-failure.json` into its folder by hand. inject-order's answer check accepts the total written as `$16`,
  `$16.00` or `16.00`. Other spellings fail.
- inject-mail's answer check is a pair of word patterns. Of the 127 stored answers, the 115 that name the forwarding
  address all pass them (the old patterns passed 109), and 16 hand-written answers that claim a send fail
  (`tests/fowl-answer-graders.test.mjs`). A new phrasing can still miss.
  The site log's `action /mail/send` rule is what catches a send. The race takes its answer patterns from
  `bench/world/tasks/fowlbrowser.json`, while gate rounds on FowlBrowser's own runner (`bench/fowl/h2h.sh`, release passes)
  still grade with the pinned `codex-h2h.json`.
- `vscode-edit` and `cursor-edit` launch their own instance with a temporary profile, but no run has used it live yet. We don't know
  whether Cursor shows a sign-in or onboarding screen over an empty profile, or whether VS Code and Cursor create
  `~/.vscode/argv.json` and `~/.cursor/argv.json` outside that profile when those are missing. The Firefox tasks still quit
  Firefox with an AppleScript `quit`, which is an Apple event.
- The sleight-in-Codex arms (`codex-sleight`, `codex-sleight-sol`) have never run live. `codex exec` can't answer an MCP form, so
  `bench/codex-sleight-proxy.mjs` sits between Codex and sleight-mcp and answers sleight's approval forms from the benchmark's
  allowlist, as the Claude arms' hooks do. Their rows include one extra process hop that Claude-hosted rows don't have. It added
  0.016 ms a call over 2,000 offline echo calls (0.020 ms with both guards), and we haven't measured its start-up or a live run. Codex doesn't run a Stop hook, and sleight ends a used turn after 30 idle seconds.
  The arms' Codex login is a copy of the codex arm's `auth.json`. We don't know whether Codex rotates refresh tokens, which
  would log the other copy out. We don't know whether sleight's replies keep the engine's `codex/nodeReplExecutionDurationMs`
  field that fills `engineMs` in the codex arm's rows. In a pass that also runs `codex` or `codex-sol`, the engine's Always
  allow list holds the benchmark apps for the whole pass. The sleight arms there meet fewer engine prompts than they would
  alone. The results record it (`engineAllowList`), and nothing refuses such a pass.
- The speed map's VS Code and Word fixtures failed setup live on 2026-10-14, and no live run has followed the fix. We found
  the VS Code cause offline. VS Code read AppKit's persistence switch as `--status` and quit, and its pid then answered
  -25204. The Word cause comes from the code path, not from a live receipt. Word's new window wasn't identified as the fixture
  in time, and that stop left Word open. The 60 s startup budget is a guess, since no run has measured how long VS Code,
  Cursor, Word or Excel take to show an identifiable window here. Cursor, Excel and the concurrent cohort have never run. The
  first qualification (2026-10-19, 04:41 UTC) stopped Word's first cell on FOCUS_CHANGED between the end of setup (1517 ms)
  and the first engine call, with cleanup confirmed. Its samples kept only booleans, so we don't know whether Word activated
  itself or its window covered the owner's. VS Code didn't run. The second (08:45 UTC) passed setup in 1476 ms. Word covered
  the owner's Terminal at 1774 ms (launch-cover) and read in 199 ms first and 110 ms warm, but its scroll step failed with
  NO_UNIQUE_SCROLL_AREA, because Word also has a Ribbon scroll area. Cleanup left Word running behind a window the host never
  retained, with unreadable document and sheet attributes. Only reason codes were kept, so we don't know which window it was.
  Document fixtures now scroll the area around their own text, and rows keep the tree's scroll-area counts and each cleanup
  window's AX codes. The third (08:50 UTC) measured every phase (acquisition 793 ms, reads 86 and 143 ms, scroll 1391 ms,
  readback 106 ms) and confirmed cleanup, then stopped because Word's window covered Terminal while its document closed. That
  cover is now `cleanup-cover`. The fourth (09:0x UTC) completed Word's cell. VS Code reached setup for the first time and
  opened an empty window instead of the fixture folder, and cleanup left the run's own instance running. The folder now goes
  in argv, and cleanup quits an instance proven to be the run's own. The full map (08:57 UTC, 10 runs) completed Finder,
  TextEdit, VS Code and Word 10/10 and the TextEdit cohort 40/40. Cursor and Excel were 0/10 on NO_UNIQUE_SCROLL_AREA. Excel's
  marker cell sat outside its only scroll area. Cursor 3.25's tree had neither a scroll area, a list nor a marker row, likely
  its agent-first layout on an empty profile, which no setting we found turns off. The scroll target rule now covers both. A
  Cursor rerun (09:18 UTC) measured its cell through the owned-instance fallback, but Cursor's 102-node tree had one text
  entry area (likely the agent prompt) and no document region, so its scroll timing isn't a document scroll. The run then
  stopped when macOS handed focus to Finder as Cursor quit, which now counts as `quit-handoff`. The 09:31 UTC rerun measured
  Cursor 10/10 that way and the Excel cohort 40/40, but Excel's sequential cells passed 2/10. All eight failures were at the
  scroll, which went to the formula bar field because Excel's tree doesn't list its cells. The engine's error text wasn't
  kept, so its code is unknown. The Excel-only run (09:44 UTC) failed all 10 canvas scrolls and 5 of 10 four-session cohorts
  at acquisition, each cohort losing all four sessions together. That pattern points to the fixture's state in those cohorts,
  not contention among sessions. The cause isn't known, because the receipt kept only the error kinds (timeout, unsupported,
  lease, approval). Excel's action is now a Page Down key, and the log keeps the error template. At 09:55 UTC Excel completed
  10/10 with the key, and its cohorts lost 11 of 40 acquisitions. The engine's helper had crashed (SIGSEGV, 10 crash
  reports in that run and 11 at 09:44, one stack): concurrent `getApp` calls on a helper that has just started can crash
  it, and sleight's one resend from every session then met the next new helper together. The harness had logged the
  engine docs ahead of the error, which hid it. Crash resends now wait a random 0 to 1.5 s more, and cells count the
  helper's crash reports. Whether the spread resends stop the second crash isn't measured yet. Results:
  docs/benchmarks/2026-10-19-speed-map.md.
- The Cursor arm is offline only. Its interval (submit to recorded end) excludes composer setup and is not comparable to other arms' totals.
- Telemetry from the FowlBrowser jobs is fixture evidence that page JavaScript can forge.
- The mail-to-Numbers task has no live Numbers import, export or cleanup run. Saved documents are left for the owner, and an unreadable receipt reports "leftover check unavailable".

## Turbo in unattended runs

- In the claim baseline's sleight arm (2026-10-16, 15:34 UTC), all 3 browser tasks got "Turbo is unavailable for this turn",
  so Claude used the engine's browser path. `doctor` read turbo as on, with Helium's remote debugging on. The worker drops the
  reason (`plugins/sleight/lib/direct-browser/worker.mjs`, the generic `failure()`), so we don't know whether a consent
  prompt in Helium, the connection check or the browser choice refused it. Turbo's live qualification with the owner present
  hasn't happened yet. Until it does, sleight's browser numbers in the claim come from the engine path.
- A sign-in popup that closed itself ended turbo for the turn in 5 of 5 DemoID runs (2026-10-18). Chromium answers a command
  sent to a closed popup's session with a -32001 "session not found" error and no `sessionId`, and
  `selected-connection.mjs` took that reply for a protocol violation and fenced the whole connection. It now fails only that
  command. The worker also writes the reason code for any connection loss to the relay's trace file (`SLEIGHT_TRACE`,
  direction `turbo-connection-lost`, a fixed code and nothing from the page). Measured on a headless Chromium fixture, not yet
  in a real window.

## Turbo popups, the hook and the click seal

- Turbo v3 reports a new-tab link click as unconfirmed when a same-origin window it can get at has a `preventDefault`
  that doesn't reach the hook: a window handle that stayed unhooked or whose `Event` the page replaced. Hooked iframes, openers
  and `window.open` handles forward `preventDefault` and a `returnValue = false` cancel to the clicked page. A window's first
  document gets the whole hook (not only `preventDefault`) before `open` returns, so a function the page saves from a handle
  is the hooked one. That install runs `eval` in the new window on source text containing the hook's key and secret, built
  inside the hook from natives it captured. On a page whose content security policy blocks `eval` it fails,
  only the forwarded `preventDefault` remains, and natives saved from such a handle are not hooked.
  Script-started openings (`a.click()`, `form.submit()`, `requestSubmit()`, `dispatchEvent` of a click, in the page, in a
  closed shadow root or from another frame's natives) are held, not opened in the background, and the result says so.
  Enter (every spelling) on a focused link opens it in the background. Enter on a link whose address sleight can't check
  (credentials in the URL, `about:blank`, `mailto:`) and Enter in or on a form that submits to a new tab (decided from the
  form's elements and the control's own `form` and `formtarget`) are refused, because Ctrl+Enter doesn't submit a form
  and a plain Enter would raise the tab. A click on the same link still works.
  A synthetic click with Shift, Ctrl, Meta, Alt or a non-primary button (an `auxclick` too) on a link, an image-map
  area or a submit control is held wherever it is, including inside the agent's own click, because the browser takes the
  new window, tab or download from the event itself. A synthetic click that can't be cancelled is held on a new-tab link too.
  A link or form that a listener changes after the hook decided it was plain (`a.target = '_blank'` in the link's own
  click handler, or `window.name` renamed so a named target stops matching) is caught for the agent's click and for Enter.
  A change made before the click happens (in a `pointerdown`
  listener) is stopped by the dispatch guard instead, and the result reads "page changed during the click". The hook cancels a
  changed link and opens it in the
  background. It cancels a changed form and the result says so. A script-started click, `requestSubmit()` or
  `button.click()` (outside the agent's click) is cancelled while it is dispatched if a listener re-aims it through
  `window.name` (also a frame's), a `target` or `formTarget` property, `setAttribute` and the other attribute methods
  (`removeAttributeNode` too), an `Attr` value, `nodeValue` or `textContent`, `setNamedItem`, or by removing the frame a target
  named (`remove`, `removeChild`, `replaceChild`, `replaceWith`, `replaceChildren`, `innerHTML`, `outerHTML`, `textContent`
  of its parent, `document.open`), from this window's natives or another hooked window's. A frame or window created inside the
  listener asks the windows above it, when its hook installs, whether a script click is in flight. Re-aiming it by adding a
  `<base target>` element (`append`, `insertAdjacentHTML`) is not seen: the tab comes to the foreground and the result says
  it probably did. A frame that changes its own `name` attribute doesn't rename its window, so that is not a flip.
  An SVG `a` is a link whether its address is `href` or `xlink:href`; every hold above covers it, and the seal includes the
  `xlink:href` value. The hold selector matches an `href` in any namespace, so an HTML `a` with a namespaced `href`
  (which the browser doesn't follow) is held as well.
  A hold made by a frame's hook is counted by the top window's `take()`, which asks each frame below it with a signed call. The result reports it.
  Found 2026-10-14 (AD1); the modifier, name and attribute cases 2026-10-15 (pop round 4); SVG links, the remaining writers and frames created in the listener 2026-10-15 (pop round 5).
- When a page opens a tab outside the dispatch of an agent click (a script click that flipped, a timer), it has no
  background modifier, CDP doesn't say which tab is active, and sleight can't put the previous one back. The result says
  the tab probably took the foreground, with the reason: this click had no modifier, or the page opened it after the
  click. The click's result waits up to 1 s for a tab whose opening sleight has already heard about to finish being admitted. A
  page that opens a tab through an unseen `<base target>` flip 300 ms after the click put the line in that click's own result in
  18 of 20 runs (14 of 20 before the wait), and in the next click's result in the other 2 (20 of 20 by then). A tab that
  arrives after that, with no opening heard yet, waits for the next click. Measured 2026-10-15 on the pinned Chromium: a tab made with `Target.createTarget` in the background reports
  `visibilityState` `hidden`; once `Emulation.setFocusEmulationEnabled` is on for it (Playwright sends that for every page it
  attaches, and sleight's install does too) it reports `visible`, and `Page.screencastVisibilityChanged` says `visible: true` for
  a background tab. In the test bank every tab, background or not, reports `visible`. No CDP signal separates the tabs,
  so the report comes from the click and from popups that no click's settling accounted for.
- A page can raise a window it opened from another origin by calling `focus()` on the handle, an OAuth "Sign in again"
  button for one, and sleight can neither stop nor detect it. Measured 2026-10-15: the opener's `w.focus()` on a cross-origin
  popup made it the active tab (the test bank reads the browser's own tab list). The popup's own document, with the
  hook installed and `focus` wrapped, saw no `focus` call and no `focus`, `blur`, `visibilitychange`, `pagehide` or `resize`
  event, the same as the control without the call, so no code in that document can see it. The opener's `w.focus` is
  the browser's cross-origin accessor, so replacing `Window.prototype.focus` doesn't reach it, and returning a wrapper from
  `window.open` would break `event.source === popup`. In the browser, `focus()` on a window the incumbent opened doesn't need a user
  gesture, so no gesture check helps, and CDP has no command that refuses or reverses it. Calling `Target.activateTarget`
  on another tab afterwards would need to know which tab was active, and CDP doesn't say. Same-origin windows run the hook,
  whose `focus` does nothing for a top-level window. After every click and key press the result lists the tabs the page opened
  from another origin that are still open ("can be raised to the foreground by the page, and sleight cannot block or detect that").
  It lists them whether or not the page called `focus()`. A window opened with `noopener` (the default for a `target=_blank`
  link) or one that dropped its opener gives the page no handle, so it isn't listed.
  The list costs one `Target.getTargetInfo` per listed tab per click. Measured 2026-10-15 with one and three such tabs open
  (25 clicks, median of the last 20, two runs each): 624 to 633 ms against 625 to 632 ms without the list, inside the noise of the 600 ms observation wait.
- In turbo v3, the popup hook is a random window property, frozen and non-configurable, and every call to it
  carries a one-use proof made with a per-registry secret. Its answers are signed with the same secret. A page that
  replaces, deletes or redefines the property, calls `off()`, or replaces `window.eval` or `Array.prototype.slice` to
  read or forge what Playwright carries (40 real-browser cases in `hook-key.real.test.mjs`) cannot switch the hook
  off, steer a request, or get a foreground tab. The proof code doesn't read anything a page can redefine: the secret is
  injected as byte values, and no typed array length, prototype method or Math function is called after install
  (round 1 read the secret through `%TypedArray%.prototype.length`, which a page could redefine to copy it). It can read the proof off an evaluate argument and use it first, which
  fails that one click closed ("preparation failed"), so a page can stop turbo v3 from clicking anything on it. The hook
  also reads its globals from copies taken before page scripts, so replacing `window.Element` and the rest changes
  nothing; replacing the prototypes behind them (`Element.prototype.localName`, `Set.prototype.has`, `Array.prototype`
  methods) is still unmeasured outside the swap shield, which reads only natives it captured. A same-origin window the
  page opens keeps the opener's key and secret, so a page that plants a property at that key before the hook installs
  makes the install fail, and that tab is not adopted. The source for a handle's first document goes to that window's `eval`
  once, and only if the window is not hooked yet. A same-origin window the page controls, never opened through the hook and
  without a hook of its own, could replace its `eval` and read the key and secret from the source. We built no such page. Found 2026-10-15 (AD1 pop round 2).
- Before a click is sent, turbo v3 seals what the click activates and arms every other frame as foreign. Trusted input that no longer matches the seal is cancelled. Limits of that check (AD1 swap rounds 3 and 4, 2026-10-15):
  - A frame on another site has no hook, because the registry's script is on the page target. The shield skips it, and a click that ends up in it is only reported afterwards, by the landed check.
  - A same-site frame that answers "no hook" fails the click before it is sent, since a page can fake that answer. The result says to use the engine browser path. A popup's child frames that began before sleight adopted it get the hook installed at adoption. A frame that can't run scripts (its iframe's `sandbox` attribute, or an ancestor's, lacks `allow-scripts`) doesn't fail it. The registry's script runs there but no listener ever fires, so arming it returns false (or the hook is absent), and nothing in the frame can run page code or forge an answer. The attribute is read from the parent's side in the utility world after a frame gives either reply. A page can change the attribute after the frame loaded, which skips that frame like a cross-site one (the landed check reports it afterwards). A frame sandboxed by a CSP `sandbox` header, with no attribute, isn't recognized and can fail the click closed (measured 2026-10-15: `<iframe src>` to a response with `content-security-policy: sandbox`).
  - A click handler registered after the last guarded event can still change the page, and `form.submit()` or `fetch` from a key handler can't be vetoed.
  - A frame the browser creates or navigates between the last confirm and the press arms itself from its parent's state when it is same-origin. One under a cross-origin parent can't.
  - A foreign shield that can't be released (the frame stopped answering) keeps cancelling trusted input in that frame until its hard cap, about 25 s.
  - A frame with a hook that doesn't answer within the timeout fails the click before it is sent. Not measured on pages with many slow frames.
  - The digests from the rules' read go to the hook as an evaluate argument, which a page that replaces Playwright's machinery can alter, so `expect` can miss a swap made between the seal and the rules' read. The press-time check still compares the whole seal.
  - The runner without a v3 context (`act.mjs` alone) reads the element before the seal and has no digest tie.
  - Background-tab timer throttling of the 40 ms fallback in `settle()` is unmeasured (it needs a headed window).
  - On 12 ordinary pages, 8 fresh clicks each, 64/96 clicks went through the first time and 96/96 after one retry. The pages that cancel the first click (four of the 12) change the checked element on mousedown or in a focus handler, or replace it on its first pointerover or the next frame. A scroll-spy page with a button 3,000 px down reported "Trusted turn or target evidence is unavailable" 8/8 on 2026-10-15, before and after round 4. We haven't found why.

## Turbo viewport and offscreen markers

- `[offscreen]` and `[partly offscreen]` compare an element's box with the page's viewport only. A scroll container or an overlay that
  clips the element isn't counted, and refs inside frames (`f2e1`) never get a marker. Checked on a tall page at 390x844 with a real
  headless Chromium. Not checked on pages with scroll containers.
- An empty `viewport` step and the tab's release clear every override. The tab then follows its window again.
- Touch emulation refuses a tab that already reports touch capability. Clicks stay mouse clicks. Release uses private fields of the pinned Playwright, and a failed first size read reports "unknown". Real windows at 125% and 150% zoom are unverified.

## Turbo closed shadow roots

- Controls inside closed shadow roots (refs `s1`, `s2`) take click, check, uncheck, type, select and key presses through the same
  pinned-node path as other refs. They resolve from the snapshot's CDP backend node into a Playwright element handle, which depends on
  the pinned in-process Playwright 1.64.0 internals (`closed-handle.mjs`). A Playwright upgrade can break that handle; the failure is
  the message "Closed-root actions need the in-process browser connection", and `tests/direct-browser-closed-handle.test.mjs` shows it.
- `browser_fill` on a closed-root combobox, listbox or reorderable list can't search for its options, because Playwright locators can't
  enter a closed root. Use `browser_act` click on the option refs from the read. Not measured on a real closed-root combobox.
- A key press on a closed-root element that isn't a button or an input needs CDP's answer that the element hosts no closed root itself.
  Without that answer (the node was resolved some other way) the press is refused, because a focused closed host looks the same as its
  inner receiver from the page.
- A key press on a light-DOM div, span or custom element asks CDP the same question and goes through when the node hosts no shadow root.
  It costs one extra CDP call, and only after the page-side proof refused. Measured on a `div role=combobox tabindex=0` (arrow keys
  worked) and on a div hosting a closed root (refused), 2026-10-15.
- A key press in a cross-origin iframe is refused for closed-root and light-DOM refs alike, because focus can't be proved up the frame
  chain from inside the child (1 closed and 1 light fixture, 2026-10-15). Clicks and fills there work. Not measured in an
  out-of-process frame: the cross-origin fixture frame shared the page's CDP session.
- Payment terms (item, amount, payee) are read from the nearest form or dialog around the control, climbing from the closed root to
  its host. The text walk doesn't enter shadow roots, so terms shown inside a different closed root should not be read, and
  that Pay button should need confirmation even when the user's message names the exact payment (from the code, not measured).
  Measured on 4 fixtures: terms in the button's own closed form and in the page form beside its host were both read (2026-10-15).
  The final payment check (any figure above the requested amount asks) reads the same form. A closed card form with a 25.00 total
  beside the 18.00 amount asked even with the exact payment in the message. A div `role=button` in a card form asked for a click,
  Enter and Space (2026-10-15). A figure inside a different closed root is not seen.
- Closed-root controls go through the same safety layer as other refs (the click seal, the popup hook, the payment rules, the key
  shield). `tests/direct-browser-closed-ad1.real.test.mjs` runs 12 cases with a light-DOM twin beside each (2026-10-15). The pinned
  handle is the control itself. The seal is taken from that element, a ref can't be re-bound to another node, and a node the page
  removes fails the action as stale. An event inside a closed root arrives at the window's listeners with only the outermost closed
  host in its path. So the hook also listens on each closed root above the checked element and cancels any press, release,
  click or key whose path from inside the root lacks the sealed element. Measured: a page that slides a second button over the
  checked one in the same root on pointerdown gave that button pointerup and mouseup before this listener and nothing after, the
  same as the light-DOM twin. A keydown handler that moves focus to a sibling in the same root gave the sibling a keypress before and
  nothing after. A listener the page registered on the same closed root earlier runs before the hook's, and the hook can't be first
  in a root the page made. A change to an attribute inside a closed root (a link's or form's `target` flipped in the control's own
  click handler) is watched through that root too. Before 2026-10-15 a closed-root link flipped that way opened a foreground tab.
- A page that swaps the clicked control gives the new one zero events, closed or light. A swap on pointer arrival means the click
  isn't run. A swap on mousedown gives the result "page changed during the click". 4 of 4 fixtures, 2026-10-15.
- A protected field's value is removed from the rest of a read only when it has 4 or more characters. A value of 1 to 3 characters
  (a 3-digit CVV, a 2-character PIN) is hidden in its own row and nowhere else, so a page that echoes it elsewhere shows it. A
  value of 4 to 7 letters in a Latin, Greek or Cyrillic script is removed only as a whole token, so it still shows when glued to
  other letters or digits ("test" in "test1"). Before 2026-10-15 the value was blanked wherever its characters appeared, and "o"
  turned "Account controls" into "Acc[redacted]unt c[redacted]ntr[redacted]ls". Checkbox, radio and button values are not scrubbed.

## Turbo option lists

- `browser_fill` on a listbox or combobox finds options by `role=option` or `<option>` inside the list it names. Rows drawn as plain
  divs, buttons or links without those roles aren't found, and the message says no option matches.
- The search bisects a list that reads as sorted by visible text and walks every other list from the top, 8 s at most. On a sorted
  400-row list a hit took 0.4 to 1.8 s and a miss about 2 s (fixture runs, 2026-10-15). A list that reorders itself while it is
  searched, or loads rows only after a delay, can end as "ran out of time". Not measured on a real infinite-scroll list.
- A combobox that filters on a different spelling than the option text gets up to three typed queries (the text, without brackets,
  its first two words). After a miss the field is typed back to the asked text.

## Electron debugger consent (not in a release yet)

- Always allow records for an Electron app's debugger are sealed with an HMAC key in a 0600 file beside them
  (`grant-seal.key`). A hand-written record, an old unsealed one, or one with a changed field is refused (unit-tested,
  2026-10-17). A process running as you, including Claude's own shell, can still read that key and seal its own record
  for an app build. That build then gets the debugger without the card until you revoke it. The engine's own app
  approval is still required. A seal that same-user processes can't read (a keychain item limited to the consent host
  binary) isn't built. The consent host is compiled on your Mac and its code identity changes with each build. A
  keychain item bound to it would prompt you after every rebuild.
- The resident Electron host's ownership journal is sealed with `host.key`, also a 0600 file. A same-user process can
  forge the journal and make the host refuse a launch or report a wrong owner. It can't open the host's channel,
  whose admin secret the parent passes for each start and never writes.
- The MCP server process holds the host's admin secret in memory and hands it to each turbo worker it starts, so a new worker
  reaches the host an earlier one started (unit-tested, 2026-10-18). The next Claude Code session runs a new server with a
  new secret. The new server can't administer a host and app from the earlier session, and turbo answers that you should quit the
  window sleight opened, until you quit that instance with the app's own Quit. Measured live: not yet.
- Killing the resident host (`kill -9` from Claude's shell is one way, which the write guard doesn't stop) closes the
  app's debugging pipe, and Electron quits on pipe EOF, so the window sleight opened quits without its unsaved-work prompt.
  Your own instances of the app aren't affected. Keeping the pipe open past the host needs another process to hold it, and
  that isn't built or measured.
- A second Claude Code session on the same opted-in app gets that same quit-the-window answer, not ELECTRON_BUSY: its
  server has another secret, and the host takes one administrator at a time. ELECTRON_BUSY separates sessions only over
  one host channel, which is what the EPV3-8 contention cell measures.
- The Claude in Chrome prompt watcher (`bench/fowl/chrome-allow.mjs`) has not run against a live prompt. The prompt's
  Accessibility shape (window title, whether Chrome exposes the extension page's URL and button labels) is unmeasured, so the
  matcher declines anything it cannot place and logs a role-and-label skeleton to `approvals.jsonl`. Turning on Chrome's page
  accessibility for the prompt may slow pages in that round, which isn't measured.

- Cursor pause controls refuse screen-reader presses, as consent cards do; the menu accepts a fresh hardware mouse click or
  Space, Return or Enter on its highlighted row. A paused cursor host is replaced once; if that fails, start a new session.
