# Guard and app-probe CPU (2026-10-10)

The changes keep executable guard setup in the engine and filter app/window lists before bridging
them into JavaScript. They retain full AX reads, numbered-action checks, app probes on each read,
input leases, and the existing window, URL and saved-file rules. CPU parity with Codex still needs
sleight-arch's head-to-head. ROADMAP 3.5 remains unfulfilled.

The reference task pass used 45.8 CPU s of sleight's own CPU against Codex's 38.7, with two runs per
arm on Calculator click, TextEdit save and TextEdit edit. Component measurements below cannot be
subtracted from that task total because the workloads and probe frequencies differ.

Baseline: `332e3ca0260d7eee0b003882d95d8b64ec431dd3`. The initial profile used engine 26.1002.52244.
By the final measurements the installed engine was 26.1007.21159. Both arms of the final source
comparison ran in the same session of that newer engine. Each probe acquired the shared live lock
before observing existing Calculator and TextEdit processes in the background. Model turns and model time
were zero. They refused work while `/tmp/sleight-hold` existed. Engine and helper files were unchanged.

## CPU comparison

The final source comparison alternated three blocks of 30 calls per arm, for 90 calls each. These
calls execute the guard setup with no app input or AX read. The one-minute load stayed at 12.46.
The table sums all three blocks, including the colder first baseline block:

| Process, 90 guarded no-op calls | Baseline CPU s | Final CPU s |
|---|---:|---:|
| Engine node | 0.75 | 0.05 |
| Codex sandbox wrapper | 0.17 | 0.00 |
| Probe driver, including source generation | 0.036 | 0.015 |
| Shared engine helper | 0.06 | 0.02 |
| TextEdit | 0.03 | 0.01 |
| Calculator | 0.00 | 0.00 |

The engine's median per 30-call block fell from 0.18 to 0.02 CPU s. Source size fell from 23,088 to
1,301 bytes. The separate one-time installation used 0.03 engine CPU s and took 17 ms. Process-tree
sampling resolves 0.01 CPU s. A displayed zero means no increment at that resolution. Only the
first baseline block registered wrapper CPU. This does not establish a general wrapper saving.
Shared-process rows may include background clients and are not attributed to these no-op calls.

The final app-health comparison alternated three 100-query blocks per arm and app, with the exact
Unicode post-filter installed. Each block includes helper startup and one initial probe. The
one-minute load ranged from 12.56 to 13.39:

| Process and workload | Baseline median CPU s (range) | Final median CPU s (range) |
|---|---:|---:|
| osascript, 100 Calculator probes | 4.83 (4.74 to 5.04) | 0.57 (0.56 to 0.58) |
| osascript, 100 TextEdit probes | 4.72 (4.38 to 5.14) | 0.54 (0.44 to 0.56) |

All 12 blocks exited 0 with unchanged window counts. Calculator had no on-screen document window,
and TextEdit had one. The raw data records false full-screen observations apart from one unknown result.

The initial helper profile compared the baseline with an intermediate native-filter draft. Each
repeated-query row includes helper startup, one initial probe and 100 repeated queries:

| Process and workload | Baseline CPU s | Intermediate draft CPU s |
|---|---:|---:|
| osascript, Calculator probe | 5.99 | 0.66 |
| osascript, TextEdit probe | 6.16 | 0.66 |
| osascript, Calculator Space checks | 2.27 | 0.32 |
| osascript, TextEdit Space checks | 2.28 | 0.34 |
| osascript, startup and one Calculator probe | 0.21 | 0.13 |
| osascript, startup and one TextEdit probe | 0.18 | 0.13 |

This draft predates the exact Unicode post-filter. These two profiles also ran under different desktop
conditions. The first saw a full-screen Space and
neither app on screen. The second saw a TextEdit window on screen. They motivated the alternating
comparison and do not establish a task-level reduction. The raw files retain each load average,
app status, query count and exit code.

