// Dump-only inventory. The supplied host must be an offline consent-host build.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { host: { type: 'string' } } });
if (!values.host?.startsWith('/private/tmp/')) throw Error('private temporary host required');
const hostSha256 = createHash('sha256').update(readFileSync(values.host)).digest('hex');
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const keys = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
for (const size of ['small', 'medium', 'stage']) {
  const legacy = size === 'small';
  const input = [
    { hand: 'character', nonce, seq: 1, id: 'fixture', sheet: '/private/tmp/unused-parked-sheet.png', extra: null,
      cell: [192, 208], table: { idle: { ...entry, frames: 2 } }, size, stageAttention: false,
      perch: { anchor: [96, 150], table: Object.fromEntries(keys.map(k => [k, entry])) } },
    ...legacy ? [] : [{ dumpStageArt: true }, { dumpSchedule: true }],
    { dumpWorld: { windows: [{ id: 7, pid: 42, frame: [200, 500, 900, 350] }],
      displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
      pointer: [1750, 1150], inputAge: 20, pointerAway: 10, person: [1450, 700, 300, 300], cards: [] } },
    { hand: 'status', nonce, seq: 2, state: 'paused', pid: 42, windowId: 7, at: [650, 700] },
    { dumpClock: 1 }, { dumpStats: true }, { dumpClock: 62 }, { dumpStats: true },
  ];
  const run = spawnSync(values.host, ['--stage-dump', '--reduce-motion', ...legacy ? ['--legacy-perch'] : []],
    { input: input.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  if (run.error || run.status !== 0) throw Error(run.stderr || String(run.error ?? run.status));
  const rows = run.stdout.trim().split('\n').map(JSON.parse);
  const [before, after] = rows.filter(row => row.effect === (legacy ? 'legacy-stats' : 'stage-stats'));
  const delta = Object.fromEntries(Object.entries(after.wakeCounts).map(([key, value]) => [key, value - (before.wakeCounts[key] ?? 0)]));
  console.log(JSON.stringify({ hostSha256, size, seconds: 61, poll: after.poll, wakeCounts: delta, before, after }));
}
