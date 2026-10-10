# Electron and Firefox tree counts

One engine `getAXState` of each app's main window on 2026-10-10. The call didn't send keys, clicks
or text. Cursor was already running and was only read. VS Code, Firefox, Slack, Discord and WhatsApp
were launched with `open -g` and quit afterwards. Published figures are counts. Chat trees were
not copied.

| App | Chars | Elements | Text fields | Buttons (id / label / neither) | Read ms |
|---|---:|---:|---:|---|---:|
| VS Code | 4130 | 116 | 0 | 27 (0 / 24 / 3) | 1934 |
| Cursor | 6777 | 139 | 0 | 34 (0 / 31 / 3) | 446 |
| Firefox | 898 | 24 | 0 | 5 (0 / 2 / 3) | 147 |
| Slack | 483 | 15 | 0 | 3 (0 / 0 / 3) | 914 |
| Discord | 11158 | 251 | 1 labeled | 46 (0 / 43 / 3) | 594 |
| WhatsApp | 940 | 19 | 0 | 5 (0 / 2 / 3) | 179 |

No button on any of the six had an ID. Cursor also had one `text entry area`, not counted as a
text field. Slack, Firefox and WhatsApp are thin: window chrome and a few unlabeled controls.
Discord is not: 17 rows and one labeled text field. VS Code and Cursor expose a normal-sized
tree of labeled buttons, still with no text fields.

Tasks are unit-tested and not live-run on this branch. Chat results use the Mimestream hash
shape. Published rows keep verdicts, times and hashes, without author names or message text.
