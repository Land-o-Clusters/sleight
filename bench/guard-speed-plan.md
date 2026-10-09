# Guard speed plan

Spec: `.dev/prompts/astra-guard-speed.md` in the primary checkout.
Base: `1bdfd39`, branch `codex/guard-speed`.

The guard will keep a full tree for the first action and for every element selector. A native
observation may replace later reads for keys, text, paste and coordinates only when it proves the
same process, window, title and document with no sheet or dialog. Unknown, late or changed
observations stop or use the existing full guard. This remains cooperative JavaScript.

- [x] Measure cold and persistent native observations without requesting permissions. Start with
  JXA using ApplicationServices, which existing sleight tools already use. Bind observations to
  retained AX window identities and process lifetime. Record failures and cleanup.
- [ ] Test native response validation, late replies, helper failure and guard routing before
  adding the relay bridge and per-action optimization. Preserve leases and selector checks.
- [x] Measure an abandoned post-input engine read and the following call before considering any
  production deadline. A timer alone is not cancellation.
- [x] Reproduce degraded tree compaction with real line forms. Test changed IDs, ambiguous names,
  lost attributes and renumbering before changing comparison behavior.
- [x] Run interleaved Calculator measurements at natural load and with 20 owned workers. Publish
  all attempts, load intervals, limits and before/after numbers in `docs/benchmarks/`.
- [x] Update `docs/design/guard-reads.md` and known problems. Run `npm run check` and
  `npm run lint:prose` separately and require exit 0. Review the final changes.

Publication uses exact paths and the requested branch. sleight-arch handles reproduction and merge.

Review window replacements that keep the same title and calls through multiple app handles.
Check missing AX attributes, reads completing after input and degraded selectors under load.

The user supplied the brief and execution request for this session. sleight-arch handles
reproduction and merge. The worktree started clean at the requested base.

Engine `connect EPERM` blocks native integration. AX reads also failed at load 62 to 67, and
the 100 ms read race did not bound the tool call. The unapplied patch is retained in `bench/`.
Production guard reads remain. This branch delivers the compactor fix and experiment record,
with the requested latency work unfinished.
