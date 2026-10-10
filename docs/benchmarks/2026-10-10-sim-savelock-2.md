# Simulator and turn cleanup review, 2026-10-10

Follow-up to sleight-arch's review of `6e5e04d`, on `codex/sim-savelock`.
The branch is rebased onto private `pane/auto-mode` at `fa079f0`, which includes `e42b974`.
The package retains both branches' prose paths and uses four test workers.

## Corrections

- Rejected turn cleanup has three total attempts, including the initial request. A third rejection
  writes one warning, records abandonment and drops that turn. Later turns get their own budget.
- The Simulator note requires `SLEIGHT_SIM_FOCUS_NOTE=1`. It is off by default. Its affected
  `simulator-form` task still needs to run with the note before it can become the default.
- The read-only cleanup receipt `1791613184878` violated the hold and left the owned TextEdit
  process running. It remains published as failed evidence. Both native helpers now stop under a
  hold before reads or actions. The cleanup runner checks before lock access, including inspection.
  The focus probe also guards each permission-observer command and its retained fixture's AX reads.
- A closed fixture is no longer complete cleanup while its owned process remains. Cleanup verifies
  the recorded PID, bundle and launch time and quits only an empty owned launch. It preserves restored
  windows and refuses foreground changes. A failed unedited attach also attempts this cleanup after
  collecting its helper. An absent lock can be reacquired. A different retained lock is refused.
- Simulator result JSON scrubs the device UDID and name, home path and owner name from every string,
  including nested ownership, rows and errors. Real device identifiers remain in memory for cleanup.

## Verification

The final focused run passed 110 tests, exit 0, including existing fixture and permission coverage.
New tests first failed against the prior behavior:
unbounded retries, default-on notes, one test worker and missing native hold checks. New serializer
and cleanup-runner tests first failed because those modules did not exist. One runner test had an
invalid time range. Correcting its fixture produced the expected lock-identity check. No app ran.
The [attempt receipt](2026-10-10-sim-savelock-2-validation.json) preserves these results.
Review found two further gaps: the probe's nested observers did not check a new hold, and its direct
relay did not receive the note flag. The observer test file failed 5/5 before those fixes. The probe now passes
the flag explicitly and checks the hold in its observer commands and retained native helper.

At 08:24Z the shared hold covered Puddle's upcoming R16 measurements. The corrected inspect-only CLI
stopped before lock or Accessibility work. Its first receipt write was denied by the sandbox, exit 1.
The host retry published the [hold refusal](2026-10-10-save-lock-cleanup-1791620699444.json), exit 1,
with `holdPresent: true` and `lockRetained: false`. The old owned TextEdit PID `86808` has not been
inspected or quit during this hold. Bare `npm run lint:prose` passed across 77 files, exit 0.
Bare `npm run check` waited at its hold gate without starting tests. It was interrupted once through
its retained terminal and returned exit 1. A full passing check, owned-launch cleanup and publication
remain pending until the shared hold is lifted. No commit, push or merge has been made for this follow-up.

## Handoff to sleight-arch

Run from this branch after the hold is lifted. First finish the recorded owned-launch cleanup:

```sh
node bench/textedit-save-lock-cleanup.mjs docs/benchmarks/2026-10-10-save-lock-1791610854988.json
```

This doesn't send test input and checks exact launch ownership. If it reports restored windows or a
dialog, preserve them and inspect the remaining cleanup before releasing its lock.

With the owner away, run each focus probe separately:

```sh
SLEIGHT_SIM_FOCUS_NOTE=1 node bench/simulator-focus-live.mjs --owner-away --observation screenshot
SLEIGHT_SIM_FOCUS_NOTE=1 node bench/simulator-focus-live.mjs --owner-away --observation combined
```

Each probe waits up to 120 seconds for `tap.json` beside its fresh image and `point-request.json`.
Supply the requested image hash and a measured point inside the Message field. The probe sends at
most two identical taps and no text. Inspect cleanup status and publish its scrubbed JSON, including
failures. Check screenshots for personal data before publishing them.

Run the affected model task with the note enabled, then the TextEdit event comparison:

```sh
SLEIGHT_SIM_FOCUS_NOTE=1 node bench/run.mjs --arm sleight --tasks simulator-form --runs 3 --owner-away
node bench/textedit-save-lock.mjs
```

These remain unrun here. The TextEdit comparison uses a new temporary file for each event variant;
it cannot establish causality if attachment, save or cleanup stops. The existing Shift workaround
remains in place. The full check must wait for the shared hold, and neither probe may run during it.
