# Browser extension against accessibility reads (2026-10-10)

The real-use suite's Helium web tasks (form, grid, editor, dense, spa, nested and infinite), Haiku
5.5 at high on the API key, owner away, three rounds with the side that went first alternating. One
side drove Helium through its accessibility tree only (`--surfaces computer`, the default). The
other also had the engine's browser-extension API (`--surfaces browser,computer`), with the ChatGPT
extension connected. Every run is in [`2026-10-10-surface-ab.json`](2026-10-10-surface-ab.json).

The first attempt stopped at helium-form setup on all six sides: the fixture's control file made
Helium's setup time out (`9aa125c`).

In the rerun, the accessibility side passed 21/21, in 634 s and 176 turns. The extension side ran 8
runs and passed 2. In 3 runs the engine asked to let browser use reach the benchmark's own page
(`http://127.0.0.1:…`), and the benchmark's approver declined the prompt, as it does for anything off
its allowlist. In 2 runs Claude used the extension API and the page didn't end in the expected
state (helium-grid, and helium-form without all five values).

There is no comparison yet. The extension API needs a site approval for each page, and an
unattended run can only give one if the benchmark's allowlist covers its own local pages, which is
the owner's call.
