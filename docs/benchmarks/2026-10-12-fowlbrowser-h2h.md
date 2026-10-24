# sleight against FowlBrowser on FowlBrowser's own tasks (2026-10-12)

These results used `8b68924` (baseline). The next race targets `6a12d60` (head).

FowlBrowser (github.com/argofowl/FowlBrowser, MIT) is a Chrome and Helium extension with its own MCP
server. Its author published 26/26 on 13 tasks for Claude with FowlBrowser, against 23/26 for Claude with
Codex's Chrome extension. We ran the same 13 tasks on its own runner and grader, with sleight added as a
third arm. Both arms ran on this Mac on the same day.

FowlBrowser won: 26/26 against sleight's 23/26, in less than half the time, at 60% of the cost.

## Setup

- Runner and grader: FowlBrowser's `tools/rounds.mjs` and `tools/agents/codex-h2h.json` at `8b68924`
  (13 tasks, the takeover task skipped by the runner), with one patch that adds `--surface sleight`
  ([bench/fowl/sleight-surface.patch](../../bench/fowl/sleight-surface.patch)). Each round starts all 13
  agents at once. Each task ran twice per arm, in Chrome and Helium swapped between rounds, arms
  interleaved (FowlBrowser, sleight, FowlBrowser swapped, sleight swapped).
- The agent is Claude Code 2.1.289 (`claude -p`), Opus 5.5 at medium effort, as in FowlBrowser's published
  runs, on the API key. Cost is Claude Code's own usage report.
- FowlBrowser: installed with `install.sh --lite` from the pinned commit. sleight: the repo at
  `d6c2b3d`, through the Codex extension 1.26.901.11451 and engine 26.1007.30912.
- sleight's arm differs from the Codex arm in FowlBrowser's runner in two ways. It runs with browser and
  computer surfaces, sleight's default when the extension is connected, because a browser-only sleight
  fails every call (see below). An Elicitation hook ([bench/fowl/origin-hook.mjs](../../bench/fowl/origin-hook.mjs))
  accepts the engine's site prompt for 127.0.0.1, en.wikipedia.org and developer.mozilla.org for the
  session, and declines everything else. FowlBrowser has no site prompt. Its runner gives the Codex arm
  each browser's extension id, and the sleight arm got them the same way.
- The Mac is an Apple M5, macOS 27.0.1, Chrome 154.0.8037.98, Helium 0.19.2.1, the owner's real profiles.
  The owner was working on the Mac during the runs.
- Command: `bench/fowl/h2h.sh`. Raw reports: [fowlbrowser-normal](2026-10-12-fowlbrowser-h2h/fowlbrowser-normal.md),
  [fowlbrowser-swap](2026-10-12-fowlbrowser-h2h/fowlbrowser-swap.md),
  [sleight-normal](2026-10-12-fowlbrowser-h2h/sleight-normal.md),
  [sleight-swap](2026-10-12-fowlbrowser-h2h/sleight-swap.md).

## Results

| | FowlBrowser | sleight |
| --- | --- | --- |
| Tasks done right | 26/26 | 23/26 |
| Time, all 26 runs summed | 972 s | 2,109 s |
| Cost, all 26 runs | $7.98 | $13.33 |
| Tool calls | 240 | 501 |
| Tool errors | 4 | 139 |
| Focus changes and flashes the runner counted | 0 | 19 |

Per task, with the median of the two runs:

| Task | FowlBrowser | sleight |
| --- | --- | --- |
| `form-travel` | 2/2, 94 s, 28.5 calls | 2/2, 155 s, 62.5 calls |
| `form-settings` | 2/2, 50 s, 13 calls | 2/2, 182 s, 43.5 calls |
| `form-checkout` | 2/2, 68 s, 17 calls | 0/2, 93 s, 15 calls |
| `form-settings-helium` | 2/2, 49 s, 14 calls | 1/2, 168 s, 37 calls |
| `shipping-link` | 2/2, 20 s, 4 calls | 2/2, 33 s, 7 calls |
| `size-guide` | 2/2, 25 s, 5 calls | 2/2, 33 s, 8 calls |
| `demoid` | 2/2, 29 s, 6.5 calls | 2/2, 36 s, 7 calls |
| `mobile` | 2/2, 25 s, 6.5 calls | 2/2, 135 s, 24 calls |
| `handoff` | 2/2, 31 s, 7 calls | 2/2, 77 s, 15 calls |
| `inject-order` | 2/2, 30 s, 6 calls | 2/2, 57 s, 11 calls |
| `inject-mail` | 2/2, 35 s, 6.5 calls | 2/2, 54 s, 17 calls |
| `wikipedia` | 2/2, 14 s, 3 calls | 2/2, 17 s, 1 call |
| `mdn` | 2/2, 19 s, 3 calls | 2/2, 18 s, 2.5 calls |

sleight's 23/26 matches what FowlBrowser's author measured for Claude with Codex's extension (23/26,
$12.78), which is the extension sleight drives too.

## Why sleight lost

- Both checkout runs stopped before paying. The engine's own instructions tell Claude to confirm any
  financial transaction at the moment it happens. A headless run has nobody to answer ("the order is
  waiting on your OK for the $268.00 payment prompt"). FowlBrowser doesn't give that instruction.
- 52 of 80 errors in the first round were sleight's input lease refusing a call that only used a tab
  ("a bundle ID and full window header are required"). The lease treats a call as browser-only only when
  it matches a narrow pattern, so a `console.log`, a `.slice` or a loop sent it down the native path. The
  lease is also held per app, so the 13 agents in one browser waited on each other.
- Claude reached for `cua.getApp` on a web page 8 times, wrote a top-level `return` 4 times, and called
  tab input without an element index 5 times.
- Claude spent 2 to 4 calls in most runs telling Chrome from Helium, which both report as "Chrome".
- No sleight run closed its tabs. FowlBrowser closes its agent tabs at turn end.
- A browser-only sleight (`SLEIGHT_SURFACES=browser`) fails every call: three modules call
  `cua.getApp.bind`, and the browser-only `cua` has no `getApp`.

Each of these is a build item in the lane ledger (F1 to F8). The rerun after they merge gets published
next to this one.

## Speed per call

Without a model, each tool through an MCP client on a local page in Helium, 10 runs, median
(FowlBrowser's `mcp/test/bench.mjs`, and `bench/fowl/ext-speed.mjs` for the extension, raw through
ChatGPT's `cua_repl` and through sleight):

| Call | FowlBrowser | Extension, raw | Extension through sleight |
| --- | --- | --- | --- |
| Read the page | 8 ms | 44 ms | 46 ms |
| Click, no read | 131 ms | 46 ms | 48 ms |
| Click, then read | 342 ms | 265 ms | 248 ms |
| Type, no read | 137 ms | 50 ms | 55 ms |
| Run JavaScript in the page | 57 ms | 14 ms | refused by sleight's lease |

The extension isn't what made sleight slower. sleight made 501 calls to FowlBrowser's 240, and 139 of
them failed, so most of the gap is model time between calls.

## What we don't know

- How Claude does on the bare extension with these tasks. FowlBrowser's runner has a Codex arm through a
  proxy that isn't in its repo, so we didn't run it here.
- Whether the gap holds on a quiet Mac. The owner was working during the runs, the same for both arms.
