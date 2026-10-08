# App read diagnosis

When two successive reads of an app time out, independent checks run before the second error
reaches Claude. `app-health.js` queries the process's AXWindows with a 500 ms native messaging
timeout. It never activates the app or requests macOS permission. Missing permission, ambiguous
selectors, subprocess deadlines and other failures remain unknown.

The relay selects another app from successful literal acquisitions in this engine session.
It checks that process through AX, then sends a fresh engine read through the existing guards.
The control request has a 1.5 s engine deadline and a 5.5 s relay deadline. A relay deadline alone
does not prove a helper timeout. Document and once approval modes report unknown rather than
starting a hidden control acquisition. The probe cannot request a new approval or higher risk.

| Evidence | Advice |
|---|---|
| Target AX times out; fresh control read succeeds | Save work if possible, then quit and reopen the target app |
| Target AX responds; fresh control read succeeds | The target's engine read or window state failed; reopen that app |
| Both AX processes have windows; control returns an actual engine timeout | The engine read path appears stuck; ask the user to restart ChatGPT |
| Missing or contradictory evidence | Stop retries and report uncertainty |

Recovery still runs once every 20 seconds. All hidden results bypass the visible compactor and
require a later full visible read before actions. Pending or expired control reads block actions
on that control until collected. Late results cannot approve input; session reset invalidates
diagnostics by generation. Native approval tokens differ from relay request IDs. While a control
read remains outstanding, approvals use only an existing matching grant and otherwise decline.

The [live report](../benchmarks/2026-10-08-reliability.md) records native app hangs. A shared helper
wedge was not provoked. No code quits apps or restarts ChatGPT in response to this diagnosis.
