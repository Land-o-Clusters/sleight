// Owner-away probe only. No app, driver or worker starts when this file is imported.
import { fileURLToPath } from 'node:url';
import { createMacReplClient } from './client.mjs';

export async function runTracedSmoke({ approvedCalculator = false, driver, trace = () => {},
  createClient = createMacReplClient, signals = process } = {}) {
  if (approvedCalculator !== true) throw Error('CALCULATOR_APPROVAL_REQUIRED');
  const started = performance.now();
  const record = (event, fields = {}) => trace({ event, elapsedMs: Number((performance.now() - started).toFixed(3)), ...fields });
  record('start', { platform: 'darwin', code: 'let app = await cua.getApp("Calculator");' });
  driver ??= (await import('../mac-driver/client.mjs')).createMacDriverClient();
  let requests = 0;
  const client = createClient({ platform: 'darwin', driver,
    async dispatch(method, params, { isActive }) {
      // The operator approves this one read. This is not the relay's app policy.
      if (method !== 'getApp' || params?.selector !== 'Calculator' || Object.keys(params).length !== 1 || requests++)
        throw Error('SMOKE_REQUEST_REFUSED');
      if (!isActive()) throw Error('REPL_RESET');
      record('driver-request', { method });
      const result = await driver.request(method, params);
      if (result?.window?.bundleId?.toLowerCase() !== 'com.apple.calculator')
        throw Object.assign(Error('IDENTITY_CHANGED step=bundle-id'), { code: 'IDENTITY_CHANGED' });
      record('driver-result', { method, readId: result.readId, treeBytes: Buffer.byteLength(result.text ?? ''), truncated: result.truncated === true });
      return result;
    } });
  let closing;
  const close = () => closing ??= client.close();
  const interrupted = () => { close().catch(() => {}); };
  signals.once('SIGINT', interrupted); signals.once('SIGTERM', interrupted);
  try {
    const result = await client.execute({ code: 'let app = await cua.getApp("Calculator");' });
    record('result', { isError: result.isError === true, items: result.content?.length ?? 0 });
    return result;
  } finally {
    signals.removeListener('SIGINT', interrupted); signals.removeListener('SIGTERM', interrupted);
    await close(); record('closed');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'darwin') throw Error('PLATFORM');
    if (process.argv.length !== 3 || process.argv[2] !== '--approved-calculator') throw Error('CALCULATOR_APPROVAL_REQUIRED');
    const result = await runTracedSmoke({ approvedCalculator: true,
      trace: event => process.stderr.write(JSON.stringify(event) + '\n') });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.isError ? 1 : 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: 'error', code: error.code ?? error.message }) + '\n');
    process.exitCode = 1;
  }
}
