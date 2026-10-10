# TextEdit follow-up plan

Apply the seven review items in `.dev/prompts/sol-textedit-fixes-2.md` inline.

- [x] Test spelling-only AX attributes, supported visual differences and preparation fallback.
  Restrict the comparison in `drag.js` and preserve strict prepared-child revalidation.
- [x] Test direct Edit-menu lookup and stopping at the first enabled Command-V Paste.
- [x] Test collected children killed before and after a stderr Paste receipt. Emit the receipt
  immediately before AXPress, restore on pre-press termination, retain on uncertain posted input.
- [x] Test bounded shutdown recovery and expiry. Restore when safe; otherwise report clipboard
  contents as left, collect the native helper and release the shared reservation.
- [x] Remove published clipboard hashes and retain only match booleans. Document Screen Recording
  dependence of CG Save-panel names.
- [ ] Record load and Paste wait in the fixture harness. Run rich text, misspelled plain text and
  orphan-panel probes with the shared lock and no hold marker. If off Space, use one fresh fixture
  through `open -g -a TextEdit`, retry once, then stop and publish the result.
  Both follow-up attempts stopped at the occupied live lock before any app operation. Their
  records are published. The requested live qualifications remain open under the stop rule.
- [x] Review the changes, run both required bare checks to exit zero and rebase private upstream.
  Review is complete and the branch includes private upstream `3f5c509`. The final full check
  exited 0: 1,185 Node tests, both manifest validations and 26 mod tests passed. Prose lint exited
  0 with no findings in 75 files.

Publish by committing explicit paths and pushing the private branch without merging. The live
qualification remains open under the shared-lock stop rule.

Focus on absent AX attributes, localized menu names, the interval between receipt and AXPress,
newer clipboard generations, and shutdown with a native helper in flight.
