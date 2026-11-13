// Optional native counters describe an outcome. They never validate an outcome.
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(' ') === keys.split(' ').sort().join(' ');
const count = value => Number.isSafeInteger(value) && value >= 0;
const hwnd = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const ids = value => Array.isArray(value) && value.length <= 4096 && value.every(hwnd);
const rootRelations = ['equals-root', 'retained-member', 'descendant-not-retained'];
const focusRelations = ['equals-focus', 'equals-root', 'ancestor-of-focus', 'other-member', 'descendant-not-retained'];
function ring(value) {
  return exact(value, 'rootHwnd focusHwnd focusPath capacity total overflow events') &&
    hwnd(value.rootHwnd) && hwnd(value.focusHwnd) && ids(value.focusPath) && value.capacity === 64 &&
    count(value.total) && typeof value.overflow === 'boolean' && value.overflow === (value.total > 64) &&
    Array.isArray(value.events) && value.events.length === Math.min(value.total, 64) && value.events.every(event =>
      exact(event, 'epoch kind hwnd objectId childId pid thread className rootRelation focusRelation focusHwnd focusPathKnown') &&
      ['epoch', 'kind', 'pid', 'thread'].every(key => count(event[key])) &&
      ['objectId', 'childId'].every(key => Number.isSafeInteger(event[key]) && event[key] >= -2147483648 && event[key] <= 2147483647) &&
      hwnd(event.hwnd) && hwnd(event.focusHwnd) && typeof event.focusPathKnown === 'boolean' &&
      (event.className === null || typeof event.className === 'string' && event.className.length <= 256 && !/[\x00-\x1f\x7f]/.test(event.className)) &&
      rootRelations.includes(event.rootRelation) && focusRelations.includes(event.focusRelation));
}
export function windowsDiagnostics(report) {
  const result = {};
  try {
    if (ring(report?.lifecycleEvents)) result.lifecycleEvents = report.lifecycleEvents;
    const checks = report?.identityChecks;
    if (exact(checks, 'count totalMs maxMs') && count(checks.count) &&
        [checks.totalMs, checks.maxMs].every(n => Number.isFinite(n) && n >= 0) && checks.maxMs <= checks.totalMs)
      result.identityChecks = checks;
  } catch { /* A diagnostic can be omitted without replacing a driver result. */ }
  return result;
}
