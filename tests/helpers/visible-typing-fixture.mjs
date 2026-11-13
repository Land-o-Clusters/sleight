// Successful typing in these guard fixtures is immediately visible. Delayed AX
// delivery and genuine no-change input have their own typing-settle fixtures.
export function visibleTypingTree(tree, typed) {
  if (!typed) return tree;
  const rows = tree.split('\n');
  const editable = /^\s*\d+ (?:text field|text area|text entry area|search (?:text )?field|combo box)\b/;
  const focus = /^The focused UI element is (\d+) /m.exec(tree)?.[1];
  let at = rows.findIndex(row => editable.test(row) && row.trimStart().startsWith(focus + ' '));
  if (at < 0) at = rows.findIndex(row => editable.test(row));
  if (at >= 0) {
    rows[at] = rows[at].replace(/, Value: .*$/, '') + ', Value: ' + JSON.stringify(typed);
  } else {
    // Minimal window fixtures omit the editor. Expose its document text without
    // changing any existing element number, window identity or focus evidence.
    const next = Math.max(...rows.map(row => Number(/^\s*(\d+) /.exec(row)?.[1] ?? 0))) + 1;
    const focusAt = rows.findIndex(row => row.startsWith('The focused UI element is '));
    rows.splice(focusAt < 0 ? rows.length : focusAt, 0, '\t' + next + ' text ' + JSON.stringify(typed));
  }
  return rows.join('\n');
}