## AX reads and guard source

The first completed profile measured 30 full and 30 diffed reads of each app. The median CPU seconds
per ten reads were 0.05 / 0.05 for Calculator and 0.03 / 0.03 for TextEdit in the engine's node
process. Full trees were 4,493 and 3,732 characters. Diffed replies were much shorter, but often had
no Window header. Cold Calculator blocks took 69.7 and 34.9 s. Later blocks took 2.2 to 3.2 s. The
first one-minute load average was 214.84. These are settled reads without input between them, not
the settling cost after each numbered action. They do not establish a scaling curve for larger trees.

The 26.1002.52244 engine API offers `emit` and `disableDiffing` for state reads, with no depth limit or
header-only native read. Reconstructing a full tree from diffs would need a reliable baseline: another
handle's read can advance the engine's diff state. With no measured CPU saving here, full reads stay.
The guard keeps the owner's existing narrow reuse rule for the immediately preceding slow read.
It doesn't add a cross-call observation cache or lengthen the reuse window.

A no-op sent with the full guard still costs engine CPU. Warm ten-call blocks used 0.08 to 0.13 s
for roughly 22 to 23 KiB of guard source, against 0.00 s at the sampler's 0.01 s resolution for plain
no-ops. The relay now installs the setup function once, waits for its successful execution marker,
then sends only the call's parameters and body. Every invocation resets observations as before.
The marker is hidden from the client. Reset, engine restart and failed calls discard readiness;
a missing runtime function stops before caller code and never replays input automatically.

The wrapper's completed profile total was 0.55 CPU s. The engine's node process used 1.86 s. The
shared helper used 10.65 s, Calculator 3.93 s and TextEdit 1.25 s. Shared-process totals may include
other clients. The wrapper remains unchanged as part of the engine's launch boundary.

The final relay run on 26.1007.21159 passed three explicit full reads and three guarded no-input
calls per app, followed by reset and reacquisition. It recorded 10 app probes and two setup
installations across 16 engine calls. Warm full-read calls carried 328 bytes; guarded calls carried
1,733 or 1,743 bytes. All six after-call guard reads succeeded, producing 4,489-character Calculator
and 4,276-character TextEdit trees in 68 to 100 ms. The one-minute load ranged from 12.46 to 12.85.
This validates setup reuse and reset through the real relay without changing either app's content.

## Native filtering and preserved checks

Each app probe still obtains the current running-app list, both CG window lists, the front window's
full-screen state, AXWindows and minimized-window flags, with the same native messaging deadline.
Foundation filters document windows by PID, layer, alpha and size, avoiding conversion of every
window dictionary and its title. App candidates are filtered natively, then compared using the
original JavaScript lowercase rule. Foundation alone equates `Straße` and `STRASSE`; a regression
test caught that difference before the final comparison was added. Duplicate exact matches still
return unknown. There is no PID, window-count or probe-result cache.

Review also found that handle reads lost their app selector, so only acquisitions dispatched a
Space probe despite the per-read rule. The relay now retains that selector through consecutive
handle reads. A regression test failed with one probe instead of three before the fix. This restores
the required check and adds work compared with the faulty baseline; the component CPU comparison
does not count that change in task frequency.

Guard tests exercise a changed window on the next call, renumbering after the first numbered action,
fresh full reads, missing setup, reset and late replies. App tests cover denied permission,
ambiguous selectors, native timeouts, off-Space windows, minimized windows, and native Unicode and
quoted selectors. The guards remain cooperative JavaScript in the caller's realm.

## Attempts and validation

The required bare checks both exited 0: `npm run check` and `npm run lint:prose`.

- The first sandbox check encountered socket and fixture-write denials and was interrupted through
  its retained terminal. It exited 1 and is not a passing baseline.
- The first sandbox profile could not write its report in the requested worktree. Its unchanged
  host-access retry reached the engine, which refused `node:process`. That failure is in the raw
  profile. CPU measurement moved outside the engine to the owned process tree.
