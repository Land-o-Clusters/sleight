# Benchmark results

One page per release, generated from the results files in [benchmarks](../benchmarks/). Every number comes from those files. Every run the benchmark made is published, failures included ([LAWS](../status/LAWS.md), Method). Known limits are quoted in [known-problems](../known-problems.md), not copied here. The same page as a chart is [index.html](index.html).

## Latest release pass

1.1.0 (2026-10-09) on claude-sonnet-5-5 at medium: 20 of 21 runs passed, 150 turns, 1,469 s in total. Raw file: [2026-10-09-release-1.1.0.json](../benchmarks/2026-10-09-release-1.1.0.json).

## Head-to-heads

### sleight and Codex (2026-10-10)

| Arm | Model | Passed | Total s | Turns | Model s | Own CPU s |
| --- | --- | --- | --- | --- | --- | --- |
| sleight | claude-haiku-5-5 | 9/9 | 313 | 79 | 189.6 | 78.2 |
| Codex | gpt-6.1-sol | 9/9 | 340 | 83 | n/a | 54.3 |

Own CPU is the run's own process group plus the shared engine helper and the target app. The groups are named by process name: engine is the engine's node and helper, "sleight's processes" is the relay, MCP servers and osascript, client is the host CLI, and other is the target app and anything unclassified.

Own CPU seconds by group:

| Arm | Engine | sleight's processes | Client | Other |
| --- | --- | --- | --- | --- |
| sleight | 33.4 | 9.5 | 21.2 | 14.0 |
| Codex | 26.5 | 1.4 | 11.7 | 14.8 |

Every process the sampler saw, per arm:

| Process | sleight | Codex |
| --- | --- | --- |
| engine helper | 20.9 | 19.6 |
| claude | 18.1 | 0.0 |
| engine node | 12.5 | 6.8 |
| TextEdit | 10.2 | 13.3 |
| mcp@latest | 5.4 | 0.0 |
| Calculator | 3.4 | 1.5 |
| codex | 3.1 | 10.8 |
| node | 2.2 | 1.4 |
| osascript | 2.0 | 0.0 |
| Python | 0.2 | 0.0 |
| python3 | 0.1 | 0.0 |
| (bash) | 0.0 | 0.0 |
| (node) | 0.0 | 0.0 |
| bash | 0.0 | 0.0 |
| (vibe-island-brid) | 0.0 | 0.0 |
| (AgentPeekBridge) | 0.0 | 0.0 |
| uv | 0.0 | 0.0 |
| (git) | 0.0 | 0.0 |
| sh | 0.0 | 0.0 |
| (sh) | 0.0 | 0.0 |
| (grep) | 0.0 | 0.0 |
| &lt;defunct&gt; | 0.0 | 0.0 |
| vibe-island-bridge | 0.0 | 0.0 |
| codex-code-mode-host | 0.0 | 0.9 |

### sleight and LCU (2026-10-03)

| Arm | Model | Passed | Total s | Turns | Model s | Own CPU s |
| --- | --- | --- | --- | --- | --- | --- |
| sleight | default | 12/15 | 545 | 172 | n/a | n/a |
| LCU | n/a | 12/15 | 524 | 142 | n/a | n/a |

Own CPU is the run's own process group plus the shared engine helper and the target app. The groups are named by process name: engine is the engine's node and helper, "sleight's processes" is the relay, MCP servers and osascript, client is the host CLI, and other is the target app and anything unclassified.

## Every run

### 1.1.0 release pass (2026-10-09)

| Task | Run | Arm | Result | s | Turns | Model s | Raw |
| --- | --- | --- | --- | --- | --- | --- | --- |
| calculator-click | 1 | sleight | pass | 94.7 | 10 | 21.0 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| calculator-click | 2 | sleight | pass | 20.0 | 4 | 11.4 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| calculator-click | 3 | sleight | pass | 16.3 | 4 | 8.3 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| calculator-menu | 1 | sleight | pass | 30.3 | 8 | 16.3 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| calculator-menu | 2 | sleight | pass | 15.3 | 5 | 7.2 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| calculator-menu | 3 | sleight | pass | 18.6 | 5 | 10.6 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| chess-drag | 1 | sleight | pass | 303 | n/a | n/a | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| chess-drag | 2 | sleight | pass | 303 | n/a | n/a | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| chess-drag | 3 | sleight | pass | 127 | 23 | 89.1 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| simulator-form | 1 | sleight | pass | 51.3 | 7 | 22.0 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| simulator-form | 2 | sleight | `failed: server received []` | 79.4 | 11 | 39.8 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| simulator-form | 3 | sleight | pass | 48.5 | 7 | 20.9 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-drag | 1 | sleight | pass | 55.3 | 9 | 31.1 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-drag | 2 | sleight | pass | 57.9 | 10 | 37.6 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-drag | 3 | sleight | pass | 34.0 | 8 | 15.9 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-edit | 1 | sleight | pass | 30.7 | 6 | 16.4 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-edit | 2 | sleight | pass | 34.3 | 7 | 16.3 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-edit | 3 | sleight | pass | 26.0 | 5 | 9.4 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-save | 1 | sleight | pass | 42.8 | 7 | 18.1 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-save | 2 | sleight | pass | 44.5 | 7 | 19.2 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |
| textedit-save | 3 | sleight | pass | 37.1 | 7 | 13.3 | [json](../benchmarks/2026-10-09-release-1.1.0.json) |

