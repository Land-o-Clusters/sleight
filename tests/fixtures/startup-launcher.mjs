import './isolated-launcher-user.mjs';
import { run } from '../../plugins/sleight/lib/launch.mjs';
import { emptyApprovalStorage } from './preapproved-storage.mjs';
await run({ approvalStorage: emptyApprovalStorage });
