// Detached menu owner. No relay, engine, locator, action frames or session consent channel.
import { createHandClient } from './client.mjs';
import { fileURLToPath } from 'node:url';
export function createMenuWorker({ createClient = createHandClient, send = message => process.send?.(message) } = {}) {
  let ready = false;
  const client = createClient({ menuOnly: true,
    onMenuReady(existing) {
      ready = true;
      send({ ready: true, existing });
      if (existing) client.close();
    },
    trace(event, detail) {
      if (event === 'hand-off' && detail?.reason !== 'setting') {
        if (!ready) send({ ready: false });
        client.close();
      }
    },
  });
  return { client, disconnected() { if (!ready) client.close(); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.send) process.exit(64);
  const worker = createMenuWorker();
  // If the caller disappears before readiness, close the host too. After readiness the menu owns its lifetime.
  process.on('disconnect', () => worker.disconnected());
  await worker.client.startMenu();
}
