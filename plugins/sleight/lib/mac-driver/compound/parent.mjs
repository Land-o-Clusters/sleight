import { randomUUID } from 'node:crypto';
import { verifyCompoundAuthoritySnapshot } from './authority.mjs';
import { COMPOUND_LIMITS, compoundFault, knownCompoundBoundary, parseCompoundIntent, requireCompound } from './intent.mjs';
import { compoundBinding, compoundEqual } from './observation.mjs';
import { createCompoundHelper } from './helper.mjs';
import { createCompoundReceipt, encodeCompoundReceipt, finishCompoundReceipt } from './receipt.mjs';

const stopCodes = new Set(['BOUNDARY_REQUIRED', 'APP_DECLINED', 'APP_NOT_ACQUIRED', 'APP_BLOCKED', 'APP_POLICY_REFUSED',
  'FORBIDDEN_TARGET', 'FORBIDDEN_SETTINGS', 'OWN_HOST_REFUSED', 'SITE_UNPROVEN', 'SITE_BLOCKED', 'PERMISSIONS_UNAVAILABLE',
  'FLOW_REFUSED', 'LEASE_REFUSED', 'LEASE_EXPIRED', 'REPL_CELL_ENDED', 'AUTHORITY_CHANGED', 'STALE_GRANT', 'COMPOUND_BUSY',
  'METHOD_NOT_FOUND', 'INVALID_CONTRACT', 'UNSUPPORTED_TRANSITION', 'IDENTITY_CHANGED', 'IDENTITY_UNVERIFIED',
  'OBSERVATION_INCOMPLETE', 'INCOHERENT_OBSERVATION', 'MODAL_APPEARED', 'BACKGROUND_UNAVAILABLE', 'OWNER_UNPROVEN',
  'OPTION_SET_INCOMPLETE', 'AMBIGUOUS_STEP', 'STEP_NOT_FOUND', 'STEP_DISABLED', 'SECURE_FIELD', 'STALE_CONTROL',
  'PANEL_UNPROVEN', 'CONTEXT_DRIFT', 'WITNESS_CHANGED', 'PERSON_STATE_UNAVAILABLE', 'PERSON_TOOK_OVER',
  'PERSON_HOLDS_MODIFIER', 'SCREEN_LOCKED', 'SECURE_INPUT_ACTIVE', 'DEADLINE_EXCEEDED', 'DELIVERY_UNRESOLVED',
  'INVALID_DELIVERY', 'EFFECT_UNVERIFIED', 'DESTINATION_UNVERIFIED', 'UNSETTLED', 'HELPER_FAILED', 'RECEIPT_CAPACITY',
  'RECEIPT_FAILED', 'USER_STOPPED', 'ACTION_UNCONFIRMED', 'UNEXPECTED_TRANSITION']);
const code = error => stopCodes.has(error?.code) ? error.code : 'HELPER_FAILED';

// This is the only runtime adapter provided here. It asks the actual parent
// admission seam for an unregistered method. There is no enable flag, action
// registrar, localTool route or evaluated-JS escape hatch.
export function createRuntimeCompoundAdmission({ safety, context = {} }) {
  return Object.freeze({
    begin: () => safety.request('compoundBegin', {}, context),
    authorizeRead: request => safety.request('compoundPrepare', request, context),
    admit: request => safety.request('compoundAdmit', request, context),
    current: () => undefined, consume: () => false,
    invalidate() {}, observe() {}, acknowledge() {},
  });
}

