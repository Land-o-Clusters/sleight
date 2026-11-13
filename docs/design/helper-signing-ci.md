# Mac helper signing and release

RT18 preparation. No Developer ID certificate, Apple team or notary credentials are configured here.
The plugin keeps compile at first use until its reviewed release pin is populated.

## Build and install design

`scripts/helper-release.mjs` composes the same Swift input as `mac-driver/build.mjs`.
It requires a clean Git checkout, Apple build tools and an explicit identity. It checks for the
tools before calling xcrun, so missing tools cannot open an install prompt. It builds arm64 for macOS 14,
with `-O`, a fixed module name, path remapping and no linker UUID. The compile fallback omits `-O`.
The optimized release needs its own ping and health smoke test before bundling.
The record includes the commit, Swift version, SDK version, source hash, unsigned hash,
signed hash and the build ID checked by ID1B's expected-build handshake.
Reproducing the unsigned hash requires the same Xcode and SDK. Developer ID timestamps
and notarization results are separate from reproducible compiler output.

The release folder contains `glide-engine`, `glide-engine.zip`, `release.json` and
`release-pin.json`. The script never launches the driver. An ad-hoc release uses `--identity -`,
doesn't require a keychain and cannot be notarized. A Developer ID release requires `--team-id` and
`--keychain`, pointing to a dedicated CI keychain. Its signature has the hardened runtime enabled.
Credentials are read only for an explicit `--submit`. Missing credentials produce a recorded
`credentials-missing` result and no upload. A failed or rejected submission fails the release.

`mac-driver/host.mjs` owns prebuilt verification. `MAC_DRIVER_RELEASE_PIN` is null until reviewed.
The plugin reads only its fixed `mac-driver/prebuilt/darwin-arm64/glide-engine` path.
It verifies the file hash, source hash, build ID, architecture, signature, signing identifier
and Apple Developer ID team requirement before accepting the helper. The signing identifier is
`com.sleight.glide-engine`. The consent window keeps its separate `consent-host` build. Ad-hoc acceptance is an
internal test seam. No environment variable, downloaded manifest or tool argument supplies pins.
Before spawn, the receipt rechecks the source and binary bytes. Refusal during preparation uses
the existing source compiler. A changed file after preparation stops the launch.
The shared consent host and the engine path build their helpers as before.

Refused pins write one private stderr diagnostic naming the failed check, such as
`source-hash`, `build-id`, `binary-hash`, `architecture`, `identifier`, `signature`, `team`,
`file-mode` or `symlink`. With a null pin, the loader returns without logging.
Tool results and model notices keep their existing text.
The diagnostic contains no file path or signing output. Verification runs synchronously once
per preparation, with up to 3 external commands, each limited to 10 seconds.

These checks guard against a tampered or stale package. They assume the plugin folder is trusted.
A same-user attacker who can write that folder can replace the validator and pin too.
The loader checks the binary file's owner and mode, and refuses symlinks, including linked ancestors.
Parent directories' write permissions aren't checked, and spawning the binary by path after hashing
leaves a gap in which that same-user attacker can swap it.

Offline tests use real ad-hoc signatures. The Developer ID requirement, team parsing and hardened-runtime
check still need a positive test with the owner's real artifact. The first signing CI run must supply that proof.

The workflow below is a proposal only. The owner installs it under `.github/workflows/`.

## Proposed workflow

Use a protected environment named `helper-signing`. Restrict its secrets to reviewed release commits.
Pin the runner's Xcode and SDK after the owner chooses the supported toolchain. Set
the repository variable `HELPER_MACOS_RUNNER` to an available macOS runner label and
`HELPER_DEVELOPER_DIR` to the
selected Xcode's developer directory. Record its SDK and Swift versions from the dry run.

