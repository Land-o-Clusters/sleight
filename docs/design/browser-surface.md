# Browser control

Startup discovery runs one owned engine with only browser control enabled. It calls
`cua.listBrowsers({emit: false})` with fresh session and turn metadata. Only an extension entry with
`metadata.extensionInstanceId` enables browser control in the session engine. Discovery declines any
unexpected prompt and hides its output. It times out after four seconds and collects its process. Failure
leaves native control available. An explicit `SLEIGHT_SURFACES` skips discovery and preserves the
configured backends. Automatic discovery enables extensions and excludes the in-app browser.

Browser call text is a first filter. It never turns off the native guards. The relay accepts browser
status and learns browser handles only after a successful engine reply reports
`_meta['codex/toolSurface'].kind: "browserUse"`. Missing, failed or native replies keep native result
handling. A confirmed browser reply preserves the last native window observation.

Each candidate gets the native runtime guard before execution. When a native window is known, the
relay attempts its input lease and applies saved-file change review before forwarding. Without a
confirmed target or available lease, the guard denies native acquisitions and native handle methods;
ordinary browser calls still run. Flow rules inspect every call. Browser candidates run one at a time,
and native reads and resets wait for their reply so they cannot clear a pending native denial.
Only native handles touched during the current candidate produce a native post-action observation.
Document approval mode remains native-only.

The locked engine probe found that `cua` is global and earlier native bindings remain visible inside
an async function with a frozen browser-only `cua` parameter. String-generated functions are disabled,
but `globalThis.cua.getApp` and an earlier native handle are still reachable. Importing `node:vm` is
possible; bridging browser functions into another VM context is not an engine-supported capability
boundary. The relay uses the reply-metadata fallback instead of claiming JavaScript
isolation. The existing native runtime guards remain cooperative and mutable by arbitrary caller
JavaScript, as described in [the laws](../status/LAWS.md).

The final locked fallback run acquired a browser tab in `app`, read Example Domain, read TextEdit,
then read both again in the same session. Browser replies reported `browserUse`; TextEdit replies
reported `computerUse`. The owned tab closed and the launcher exited with code 0. TextEdit stayed in
its existing Open dialog. The run only read its state. Saved-file snapshot
conflicts are covered by unit tests. The [full results and traces](../benchmarks/2026-10-04-browser-enforcement.json)
include all six attempts, including the earlier refused probes. The launcher's traces truncate code
and text. The recorded replies are complete. Home and per-user temporary paths are redacted.

The `browser-use` connector sends its prompts through the same dialog or client route as app
approvals. The relay never applies the app preapproval list or app session memory to browser prompts.
Declines remain declines. The engine can retain its own origin decision after a person accepts it.

Flow rules call all browser sources and destinations `browser`. They inspect literal fills, typing,
key presses and navigation URLs, and remember emitted browser values for source rules. Sites, tabs
and browser instances share that label. Runtime strings, clipboard operations and other DOM actions
remain outside literal inspection.

The existing turn metadata and `turn_ended` path also serve browser calls. The final locked run on
merged code opened and read Example Domain and clicked its link in 2/2 trials, Chrome and Helium.
The owner identified both labeled tabs. Both reached the IANA URL. Turn end removed both ordinary tabs,
confirmed by empty tab lists and "No tab with id" on each close. Earlier inventories were empty
despite an installed extension. The final run detected both after a connection refresh.
The [published calls and trace](../benchmarks/2026-10-04-browser-surface.json) include all failed attempts.
