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

The final relay check returned no tool errors. It restored the user's snapshot after the synthetic
fixtures. The helper materializes and verifies every published item before exiting. The file-only
check and final run preserved both file URLs after that process had exited.

Verification: `npm run check` exited 0 with 191 unit tests, manifest validation and 8 mod tests.
`npm run lint:prose` exited 0. Regression tests first failed for missing guard exports, shortcut
classification, relay restoration, reset and close cleanup, and a writer dropping an item. The
fixed tests passed. Earlier prose checks failed on the missing Vale pack and style rules. Installing
the pinned pack and revising the prose resolved them.

Attempt 3's `restoredBytes: false` for rich text compared the format arrays in order. The engine
reordered the formats; each type, byte length and hash was preserved. Later comparisons sort formats
within each item. The raw result remains as captured.

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
```

Each invocation writes `results.json` in that folder. Save it before another invocation; the file is
replaced. `original.json` holds the private clipboard snapshot and must never be published. The
runner restores it only if the current generation still matches the last fixture. The shell runner
holds the lock for the live invocation and releases it on exit. Build the fixture outside the lock.
