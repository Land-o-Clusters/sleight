# Windows VM session for sleight

WV1, 2026-10-28. Export a reviewed commit from the Windows integration branch. The starting integration is
`5706336e` on `private/claude/win`. Use a later reviewed SHA containing WV1 before exporting this kit.
The kit has Mac tests with mocks. The 2026-10-31 Windows VM sitting ran preflight and the non-drawing driver build/selftest
on kit `7c1c6dd2`. Later exports need their own receipts.

## Before the sitting

UTM 5.0.8 is installed at `/Applications/UTM.app`, with its download SHA-256 checked and notarization verified by
sleight-arch. The Mac has 32 GB RAM, 10 cores and 166 GB free at the setup handoff. Use 4 guest cores, 8 GB RAM and a
96 GB virtual disk for the ISO path. Save the VM folder under `~/Downloads/sleight-vm/`. A growing disk, installer image
and snapshots all consume Mac storage. Recheck free space before setup. Leave the VM off during another project's timed tests.

Guest commands and input run through the UTM window on this Mac. Even a non-drawing guest check uses a Mac window,
focus and keyboard input to start. Before opening UTM or driving the guest, check that `/tmp/sleight-hold` is absent
and have sleight-arch arrange a quiet window with Puddle. The owner chooses a supervised sitting while present or
explicitly says they are away. A present sitting requires the owner's explicit permission for the visible UTM steps;
otherwise wait until they say they are away, as required by LAWS, "Anything that shows windows...".
These conditions apply to steps 3 through 8, every guest command below and the driver sitting. Recheck the hold before
each phase. If it appears, the Puddle window ends or the owner returns during an away sitting, pause guest driving.

