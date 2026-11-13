import { selectReplNode, supportsReplNode } from '../../plugins/sleight/lib/repl/node.mjs';

// These tests fork the real permission-limited worker against inert drivers.
// macOS may select its supported installed Node, as the production client does.
export const replWorkerSkip = !selectReplNode() && 'real REPL worker needs Node 25 or later with --permission and --allow-net';
export const windowsWorkerSkip = !supportsReplNode(process.allowedNodeEnvironmentFlags) &&
  'real Windows REPL worker needs Node 25 or later with --allow-net';
