// Offline decisions only. This script never executes candidate command strings.
import { pathToFileURL } from 'node:url';
import { resolve, posix } from 'node:path';
import { directoryMatrix, keywordCases, writerCases, nestedCases, directoryReview, dynamicDirectoryCases, reviewerReads, readWrappers } from '../tests/fixtures/gd6-review-bank.mjs';
const module = await import(pathToFileURL(resolve(process.argv[2] ?? 'plugins/sleight/hooks/preapproved-write-guard.mjs')));
const options = { stat: async path => ['/nope', '/tmp/does-not-exist', '/Users/u/Application Support/sleight'].includes(posix.normalize(path)) ? undefined : ({ realPath: path }), home: '/Users/u', configDir: '/Users/u/.claude', platform: 'darwin' };
const refuses = async command => !!await module.preapprovedWriteTarget({ tool: 'Bash', command }, options) || module.loggingSwitchWriteDenied({ tool: 'Bash', command });
for (const [group, cases] of Object.entries({ directoryMatrix: directoryMatrix.map(({ command }) => command), keywords: keywordCases, writers: writerCases, nested: nestedCases, directories: directoryReview.map(([command]) => command), dynamic: dynamicDirectoryCases, reads: readWrappers.flatMap(prefix => reviewerReads.map(command => `${prefix} ${command}`.trim())) })) {
  let refused = 0;
  for (const command of cases) if (await refuses(command)) refused++;
  console.log(JSON.stringify({ group, cases: cases.length, refused, allowed: cases.length - refused }));
}
