// Explicit hand-on replay adapter. Importing it does not compile, launch or inspect the desktop.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../..', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const jsonLines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function assertHandAway({ exists = existsSync, ownerAwayFile = process.env.SLEIGHT_OWNER_AWAY_FILE } = {}) {
  if (typeof ownerAwayFile !== 'string' || !ownerAwayFile || !exists(ownerAwayFile))
    throw Error('Hand-on replay requires an owner-away marker file (--owner-away-file or SLEIGHT_OWNER_AWAY_FILE)');
}

export function assertSideHosts(sides) {
  if (sides.size !== 2) throw Error('Hand-on replay needs two separately built sides');
  const [a, b] = [...sides.values()];
  if (a.build.worktree === b.build.worktree || a.cache === b.cache || a.binaries.host === b.binaries.host ||
      [...sides.values()].some(side => side.identity.worktree !== side.build.worktree ||
        !side.binaries.host.startsWith(side.cache + '/') || !side.binaries.sampler.startsWith(side.cache + '/')))
    throw Error('Hand-on replay sides must not share a host build or cache');
}

export function handClientSpec(name, spec, hand, worktree) {
  if (name !== 'plugin:sleight:computer') throw Error('Hand-on replay accepts only the native computer server');
  if (hand.worktree !== worktree || !hand.binary || !hand.config) throw Error('Hand-on replay side does not match server worktree');
  return { ...spec, command: process.execPath, args: [join(root, 'bench/replay/hand-server.mjs'), hand.config],
    env: { ...spec.env, SLEIGHT_HAND: '1', SLEIGHT_CURSOR_STYLE: 'sprite', SLEIGHT_RUNTIME: 'engine', SLEIGHT_TURBO: '0' } };
}

export function assertHandClient(spec, hand) {
  if (spec.env?.SLEIGHT_HAND !== '1' || spec.args?.[0] !== join(root, 'bench/replay/hand-server.mjs') || spec.args?.[1] !== hand.config)
    throw Error('Hand-on replay must not fall back to the hand-off launcher');
}

