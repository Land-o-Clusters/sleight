// Runs the real launcher with a private test lease bank and a fake engine.
import './isolated-launcher-user.mjs';
import { run } from '../../plugins/sleight/lib/launch.mjs';
import { emptyApprovalStorage } from './preapproved-storage.mjs';
run({ leaseDirectory: process.argv[2], approvalStorage: emptyApprovalStorage,
  healthHelperFactory: () => ({ close: async () => {}, keyboardTaps: async () => [] }) });
