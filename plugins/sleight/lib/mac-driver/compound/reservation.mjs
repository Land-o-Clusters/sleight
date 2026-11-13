import { requireCompound } from './intent.mjs';
import { macLeaseTarget } from '../../mac-safety.mjs';

// The parent's document grant remains held during app-scope acquisition. The
// separate service fence must outlive lease expiry and deny another writer until
// the transport is proved retired. InputLease alone does not provide that fence.
// No production fence service is installed by this module.
export function createCompoundReservation({ lease, documentGrant, fence }) {
  const owned = new WeakSet();
  const held = (record, execution) => {
    requireCompound(owned.has(record) && record.execution === execution, 'LEASE_REFUSED');
    requireCompound(fence.validate(record.fence, execution) === true, 'LEASE_REFUSED');
    lease.withGrant(documentGrant.key, documentGrant.token, () => {});
    lease.withGrant(record.app.key, record.app.token, () => {});
    return true;
  };
  return Object.freeze({
    acquire(binding, execution, deadline) {
      requireCompound(fence && documentGrant?.key && documentGrant?.token, 'LEASE_REFUSED');
      lease.withGrant(documentGrant.key, documentGrant.token, () => {});
      const pinned = fence.acquire({ bundleId: binding.bundleId, pid: binding.pid, processStart: binding.processStart,
        helper: binding.helper, execution, deadline });
      requireCompound(pinned, 'LEASE_REFUSED');
      try {
        const app = lease.acquireGrant(macLeaseTarget(binding), 'app');
        const record = { app, fence: pinned, execution }; owned.add(record); return record;
      } catch {
        fence.release(pinned, execution, { neverDispatched: true });
        throw Object.assign(Error('LEASE_REFUSED'), { code: 'LEASE_REFUSED' });
      }
    },
    validate: held,
    dispatched(record, execution) { held(record, execution); fence.dispatched(record.fence, execution); },
    acknowledged(record, execution) { held(record, execution); fence.acknowledged(record.fence, execution); },
    release(record, execution) {
      requireCompound(owned.has(record) && record.execution === execution, 'LEASE_REFUSED');
      // Called only after retirement, even after an ordinary successful reply.
      requireCompound(fence.retired(record.fence, execution) === true, 'LEASE_REFUSED');
      // InputLease.release compares its retained ownership token and can remove
      // an expired own record. releaseGrant would reject expiry after retirement
      // and strand the fence. A replacement token is never removed here.
      lease.release([record.app.key]);
      fence.release(record.fence, execution, { retired: true }); owned.delete(record);
    },
  });
}