The owner chose the free Windows Insider Preview for ARM under its own terms. A paid Windows license waits until
sleight releases Windows support. The owner signs in to the Windows Insider program and downloads the ARM64 preview
image from [Microsoft's Insider ARM64 page](https://www.microsoft.com/en-us/software-download/windowsinsiderpreviewarm64).
That page requires Insider membership and sign-in. No product key is part of this sitting. If the offered image or its
terms require a different licensing decision, stop setup and record the question. Do not substitute a retail image,
purchase a key or bypass an eligibility check. Record the chosen channel, build, download date, image filename and
Microsoft's checksum when offered. Before importing or booting the image, compute its SHA-256 in the Mac download
directory (replace the filename):

```sh
shasum -a 256 WINDOWS_IMAGE_FILENAME
```

When Microsoft publishes a SHA-256 for that exact filename and build, compare the complete digest with that value.
A mismatch stops setup. Retain both digests and the Microsoft source. If no checksum is published, record that image
verification is unavailable and retain the local digest for provenance only. Preview terms, expiry and available builds
can change.

All durations below are estimates, with no installation trial behind them. Allow roughly 90 to 180 minutes for setup,
then 30 to 60 minutes for preflight, inventory and offline checks. The optional driver sitting is longer and may need
another session.

| Order | Who | Step | Estimated time |
| --- | --- | --- | --- |
| 1 | sleight-arch | Review the integration commit, run its focused checks and export the guest kit below. Retain its commit and manifest hash outside the kit. | 5 to 10 min |
| 2 | Owner | Join/sign in to Insider, read the terms, download the Windows Insider Preview ARM64 image and check its hash when published. | 30 to 90 min |
| 3 | Owner | Create the UTM VM with the settings below, start installation and handle terms/account prompts. | 20 to 40 min |
| 4 | Owner | Install guest tools and Windows updates, then restart. Check clipboard isolation again. | 20 to 40 min |
| 5 | Owner | Install the pinned ARM64 Node MSI after its checksum check. Handle installer/UAC prompts. | 5 to 10 min |
| 6 | sleight-arch, owner-chosen sitting | After the hold/Puddle/owner checks above, transfer only the exported kit, verify the two receipt pins and run guest preflight first. | 5 to 10 min |
| 7 | sleight-arch, owner-chosen sitting | Under the same checks, run Phase 0 inventory, then the non-drawing host checks. Stop each failed part. | 30 to 60 min |
| 8 | Owner, then sleight-arch | If a second sitting is available, prepare disposable guest windows for the driver runbook. | 90 to 120 min |

The owner handles Microsoft accounts, sign-in, terms, UAC, app installation, engine approvals and visible fixture setup.
sleight-arch handles commit review, export, command execution, evidence review and reporting. This runbook authorizes no
unattended desktop driving without the owner's away authorization. The owner installs ChatGPT in the guest and signs in.
If ChatGPT installation or guest Computer Use access needs an owner decision, skip the engine
portion until that decision and access exist. The host and driver checks can proceed independently.

## UTM 5.0.8 settings and installation

1. Owner: after the sitting checks above, open the installed UTM and choose **Create > Virtualize > Windows**.
   Use the Windows 10-or-higher option and QEMU virtualization on Apple silicon, with ARM64/aarch64 architecture.
   Set 4 CPU cores and 8,192 MiB RAM. Enable Windows guest drivers and SPICE tools. Choose the path matching the download:

   - ISO: select **Boot ISO Image**, attach the ARM64 ISO and create a 96 GB virtual disk for Windows installation.
   - VHDX: select the existing ARM64 disk through **Boot VHDX Image**, the equivalent boot-disk choice. The installed
     UTM 5.0.8 bundle contains that English label in `Contents/Resources/de.lproj/Localizable.strings`.
     I could not confirm an **Import VHDX** sequence, disk-size handling or first-boot OOBE from bundled documentation.
     Do not apply the ISO's 96 GB blank-disk step to this branch. Check that the saved VM uses the downloaded VHDX and
     record its actual capacity. First boot may open Windows account/region setup (OOBE) rather than the ISO installer;
     this has not been verified. If the existing disk cannot be selected, stop this branch and record an owner question.

   Save the VM folder under `~/Downloads/sleight-vm/`.
2. Owner: check the saved VM settings before first boot. UEFI boot must be on, with TPM 2.0 and Secure Boot.
   UTM's Windows wizard enables TPM and Secure Boot
   on current new VMs, but check the saved settings. Under QEMU settings, UEFI and TPM must be enabled. For a new VM,
   use **Preload Secure Boot Keys** if key enrollment is needed. Follow the
   [UTM QEMU guide](https://docs.getutm.app/settings-qemu/qemu/) and
   [Windows guide](https://docs.getutm.app/guides/windows/). Stop if those controls are absent. Keep the Windows checks enabled.
3. Owner: in **Edit > Sharing**, turn **Clipboard sharing** off. Don't share a Mac home folder. Start the VM, install the
   preview from the ISO, or boot the imported VHDX. Complete its account and terms screens without supplying a product key.
   An unexpected key requirement stops setup.
4. Owner: install the supplied guest tools, apply Windows Update and restart. Verify clipboard sharing remains off after
   SPICE installation and reboot. Record UTM 5.0.8, Windows build and architecture. Check TPM and Secure Boot in guest
   System Information/Windows Security. Any unsupported or disabled result stops qualification.

UTM 5 has experimental Windows graphics support through guest tools. Record the selected display driver and acceleration
setting. Graphics failures need a physical-Windows comparison before attributing them to sleight. Microsoft's
[Mac guidance](https://support.microsoft.com/en-us/windows/experience/platform-variants/options-for-using-windows-11-with-mac-computers-with-apple-m1-m2-and-m3-chips)
names Parallels. It does not establish UTM support.

## Install Node and transfer the kit

Owner: install Node 25.0.0 ARM64 for both runbooks. From the
[official Node download page](https://nodejs.org/en/download), save the
[ARM64 MSI](https://nodejs.org/dist/v25.0.0/node-v25.0.0-arm64.msi) and
[SHASUMS256.txt](https://nodejs.org/dist/v25.0.0/SHASUMS256.txt) from that same release.
From their download directory in guest PowerShell, check the installer before opening it:

```powershell
$expected = ((Get-Content SHASUMS256.txt | Select-String '\s+node-v25.0.0-arm64.msi$').Line -split '\s+')[0]
if (-not $expected -or (Get-FileHash node-v25.0.0-arm64.msi -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node checksum mismatch' }
```

Owner: run the installer, handle UAC and decline optional native build tools. The kit adds 0 npm dependencies.
No npm install, Git for Windows, .NET SDK, private-repository login or host token is needed in the guest.

sleight-arch: from the clean reviewed Mac worktree, replace the full SHA and absent output-folder placeholders:

```sh
bench/windows/export-guest.sh --commit REVIEWED_FULL_SHA --output NEW_EXPORT_FOLDER
```

The exporter uses `/usr/bin/git archive` with a fixed source/fixture selection. It refuses tracked, staged or untracked
dirt, symlinks, submodules, case-colliding paths, literal Mac home paths and recognized credential patterns. It includes no
`.git`, `node_modules`, ledger, host settings or authentication files. Pattern scanning cannot prove the absence of every
possible secret. Review the selected commit before transfer. The receipt prints the commit, file count, byte count and
SHA-256 of `guest-manifest.json`. Retain that receipt separately. A folder's identity is the manifest hash and its complete
per-file hashes. Output must be absent; a copy failure can leave a partial folder, which must not be transferred.
Before publication, the extracted file count must equal the selected `git ls-tree` count. An `export-ignore` omission
stops the export instead of producing an incomplete kit. A 60-second Git or tar timeout also stops export before
publication. Rerun from the clean worktree after the load falls.

Owner and sleight-arch: mount only that exported folder read-only through UTM directory sharing, using guest tools.
Verify a guest write to the share is refused, then copy its contents into a new guest-local `C:\sleight` folder.
If the read-only UTM share is not set up, `scp` from the Mac into a new `C:\sleight` is the accepted transfer
(sleight-arch, 2026-11-02). Use the guest's existing SSH access. Before either transfer, preserve an old kit in guest
PowerShell. Never delete it or copy a new kit over it:

```powershell
if (Test-Path -LiteralPath C:\sleight) {
  $oldKit = 'sleight-kit-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  if (Test-Path -LiteralPath (Join-Path C:\ $oldKit)) { throw 'Backup name exists; stop transfer' }
  Rename-Item -LiteralPath C:\sleight -NewName $oldKit -ErrorAction Stop
}
```

For `scp`, run this on the Mac, replacing the exported folder, guest account and guest address. The destination must
be absent so the copy creates `C:\sleight`, without nesting another kit folder inside it:

```sh
scp -r NEW_EXPORT_FOLDER WINDOWS_USER@GUEST_HOST:C:/sleight
```

Do not share a Mac checkout or home directory. Test/compiler outputs stay in the guest-local copy. Disconnect the share
if used, once copying finishes. Preserve LF and all original bytes. Avoid rewriting files in a guest editor.
After either transfer, verify the independent Mac receipt in guest PowerShell before building or running a dry run:

```powershell
$sha = 'REVIEWED_FULL_SHA'
$manifestHash = 'MAC_RECEIPT_MANIFEST_SHA256'
$kit = 'C:\sleight'
$manifestPath = Join-Path $kit 'guest-manifest.json'
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $manifestHash) { throw 'Manifest hash mismatch' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
if ($manifest.commit -ne $sha) { throw 'Kit commit mismatch' }
foreach ($file in $manifest.files) {
  $path = Join-Path $kit $file.path
  $item = Get-Item -LiteralPath $path -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -ne $file.bytes) { throw "Kit size mismatch: $($file.path)" }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Kit hash mismatch: $($file.path)" }
}
if (@(Get-ChildItem -LiteralPath $kit -Recurse -File -Force -ErrorAction Stop).Count -ne $manifest.files.Count + 1) { throw 'Unexpected kit files' }
```

Any copy or verification failure stops transfer. Retain the partial folder for inspection. On retry, rename that folder
with the preservation block above, then transfer into an absent destination. Use the guest account shown in the kit's Owner field or an elevated guest
account to rename a kit that was locked read-only. The partial folder is never reused. After the lock step,
Phase 0 preflight checks the same receipt pins and every file hash again, rejects missing or extra files, and must exit 0.

### Lock the kit folder

In guest PowerShell, check the new `C:\sleight` folder's owner first:

```powershell
(Get-Acl C:\sleight).Owner
```

If the owner is your account, run the lock commands below in a standard, unelevated shell. A folder created elevated
may be owned by the Administrators group (`BUILTIN\Administrators`). In that case the lock step must run in an elevated
PowerShell under the same Windows account. An unelevated token has that group deny-only and cannot change its ACL.
If the owner is neither your account nor Administrators, stop this part and retain the owner value. Do not take ownership.
After the lock step, use a standard, unelevated shell for preflight and every kit command.

```powershell
icacls C:\sleight /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(OI)(CI)F" '*S-1-5-32-545:(OI)(CI)RX'
if ($LASTEXITCODE -ne 0) { throw 'Kit folder lock failed; stop here' }
icacls C:\sleight\* /reset /T /C /Q
if ($LASTEXITCODE -ne 0) { throw 'Kit child ACL reset failed; stop here' }
```

This removes inherited write access for other users, which otherwise lets them replace helper sources and makes the
host's source guard refuse the build. The first command applies only to the root folder; the second resets children
to inherit its rules. Do not add `/T` to the first command: applying those rules directly to files left them without
usable entries in the 2026-10-31 guest sitting. Keep this order and substitute the new kit path for a later copy.
This lane did not test the unelevated path. sleight-arch ran the lock step once over SSH in an elevated session on
2026-10-31 with kit `7c1c6dd2`, and it worked. If either command is denied, retain the error and stop this part.

`/Q` still prints the `Successfully processed N files; Failed processing 0 files` summary. On 2026-10-31,
sleight-arch observed 1,630 and 1,629 files in two guest runs. Check that the printed `Failed processing` count is 0,
even if `$LASTEXITCODE` is 0. `/C` continues after errors, so the
exit code alone cannot prove that every child ACL was reset. The current user's SID avoids account-name lookup for
domain and Entra accounts. Preflight checks every native Windows source file as the backstop for a partial reset.

## Phase 0: preflight and inventory first

Use a standard, unelevated guest PowerShell in `C:\sleight`. Copy the commit and manifest SHA-256 from the independent
Mac receipt into the two variables. Keep this shell open for later phases. Use new result filenames on every attempt.
Commands returning nonzero stop their part. Retain the failure report before making a fix. Creating `vm-results` tolerates
an existing folder, but output files must still be new. After source or fixture bytes change, copy the pristine exported
kit into a new guest-local folder and run there. Keep the prior kit and reports. Change `Set-Location` and report names
for that attempt. An ACL-only lock step doesn't change file bytes, so re-preflight in the same folder is allowed with a new report name.

```powershell
Set-Location C:\sleight
$sha = 'REVIEWED_FULL_SHA'
$manifestHash = 'MAC_RECEIPT_MANIFEST_SHA256'
New-Item -ItemType Directory -Path vm-results -Force
node bench/windows/guest-preflight.mjs --expected-commit $sha --expected-manifest-sha256 $manifestHash --output vm-results/preflight.json
if ($LASTEXITCODE -ne 0) { throw 'Guest preflight failed; stop here' }
```

Preflight verifies every source/fixture hash and rejects missing/extra files. The guest requires the pinned commit,
Windows build 22000 or newer, native ARM64 Windows and Node 25.0.0 ARM64. It reports the Windows build/revision, Node version, UIA
availability and every kit file's SHA-256. It instantiates and releases UI Automation without reading a window.
Before that probe, it runs the kit's own `cache-access.ps1` source checks on the kit root, the
`plugins/sleight/lib/direct-browser/native/win` folder and every manifest file beneath it, all in one checker call.
`KIT_FOLDER_WRITABLE` has a fixed `reason`: `refused` means the checker exited 65 with a stderr line equal to
`HOST_CACHE_UNSAFE`, including when CLIXML progress surrounds it; `unproved`
means a timeout, spawn error or other unsuccessful or malformed reply. The mismatch line states the reason without child text.
Exit 0 with valid checker JSON passes the ACL checks even when stderr contains CLIXML progress.
The guest checker took 1,134 to 1,420 ms for 27 source checks. The revised preflight has 28 passing offline cases
but no VM receipt.
Only `refused` includes the owner check and both folder-lock commands. Follow the [lock step](#lock-the-kit-folder),
then rerun in place with a new report name. For `unproved`, retain the report and retry preflight with a new report name;
that result does not establish that a lock is needed. Stop this part if the checks still cannot be proved.
A mismatch exits 1, while a pass exits 0. Hash failure starts 0 PowerShell children. Results under `vm-results` are excluded
from later integrity checks. Source paths have no exemption. Re-preflight after source changes needs a pristine kit copy;
the lock step doesn't change file bytes and permits a rerun in place. Use a new report name on each attempt.

Both PowerShell children execute the verified script bytes through `-EncodedCommand`.
They don't change an execution-policy setting.
If organization policy blocks it, retain the failure and stop. Do not change WindowsApps ownership or run elevated.
The hashes detect changes relative to the independent receipt. They don't authenticate a receipt supplied by an attacker.

First run the no-pipe inventory (estimate: under 1 minute):

```powershell
node bench/windows/probe-engine.mjs --output vm-results/before.json
if ($LASTEXITCODE -ne 0) { throw 'Inventory failed' }
```

This compiles the probe's C# and runs its in-memory byte-counter selftest. A compile or selftest error needs a lane fix.
It inventories package/cache executable metadata, matching processes and up to 2,048 pipe names, without launching vendor
executables. Searches stop at 30,000 entries, 10 levels or 15 seconds between directory reads. An inaccessible or
truncated search leaves presence unknown. Reports contain no window content or screenshots.

The owner installs ChatGPT, signs in and enables guest Computer Use, then requests `12 × 12` in Calculator through that app.
The owner handles its approval and verifies `144`. Record the request and result, including errors and the app version.
Account/workspace availability also needs a record because installation alone does not establish access. Then run:

```powershell
node bench/windows/probe-engine.mjs --baseline vm-results/before.json --output vm-results/after.json
if ($LASTEXITCODE -ne 0) { throw 'After inventory failed' }
```

A new pipe/process is correlation. Stop any active engine task before selecting one exact observed local pipe name.
Connecting can consume a single-client server's slot briefly. Replace the placeholder only from the guest inventory:

```powershell
node bench/windows/probe-engine.mjs --pipe-name OBSERVED_PIPE_NAME --output vm-results/pipe.json
if ($LASTEXITCODE -ne 0) { throw 'Pipe probe failed' }
```

The probe opens read-only, records the connected server PID and reads at most 16,384 bytes for 1 second. It retains
shapes of at most 4 frames, with strings and unknown fields removed. Its measured `bytesWritten` must be 0. A silent or
client-first pipe leaves negotiation unknown. A connection proves neither original pipe creation nor an accepted engine
request. No guessed handshake, approval answer or credential is sent. Client-first negotiation needs another reviewed contract.

For an owner-run engine click, start the observer and wait for `Observer ready inside the guest` before the owner initiates
one Calculator click through ChatGPT (estimate: 30 seconds plus startup):

```powershell
node bench/windows/probe-engine.mjs --observe-seconds 30 --output vm-results/focus.json
if ($LASTEXITCODE -ne 0) { throw 'Focus observation failed' }
```

The observer samples foreground HWND/PID every 10 ms and uses a temporary mouse hook for click timestamps. It records no
keys, titles, screenshots or pointer coordinates. Check hook installation/removal, callback errors and interval coverage.
Injected flags do not identify the sender. Other clicks make attribution ambiguous. The normal-priority pump can add
about 10 ms to mouse events, with more delay under load; a hung observer can stall the guest mouse until hook timeout
or process exit. Covered, minimized and disconnected UTM behavior remains unmeasured.

RT31 moves Notepad's `TabState` and `WindowState` into `notepad-state-*` backups in the run bank before launch and
after close, with no Notepad process running, to prevent Windows 11 session restore from adding tabs. The saved state
is not restored to Notepad. Backups remain in the run bank for inspection. A setup backup failure stops launch.
After a confirmed close, a backup failure records `stateBackup=failed` while preserving the closed-fixture result.

## Phase 1: non-drawing host and offline checks

sleight-arch: list the 4 groups and 9 explicit test files without executing them (estimate: under 1 second):

```powershell
node bench/windows/run-checks.mjs --list
if ($LASTEXITCODE -ne 0) { throw 'Check inventory failed' }
```

The manifest selects Windows settings/startup, cursor transport, native host/gates/reference, and browser adapter tests.
Mac-specific platform and JXA suites are excluded. Build the host through the source/compiler/ACL receipt helper
(estimate: up to 5 minutes cold):

```powershell
node bench/windows/build-host.mjs --output vm-results/consent-host.exe
if ($LASTEXITCODE -ne 0) { throw 'Host build failed' }
```

The helper uses Windows' in-box Framework `csc.exe`, copies the receipt-verified binary into the guest-local results
folder and prints its SHA-256. It launches 0 hosts. Then run the selected tests and planner comparison
(estimate: 5 to 15 minutes; each test group has a 10-minute cap):

```powershell
node bench/windows/run-checks.mjs --host .\vm-results\consent-host.exe --timeout-ms 600000 --output vm-results/checks.json
if ($LASTEXITCODE -ne 0) { throw 'Offline checks failed or are incomplete' }
```

The 4 test groups run with a fresh `CLAUDE_CONFIG_DIR` per group, low priority and `--test-concurrency=1`. Native tests use validation,
dump or selftest modes without drawing. Missing suites, skipped/todo tests or a missing host produce exit 2. Failures
produce exit 1. Before any planner frames, the host must confirm non-drawing `--plan-dump` via `--capabilities`.
All 12 committed Swift cases compare every JSON key/value with numeric tolerance `0.000001`; a source-hash mismatch
stops before tests. Mac fixture regeneration is maintenance work after source review, outside the first guest sitting.

Timeout, output overflow or interruption collects the child's tree through fixed Windows taskkill arguments. If cleanup
reports `tree-unconfirmed`, stop further checks and resolve the guest child before retrying. Failed children retain a
redacted stderr tail capped at 512 UTF-8 bytes. Never overwrite a failed report or silently rerun a partial action.

## Phase 2: driver sitting and remaining checks

Follow [driver-sitting-runbook.md](driver-sitting-runbook.md) with the same verified kit and `$sha`. It supplies the
non-drawing build/selftest, dry plan, fixture server and commands for inventory, core actions, toolkit, captures, DPI and
safety. Each command has Mac mock coverage in `tests/windows-driver-sitting.test.mjs`. The owner prepares disposable
windows and their cover inside the guest. WDR5 safety wiring is integrated; a missing module leaves the safety phase
incomplete. Keep all refusals. Never add a foreground retry.

The longer qualification also needs real Claude Code plugin-loader checks, Windows Hello/password cancellation and
withdrawal, inherited ACLs and browser endpoint writes, clipboard isolation, non-ASCII paths/code pages, long cards at
100/125/150/200 percent scaling, capture exclusion, idle CPU and focus preservation. These are separate guest checks;
this sitting's offline pass cannot qualify them. Multi-monitor and negative-origin rows remain skipped if UTM cannot
expose the required monitor arrangement.

## Retain the evidence

Keep the independent export receipt, preflight, all JSON reports, compiler errors, image provenance, software versions
and the owner's observed Calculator result. Preserve every failed attempt and whether it needed a restart. Reports use
best-effort profile/username/machine redaction. Inspect custom paths, short aliases and pipe names before sharing.
No credentials, account identifiers or raw screenshots belong in published evidence. sleight-arch reviews and copies
accepted reports to the benchmark docs later. The owner saves guest work and shuts down Windows through its own menu.
The kit doesn't change Mac live-run markers or shut down the VM.

Probe reports scrub user and computer names of any length except beside another letter or digit, as in `bobcat` or
`Bob2`. Inspect pipe names before sharing. Only the exact older `%USERNAME%.windows-engine-probe/1` baseline schema
is repaired. Other schemas refuse.
