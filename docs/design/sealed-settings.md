# Sealed settings

In 1.6.0, doctor shows each seal's verdict without changing permission decisions. Existing grants keep working.
Readers, the managed shim and scheduled ticks skip verification, including helper discovery and seal-file polling.
Doctor verifies once per run. Tool results omit the I4 line until a signed release enables enforcement and budgets that line.
The menu shows the preview state without reading settings or a key store.
Enforcement and adoption require the signed helper.

## Work plan

1. Prepare an unrun signing probe. It uses a separate probe service and never prints a key.
2. Add a native settings store, strict sidecars, descriptor-based file checks, serialized writes and a test-only file key store.
3. Add the Node protocol reader and build-hash proof. Pass verified content to readers without reading it again.
4. Prepare trusted settings readers. Keep current reads and writers active during the preview. Report verdicts in doctor.
5. Exercise 25 adversarial cases and 16 broken variants offline. Compare Swift and Node against one fixture set.
6. Record signing checks and integration limits, lint the prose, commit named paths and push the lane branch.

## Contract

The helper verifies `preapproved.json`, `permissions.json`, `turbo.json`, `turbo-owner.json`, `turbo-apps.json`,
`electron-grants.json`, `hand.json`, `settings-link.json`, `routine-launcher.mjs` and the JSON files read from
`routines/<id>/` and `watches/<id>/`. Operational folders and the per-host journal remain outside this store.

Each sidecar has exactly `version`, `file`, `counter` and `mac`. Its byte limit is 1,024. The MAC covers the exact file
bytes, relative path, installation id and counter. The shared fixture encodes the installation id in base64url and
the SHA-256 digest in lowercase hex. It encodes the key in base64url in the key store. These encodings remove ambiguity
between the Swift and Node implementations.

The native helper reads and updates the key and counters. Verification never creates a key, rewrites settings or repairs a seal.
The states are `trusted`, `absent`, `unsealed`, `tampered`, `stale` and `unsafe`. Only `trusted` contains content.
A missing file that the key store records as present is `tampered`. No verdict uses a clock or an environment override.

Writes take `.settings-lock`, create a private temporary file, advance the persistent counter, publish the sidecar,
then rename the file. A torn write can leave a stale pair. Verification requires counter equality.

The signed helper uses the data-protection keychain, a Team access group, after-first-unlock accessibility and no synchronization.
The file key store is compiled only with `SLEIGHT_TEST_KEYSTORE`. The production protocol accepts intents and never
accepts a file name plus bytes to seal. The legacy ACL fallback is not enabled.

## Migration defaults awaiting owner confirmation

Drop unsealed grants and ask again for each app. Adopt other settings after printing their contents, a typed `adopt`
and one Touch ID confirmation. Removals use the sealed write path without a sheet. Report one line with the file,
state and repair command, without settings content. Seal routines, watches and `hand.json` too.

The preview leaves existing writers in place. Enabling enforcement also requires moving those writers to native intents,
including the relay's Always allow callback and Electron grants. The relay interface is an integration boundary because
this lane may not edit `relay.mjs`.

`writeSettings({ family, op, args })` accepts closed intent forms. The native process computes the resulting bytes.
Native Always allow uses a protected card and merges against the latest trusted list under the lock. Other supported
changes capture their starting content and refuse if it changes during confirmation. Removals keep counter tombstones.
The preview refuses every native mutation with `SETTINGS_PREVIEW_ONLY`.
The production binary contains the protected-card and Touch ID intent code, but the enforcement flag and signed key store
keep it unreachable in the preview.

The install adapters for routine creation, watch recording and fresh browser or Electron receipts remain inactive.
Automatic watch and routine state changes also need an authorization design before enforcement: the invariant seals
every JSON file those stores read, including state files written without a person present. No general byte-sealing
endpoint is provided to work around that boundary.

The enforced JavaScript launcher checks its own seal, but edited JavaScript can remove that check. Enforcement
needs a signed launchd bootstrap that verifies the copied launcher before Node executes it. The preview hasn't changed
launchd registrations or established that execution boundary.

## Signing checks

The preview doctor proves the cached binary against its source inventory and `build.json`. A same-user attacker who
changes code and the build record can defeat that proof. It doesn't establish signed isolation.

`SETTINGS_BUILD_POLICY` defines the build policy. Its enforcement field is false and its Team is unset in this preview.
The native build flag follows that policy. An enforcement build refuses a missing or unproved helper instead of reading
raw settings. The signing release must rebuild the helper cache when changing the policy.
The routine installer stamps that policy into the self-contained launchd copy, so preview ticks don't load extra modules.

The signed verification transport waits on a metadata-only readiness pipe. Node proves the peer helper, checks the
child's running code flags, birth identity and cdhash through that peer, verifies the pinned Developer ID requirement,
then checks the running identity again. Only then does it let the child read settings and accept its output. Offline
tests inject these process results. The running-process proof hasn't been verified with a signed helper on this Mac.

After signing, run the probe with a Developer ID helper and its access-group entitlement. Confirm entitled add/read/delete,
refusal by `security`, refusal by an unsigned copy and absence of a prompt. If a bare tool cannot use the entitlement,
repeat with a minimal app bundle. Build that probe with `SLEIGHT_SEALED_SETTINGS` and `SLEIGHT_KEYSTORE_PROBE`; the normal
production build contains no probe entry point. The script makes an ad-hoc copy that calls SecItem directly and requires
`errSecMissingEntitlement`, so a launch or parser failure does not count as isolation evidence.
A legacy keychain fallback requires a separate documented decision because a same-user
process can replace its item. Real keychain behavior, Touch ID and physical-input handling need live checks after signing.
