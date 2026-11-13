// Offline verdict comparison only. Candidate commands are data, never executed.
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, switchCases, allows, timingShapes } from '../tests/fixtures/gd4-write-cases.mjs';
const modulePath = process.argv[2] ?? 'plugins/sleight/hooks/preapproved-write-guard.mjs';
const { preapprovedWriteDenied, loggingSwitchWriteDenied } = await import(pathToFileURL(resolve(modulePath)));
const options = { stat: async path => ({ realPath: path }), home: '/fixture', configDir: '/fixture/.claude', platform: 'darwin' };
const groups = {};
for (const { group, command } of cases) {
  const row = groups[group] ??= { cases: 0, refused: 0 };
  row.cases++;
  row.refused += Number(await preapprovedWriteDenied({ tool: 'Bash', command }, options));
}
groups['startup switches'] = { cases: switchCases.length, refused: switchCases.filter(command => loggingSwitchWriteDenied({ tool: 'Bash', command })).length };
let allowed = 0;
for (const command of allows) allowed += Number(!await preapprovedWriteDenied({ tool: 'Bash', command }, options));
console.log(JSON.stringify({ modulePath, groups, allows: { cases: allows.length, allowed } }, null, 2));

// The old 256 KiB inline scan takes about 76 seconds according to the review's projection. Baseline timing is 64 KiB only.
if (process.argv.includes('--timings')) {
  const sizes = process.argv.includes('--baseline') ? [65536] : [65536, 262144];
  for (const shape of timingShapes) for (const size of sizes) {
    const command = shape.make(size), start = performance.now();
    const refused = await preapprovedWriteDenied({ tool: 'Bash', command }, { ...options, platform: shape.platform });
    console.log(JSON.stringify({ shape: shape.name, characters: command.length, ms: performance.now() - start, refused }));
  }
}
