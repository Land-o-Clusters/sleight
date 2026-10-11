import { randomBytes } from 'node:crypto';
import { tasks, counts } from './tasks.mjs';

export function markerFor(task) {
  return task.mode === 'calculate' ? String(10000000 + randomBytes(4).readUInt32BE() % 90000000)
    : `BATTERY-${randomBytes(12).toString('hex')}`;
}
export function promptFor(task, ctx) {
  const target = ctx.target ?? (task.fixtureKind === 'doc-file' ? `<fixture>/${task.id}.${task.format}`
    : task.fixtureKind === 'web-page' ? 'http://127.0.0.1:<port>/fixture' : undefined);
  return `Use ${task.app} (${task.bundle}) only. ${ctx.scripted ? 'Read the fixture seeded through local app scripting. Leave its marker visible for a single engine read.' : task.goal}\nMode: ${ctx.scripted ? 'read' : task.mode}.` +
    (target ? `\nFixture: ${target}` : `\nFixture marker: ${ctx.marker}`) +
    (task.mode === 'calculate' ? `\nCalculate ${ctx.marker} + 0 and leave the result visible.` : '') +
    (task.mode === 'create' && !ctx.scripted ? '\nUse a new local benchmark item only, without invitations, notifications, sharing or account settings. If a local fixture is unavailable, stop.' : '') +
    '\nUse computer-use tools only, no shell, file APIs, scripts, network requests or other apps. Never send, post, delete or change settings. Do not close or quit apps. Stop at any permission or sign-in prompt. Return only JSON with marker (and sender and time for self-message).';
}
export function selectTasks({ ownerPresent = false, wanted } = {}) {
  if (wanted?.some(id => !tasks.some(t => t.id === id))) throw new Error('unknown battery task');
  const selected = tasks.filter(t => !wanted || wanted.includes(t.id));
  if (wanted && !ownerPresent && selected.some(t => t.ownerPresent)) throw new Error('selected tasks require --owner-present');
  return selected.filter(t => ownerPresent || !t.ownerPresent);
}
export function plan({ ownerPresent = false, wanted, runs = 1, markers = {}, localFixtures = {} } = {}) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('runs must be an integer from 1 to 100');
  const selected = selectTasks({ ownerPresent, wanted });
  const seeds = Object.fromEntries(selected.map(t => [t.id, markers[t.id] ?? markerFor(t)]));
  for (const marker of Object.values(seeds)) if (!/^(?:BATTERY-[a-f0-9]{24}|[1-9][0-9]{7})$/.test(marker)) throw new Error('invalid fixture marker');
  const rows = [];
  let pair = 0;
  for (let run = 1; run <= runs; run++) for (const task of selected) {
    const marker = seeds[task.id], prompt = promptFor(task, { marker, scripted: Boolean(task.scripting && localFixtures[task.id]) });
    const arms = pair++ % 2 ? ['codex', 'sleight'] : ['sleight', 'codex'];
    for (const arm of arms) rows.push({ task: task.id, app: task.app, bundle: task.bundle, run, arm,
      fixtureKind: task.fixtureKind, checkKind: task.checkKind, ownerPresent: task.ownerPresent, marker, prompt });
  }
  return { suite: 'battery', dryRun: true, counts: counts(selected), catalogCounts: counts(tasks),
    excluded: tasks.filter(t => !wanted && !selected.includes(t)).map(t => ({ task: t.id, reason: 'requires --owner-present' })),
    seedMarkers: seeds, ownerSetup: selected.filter(t => t.fixtureKind === 'self-message' || (t.fixtureKind === 'app-state' && t.mode === 'read'))
      .map(t => ({ task: t.id, marker: seeds[t.id], action: t.fixtureKind === 'self-message'
        ? 'Owner posts this to themself once before the pass. The runner never posts.'
        : 'Owner makes this marker visible in an isolated item before the pass. The runner reads only.' })),
    telemetry: ['pass', 'seconds', 'turns', 'modelMs (null when unavailable)', 'footprint', 'calls with waste classes', 'window order and frontmost bundle every 200 ms'],
    cleanup: 'Close only retained fixture windows; quit only the exact app process this run launched; stop if cleanup is unconfirmed.',
    runs: rows };
}