### sleight and Codex (2026-10-10)

| Task | Run | Arm | Result | s | Turns | Model s | Raw |
| --- | --- | --- | --- | --- | --- | --- | --- |
| calculator-click | 1 | sleight | pass | 24.3 | 5 | 10.4 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| calculator-click | 1 | Codex | pass | 16.1 | 4 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| calculator-click | 2 | sleight | pass | 26.4 | 6 | 13.7 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| calculator-click | 2 | Codex | pass | 14.9 | 4 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| calculator-click | 3 | sleight | pass | 16.8 | 4 | 7.6 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| calculator-click | 3 | Codex | pass | 15.1 | 4 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-edit | 1 | sleight | pass | 21.7 | 7 | 12.9 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-edit | 1 | Codex | pass | 40.6 | 10 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-edit | 2 | sleight | pass | 28.1 | 9 | 19.5 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-edit | 2 | Codex | pass | 29.4 | 9 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-edit | 3 | sleight | pass | 23.9 | 7 | 14.1 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-edit | 3 | Codex | pass | 26.8 | 7 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-save | 1 | sleight | pass | 51.8 | 11 | 32.0 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-save | 1 | Codex | pass | 50.2 | 11 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-save | 2 | sleight | pass | 50.7 | 12 | 31.8 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-save | 2 | Codex | pass | 110 | 24 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-save | 3 | sleight | pass | 69.6 | 18 | 47.7 | [json](../benchmarks/2026-10-10-h2h-5.json) |
| textedit-save | 3 | Codex | pass | 37.1 | 10 | n/a | [json](../benchmarks/2026-10-10-h2h-5.json) |

### sleight and LCU (2026-10-03)

| Task | Run | Arm | Result | s | Turns | Model s | Raw |
| --- | --- | --- | --- | --- | --- | --- | --- |
| calculator-click | 1 | sleight | pass | 16.1 | 6 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-click | 1 | LCU | pass | 20.6 | 4 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-click | 2 | sleight | pass | 11.6 | 6 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-click | 2 | LCU | pass | 11.1 | 4 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-click | 3 | sleight | pass | 14.3 | 6 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-click | 3 | LCU | pass | 15.4 | 4 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-menu | 1 | sleight | pass | 22.8 | 8 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-menu | 1 | LCU | pass | 16.1 | 6 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-menu | 2 | sleight | pass | 17.0 | 8 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-menu | 2 | LCU | pass | 22.9 | 6 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-menu | 3 | sleight | pass | 19.3 | 8 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| calculator-menu | 3 | LCU | pass | 26.2 | 6 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-drag | 1 | sleight | `failed: file holds "alpha beta gamma"` | 53.4 | 15 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-drag | 1 | LCU | `failed: file holds "alpha beta gamma"` | 66.0 | 16 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-drag | 2 | sleight | `failed: file holds "alpha beta gamma"` | 63.6 | 16 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-drag | 2 | LCU | `failed: file holds "alpha beta gamma"` | 44.7 | 11 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-drag | 3 | sleight | `failed: file holds "alpha beta gamma"` | 35.5 | 12 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-drag | 3 | LCU | `failed: file holds "alpha beta gamma"` | 33.6 | 10 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-edit | 1 | sleight | pass | 31.6 | 11 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-edit | 1 | LCU | pass | 32.2 | 9 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-edit | 2 | sleight | pass | 21.2 | 9 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-edit | 2 | LCU | pass | 31.3 | 10 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-edit | 3 | sleight | pass | 18.1 | 9 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-edit | 3 | LCU | pass | 25.0 | 8 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-save | 1 | sleight | pass | 74.7 | 21 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-save | 1 | LCU | pass | 75.5 | 20 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-save | 2 | sleight | pass | 106 | 23 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-save | 2 | LCU | pass | 33.8 | 11 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-save | 3 | sleight | pass | 39.4 | 14 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |
| textedit-save | 3 | LCU | pass | 69.8 | 17 | n/a | [json](../benchmarks/2026-10-03-sleight-vs-lcu.json) |

## Release history

