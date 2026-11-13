// Compatibility entry point. Shared implementation lives in lib/repl.
import { fileURLToPath } from 'node:url';
import { runWorker } from '../repl/worker.mjs';
export * from '../repl/worker.mjs';
if (process.argv[1] === fileURLToPath(import.meta.url) && process.send) runWorker();
