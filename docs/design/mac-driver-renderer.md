# Renderer accessibility reads

`DriverRenderer.swift` retries a thin accessibility tree under an approved window lease. A complete read with 1 to 20
window nodes and no editable field gets one untouched re-walk before any attribute probe. Menu-bar nodes do not count.
A truncated read or an explicit depth limit below 64 skips activation.

If that walk remains thin, `AXManualAccessibility` is tried first. The helper writes true only when the attribute is
settable and its original Boolean value is false. It reads the write back, waits 2 s after a confirmed transition, and
walks again. `AXEnhancedUserInterface` is tried only if the latest tree is still thin and contains `AXWebArea` or
`AXHTMLContent`. A Manual attempt that fills the tree stops the sequence before Enhanced is probed. App names play no part.
Already-enabled, unknown and unsupported attributes are preserved. A failed read or settable probe before any write returns
the untouched retry and adds `activation-probe-failed` to `rendererNotes`.

Each 2 s wait checks the request deadline, parent PID and window/process binding in slices of at most 25 ms. Each activation needs at least 4.75 s remaining:
0.5 s for write/readback, 2 s for the wait, 1 s for the walk and 1.25 s for cleanup. A short budget skips the write and adds
`activation-budget-skipped`. Each activation walk uses an earlier request deadline that reserves 1.25 s for cleanup.
The initial read and plain retry use at most 2 walks. Each attribute can add 1 walk and a 2 s wait, for a total
of at most 4 walks and two 2 s waits.

## Durable records

The helper constructs `DriverRendererRestoreStore(stateDirectory:)` with its private runtime state directory.
Path components are opened relative to the previous directory descriptor, with `O_NOFOLLOW` and `O_DIRECTORY`.
Symlinks in ancestors, the state directory and `renderer-restore/` are refused. Paths must be absolute and resolved,
without `.` or `..` components. The state and restore directories must belong to the current user and have mode 0700.
Only the exact runtime state path returned by `runtimeStateDirectory()` receives a 0755-to-0700 repair through its open
descriptor. Other state paths and the restore subdirectory must already have mode 0700. Other modes are refused with
`INVALID_PARAMS` and a directory error. Ancestor permissions are left unchanged. All descriptors use `O_CLOEXEC`.

The store creates `renderer-restore/` and acquires its mode-0600 `.lock` file. It tries for at most 100 ms, in 10 ms slices.
If another session holds the lock, construction succeeds in read-only mode. That instance skips record mutations and
cannot activate attributes. A plain read still proceeds with `activation-recovery-unavailable`.
A new store can acquire the lock after the other session releases it. If startup cannot open a safe store, activation
also stays disabled. These instances cannot arm writes. Their `rendererRestore` returns `restored: true`,
`retained: 0` and `recovery: {available: false}`. The runtime can release that session's lease and continue later turns.

Before each activation write, the store publishes a mode-0600 JSON record keyed by PID, process start and attribute name.
Its fields are `pid`, `processStart`, `bundleId`, `attribute` and `original`, with an optional `recoveryReason`.
The older `bundleID` spelling is accepted when loading. Only the two activation attributes and an original value of
false are accepted. Bundle IDs accept letters, digits, periods, hyphens, `_` and `+`, up to 255 characters.
Activation eligibility validates the process identity before `armRestore`. An invalid identity returns the plain
retry with `activation-recovery-unavailable` and leaves parent recovery unarmed.
The store calls `fsync` on the temporary file, renames it into place, then syncs the directory before allowing the
attribute write. Confirmed cleanup removes the record and syncs the directory. Records survive helper termination.
This does not promise drive-cache persistence across power loss, when the target app also exits.

## Inventory and pruning

Recovery only inventories, prunes and reports. It has no AX providers, reads or writes, including at startup, during
leased reads, at lease end and through `helper --restore-renderer`. A same-user record cannot establish who owns the
current attribute value. Reacquiring a lease never authorizes restoration from a saved record.

Recovery validates each record separately. Malformed JSON, duplicate or unknown fields, unknown attributes, oversized
files (over 1,024 bytes), filename mismatches, public modes, hard links, symlinks and directories are renamed to
`.quarantine-<uuid>` in the same directory. The bad entry remains there for diagnosis. Recovery continues to the next
entry. Transient file-open errors, including `EMFILE`, `ENFILE`, `EINTR` and `EAGAIN`, retain the record for a later scan.
Interrupted metadata and file reads also retain it. A missing entry is skipped. An I/O failure or incomplete scan
prevents activation until a later scan succeeds.

Recovery prunes records for exited processes and reused PIDs with a different kernel start time. The old attribute
belonged to the exited process. Records for matching running processes stay saved, with `recovery-disabled` when an earlier
reason is absent. Unknown process status retains the record and reports a failed scan. Pending records block activation for that process,
including a conflicting bundle at the same PID and start. Plain reads remain available.
The lease-end scan selects only the two filenames for its PID and start before opening any record file. Other entries
remain for a full startup or read scan. All scan mutations share at most one directory `fsync`, including removals,
quarantine and diagnostic updates. Each rewritten record still receives its own file sync; an unchanged reason causes
no rewrite. The directory sync also runs after partial pruning on timeout or cancellation. A sync failure marks the scan
incomplete and disables activation.

