// Match the current input field, never a previous expression or history entry.
export function calculatorValue(text) {
  const matches = [...text.matchAll(/^\s*\d+ text Description: Edit field, Value: ([^\r\n]*)$/gm)];
  if (matches.length !== 1) throw new Error('Calculator current input field is missing or ambiguous');
  return matches[0][1].replace(/[, ]/g, '');
}
