import { browserTools, validateToolCall } from '../../plugins/sleight/lib/direct-browser/tools.mjs';
// Bench transport only. The production v3 surface supplies the entire catalog,
// validation and dispatch. Do not reserialize its plain-text MCP result as JSON.
const stageName = value => typeof value === 'string' && /^[a-z][a-z-]{1,31}$/.test(value) ? value : undefined;
const codeName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,47}$/.test(value) ? value : undefined;
// A session start that failed before any command reached the browser (the error says beforeCdp) starts once more after
// retryDelayMs, within the same call. Two of about 290 real-Chrome task starts failed this way on 2026-10-18 and
// 2026-10-19 and every later call of the task failed with them. A second failure is final for the task, as before.
// onStartupFailure gets { attempt, stage, code, reason, retrying, ms } for each failed attempt, never page content or paths.
export function createProtocol({ output = process.stdout, start, tools = browserTools('bbench'), validate = input => validateToolCall(input, 'bbench'),
  retryDelayMs = 300, retryWithinMs = 10000, onStartupFailure = () => {}, now = Date.now } = {}) {
  if (!Array.isArray(tools) || typeof validate !== 'function' || typeof start !== 'function') throw Error('V3 interface required');
  let session, starting, queue = Promise.resolve(), closing = false, cleanup;
  const startSession = async () => {
    for (let attempt = 1; ; attempt++) {
      const began = now();
      try { return await start(); }
      catch (error) {
        // A start that hung (the bridge's 120 s startup or 31 s bind deadline) is not retried: the call would outlast the client.
        const retrying = attempt === 1 && error?.beforeCdp === true && now() - began < retryWithinMs;
        const code = codeName(error?.message) ?? 'UNKNOWN';
        try { onStartupFailure(Object.freeze({ attempt, stage: stageName(error?.stage) ?? 'startup', code,
          reason: codeName(error?.reason) ?? code, retrying, ms: Math.max(0, now() - began) })); } catch {}
        if (!retrying) throw error;
        // A close during the pause still lets this accepted call finish its one retry; close() then ends that session.
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  };
  const send = value => new Promise((resolve, reject) => {
    output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n', error => error ? reject(error) : resolve());
  });
  const run = async message => {
    const id = message?.id; if (id === undefined) return;
    if (message.method === 'initialize') return send({ id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'sleight-turbo-v3-bench', version: '0.1.0' } } });
    if (message.method === 'ping') return send({ id, result: {} });
    if (message.method === 'tools/list') return send({ id, result: { tools } });
    if (message.method !== 'tools/call') return send({ id, error: { code: -32601, message: 'Method not found' } });
    let request;
    try {
      // The original task belongs to the launch boundary. Strip every outer
      // client field, including Claude Code's _meta and any purported authority.
      if (!tools.some(tool => tool.name === message.params?.name)) throw Error('Unknown v3 tool');
      request = validate({ name: message.params?.name, arguments: message.params?.arguments });
    } catch (error) { return send({ id, error: { code: -32602, message: error.message } }); }
    let result, startup;
    try {
      starting ??= startSession();
      try { session = await starting; } catch (error) { startup = stageName(error?.stage) ?? 'startup'; throw error; }
      result = await session.call(request);
      if (typeof result?.text !== 'string' || typeof result.isError !== 'boolean') throw Error('Invalid v3 result');
    } catch (error) {
      // The model gets the failed startup stage at most. The round's stderr, and for a startup the task folder's
      // turbo-metrics.jsonl (onStartupFailure), keep the code.
      process.stderr.write(`turbo bench: ${String(error?.code ?? error?.message ?? error).slice(0, 200)}\n`);
      result = { text: `Turbo bench unavailable (effect unknown${startup ? `, startup stage ${startup}` : ''}). Read before any retry.`, isError: true };
    }
    // Match relay.mjs's direct-browser projection. The production worker has
    // already bounded and downscaled images; preserve their MIME, bytes and order.
    // 1.4.2 returns text only, so it needs no newer image module or launcher import.
    await send({ id, result: { content: [{ type: 'text', text: result.text }, ...(result.images ?? [])], isError: result.isError } });
    // An undelivered observation cannot unlock a submit retry. The product
    // surface decides which results represent deliverable observations.
    session?.delivered?.(result, request);
  };
  return Object.freeze({
    message(message) {
      if (closing) return message?.id === undefined ? Promise.resolve() : send({ id: message.id, error: { code: -32000, message: 'Session closing' } });
      const work = queue.then(() => run(message)); queue = work.catch(() => {}); return work; },
    close() {
      closing = true;
      return cleanup ??= (async () => {
        await queue;
        if (starting) { try { session = await starting; } catch {} }
        return session?.close();
      })();
    } });
}
