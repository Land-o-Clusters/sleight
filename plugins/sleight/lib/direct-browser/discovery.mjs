// Original implementation informed by CDM BrowserManager discovery/lifecycle.
// Source pin and license are recorded in distribution-inventory.md. No launch, profile scan, HTTP
// discovery, WebSocket connection or process inspection occurs in this module.
import path from 'node:path';

const browserPath = /^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/;
export function parseActivePort(text) {
  if (typeof text !== 'string' || text.length > 512) throw new Error('invalid active port');
  const match = /^(\d{1,5})\r?\n([^\r\n]+)(?:\r?\n)?$/.exec(text);
  if (!match || !browserPath.test(match[2]) || Number(match[1]) < 1 || Number(match[1]) > 65535)
    throw new Error('invalid active port');
  return { port: Number(match[1]), path: match[2] };
}
export function validateEndpoint(endpoint) {
  // Validate raw spelling before URL canonicalization (127.1 and encoded paths).
  const m = /^ws:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})(\/devtools\/browser\/[A-Za-z0-9_-]{1,256})$/.exec(endpoint);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error('invalid endpoint');
  return endpoint;
}
const same = (a, b) => a && b && ['application', 'root', 'pid', 'start'].every(k => a[k] === b[k]);
function validIdentity(s) {
  return s && typeof s.application === 'string' && path.isAbsolute(s.application) &&
    typeof s.root === 'string' && path.isAbsolute(s.root) && path.normalize(s.root) === s.root &&
    Number.isSafeInteger(s.pid) && s.pid > 0 && Number.isFinite(s.start) && s.start > 0;
}
/** Trusted adapters must supply canonical filesystem evidence, current process
 * incarnation and authenticated connection-peer binding. Browser.getVersion or
 * a GUID alone cannot prove this. If the platform cannot bind the socket to the
 * selected process/root, omit peer evidence and refuse. No profile/context map. */
export function discoverSelected({ selected, canonicalRoot, processes = [], file, setting, supported, connection } = {}) {
  const result = (state, reason) => ({ state, reason });
  if (supported === false) return result('unsupported', 'capability');
  if (setting === false) return result('off', 'user-setting');
  if (supported !== true || setting !== true || !validIdentity(selected) || canonicalRoot !== selected.root)
    return result('stale-instance', 'selected-identity-unproved');
  const matches = processes.filter(p => p.alive === true && p.root === selected.root && p.application === selected.application);
  if (matches.length !== 1 || !same(matches[0], selected)) return result('stale-instance', 'process-incarnation');
  const expected = path.join(selected.root, 'DevToolsActivePort');
  if (!file || file.path !== expected || file.canonicalPath !== expected ||
    !Number.isFinite(file.mtime) || file.mtime < selected.start) return result('stale-instance', 'endpoint-file');
  let hint;
  try { hint = parseActivePort(file.text); } catch { return result('stale-instance', 'endpoint-file'); }
  if (!connection) return result('disconnected', 'hint-is-not-liveness');
  if (['approval-pending', 'declined', 'disconnected'].includes(connection.state)) return result(connection.state, 'connection');
  try {
    validateEndpoint(connection.endpoint);
    const url = new URL(connection.endpoint);
    if (connection.state !== 'connected' || connection.redirected !== false || !same(connection.peer, selected) ||
      Number(url.port || 80) !== hint.port || url.pathname !== hint.path) throw new Error('identity');
  } catch { return result('stale-instance', 'connection-identity-unproved'); }
  return { state: 'connected', identity: { ...selected }, endpoint: connection.endpoint };
}
export function effectiveOrigin(url, creatorOrigin) {
  const parsed = new URL(url);
  if (url === 'about:blank' || ['blob:', 'data:'].includes(parsed.protocol)) {
    const creator = new URL(creatorOrigin ?? 'invalid:');
    if (!['http:', 'https:'].includes(creator.protocol) || creator.origin !== creatorOrigin ||
      (parsed.protocol === 'blob:' && parsed.origin !== creator.origin)) throw new Error('creator origin required');
    return creator.origin;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported origin');
  return parsed.origin;
}
