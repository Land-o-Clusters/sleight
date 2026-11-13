# Windows driver sitting

## UC3F Mac entry points

The UC3F collector uses separate owner-present and owner-away blocks. A real sitting requires the reviewed guest
collector and exporter with the file-request adapter, plus live validation beyond the offline tests.

The owner starts a present block by typing its command into a real local Terminal window on the Mac. Both stdin and
stdout must be TTYs. An agent shell, redirected command or SSH session cannot answer the guard's local prompts.
The owner types exact `go` before arming. The guard then runs alone, before any guest preflight, row or lease.
At its guard-check prompt, click into the pinned UTM window, move or resize it, return to the same Terminal and type
`go`. The sitting checks the guard before starting guest work. It expects capture, focus, pointer and geometry changes
in this present block. A different UTM window, VM title or UTM process still stops it, as do hold, live-lock changes,
unknown capture state and stale samples. Keep using the same VM window throughout the block.

For a separate guard-only check, add `--guard-only` to the present command below and use a new output path. It runs
0 rows and makes 0 guest calls. It closes the guard and releases its lock after confirmed shutdown. A normal present
block also runs this check first, then requires another `go` before each row.

From the reviewed checkout, replace the paths and VM id with the sitting's pinned inputs. Use new absolute output
paths. The tools directory must contain the reviewed guard executable. The SSH config and versioned VM record must
refer to the same guest.

Use a standalone SSH config with `Host vm`, its pinned `HostName` on `192.168.64.0/24`, and
`StrictHostKeyChecking yes`. The shared ledger config uses `accept-new`, which the sitting validator refuses with
`SSH_CONFIG_UNSAFE`. Copy it to the sitting's private input directory and change that copy to `yes` after verifying
the guest host key. Keep the existing identity and known-hosts file paths. Includes, proxy commands and forwarding
are refused.

```sshconfig
Host vm
  HostName 192.168.64.8
  User Sleight
  # IdentityFile /private/tmp/uc3f-input/REVIEWED-IDENTITY
  # UserKnownHostsFile /private/tmp/uc3f-input/REVIEWED-KNOWN-HOSTS
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 10
```

Replace the example address with the pinned address. Uncomment both file lines and substitute the reviewed paths.

After every VM pause or resume, compare the guest UTC clock with the Mac. Before the first guest preflight and lease,
the coordinator reads the guest clock over pinned SSH. The guest accepts only `0 < remaining <= 900000` ms.
For a full lease, `remaining = 900000 - offset - elapsed`, with offset measured as guest minus Mac time.
There is no guaranteed minimum elapsed time before admission, so even 1 ms behind can exceed the cap. An offset
of 900000 ms ahead can expire the lease immediately. The coordinator reserves the longest row's planned duration
from the row table (currently 120000 ms) within each 900000 ms lease. Export and cleanup need 45000 ms of their
60000 ms leases, so the stricter bound is currently `[0, 15000)` ms for the entire measured offset interval.
The interval is `[guest - received, guest - sent]`, which includes SSH connection and guard-check uncertainty.
An interval outside those bounds stops with `GUEST_CLOCK_SKEW`, the VM id, pinned host, signed offset and round trip.
A long round trip can cause a conservative refusal even with synchronized clocks. Later delays, clock drift
or a shorter lease can still expire an operation after preflight passes.

To correct the clock, use the VM's reviewed elevated SSH route from the Mac. Verify the VM id and pinned host in
the refusal before running the command. The normal sitting still uses its unelevated account. Replace the config
path below with the reviewed elevated route to that same VM. This reads Mac UTC with millisecond precision when run
and adds 10 seconds to allow for transfer:

```sh
ssh -F /private/tmp/uc3f-input/elevated-ssh_config -o HostName=192.168.64.8 -o BatchMode=yes -o StrictHostKeyChecking=yes vm "powershell -NoProfile -NonInteractive -Command \"Set-Date -Date ([DateTimeOffset]::Parse('$(node -p 'new Date(Date.now()+10000).toISOString()')').LocalDateTime)\""
```

Rerun preflight after the correction. Transfer time over 10 seconds can still leave the guest behind the lower bound;
the next measurement must pass. The coordinator never sets the clock or changes the lease rules.
The collector's restricted environment also reaches guest fixture children. Live startup with no USERPROFILE,
APPDATA, PATH or ComSpec remains unverified.

In the owner's Terminal:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/uc3f-sitting.mjs --owner-present --tools /private/tmp/uc3f-tools --ssh-config /private/tmp/uc3f-input/ssh_config --vm-id PINNED-VM-ID --vm-record /private/tmp/uc3f-input/vm.json --out /private/tmp/uc3f-present.json --evidence-out /private/tmp/uc3f-present-evidence.json --attestation-out /private/tmp/uc3f-present-attestation.json
```

The away block starts from sleight-arch's shell as before, after the owner confirms they are away. It retains the
background-only guard and faults on input capture, window movement, focus changes and hardware input. It has no local
`go` prompt. Use the same pinned inputs and different output files:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/uc3f-sitting.mjs --owner-away --tools /private/tmp/uc3f-tools --ssh-config /private/tmp/uc3f-input/ssh_config --vm-id PINNED-VM-ID --vm-record /private/tmp/uc3f-input/vm.json --out /private/tmp/uc3f-away.json --evidence-out /private/tmp/uc3f-away-evidence.json --attestation-out /private/tmp/uc3f-away-attestation.json
```