```yaml
name: Mac helper release
on:
  workflow_dispatch:
    inputs:
      submit:
        description: Submit the signed helper to Apple
        type: boolean
        default: false
permissions:
  contents: read
jobs:
  helper:
    runs-on: ${{ vars.HELPER_MACOS_RUNNER }}
    environment: helper-signing
    env:
      DEVELOPER_DIR: ${{ vars.HELPER_DEVELOPER_DIR }}
    steps:
      - uses: actions/checkout@v4 # Owner pins the reviewed action commit before adoption.
      - uses: actions/setup-node@v4 # Pin this action's commit too.
        with:
          node-version: '24' # Matches the repository's main CI workflow.
      - name: Import certificate into a disposable keychain
        shell: bash
        env:
          CERTIFICATE_BASE64: ${{ secrets.DEVELOPER_ID_CERTIFICATE_BASE64 }}
          CERTIFICATE_PASSWORD: ${{ secrets.DEVELOPER_ID_CERTIFICATE_PASSWORD }}
          KEYCHAIN_PASSWORD: ${{ secrets.HELPER_KEYCHAIN_PASSWORD }}
        run: |
          set -euo pipefail
          : "${DEVELOPER_DIR:?set HELPER_DEVELOPER_DIR to the selected Xcode}"
          umask 077
          printf '%s' "$CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/developer-id.p12"
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$RUNNER_TEMP/helper.keychain-db"
          security set-keychain-settings -lut 21600 "$RUNNER_TEMP/helper.keychain-db"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$RUNNER_TEMP/helper.keychain-db"
          security import "$RUNNER_TEMP/developer-id.p12" -P "$CERTIFICATE_PASSWORD" -T /usr/bin/codesign -t cert -f pkcs12 -k "$RUNNER_TEMP/helper.keychain-db"
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$RUNNER_TEMP/helper.keychain-db"
          rm "$RUNNER_TEMP/developer-id.p12"
      - name: Build, sign and optionally submit
        shell: bash
        env:
          SIGNING_IDENTITY: ${{ secrets.DEVELOPER_ID_IDENTITY }}
          TEAM_ID: ${{ vars.APPLE_TEAM_ID }}
          NOTARY_KEY_BASE64: ${{ secrets.NOTARY_KEY_BASE64 }}
          SLEIGHT_NOTARY_KEY_ID: ${{ secrets.NOTARY_KEY_ID }}
          SLEIGHT_NOTARY_ISSUER: ${{ secrets.NOTARY_ISSUER }}
          SUBMIT: ${{ inputs.submit }}
        run: |
          set -euo pipefail
          umask 077
          args=()
          if [[ "$SUBMIT" == true ]]; then
            args+=(--submit)
            if [[ -n "$NOTARY_KEY_BASE64" ]]; then
              printf '%s' "$NOTARY_KEY_BASE64" | base64 --decode > "$RUNNER_TEMP/notary.p8"
              export SLEIGHT_NOTARY_KEY_FILE="$RUNNER_TEMP/notary.p8"
            fi
          fi
          nice -n 20 node scripts/helper-release.mjs --identity "$SIGNING_IDENTITY" --team-id "$TEAM_ID" --keychain "$RUNNER_TEMP/helper.keychain-db" --output "$RUNNER_TEMP/helper-release" "${args[@]}"
      - uses: actions/upload-artifact@v4 # Pin this action's commit too.
        with:
          name: mac-helper-arm64
          path: ${{ runner.temp }}/helper-release/
      - name: Remove signing material
        if: always()
        shell: bash
        run: |
          security delete-keychain "$RUNNER_TEMP/helper.keychain-db" || true
          rm -f "$RUNNER_TEMP/developer-id.p12" "$RUNNER_TEMP/notary.p8"
```

No secret is echoed. Do not enable shell tracing. The temporary keychain is never added to the
login keychain search list. This workflow uploads a private Actions artifact.
The final plugin pin and bundled binary need a separate reviewed packaging commit. A raw Mach-O
inside a zip doesn't support a stapled ticket. This design submits the zip and leaves Gatekeeper's
ticket lookup online. An offline installer would need a signed, notarized and stapled package,
which is a separate owner decision.

## Owner steps, in order

1. Complete Apple Developer enrollment. Create a Developer ID Application certificate and export
   its private key as a password-protected `.p12` from the owner's secure machine.
2. Create an App Store Connect notary API key. Keep the `.p8`, key ID and issuer in the owner's
   secret store. Do not put credentials in this repository or the lane report.
3. Create the protected Actions environment: `gh api --method PUT repos/Land-o-Clusters/sleight-dev/environments/helper-signing`.
   Configure its required reviewers and permitted release refs before adding secrets.
4. Add the certificate: `base64 < developer-id.p12 | gh secret set DEVELOPER_ID_CERTIFICATE_BASE64 --env helper-signing --repo Land-o-Clusters/sleight-dev`.
5. Add the certificate password from a secure prompt: `gh secret set DEVELOPER_ID_CERTIFICATE_PASSWORD --env helper-signing --repo Land-o-Clusters/sleight-dev`.
6. Add a dedicated keychain password: `gh secret set HELPER_KEYCHAIN_PASSWORD --env helper-signing --repo Land-o-Clusters/sleight-dev`.
7. Add the signing identity: `gh secret set DEVELOPER_ID_IDENTITY --env helper-signing --repo Land-o-Clusters/sleight-dev`.
8. Add the team ID: `gh variable set APPLE_TEAM_ID --env helper-signing --repo Land-o-Clusters/sleight-dev`.
9. Add the notary key: `base64 < AuthKey.p8 | gh secret set NOTARY_KEY_BASE64 --env helper-signing --repo Land-o-Clusters/sleight-dev`.
10. Add its key ID: `gh secret set NOTARY_KEY_ID --env helper-signing --repo Land-o-Clusters/sleight-dev`.
11. Add its issuer: `gh secret set NOTARY_ISSUER --env helper-signing --repo Land-o-Clusters/sleight-dev`.
12. Choose Xcode and SDK. Set the repository variables `HELPER_MACOS_RUNNER` and `HELPER_DEVELOPER_DIR` with
    `gh variable set NAME --repo Land-o-Clusters/sleight-dev` for each name.
    Pin the three Actions by commit and install the proposed workflow.
    Run `gh workflow run helper-signing.yml --repo Land-o-Clusters/sleight-dev --ref REVIEWED_COMMIT -f submit=true`.
