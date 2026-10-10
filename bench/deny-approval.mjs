// Generic arms may use only the benchmark's MCP elicitation allowlist.
import { writeFileSync } from 'node:fs';
if (process.env.BENCH_APPROVAL_STOP) writeFileSync(process.env.BENCH_APPROVAL_STOP, 'unsupported approval: non-elicitation permission request\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
  decision: { behavior: 'deny', message: 'Benchmark stopped: approval must use MCP elicitation.' } } }));
