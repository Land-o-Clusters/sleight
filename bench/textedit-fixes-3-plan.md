# TextEdit third review plan

Apply `.dev/prompts/sol-textedit-fixes-3.md` to the existing private branch.

- [x] Test and gate rich moves with `SLEIGHT_RICH_TEXT_MOVE=1`.
- [x] Test bounded recovery, exact staged clipboard matching and late recovery replies.
- [x] Test the child Paste budget and native AX timeout.
- [x] Test missing foreground color against explicit black, including native CGColor values.
- [x] Test Save-panel advice once per native window across reads, diagnosis and blocked input.
- [x] Record the loaded Paste measurement or the shared-lock refusal.
- [x] Run bare checks, squash the branch without clipboard digests, and push privately.
  The full check exited 0 with 1,194 Node tests, both manifest validations and 26 mod tests.
  Bare prose lint exited 0. Publication uses one feature commit after the history check.

The branch rebased cleanly onto private upstream `e42b974`. The live lock was occupied on
inspection. Full live qualification belongs to the architect after this review.