13. Download the private artifact: `gh run download RUN_ID --repo Land-o-Clusters/sleight-dev --name mac-helper-arm64 --dir helper-release`.
14. Check `release.json` for `notarization.status: accepted`, the exact source commit, Swift/SDK
    versions and build ID. Build again with the same toolchain and compare `unsignedSha256`.
    Inspect `codesign --display --verbose=4 helper-release/glide-engine`: confirm the identifier,
    Developer ID authority, team ID and hardened-runtime flag. Record the strict signature verification
    from the release script as the first real Developer ID positive result.
    Before bundling, smoke-test this `-O` binary in a disposable test session through the driver client:
    ping, compare the returned build ID to `release.json`, and read health. Record commands and results.
    A passing compile-fallback test does not test the optimized binary.
15. Create the destination directory: `mkdir -p plugins/sleight/lib/mac-driver/prebuilt/darwin-arm64`.
16. Copy the helper: `install -m 755 helper-release/glide-engine plugins/sleight/lib/mac-driver/prebuilt/darwin-arm64/glide-engine`.
    Replace the null pin in `host.mjs` with
    the literal object from `release-pin.json`. Keep the source hash and build ID tied to this
    plugin's source. Commit those two paths together and run the focused build and prebuilt tests.
    This packaging commit must follow the last native-source change. Any later native edit needs
    a rebuilt helper and a new pin before publishing. The non-null release-pin test must pass.
    The team ID becomes public in the committed pin and in every signature. The owner must knowingly
    accept that disclosure before committing it.
17. Have sleight-arch run the fresh-user check below before publishing. Publishing needs the
    owner's approval. So does packaging for a separate TCC row or an offline installer.

For a local ad-hoc dry run from a clean checkout, with the lane test gate open:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node scripts/helper-release.mjs --identity - --output "$(mktemp -d /private/tmp/sleight-release.XXXXXX)/helper-release"
```

## Fresh-user check for sleight-arch, not run by this lane

The RT18 done line requires a fresh macOS user to install sleight and drive Calculator, with
clicks and minutes counted. Use a disposable local user on an owner-approved Mac and a quiet slot.
Keep the owner's apps, accounts and TCC database outside the run. Do not reset their grants.

1. Record the plugin commit, helper SHA-256, build ID, team ID, macOS version, architecture,
   Node version, host app/version and whether Command Line Tools are installed. Start a monotonic
   timer before the first install command. Record each command and its exit code.
2. Log in as the fresh user. Install the exact plugin package through that host's documented
   local plugin install command. Record every physical click, including install, trust and
   permission dialogs, and total elapsed minutes. Record unexpected prompts verbatim.
3. Select the runtime preview using `SLEIGHT_RUNTIME=own` for that test session. With the
   Command Line Tools absent, request one Calculator acquisition. Confirm the pinned prebuilt
   was used. A compiler or a prompt to install tools fails this check. Corroborate the helper's
   ping build against `release.json`. Record the host executable to which TCC grants attach.
4. The person answers Accessibility, Screen Recording and sleight's Calculator approval.
   Count each click and any app restart. Never use an agent to answer these prompts.
5. Through sleight, calculate `7 * 8`. Verify the displayed `56` by a fresh read, then perform
   a screenshot read of that Calculator window to exercise the Screen Recording grant.
   Save only fixture-window evidence. Record tool outcomes, click count and elapsed minutes.
   If the integrated runtime still refuses input in preview, stop and report that gate. Do not
   enable fixture capabilities to count this check as passed. Do not send input through another driver.
6. End the session. Start a second session and repeat the calculation. Record whether any
   prompts recur and whether the helper/build identity stays the same. Check that the person
   can keep typing in another fixture app without a focus or Space change.
7. In a separate disposable install, tamper with the bundled helper. With Command Line Tools
   installed, confirm prebuilt refusal and compilation from the matching plugin source.
   With tools absent, confirm `APPLE_TOOLS_MISSING` and no install dialog. Do not execute the tampered helper.
8. Record passes and failures separately for install, signature/build check, TCC, approval,
   Calculator input, AX read, screenshot, warm session and fallback. RT18 passes only when
   the fresh user completes the Calculator task. Report total clicks, total minutes and all
   skips. Close only the fixture apps and remove the disposable user by the owner's procedure.

This runbook does not authorize a live run. sleight-arch must obtain its quiet slot and owner
authorization. Confirm the signed helper's attribution during
the fresh-user run before claiming that the grant model works for that host.
