# Battery report template

Fill this template after sleight-arch collects the battery results.

## Inputs and method

Record the source commits, engine version, model and effort for each arm, owner presence, load,
arm setup and every attempted run. Generate separate reports for each setup and load. Include failures.
Use bundle IDs for the app split, never display names or window titles.

Generate the report offline after sleight-arch collects the battery. The reporter launches no
processes and evaluates no transcript code. It reads Codex sessions under `~/.codex-bench/sessions`
and sleight transcripts under `~/Library/Caches/sleight-bench/claude-config/projects/`.
Those directories are inputs only. Outputs must be new files.

```sh
node bench/battery-report.mjs --results bench/results/battery.json \
  --catalog bench/results/battery-plan.json \
  --turn-study bench/results/turn-study.json \
  --json bench/results/battery-report.json \
  --table docs/benchmarks/battery-report.md
```

Repeat `--results FILE` to include more passes. `--catalog` accepts the saved harness dry plan's
`runs`, or a JSON array of `{ "task": "fixture-read", "bundle": "org.example.Lark" }`.
Supply it when result rows omit the bundle ID. A task must map to exactly one bundle ID.
Top-level `armSetup` becomes each row's `setup`. Supply `stamp` to distinguish passes.

Rows accept `arm`, `task`, `run`, `bundle` (or `bundleId`), `passed` (or `pass`), `seconds`,
`turns`, `modelMs`, `footprint.split`, `calls` and `windows.samples`. The CPU total sums sleight,
engine, client and other process CPU in the footprint split. Target app CPU is excluded.
Sampled focus changes and target-over-owner states count transitions into each state, rather than
every sample in that state. Missing samples are unknown. Short events between samples can be missed.
Model time stays unknown when the driver does not expose it. Host scheduling gaps are separate.

Optional `session`, `sessionId` or `threadId` links a row to an exact transcript. Without that link,
sleight matching uses turn-study's run coordinates. Codex matching requires its session metadata.
Unmatched and ambiguous transcripts cannot establish a call comparison. Turn-study input uses its
`runs` array. Harness call metrics supply comparisons when transcripts are unavailable or their
call counts disagree with the harness. Count mismatches appear in coverage. A `wasteCalls` array
supplies rule evidence only, because it can omit other driver calls.

## Pass parity

Use the generated table for each app and overall. Each metric includes its measured run count.
Report pass rate, median total seconds, turns, model seconds, model seconds per turn and own CPU
seconds, plus observed focus steals and windows over the owner's. State every app where sleight's
pass rate is below Codex's, with both pass and run counts. An absent arm leaves parity incomplete.
An overall lead does not establish parity in every app.

## Calls on the same task

Use the ranked paired table. Pair the same bundle ID, task, run, stamp, setup and load context.
Record both driver models. A cross-driver pair can use different models.
Show both call counts, timed-call counts and attributed seconds. Attribute calls to tool-description,
skill, relay-note or guard mechanisms with repository file links. Mechanism associations are
hypotheses until an A/B measures their effect. Keep unclassified differences visible.

## Rules from learn apps

The fixed split hashes the bundle ID with SHA-256. An even first byte assigns learn, an odd first
byte assigns test. This produces approximately half in each group and keeps assignments unchanged
when apps are added. Record both groups before testing rules.

Candidates use learn apps only. A tree empty after launch, an oversized result, changed foreground
after launch and a list that did not scroll are mechanisms. Candidate names never include an app.
Do not turn an observed call pattern into a claim that a rule improves an untested app.

## Later flag A/B on test apps

Add `startedAt`, `experiment`, `flags`, `setup`, `load` and `model` to every A/B row. Discovery rows
need `startedAt` and total seconds too. The later A/B must begin after every discovery run finishes.
Keep every condition except the selected flag equal within a pair. Use two separate arm names in
the same experiment, with the same run coordinates. Pass the following specification as `--ab FILE`:

```json
{
  "rule": "spilled-result",
  "flag": "SLEIGHT_RESULT_TRIM",
  "controlArm": "off",
  "treatmentArm": "on",
  "controlValue": "0",
  "treatmentValue": "1",
  "experiment": "trim-ab"
}
```

Use a later sitting than discovery. The report compares both flag arms on the test apps, with run
counts, pass rates and time. It marks a candidate proven in the sample only when median total time
improves on both learn and test halves and no app loses pass rate. Missing pairs, missing times,
earlier runs or another changed flag leave it unproven. This is a sample comparison without a
statistical significance test. Publish all A/B attempts and all failures.

## Review before publication

Verify the results include every attempted run, that metric counts agree with the harness and that
transcript matches are unique. Check the generated JSON and Markdown for personal data. The
reporter omits transcript text, code, answers, titles and source paths. Keep home paths as `~` in
any accompanying evidence. Record remaining limits in [known problems](../known-problems.md).

sleight-arch compares sampled window order with its live observer and verifies unique transcript
links. Task verdicts and CPU accounting must agree with the report. After the flag A/B, sleight-arch
publishes the live evidence needed to assess parity and a rule's effect.
