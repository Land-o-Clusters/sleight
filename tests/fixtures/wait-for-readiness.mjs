import assert from 'node:assert/strict';

// A worker refusal cannot produce a readiness event. Report the result instead
// of leaving the suite waiting for a panel or a driver that never started.
export async function waitForReadiness(ready, call, { label = 'readiness', timeoutMs = 30000 } = {}) {
  let timer;
  const text = result => result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? JSON.stringify(result);
  try {
    return await Promise.race([ready,
      call.then(result => assert.fail(`call completed before ${label}: ${text(result)}`)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
