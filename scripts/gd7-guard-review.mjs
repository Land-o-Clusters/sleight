// Offline before/after verdicts. Does not execute any candidate shell command.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture, ordinaryCommands, bypassBanks, refuses, conditionalDirectories, reviewOptions } from '../tests/fixtures/gd7-review-harness.mjs';
const guard = await import(pathToFileURL(resolve(process.argv[2] ?? 'plugins/sleight/hooks/preapproved-write-guard.mjs')));
const compare = process.argv[3] && await import(pathToFileURL(resolve(process.argv[3])));
const pinPath = process.argv[4] && resolve(process.argv[4]);
const f = fixture(), previousCwd = process.cwd(), verdicts = {};
process.chdir(f.options.cwd);
try {
  for (const [group, cases, options] of [['ordinary-real-fs', ordinaryCommands, f.options], ...Object.entries(bypassBanks).map(([name, cases]) => [name, cases, reviewOptions]), ['conditional-directories', conditionalDirectories, reviewOptions]]) {
    let refused = 0;
    const refusals = [], relaxed = [], allowedCommands = [];
    verdicts[group] = [];
    for (const command of cases) {
      const result = await refuses(guard, command, options);
      verdicts[group].push(result);
      if (result) { refused++; refusals.push(command); } else allowedCommands.push(command);
      if (compare && !result && await refuses(compare, command, options)) relaxed.push(command);
    }
    if (compare && group !== 'ordinary-real-fs' && relaxed.length) process.exitCode = 1;
    console.log(JSON.stringify({ group, cases: cases.length, refused, allowed: cases.length - refused, ...compare ? { relaxed } : {}, ...group.startsWith('W ') ? { allowedCommands } : {}, ...group === 'ordinary-real-fs' ? { refusals } : {} }));
  }
  if (pinPath) writeFileSync(pinPath, JSON.stringify({ source: 'f4c471620e7496e6c6bdb9b950905b754ff85600', verdicts }) + '\n');
} finally { process.chdir(previousCwd); f.close(); }
