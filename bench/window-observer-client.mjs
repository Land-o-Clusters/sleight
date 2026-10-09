// Research client. Engine 26.1002.52244 refused its socket connection with EPERM.
export function treeFreeAction(name, args) {
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  if (['pressKey', 'typeText', 'paste'].includes(name)) return typeof args[0] === 'string';
  if (['click', 'scroll'].includes(name)) return point(args[0]);
  return name === 'drag' && point(args[0]) && point(args[1]);
}

export function nativeWindowMatches(value, expected, appId) {
  return !!value && value.status === 'ok' && typeof value.epoch === 'string' && !!value.epoch &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isFinite(value.processStart) && value.processStart > 0 &&
    Number.isSafeInteger(value.window) && value.window > 0 && value.overlay === false && value.matchingWindows === 1 &&
    typeof appId === 'string' && value.appId === appId && typeof expected?.app === 'string' && value.app === expected.app &&
    typeof expected?.title === 'string' && value.title === expected.title && value.document === (expected.url ?? null);
}

export function sameNativeWindow(a, b) {
  return !!a && !!b && b.status === 'ok' && b.overlay === false && b.matchingWindows === 1 &&
    ['epoch', 'pid', 'processStart', 'window', 'appId', 'app', 'title', 'document'].every(key => a[key] === b[key]);
}

export async function requestNativeWindow(endpoint) {
  const start = Date.now(), budget = Math.min(1000, Math.max(1, endpoint.timeoutMs ?? 250));
  try {
    const net = await import('node:net');
    return await new Promise(resolve => {
      let buffer = '', done = false;
      const socket = net.createConnection({ path: endpoint.path });
      const finish = value => {
        if (done) return;
        done = true; clearTimeout(timer); socket.destroy();
        // Timers can be starved too. Recheck elapsed time when the reply is handled.
        resolve(Date.now() - start >= budget ? { status: 'expired' } : value);
      };
      const timer = setTimeout(() => finish({ status: 'expired' }), budget);
      socket.on('error', () => finish({ status: 'unavailable' }));
      socket.on('end', () => finish({ status: 'unavailable' }));
      socket.on('connect', () => socket.write(JSON.stringify({ token: endpoint.token, appId: endpoint.appId, expires: start + budget }) + '\n'));
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 16384) { finish({ status: 'invalid' }); return; }
        const at = buffer.indexOf('\n');
        if (at < 0) return;
        try { finish(JSON.parse(buffer.slice(0, at))); } catch { finish({ status: 'invalid' }); }
      });
    });
  } catch { return { status: 'unavailable' }; }
}
