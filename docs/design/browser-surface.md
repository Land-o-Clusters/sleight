# Browser control

Startup discovery runs one owned engine with only browser control enabled. It calls
`cua.listBrowsers({emit: false})` with fresh session and turn metadata. Only an extension entry with
`metadata.extensionInstanceId` enables browser control in the session engine. Discovery declines any
unexpected prompt and hides its output. It times out after four seconds and collects its process. Failure
leaves native control available. An explicit `SLEIGHT_SURFACES` skips discovery and preserves the
configured backends. Automatic discovery enables extensions and excludes the in-app browser.

Browser calls use observed handle bindings to avoid native window lease and saved-file guards.
Tabs have no sleight lease. Native acquisitions remove reused browser bindings, and mixed calls with
native handles still pass through the native guard. These checks run against cooperative code.
Arbitrary JavaScript can bypass them, as it can bypass the existing guards. Document approval mode
remains native-only.

The `browser-use` connector sends its prompts through the same dialog or client route as app
approvals. The relay never applies the app preapproval list or app session memory to browser prompts.
Declines remain declines. The engine can retain its own origin decision after a person accepts it.

Flow rules call all browser sources and destinations `browser`. They inspect literal fills, typing,
key presses and navigation URLs, and remember emitted browser values for source rules. Sites, tabs
and browser instances share that label. Runtime strings, clipboard operations and other DOM actions
remain outside literal inspection.

The existing turn metadata and `turn_ended` path also serve browser calls. The locked live trial
opened and read Example Domain, clicked its link and observed the new IANA URL. Turn end removed its
ordinary tab, confirmed by "No tab with id" and an empty tab list in a later session. There was one
connected extension, reported as Chrome. Owner identification and a second browser trial are pending.
An owner-connected retry found zero engine instances with both automatic detection and the override.
The [published calls and trace](../benchmarks/2026-10-04-browser-surface.json) include all failed attempts.