// Internal parent coordinator. The admitted positive path is exercised only by
// injected fixture services. A future native transport must implement these
// same prepare/execute/ack boundaries and separately review its qualifications.
export function createCompoundParent({ admission, provider, contracts, reservation,
  now = () => performance.now(), timeoutMs = COMPOUND_LIMITS.milliseconds,
  record = async () => {}, cosmeticTitle = false, application, menuRequests = () => [] }) {
  requireCompound(typeof admission?.consume === 'function', 'FLOW_REFUSED');
  requireCompound(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= COMPOUND_LIMITS.milliseconds, 'INVALID_INTENT');
  let used = false, cancelled, generation = 0, helper, lastResult;
  const grants = new WeakMap();
  const within = async (operation, deadline, maximum = timeoutMs) => {
    const remaining = Math.min(maximum, deadline - now());
    requireCompound(remaining > 0, 'DEADLINE_EXCEEDED');
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(compoundFault('DEADLINE_EXCEEDED')), remaining);
    })]); } finally { clearTimeout(timer); }
  };
  function authority(intent, original, deadline, binding, execution) {
    requireCompound(!cancelled, cancelled ?? 'USER_STOPPED');
    requireCompound(now() < deadline, 'DEADLINE_EXCEEDED');
    const a = verifyCompoundAuthoritySnapshot(admission.current(), { intent, binding, execution, now: now() });
    const stamp = { ...a, parentGeneration: generation };
    if (original) requireCompound(compoundEqual(original, stamp), 'AUTHORITY_CHANGED');
    return stamp;
  }
  return Object.freeze({
    async run(input, recipient) {
      requireCompound(!used, 'COMPOUND_STOPPED'); used = true;
      const intent = parseCompoundIntent(input), binding = compoundBinding(recipient), execution = randomUUID();
      const receipt = createCompoundReceipt(intent, binding), deadline = now() + timeoutMs;
      let stamp, reserved, current, state = 'stopped', reason, at = 0, outstanding;
      try {
        requireCompound(!cancelled, cancelled ?? 'USER_STOPPED');
        if (intent.operation === 'menu' && intent.segments.some(s => knownCompoundBoundary(s.label)))
          throw compoundFault('BOUNDARY_REQUIRED');
        await within(() => admission.begin({ execution, intent, binding, deadline }), deadline);
        stamp = authority(intent, undefined, deadline, binding, execution);
        requireCompound(reservation && typeof reservation.acquire === 'function', 'LEASE_REFUSED');
        reserved = await within(() => reservation.acquire(binding, execution, deadline), deadline);
        requireCompound(reserved, 'LEASE_REFUSED'); authority(intent, stamp, deadline, binding, execution);
        helper = createCompoundHelper({ execution, intent, binding, provider, contracts, now, deadline, cosmeticTitle,
          application, menuRequests,
          authorizeRead: async request => {
            authority(intent, stamp, deadline, binding, execution);
            requireCompound(await admission.authorizeRead(request) === true, 'APP_DECLINED');
            authority(intent, stamp, deadline, binding, execution);
          },
          revalidate() {
            authority(intent, stamp, deadline, binding, execution);
            requireCompound(reservation.validate(reserved, execution) === true, 'LEASE_REFUSED');
          },
          consume(grant, witness) {
            const entry = grants.get(grant);
            requireCompound(entry && !entry.consumed && entry.witness === witness && entry.execution === execution &&
              entry.index === witness.index && witness.helper === binding.helper && entry.expires > now(), 'STALE_GRANT');
            authority(intent, stamp, deadline, binding, execution);
            // Synchronous service fencing joins the parent authority decision.
            requireCompound(reservation.validate(reserved, execution) === true, 'LEASE_REFUSED');
            requireCompound(admission.consume(witness) === true, 'FLOW_REFUSED');
            entry.consumed = true;
          },
        });
        for (at = 0; at < receipt.steps.length; at++) {
          authority(intent, stamp, deadline, binding, execution);
          const step = receipt.steps[at];
          const prepared = await within(() => helper.prepare(), deadline);
          current = prepared.before;
          if (prepared.noop) {
            const noops = prepared.all ? receipt.steps.slice(at) : [step];
            for (const s of noops) Object.assign(s, { effect: prepared.noop, effectObserved: true,
              beforeReadId: prepared.before.readId, afterReadId: prepared.before.readId });
            await within(() => record('acknowledge-noop', { execution, index: at }), deadline);
            helper.acknowledgeNoop(at, prepared.all);
            if (prepared.all) break;
            continue;
          }
          const witness = prepared.witness;
          if (witness.kind === 'menu.direct') {
            requireCompound(at === 0, 'UNEXPECTED_TRANSITION');
            // Route selection precedes any input. The complete path is one
            // leaf press, not a fictitious prefix of opened parent menus.
            receipt.steps.splice(1);
            step.transition = 'menu.direct';
            receipt.menuMechanism = 'accessibility-leaf';
          }
          await within(() => record('prepared', { execution, index: at }), deadline);
          // All intermediate inputs and their data provenance pass the parent's
          // policy/flow coordinator, not just the outer compound name.
          requireCompound(await within(() => admission.admit({ witness, before: prepared.before, intent }), deadline) === true,
            'APP_POLICY_REFUSED');
          authority(intent, stamp, deadline, binding, execution);
          const grant = Object.freeze({});
          grants.set(grant, { witness, execution, index: at, expires: deadline, consumed: false });
          await within(() => record('dispatch-intent', { execution, index: at }), deadline);
          authority(intent, stamp, deadline, binding, execution);
          reservation.dispatched(reserved, execution);
          const result = await within(() => {
            // Parent records potential dispatch immediately before crossing the
            // transport. A local fence refusal has not sent a helper request.
            Object.assign(step, { beforeReadId: witness.beforeReadId, attempts: 1, delivery: 'unknown',
              effect: 'unresolved', expected: witness.kind }); outstanding = at;
            return helper.execute(grant, at);
          }, deadline);
          requireCompound(result?.index === at && [0, 1].includes(result.attempts) &&
            ['not-sent', 'sent-unverified', 'sent-verified', 'unknown'].includes(result.delivery) &&
            typeof result.effectObserved === 'boolean', 'INVALID_DELIVERY');
          await within(() => record('received', { execution, index: at }), deadline);
          Object.assign(step, { attempts: result.attempts, delivery: result.delivery, effect: result.effect,
            effectObserved: result.effectObserved, ...(result.afterReadId ? { afterReadId: result.afterReadId } : {}) });
          if (!result.effectObserved) {
            reason = code({ code: result.reason });
            if (reason === 'ACTION_UNCONFIRMED' && result.after) {
              authority(intent, stamp, deadline, binding, execution);
              requireCompound(await within(() => admission.observe({ witness, observation: result.after, receipt: result }), deadline) === true, 'FLOW_REFUSED');
              current = result.after;
            }
            break;
          }
          authority(intent, stamp, deadline, binding, execution);
          current = result.after;
          requireCompound(await within(() => admission.observe({ witness, observation: result.after, receipt: result }), deadline) === true, 'FLOW_REFUSED');
          await within(() => record('acknowledge', { execution, index: at }), deadline);
          requireCompound(await within(() => admission.acknowledge({ execution, index: at }), deadline) === true, 'RECEIPT_FAILED');
          authority(intent, stamp, deadline, binding, execution);
          helper.acknowledge(at, result); outstanding = undefined;
          reservation.acknowledged(reserved, execution);
        }
        if (!reason) {
          if (intent.operation === 'prepareSaveAs') {
            requireCompound(helper.preparedDestination, 'DESTINATION_UNVERIFIED'); state = 'prepared';
          } else state = 'completed';
          if (receipt.menuMechanism === 'accessibility-leaf')
            receipt.detail = 'Pressed the menu item through Accessibility without opening the menu.';
        }
      } catch (error) { reason = code(error); }
      if (reason) {
        state = receipt.steps.some(s => s.attempts > 0 && !s.effectObserved) ? 'uncertain' : 'stopped';
        helper?.stop(reason); generation++;
        try { admission.invalidate({ execution, reason }); } catch { /* Continuation is already locally invalid. */ }
      }
      if (outstanding !== undefined && reason && receipt.steps[outstanding].effectObserved) {
        // An unacknowledged reply cannot authorize a successor. Retain delivery
        // evidence, but keep the required semantic effect unresolved.
        receipt.steps[outstanding].effectObserved = false;
        receipt.steps[outstanding].effect = 'acknowledgment-unavailable'; state = 'uncertain';
      }
      let retired = !helper;
      try {
        if (helper) retired = await within(() => helper.retire(), now() + 3000, 3000);
      } catch { retired = false; }
      receipt.transportRetired = retired;
      if (reserved && retired) {
        try { await reservation.release(reserved, execution); }
        catch { receipt.reservationRetained = true; }
      } else if (reserved) receipt.reservationRetained = true;
      if (!retired && !reason) {
        reason = 'HELPER_FAILED'; state = 'uncertain'; generation++;
        try { admission.invalidate({ execution, reason }); } catch { /* Local continuation is already invalid. */ }
      }
      const redact = ['APP_DECLINED', 'APP_BLOCKED', 'PERMISSIONS_UNAVAILABLE', 'REPL_CELL_ENDED', 'AUTHORITY_CHANGED'].includes(reason);
      lastResult = finishCompoundReceipt(receipt, { state, reason, index: Math.min(at, receipt.steps.length - 1),
        observation: reason && reason !== 'ACTION_UNCONFIRMED' ? undefined : current, redact });
      try { await within(() => record('final-encode', { execution }), now() + 100, 100); encodeCompoundReceipt(lastResult); }
      catch {
        // The acknowledged prefix survives a formatting/journal failure. The
        // fixed receipt remains available to the parent, without a current view.
        lastResult.observation = { status: 'unavailable', reason: 'RECEIPT_FAILED' };
        lastResult.encodingFailed = true;
      }
      return structuredClone(lastResult);
    },
    cancel() { cancelled = 'USER_STOPPED'; generation++; helper?.stop(cancelled); },
    get receipt() { return lastResult && structuredClone(lastResult); },
  });
}