export async function prepareHandSides(variants, out, signal, { load = path => import(path), createGuard, preflight,
  ownerAwayFile, assertAway = () => assertHandAway(ownerAwayFile === undefined ? {} : { ownerAwayFile }), validateOutput = path => {
    if (!realpathSync(path).startsWith('/private/tmp/')) throw Error('Hand-on replay output must be under real /private/tmp');
  } } = {}) {
  assertAway(); validateOutput(out);
  const { stageRunGuard } = await import('../hand/stage-live.mjs');
  const { idleSeconds } = await import('../compat/live.mjs');
  const guard = (createGuard ?? stageRunGuard)({ timeoutMs: 120 * 60 * 1000 });
  const abort = () => guard.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const boundary = async boundarySignal => {
    assertAway(); boundarySignal?.throwIfAborted();
    if (existsSync('/tmp/sleight-hold')) throw Error('Hand-on replay stopped: /tmp/sleight-hold exists');
    if (preflight) return preflight();
    await handPreflight({ execute: guard.execute, readIdle: idleSeconds, signal: boundarySignal,
      recordWait: row => appendFileSync(join(out, 'waits.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 }) });
  };
  const close = async () => { signal?.removeEventListener('abort', abort); await guard.close(); };
  try {
    await boundary(signal);
    const sides = new Map();
    for (const step of variants) {
      assertAway(); signal?.throwIfAborted();
      const worktree = realpathSync(step.build.worktree), cache = join(out, `hand-build-${step.variant}`);
      mkdirSync(cache, { mode: 0o700 });
      const source = join(worktree, 'plugins/sleight/lib/direct-browser/native/consent-host.swift');
      const module = await load(pathToFileURL(join(worktree, 'bench/hand/check4-build.mjs')).href);
      if (realpathSync(module.HOST) !== source) throw Error('Private host builder does not belong to selected worktree');
      const sourceSHA256 = hashFile(source);
      const binaries = await module.buildCheck4(cache, guard.execute);
      if (hashFile(source) !== sourceSHA256) throw Error('Host source changed during build');
      const mabel = await module.prepareMabel(cache);
      const identity = { ...step.build, worktree, sourceSHA256, binarySHA256: hashFile(binaries.host),
        samplerSHA256: hashFile(binaries.sampler), cache, character: mabel.identity };
      save(join(cache, 'identity.json'), identity);
      sides.set(step.variant, { build: step.build, cache, binaries, mabel, identity });
    }
    assertSideHosts(sides);
    return { sides, boundary, close };
  } catch (error) { await close(); throw error; }
}

// Kept outside check4-live: that driver imports run.mjs, so importing it here would deadlock the CLI.
export async function handPreflight({ execute, readIdle, signal, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, recordWait = () => {} }) {
  let closed = false;
  try { await execute('/usr/bin/pgrep', ['-x', 'Calculator'], { timeout: 10000, killSignal: 'SIGKILL' }); }
  catch (error) { if (error.code !== 1) throw error; closed = true; }
  if (!closed) throw Error('Hand-on replay requires Calculator to be closed');
  const began = now();
  for (;;) {
    signal?.throwIfAborted();
    const idle = await readIdle();
    if (Number.isFinite(idle) && idle >= 30) break;
    if (now() - began >= 120000) throw Error(`Hand-on replay owner-return guard: HID idle ${idle ?? 'unknown'} s; needs 30 s`);
    await wait(1000);
  }
  if (now() - began > 1000) recordWait({ kind: 'idle', began, ended: now() });
}

// The sampler and JXA drag phases use the same monotonic system clock. Wall times only bind a call and approval.
export function dragHandEvidence(calls, rows, wire, trace) {
  return calls.filter(call => call.name === 'drag').map(call => {
    const from = Date.parse(call.startedAt), to = Date.parse(call.finishedAt);
    const samples = rows.filter(row => row.epochMs >= from && row.epochMs <= to);
    const events = trace.filter(row => Date.parse(row.t) >= from && Date.parse(row.t) <= to);
    const phases = events.filter(row => row.direction === 'drag-phase').map(row => row.msg);
    const starts = phases.filter(row => row.phase === 'ax-move' && row.edge === 'start');
    const ends = phases.filter(row => row.phase === 'ax-move' && row.edge === 'end');
    const start = starts.length === 1 ? starts[0].monoMs : null, end = ends.length === 1 ? ends[0].monoMs : null;
    const offset = samples.length ? samples.reduce((sum, row) => sum + row.epochMs - row.t, 0) / samples.length : null;
    const approvals = events.filter(row => row.direction === 'local-approval' && row.msg?.action === 'accept' && /"drag"/.test(row.msg.key ?? ''));
    const approvalAtMs = approvals.length === 1 ? Date.parse(approvals[0].t) : null;
    const before = rows.findLast(row => row.t <= start), after = rows.find(row => row.t >= end);
    const movement = start !== null && end >= start && before && after ? rows.filter(row => row.t >= before.t && row.t <= after.t) : [];
    const covered = movement.length >= 2 && movement[0].t <= start && movement.at(-1).t >= end &&
      movement.every((row, i) => row.valid === true && (!i || row.t - movement[i - 1].t <= 100));
    const seated = row => row.status?.shown === true && row.panel?.onScreen === true && typeof row.status.seat === 'string' && row.status.seat.length > 0 &&
      ['stage', 'three-quarter', 'medium', 'small'].includes(row.status.size);
    const requests = wire.filter(row => row.event === 'request' && row.requestedAtMs >= from && row.requestedAtMs <= to);
    const acknowledgements = requests.map(request => {
      const ack = wire.find(row => row.event === 'ack' && row.id === request.id && row.hostPid === request.hostPid);
      return { ...request, acknowledgedAtMs: ack?.acknowledgedAtMs ?? null, ackMs: ack?.ackMs ?? null, kind: ack?.kind ?? null };
    });
    return { index: call.index, movementStartMonoMs: start, movementEndMonoMs: end, samples: movement.length, covered,
      seatKinds: [...new Set(movement.map(row => row.status?.seat))], rungs: [...new Set(movement.map(row => row.status?.size))],
      stayedSeated: covered ? movement.every(seated) : null, panelContacts: movement.reduce((n, row) => n + (row.intersections?.length ?? 0), 0),
      approvalAtMs, approvalToAXStartMs: approvalAtMs !== null && offset !== null && start !== null ? start + offset - approvalAtMs : null,
      placement: acknowledgements, placedAcknowledgements: acknowledgements.filter(row => row.placed && row.kind === 'placed-ready').length,
      placementAckMs: acknowledgements.filter(row => row.placed && row.kind === 'placed-ready').map(row => row.ackMs) };
  });
}

export function handRunEvidence({ side, calls, rows, wire, trace, collection, samplerExit }) {
  const hosts = collection?.hosts ?? [];
  const cleanupConfirmed = collection?.collected === true && hosts.every(host => host.collected === true) && samplerExit?.code === 0;
  const drags = dragHandEvidence(calls, rows, wire, trace);
  const observed = hosts.length > 0 && rows.some(row => row.valid === true && hosts.some(host => host.pid === row.status?.pid));
  return { mode: 'hand-on', identity: side.identity, hosts, samplerExit, cleanupConfirmed, observed, drags,
    verdict: cleanupConfirmed && observed && drags.length > 0 && drags.every(row => row.covered) ? 'measured' : 'unmeasured' };
}

export async function handIteration({ side, dir, prepared, signal, drive, ownerAwayFile }) {
  const handAway = () => assertHandAway(ownerAwayFile === undefined ? {} : { ownerAwayFile });
  handAway();
  if (hashFile(side.binaries.host) !== side.identity.binarySHA256 || hashFile(side.binaries.sampler) !== side.identity.samplerSHA256)
    throw Error('Hand-on replay binary identity changed');
  const { stageRunGuard, jsonChild } = await import('../hand/stage-live.mjs');
  const guard = stageRunGuard({ timeoutMs: 15 * 60 * 1000 });
  const abort = () => guard.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const status = join(dir, 'host-status.json'), tracePath = join(dir, 'host-trace.json'), collectionPath = join(dir, 'host-collection.json');
  const wirePath = join(dir, 'host-wire.jsonl'), pids = join(dir, 'task-pids.json'), config = join(dir, 'hand-server.json');
  save(pids, { pids: [] });
  save(config, { worktree: side.build.worktree, binary: side.binaries.host, character: side.mabel.folder,
    status, trace: tracePath, collection: collectionPath, wire: wirePath });
  const setup = prepared.native.definition.setup;
  prepared.native.definition = { ...prepared.native.definition, setup: async ctx => {
    await setup(ctx);
    save(pids, { pids: Object.values(ctx).flatMap(value => value && typeof value === 'object' && Number.isSafeInteger(value.pid) ? [value.pid] : []) });
  } };
  let sampler, samplerExit, result, failed;
  try {
    sampler = jsonChild(side.binaries.sampler, ['--status', status, '--pids', pids], {}, { spawnChild: (...args) => guard.spawn(...args) });
    sampler.child.stdout.on('data', chunk => appendFileSync(join(dir, 'sampler.jsonl'), chunk, { mode: 0o600 }));
    await sampler.wait(row => Number.isFinite(row.t) && Number.isFinite(row.epochMs), 5000);
    result = await drive({ clientOptions: { hand: { worktree: side.build.worktree, binary: side.binaries.host, config } },
      beforeDrive: async () => { handAway(); },
      afterDrive: async () => { /* Host and sampler remain up until normal server collection. */ } });
  } catch (error) { failed = error; }
  finally {
    try { samplerExit = sampler ? { ...await sampler.close(), pid: sampler.pid } : undefined; }
    finally { signal?.removeEventListener('abort', abort); await guard.close(); }
  }
  const rows = sampler?.rows.filter(row => row.source === 'CGWindowListCopyWindowInfo') ?? [];
  const trace = readdirSync(dir).filter(name => /^trace-\d+\.jsonl$/.test(name)).flatMap(name => jsonLines(join(dir, name)));
  const hand = handRunEvidence({ side, calls: result?.calls ?? [], rows, wire: jsonLines(wirePath), trace,
    collection: existsSync(collectionPath) ? json(collectionPath) : null, samplerExit });
  save(join(dir, 'hand-result.json'), hand);
  if (failed) { failed.hand = hand; throw failed; }
  result.hand = hand;
  result.cleanupConfirmed &&= hand.cleanupConfirmed;
  if (hand.verdict !== 'measured') { result.verdict = 'diverge'; result.reason = 'Hand-on replay did not measure the owned character across every drag'; }
  return result;
}
