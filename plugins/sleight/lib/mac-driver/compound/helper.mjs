import { sessionMenuRequestAllowed } from '../../session-menu.mjs';
import { COMPOUND_LIMITS, compoundFault, freezeCompound, requireCompound } from './intent.mjs';
import { compoundBinding, compoundDomain, compoundDigest, compoundEqual, compoundMeaning,
  resolveCompoundExact, validateCompoundObservation } from './observation.mjs';
import { classifyCompoundTarget } from './boundary.mjs';
import { createCompoundPersonWatch } from './person.mjs';
import { exactPreparedDestination, NO_COMPOUND_CONTRACTS } from './contracts.mjs';
import { resolveUnopenedMenu } from './menu.mjs';

// The helper half has no policy, approval, lease creation, renderer or generic
// native-method interface. An embedding transport must retain this instance
// across RPCs. Production does not register that transport in this change.
export function createCompoundHelper({ execution, intent, binding, provider, contracts = NO_COMPOUND_CONTRACTS,
  now, deadline, authorizeRead, consume, revalidate = () => {}, cosmeticTitle = false, application, menuRequests = () => [] }) {
  const bound = compoundBinding(binding), person = createCompoundPersonWatch(() => provider.person());
  const classify = request => classifyCompoundTarget({ ...request, application, menuRequests: menuRequests() });
  let index = 0, readId = 0, previous, prepared, pending, terminal, busy = false, control, menuRoute;
  const receipts = new Map();
  const check = async () => {
    requireCompound(!terminal, terminal ?? 'COMPOUND_STOPPED');
    requireCompound(now() < deadline, 'DEADLINE_EXCEEDED'); await person.check();
    requireCompound(now() < deadline, 'DEADLINE_EXCEEDED');
  };
  const read = async () => {
    await check();
    // Inventory is metadata only. A new Save child is authorized and leased
    // before its contents enter the complete observation.
    const inventory = await provider.inventory();
    requireCompound(inventory?.complete === true && Array.isArray(inventory.panels) && Array.isArray(inventory.modals), 'OBSERVATION_INCOMPLETE');
    requireCompound(inventory.modals.length === 0, 'MODAL_APPEARED');
    if (inventory.panels.length) {
      requireCompound(intent.operation === 'prepareSaveAs' && inventory.panels.length === 1, 'MODAL_APPEARED');
      const panel = inventory.panels[0];
      requireCompound(panel.ownerProved === true, 'OWNER_UNPROVEN');
      requireCompound(panel.pid === bound.pid && panel.processStart === bound.processStart &&
        panel.attachedTo === bound.document && typeof panel.token === 'string' && panel.standard === true, 'PANEL_UNPROVEN');
    }
    await authorizeRead({ binding: bound, inventory, execution, index }); await check();
    const snapshot = validateCompoundObservation(await provider.read({ binding: bound, deadline }), bound, readId);
    readId = snapshot.readId; await check(); return snapshot;
  };
  const sameMeaning = (a, b) => {
    a = compoundMeaning(a); b = compoundMeaning(b);
    if (cosmeticTitle) { delete a.title; delete b.title; }
    return compoundEqual(a, b);
  };
  const serial = async action => {
    requireCompound(!busy, 'COMPOUND_BUSY'); busy = true;
    try { return await action(); }
    catch (error) { stop(error.code ?? 'HELPER_FAILED'); throw error; }
    finally { busy = false; }
  };
  function stop(reason) { terminal ??= reason; prepared = undefined; }
  function transition(snapshot) {
    if (intent.operation === 'menu') {
      if (index === 0 && menuRoute !== 'lazy') {
        const direct = resolveUnopenedMenu(snapshot, intent.segments);
        if (direct) {
          menuRoute = 'direct';
          return { kind: 'menu.direct', ...direct };
        }
        requireCompound(menuRoute !== 'direct', 'WITNESS_CHANGED');
        menuRoute = 'lazy';
      }
      const owner = index === 0 ? bound.root : pending?.nodeToken;
      const domain = compoundDomain(snapshot, 'menu', owner);
      const node = resolveCompoundExact(snapshot, domain, intent.segments[index]);
      return { kind: index === 0 ? 'menu.open' : index === intent.segments.length - 1 ? 'menu.command' : 'menu.expand', node };
    }
    if (intent.operation === 'choose') {
      const node = snapshot.nodes.find(n => n.token === control.token);
      requireCompound(node && node.role === control.role && node.identifier === control.identifier &&
        node.parent === control.parent && node.enabled && !node.secure, 'STALE_CONTROL');
      if (index === 0) {
        requireCompound(node.title === control.title && node.description === control.description && node.value === control.value,
          'STALE_CONTROL');
        if (snapshot.selection?.complete === true && snapshot.selection.control === node.token &&
          snapshot.selection.source === intent.option.source && snapshot.selection.label === intent.option.label)
          return { noop: 'already-selected', all: true };
        requireCompound(node.role === 'AXPopUpButton' && !node.expanded, 'UNSUPPORTED_TRANSITION');
        return { kind: 'choose.open', node };
      }
      const domain = compoundDomain(snapshot, 'options', control.token);
      return { kind: 'choose.select', node: resolveCompoundExact(snapshot, domain, intent.option), control: node.token };
    }
    if (index === 0) {
      if (snapshot.panel) {
        compoundDomain(snapshot, 'panel', bound.root);
        requireCompound(snapshot.panel.standard === true && snapshot.panel.attachedTo === bound.document &&
          snapshot.panel.pid === bound.pid && snapshot.panel.processStart === bound.processStart &&
          snapshot.panel.acquired === true, 'PANEL_UNPROVEN');
        return { noop: 'acquired-panel-observed' };
      }
      const node = snapshot.nodes.find(n => n.token === snapshot.saveOpener);
      requireCompound(node && node.role === 'AXMenuItem' && node.enabled && !node.secure, 'UNSUPPORTED_TRANSITION');
      return { kind: 'save.open', node };
    }
    const domain = compoundDomain(snapshot, 'panel', bound.root), panel = snapshot.panel;
    requireCompound(panel?.standard === true && panel.attachedTo === bound.document && panel.pid === bound.pid &&
      panel.processStart === bound.processStart && panel.acquired === true, 'PANEL_UNPROVEN');
    requireCompound(panel.conflict === false && panel.authentication === false, 'BOUNDARY_REQUIRED');
    const field = index === 1 ? panel.directoryField : panel.basenameField;
    const node = snapshot.nodes.find(n => n.token === field && n.parent === domain.container);
    requireCompound(node && node.role === 'AXTextField' && node.enabled && !node.secure &&
      node.actions.includes('AXSetValue'), 'UNSUPPORTED_TRANSITION');
    return { kind: index === 1 ? 'save.directory' : 'save.basename', node,
      value: index === 1 ? intent.directory : intent.basename };
  }
  return Object.freeze({
    prepare: () => serial(async () => {
      await check(); requireCompound(!prepared, 'STEP_AWAITING_EXECUTE');
      // Initial numbers are consumed only by the delivered-reference adapter.
      // They never reach the later scoped label resolver.
      if (intent.operation === 'choose' && !control) {
        control = freezeCompound(structuredClone(await provider.resolveDelivered(intent.control)));
        requireCompound(control && typeof control.token === 'string' && control.readId === intent.control.readId,
          'STALE_CONTROL');
      }
      const before = await read();
      // An unavailable Apple leaf must refuse before the lazy route opens its
      // ancestors. Literal intent is used only to restrict, never to grant input.
      if (intent.operation === 'menu' && /^(?:Apple|)(?: menu)?$/i.test(intent.segments[0]?.label ?? ''))
        for (const selector of intent.segments.slice(1))
          requireCompound(sessionMenuRequestAllowed(selector.label, { app: application, apple: true }, menuRequests()), 'BOUNDARY_REQUIRED');
      if (previous) requireCompound(sameMeaning(previous, before), 'CONTEXT_DRIFT');
      const next = transition(before);
      if (next.noop) { previous = before; return { noop: next.noop, all: next.all === true, index, before }; }
      for (const node of next.path ?? [next.node])
        requireCompound(classify({ transition: { ...next, node }, snapshot: before, intent }) === 'local', 'BOUNDARY_REQUIRED');
      requireCompound(await provider.classify({ transition: next, snapshot: before, intent }) === 'local', 'BOUNDARY_REQUIRED');
      const evidence = await provider.mechanism(next.node.token, next.kind);
      const contract = contracts.resolve(evidence,
        { transition: next, snapshot: before, intent, binding: bound });
      requireCompound(next.node.actions.includes(contract.primitive === 'press' ? 'AXPress' : 'AXSetValue'), 'UNSUPPORTED_TRANSITION');
      const witness = freezeCompound({ execution, index, helper: bound.helper, beforeReadId: before.readId,
        digest: compoundDigest(compoundMeaning(before)), recipient: bound, nodeToken: next.node.token,
        kind: next.kind, primitive: contract.primitive, contract: contract.id,
        ...(next.value === undefined ? {} : { value: next.value }) });
      prepared = { witness, before, next, contract, evidence };
      return { witness, before };
    }),
    execute: (grant, ordinal) => serial(async () => {
      // Duplicate execute returns the retained disposition, including uncertainty.
      // A new helper has an empty map and cannot consume an old helper's grant.
      if (receipts.has(ordinal)) return structuredClone(receipts.get(ordinal));
      await check(); requireCompound(prepared && ordinal === index, 'STALE_GRANT');
      const step = prepared;
      const receipt = { index, beforeReadId: step.before.readId, attempts: 0, delivery: 'not-sent',
        effect: 'not-attempted', effectObserved: false, expected: step.contract.effectClass };
      let performing = false, returned = false;
      let after;
      try {
        const current = await read();
        requireCompound(compoundEqual(compoundMeaning(current), compoundMeaning(step.before)), 'WITNESS_CHANGED');
        const node = current.nodes.find(n => n.token === step.next.node.token);
        if (step.next.kind === 'menu.direct') {
          const resolved = resolveUnopenedMenu(current, intent.segments);
          requireCompound(resolved?.node.token === node?.token, 'WITNESS_CHANGED');
          for (const ancestor of resolved.path)
            requireCompound(classify({ transition: { ...step.next, node: ancestor }, snapshot: current, intent }) === 'local', 'BOUNDARY_REQUIRED');
        }
        requireCompound(node && await provider.mechanism(node.token, step.next.kind) === step.evidence, 'UNSUPPORTED_TRANSITION');
        requireCompound(step.contract.qualifies({ transition: step.next, snapshot: current, intent, binding: bound }) === true, 'UNSUPPORTED_TRANSITION');
        requireCompound(classify({ transition: { ...step.next, node }, snapshot: current, intent }) === 'local', 'BOUNDARY_REQUIRED');
        requireCompound(await provider.classify({ transition: step.next, snapshot: current, intent }) === 'local', 'BOUNDARY_REQUIRED');
        await check();
        // The parent's synchronous consume is the admission linearization point.
        // The platform still has a non-atomic check-to-action interval afterward.
        consume(grant, step.witness);
        await provider.phase?.('before-input');
        // Re-sample after every asynchronous dispatch hook and after consume.
        await check(); revalidate();
        for (const target of step.next.path ?? [node])
          requireCompound(classify({ transition: { ...step.next, node: target }, snapshot: current, intent }) === 'local', 'BOUNDARY_REQUIRED');
        receipt.attempts = 1; receipt.delivery = 'unknown'; receipt.effect = 'unresolved'; performing = true;
        const sent = await provider.perform({ primitive: step.contract.primitive, node: node.token,
          ...(step.next.value === undefined ? {} : { value: step.next.value }), deadline, binding: bound });
        returned = true;
        requireCompound(['sent-verified', 'sent-unverified', 'unknown', 'not-sent'].includes(sent?.delivery), 'INVALID_DELIVERY');
        receipt.delivery = sent.delivery;
        requireCompound(sent.delivery !== 'unknown' && sent.delivery !== 'not-sent', 'DELIVERY_UNRESOLVED');
        await provider.phase?.('after-input'); await check();
        const settled = await provider.settle({ binding: bound, deadline });
        requireCompound(settled?.settled === true && settled.personTookOver === false && settled.busy === false &&
          settled.capped === false, 'UNSETTLED');
        // Settle is readiness only. Its digest or notification basis never
        // replaces the fresh complete postcondition observation.
        after = await read();
        receipt.afterReadId = after.readId;
        const effect = step.contract.effect({ before: step.before, after, transition: step.next, intent, binding: bound });
        const effectFailure = ['OPTION_SET_INCOMPLETE', 'OWNER_UNPROVEN', 'DESTINATION_UNVERIFIED',
          'UNSUPPORTED_TRANSITION', 'OBSERVATION_INCOMPLETE'].includes(effect?.reason) ? effect.reason : 'EFFECT_UNVERIFIED';
        requireCompound(effect?.observed === true && typeof effect.code === 'string' && /^[a-z-]{1,80}$/.test(effect.code),
          step.next.kind === 'menu.direct' ? 'ACTION_UNCONFIRMED' : effectFailure);
        if (step.next.kind === 'save.basename') requireCompound(exactPreparedDestination(after, intent), 'DESTINATION_UNVERIFIED');
        receipt.effect = effect.code; receipt.effectObserved = true; receipt.afterReadId = after.readId;
        previous = after; pending = { nodeToken: step.next.node.token }; prepared = undefined;
        receipts.set(index, structuredClone(receipt));
        await provider.phase?.('reply');
        return { ...receipt, after };
      } catch (error) {
        if (receipt.effectObserved) { receipt.effectObserved = false; receipt.effect = 'observation-unavailable'; }
        if (performing && !returned && error.delivery === 'not-sent') receipt.delivery = 'not-sent';
        receipt.reason = error.code ?? 'HELPER_FAILED';
        stop(receipt.reason); receipts.set(index, structuredClone(receipt));
        return { ...receipt, ...(receipt.reason === 'ACTION_UNCONFIRMED' ? { after } : {}) };
      }
    }),
    acknowledge(ordinal, receipt) {
      requireCompound(!terminal && ordinal === index && receipt.effectObserved === true &&
        receipts.get(index)?.effectObserved === true, 'STALE_ACKNOWLEDGMENT');
      index++;
    },
    acknowledgeNoop(ordinal, all = false) {
      requireCompound(!terminal && ordinal === index && !prepared, 'STALE_ACKNOWLEDGMENT');
      index += all ? 2 : 1;
    },
    stop,
    async retire() { stop('HELPER_RETIRED'); return await provider.retire() === true; },
    get preparedDestination() { return exactPreparedDestination(previous, intent); },
    get index() { return index; },
  });
}
