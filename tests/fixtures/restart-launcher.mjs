import { run } from '../../plugins/sleight/lib/launch.mjs';
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
run({ leaseDirectory: process.argv[2], inspectInput: async () => ({ ok: true }), healthHelperFactory });
