// Keep the real identity only in memory for simctl; sanitize every serialized field.
export function simulatorFocusReport(report, sim, { home, ownerName }) {
  const replacements = [[home, '~'], [ownerName, '<user>'], [sim?.udid, '<simulator-id>'], [sim?.name, '<simulator-name>']]
    .filter(([from]) => typeof from === 'string' && from.length > 0)
    .sort(([a], [b]) => b.length - a.length);
  const cleanString = value => replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  const clean = value => {
    if (typeof value === 'string') return cleanString(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanString(key), clean(item)]));
    return value;
  };
  return JSON.stringify(clean({ ...report, simulatorOwnership: sim ?? null }), null, 2) + '\n';
}