`recover(leasedProcess:onlyProcess:deadline:check:)` has a 750 ms total budget, shortened by its caller's deadline.
Cancellation and deadlines are checked throughout enumeration and process inspection. Cancellation propagates to the
caller with remaining records retained. Filesystem calls are synchronous. This budget cannot interrupt a blocked syscall.

`helper --restore-renderer <state-directory>` accepts only
`<account-home>/Library/Application Support/sleight/runtime`, derived from `getpwuid(getuid())`. `HOME` and environment
settings cannot redirect it. The exact path must pass the same component, ownership and mode checks. JSON reports
`restored` (always 0 for inventory), `retained`, `skipped` (vanished entries), `quarantined`, `pruned`, `failed`, `complete`
and the remaining record identities and reasons. Exit 1 reports failure or an incomplete scan, including lock contention.
Exit 0 means enumeration finished without failure. Retained records can remain. Unsafe paths return exit 1 with
`INVALID_PARAMS`. There is no termination supervisor. The doctor reads record files and explains that a running app may
still carry the enabled attribute, automatic recovery leaves it unchanged, and quitting that app clears it.
An exited app does not need attribute cleanup. Its stale record disappears at a later successful scan.

## Cleanup during a read

A `DriverRendererLease` with only callbacks cannot activate. Its concrete `restoreStore` is required; otherwise the plain
retry returns with `activation-recovery-unavailable`. The Swift store owns persistence. The internal `armRestore` callback
repeats the request and binding checks in production. `confirmRestored` is a no-op there. Adapters can supply their own
bounded callbacks. Failure in the arm callback prevents writing.

Cleanup may write false only for an enable issued by this process during the same read. An already-true attribute is
never owned by that read. Before undo, the helper checks the request deadline, parent PID, exact window binding and
process identity. It reads the current attribute and requires it to equal the true value sleight wrote. A known running
assistive source vetoes cleanup. The helper reads VoiceOver, Switch Control and known tool processes, while
display preferences such as Reduce Motion, which leave these attributes alone, are left out (2026-11-01). An
unknown or throwing source does not veto this read's own cleanup, and the live provider reports Voice Control and
Accessibility Full Keyboard Access as unknown. A recognized running tool process still vetoes cleanup.

The helper checks the request and process identity again after reading the value and sampling assistive state. It does
not receive a parent-side revoke or lease TTL expiry during an in-flight read. The parent renews the lease immediately
before sending the read, but that does not prove it remains unexpired until every AX call. The helper's checks are bounded
by the request budget (at most 30 s). A parent lease ending queues inventory behind the read; after 2 s without confirmation,
the parent retires and collects the helper before releasing the lease. Inventory never writes AX.

If the current value is false, cleanup removes the record without an AX write. This includes a rejected or ignored enable
that left the original value unchanged. A failed enable that landed true still takes the guarded cleanup path. An armed
record whose enable was never issued is removed without touching the attribute. A late asynchronous enable after a failed
write and false readback remains unmeasured. The false readback is the evidence used to discard that record.

An unknown or non-Boolean value, assistive veto or failed binding check leaves the record and attribute untouched. A
completed read reports `activation-cleanup-retained:<reason>` in `rendererNotes`, and the runtime adds the reason and a
one-line notice to the result text. A failed read preserves its original error, with the reason saved in the record for
inventory and doctor. Retention permits lease release. An AX write/readback failure or failed confirmation faults the
helper as unhealthy. Cleanup attempts the other attribute if one fails and confirms only successful restorations, after
all cleanup writes. A retained record disables later activation for that process.

The value check and write are separate AX calls. Another writer can race between them, and a same-valued external write
is indistinguishable from sleight's own enable. Unknown assistive state is accepted only for this read's own write;
saved records never authorize cleanup. Each attempted attribute adds a 2 s debounce after confirmed activation, plus the
walk and AX calls.

## Remaining live checks

Offline tests use fake AX storage, synthetic trees and temporary state directories. The production service, driver client,
runtime selection and safety lease endings run against those fakes, including 2 runtimes sharing a lock. Tests never read
real accessibility settings. The only live assistive-provider branches tested return unknown without consulting settings.

sleight-arch runs the live gate: 5 cold Discord trials with at least 500 nodes on the first tool read, Slack's message
field, VS Code's editor field, background behavior and retained-attribute behavior. Measure whether the immediate plain
re-walk needs a delay and whether cold Chromium exposes a web-area role before activation. Real filesystem timing and
concurrent application-wide attribute behavior remain unmeasured. This lane ran 0 live trials.
