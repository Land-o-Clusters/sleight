// Keep host load diagnostic. It never changes an attempt's pass/fail verdict.
export function loadReceipt(stamps) {
  const sample = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && n >= 0);
  if (!sample(stamps?.loadStart) || !sample(stamps?.loadEnd) || !Number.isInteger(stamps?.loadCores) || stamps.loadCores < 1) return {};
  const { loadStart, loadEnd, loadCores } = stamps;
  return { loadStart: [...loadStart], loadEnd: [...loadEnd], loadCores,
    loadExceededHalfCores: Math.max(loadStart[0], loadEnd[0]) > loadCores / 2,
    loadExceededCores: Math.max(loadStart[0], loadEnd[0]) > loadCores };
}
export function loadWarnings(rows, { halfCores = false } = {}) {
  return rows.filter(row => loadReceipt(row)[halfCores ? 'loadExceededHalfCores' : 'loadExceededCores']).map(row =>
    `LOAD: ${row.arm}/${row.task} #${row.run}: 1-minute ${row.loadStart[0]} at spawn, ${row.loadEnd[0]} at exit exceeded ${halfCores ? `half of ${row.loadCores} cores (${row.loadCores / 2})` : `${row.loadCores} cores`}.`);
}
export function loadSummary(rows) {
  return rows.map(row => {
    const receipt = loadReceipt(row), label = `${row.arm ?? row.runtime}/${row.task} #${row.run}`;
    if (!receipt.loadStart) return `LOAD: ${label}: samples unavailable.`;
    return `LOAD: ${label}: 1-minute ${receipt.loadStart[0]} at spawn, ${receipt.loadEnd[0]} at exit, ${receipt.loadCores} cores.` +
      (receipt.loadExceededHalfCores ? ` LOAD_WARNING: exceeded half the cores (${receipt.loadCores / 2}).` : '');
  });
}
