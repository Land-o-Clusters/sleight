// Private helper/parent handshake. One bounded wait replaces the relay's pre-input clear.
// No endpoint or control token reaches the tool reply or public cursor stream.
export function attachPointerPlacement(child, { token, place, hide, current = () => {}, now = Date.now }) {
  let buffer = '', closed = false, pending = false, poisoned = false;
  const fail = () => { try { hide(); } catch {} };
  const receive = chunk => {
    if (closed || poisoned) return;
    buffer += String(chunk);
    if (buffer.length > 8192) { poisoned = true; buffer = ''; fail(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line === `sleight-place-timeout ${token}`) { fail(); continue; }
      if (!line.startsWith('sleight-place ')) continue;
      let request;
      try { request = JSON.parse(line.slice('sleight-place '.length)); } catch { continue; }
      if (request.token !== token) continue;
      const { frame, deadline } = request;
      const pointer = frame?.kind === 'drag' && [undefined, 'act'].includes(frame.hand) || frame?.hand === 'aim' && frame.kind === 'move';
      if (pending || Object.keys(request).sort().join() !== 'deadline,frame,token' ||
          !Number.isFinite(deadline) || deadline > now() + 100 || !pointer) { fail(); continue; }
      pending = true;
      const finish = (placed, stopped = false) => {
        if (closed) return;
        pending = false;
        try { current(); } catch { stopped = true; }
        if (stopped) placed = false;
        if (!placed || now() >= deadline) { placed = false; fail(); }
        try { child.stdin.write(JSON.stringify({ token, placed, ...stopped ? { stopped: true } : {} }) + '\n'); } catch { fail(); }
      };
      if (deadline <= now()) { finish(false); continue; }
      try { current(); Promise.resolve(place(frame, deadline)).then(value => finish(value === true), () => finish(false, true)); }
      catch { finish(false, true); }
    }
  };
  child.stderr?.on('data', receive);
  child.stdin?.on?.('error', fail);
  return () => { closed = true; buffer = ''; child.stderr?.removeListener('data', receive); child.stdin?.removeListener?.('error', fail); };
}
