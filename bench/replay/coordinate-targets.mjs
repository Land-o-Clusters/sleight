// Offline stdin replay. The fixture is the recording-sink executable built by
// mac-driver-pointer-core.test.mjs, never the installed helper or a GUI host.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { coordinateReplayCases } from '../../tests/fixtures/uc2d-coordinate.mjs';

export function replayCoordinates(cases, invoke) {
  const counts = { cells: cases.length, allowed: 0, refused: 0, wrong: 0 };
  for (const row of cases) {
    const result = invoke(row.input);
    if (row.code ? result.ok === false && result.error?.code === row.code && result.error.delivery === 'not-sent' && result.posts === 0
      : result.ok === true && result.posts === 2) counts[row.code ? 'refused' : 'allowed']++;
    else counts.wrong++;
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cases = coordinateReplayCases();
  if (args.length === 1 && args[0] === '--dry-run') {
    const recorded = JSON.parse(readFileSync(new URL('../../tests/fixtures/rt11f-replay.json', import.meta.url)));
    console.log(JSON.stringify({ syntheticCells: cases.length, expected: { allowed: 2, refused: 9, wrong: 0 },
      recordedNumberedActions: recorded.actions.length,
      recordedCoordinateCells: 0, reason: 'The RT11D bank has no coordinate frames, retained AX objects or pixel patches.' }));
  } else if (args.length === 2 && args[0] === '--fixture') {
    const result = replayCoordinates(cases, input => {
      const child = spawnSync(args[1], [], { input: JSON.stringify(input) + '\n', encoding: 'utf8',
        timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      if (child.status !== 0) throw Error('Coordinate fixture did not complete');
      return JSON.parse(child.stdout);
    });
    console.log(JSON.stringify(result)); process.exitCode = result.wrong ? 1 : 0;
  } else { throw Error('Use --dry-run or --fixture PATH_TO_POINTER_CORE_FIXTURE'); }
}
