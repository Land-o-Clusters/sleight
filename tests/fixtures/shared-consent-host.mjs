import { spawn } from 'node:child_process';

// Own the exact child until close. A ready step gates the next write on the complete reset acknowledgement.
export async function runSharedHost(binary, steps, args = ['--hand', '--consent'], {
  spawnProcess = spawn, timeoutMs = 30000, readyTimeoutMs = 10000, collectTimeoutMs = 3000,
} = {}) {
  const child = spawnProcess(binary, ['--channels-selftest', ...args], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } });
  const out = { stdout: '', consent: '', stderr: '', alive: [] };
  let closed = false, code, readiness, cursor = 0, rejectFailure;
  const pauses = new Set();
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const fail = name => rejectFailure(Error(name));
  let resolveClose;
  const collected = new Promise(resolve => { resolveClose = resolve; });
  const onClose = status => { closed = true; code = status; readiness?.check(); resolveClose(status); };
  const onError = () => fail('SHARED_HOST_ERROR');
  const onStdout = data => { out.stdout += data; readiness?.check(); };
  const onConsent = data => { out.consent += data; };
  const onStderr = data => { out.stderr += data; };
  const ignoreInputError = () => {};
  child.once('close', onClose); child.on('error', onError);
  child.stdout.on('data', onStdout); child.stdio[4].on('data', onConsent); child.stderr.on('data', onStderr);
  for (const fd of [0, 3]) child.stdio[fd].on('error', ignoreInputError);
  const timer = setTimeout(() => fail('SHARED_HOST_TIMEOUT'), timeoutMs);
  const race = work => Promise.race([work, failure]);
  const pause = ms => new Promise(resolve => {
    const pending = setTimeout(() => { pauses.delete(pending); resolve(); }, ms); pauses.add(pending);
  });
  const waitReady = expected => new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(deadline); readiness = undefined;
      error ? reject(error) : resolve();
    };
    const deadline = setTimeout(() => finish(Error('SHARED_READY_TIMEOUT')), readyTimeoutMs);
    const check = () => {
      if (closed) return finish(Error('SHARED_READY_CLOSED'));
      for (;;) {
        const newline = out.stdout.indexOf('\n', cursor);
        if (newline === -1) return;
        const text = out.stdout.slice(cursor, newline); cursor = newline + 1;
        let row;
        try { row = JSON.parse(text); } catch { return finish(Error('SHARED_READY_INVALID_JSON')); }
        if (!row || Object.keys(row).sort().join() !== 'hand,nonce,token' || row.hand !== 'consent-ready' ||
            row.nonce !== expected.nonce || row.token !== expected.token) return finish(Error('SHARED_READY_MISMATCH'));
        return finish();
      }
    };
    readiness = { check, finish }; check();
  });
  try {
    for (const [what, value] of steps) {
      if (what === 'ready') await race(waitReady(value));
      else if (what === 'wait') await race(pause(value));
      else if (what === 'alive') out.alive.push(child.exitCode === null && child.signalCode === null);
      else if (what === 'end') child.stdio[value].end();
      else child.stdio[what].write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
    }
    await race(collected);
    return { code, ...out };
  } catch (error) {
    if (!closed) {
      try { child.kill('SIGKILL'); } catch {}
      let deadline;
      try { await Promise.race([collected, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('SHARED_HOST_COLLECTION_UNCONFIRMED')), collectTimeoutMs);
      })]); }
      catch (cleanup) { throw Object.assign(cleanup, { cause: error }); }
      finally { clearTimeout(deadline); }
    }
    throw error;
  } finally {
    clearTimeout(timer); for (const pending of pauses) clearTimeout(pending);
    readiness?.finish(Error('SHARED_HOST_STOPPED'));
    child.removeListener('close', onClose); child.removeListener('error', onError);
    child.stdout.removeListener('data', onStdout); child.stdio[4].removeListener('data', onConsent); child.stderr.removeListener('data', onStderr);
    for (const fd of [0, 3]) child.stdio[fd].removeListener('error', ignoreInputError);
  }
}
