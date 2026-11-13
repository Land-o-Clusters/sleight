# sleight laws

The owner's decisions, and the few rules that protect the owner and their Mac. Everything else is sleight-arch's judgment.
Facts about the engine are in [engine-notes.md](../engine-notes.md), and current status is in [STATE.md](STATE.md).

## The owner's decisions

- The goal is a published claim that sleight is the fastest computer use plugin for Mac, measured against Claude in Chrome,
  Claude's own computer use, FowlBrowser, Codex, LCU and other reputable plugins. Haiku 5.5 at high effort drives the benchmark,
  with one Opus head-to-head for the headline. The Codex arm runs gpt-6-luna at the same effort. sleight also runs inside Codex as its plugin (MCP server), on gpt-6-luna and on
  gpt-6.1-sol, in real browser windows (owner, 2026-10-18). Benchmark runs publish every
  result, failures included, with the model ids each arm actually ran.
  Browser tasks are tested only against turbo, never sleight's engine browser path (owner, 2026-10-17), so the native claim
  suite is the 9 native tasks in bench/claim-tasks.txt, plus app tasks in VS Code, Slack and Spotify, apps people use (owner,
  2026-10-18, replacing VS Code and Cursor). VS Code runs as a separate instance with a temporary profile and fixture content.
  Slack runs in the owner's throwaway account on this Mac and posts one fixed message in one test channel. Spotify runs in the
  owner's account and searches, plays and pauses a track. These tasks run on the native path users get in 1.3.0, and Electron
  turbo comes in 1.3.1 with the relaunch flow (owner, 2026-10-18, decision F3). That covers the browsers turbo drives. In Safari and Firefox, which
  turbo can't drive yet, sleight races on the engine path, and the headline's wording follows that race (owner, 2026-10-17,
  ROADMAP 1b).
  The word "fastest" is used only if sleight has the lowest expected time on a majority of the 9 native tasks and the lowest total,
  with 5 runs on every task within 20%. Otherwise the wording is "completed every task, fastest on N of 9". The post says the suite
  is sleight's own, which tasks the skill was tuned on, and that competitors ran their defaults (owner, 2026-10-17, set before the
  claim run).
  Claim results run a fixed claim suite, one task per skill, 3 runs per arm, with 5 runs where sleight and an arm are
  within 20%, measured as the difference over the slower arm's expected time. After sleight's final claim run, the arms that
  land within 20% get one top-up round to 5 runs, and then the results stand; a later sleight change makes a new claim
  (owner, 2026-10-17, so the rule can't loop). They give the median and range, and p90 only at 5 runs. The full suite runs once per release as a regression
  check. An arm's results stand until a threshold trips (owner, 2026-10-26): nightlies and unreleased commits never trigger
  a rerun; a stable release reruns its arm only when its notes touch what we measure (speed, the action path, how it drives
  the browser or apps), and otherwise only the version note changes; before a public claim, the arms it quotes are refreshed
  when their pinned version is over 30 days old or two stable releases behind; a competitor's published speed claim that
  contradicts ours reruns that arm. FowlBrowser has no releases. Its commits since our pin count as a release and pass the
  same test: they rerun its arm only when they touch what we measure. A new competitor or a sleight fix round reruns only that
  arm. Cursor IDE's Computer Use joins the arms (owner, 2026-10-26). ChatGPT updates its app several times a week, so an engine update doesn't force reruns. Every published result
  names the engine version it ran on and its date, and the benchmarks rerun periodically. What runs after every engine update is
  an automated compatibility check for breaking changes (owner, 2026-10-19). A fixture cleanup failure skips to the next task when every app the run launched has exited, and any
  other stop still ends the pass (owner, 2026-10-16). Claude's own computer use runs Haiku 5.5 on the owner's login.
  Arms whose code isn't in the repo (the codex-cu and devtools bridges) are named as not run, with the reason.
  A run that stops to ask at a page dialog that widens what the prompt asked for (form-settings-helium's every-device scope)
  counts as done correctly, like the unpriced checkout below (owner, 2026-10-27).
  A run that stops to ask before a payment the prompt didn't price (form-checkout) counts as done correctly, and an arm that pays
  there anyway is noted (owner, 2026-10-15: "that's how someone blows a lot of money").
- Release validation is sleight's own (owner, 2026-10-19): the full check, the release pass and an A/B of the new build against
  the previous one on sleight's own tasks. Competitor arms aren't rerun for a release. 1.5.0 is the exception: it waits for the Cursor arm run (one more
  window, and a new kind of harness failure there releases 1.5.0 without the Cursor results, which publish with 1.6.0, owner,
  2026-10-30) and
  the FowlBrowser rematch (owner, 2026-10-28), and for the parser-based code inspection (CA1 to CA4) that replaces the
  hand-written tokenizer (owner, 2026-10-28 evening), and for the Safari wrong-field guard SB3 (owner, 2026-10-29). 1.5.0 and
  1.6.0 are separate releases (owner, 2026-10-29). The previous release candidate's recorded
  runs serve as the A side when the task, prompt, harness, model and engine version are the same and nothing between the two runs
  changed how the task runs, and then only the new build's B rounds run. A task the old build never ran, or one whose prompt or
  harness changed, gets both sides. Each published A/B names the A rounds it used. A point release runs only the groups its
  changed code can affect, 3 runs a side, with no Opus round; Opus numbers come from the claim and race runs (owner,
  2026-10-22). When an A/B shows a slowdown, the fix is measured by rerunning only the slow tests (and any group the fix's changed
  code can affect), and the rest of that A/B stands (owner, 2026-10-26). The rerun runs both sides again, interleaved, at the
  first A/B's run count, and its pass rule is the first A/B's rule, fixed before the rerun starts. A release A/B passes when no
  group is slower than its detectable limit (8% Chrome, Firefox and AS-3 Firefox; 20% native, Safari, AS-3 Safari and CC),
  measured on passing runs with the early-stop check's statistic, and no group loses 2 or more passes. One group that misses
  blocks the release until it is traced, fixed and rerun on its own (owner, 2026-10-26). Chrome's 8% is sized for Chrome
  Haiku at 5 runs a task. Chrome Opus runs once a task, so it uses the 20% limit and the same 2-pass rule (sleight-arch's call,
  delegated by the owner, 2026-10-26).
  The aim for every release is flat or faster than the one before (owner, 2026-10-27). Model noise and ChatGPT engine changes
  are tolerated, and so is a slight slowdown as features grow, but a large one (the first 1.5.0 Chrome round read 30%) isn't
  released, even inside a group's limit if it is plainly the build. A regression in sleight's own release is fixed before release,
  with Astra or Fable studies when needed. That is not scoreboard tuning.
  How "flat or faster" is measured (owner, 2026-10-27, from study NT1). The release A/B against the previous release keeps
  its limits, run counts and 2-pass rule, and catches large slowdowns. Drift is capped against a fixed 1.4.2 reference: each
  release's measured change against 1.4.2 is recorded per group, and a group whose total reaches 5% gets a dedicated large
  run against 1.4.2 (about 30 runs a side in Chrome) before the next release. Tool-side changes are proved flat by replay,
  and changes to what the model sees by turn counts as well as time. Timed runs go in quiet windows with Mac load recorded
  for every task. The reference suite is the tasks 1.4.2 runs today. A new task is compared with the previous release
  only, and joins the reference suite once two releases have run it. A task 1.4.2 never passes is reported apart from the
  reference timing and never dropped quietly. A changed prompt, fixture or harness makes a new task version. A group run
  at more than about 10 runs a task uses a pass-rate rule fixed before the run instead of the 2-pass rule.
  1.5.0 may be released with Firefox slower than 1.4.2 if, after its fix round, it is inside its limit. Firefox and Safari
  speed are then a 1.6.0 focus (owner, 2026-10-28). The release and claim benches keep a best-ever record per task: the
  lowest median passing time any build has reached, noted with its build, engine version and date, so drift shows against
  our best and not only against the last release. It stays internal and is not published (owner, 2026-10-28).
- Tuning goes only to tasks sleight still loses across the claim and race trials. Where sleight wins, nothing gets tuned (owner,
  2026-10-18). Generic fixes that also change a task sleight leads (Word steering, the keyboard drag route) are allowed when they are
  measured on held-out tasks, never on the claim task itself, and pure scoreboard tuning (SP2, PV1) stays out (owner, 2026-10-18
  evening). A task counts as lost when a competitor has the lower expected time or a faster passing run (owner, 2026-10-18,
  after Codex's 36.5 s checkout against sleight's best of 52.5 s). Loss studies start once each browser's rounds finish, beginning with Firefox.
- Codex's numbers on the same tasks are the speed bar. sleight is light enough that nobody notices it running, and its skill, tool
  descriptions and notices count against one small budget. When a competitor releases, sleight answers with a same-day head-to-head.
  Releasing on speed before footprint parity is the owner's call.
- An art-direction architect, which the owner boots, directs the launch video's art (owner, 2026-10-16). sleight-arch supplies the
  real captures, the race runs and the measured numbers. The owner publishes the launch post.
- The owner parked the Anthropic directory listing, scoped approvals and the stable-controls mode. Windows PCs were parked
  too until 2026-10-26, when the owner unparked them and started the work as Codex lanes (study: ledger/vc/W1-windows-study.md).
  On Windows, sleight drives native apps with its own background driver on UI Automation and window messages, because
  OpenAI's Windows engine takes over the desktop. That engine is at most an optional foreground fallback. The Mac rule that
  native apps stay on the ChatGPT engine doesn't apply on Windows. The test VM runs the free Windows Insider Preview for ARM
  under its own terms, and a paid license waits until Windows is released (owner, 2026-10-26).
  Windows driver safety (owner, 2026-11-01, Fable's UC3F recommendations). The driver refuses before input, and stops
  mid-typing, when the person's hardware input is under 500 ms old and goes to the target's process (pointer motion
  only over the target). During a turn that acts on an app it installs a keyboard-only low-level hook, removed after 60 s idle,
  and any physical Escape stops sleight for the rest of the turn wherever focus is, still reaching the person's app.
  It refuses a locked session, a screensaver and the secure desktop, with a locked-screen opt-in only after the
  sitting and only by the owner. Browsers are refused through the native driver in 1.6.0. The C# refuses terminals and
  OpenAI's apps itself, and the docs say the trust boundary is the Windows user. The shell guard learns Windows
  launcher commands during driving turns.
- Releases are a git tag plus a GitHub release from the CHANGELOG, bigger and less often. Work in progress goes to the private
  `Land-o-Clusters/sleight-dev`. The public repo gets pushes only at release, after public CI passes (a pre-push hook enforces it).
- Every open-source project of the owner's matches competitors first and does it better, then improves on them, then builds what
  nobody has. Reading competitors' code for ideas is fine, but sleight never adapts or copies it. A lane that never read the source
  writes the idea from a behavior spec (owner, 2026-10-14). agent-desktop is the one exception, under the runtime line below.
  Bundled libraries such as playwright-core are included unmodified, with their
  notices. Going public, money, scope changes, and redistributing anything that depends on another vendor's app or engine
  are the owner's calls. The ChatGPT engine dependency is cleared for release.
- sleight builds its own computer-use runtime, because relying on the ChatGPT engine will hurt it one day (owner, 2026-10-31). It
  may start from a fork of agent-desktop (vercel-labs, Apache-2.0) that keeps its license and NOTICE, marks changed files and
  uses none of Vercel's names or marks. It learns from the ChatGPT engine and other runtimes by their behavior, and takes code
  from another project only when that project's license allows it. The engine's helper app and its cua-repl layer come with no
  open-source license, so nothing is copied from them. The runtime replaces the engine only when it is as fast as or faster than
  the engine path of that day on the release suite, with feature parity: background drag, keys, double-click and hover without
  taking focus, screenshots with the tree, approval cards and every guard. The owner accepts however much work that takes.
  sleight's own runtime keeps refusing OpenAI's apps (ChatGPT, Codex, Atlas) in its opt-in preview, as the engine does
  (owner, 2026-10-31, RT28), to be revisited for 2.0. It keeps refusing terminals outright too, with no click-only tier
  (owner, 2026-11-01, UC2 L9, revisit for 2.0). While the Glide engine acts on an app, sleight shows a Stop control in its
  own consent window (no keyboard tap and no Input Monitoring grant) that ends the current action within 500 ms and
  releases held buttons and keys (owner, 2026-11-01, UC2 L10b). The runtime reads and returns what the engine returns, field values in
  its tree reads included. For selectText, paste and setValue it may search a text element's value (up to 1 MiB) and
  return only the selected range and a match count. Secure fields are never read (owner, 2026-10-31, RT9).
  The runtime's paste never writes the general pasteboard: it delivers text through a direct input path the target
  supports, or refuses before any input and says why (owner, 2026-11-01, CB1, on sleight-arch's recommendation, because
  no save-and-restore scheme can keep a copy the user makes mid-paste). The runtime refuses Copy and Cut it can identify by
  physical key or menu key equivalent before input, and stops the turn and tells the user when the general pasteboard's change
  count moves during or right after one of its actions. It never reads the clipboard's contents and never restores it. A Copy
  the user's own message asks for is still refused in 1.6.0. Control+C and Control+X are allowed, with the change count as the
  backstop (owner, 2026-11-01, Fable's CB1G answers). Its reads may return a document's structure as text
  (paragraph styles, tables, cursor and selection, capped at 4,000 characters) after the app's approval, with secure fields
  redacted, never logged, and never used to bind a drag endpoint (owner, 2026-11-01, VF1 I2). The rule below
  against reading document content covers sleight's own reads beside the engine path, not the runtime that replaces it. The preview is released in 1.6.0, folded in from 1.7 so one release A/B
  covers both (owner, 2026-10-31 evening).
  The owner joins the Apple Developer Program for signing and notarization (planned for the weekend of 2026-11-01). Until
  then the helper compiles on the user's Mac at first use. The helper uses the host app's Accessibility and Screen Recording
  grants (the terminal or the Claude app) for now, with that exposure stated in the README (owner, 2026-10-31).
- Everything people read (docs, the README, benchmark pages, the post, commit messages) goes through the humanizer skill and
  Vale before it's published or committed (owner, 2026-10-19).
- The name is sleight, and its icon is the two-hands image. Branding uses only sleight's own marks.
- sleight's own computer-use runtime is the Glide engine, and its helper binary is `glide-engine` (owner, 2026-11-01). Docs,
  code and model-facing text always say "the Glide engine" or "the ChatGPT engine", never a bare "engine".
- No commit, tag or file in either repository carries the owner's name, username, home path or personal email. Commits are
  authored as penguinspecz with the GitHub no-reply address, and `scripts/release-history-scan.mjs` must come back empty
  before any public push (owner, 2026-10-20, after the history rewrite).
- The launch film leaves out the ghost hand (owner, 2026-10-20).
- sleight is app-agnostic, like Codex. Its mechanisms are generic and work in any app.
- Install has two paths: with Computer Use already on in ChatGPT or Codex, installing sleight is enough. Without it,
  `sleight-mcp setup`.
- Approvals: one card per app (Allow, Always allow, Decline), remembered for the Claude Code session. Only the user's click writes
  Always allow. For the Electron turbo qualification the owner delegated that one Always allow click on the benchmark VS Code to
  sleight-arch (owner, 2026-10-19), and the owner let sleight-arch push the compatibility check's CI workflow. The owner also
  delegated every sleight card in the Electron qualification run (Allow this session, Always allow, Quit and reopen) on benchmark
  VS Code copies only, never the owner's own VS Code (owner, 2026-10-19). The engine refuses terminals and OpenAI's own apps, and sleight never works around that; the refusal tells the user
  about the `ComputerUseAllowForbiddenTargets` switch.
- Protected card buttons (Always allow, payment and action confirms, sleight's own consent cards) accept only a person's
  pointer or key input, never an Accessibility press or another process's posted event (GB12). In 1.4.0 that limit is
  accepted and documented: VoiceOver, Switch Control, Voice Control and screen-sharing users answer those cards with a
  physical keyboard or pointer. After 1.4.0, the card gets a person-only alternative such as a typed confirmation (owner,
  2026-10-20). The alternative is a typed confirmation: the card also accepts typing a short word it shows, read aloud by
  VoiceOver (owner, 2026-10-24).
- In a host the user set to answer approvals automatically (Codex's full-access mode or its auto-review), a session-only app
  approval may be answered by the host. Always allow, payment cards and sleight's own consent cards still need the user's click
  (owner, 2026-10-19).
- Remote approvals (owner, 2026-10-25): in Claude Code, the user's own typed message `allow <app>` (one or more apps, named in
  the user's words and read by sleight's mod before the model runs) approves those apps for the session. A bare "yes" doesn't
  count. When nobody is at the Mac, sleight doesn't wait on the approval card: it returns at once with the exact phrase to
  type, and the card stays up for whoever answers first. Before starting, sleight may ask once for every app the request
  names or implies through the Mac's default apps. Always allow, payment and action confirms and sleight's consent cards still need a
  person's physical input at the Mac.
- When the user's own message names what to pay, the amount, and what to pay with, that payment counts as confirmed, including the
  page's own confirm dialog. Any other payment asks, on the engine path and on turbo alike. A checkout whose amount the message didn't state
  asks once (owner, 2026-10-17, after the engine path paid $268 on an unpriced test checkout). `SLEIGHT_CONFIRM_PAYMENTS=always` keeps asking. `SLEIGHT_CONFIRM_PAYMENTS=never` lets a user opt
  out of the one confirmation for a purchase they asked for in their own message (owner, 2026-10-15: fully autonomous users
  shouldn't be stopped). Only the user sets it. A payment the user never asked for, such as one a page tries to trigger, still asks.
- A booking or reservation that the user's own message asks for counts as confirmed, as a named payment does, so sleight doesn't
  stop to ask again. Any money it charges still follows the payment rule above. A booking that only the page proposes still asks
  (owner delegated the call to sleight-arch, 2026-10-18, after travel r3 stopped before "Book trip").
- A form submit or save that the user's own message asks for is confirmed, like a named payment or booking. That covers the
  values the message names, notification switches included. A page's confirmation dialog that adds anything the
  message didn't name still asks. A security or privacy switch the message names with its value counts only when it makes the
  account safer (two-factor on, a profile made private, sharing off). Loosening one, changing a recovery email or phone, a password or
  connected apps, and a setup step that needs a code still ask (owner, 2026-10-19, replacing the 2026-10-18 ruling that asked before
  every security setting). Payments and bookings follow the payment and booking rules above (owner, 2026-10-18).
- Creating an account that the user's own message asks for, naming the username or email and the password, counts as a
  requested submit, though the engine's policy lists an account's final step as always-confirm. A sign-up only the page proposes
  still asks, and the engine's other always-confirm steps stay (owner, 2026-10-19, after Haiku refused 18 of 24 requested
  sign-ups).
- Mod-attributed turns (owner, 2026-11-01, Fable's MB1 recommendations). Typed approvals, turbo's user-turn binding,
  the payment and booking message and desktop turns come only from frames the relay can attribute to sleight's mod by a
  signal the model can neither produce nor remove. Sessions without the mod (`claude -p`, the Agent SDK, mods off) are in
  scope. Where no such signal exists, they behave as Cursor does, so approvals are answered on the card at the Mac and
  every payment asks on sleight's card. `SLEIGHT_DESKTOP_TURNS` waits behind the same check. One live traced check of the
  mod's calls picks the signal. For 1.5.0 and 1.5.1 the fix comes with a known-problems entry and a CHANGELOG line. A standalone
  advisory follows only if users run `claude -p` with turbo on.
- Sign-in handoff (owner, 2026-10-24): after the user's Continue click, sleight may acquire a native app's new window when it
  belongs to the same app (bundle id), with the usual lease and approval checks. Page watches read public pages only. A page
  with password fields, or one the user didn't mark public, is refused, and account pages need the user present.
- sleight's shell guard (owner, 2026-10-24) blocks commands that open apps, URLs or windows only during a turn in which sleight
  has driven an app or browser. SLEIGHT_SHELL_GUARD=0 turns it off, and a user's own commands in other turns are untouched.
- Sealed settings (owner, 2026-11-01, Fable's SG2 recommendations, ROADMAP 12b). sleight accepts a grant or settings file only
  when its seal verifies under a key that only the signed helper can read. Enforcement starts with the signed helper, and until
  then the plumbing only reports. On upgrade, unsealed grants are dropped (one Allow per app again), and the rest are adopted
  after a printed review and one Touch ID prompt. Removing a grant is sealed with no prompt. The user sees one line in the tool
  result, the doctor and the menu bar. The key is stored in the data-protection keychain under sleight's access group, with the
  legacy keychain only as a documented fallback. Routines, watches and the hand settings are sealed too. A follow-up has the
  signed helper check sleight's installed files against a signed manifest. In the release that turns sealing on, the shell guard shrinks
  to its literal and tree rules, with its false-refusal rate measured before and after.
- Cookie and consent walls (owner, 2026-10-24): sleight declines non-essential cookies by default, choosing the page's
  reject or necessary-only option, never accepting, and says so in the result. A wall with no reject option stops and asks.
- Turbo's payment check reads figures, not wording: if any money figure on the checkout is larger than the amount in the
  user's message, it asks. The owner chose this over label rules (2026-10-15), accepting that about half of honest checkouts
  ask once (measured in docs/known-problems.md).
- Native apps stay on the ChatGPT engine until sleight's own runtime is as fast with feature parity, as above (owner, 2026-10-31). After the engine approves an app, sleight may read that app's accessibility metadata itself,
  though never its document content. One exception for input (owner, 2026-10-17): a plain single click on an element in a group of
  sibling buttons or tabs that advertises AXPress may be pressed by sleight through Accessibility instead of a posted pointer click,
  in the background and after the same lease and identity checks, because Excel treated posted tab clicks as drags (6 of 8 runs).
  A second exception (owner, 2026-10-18, WK4): when the leased app's menu stays stuck open across two calls, sleight may post one
  Escape to that app's pid, once per stuck episode, in the background, never while the user is typing or moving the mouse, and it
  says so in the result. `SLEIGHT_STUCK_ESCAPE=0` turns it off. Reading document text for drag endpoints stays forbidden (FM6),
  and so does giving up on a read early (IN2).
  A third exception (owner, 2026-10-19, CC8): to bind a drag endpoint given by element number, sleight may compare the AXValue
  of AXStaticText elements in the leased window's content with a label the engine printed as `text <label>`, 80 characters or
  fewer, equal exactly. Static text under a text area, text field, combo box or layout area is never read, and neither are other
  roles' values. The value is only compared, never returned, stored or logged, and clicks and other tools don't get this.
  A fourth (owner, 2026-10-20, WD5): the drag tool's Accessibility text move may read the whitespace characters right next
  to the moved text, at the source and the destination, to collapse a double space or stray newline the way a native drag's
  smart insert and delete does. Those characters are only compared, never returned, stored or logged.
  A fifth, for sleight's own runtime (owner, 2026-10-31, RT5): when a keyboard shortcut posted to a background app doesn't
  take effect, the runtime may press the one menu item whose key equivalent exactly matches that shortcut, through
  Accessibility, after the same lease and identity checks, and it says so in the result.
  A sixth, for the Glide engine (owner, 2026-11-01, UC2 L5): its menu compound may press a menu item found by title path
  through Accessibility without opening any parent menu, in the background, after the same lease and identity checks,
  and it says so in the result. An item missing from the unopened menus falls back to opening the menu and choosing.
  Select_window may pick the one window of the same app whose title ends with a requested title of 12 or more characters when
  no title matches exactly, and says so (owner, 2026-10-19, LB5). The engine path may reuse a fresh before-action read under
  the conditions LB7 traces, merged only after a security review (owner, 2026-10-19). Three more guard changes may merge once
  their A/B and a security review pass (owner, 2026-10-19): CK3 proves window and focus after a tab shortcut with the helper
  probe instead of reading the New Tab page, CK2 acts on a moved plain line that appears exactly once with the same role, text
  and parent (never a payment target), and CK1 binds later setValues in a batch to the first read when each is a unique
  settable field.
- Electron saves (owner, 2026-10-18): sleight reports a save as confirmed only when the window shows its file path. Otherwise the
  edit is reported done and the save unconfirmed, with no other evidence path. The relaunch flow avoids taking focus, or the card
  says the app comes to the front briefly.
- The ghost hand is off by default in 1.3.1 (owner, 2026-10-19, after the cost pass measured textedit-drag 31 to 37 s with it
  against 23 to 26 s without), turned on from the menu bar dropdown, `sleight-mcp hand on` or the settings file. It becomes the
  default once a fix measures no slowdown in an A/B (the owner's 2026-10-18 plan had it on by default). A Fable art director designs its final art now. It shows in the user's own screenshots and recordings if
  the capture test proves sleight's own screenshots never include it. Otherwise captures leave it out.
- Browsers get turbo, sleight's own direct path, with no extension install. The user turns it on once through Chrome's built-in
  remote-debugging consent. Its benchmark proved it, so turbo is the default from 1.3.0 (owner, 2026-10-16).
  Turbo includes `playwright-core` 1.64.0, pinned, with its notices, and compiles two native helpers from source on the user's Mac
  at first use. Turbo follows the payment rule and never treats page content as an instruction or a permission. Before retrying a
  submit with an unknown effect it reads the page, it works in the background, and it checks only the element it acts on.
- Turning turbo on keeps the engine's browser path beside turbo's tools, and Claude picks between them. Turbo never removes a
  capability the engine path has, a mobile viewport for one (owner, 2026-10-14).
- sleight works in the background: it never switches Spaces or takes focus. Chrome's own consent prompt is the one exception.
- Electron apps get the same turbo after 1.3.0, opt-in per app, relaunching an app only on the user's click.
- Right after 1.3.0 come Electron and slimming the plugin. Slimming keeps only what turbo loads (V8 measured 15.4 MB down to 8.2 MB).
- Electron (2026-10-14): the debugger is its own opt-in per app, with Always allow written only by the user's click. sleight relaunches
  an app only on the user's click, through the app's own Quit. The connection lives until the user quits or disconnects, and
  revoking stops commands without closing the pipe. The accessibility reader matches PID and window, and ambiguity stops. Temporary
  profiles are for benchmarks only. Apps not yet qualified stay on the native path.
- Browser turbo's trusted confirmations use sleight's own window, outside the page. Connecting shows a short hookup animation and a
  connected indicator with Pause and Disconnect, and never hides Chrome's own indicators. Chrome and Helium are qualified separately.
  Each Claude Code session has its own turbo worker, and its Chrome connection is released when the session ends (owner,
  2026-10-15, replacing design v2's shared connection kept until Disconnect).
- Names (owner, 2026-10-19). Sol is OpenAI's gpt-6.1-sol, run only in headless Codex lanes (`codex exec`). Astra is OpenAI's
  gpt-6-astra, a Fable-class model for deep performance work and investigations, also in Codex lanes. Fable, Opus, Sonnet and
  Haiku are Claude models, and subagents run Claude models, never Sol or Astra. Item, branch and agent names never reuse "Sol"
  or "Astra". Work items get their own IDs, such as CR1 for a Codex race fix.
- Build work runs in parallel Codex lanes, and sleight-arch also builds, merges and tests directly whenever that is faster or
  better. Claude reviewers take reviews and the investigations sleight-arch or the owner needs. SUPERSEDED (owner, 2026-10-15):
  Claude usage isn't quota-limited. Builds, fix rounds and integrations go to Sol codex lanes by default, and Claude keeps reviews
  and Fable studies (owner, 2026-10-19, after 10% of the weekly Claude quota went in 2-3 hours).
  For safety-critical logic (anything that guards input, approvals, the clipboard or element identity), Fable or Astra
  first writes the invariant and the adversarial cases, and Sol then builds that rule (owner, 2026-11-01, after the
  stale-number and clipboard items each took three to five Sol rounds of case-by-case patches). Astra gets open-ended prompts.
- Every change is proven in small steps, never by betting on the final rounds (owner, 2026-10-19): unit tests and a review
  per branch, then a replay check for tool-side changes (the recorded tool calls sent straight to sleight's server, no
  model, switch on and off) or a 1-run traced smoke for model-side changes, as soon as the branch is built. Only what passes
  merges. Short A/Bs run only for model-side changes, on the tasks they target, and the release's validation rounds come
  last. Each new issue a run or study finds gets an item, a ledger line and a Sol lane in the same turn.
- A commit that changes only docs needs only `npm run lint:prose`. Code commits keep the full check (owner, 2026-10-30).
- Lanes run only the tests for what they changed, and sleight-arch runs the full check once per merge. Full checks in every lane
  loaded the Mac enough to hold up the owner's other projects (owner, 2026-10-14).
- SUPERSEDED (owner, 2026-10-15): benchmark Claude arms ran on the owner's API key, from the $200 monthly credit.
- All testing and every benchmark Claude arm run on the owner's Anthropic account login, never the API console credits. The account
  has quota now (owner, 2026-10-15). Incremental runs use Haiku.
- The owner's other project (Puddle) runs heavy Swift tests on the same Mac. Before long or heavy runs, sleight-arch agrees quiet
  windows with Puddle's architect session by message, and both honor `/tmp/sleight-hold`. Puddle's builders don't run tests while
  `/tmp/fable-sleight-window-done` is absent, so sleight-arch removes it when a window starts and touches it, with a "window done"
  message, when the window ends (owner-approved, 2026-10-28).

## Protecting the owner and their Mac

- Never delete or move the owner's files. Leftovers are named to the owner, who decides.
- Never drive the owner's main Chrome profile, or any browser window the owner uses: benchmark browser tasks run only in an isolated
  browser (on 2026-10-16 fixture tabs opened in the owner's Helium window beside their mail). Tasks in the owner's real accounts
  (mail, chat) only read, and only with the owner watching.
- Anything that shows windows, takes focus or moves the pointer runs only after the owner says they're away, or headless.
- Lanes and benchmark arms run with a throwaway Claude config, so they never put a keychain prompt on the owner's screen, and
  sleight-arch never answers macOS permission prompts for the owner.
- Scripts never send Apple events to an app this Mac hasn't granted Automation for (Excel raised a prompt on 2026-10-17). Fixture
  apps quit through NSRunningApplication and their own Don't Save sheet, answered through System Events.
- Apps are approved without the owner only through the benchmark's own allowlist. UTM joins it for the Windows VM sitting
  (owner, 2026-10-30). RT25's probe witness joins it for the runtime-versus-engine sitting, which then runs with the owner
  away except its screen-lock step (owner, 2026-11-01). RT31's VM input probe runs background rows only, with the owner
  away and no foreground or preference rows (owner, 2026-11-01). Cursor may join it for testing (owner,
  2026-10-19), and Cursor's tests and benchmark arms run Grok 4.7 at high effort, Cursor's current default, at normal speed, never fast mode, unless the owner says otherwise (owner, 2026-10-23).
  For the claude-cu arm, the harness may press Claude Code's "Allow for this session" card in its own terminal only when every
  app the card names is on that allowlist (owner, 2026-10-17). sleight-arch may click Allow on Claude in Chrome's own permission
  prompts in the benchmark Chrome profile for the race's sites only (owner, 2026-10-18).
- The Cursor arm (owner, 2026-10-23) measures the desktop app's Computer Use on This Mac in the owner's own Cursor with
  the owner's login, not a scratch copy (owner, 2026-10-27). It runs only when the owner says Cursor is free, and the
  harness leaves Cursor running and touches only the run's model and Computer Use selection. The harness may press "Allow in this chat" on Cursor's per-app cards for apps on the benchmark
  allowlist, never Always Allow. It may also press Cursor's per-call Run on an app-lookup (resolve_app) card when the card
  shows exactly Skip and Run and its arguments give exactly one app on that allowlist (owner, 2026-10-31). Every arm records both its own interval and the like-for-like one, from the task reaching
  the agent to the agent's end, and cross-arm results publish the like-for-like interval.
  The arm's prompt is entered by sleight itself (owner, 2026-10-28, after three days of a fixed accessibility script
  breaking on Cursor's UI). Before each entry turn the harness opens a new chat in Cursor through sleight (owner,
  2026-10-30). It clicks the labeled New Agent control and doesn't send keys (CE8, 2026-10-30), because the owner's Cmd+N
  may also have opened Mail drafts. SUPERSEDED: the harness Cmd+N, until an owner-present probe shows keys stay with Cursor. A short Haiku turn through sleight then confirms on screen that the chat is new and empty. It then sends the task prompt and lets go of Cursor. The harness then reads only that one new stored chat
  (timestamps, status, final answer) and presses Stop if it can't find exactly one new chat holding the prompt.
  sleight's driving time is outside the timed interval, which runs from the stored user message to Cursor's last reply.
  The entry drives like a normal sleight task, with screenshots and a few tries per step, and is limited only by its click
  allowlist (owner, 2026-10-29, who called Cursor a low-stakes account). Each run needs a fresh chat with no repo. The
  "@computer use" tag is optional, and the harness checks the linked chat's prompt and repo from storage. sleight's own MCP
  stays out of Cursor during benchmark runs (Cursor's third-party plugin import off), so the agent's only desktop tool is
  Cursor's Computer Use. Owner entry by hand (SLEIGHT_CURSOR_OWNER_ENTRY=1) is the fallback. SUPERSEDED: the one-attempt
  gate and the hand-entry plan from earlier on 2026-10-29.
  Cursor's agent runs with its defaults: a run that uses Cursor's other tools (file reads, search) isn't stopped. It is
  graded like any run, and the published results list the tools each run used and mark runs that did the task without
  Computer Use (owner, 2026-10-29).
- Screenshots and recordings capture single windows, never the whole screen, and published results show home paths as `~` with the
  owner's name scrubbed.
- During another project's timed window (`/tmp/sleight-hold`), live runs and heavy checks wait.
- Long live runs on the owner's Mac are resumable, and a stopped run is resumed from the round that stopped, never restarted
  from scratch; the owner's time with the Mac and their quota come first (owner, 2026-10-20, after a day of restarts).
  That includes a task that can't run. The bank records it as excluded on both sides with the reason, then continues
  from the same step. Restarting a bank to drop a task is not allowed (owner, 2026-10-27, after sleight-arch restarted the
  1.5.0 A/B 45 minutes in to drop cc-list-native).
- The owner doesn't use Chrome on this Mac; sleight-arch may quit it when a run needs it closed (owner, 2026-10-20).
- Live runs that capture the screen start from sleight-arch's own shell, never double-forked (`( … &)`), which hands them to launchd.
  A claude-cu run started that way made macOS ask the owner to give "zsh" screen and audio recording (2026-10-18).
