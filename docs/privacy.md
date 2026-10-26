# Privacy

sleight keeps its records on your Mac. This page lists everything it writes, where it lives, how
long it stays, and what leaves your Mac. Each claim cites the file it comes from, and a test
(`tests/privacy-doc.test.mjs`) fails if a path named here stops matching the plugin, so the page
cannot drift from the code.

## What sleight stores

| Data | Where and what | How long | Source |
|---|---|---|---|
| App approvals | In the relay's memory for the life of the Claude Code session. Declines and cancels are never remembered, and nothing is written to disk. | One session | `plugins/sleight/lib/relay.mjs` |
| Your pre-approved apps | `~/Library/Application Support/sleight/preapproved.json`, private to your account (0600). App name, risk level and the date added. sleight adds an app only on your click on "Always allow", and `sleight-mcp allow remove` takes one off. You can also edit the file. Claude and project settings cannot change it. | Until you remove the app | `plugins/sleight/lib/preapproved.mjs` |
| Pre-approval audit | `~/Library/Logs/sleight/preapproved-<pid>.jsonl`, private to your account (0600). One line per action your list approved: app, risk level, tool, time. Written only while your list is non-empty, and rotated to a `.1` file at 64 KiB. | Until you delete it | `plugins/sleight/lib/preapproved-audit.mjs` |
| Relay trace, opt-in | `SLEIGHT_TRACE=1` logs every relayed message to a `trace-<pid>.jsonl` file in `~/Library/Logs/sleight/`. Long strings are cut to 300 characters (`SLEIGHT_TRACE_CUT` sets the cut). Claude's JavaScript is recorded whole only with `SLEIGHT_TRACE_CODE=1`; without it, code is cut like every other string. Turbo's worker adds its ghost hand events to the same file: `hand-skipped` with the step's operation and a reason from a fixed list (such as `hidden-tab` or `covered`), and `hand-shown` with the operation and the hand's gesture. Page text, element names and screen points stay out. | Until you delete it | `plugins/sleight/lib/launch.mjs` |
| Turn receipts, opt-in | `SLEIGHT_RECEIPTS=1` writes one JSON file per used turn to `~/Library/Logs/sleight/receipts/`, private to your account (0600, folder 0700). Typed and pasted text, pasted and set values, single printable keys and window titles become length markers. The account's username and full name are scrubbed, and your home path is shown as `~`. Document text is kept only as SHA-256 digests. | Pruned to seven days or 200 files, whichever is fewer | `plugins/sleight/lib/turn-receipts.mjs` |
| Action log, opt-in | `SLEIGHT_ACTION_LOG=<file name>` appends one JSON line per action to that file in `~/Library/Logs/sleight/`, private to your account (0600). Paths outside that folder are ignored. Each line has the time, call id, tool, app or browser origin (scheme and host), action kind, target role, outcome, and the reason for a refusal as a category. A control's name is kept only when it's a generic word such as Save or Cancel. A line also has the length of typed or set text, but only for a plain text field whose line names nothing like a password, card, account, ID, bank code, PIN, expiry or birth date, and a named key or a Command or Control shortcut. Since 1.4.0 it also has the call's time in milliseconds, the relay's process id, how many reads it saved, and for the engine's browser path how many input calls the code names. `sleight-mcp stats` and the glove's menu read it back on this Mac. The [field list](settings.md#action-outcomes-and-the-action-log) is exact. Typed text, set values, a secure field's value or length, window and sheet titles, page text and screenshots stay out. | Rotated at 5 MB, two old files kept | `plugins/sleight/lib/action-outcomes.mjs` |
| Turn review, opt-in | `SLEIGHT_STATE_REVIEW=1` shows the same per-turn summary, with changed windows and observed Undo or Revert controls, in the pane without writing any file. | One turn, in memory | `plugins/sleight/lib/relay.mjs` |
| Saved-file backups, opt-in | `SLEIGHT_CHANGE_REVIEW=1` copies each file before Claude's first edit of it, into a `sleight-review-` folder in the system temporary directory, private to your account (0700). Undo restores the copy. | Deleted when the session ends | `plugins/sleight/lib/change-review.mjs` |
| Input leases | `~/Library/Application Support/sleight/leases/`: a JSON record per held window names its holder and its window (app, title or URL). A `.coordinator.sqlite` database supplies the cross-session locks. A lease expires after 30 seconds. | Removed on release; expired leases are ignored | `plugins/sleight/lib/input-lease.mjs` |
| Clipboard lock | `~/Library/Application Support/sleight/clipboard.sqlite`, private to your account (0600). A reservation held while a copy, cut or paste runs, so two sessions can't interleave. It doesn't store clipboard content. Clipboard contents pass through memory and the system clipboard. | During the action | `plugins/sleight/lib/clipboard.mjs` |
| Routines | Per routine: the reviewed task and script under `~/Library/Application Support/sleight/routines/`, with the launcher copy at `~/Library/Application Support/sleight/routine-launcher.mjs`. A launchd plist goes in `~/Library/LaunchAgents/`, and a private run log in `~/Library/Logs/sleight/routines/`. A `running/owner.json` lock (process id and start time) sits in the routine's folder while it runs. | Until `routine remove` | `plugins/sleight/lib/routines.mjs`, `plugins/sleight/lib/routine-lock.mjs` |
| Recordings | The JSON file you name (`/sleight record` defaults to `sleight-<session id>.json` in the working folder) and never replaces an existing file. It holds the session's successful sleight calls, with the JavaScript they ran. | Until you delete it | `plugins/sleight/hooks/register.tsx`, `plugins/sleight/lib/replay.mjs` |
| Demonstration recordings | The JSON file you name, written once (0600). `record --watch` also compiles an observation helper, cached under `~/Library/Caches/sleight/observer/`, staged through the system temporary directory. | Until you delete it | `plugins/sleight/lib/demonstration.mjs` |
| Window screenshots | A hover capture per call (`sleight-hover-` folders) and one file per blocked-app read (`sleight-blocked-<pid>-<time>.png`), written to the system temporary directory. Captures take the frame of the chosen window, never the whole screen. The pane's picture is passed to the pane in memory and written nowhere. | Life of the call | `plugins/sleight/lib/hover.js`, `plugins/sleight/lib/launch.mjs`, `plugins/sleight/hooks/snapshot.ts` |
| Browser surface cache | `~/Library/Caches/sleight/extensions.json`: whether the engine's browser inventory connected and when, plus a hash of the engine's launch command. No profiles, tabs or approvals. | Refreshed each session; used for 6 hours after a connect, 24 otherwise | `plugins/sleight/lib/surface-cache.mjs` |
| Grok Bot shell session | `~/Library/Caches/sleight/shell/session.sock`, a 0600 Unix socket in a user-owned 0700 folder. Calls and results pass through memory. Each reply prints the session UUID. Private `starting/owner` and `session-start.sqlite` files serialize the session through shutdown. Detached startup appends stderr to a 0600 `session.log` in that folder. The peer-check helper is compiled in a private system temporary folder. This route never writes pre-approvals. | Socket, startup owner, helper and images removed on normal exit, SIGTERM or ten idle minutes. Coordinator and stderr log remain until removed by the owner | `plugins/sleight/lib/socket-bridge.mjs` |
| Shell image results | `images-*` folders under `~/Library/Caches/sleight/shell/` (0700), with one 0600 file per returned image. The shell prints each path instead of inline image data. | Capped at fifty per session. Pruned at exit and at the next startup after a crash | `plugins/sleight/lib/socket-bridge.mjs` |

## Optional narration

Narration defaults to off. When enabled, the mod caches assistant prose from its message events without fetching
a transcript or retaining images. The cutter removes code, quoted values, URLs, paths, email addresses, tokens with
API-key prefixes, long base64 or hex runs, and Luhn-valid card numbers. It also omits text-entry narration and checks
for whole user-value words of at least four characters. These filters can remove ordinary identifiers and cannot
recognize every secret. Claude can paraphrase screen text or repeat tool results in its prose, including personal
names and short secrets. Turn narration off for sensitive work.

The built-in host checks secure input before drawing or speaking. Local speech uses installed system voices
without downloads, Personal Voice authorization or opening an input device. Core Audio metadata reads happen
off the main thread, at most once per 500 ms, and unreadable state skips speech. Recordings can silence narration
because running input is a conservative call proxy. The checks and speech synthesis are in
`plugins/sleight/lib/direct-browser/native/consent-host.swift`.

Opt-in cursor streams can include the filtered sentence as `say` after a native secure-input check. A missing host
omits it, and replay or deferred delivery removes it. External renderers must hide parked text when secure input
changes. See [the protocol's narration limits](design/cursor-protocol.md#narration).

## What leaves the Mac

The Grok Bot shell route uses a local Unix socket, with no TCP listener. The bot receives sleight's results through
Grok Bot's local daemon and gateway. Screenshots and app text sent through that route go to Grok's hosted model.

sleight launches the computer-use engine that comes with the ChatGPT desktop app, on your Mac
(`plugins/sleight/bin/sleight-mcp`, `plugins/sleight/lib/launch.mjs`). The engine is OpenAI's
software, and what it sends is handled under [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/).
sleight runs inside Claude Code, and what Claude Code sends is handled under
[Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). This page can't speak for
either.

Screenshots and app text sent through any Grok route go to Grok's hosted model. Grok Bot sends them through its gateway.
Its custom STDIO MCP servers run in Grok's hosted box, off this Mac. The local shell route starts on demand and installs
no LaunchAgent. Its doctor section reads local non-credential metadata, checks whether the recorded daemon PID exists,
and asks the live shell session for sleight's native helper's no-prompt Accessibility trust check
(`plugins/sleight/lib/grokbot-host.mjs`).

The results site doesn't load resources from third parties or use analytics.
GitHub hosts the site and keeps its normal server logs.

## The update watch

The weekly or daily watch job is not part of the installed plugin. The marketplace installs only
`plugins/sleight` (`.claude-plugin/marketplace.json`). If you install the job from a source
checkout (`scripts/watch-install.sh`), a launchd job runs `scripts/watch.sh`. It keeps its log, engine API
snapshots and compatibility results under `~/Library/Logs/sleight/`. Remove it with `npm run watch:remove`.

## Deleting everything

Quit Claude Code so no relay holds memory or session backups, then delete the folders named
above: `~/Library/Application Support/sleight/`, `~/Library/Logs/sleight/`,
`~/Library/Caches/sleight/`, and any routine plists under `~/Library/LaunchAgents/`. Receipts
prune themselves. The rest stays until you delete it.
