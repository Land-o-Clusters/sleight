# Turbo v3 distribution inventory

Turbo uses the running Node runtime, built-in modules and the pinned Playwright core 1.64.0 runtime under vendor/playwright-core.
The exact vendor file hashes live in inspectors/playwright-files.json. LICENSE, NOTICE and ThirdPartyNotices.txt remain intact.
The loader verifies every retained file and refuses extra, missing, changed or linked files.

The plugin distributes native/peer-host.c and native/consent-host.swift as source. The process observer still supplies the selected
browser's PID, start time and executable evidence. The consent host supplies authenticated payment and connection controls.
Both compile locally at first use with Apple's command-line tools. No signed or notarized native binary is distributed.

Electron turbo modules load only on a turn for an app the operator opted in per app (turbo-apps.json, read by
electron-config). Each uses built-in Node modules and the shared v3 modules named here, never a new dependency.
- electron-identity and electron-consent: the app instance, typed app documents and the debugger card. consent-ui, host-files
  and v3-context import electron-identity and use it only when a trusted app binding exists.
- electron-channel, electron-connection, electron-host, electron-host-entry, electron-host-run, electron-admin and
  electron-ownership: the resident host process, its authenticated channels and the parent's admin client. Playwright is the
  pinned copy, loaded through worlds.mjs and connected through cdp-filter.mjs in app mode.
- electron/: the broker (broker.mjs), the Python launch adapter and pipe keeper (launch.py, run with the system python3), the reviewed recipe
  registry (recipes.json) and their notices. The package receipt hashes them with every other file.
- electron-targets, electron-native-join and electron-pages: app target admission, the window join and the page registry.
  cdp-filter's app mode is off unless a caller passes it, so the browser path is unchanged.
- electron-recipes, electron-capabilities and electron-windows.mjs: registry checks, the qualification dry run and the window
  reader. electron-windows.js is its JXA helper, run with /usr/bin/osascript, and reads window metadata only.
- electron-read and electron-handoff: the app read header over snapshot.mjs, and input runners over act.mjs and fill.mjs.
- electron-runtime: what worker.mjs calls to connect an opted-in app for a turn.
- electron-relaunch: the relaunch flow, which reopens the user's own app with the debugger pipe after the user's click.
  electron-apps.js is its JXA helper, run with /usr/bin/osascript. It lists the app's processes and asks one exact process
  to quit through NSRunningApplication.

host.mjs publishes both helpers only after compilation and hash verification, under a private per-user cache.
Its exclusive build.lock refuses concurrent publication. Source and executable identity are rechecked before each launch.
Only a locally issued receipt object can start a helper. Missing tools or failed compilation leave the engine route available.

installed-config.mjs accepts only the operator's fixed configuration. The source receipt inventories the entire plugin, including
launcher, relay, hooks, helpers and vendor bytes. A package change needs fresh operator acceptance.

worker.mjs uses inherited fork IPC instead of the retired socket broker and peer-client protocol.
V3 retains the native process observer, UI channel, user-file authority and selected browser connection.
Engine apps and browser tools remain available beside turbo. No app, profile or browser is opened during package verification.

Live qualification covers the v3 page, snapshot, action, form, rule, context and worker tests through the host runner.
Offline tests and compiler success do not prove live behavior, foreground preservation or task performance.
