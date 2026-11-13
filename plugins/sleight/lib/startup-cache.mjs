import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const limit = 1024 * 1024;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const owned = stat => (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
// The engine inherits sleight's whole environment. These are the names it or its node kernel can read, apart from
// per-session values. The engine never reads SLEIGHT_* switches: sleight applies those to the engine's replies itself.
const engineEnv = /^(?:CUA_|NODE_REPL_|SKY_|BROWSER_USE_)|^(?:CODEX_HOME|CODEX_CLI_PATH)$/;
const sessionEnv = /(?:_ID|_PID|TOKEN|NONCE|SECRET|_KEY|_PORT|SOCKET|PIPE_PATH|VERIFYING_IDENTITY)$/;
const valid = entry => entry?.schema === 2 && typeof entry.initialize?.protocolVersion === 'string' &&
  typeof entry.initialize?.serverInfo?.name === 'string' && typeof entry.initialize?.serverInfo?.version === 'string' &&
  entry.initialize.capabilities && typeof entry.initialize.capabilities === 'object' && !Array.isArray(entry.initialize.capabilities) &&
  Array.isArray(entry.tools?.tools) && !entry.tools.nextCursor &&
  entry.tools.tools.every(tool => typeof tool?.name === 'string' && tool.inputSchema?.type === 'object');

// Everything that starts the engine: its launch path and environment, inherited engine settings, and the sleight build
// and runtime. Only the resulting digest is written, never environment values.
export function startupIdentity(server, pluginRoot, env = process.env) {
  if (!server.version) return;
  try {
    const lib = join(pluginRoot, 'lib');
    const build = createHash('sha256');
    for (const file of readdirSync(lib).filter(file => file.endsWith('.mjs')).sort()) build.update(file + '\0').update(readFileSync(join(lib, file))).update('\0');
    return { engine: [server.version, server.command, server.args],
      sleight: [JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).version, build.digest('hex')],
      runtime: [process.platform, process.arch, process.version], env: {
        ...Object.fromEntries(Object.entries(env).filter(([name]) => engineEnv.test(name) && !sessionEnv.test(name))),
        ...server.env,
      } };
  } catch { return; } // Cache setup must not fail an otherwise usable engine.
}

