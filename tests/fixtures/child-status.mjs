import assert from 'node:assert/strict';

// Keep status assertions useful when spawnSync returns status:null on a timeout.
export function assertChildStatus(result, expected, message = '', comparison = 'equal') {
  const detail = result.error?.code ?? result.signal ?? result.status;
  assert[comparison](result.status, expected, `${message}\nchild: ${detail}`);
}
