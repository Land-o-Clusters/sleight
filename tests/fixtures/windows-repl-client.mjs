// Headless worker and driver fixture shared by the Windows REPL tests.
import assert from 'node:assert/strict';
import { spawn, fork as spawnWorker } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindowsDriverClient } from '../../plugins/sleight/lib/windows-driver/client.mjs';
import { createWindowsReplClient } from '../../plugins/sleight/lib/windows-repl/client.mjs';
export function windowsReplFixture(t, options = {}) {
  const calls = [], children = [], workers = [], requests = [];
  const driver = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./windows-driver-fake.mjs', import.meta.url)), ...options.driverScenario ? [options.driverScenario] : []],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { SLEIGHT_DRIVER_NONCE: nonce } });
    children.push(child); return child;
  } }) });
  const request = driver.request;
  const repl = createWindowsReplClient({ platform: 'win32', environment: () => ({ LANE_FIXTURE: '1' }),
    driver: { ...driver, request: (method, params) => { requests.push({ method, params }); return request(method, params); } },
    spawn: (...args) => { calls.push(args); const child = spawnWorker(...args); workers.push(child); return child; },
    admit: async () => true, ...options });
  t.after(() => repl.close());
  return { repl, driver, calls, children, workers, requests, js: code => repl.execute({ code }) };
}
