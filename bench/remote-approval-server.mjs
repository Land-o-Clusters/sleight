// RA1's live arm has a private empty approval store. Only metadata about genuine typed grants is recorded.
import { appendFileSync } from 'node:fs';
import { run } from '../plugins/sleight/lib/launch.mjs';
import { replayApprovalStorage } from './replay/server.mjs';
import { createServerEvidence, createEvidenceSaver } from './remote-approval-evidence.mjs';
const diagnostics = createServerEvidence(), destination = process.env.RA1_DIAGNOSTICS;
const audit = process.env.RA1_AUDIT;
if (!audit) throw Error('Remote approval arm audit path is missing');
const write = process.stderr.write.bind(process.stderr);
const { save, flush } = createEvidenceSaver({ destination, diagnostics, onFailure: failure => {
  write(`sleight: RA1 evidence write failed (${failure.code}); further saves disabled.\n`);
} });
process.once('exit', flush);
process.stderr.write = function (chunk, ...args) {
  const app = /^sleight: typed session approval for ([A-Za-z0-9.-]+)\.\n$/.exec(String(chunk))?.[1];
  if (app) appendFileSync(audit, JSON.stringify({ app, t: Date.now() }) + '\n', { mode: 0o600 });
  diagnostics.stderr(chunk); save();
  return write(chunk, ...args);
};
process.env.SLEIGHT_TURBO = '0';
// Avoid the general trace writer, which can include message payloads. Persist only the filtered RA1 trace.
await run({ approvalStorage: replayApprovalStorage, logging: () => ({ trace: (direction, msg) => {
  diagnostics.trace(direction, msg); save();
} }) });
