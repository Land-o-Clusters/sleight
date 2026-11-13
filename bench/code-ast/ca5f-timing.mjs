// Offline scanner timing only. No caller code is executed. The CA5F 'before' arm read a private commit; release
// clones are shallow, so only the frozen FLOW_BASE baseline is compared now.
import { existsSync } from 'node:fs';
import { benchGateOpen } from '../runtime-options.mjs';
import * as flow from '../../plugins/sleight/lib/flow-rules.mjs';
import { clearCellCache } from '../../plugins/sleight/lib/code-ast.mjs';
import { FLOW_BASE, revisionFlow, statementCell, measureCalls, median } from '../../tests/fixtures/revision-flow.mjs';

const arms = {};
try {
  arms.base = await revisionFlow(FLOW_BASE);
  arms.after = { ...flow, clearCellCache };
  for (const count of [200, 1000, 4000]) {
    const code = statementCell(count), samples = { base: [], after: [] };
    for (let round = 0; round < 3; round++) {
      for (const name of round % 2 ? ['after', 'base'] : ['base', 'after']) {
        while (!benchGateOpen() || existsSync('/tmp/sleight-hold')) await new Promise(resolve => setTimeout(resolve, 60000));
        samples[name].push(measureCalls(arms[name], code));
      }
    }
    console.log(JSON.stringify({ statements: count, pairs: count / 2, bytes: Buffer.byteLength(code),
      samples, medianMs: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)])) }));
  }
} finally { arms.base?.cleanup(); }
