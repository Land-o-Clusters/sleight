import './isolated-launcher-user.mjs';
import { run } from '../../plugins/sleight/lib/launch.mjs';
import { emptyApprovalStorage } from './preapproved-storage.mjs';
import { loadPreapproved, livePreapproved, addPreapproved } from '../../plugins/sleight/lib/preapproved.mjs';
import { appendFileSync } from 'node:fs';
let nextHelper = 0;
const healthHelperFactory = () => {
  const helper = ++nextHelper;
  let closed = false;
  return {
    probe: async () => {
      if (closed) throw new Error('Closed health helper used');
      appendFileSync(process.env.SLEIGHT_TEST_ENGINE_LOG, JSON.stringify({ event: 'probe', helper }) + '\n');
      return { status: 'responding', windows: 1, windowTitles: ['Untitled'], onScreen: 1 };
    },
    keyboardTaps: async () => [], windowIdentity: async () => ({ status: 'unknown' }),
    close: async () => { closed = true; },
  };
};
const approvalStorage = process.argv[3] === '--fixture-preapproved'
  ? { load: loadPreapproved, live: livePreapproved, add: addPreapproved } : emptyApprovalStorage;
run({ leaseDirectory: process.argv[2], approvalStorage, inspectInput: async () => ({ ok: true }), healthHelperFactory });