Present and away blocks stop after 60 and 150 minutes. Rows have leases of at most 15 minutes. Export receives a fresh
lease of at most 60 seconds within the block deadline. It authorizes only export, while cleanup uses a separate lease.
Status polling starts at most 1 SSH and guest PowerShell process every 2 seconds, with the final sleep and SSH timeout
bounded by the operation's remaining lease. The guard samples independently during each wait.

## Guest-local driver checks

Run this after [WIN0's engine probe](vm-runbook.md#phase-0-inventory-first), inside the guest-local checkout.
Complete the [kit folder lock](vm-runbook.md#lock-the-kit-folder) before preflight or the build phase.
The 2026-10-31 Windows VM sitting ran preflight and the non-drawing driver build/selftest on kit `7c1c6dd2`.
That receipt covers those phases only. All durations below are estimates. Keep the Mac's shared clipboard off.
Use a standard, unelevated PowerShell. The ordinary driver phases never launch an app, answer a card or change display settings.
The owner prepares disposable windows, then covers them. Each ordinary measured step runs WIN0's observer for 120 seconds.
Leave the cover in front and do not type or click until the command returns. The UC3F collector has separate fixtures,
an intervention observer and owner instructions for its present rows. Its requirements appear under safety checks below.

Use Node 25.0.0 in both VM runbooks. From the [official download page](https://nodejs.org/en/download), use the
[25.0.0 release](https://nodejs.org/en/blog/release/v25.0.0) and choose the
[Windows ARM64 MSI](https://nodejs.org/dist/v25.0.0/node-v25.0.0-arm64.msi). Save the matching
[SHASUMS256.txt](https://nodejs.org/dist/v25.0.0/SHASUMS256.txt) beside it. Before running the installer, compare SHA-256
in guest PowerShell from that download directory:

```powershell
$expected = ((Get-Content SHASUMS256.txt | Select-String '\s+node-v25.0.0-arm64.msi$').Line -split '\s+')[0]
if (-not $expected -or (Get-FileHash node-v25.0.0-arm64.msi -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node checksum mismatch' }
```

The owner handles installer and UAC prompts and declines optional native build tools. Confirm `node --version` is
`v25.0.0` and `node -p process.arch` is `arm64`. The kit adds 0 npm dependencies.

The JavaScript worker requires Node's `--allow-net` permission flag. Under older Node, the batch row skips with
`NODE_BATCH_UNSUPPORTED`, no worker starts, and core exits 2 for incomplete coverage. Other rows can still run.
Record Windows, UTM, Node and app versions separately. Copy only the reviewed checkout, without host credentials or `node_modules`.

## Plan, build and fixtures

Run from `C:\sleight`. Substitute the reviewed integration SHA for `REVIEWED_SHA` once, then keep that shell open.
The command refuses outside Windows and rejects an unproved VM before starting a driver. It reads the guest's
`Win32_ComputerSystem` manufacturer and model through a bounded, noninteractive PowerShell command. QEMU, VMware,
VirtualBox, Parallels and Microsoft's Virtual Machine are accepted. Unknown identities need review. This check
prevents accidental runs on a physical PC. A same-user process can forge its evidence, so it does not authenticate the VM.
Use a new JSON filename for every attempt. Exit 0 means the selected phase passed, 1 means a failure and 2 means
incomplete coverage. Expected DPI cells and Calculator editor skips do not block exit 0. Missing fixtures, an older
Node worker or a missing safety module still block it. Exit 1 also covers an invalid report retained for diagnosis.

1. Record the reviewed commit (under 1 second):

   ```powershell
   $sha = 'REVIEWED_SHA'
   ```

2. Check Node (under 1 second), using the version above:

   ```powershell
   node --version
   ```

3. Print every planned step without Windows commands or report writes (under 1 second):

   ```powershell
   node bench/windows/driver-sitting.mjs --dry-run
   ```

4. Create the report directory if WIN0 did not create it (under 1 second):

   ```powershell
   New-Item -ItemType Directory -Force vm-results
   ```

5. Compile through the existing source/compiler receipts and run the non-drawing `--driver-selftest` (up to 5 minutes
   for a cold build, about 10 seconds cached). A failure stops the phase and writes a failure row. No driver window opens:

   ```powershell
   node bench/windows/driver-sitting.mjs --phase build --revision $sha --output vm-results/driver-build.json
   ```

6. Copy the 40-line document into the disposable bank (under 1 second). The input tests replace its text:

   ```powershell
   Copy-Item bench/windows/fixtures/driver-notepad.txt vm-results/driver-notepad.txt
   ```

7. Open that copy (about 5 seconds). Put its caret at the end of its text before covering it. Also open a separate
   untitled Notepad window through File > New window. Keep the title `Untitled - Notepad`, and turn off Notepad
   session restoration and automatic tab naming for these disposable fixtures if they change the title. Never give
   this untitled buffer a filename. Save-dialog rows use only its separate HWND:

   ```powershell
   notepad.exe C:\sleight\vm-results\driver-notepad.txt
   ```

8. Open Calculator in Standard mode (about 5 seconds). Close other Calculator windows:

   ```powershell
   calc.exe
   ```

9. Start the WPF editor in another guest PowerShell (about 5 seconds). Keep its console open. It prints its decimal HWND.
   The editor receives focus once on opening. No keyboard focus is forced during the measurements:

   ```powershell
   powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File C:\sleight\bench\windows\fixtures\driver-wpf.ps1 -Mode editor
   ```

10. Serve the 500-control Edge fixture from another guest PowerShell (under 2 seconds to start). This server binds loopback
    only. Leave the console open; Ctrl+C in that console stops the server after the sitting:

    ```powershell
    node bench/windows/driver-fixture-server.mjs
    ```

11. Open the disposable page in Edge (about 5 seconds), then click its WDR7 editor once before covering it:

    ```powershell
    Start-Process msedge.exe '--inprivate --new-window http://127.0.0.1:9167/'
    ```

12. Start the cover in another guest PowerShell (about 5 seconds). It prints its decimal HWND. Move the targets onto the
    same monitor first. The cover is topmost, with 75 percent of the primary work area width and 96 percent of its height.
    Put guest consoles in the free right quarter, and every target fully inside the covered left area. Resize targets
    to fit before starting. Keep this same cover window open across phases. Move or resize it between phases if needed,
    then click it during each command delay so it remains foreground throughout observation:

    ```powershell
    powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File C:\sleight\bench\windows\fixtures\driver-wpf.ps1 -Mode cover
    ```

13. Discover fixture HWNDs (about 5 seconds). JSON contains only fixed target aliases, HWNDs and PIDs. It omits unrelated
    windows. Run this from the measuring PowerShell, then click the cover before each measured command starts:

    ```powershell
    node bench/windows/driver-sitting.mjs --phase inventory --revision $sha --output vm-results/driver-inventory.json
    ```

Read `discovery` from that file in the guest. Replace `NP`, `UNTITLED`, `CALC`, `EDGE`, `WPF` and `COVER` below with the decimal HWNDs.
Print it in the guest console (under 1 second):

```powershell
Get-Content vm-results/driver-inventory.json
```

Use an owner-controlled delayed command when returning focus to the cover. This gives 10 seconds to click it before the
observer starts. HWNDs can change when an app restarts. Repeat discovery after restarting a fixture. Never guess a handle.
`UNTITLED` is the separate `notepad-untitled` entry. The runner checks the `driver-notepad.txt` filename,
the untitled buffer's title, Edge's fixture title, WPF's title and the target executable before input.

## Core, toolkit and capture numbers

Keep 100 percent scaling for the first run. The driver checks the observed DPI and covered geometry before each trial.
The core phase has 11 steps, each with up to 20 trials and a 120-second observation window (about 22 minutes, plus observer
startup). The driver warms up before observation, so compile and driver startup are excluded from API percentiles.
New requests stop at the observation budget. Reads require all 40 Notepad line markers and at least 500 Edge tree lines.
Run phases in this order: core, toolkit, capture, DPI, safety. Before a repeated core attempt, close the `driver-notepad.txt` window
without saving, copy the source fixture again, reopen it, and repeat inventory into a new filename. Update `NP`
and any restarted fixture's HWND. The harness never restores or closes the owner's windows.

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase core --revision $sha --notepad NP --notepad-untitled UNTITLED --calculator CALC --edge EDGE --cover COVER --output vm-results/driver-core.json
```

Calculator runs Clear, then Invoke on 7, +, 5 and =. Each action uses the new map returned by the last action.
`12` must appear on the CalculatorResults row, rather than elsewhere in the tree. Notepad receives 200 characters through
Value and 40 through typing at the existing caret, with a reread for each. The Return row checks spacing before the typed
marker in flattened UIA text. Line breaks and spaces have the same representation in that format. The owner must inspect the first
real Return result before claiming line-break correctness.
Calculator's menu must appear before Escape changes the tree. Ctrl+S must produce a same-process dialog for the
`save-notepad` row to pass. Both Win32 chord rows first seed the untitled buffer, then press Ctrl+S and dismiss the
dialog with Escape. They refuse a named buffer before input, so they cannot save over the fixture copy.
A printable chord without an accelerator can refuse with `CHORD_NEEDS_FOREGROUND`. Keep that result. Never add a foreground
retry. Save effects without a dialog are unverified.

The batch row times one warm Windows JavaScript worker call with four actions, including IPC, action settle and result
items. Acquiring its fixture handle and clearing Calculator happen before the batch clock. It does not time a model or
full MCP relay call. A worker error stops that step. The runner does not bypass the worker's Node permission requirements.

The toolkit phase has 12 rows across 4 toolkits. It tests Value, WM_CHAR and Ctrl+S in Win32 Notepad, WinUI Calculator,
the WPF fixture and Chromium Edge (about 18 minutes, plus observer startup). Calculator's 3 editor rows skip as expected.
9 rows with 20 passes each and 3 expected skips exit 0 when their focus checks pass.
Refocus the three disposable editors before
covering them. Its WM_CHAR row checks the 40 inserted characters. The row requires a WM_CHAR or WM_UNICHAR route.
Chords pass only when a fixture's observable result changes. WPF and Edge use `Chord: saved` markers. Their handlers
read thread modifier state, which posted key messages may leave unchanged. A failed chord can come from
the fixture's modifier check. Retain its route and failure without attributing it to the driver until a real VM check.
Missing UIA ids, refusals and unsupported patterns are recorded. The owner retains control of foreground input.

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase toolkit --revision $sha --notepad NP --notepad-untitled UNTITLED --calculator CALC --edge EDGE --wpf WPF --cover COVER --output vm-results/driver-toolkits.json
```

Capture each covered target at two sizes relative to the guest's actual monitor (about 6 minutes per size plus startup).
Use `--size compact` for client dimensions around 35 percent of monitor width and height, then `--size large` for around
65 percent. These are size labels, with no exact pixel requirement. Leave the right quarter for consoles and fit all
targets under the cover. Borders and taskbars reduce the available area. Resize the cover between phases if needed,
keeping the same HWND. Each trial records the real client width and height, containing monitor width and height, and
`displayWidthFraction` and `displayHeightFraction`. Compare timing using those measured sizes. A missing containing
monitor fails the sample. The runner never changes display settings or resizes a window.
The kit checks PrintWindow's nonblack status, PNG signature and dimensions, then discards the PNG bytes.
Visual rendering correctness still needs the owner's inspection in a separate reviewed capture session.

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase capture --revision $sha --notepad NP --calculator CALC --edge EDGE --cover COVER --size compact --output vm-results/driver-capture-compact.json
```

After resizing all three targets:

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase capture --revision $sha --notepad NP --calculator CALC --edge EDGE --cover COVER --size large --output vm-results/driver-capture-large.json
```

## DPI and negative-origin matrix

The owner sets Windows display scaling and monitor placement, then reruns the WPF fixture if Windows requires it.
The runner reads the resulting geometry. Standard-origin rows require a nonnegative client origin. Negative-origin
rows require both a negative client origin and a monitor with a negative left or top coordinate. If UTM cannot expose a
second monitor, leave the 4 negative-origin rows skipped and record that limit. Do not claim mixed-monitor qualification.
Each command runs one 20-trial cell (about 2 minutes plus startup). The other 7 cells stay skipped as expected in that
report. A selected cell with 20 passes and a passed focus check exits 0. A missing selected fixture still exits 2.
The runner clicks a physical point inside WPF's Invoke button and verifies its invocation counter changes.
Refresh WPF and cover HWNDs after any fixture restart.

At 100 percent scaling:

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 100 --origin standard --output vm-results/driver-dpi-100.json
```

At 125 percent:

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 125 --origin standard --output vm-results/driver-dpi-125.json
```

At 150 percent:

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 150 --origin standard --output vm-results/driver-dpi-150.json
```

At 200 percent:

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 200 --origin standard --output vm-results/driver-dpi-200.json
```

Move WPF and its cover to the negative-origin monitor, then repeat at each scale:

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 100 --origin negative --output vm-results/driver-dpi-100-negative.json
```

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 125 --origin negative --output vm-results/driver-dpi-125-negative.json
```

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 150 --origin negative --output vm-results/driver-dpi-150-negative.json
```

```powershell
Start-Sleep -Seconds 10; node bench/windows/driver-sitting.mjs --phase dpi --revision $sha --wpf WPF --cover COVER --dpi 200 --origin negative --output vm-results/driver-dpi-200-negative.json
```

## Safety refusal checks

### UC3F acceptance plan and owner presence

These 19 rows are acceptance targets, with 47 cases and 2,201 required observations. They are unmeasured by this lane.
The existing 3 parent refusal rows remain separate. Complete safety qualification needs all 22 rows; `--runs` never
reduces the UC3F counts. This sitting measures the time for each checkpoint with every safety check active. Cost is measurement-only, so it
cannot claim complete safety qualification. Keep every failed attempt.

Follow the [VM runbook's sitting gates](vm-runbook.md#before-the-sitting). Check that `/tmp/sleight-hold` is absent
before each phase and use only the quiet window agreed by sleight-arch and Puddle. Get explicit permission from a
present owner for visible steps. For an away sitting, wait for the owner's explicit owner-away instruction. Pause guest
driving if the hold appears, the quiet window ends or the owner returns during an away sitting.

"Present" means the owner watches and acts only in the Windows guest when instructed. The Mac terminal prints one
instruction at a time and waits for the owner's typed `go`. The collector never answers UAC, unlocks, logs on or
switches back for the owner. Keep all four lock, screensaver and session-switch rows in the present sitting, including
screensavers that do not require sign-in on resume.

Only Calculator's packaged-window layout was measured in the guest. Settings and Photos are expected to use the same
layout, but have not been measured. Frame windows, CoreWindow windows and other surfaces of a hosted process refuse.
Ordinary Win32 windows can also refuse. Native C# changes require compilation and execution in the Windows guest;
the Mac integration tests execute translated production logic and source checks. Before the next sitting, measure
getState on a desktop with many windows and a 64-unit typing run. In the guest self-test, also measure Record:
it calls IsChild once per tracked root (up to 4,096) for every system-wide window event, on the pump thread
under the epoch lock. Reorder events can be frequent. Its Windows cost is unmeasured. The former hosted-process lookup was quadratic in
the window count and allocated a 64 KB executable-name buffer per lookup. The current lazy cache shares one hosted-process scan across a whole inventory
and both metadata reads within an observation. Both metadata reads reuse that snapshot. Its Windows cost and false-refusal rate remain unmeasured.

If Calculator ownership validation throws during polling, the harness instance can remain open and unregistered.
Close that instance before retrying. The next launch refuses while CalculatorApp.exe is running.

The read-only lifetime proof cannot distinguish same-thread HWND reuse with identical sampled fields when the lifecycle
event has not been delivered before the fence. A root that exceeds 4,096 retained members refuses with TARGET_UNAVAILABLE until its
destruction or release. Other roots keep working. A virtual desktop switch revokes the binding. Approval is app-wide,
so an explicit HWND can select another window of the approved app. Native C# compilation and execution require the
Windows guest. The false-refusal rate, event-fence completeness and lifetime-check cost remain unmeasured.

| Row | Owner presence | Required VM evidence and pass rule |
| --- | --- | --- |
| person-idle | Owner present for background-word; away for idle trials | 50 Notepad and 50 WPF receiver actions, each delivered with unchanged GetLastInputInfo and 0 refusals. Also 10 activated Calculator reads must return HOSTED_APP_UNRESOLVED before input. Then 20 passing background Notepad actions while the owner types in a disposable Word document. |
| person-key-before | Away | 20 scheduled SendInput keys, measured 50 to 150 ms before foreground Notepad typing. PERSON_TOOK_OVER, person-active, not-sent/safe, 0 posts and pattern calls. |
| person-key-during | Away | 10 scheduled-input trials during 3,000-unit typing. PERSON_TOOK_OVER, typed from 1 through 2,999, sent-unverified/read-first, key-ups delivered and 0 posts after stop. |
| lock-refused | Owner present to unlock | 10 reads, 10 captures and 10 actions while locked: SCREEN_LOCKED, session-locked, 0 UIA fetches, captures and posts. Also 50 passing unlocked actions, 1,000 successful WTS queries, flags 0 locked and 1 unlocked, and a passing first request after unlock. |
| lock-during-type | Owner present to unlock | 10 locks during 3,000-unit typing. SCREEN_LOCKED, typed from 1 through 2,999, sent-unverified/read-first, key-ups delivered, 0 posts after stop and 0 final reads. |
| screensaver-refused | Owner present to resume | 5 Screen-saver trials. SCREEN_LOCKED, screensaver, 0 reads, captures and input. The owner handles any sign-in on resume. |
| session-switch-refused | Owner present to switch back | 5 switches. SCREEN_LOCKED, session-disconnected, 0 reads, captures and input. The first request after return passes without restarting the driver. |
| uac-refused | Owner present to answer UAC | 10 owner-triggered secure prompts. First call: SECURE_DESKTOP_ACTIVE, secure-desktop, 0 input while up. Also 100 idle probes and 50 actions with 0 false secure refusals. |
| uac-hint | Owner present to answer UAC | 10 prompt-raising actions. cap, budget or deadline reply includes secure-desktop-seen, 0 stacked prompts, first call after the owner answers passes without another prompt. |
| escape-stop-hardware | Owner present for owner-keyboard | 10 physical Escapes during 4,000-unit typing with UTM focused. Both injected flags false, 0 injector entries in the trial window. USER_STOPPED, escape, typed from 1 through 3,999, stop below 250 ms from hook event to reply, cleanup complete, Escape reaches the fixture. Next action refuses before input. |
| escape-ignored-injected | Away | 10 scheduled SendInput Escapes with an injected hook flag, none stopping input through the Escape hook. PERSON_TOOK_OVER may independently stop input. |
| escape-ignored-posted | Away | 10 posted stuck-menu Escapes keep hookEvents and escapeStops at 0. |
| cancel-frame | Away | 10 parent cancel frames during typing, 5 per reply order. Flag below 300 ms after write, USER_STOPPED/cancel, typed from 1 through 2,999, job and acknowledgment ids match their own replies, cleanup complete. |
| direct-launch-terminal | Away | 10 terminal and 10 terminal-settings requests on each of the scheduled direct and parent paths. FORBIDDEN_TARGET or FORBIDDEN_SETTINGS respectively, 0 UIA fetches. Direct launch uses a fresh nonce. |
| direct-launch-override | Away; reviewed spawn override only | 10 terminal reads pass on each path with the owner's spawn-environment override. 10 settings requests on each path still return FORBIDDEN_SETTINGS, 0 UIA fetches. |
| browser-refused-edge | Away | 10 name and 10 HWND refusals: BROWSER_TARGET_REFUSED, 0 cards, leases and content reads. Also 50 acquisitions of Notepad and 100 of WPF, 0 false refusals. |
| browser-refused-firefox | Away; owner installs Firefox first | 10 name and 10 HWND refusals: BROWSER_TARGET_REFUSED, 0 cards, leases and content reads. |
| browser-refused-renamed | Away | 10 renamed Edge refusals: BROWSER_TARGET_REFUSED, 0 cards, leases and content reads. The collector creates the msedge.exe copy in its bank, preserves OriginalFilename and ProductName, then deletes that copy. |
| checkpoint-cost | Away; measurement only | 50 samples each for session-probe, lock-check, desktop-check, person-input, budget-check, hook-install and hook-remove. 100 hook-callback samples use own time before the next hook. Every safety check is active. Keyboard latency is not measured. |

Run `person-idle` first: its idle cases test whether the driver's own posts leave GetLastInputInfo unchanged.
Its 20 `background-word` observations require real owner typing. Do not substitute a scheduled key or mark that case
away. The collector splits the row between the away and present plans. A row passes only after all its cases have
observations. The guest must own the disposable Word
fixture too. The owner's existing document is outside the fixture set.

For all 9 no-false-refusal cases, `effectObserved: true` requires the intended fixture postcondition, a successful
session probe or the requested window identity after acquisition. The Word case needs the Notepad effect while the
owner types in Word. A transport reply or 0 refusals alone cannot prove that flag. Keep fixture text and pixels in
the guest, outside the evidence bundle.

### Collect and grade UC3F observations

Collection requires UC3F's native checkpoints, hook, cancel and refusal changes, plus the UC3G observer, injector,
guest runner, exporter and Mac coordinator, merged into one reviewed kit and compiled in the guest. UC3E's grader
alone supplies no observations. The ordinary cover observer rejects deliberate input and focus changes, so it
cannot replace `uc3f-observer.ps1` on intervention rows. The core Edge read and capture rows remain separate
native measurements from the new browser admission refusals.

Keep the shared clipboard off. The Mac coordinator uses SSH and SCP through the reviewed `vm` alias, whose address
must be in `192.168.64.0/24`. It checks the recorded `--vm-id`, guest manufacturer, hostname hash and MachineGuid
hash before collection. Every guest task must run in an interactive, unelevated session. Never supply a different
host or use QEMU key injection, Apple events, UTM input commands or a Mac screenshot as a fallback.

From the reviewed Mac checkout, print both collector plans before choosing rows:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/uc3f-sitting.mjs --dry-run --owner-away
```

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/uc3f-sitting.mjs --dry-run --owner-present
```

The dry plan must start 0 processes and write 0 files. Check the selected row ids, cases and presence before a live
invocation. Select exactly one of `--owner-away` or `--owner-present`, including on dry runs. The away plan has 12 row
entries, including the skipped cost row and only the Notepad and Calculator cases of `person-idle`. The present plan
has 8 entries, the 7 present rows plus `person-idle`'s `background-word` case. Both plans together cover 19 unique
rows. `--rows` accepts a comma-separated subset within the chosen presence mode. A present-only row must refuse
`--owner-away`. Allow about 2 hours away and 45 minutes present, estimates rather than measured durations.

The draft coordinator still needs a reviewed guest adapter for `sleight.uc3f-transport/1`. The unchanged RT31
transport lacks that protocol and refuses with `UC3F_TRANSPORT_PROTOCOL_REQUIRED`. Present mode also needs a guard
that permits the expected input inside UTM and terminal prompts that read `go`. Without that guard it refuses
`UC3F_PRESENT_GUARD_REQUIRED`. Do not bypass either refusal. The following live invocation templates require those
integration changes and the owner's sitting in the agreed quiet window. They have not been run on Windows.

Replace `SSH_CONFIG`, `VM_ID`, `VM_RECORD_JSON` and `GUARD_TOOLS` with the reviewed files and identity. The VM record
contains vmId, QEMU manufacturer, model, Windows build, hostnameSha256 and machineGuidSha256. Prepare a fresh output
directory first and keep each block's 3 output paths distinct. Run the away block only after the owner says they
are away:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/uc3f-sitting.mjs --owner-away --ssh-config SSH_CONFIG --vm-id VM_ID --vm-record VM_RECORD_JSON --tools GUARD_TOOLS --out vm-results/uc3f-away.json --evidence-out vm-results/uc3f-away-observations.json --attestation-out vm-results/uc3f-away-observations.attestation.json
```

Run the present block with the owner watching. Its terminal instructions must ask for `go` before each row:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/uc3f-sitting.mjs --owner-present --ssh-config SSH_CONFIG --vm-id VM_ID --vm-record VM_RECORD_JSON --tools GUARD_TOOLS --out vm-results/uc3f-present.json --evidence-out vm-results/uc3f-present-observations.json --attestation-out vm-results/uc3f-present-observations.attestation.json
```

Retain both blocks' evidence and sidecars. The reviewed exporter must combine the observations from both blocks
before `person-idle` can pass with all 3 cases. Never overwrite one block with the other or hand-edit a bundle to
combine them. An orchestration report's `completed` field means collection and cleanup finished for that selection.
It does not qualify all 19 rows, and the skipped cost row still prevents full qualification.

The coordinator holds the live lock and checks the hold before every row and transport call. The owner's Mac input
stops away work. The coordinator writes a lease expiring in 15 minutes before each guest row. An expired lease, an unowned PID
or process start time, or a desktop other than Default refuses guest injection. The present sitting's expected
keyboard input happens inside UTM, never through a Mac-side input helper. No row sets `SLEIGHT_DRIVE_LOCKED`.

Only the test driver's spawn environment enables `SLEIGHT_DRIVER_COUNTERS=1`. Retain postedMessages, patternCalls,
uiaFetches, captures and finalReads from the driver, and message and key-state observations from the fixtures.
Fixture message counts cannot prove 0 UIA reads or captures. Missing native counters leave those claims unmeasured.

The guest runner writes `raw/<request>.<row>.<row>[-away|-present].jsonl` under its fresh
`C:\sleight-setup\uc3f-<16 hex>` bank. Keep all request-scoped logs. Repeated cases are rejected during export,
so a later passing attempt cannot replace an earlier failure. Join driver replies,
native counters, fixture counts, observer events and injector ticks. The observer records Escape or other key kinds,
raw injected flags, foreground identity, last-input ticks, WTS state and input-desktop names, without characters,
titles or pixels. The exporter derives Escape source from those flags and the injection log. An unflagged Escape
within 2 seconds of an injection is `INJECTION_UNATTRIBUTED`, never hardware evidence. A planned hardware row alone
cannot establish `source: owner-keyboard`.
Mouse summaries record publication time in `tickMs` and event time in `firstTickMs` and `lastTickMs`.
Any overlap with a trial counts the full `eventCount`, including a summary that crosses either trial boundary.
Key records use their event clocks, with DWORD wrap resolved against publication time.

Stop after an uncertain action and read the disposable target before preparing another trial. Cleanup must unregister
and verify every scheduled task, confirm `hookRemoved: true`, close only owned fixtures through WindowPattern.Close
and their Don't Save response, and leave the guest unlocked and connected. Copy the bundle and its sidecar before
deleting the owned renamed executable and bank. The final `cleanup-check` must find 0 `sleight-uc3f-*` tasks,
0 fixture PIDs and 0 bank files. Retain a cleanup failure as a failure. Never sweep unrelated files or processes.

### Grade the bundle and attestation together

`uc3f-export.mjs` writes `uc3f-observations.json` with exactly `schema`, `revision` and `rows`, using schema
`sleight.windows-uc3f-evidence/1`. Each row has `id` and `evidence.cases`. Each case has its fixed id and samples.
`UC3F_ROWS` in `driver-sitting.mjs` defines the required counts and fields. Unknown keys, titles, trees, paths, images
and raw child output cannot become evidence. The reader rejects duplicate or unknown rows, revision mismatches,
symlinks, nonregular files and bundles over 1 MiB. Missing samples never become passing samples.

The sidecar `uc3f-observations.attestation.json` binds the bundle SHA-256 and revision to the kit manifest hash,
exporter and observer hashes from `guest-manifest.json`, VM manufacturer, model and build, hashed hostname and
MachineGuid, Windows user SID hash and export time. Always pass `--safety-attestation` with `--safety-evidence`.
A missing sidecar, hash mismatch or identity mismatch must produce `UC3F_EVIDENCE_INVALID` for all 19 imported rows.
Attestation is not authentication: a process running as the same Windows user can regenerate both files. These
checks catch accidental edits and mixed kits. They don't independently prove hardware origin or protect against
a malicious same-user process.

Report redaction can invalidate fixed vocabulary that matches the Windows username. Diagnose that collision before
publication. The 46-command shell-guard comparison belongs to Lane C, outside these sitting rows. The planned
120-second UC3F durations and aggregate zero-duration percentiles are placeholders, never measured action costs.

After the collector and attestation reader are integrated, grade the copied pair in the guest alongside the original
3 refusal fixtures. Set `$sha`, `NP`, `WT`, `ENP` and `ENP_PID` as described in this runbook, and use a new output file:

```powershell
node bench/windows/driver-sitting.mjs --phase safety --revision $sha --notepad NP --terminal WT --elevated ENP --elevated-pid ENP_PID --safety-evidence vm-results/uc3f-observations.json --safety-attestation vm-results/uc3f-observations.attestation.json --output vm-results/driver-safety-uc3f.json
```

Grading doesn't start an intervention. The 3 original admission checks still query their fixtures. Each UC3F row has
1 aggregate trial retaining the case observations, with elapsedMs 0 because importing does not time a Windows action.
All 19 aggregates and all 3 admission rows must pass for qualification. Missing evidence or the skipped cost row
keeps coverage incomplete (exit 2). An unsafe observation fails (exit 1). Report validation regrades the observations.

The exporter reports the 18 safety rows' pass, fail and skip counts separately from cost samples.
Even with all 18 passing, the safety phase ends `incomplete` (exit 2) while cost is unmeasured.
With 0 cost samples the note is `not measured: no timing producer`. Without a native timing producer, the collector
records unavailable trials before creating a driver, calling `getAXState` or sending input.
Supplied timing samples remain unqualified with `bounds not registered` and cannot make this sitting pass.

The cost row reports each checkpoint's own native clock with every safety check active. It never disables a
check to build a baseline and never qualifies cost. Keyboard latency is not measured in this sitting.
The collector enables the private timing producer only for this row, runs one driving turn per trial, and reads
install from the action and remove from the end reply. Callback time comes from `hookOwnCallbacks`, before
`CallNextHookEx`. Each trial selects at most one sample. The 65,536-entry worker bank resets per action.
the 256-entry lifecycle bank resets per turn. A saturated bank records omitted counts. Telemetry is omitted when
it would push the serialized result above 4 MiB, preserving headroom below the 8 MiB reply cap. Missing samples
are unavailable. The pure C# timing fixture must pass on Windows before the sitting counts a native sample.

### Original parent refusal checks

Allow about 1 minute after fixture preparation. The integrated `windows-driver/safety.mjs` runs all 3 refusal rows
through the parent admission dispatcher, with a programmed Decline decision. Each row calls `getApp` and must refuse
before a content request or lease acquisition, without showing or validating a consent card.
A missing safety module still produces 3 skips and incomplete coverage (exit 2), so it cannot qualify the safety phase.

Open Windows Terminal manually. Use the owner's Windows UI to launch an elevated disposable Notepad and handle UAC.
Never run the kit elevated. Rerun discovery into a new inventory report. Match `elevated-candidate`'s PID to the elevated
fixture in Task Manager before using its HWND. An unrelated elevated app must not be substituted. Replace `WT` and `ENP`
with those HWNDs, and `ENP_PID` with that exact PID, using the ordinary fixture Notepad HWND for `NP`. The runner
requires the elevated record to match the supplied PID. It also checks its own integrity before running any phase and
refuses elevated or unproved tokens:

```powershell
node bench/windows/driver-sitting.mjs --phase safety --revision $sha --notepad NP --terminal WT --elevated ENP --elevated-pid ENP_PID --output vm-results/driver-safety.json
```

The expected codes are `APP_DECLINED`, `FORBIDDEN_TARGET` and `ELEVATED_TARGET`, with 0 content requests for every row.
The decline row needs exactly 1 approval callback. The other two need 0. A different code fails, with no fallback.
Card UI, session approval memory, cross-session leases and the full relay still need separate Windows qualification.

## Read and retain the results

`validateResult` in `driver-sitting.mjs` is authoritative, including summary recomputation and focus checks.
[driver-sitting.schema.json](driver-sitting.schema.json) describes the fields, with schema id
`sleight.windows-driver-sitting/1`. `summary.pass`, `fail` and `skip` count trial outcomes.
`p50Ms` and `p90Ms` use nearest-rank percentiles of API call durations, including failed calls when measured.
`passP50Ms` and `passP90Ms` include passing calls only. The console summary prints `focusStatus` beside the counts.
Counts alone do not prove focus passed. `wallP50Ms` and `wallP90Ms` include fixture verification and preparation. `settleP50Ms` and `settleP90Ms` summarize
individual action settle durations from `settleTimings`. Each trial also records their sum as `settleMs`, their count as
`settleSamples` and their modes in `settleModes`. The Calculator Invoke row includes Clear in its settle total.
Its batch time excludes Clear. The js batch's settle total covers its 4 actions. Null means no measurement.
Failed requests without an API timing use the trial wall duration.
Mac reference times are 48 ms idle read, 416 ms post-input read and 72 ms warm write. The Notepad and Calculator read
p50 target is under 300 ms. The printed summary computes `readP50Under300Ms` from passing calls for these 2 rows.
These references and targets are not Windows results.

An ordinary measured row needs 20 passes, 0 failures and 0 skips, plus a passed focus observation, before calling its 20 trials complete.
The observer must report that its hook was installed and removed, with 0 callback errors and no truncation.
The cover HWND must be foreground at the start. The observer must log 0 transitions and 0 clicks.
Its interval must contain every trial. A focus failure stops later rows.
Read each result file from the visible console after the phase. Clicking that console is safe after the command returns.
Click the still-open cover again during the next command delay. Ctrl+C from the console interrupts a running phase and
invalidates its focus evidence.
A partial action is never retried automatically. Preserve the JSON from every failed attempt. `passed-phase` qualifies only
that phase and its selected configuration. `--runs` below 20 is diagnostic only. The full DPI matrix needs 8 reports.

The report writer uses WIN0's existing redaction for profile paths, the username and the machine name. Its data projection
excludes trees, window titles, arbitrary inventory strings, screenshot bytes and raw child output. Review the JSON before
sharing. A validator failure writes the projected, redacted measurements to the requested file with `verdict: invalid`,
then exits 1. Keep that file for diagnosis. Its fields may fail the schema. Raw validator error text is excluded.
Retain all reports with the integration SHA and separately recorded software versions, then copy the reviewed
reports to `docs/benchmarks/` through the integration owner. Do not publish a synthesized Mac result as a VM sitting.
Close the ordinary sitting's disposable windows and stop the fixture server from its own console after saving the reports.
Those phases never close another process or change Mac live-run markers. The UC3F collector separately verifies cleanup
of the fixtures and tasks it owns.
