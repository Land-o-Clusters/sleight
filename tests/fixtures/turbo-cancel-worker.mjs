import { startInstalledV3Worker, unavailableFrame } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareNativeHelpers } from '../../plugins/sleight/lib/direct-browser/host.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
const spawn = childProcess.spawn;
childProcess.spawn = (_command, _args, options) => spawn(process.execPath,
  [fileURLToPath(new URL('turbo-stuck-compiler.mjs', import.meta.url)), join(root, 'compiler.pid')], options);
syncBuiltinESMExports();
const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
  files: ['peer-host.c', 'consent-host.swift'].map(name => ({ path: 'native/' + name,
    sha256: createHash('sha256').update(readFileSync(join(root, 'sources', name))).digest('hex') })) };
try {
  await startInstalledV3Worker({ channel: process }, {
    strictText: true, sites: () => false, tracePhase: () => {},
    readConfig: () => ({ receipt: inventory }), acceptPackage: () => ({ current: () => true }),
    prepareHelpers: options => prepareNativeHelpers({ ...options, sourceRoot: join(root, 'sources'),
      cacheRoot: join(root, 'cache'), tools: async () => true }),
    selectConnection: () => { throw Error('UNEXPECTED_BROWSER_SELECTION'); },
  });
} catch (error) {
  writeFileSync(join(root, 'worker-result.json'), JSON.stringify({ code: error.message, stage: error.stage }));
  if (process.connected) { process.send(unavailableFrame(error)); process.disconnect(); }
}
