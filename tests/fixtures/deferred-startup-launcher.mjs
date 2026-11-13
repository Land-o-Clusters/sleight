import './isolated-launcher-user.mjs';
import { dirname } from 'node:path';
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createV3Bridge } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { buildConfig, writeConfigFile } from '../../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { installedConfigPath } from '../../plugins/sleight/lib/direct-browser/installed-config.mjs';
import { run } from '../../plugins/sleight/lib/launch.mjs';
import { emptyApprovalStorage } from './preapproved-storage.mjs';

import { join } from 'node:path';
const bank = realpathSync(dirname(process.argv[2]));
// The E5 store is new and turbo is on with Chrome. No real app/profile is inspected.
writeConfigFile(installedConfigPath(), buildConfig({ browser: { profileRoot: join(bank, 'chrome-profile'),
  executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } }));
await run({ approvalStorage: emptyApprovalStorage, sweepClipboard: async () => {}, recoverClipboard: async () => {},
  runRetentionOptions: { root: join(bank, 'runs') },
  browserFactory: async options => {
    process.stderr.write('FIXTURE_TURBO_WORK_STARTED\n');
    if (process.argv[3] === 'failure') throw Object.assign(Error('V3_RUNTIME_UNAVAILABLE'), { stage: 'connection-select', reason: 'SELECTED_PROCESS_UNPROVED' });
    if (process.argv[3].startsWith('compiler')) {
      mkdirSync(join(bank, 'sources'), { mode: 0o700 });
      for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(bank, 'sources', name), 'offline compiler input', { mode: 0o600 });
      return createV3Bridge(options, { shareConsent: async () => {}, tracePhase: () => {},
        forkWorker: () => fork(fileURLToPath(new URL('turbo-cancel-worker.mjs', import.meta.url)), [bank],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] }) });
    }
    return new Promise(() => {});
  },
  browserSelectionFactory: () => ({ changed: () => false, prepare: async server => {
    process.stderr.write('FIXTURE_ENGINE_BROWSER_PREPARED\n'); return server;
  } }),
  ownRuntimeOptions: { driverOptions: { prepare: async () => { throw Error('FIXTURE_NATIVE_HELPER_STARTED'); } },
    relayOptions: { runtimeHandClient: { enabled: false, close() {} } } },
});
