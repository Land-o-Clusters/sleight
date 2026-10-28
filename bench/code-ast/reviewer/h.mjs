// Review cases are parsed only. The original mock evaluator is deliberately absent.
import { oracle } from '../oracle.mjs';
const differential = oracle({ label: 'reviewer ' + process.argv[1].split('/').at(-1) });
process.once('beforeExit', () => differential.finish());
export async function run(code) {
  const result = differential.check(code, null);
  return { syntax: result.nodeAccepted, calls: result.visible.map(call => [call.method, call.args]),
    inv: !result.meriyahAccepted, strs: [], ts: '' };
}
