import { compoundFixture } from './compound-runtime.mjs';

// Bounded schedule enumeration over the real parent/helper. Each schedule
// replays from a clean fake world; there is no second model of their guards.
export async function exploreCompound({ operation, depth = 192 }) {
  if (!['menu', 'choose'].includes(operation) || !Number.isInteger(depth) || depth < 1 || depth > 256) throw Error('invalid explorer bound');
  const states = new Set(), edges = new Set(), limits = new Map(), failures = new Map(), kinds = new Set();
  let executions = 0, transitions = 0, maximumDepth = 0, schedulesFired = 0;
  async function run(schedule, order = [0, 1]) {
    executions++;
    const world = { owner: undefined, people: false, revoked: false, writer: false, changedAt: -1,
      personAt: -1, revokedAt: -1, leaseAt: -1, reservationLostAt: -1, leaseExpected: [], lastRead: [-1, -1], latched: [false, false], trace: [], fired: new Set() };
    const hs = [0, 1].map(seat => compoundFixture(operation, { scheduler: async (h, phase, nth) => {
      if (world.trace.length >= depth) { h.parent.cancel(); return; }
      const tick = world.trace.length, site = { seat, phase, nth };
      world.trace.push(site);
      for (let i = 0; i < schedule.length; i++) {
        const event = schedule[i];
        if (world.fired.has(i) || event.seat !== seat || event.phase !== phase || event.nth !== nth) continue;
        world.fired.add(i); schedulesFired++;
        if (event.kind === 'person') {
          world.people = true; world.personAt = tick;
          for (const x of hs) { x.sequence++; x.lastInput = x.time; }
        } else if (event.kind === 'revoke') {
          world.revoked = true; world.revokedAt = tick; for (const x of hs) x.auth.approved = false;
        } else if (event.kind === 'lease') {
          world.leaseAt = tick; for (const x of hs) x.auth.lease.token = 'rotated';
        } else if (event.kind === 'reservation-loss') {
          world.owner = undefined; world.reservationLostAt = tick;
        } else if (event.kind === 'recipient') {
          world.changedAt = tick;
          for (const x of hs) { x.trueRecipient = 'document-B'; x.snapshot.context.commandTarget = 'document-B'; x.snapshot.epoch++; }
        } else if (event.kind === 'writer') {
          world.writer = true; world.changedAt = tick;
          for (const x of hs) { x.trueRecipient = 'document-B'; x.snapshot.binding.document = 'document-B'; x.snapshot.epoch++; }
        }
      }
      if (phase === 'person' && world.people) world.latched[seat] = true;
      if (phase === 'read') world.lastRead[seat] = tick;
      if (phase === 'perform') {
        const primitive = h.calls.filter(p => p === 'perform').length;
        let violation;
        if (world.people && world.personAt < tick) violation = world.latched[seat] ? 'dispatch-after-person-latch' : 'dispatch-after-physical-input';
        else if (world.revoked && world.revokedAt < tick || world.leaseAt < tick && world.leaseExpected[seat] !== h.auth.lease.token) violation = 'dispatch-after-revocation';
        else if (world.owner !== seat && world.reservationLostAt < tick) violation = 'dispatch-without-app-reservation';
        else if (world.owner !== seat) {
          if (!limits.has('reservation-lost-after-final-validation')) limits.set('reservation-lost-after-final-validation', [...world.trace]);
        }
        else if (h.trueRecipient !== 'document-A' && world.lastRead[seat] >= world.changedAt) violation = 'dispatch-after-observed-recipient-change';
        else if (h.trueRecipient !== 'document-A') {
          if (!limits.has('recipient-changed-after-final-AX-read')) limits.set('recipient-changed-after-final-AX-read', [...world.trace]);
        }
        if (violation && !failures.has(violation)) failures.set(violation, { schedule, trace: [...world.trace], primitive });
      }
      const state = JSON.stringify({ operation, site, owner: world.owner, people: world.people, revoked: world.revoked,
        writer: world.writer, latched: world.latched, hs: hs.map(x => ({ inputs: x.mutations.length, epoch: x.snapshot.epoch,
          document: x.snapshot.binding.document, approval: x.auth.approved, lease: x.auth.lease.token,
          invalidated: x.invalidated, reservation: x.reservationHeld })) });
      states.add(state); transitions++;
      if (world.lastState) edges.add(world.lastState + '\n' + state);
      world.lastState = state;
    } }));
    for (let seat = 0; seat < hs.length; seat++) {
      const h = hs[seat];
      h.reservation.acquire = async () => {
        await h.phase('reserve');
        if (world.owner !== undefined) return false;
        world.owner = seat; world.leaseExpected[seat] = h.auth.lease.token; h.reservationHeld = true; return { seat };
      };
      h.reservation.validate = token => world.owner === seat && token.seat === seat;
      h.reservation.release = async () => { await h.phase('release'); if (world.owner === seat) world.owner = undefined; h.reservationHeld = false; };
      const perform = h.provider.perform;
      h.provider.perform = async request => { kinds.add(h.evidence.get((operation === 'menu' ?
        request.node === 'edit' ? 'menu.open' : request.node === 'find' ? 'menu.expand' : 'menu.command' :
        request.node === 'control' ? 'choose.open' : 'choose.select') + ':' + request.node)?.kind); return perform(request); };
    }
    await Promise.all(order.map(seat => hs[seat].run()));
    maximumDepth = Math.max(maximumDepth, world.trace.length);
    return world.trace;
  }
  const baseline = await run([]);
  const events = ['person', 'revoke', 'lease', 'writer', 'reservation-loss'];
  // Every reachable baseline provider/parent hook is an injection point.
  for (const site of baseline) for (const kind of events) await run([{ ...site, kind }]);
  // The recipient changes after preparation, before the execute re-read.
  // Binding remains stable, as with a same-window command-target change.
  for (const site of baseline.filter(s => s.phase === 'admit')) await run([{ ...site, kind: 'recipient' }]);
  // Pairwise adversarial events around each dispatch, with both acquisition
  // orders. These are bounded schedules, not exhaustive arbitrary app behavior.
  const critical = baseline.filter(s => ['admit', 'before-input', 'observe'].includes(s.phase));
  for (const first of critical) for (const second of critical) if (baseline.indexOf(first) < baseline.indexOf(second))
    for (const [a, b] of [['person', 'writer'], ['revoke', 'person'], ['writer', 'lease']])
      for (const order of [[0, 1], [1, 0]]) await run([{ ...first, kind: a }, { ...second, kind: b }], order);
  return { operation, states: states.size, transitions, distinctTransitions: edges.size, depth: maximumDepth, bound: depth,
    schedules: executions, eventsFired: schedulesFired, kinds: [...kinds].filter(Boolean).sort(),
    invariantFailures: failures.size, counterexamples: [...failures].map(([violation, detail]) => ({ violation, ...detail })),
    residualLimits: [...limits].map(([limit, trace]) => ({ limit, trace })) };
}
