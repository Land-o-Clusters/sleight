import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Opt in to the old evidence layout by naming its parent directory explicitly.
// No checkout, ledger or home-directory discovery runs by default.
export function retainedBank(relative, required = [], root = process.env.SLEIGHT_RETAINED_BANKS ?? process.env.SLEIGHT_BENCH_EVIDENCE_DIR) {
  if (!root) return { path: '', skip: 'SLEIGHT_RETAINED_BANKS is unset; retained evidence test skipped' };
  const path = resolve(root, relative);
  const missing = (required.length ? required : ['']).filter(file => !existsSync(join(path, file)));
  return { path, skip: missing.length ? `SLEIGHT_RETAINED_BANKS lacks ${relative}/${missing.join(', ')}; retained evidence test skipped` : false };
}
