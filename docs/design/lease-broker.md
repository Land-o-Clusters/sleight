# Lease broker

The broker lets an outside agent reserve the same window that sleight reserves.
It uses the existing SQLite coordinator and JSON records under
`~/Library/Application Support/sleight/leases`. It doesn't start the engine or
drive apps. The earlier two-sleight-session check doubled text in 5/5 trials without
leases and left one marker with one refusal in 5/5 with them (see
[input leases](input-lease.md)). This branch has no live Codex evidence.

## Participation and consent

The smallest interface is a CLI, also callable as a JavaScript module. A hook or
skill can call it before input and release after the call finishes. An MCP
adapter can expose the same operations to any MCP client. This slice adds the
CLI. An MCP server and installation into another runtime are separate work.

Codex can follow an [AGENTS.md instruction](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
or a [skill](https://developers.openai.com/codex/skills/) that invokes the CLI
before its native computer-use calls. A future MCP adapter would need an
owner-approved [server entry](https://developers.openai.com/codex/mcp/) in
`~/.codex/config.toml` plus instructions to use its tools.
Loading a server alone does not make native input take a lease. No vendor
software changes are needed for cooperation; no instruction can force a runtime
to obey. sleight never modifies or wraps OpenAI's helper.

The broker shares a holder label, target, scope and expiry. Acquire also returns
a random token to that client. Status omits the token. Possession of that token
permits renewal and release, so clients must keep it out of published traces.
Labels describe sessions. They don't authenticate them. Files remain private
to the macOS user, and another process running as that user can read them.

Approvals remain in each runtime. An approval in Claude never grants one in
Codex. An approval in Codex never grants one in Claude. A lease is a reservation. Each client must obtain its
own app approval before input. The broker never approves an app, stores approval
decisions or writes ChatGPT's `ComputerUseAppApprovals.json` Always allow list.
The engine can honor that existing user setting independently of the broker
([LAWS](../status/LAWS.md)).

## Interface

Run with Node supporting `node:sqlite`, including ChatGPT's bundled Node 24:

```sh
node plugins/sleight/lib/lease-broker-cli.mjs < request.json
```

The CLI reads one JSON object to EOF (at most 16 KiB) and writes one JSON reply.
Success exits 0. Invalid input, contention, expiry and ownership refusals exit 1
with `{"ok":false,"error":"..."}`. Requests return without waiting for a holder
or prompting the user.
The CLI always uses the existing default directory. The module accepts an
explicit directory and clock for isolated offline tests.

| Operation | Request fields | Successful reply |
|---|---|---|
| `acquire` | `client`, `window`, optional `scope` | `ok`, `lease` including `key` and `token` |
| `status` | `key` | `ok`, `lease` without token, or `null` if absent |
| `renew` | `key`, `token` | `ok`, `lease` without token |
| `release` | `key`, `token` | `ok`, `released` key |

Every request includes `operation`. Unknown fields are refused, including
approval fields. `window` contains `appId` (bundle ID), `title`, optional `url`
and optional `app` (display name). Scope defaults to `window`. `app` and
`desktop` use sleight's existing broader conflicts. Clients must use the bundle
ID and exact URL or title observed by the engine. The broker cannot verify a
target without driving or observing the app. Equal unsaved titles share a key;
different spellings of one URL can miss each other. Re-read after a target change.

```json
{"operation":"acquire","client":"Codex thread A","window":{"appId":"com.apple.TextEdit","title":"broker.txt","url":"file:///private/tmp/broker.txt"}}
```

Keep the returned key and token, then submit them for renew or release. A client
must renew every five seconds while input or its approval is pending, stop
dispatching immediately on refusal, and release only after its input has ended.
The one-shot CLI closes its SQLite connection without releasing an acquired
lease. A fresh process can renew or release using the token. Status reports
`expires` as Unix milliseconds and `active` at observation time. It is advisory;
only a successful acquire or renew admits input. Repeated acquire is a new
client, even with the same label; retry ownership with renew instead.

sleight keeps its existing `InputLease` API and automatic renewal. Token-based
broker operations use that same coordinator and records, so they conflict with
unmodified sleight relays. Checked release refuses a missing, expired or
different token and cannot erase a successor. Normal relay cleanup retains its
existing idempotent behavior.

## Guarantees and failures

With cooperating clients using the same directory and intact coordinator,
SQLite serializes admission: overlapping live leases cannot both be granted.
App and desktop reservations retain their existing broader exclusion. An old
token cannot renew or release a successor. The native helper accepts input
independently of the store. Clients following the reservation, renewal,
target and approval rules are a convention. Checks cannot retract input already
dispatched, or prevent input after a caller ignores expiry.

- A crashed holder leaves a record that expires after 30 seconds without renewal.
  The next acquire may replace it. Pending native events could continue after
  expiry. Expiry doesn't prove those events stopped.
- Local processes use the system wall clock through `Date.now`. A clock jump
  forward can expire a running holder early, and a jump backward can extend a
  stale reservation. The CLI doesn't accept a client timestamp. Injected test clocks
  do not prove safety under a clock change.
- Broker processes on the same coordinator participate in one store. Separate
  directories or replaced coordinator inodes can split ownership. Existing
  inode checks detect replacement at transaction boundaries, not throughout an
  action. Never delete the coordinator during use.
- A runtime that ignores the broker, an older tool or the user can still input
  into a held window. The broker has no authority over that path. A refusal
  names the holder and seconds remaining; invalid or unavailable storage stops
  admission. There is no notification UI in this slice.

Engine diffs can reveal an unexpected change on the next read, but their
baseline is shared across sessions and they cannot attribute the change. Helper
activity can reveal that the shared service is busy, not which agent owns a
window or whether input happened. Accessibility observers could report text,
selection or window changes after the event, with permission and app support,
but cannot identify the writer or intercept all input. This slice installs no
observer. Observations can miss outside actions and cannot enforce another
runtime's lease. Limits are also in [known problems](../known-problems.md).

## Build and offline checks

1. Write broker tests and run them against the old revision. Check broker and
   relay exclusion in both orders. Cover independent processes and expiry after
   a crashed holder, plus wrong and stale tokens, renewal, broad scopes and
   invalid requests.
2. Add checked token operations in `input-lease.mjs`, a broker request module,
   and a bounded JSON CLI. Preserve the relay's cleanup and refusal wording.
3. Run the focused tests, then bare `npm run check` and `npm run lint:prose`.
   Add this design to prose lint and record the test counts in the changelog.
   Commit the paths listed in this brief and push `codex/lease-broker` to `private`.

Offline on 2026-10-11, all 9 new tests failed against `37aeddc` before the
code existed. With the broker, the focused broker and existing
lease suite passed 51/51. The tests use temporary stores, synthetic targets and
injected clocks. They don't start the computer-use engine. A baseline suite attempt
also failed on sandbox restrictions in existing tests (sockets, clipboard helper,
worktree writes and process inspection). Those failures prove no app behavior.
Bare `npm run check` then exited 0 with scoped host access: 1,763 Node tests,
manifest validation and 30 mod tests passed. The earlier sandbox run exited 1.

## Live check for sleight-arch

Run from the checkout under test during an owner-agreed away window, with
TextEdit closed:

```sh
node bench/broker-live.mjs 'owner-agreed away window'
```

The harness takes `/tmp/sleight-live.lock` with `mkdir`. An existing lock or
`/tmp/sleight-hold` stops setup. A hold that appears during a run cancels owned
drivers and stops further app operations. It opens two private TextEdit files,
retains their native window references through `bench/real-fixture.mjs`, and
uses the double-keys fixture for independent exact text readback. It refuses
setup if TextEdit was already running. Cleanup closes only retained fixtures,
quits only the TextEdit process this run launched, and removes the lock only
after ended input, fixture closure and zero owned lease records are confirmed.
Otherwise the bank and lock stay for sleight-arch to inspect.

The Codex participant is a real headless `codex exec` thread, resumed for later
trials, on `gpt-6.1-sol` with `CODEX_HOME=~/.codex-bench`. That home must already
have its login, native `cua_repl` server and usable TextEdit approval. The harness
doesn't write an AGENTS.md or change either runtime's approval settings.
The owner-approved rule goes verbatim in each trial prompt:

> Before every native computer-use input, acquire the sleight broker lease for the observed bundle ID and exact window URL or title; renew every 5 s, stop on refusal, keep the token private, and release only after input has finished. Obtain app approval in this runtime separately.

Each prompt gives the absolute Node and broker CLI invocation, with one private
request file on stdin and a private reply file on stdout. Codex observes the
exact bundle, title and URL before admission, then sends one literal native
typing call on success. A refused client must stop before calling input.
The adapter checks recorded CLI and native-tool events, rather than the agent's
answer. It renews Codex's grant every 5 s, including while native input or
approval is pending, and keeps the grant after the headless turn ends.
A renewal failure cancels and collects that owned Codex process. The sleight
participant uses the normal relay input path and its same `InputLease` object;
a private stdio reserve operation covers the no-input reservation trials.
Both adapters hold renewals until the trial releases them.

All 13 planned scenarios must pass:

- Sleight holds first in five trials, then Codex holds first in five.
  The other client gets a holder-and-expiry refusal with zero forwarded input.
  Independent readback contains exactly one marker. After checked release,
  the refused client acquires and appends its distinct marker exactly once:
  10/10 exact contention readbacks and 10/10 exact handoffs.
- Both clients reserve different documents at once. A Codex app reservation
  excludes sleight's reservation of the other document.
- Codex renews through at least 35 s while sleight stays refused in seven
  probes. After Codex input has ended, its adapter stops renewal without
  release. At least 31 s later sleight acquires and appends its marker.
  Codex's old token cannot release that successor, which remains active.
- Each runtime obtains its own app approval. The result identifies accepted
  native calls separately from sleight's benchmark allowlist approval.
  An unanswered headless prompt fails the run, and each adapter keeps its own
  approval boundary.

The harness writes a timestamped JSON file to `docs/benchmarks/` on exit,
including failed and interrupted attempts, raw broker replies, scoped native
input replies, exact readbacks, exit results and cleanup status. Unrun scenarios
are counted separately. Unexpected tool output is omitted from publication
because it can contain unrelated windows. Its call still fails the audit.
Tokens, agent prose, rollout transcripts, image payloads and home paths are
excluded or scrubbed. Don't publish the private benchmark-home rollouts.

Offline on 2026-10-11, all 15 harness tests failed with the new harness removed
from the unchanged `464e0ba` checkout, using fake clients or engines and
temporary broker stores. An intermediate focused run passed 14/15: the fake
engine's initialization exceeded a 100 ms test deadline. That deadline was
raised to 5 s. The final full check passed all 15 harness tests within 1,836
Node tests, both validation steps and 31 mod tests; bare `npm run check`
exited 0 with scoped host access. The first sandboxed check exited 1 on
existing socket, worktree-write and host-inspection tests. These attempts
drove no app and prove no live behavior.
For live qualification, sleight-arch must show the scenario counts above and
each runtime's own approval evidence. Cleanup must confirm input completion
and fixture closure, with zero owned lease records remaining. A runtime can
ignore the cooperative lease instruction. Limits remain in
[known problems](../known-problems.md).
