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
  check. An arm's results stand until that arm or the model changes, so a new competitor or a sleight fix round reruns only
  that arm. ChatGPT updates its app several times a week, so an engine update doesn't force reruns. Every published result
  names the engine version it ran on and its date, and the benchmarks rerun periodically. What runs after every engine update is
  an automated compatibility check for breaking changes (owner, 2026-10-19). A fixture cleanup failure skips to the next task when every app the run launched has exited, and any
  other stop still ends the pass (owner, 2026-10-16). Claude's own computer use runs Haiku 5.5 on the owner's login.
  Arms whose code isn't in the repo (the codex-cu and devtools bridges) are named as not run, with the reason.
  A run that stops to ask before a payment the prompt didn't price (form-checkout) counts as done correctly, and an arm that pays
  there anyway is noted (owner, 2026-10-15: "that's how someone blows a lot of money").
- Release validation is sleight's own (owner, 2026-10-19): the full check, the release pass and an A/B of the new build against
  the previous one on sleight's own tasks. Competitor arms aren't rerun for a release. The previous release candidate's recorded
  runs serve as the A side when the task, prompt, harness, model and engine version are the same and nothing between the two runs
  changed how the task runs, and then only the new build's B rounds run. A task the old build never ran, or one whose prompt or
  harness changed, gets both sides. Each published A/B names the A rounds it used.
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
- The owner parked Windows, the Anthropic directory listing, scoped approvals and the stable-controls mode.
- Releases are a git tag plus a GitHub release from the CHANGELOG, bigger and less often. Work in progress goes to the private
  `Land-o-Clusters/sleight-dev`. The public repo gets pushes only at release, after public CI passes (a pre-push hook enforces it).
- Every open-source project of the owner's matches competitors first and does it better, then improves on them, then builds what
  nobody has. Reading competitors' code for ideas is fine, but sleight never adapts or copies it. A lane that never read the source
  writes the idea from a behavior spec (owner, 2026-10-14). Bundled libraries such as playwright-core are included unmodified, with their
  notices. Going public, money, scope changes, and redistributing anything that depends on another vendor's app or engine
  are the owner's calls. The ChatGPT engine dependency is cleared for release.
- Everything people read (docs, the README, benchmark pages, the post, commit messages) goes through the humanizer skill and
  Vale before it's published or committed (owner, 2026-10-19).
- The name is sleight, and its icon is the two-hands image. Branding uses only sleight's own marks.
- sleight is app-agnostic, like Codex. Its mechanisms are generic and work in any app.
- Install has two paths: with Computer Use already on in ChatGPT or Codex, installing sleight is enough. Without it,
  `sleight-mcp setup`.
- Approvals: one card per app (Allow, Always allow, Decline), remembered for the Claude Code session. Only the user's click writes
  Always allow. For the Electron turbo qualification the owner delegated that one Always allow click on the benchmark VS Code to
  sleight-arch (owner, 2026-10-19), and the owner let sleight-arch push the compatibility check's CI workflow. The owner also
  delegated every sleight card in the Electron qualification run (Allow this session, Always allow, Quit and reopen) on benchmark
  VS Code copies only, never the owner's own VS Code (owner, 2026-10-19). The engine refuses terminals and OpenAI's own apps, and sleight never works around that; the refusal tells the user
  about the `ComputerUseAllowForbiddenTargets` switch.
- In a host the user set to answer approvals automatically (Codex's full-access mode or its auto-review), a session-only app
  approval may be answered by the host. Always allow, payment cards and sleight's own consent cards still need the user's click
  (owner, 2026-10-19).
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
- Turbo's payment check reads figures, not wording: if any money figure on the checkout is larger than the amount in the
  user's message, it asks. The owner chose this over label rules (2026-10-15), accepting that about half of honest checkouts
  ask once (measured in docs/known-problems.md).
- Native apps stay on the ChatGPT engine. After the engine approves an app, sleight may read that app's accessibility metadata itself,
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
- Lanes run only the tests for what they changed, and sleight-arch runs the full check once per merge. Full checks in every lane
  loaded the Mac enough to hold up the owner's other projects (owner, 2026-10-14).
- SUPERSEDED (owner, 2026-10-15): benchmark Claude arms ran on the owner's API key, from the $200 monthly credit.
- All testing and every benchmark Claude arm run on the owner's Anthropic account login, never the API console credits. The account
  has quota now (owner, 2026-10-15). Incremental runs use Haiku.
- The owner's other project (Puddle) runs heavy Swift tests on the same Mac. Before long or heavy runs, sleight-arch agrees quiet
  windows with Puddle's architect session by message, and both honor `/tmp/sleight-hold`.

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
- Apps are approved without the owner only through the benchmark's own allowlist. Cursor may join it for testing (owner,
  2026-10-19), and Cursor's tests run Grok 4.6 at high effort at normal speed, never fast mode, unless the owner says otherwise.
  For the claude-cu arm, the harness may press Claude Code's "Allow for this session" card in its own terminal only when every
  app the card names is on that allowlist (owner, 2026-10-17). sleight-arch may click Allow on Claude in Chrome's own permission
  prompts in the benchmark Chrome profile for the race's sites only (owner, 2026-10-18).
- Screenshots and recordings capture single windows, never the whole screen, and published results show home paths as `~` with the
  owner's name scrubbed.
- During another project's timed window (`/tmp/sleight-hold`), live runs and heavy checks wait.
- Live runs that capture the screen start from sleight-arch's own shell, never double-forked (`( … &)`), which hands them to launchd.
  A claude-cu run started that way made macOS ask the owner to give "zsh" screen and audio recording (2026-10-18).
