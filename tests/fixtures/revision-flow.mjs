import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';

export const FLOW_BASE = 'be330c709d2df60f137c0db6a6113c6fe2c80acb';
const snapshotHash = 'a93c3858c0753928d63c84e5b316b065fd8cc10ba58ba93fbeb64a8e7b7f3621';

// Byte-for-byte sources and all 23 static dependencies from FLOW_BASE, including
// its parser. This keeps the same-run comparison available in shallow public clones.
// Import only the offline flow scanner, never relay.mjs or bench/run.mjs.
export async function revisionFlow(commit) {
  if (commit !== FLOW_BASE) throw Error('Unsupported flow baseline');
  const packed = readFileSync(new URL('./flow-base.json.gz', import.meta.url));
  if (createHash('sha256').update(packed).digest('hex') !== snapshotHash) throw Error('Flow baseline hash mismatch');
  const snapshot = JSON.parse(gunzipSync(packed));
  if (snapshot.commit !== commit || Object.keys(snapshot.files).length !== 23) throw Error('Flow baseline identity mismatch');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-flow-revision-')));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    for (const [path, source] of Object.entries(snapshot.files)) {
      if (!path.startsWith('plugins/sleight/') || posix.normalize(path) !== path || path.split('/').includes('..'))
        throw Error('Revision dependency outside plugin');
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const flow = await import(pathToFileURL(join(dir, 'plugins/sleight/lib/flow-rules.mjs')).href);
    const ast = await import(pathToFileURL(join(dir, 'plugins/sleight/lib/code-ast.mjs')).href);
    return { ...flow, ...ast, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export function statementCell(count) {
  if (count % 2) throw Error('The fixture needs pairs of statements');
  return Array.from({ length: count / 2 }, (_, i) =>
    `await app.click(${i}); const v${i} = await app.typeText("abc"+${i});`).join('\n');
}

export function measureCalls(arm, code) {
  arm.clearCellCache();
  const start = performance.now();
  arm.calls(code, new Map());
  return performance.now() - start;
}

export const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