| Version | Date | Passed | Turns | Total s | Model s a turn |
| --- | --- | --- | --- | --- | --- |
| 0.7.0 | 2026-10-05 | 16/18 | 242 | 915 | n/a |
| 0.8.0 | 2026-10-05 | 6/6 | 96 | 353 | n/a |
| 0.11.0 | 2026-10-05 | 12/12 | 170 | 648 | n/a |
| 0.12.0 | 2026-10-05 | 12/12 | 170 | 525 | n/a |
| 0.16.0 | 2026-10-09 | 20/21 | 178 | 1,355 | 2.3 |
| 1.0.0 | 2026-10-09 | 19/21 | 165 | 912 | 2.6 |
| 1.1.0 | 2026-10-09 | 20/21 | 150 | 1,469 | 2.8 |

Run counts differ between versions: the task set grew from 18 runs to 21, and 0.8.0 and 0.11.0 ran partial sets. The chart is in [index.html](index.html).

## Method and caveats

- [2026-10-05-release-0.7.0.json](../benchmarks/2026-10-05-release-0.7.0.json): 2026-10-05, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file, last of 6 passes in the file. write-up [2026-10-05-release-0.7.0.md](../benchmarks/2026-10-05-release-0.7.0.md). Every benchmark run made for the 0.7.0 release on 2026-10-05, in order, failures included. sleight arm only, Sonnet 5.5 at medium effort, Claude Code 2.1.289, engine 26.930.31730, owner away from the Mac.
- [2026-10-05-release-0.8.0.json](../benchmarks/2026-10-05-release-0.8.0.json): 2026-10-05, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file, last of 3 passes in the file. write-up [2026-10-05-release-0.8.0.md](../benchmarks/2026-10-05-release-0.8.0.md). Every benchmark run made for the 0.8.0 release on 2026-10-05, in order, failures included. sleight arm only (folder outside any repo), Sonnet 5.5 at medium effort, Claude Code 2.1.289, engine 26.930.31730, ComputerUseAllowForbiddenTargets on (it only affects terminals and OpenAI's apps).
- [2026-10-05-release-0.11.0.json](../benchmarks/2026-10-05-release-0.11.0.json): 2026-10-05, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file, last of 4 passes in the file. Every benchmark run for 0.11.0 on 2026-10-05, in order, failures included. sleight arm only, folder outside any repo, Sonnet 5.5 medium, owner away.
- [2026-10-05-release-0.12.0.json](../benchmarks/2026-10-05-release-0.12.0.json): 2026-10-05, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file. Benchmark on the 0.12.0 in-call stale-number check, 2026-10-05, owner away. sleight arm only, folder outside any repo, Sonnet 5.5 medium.
- [2026-10-09-release-0.16.0.json](../benchmarks/2026-10-09-release-0.16.0.json): 2026-10-09, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file.
- [2026-10-09-release-1.0.0.json](../benchmarks/2026-10-09-release-1.0.0.json): 2026-10-09, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file.
- [2026-10-09-release-1.1.0.json](../benchmarks/2026-10-09-release-1.1.0.json): 2026-10-09, claude-sonnet-5-5 at medium, arm sleight, owner presence not in the file.
- [2026-10-10-h2h-5.json](../benchmarks/2026-10-10-h2h-5.json): 2026-10-10, claude-haiku-5-5 at high, arm sleight and Codex, auth api, owner presence not in the file.
- [2026-10-03-sleight-vs-lcu.json](../benchmarks/2026-10-03-sleight-vs-lcu.json): 2026-10-03, default, arm sleight and LCU, owner presence not in the file.

The standard results files don't record an engine version or load figures. Passes that measured them state them in a write-up or note. Turns differ between harnesses.

## Run it yourself

```sh
npm run bench -- --runs 3                        # sleight only
npm run bench -- --arm all --runs 3              # sleight and LCU
npm run bench -- --arm sleight,codex --runs 3    # sleight against native Codex computer use

PLUGIN_ARM_RIVAL_DIR=/absolute/path/to/plugin node bench/run.mjs --arm plugin:rival,sleight --tasks calculator-click --runs 1
MCP_ARM_RIVAL_CONFIG=/absolute/path/to/mcp.json node bench/run.mjs --arm mcp:rival,sleight --tasks calculator-click --runs 1
```

A live pass auto-approves the benchmark apps and drives them unattended, and Chess and the simulator need `--owner-away`. Live runs take /tmp/sleight-live.lock and stop while /tmp/sleight-hold exists. See [benchmark.md](../benchmark.md) for the full method.

Rebuild this page after a release pass with:

```sh
node bench/results-page.mjs docs/benchmarks/2026-10-05-release-0.7.0.json docs/benchmarks/2026-10-05-release-0.8.0.json docs/benchmarks/2026-10-05-release-0.11.0.json docs/benchmarks/2026-10-05-release-0.12.0.json docs/benchmarks/2026-10-09-release-0.16.0.json docs/benchmarks/2026-10-09-release-1.0.0.json docs/benchmarks/2026-10-09-release-1.1.0.json docs/benchmarks/2026-10-10-h2h-5.json docs/benchmarks/2026-10-03-sleight-vs-lcu.json
```
