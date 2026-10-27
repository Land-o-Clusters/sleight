# Cursor desktop benchmark arm

Use the owner's installed `/Applications/Cursor.app` and existing Cursor login. The arm checks
its signed bundle against the recorded pin, reads its bundle identifier from `Info.plist`, and
binds the running process by PID, executable and launch time. Cursor must already be running.
The arm attaches through Accessibility. Cursor and its helper remain running, with every
window and chat left open.

Every live entry requires `--owner-says-cursor-free`. The owner passes this flag only after
freeing Cursor for the run. Native and browser fixtures also require `--owner-away` and the
usual live lock and hold checks. Dry runs print the plan without either flag or a host process.
The queue passes the explicit flag to each child. Without the flag, it refuses to start.
The flag also gates login metadata reads, including `setup.mjs --readiness` and
`login-readiness.mjs --arm cursor-cu`. It has no expiry. Obtain it for each attended sitting.

## Calibration

With the owner present and Cursor free:

```sh
node bench/world/arms/cursor-cu/calibrate.mjs --dry-run
node bench/world/arms/cursor-cu/calibrate.mjs --owner-says-cursor-free
```

The read-only admission checks stored authentication presence and visible signed-in controls.
Sign-in screens and busy chats stop admission, but stored authentication alone cannot prove
the session is valid. Expired sessions can still fail when submitting a turn.

The harness journals the current model, effort, speed, Computer Use attachment and target
before opening a new chat in the bound window. In that chat the owner chooses Computer Use,
This Mac, Grok 4.7 High, high effort and normal speed, then submits `Say ready.`. Once the turn
settles, the harness saves the model ID, selection markers and scrubbed field shapes under
`~/Library/Caches/sleight-bench/cursor-cu-arm/desktop/calibration.json`. It restores the saved
selections through the UI. Calibration refuses an existing file. Version 2 records the
owner-installed session contract and rejects older copy-based calibration records.

Accessibility must expose unique selection controls and their current values. The adapter
recognizes `Select model`, `Reasoning effort`, `Speed`, `Computer Use` and `Computer Use target`.
The new chat must expose its persisted composer ID as a unique Accessibility identifier
(the ID itself or `composer-` followed by the ID). Every later UI call rechecks that binding.
An absent or ambiguous control or chat binding stops admission or setup. These labels and the persisted
selection schema still need supervised validation against the installed build. The arm does
not enable Computer Use, install a helper, grant system permissions or start a login flow.
Selection controls, New Chat, Send and Stop must be inside the identified chat container.
The new chat must have no persisted conversation, generation or input draft before use.

Chromium web Accessibility is enabled only after its prior `AXManualAccessibility` boolean
has been journaled. Cleanup restores and reads back that value, including when setup fails.
An unreadable prior value refuses attachment. Permission-card reads never enable it themselves.

## Runs and restoration

```sh
node bench/world/arms/cursor-cu/probe.mjs --dry-run
node bench/world/arms/cursor-cu/probe.mjs --owner-away --owner-says-cursor-free --out /absolute/new/probe.json
```

Each task saves the owner's selection before opening a new chat. The run uses Grok 4.7 High
with high effort, normal speed and Computer Use on This Mac. Its persisted selection is checked
before submit.
Before opening the chat it reads only composer IDs. Afterwards it reads only that chat's
composer and bubbles. It records submit to persisted `clientSettleTime` as agent time.
Every persisted tool row must identify Computer Use. An edit, shell command, workspace tool
or unknown tool stops the run through that chat's Stop control and records a safety stop.
The check runs before app approvals and before accepting a completed answer. Polling cannot
prevent a tool from starting before its row becomes visible in SQLite.

Success, failure and SIGINT all restore and verify the saved selection. An interrupted turn
is cancelled through the bound chat's Stop control. A failed restoration or unproved
cancellation marks cleanup unconfirmed and retains the enclosing run's live lock. Cursor and
the benchmark chat remain open. Review an unconfirmed cleanup before another run.

The journal is `owner-selection-journal.json` under the arm's private state folder, with mode
0600 in a folder with mode 0700. It contains selection labels, process and chat bindings, and
the prior Accessibility value. It contains no chat text. Writes are synced before mutations.
A crash leaves the journal in place and every new start refuses before host access.
Cleanup removes it only after selection and Accessibility restoration have both been verified
and cancellation is confirmed.

After verifying that the old harness has stopped, with the owner present and Cursor free:

```sh
node bench/world/arms/cursor-cu/recover.mjs --owner-says-cursor-free --previous-run-stopped
```

Recovery requires the recorded Cursor launch and chat. It cancels a generating run chat,
restores the journaled state and verifies it before removing the journal. A changed launch,
missing chat or failed restore keeps the journal. Recovery leaves the enclosing live lock
unchanged for operator review.

Restore gives each host step 60 seconds and retries a failed menu change once. Run cancellation
cannot interrupt between opening a menu and choosing its item. A failed step sends Escape to
the bound Cursor PID and reads back the selection; results report the state verified or null
when it could not be read. Real control timing still needs attended calibration.

The harness answers only an exact `Allow in this chat` card from Computer Use, bound to a pending
request in the run chat, for an app on both the benchmark allowlist and the task's app list.
It checks the entire card snapshot before pressing any button and rechecks the request at the
press boundary. `Always Allow` is refused. `--no-allow-benchmark-app-prompts` stops on every card.
Saved plans and results replace home paths with `~` and scrub the account name. The native
admission read supplies the account's full name for scrubbing answers and tool evidence.

Offline tests cover the selection lifecycle and entry commands. Live qualification is still
needed for control labels and login validity, as well as the shared helper, permission cards
and model performance.
