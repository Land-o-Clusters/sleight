# Clipboard helper reuse

The preserving session now starts one AppKit byte helper on its first read or write and reuses it.
The byte staging, 64 MiB limit, generation checks, read-back verification, private session copy and
native fallback remain in place. Closing drains the active transaction and collects the helper.
Timeouts, transport errors and malformed replies keep the reservation until the child exits.
The helper doesn't replay writes or app input.

The focused helper, native-byte and relay tests passed 33/33. They cover Unicode framing,
fragmented and coalesced replies, invalid envelopes, child failure, failed writes, delayed collection,
restoration on engine failure, resets and session closure. Review found a reservation-release race
before the code was finished. A regression test failed first, then passed after collection
became the release boundary. An output-stream error regression also failed first, then passed.

No new live performance or restoration result is claimed. `/tmp/sleight-hold` remained present
beyond its stated 23:45 UTC estimate on 2026-10-09. The 2026-10-04 live results remain the baseline:
helper and coordination medians of about 180 ms for Copy, 177 ms for Cut and 179 ms for private Paste.

`bench/clipboard-helper-speed.mjs` is ready to compare the one-shot and persistent helper interfaces.
It measures three byte operations matching private Paste's read/write/restore path, separately from
engine and full-call latency. It checks text, PNG/TIFF, two file items and rich text three times per
interface. It also checks stale-generation refusal and restores the original clipboard only while
its generation is still owned. Payloads remain private. Published records contain byte lengths and
hashes. A private recovery snapshot is retained if restoration is unconfirmed.

Preparation compiled the Swift fixture and passed syntax checks. The live probe must acquire the
shared lock without waiting and refuse an existing hold. Both the speed claim and a fresh 4/4 byte
restoration claim remain pending that run.

Review found quadratic request and reply buffering. The 2026-10-10 follow-up counts only new
segments, searches only incoming chunks and joins each frame once. The 96 MiB bound includes the
newline and resets per frame. With 40 MiB of synthetic bytes encoded as base64 and delivered in
64 KiB chunks, both new timing tests failed before the fix:

| Framing path | Before (ms) | After (ms) | One-shot control after (ms) |
|---|---:|---:|---:|
| Node reply | 5,115 | 88 | 54 |
| Native helper request under VM | 5,331 | 31 | 29 |

The Node control models the old `execFile` chunk collection and EOF parse. The native control uses
the helper's retained one-shot interface with mocked AppKit. Request padding isolates framing from
pasteboard operations. These timings exclude process startup, native AppKit IO and app input.
Both tests require completion below 10 s and below the larger of 1 s or six times the one-shot
control, allowing scheduling noise while detecting the reproduced slowdown.

Focused clipboard tests passed 43/43, with another 7/7 settings tests. Boundary cases include an
exact 96 MiB frame and a frame one byte over. Separate cases check coalesced frames larger in
aggregate, then a valid frame followed by an oversized partial frame. Before the fix, four of the
six new boundary tests failed. The [run records](2026-10-10-clipboard-buffering.json) include failed
and passing runs. The full check passed 1,074 unit tests, plugin validation and 11 mod tests after a
sandbox attempt hit socket and build-output denials. Both required bare checks exited 0.
