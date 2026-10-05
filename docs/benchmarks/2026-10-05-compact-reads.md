# Smaller results after actions (2026-10-05)

After every `js` action, sleight's window guard reads the whole tree with diffing off, so the input
lease can check the window header. That read is also the engine's new diff baseline. Until 0.9.0 it
went to Claude whole, after whatever Claude had already read. Now the relay keeps the last full tree
Claude got for each window and sends only the lines that changed since then
(`plugins/sleight/lib/compact-reads.mjs`). A first read of a window, or a change larger than 60% of
the tree, still goes whole.

The benchmark passed 12/12 with it, two runs per task
([results](2026-10-05-compact-reads.json)). In those runs 46 guard reads were cut down, 38 of them
to one "no change" line. Median sleight result text per run, against the earlier passes the
same day:

| Task | Before (chars) | After (chars) |
|---|---|---|
| textedit-drag | 21,496 | 16,466 |
| textedit-edit | 17,776 | 16,942 |
| textedit-save | 66,747 | 66,405 |
| chess-drag | 20,991 | 20,262 |

The before column is the clean 0.7.0 pass, with three runs per task. The samples differ in size and
in what Claude chose to do. These apps have small trees, and textedit-save spends most of its text on
new windows and dialogs, which go whole. The complaint that started this came from a browser page
with a long sidebar. The savings there should be larger. No browser is on the benchmark's
allowlist, so we haven't measured it. A page that re-renders and renumbers its elements still comes
through whole, from the engine and from the guard.

## Fix in 0.9.1, and Helium

Everything one `js` call writes reaches the relay as one text item. In 0.9.0 the compactor only
looked for the guard's read at the start of an item, so a call that wrote its own output first got
the whole tree, with the relay's internal mark visible in it. 0.9.1 finds the read anywhere in the
item, and a full tree Claude read earlier in the same item counts as seen. The benchmark passed
12/12 again on the fixed code; 46 guard reads were cut down, 32 of them to "no change".

A script drove Helium through sleight's launcher, with Helium on the owner's pre-approved list
([sizes](2026-10-05-compact-reads-helium.json)). On a local page with a 120-item sidebar, each click
sent 428 characters instead of 35,532, and the counter read back correctly 5/5. On the CNN front
page, all 5 scrolls went whole, from 32,671 to 48,089 characters. Lazy loading inserts elements and
renumbers every element after them, so most lines change. The engine's own diff has the same
limit. Pages that hold still get the savings, and pages that keep loading don't.

## Pages that renumber, in 0.10.0

0.10.0 matches lines by their text without the element number. Elements whose only change is a new
number are left out, and one line says how many there were. Those old numbers are stale, so the
relay remembers which numbers Claude has seen since its last full read of the window. Those are the
unchanged ones and the numbers on + lines, plus any number on a line in the same result that
matches the current tree exactly. An action on any other number, or on a computed one, is refused before it reaches the
engine, with a pointer to the latest + lines or a full read.

On the CNN front page in Helium ([sizes and trials](2026-10-05-compact-reads-cnn.json)), five
scrolls sent 39,655 characters instead of 203,160 (2,523 to 16,245 each, with 310 to 363 elements
renumbered per scroll). Every + line also appeared in a full read. Clicking old numbers of text
elements after a scroll, the relay refused 8 numbers that now pointed at a different element and
let 6 through that pointed where Claude had been shown, with none wrong. A first run used a checker
that looked elements up by text; CNN repeats identical lines, and that checker flagged 3 of 14 as
wrong, so the second run checked what each number pointed at. Those three weren't rechecked one by
one.

The benchmark passed 12/12 on 0.10.0 ([results](2026-10-05-compact-reads-0.10.0.json)). The relay
refused three clicks as stale, all in textedit-save while TextEdit's menus were open. In two of
them an open menu had shifted every number by one between Claude's read and its click: 21 was now
20 and 65 was now 64, so the click would have hit the next item. Claude read again and clicked the
right one. After the third, Claude judged the task done and stopped, so there is no later read to
check it against.
