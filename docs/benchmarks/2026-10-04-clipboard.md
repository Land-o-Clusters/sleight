# Clipboard probe, 2026-10-04

TextEdit, engine 26.930.31730. A temporary document and synthetic clipboard fixtures, under the
shared live-check lock. Approval used only `bench/approve.mjs`. No full benchmark ran. Clipboard
payloads stayed in a private temporary bank. Published traces contain fixture text and pasteboard
types, byte lengths, hashes and generation counts. Home paths are `~`.

| Attempt | Exit | Result |
|---|---:|---|
| [1](2026-10-04-clipboard-attempt-1.json) | 1 | Sandbox could not resolve TextEdit. No app action ran. |
| [2](2026-10-04-clipboard-attempt-2.json) | 0 | Probe omitted the launcher's input lease. All 16 actions failed before input. Its exit handling was wrong. |
| [3](2026-10-04-clipboard-attempt-3.json) | 0 | 16 actions completed. Paste restored all bytes in four fixtures; typeText, Right and engine drag left generations unchanged. |
| [4](2026-10-04-clipboard-attempt-4.json) | 1 | Local drag left rich text and files unchanged, 2/2. Copy replaced rich text and did not restore it. A simulated new copy survived paste, which returned a conflict. Later Copy and Paste failed because the probe had not recovered the window identity. |
| [5](2026-10-04-clipboard-attempt-5.json) | 1 | Cancelled through the owned terminal while waiting for the live lock. The fixture had not started. Review found bugs to fix first. |
| [6](2026-10-04-clipboard-attempt-6.json) | 1 | The next run acquired the lock but the sandbox could not resolve TextEdit. No app action ran. |
| [7](2026-10-04-clipboard-attempt-7.json) | 1 | The fixed-path trials stopped before clipboard input in 8/8: SQLite could not open the reservation file inside the engine. |
| [8](2026-10-04-clipboard-attempt-8.json) | 0 | Diagnostic: engine home and support directory were correct. |
| [9](2026-10-04-clipboard-attempt-9.json) | 0 | Diagnostic: SQLite also failed in the private temporary bank. Engine child JXA could not read the pasteboard. |
| [10](2026-10-04-clipboard-attempt-10.json) | 0 | The same helper read the pasteboard from the host relay. Engine access failed. |
| [11](2026-10-04-clipboard-attempt-11.json) | 1 | Sandbox could not resolve TextEdit before the connection diagnostic. |
| [12](2026-10-04-clipboard-attempt-12.json) | 0 | Diagnostic: engine loopback fetch failed. Its later call lacked a recovered window identity. |
| [13](2026-10-04-clipboard-attempt-13.json) | 1 | Engine native pipe closed before discovery. |
| [14](2026-10-04-clipboard-attempt-14.json) | 0 | Diagnostic: engine could read the bridge file but could not write it. Loopback, SQLite and child clipboard access failed. |
| [15](2026-10-04-clipboard-attempt-15.json) | 1 | Sandbox could not resolve TextEdit for the relay fix check. |
| [16](2026-10-04-clipboard-attempt-16.json) | 1 | The relay trials completed, 8/8. Text, images and rich text restored. File fixtures lost their second item. |
| [17](2026-10-04-clipboard-attempt-17.json) | 1 | Cancellation raced lock acquisition. Four text/image trials completed. Final restoration was not proven. Terminal receipt retained. |
| [18](2026-10-04-clipboard-attempt-18.json) | 1 | Conditional recovery refused because the clipboard no longer matched the owned synthetic image. Current contents were preserved. |
| [19](2026-10-04-clipboard-attempt-19.json) | 1 | The host snapshot saw both file items in 2/2 trials. Copy restored one item, and Cut/Paste restored both. |
| [20](2026-10-04-clipboard-attempt-20.json) | 1 | Relay trace confirmed two file items in the snapshot and restore request. Copy still returned only one item after helper exit. |
| [21](2026-10-04-clipboard-attempt-21.json) | 0 | File Copy and Cut/Paste preserved both items after read-back verification, 2/2. |
| [22](2026-10-04-clipboard-attempt-22.json) | 0 | Final Copy and Cut/Paste checks restored every representation in text, image, two-file and rich-text fixtures, 8/8. All test documents retained their original text. |
| [23](2026-10-04-clipboard-attempt-23.json) | 1 | Round 2 sandbox could not resolve TextEdit. No app action ran. |
| [24](2026-10-04-clipboard-attempt-24.json) | 0 | Default native mode passed 9/9 Copy/Cut/Paste trials. Copy remained readable through `pbpaste`, with a notice to Claude. |
| [25](2026-10-04-clipboard-attempt-25.json) | 0 | Opt-in preservation passed 9/9 rich-text trials plus one promised-format fallback. Copy results explained the private destination. Fallback copied natively with a warning. |

