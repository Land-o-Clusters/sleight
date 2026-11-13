import { freezeCompound, requireCompound } from './intent.mjs';
import { compoundBinding, compoundEqual } from './observation.mjs';

// Only parent-owned service readers create snapshots. They must recompute
// approval, scope, policy, cell and lease on every call. No serialized object,
// even a byte-for-byte copy of an issued snapshot, is an authority capability.
const issued = new WeakMap();
export function createCompoundAuthoritySource(readCurrent) {
  requireCompound(typeof readCurrent === 'function', 'AUTHORITY_CHANGED');
  const capture = () => {
    const raw = readCurrent();
    requireCompound(raw && typeof raw === 'object', 'AUTHORITY_CHANGED');
    const { boundIntent, ...data } = raw;
    return Object.freeze({ ...freezeCompound(structuredClone(data)), boundIntent });
  };
  return Object.freeze({
    snapshot() {
      const snapshot = capture(); issued.set(snapshot, capture); return snapshot;
    },
  });
}
export function verifyCompoundAuthoritySnapshot(snapshot, { intent, binding, execution, now }) {
  const capture = issued.get(snapshot);
  requireCompound(typeof capture === 'function', 'AUTHORITY_CHANGED');
  const live = capture();
  requireCompound(snapshot.boundIntent === intent && live.boundIntent === intent, 'REPL_CELL_ENDED');
  const data = a => { const { boundIntent: _intent, ...rest } = a; return rest; };
  requireCompound(compoundEqual(data(snapshot), data(live)), 'AUTHORITY_CHANGED');
  requireCompound(live.source === 'trusted-task' && live.sessionActive === true && live.cellActive === true, 'REPL_CELL_ENDED');
  requireCompound(live.approved === true, 'APP_DECLINED');
  requireCompound(live.approvalScope?.kind === 'app-input' &&
    compoundEqual(compoundBinding(live.approvalScope.binding), binding), 'AUTHORITY_CHANGED');
  requireCompound(live.permissions === true, 'PERMISSIONS_UNAVAILABLE');
  requireCompound(live.policy === true, 'APP_POLICY_REFUSED');
  requireCompound(live.siteKnown === true, 'SITE_UNPROVEN');
  requireCompound(live.flow === true, 'FLOW_REFUSED');
  requireCompound(Number.isSafeInteger(live.generation) && live.generation >= 0, 'AUTHORITY_CHANGED');
  requireCompound(live.lease?.live === true && live.lease.fenced === true && live.lease.execution === execution &&
    typeof live.lease.token === 'string' && live.lease.token.length > 0 && Number.isFinite(live.lease.expires) &&
    now < live.lease.expires, 'LEASE_EXPIRED');
  return freezeCompound({ generation: live.generation, token: live.lease.token, scope: live.approvalScope });
}
