// RA1's live arm has a private empty approval store. Only metadata about genuine typed grants is recorded.
import { appendFileSync } from 'node:fs';
import { run } from '../plugins/sleight/lib/launch.mjs';
import { replayApprovalStorage } from './replay/server.mjs';
const audit = process.env.RA1_AUDIT;
if (!audit) throw Error('Remote approval arm audit path is missing');
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = function (chunk, ...args) {
  const app = /^sleight: typed session approval for ([A-Za-z0-9.-]+)\.\n$/.exec(String(chunk))?.[1];
  if (app) appendFileSync(audit, JSON.stringify({ app, t: Date.now() }) + '\n', { mode: 0o600 });
  return write(chunk, ...args);
};
process.env.SLEIGHT_TURBO = '0';
await run({ approvalStorage: replayApprovalStorage });
