// A reservation interface for cooperating runtimes. No engine or approval path.
import { InputLease } from './input-lease.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const invalid = () => { throw new Error('Lease broker: invalid request or unknown field.'); };
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function validate(request) {
  if (!object(request)) invalid();
  if (request.operation === 'acquire') {
    fields(request, ['operation', 'client', 'window', 'scope']);
    if (!text(request.client, 200) || !request.client.trim() || /[\x00-\x1f\x7f]/.test(request.client)) invalid();
    fields(request.window, ['appId', 'app', 'title', 'url']);
    const { appId, app, title, url } = request.window;
    if (!text(appId, 512) || !appId.trim() || /[\s\x00-\x1f\x7f]/.test(appId) || !text(title, 8192) ||
        (app !== undefined && !text(app, 512)) || (url !== undefined && !text(url, 8192)) ||
        (request.scope !== undefined && !['window', 'app', 'desktop'].includes(request.scope))) invalid();
  } else if (['status', 'renew', 'release'].includes(request.operation)) {
    fields(request, request.operation === 'status' ? ['operation', 'key'] : ['operation', 'key', 'token']);
    if (typeof request.key !== 'string' || !/^[a-f0-9]{64}$/.test(request.key)) invalid();
    if (request.operation !== 'status' && (typeof request.token !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.token))) invalid();
  } else invalid();
}

export function brokerRequest(request, { directory, now } = {}) {
  validate(request);
  const lease = new InputLease({ directory, now, holder: request.client });
  try {
    switch (request.operation) {
      case 'acquire': return { ok: true, lease: lease.acquireGrant(request.window, request.scope) };
      case 'status': return { ok: true, lease: lease.inspect(request.key) };
      case 'renew': return { ok: true, lease: lease.renewGrant(request.key, request.token) };
      case 'release': lease.releaseGrant(request.key, request.token); return { ok: true, released: request.key };
    }
  } finally {
    // One-shot clients keep the reservation after exit; only close the lock connection.
    lease.disposeCoordinator();
  }
}
