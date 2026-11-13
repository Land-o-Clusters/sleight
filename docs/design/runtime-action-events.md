# Runtime action events

The own runtime publishes records through the existing `sleight.cursor/1` stream. Its source is `native`, with `confirmed` timing.
An input admission produces `aim` then `act`. The native result produces `done` or `failed`; a parent approval
refusal produces `declined`. A pending action approval uses `status: waiting` with `detail: approval`.
Reads don't emit action or status records from this feed.

Pointer events use the frame and global screen points already resolved by the input lane. Drags retain up to 64
points from the posted plan, including both endpoints. Keyboard focus geometry is omitted when the action has
no resolved element. Unknown typing focus uses `key`, without a count. No extra AX read buys event geometry.
Records omit titles, labels, app names, text, values, key chords and narration, regardless of label settings.

The helper writes bounded JSON lines to an optional fd 3, separate from replies on stdout. It makes the descriptor
nonblocking and drops the channel on backpressure, a partial write or a disconnected reader. Events never wait for
drain, connection or a renderer. The parent checks the helper nonce and pending request id, then projects numeric
geometry. Each consumer's queue holds at most 256 records. An unfinished write at the next event, an exception or
backpressure drops that consumer. Consumers run on later event-loop turns. Dropped channels can leave an action
without its final record.

The private pipe uses `sleight.runtime-action/1`. Completion receipts contain delivery, settled and a fixed basis:
`digest`, `notification`, `notification-none`, `captures` or `none`. Cursor v1 has no settle-basis field, so
`createRuntimeHand` passes that receipt to its internal `onReceipt` callback and publishes only cursor v1 keys.
A successful post remains `sent-unverified` unless an authorized observation verifies its effect.

`createOwnRuntime().actionEvents` exposes the feed. RT8 can pass the session cursor as `relayOptions.cursor` and
the shared native hand client as `relayOptions.runtimeHandClient` to `runOwnRuntime`. It must omit predictive native
hand admission for own calls. No engine launcher, relay code, input permission or input registrar changes here.
The preview still refuses inputs. Native fake tests exercise the hooks with fake sinks; live pacing and capture
exclusion remain unverified.