export function createStartupCache({ identity, directory = join(homedir(), 'Library/Caches/sleight/handshakes') } = {}) {
  if (!identity) return;
  function safeDirectory() {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || !owned(stat)) throw new Error('unsafe handshake cache directory');
  }
  function read(file) {
    safeDirectory();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !owned(stat) || stat.size > limit) return;
      const buffer = Buffer.alloc(limit + 1);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      if (size > limit) return;
      const entry = JSON.parse(buffer.toString('utf8', 0, size));
      if (valid(entry)) return entry;
    } finally { closeSync(fd); }
  }
  function write(file, entry) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const data = JSON.stringify(entry);
      if (!valid(entry) || Buffer.byteLength(data) > limit) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 }); safeDirectory();
      writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      const files = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        try {
          const stat = lstatSync(join(directory, name));
          return stat.isFile() && owned(stat) ? [{ name, time: stat.mtimeMs }] : [];
        } catch { return []; }
      }).sort((a, b) => (b.name === basename(file)) - (a.name === basename(file)) ||
        b.time - a.time || a.name.localeCompare(b.name));
      for (const old of files.slice(8)) rmSync(join(directory, old.name), { force: true });
    } catch { /* An unavailable cache keeps the existing handshake path. */ }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Unwritable cache. */ } }
  }
  // The entry holds the engine's own initialize and first tools/list replies. The relay rewrites them for each session
  // (present), so a sleight setting never makes an entry stale. A stale entry (the engine changed under the same key)
  // costs at most the calls queued during startup: the session goes on with the engine's live answer.
  return {
    bind({ send, forward, present = {}, log = () => {} }) {
      let file, cached, initializeId, initialized = false, notified = false, started = false, failed = false, cancelled = false;
      let initializeResult, initializedTimer, shown; // shown: the initialize answer the client got from the cache
      let firstList = true, failureMessage, retryMessage; // retryMessage: set while a changed protocol refuses startup calls
      const lists = new Map(), queue = [];
      const answer = (kind, result) => (present[kind] ?? (value => value))(structuredClone(result));
      const drop = () => { try { if (file) rmSync(file, { force: true }); } catch { /* Unwritable cache. */ } };
      const fail = (message, invalidate = true) => {
        failed = true;
        clearTimeout(initializedTimer);
        failureMessage = message;
        if (invalidate) drop();
        for (const msg of queue.splice(0)) if (msg.id !== undefined && !lists.get(msg.id)?.cached) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } });
        }
      };
      // Only the tool calls waiting in the queue, with their cancellations. Everything later goes to the engine.
      const refuseQueued = message => {
        const refused = new Set();
        for (let index = 0; index < queue.length;) {
          const msg = queue[index];
          if (msg.method === 'tools/call') {
            refused.add(msg.id); queue.splice(index, 1);
            if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } });
          } else if (msg.method === 'notifications/cancelled' && refused.has(msg.params?.requestId)) queue.splice(index, 1);
          else index++;
        }
      };
      function flush() {
        if (!initialized || failed) return;
        // Send the initialized notification and list before admitting tool calls.
        for (let index = 0; index < queue.length;) {
          const msg = queue[index];
          if (msg.method === 'tools/call' || (msg.method === 'notifications/cancelled' &&
            queue.some(call => call.method === 'tools/call' && call.id === msg.params?.requestId))) { index++; continue; }
          if (msg.method === 'notifications/initialized') { notified = true; clearTimeout(initializedTimer); }
          queue.splice(index, 1); forward(msg);
        }
        if (notified && ![...lists.values()].some(list => list.cached)) {
          for (const msg of queue.splice(0)) forward(msg);
        }
      }
      return {
        initialize(msg) {
          if (started || msg.id === undefined) return;
          started = true; initializeId = msg.id;
          const key = createHash('sha256').update(canonical([identity, msg.params])).digest('hex');
          file = join(directory, key + '.json');
          try { cached = read(file); } catch { /* Cold or invalid cache. */ }
          if (cached) send({ jsonrpc: '2.0', id: msg.id, result: shown = answer('initialize', cached.initialize) });
        },
        // Whether a reply is one this cache checks or records, so the relay keeps the engine's own copy of it.
        expects(id) {
          return started && !failed && id !== undefined && (id === initializeId || lists.has(id));
        },
        request(msg) {
          if (!started || cancelled || !['tools/list', 'tools/call', 'notifications/initialized', 'ping', 'notifications/cancelled'].includes(msg.method)) return false;
          if (failed) {
            if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603,
              message: failureMessage } });
            return true;
          }
          if (msg.method === 'notifications/initialized' && notified) return true;
          if (msg.method === 'tools/list' && msg.id !== undefined) {
            const cacheable = firstList && Object.keys(msg.params ?? {}).length === 0;
            firstList = false;
            lists.set(msg.id, { cacheable, cached: cacheable && !!cached });
            if (cacheable && cached) {
              // A cached list the session's rewrite can't take is answered live instead.
              let result;
              try { result = answer('tools', cached.tools); } catch { lists.get(msg.id).cached = false; }
              if (result) send({ jsonrpc: '2.0', id: msg.id, result });
            }
          }
          queue.push(msg); flush(); return true;
        },
        // msg is the reply as the relay would send it; engine is the engine's own reply, before the relay rewrote it.
        reply(msg, engine = msg) {
          if (msg.method !== undefined || !started) return false;
          if (failed) return (msg.id === initializeId && !!cached) || !!lists.get(msg.id)?.cached;
          if (initializeId !== undefined && msg.id === initializeId) {
            initializeId = undefined;
            if (engine.error || !engine.result) {
              fail(engine.error?.message ?? 'Engine handshake failed; reconnect sleight.'); return !!cached;
            }
            if (cached && canonical(engine.result) !== canonical(cached.initialize)) {
              // The client keeps the cached answer for this session: MCP has no way to initialize a client again.
              // The entry is rewritten once the first tool list verifies.
              drop();
              log('sleight: the cached engine handshake was stale; this session continues on the engine\'s live answer.');
              // A different protocol version can change how the calls already sent should be read, so only those are
              // refused, and the client sends them again.
              if (engine.result.protocolVersion !== cached.initialize.protocolVersion) {
                retryMessage = 'The engine changed while sleight started, so this call did not run. Call it again.';
                refuseQueued(retryMessage);
              }
            }
            initializeResult = structuredClone(engine.result); initialized = true; flush();
            if (!notified) {
              initializedTimer = setTimeout(() => {
                notified = true;
                forward({ jsonrpc: '2.0', method: 'notifications/initialized' });
                flush();
              }, 2000);
              initializedTimer.unref?.();
            }
            return !!cached;
          }
          const list = lists.get(msg.id);
          if (!list) return false;
          lists.delete(msg.id);
          // Calls sent after a changed protocol's initialize reply, while the cached list waited, get the same refusal.
          if (retryMessage && list.cached) { refuseQueued(retryMessage); retryMessage = undefined; }
          if (list.cached && engine.error) {
            // The client already has the cached list. The engine's error goes to the calls that waited on it.
            drop();
            refuseQueued(engine.error.message ?? 'Engine tool list failed.');
          } else if (list.cacheable && !engine.error && initializeResult) {
            if (list.cached && canonical(engine.result) !== canonical(cached.tools)) {
              log('sleight: the cached engine tool list was stale; this session continues on the engine\'s live list.');
              // A client that was told the list can change fetches it again. Others keep the cached descriptions for this
              // session, and their calls run on the live engine.
              if (shown?.capabilities?.tools?.listChanged === true) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
            }
            write(file, { schema: 2, initialize: initializeResult, tools: engine.result });
          }
          flush(); return list.cached;
        },
        cancel() {
          cancelled = true;
          for (let index = 0; index < queue.length;) {
            if (queue[index].method === 'notifications/initialized') forward(queue.splice(index, 1)[0]);
            else index++;
          }
          fail('Startup was stopped before the call ran; reconnect sleight.', false);
        },
        close() { fail('Engine connection closed before startup completed; reconnect sleight.', false); },
      };
    },
  };
}