The final relay check returned no tool errors. It restored the user's snapshot after the synthetic
fixtures. The helper materializes and verifies every published item before exiting. The file-only
check and final run preserved both file URLs after that process had exited.

Round 1 verification: `npm run check` exited 0 with 191 unit tests, manifest validation and 8 mod tests.
`npm run lint:prose` exited 0. Regression tests first failed for missing guard exports, shortcut
classification, relay restoration, reset and close cleanup, and a writer dropping an item. The
fixed tests passed. Earlier prose checks failed on the missing Vale pack and style rules. Installing
the pinned pack and revising the prose resolved them.

Attempt 3's `restoredBytes: false` for rich text compared the format arrays in order. The engine
reordered the formats; each type, byte length and hash was preserved. Later comparisons sort formats
within each item. The raw result remains as captured.

Round 2 makes preservation opt-in with `SLEIGHT_CLIPBOARD=preserve`, because the relay cannot reliably
observe a later menu or browser paste consuming Claude's copy. Default Copy/Cut now leave that copy
on the user's clipboard. Attempts 24 and 25 both restored the original snapshot after cleanup.
The promised-format fixture contained synthetic readable bytes under a promise type. It tests the
type rejection and native fallback. A real delayed file provider remains untested. Unit tests also cover
unreadable data and the 64 MiB limit without changing the clipboard before the native shortcut.

The latency samples used three repetitions per shortcut and mode with the same rich-text fixture.
Whole-call time includes the engine response. Clipboard I/O time includes the helper and shared
reservation operations, measured separately inside the relay.

| Shortcut | Native median | Preserve median | Difference | Clipboard I/O median |
|---|---:|---:|---:|---:|
| Copy | 533 ms | 768 ms | 236 ms | 180 ms |
| Cut | 555 ms | 760 ms | 205 ms | 177 ms |
| Paste | 540 ms | 766 ms | 226 ms | 179 ms |

These are separate runs on one Mac. The difference includes engine timing variation. Large
payloads may take longer. Native mode does not run the clipboard helper or reserve the clipboard.

Round 2 verification: `npm run check` exited 0 with 218 unit tests, manifest validation and 8 mod tests.
The first regression run failed 10/33 tests before the fixes. A further reset-during-snapshot test
failed 1/10 before the relay stopped dispatch into the reset realm. The fixed tests passed, including
both `pressKey` argument wrappers, split-and-retry messages, native fallback and reset cleanup.
Prose checks exited 1 on three style flags, then one, then five in the added report. The final check
exited 0 after revision.

The local drags returned success but did not move the selected word. These trials measure clipboard
changes. They do not qualify text drag. The conflict trial confirms that a replacement clipboard
survived, not that the intended text was inserted in the document. Engine errors invalidate clipboard claims
for actions that did not run.

To repeat the focused probe, create a private `/private/tmp/sleight-clipboard-*` folder, then run:

```sh
sh bench/clipboard-build.sh /private/tmp/sleight-clipboard-EXAMPLE
sh bench/clipboard-live.sh /private/tmp/sleight-clipboard-EXAMPLE
sh bench/clipboard-live.sh /private/tmp/sleight-clipboard-EXAMPLE --extra
sh bench/clipboard-live.sh /private/tmp/sleight-clipboard-EXAMPLE --fixed
sh bench/clipboard-live.sh /private/tmp/sleight-clipboard-EXAMPLE --round2
sh bench/clipboard-live.sh /private/tmp/sleight-clipboard-EXAMPLE --round2 --fixed
```

Each invocation writes `results.json` in that folder. Save it before another invocation; the file is
replaced. `original.json` holds the private clipboard snapshot and must never be published. The
runner restores it only if the current generation still matches the last fixture. The shell runner
holds the lock for the live invocation and releases it on exit. Build the fixture outside the lock.
