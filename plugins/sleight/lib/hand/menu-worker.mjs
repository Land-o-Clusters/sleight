// Detached menu owner. No relay, engine, locator, action frames or session consent channel.
import { createHandClient } from './client.mjs';
if (!process.send) process.exit(64);
let ready = false;
const client = createHandClient({ menuOnly: true,
  onMenuReady(existing) {
    ready = true;
    process.send?.({ ready: true, existing });
    if (existing) client.close();
  },
  trace(event) {
    if (event === 'hand-off') {
      if (!ready) process.send?.({ ready: false });
      client.close();
    }
  },
});
// If the caller disappears before readiness, close the host too. After readiness the menu owns its lifetime.
process.on('disconnect', () => { if (!ready) client.close(); });
await client.startMenu();