- The initial profile and both helper profiles completed and released their locks. They record
  changing Space visibility and include all trials, including the cold slow reads.
- Existing source-pattern assertions expected assignments in the old generated code (five failures).
  The replacements check the same serialized values. The focused rerun passed 6/6. A subsequent native
  Unicode test failed on `Straße`. Exact comparison restored parity and the native/helper tests
  passed 5/5.
- The source comparison queued at 05:49 UTC was cancelled before acquiring another run's live lock,
  with exit 1 and no trial. Its abort report is retained.
- The second source comparison queued at 06:12 UTC also exited 1 before taking the lock, after the
  simulation lane reported retaining it for unconfirmed TextEdit cleanup. The owner authorized a
  cleanup request to that lane. It confirmed zero AX windows in its recorded TextEdit launch and
  released the lock. This branch didn't remove that lock or touch its windows.
- A third source comparison queued at 07:18 UTC was interrupted before acquiring the lock, with
  exit 1 and no trials. That freed this lane to run its full check during an available test slot.
- A fourth wait started at 07:45 UTC and exited 1 without trials. Primary benchmarks were releasing
  and reacquiring the lock between runs. Reducing this probe's wait interval from 15 s to 1 s let
  the final comparisons acquire the same exclusive lock. The script passed its syntax check.
- An unsupported process-inspector operation returned `CODEX_MACOS_INSPECT_APPROVAL_REQUIRED`.
  No raw inspection fallback ran.
- The first host-access `npm run check` exited 1 after 726 s: 1,133/1,147 tests passed. Ten native
  fixture failures and four short process/helper deadlines failed at a final one-minute
  load of 300.35. The failure summary is in `2026-10-10-footprint-parity-check-1.json`. Other chats
  reported the same compile timeouts. The owner authorized serial check coordination before a rerun.
- The first prose check exited 2 because this worktree lacked the pinned Vale styles. Copying the
  existing styles from the primary checkout required host access after a sandbox write denial.
- The next prose check exited 1 with 11 flags in this report. After those revisions, another check
  found one wording flag and exited 1. After the revision, the bare prose check passed with exit 0
  and no findings across 70 files.
- Adding the final measurements triggered 13 further prose flags. After revisions, one concurrency
  wording flag remained and was corrected before the final bare prose check.
- The next bare full check waited before tests in `wait-hold.sh`. The shared hold was set at
  06:15:30 UTC for Puddle's Spend gate and host load. The check was interrupted through its retained
  terminal and exited 1 without starting tests. The marker remains intact even though a later
  one-minute load reading fell to 19.13. The owner later confirmed that the timed window had ended,
  and both shared markers were absent at 07:03 UTC.
- The next serialized full check exited 1 after 134.8 s, with 1,147/1,148 tests passing and no native
  compile failures. The fixture's SQLite coordinator became unreachable, and garbage collection
  released its lock before the child exited. Retaining the coordinator fixed the focused test (2/2, exit 0), without
  changing production clipboard code or its assertions.
- The clean bare `npm run check` passed with exit 0: 1,148 Node tests, both plugin validations and
  11 mod tests. Node tests took 160.5 s. The one-minute load after completion was 41.05.
- The final helper pairs, relay reads and source pairs each exited 0, running sequentially from
  07:56:49 to 07:57:39 UTC. Production source hashes were unchanged. Each run collected its owned
  engines and helpers before releasing its lock. The report retains all four interrupted lock waits.

Raw runs are the `2026-10-10-footprint-parity-*.json` files beside this report. Reproduce with
`node bench/footprint-parity.mjs profile`, `helpers-pairs`, `source-pairs` or `relay-reads`.
The script snapshots baseline source through Git and records candidate source hashes. It collects
its owned engine and helpers before deleting the temporary source bank and releasing the live lock.
