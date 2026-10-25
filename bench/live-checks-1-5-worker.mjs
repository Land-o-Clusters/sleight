// Script-owned entry only. Reuses the benchmark's installed worker providers and refusing confirmation UI.
import { startBenchWorker, realBrowserDependencies } from './turbo/v3-worker.mjs';
import { unavailableFrame, createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareNativeHelpers, preparePdfHelper } from '../plugins/sleight/lib/direct-browser/host.mjs';
if (!process.send || !process.env.SLEIGHT_TURBO_REAL_BROWSER) throw Error('LC1_PARENT_REQUIRED');
const controller = new AbortController();
let host;
const stop = () => {
  controller.abort(Error('LC1_WORKER_STOPPED'));
  host?.close().catch(() => {}).finally(() => { if (process.connected) process.disconnect(); });
};
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
startBenchWorker({ realOptions: async browser => ({ ...await realBrowserDependencies(browser),
  prepareHelpers: options => prepareNativeHelpers({ ...options, signal: controller.signal }),
  createRuntime: options => createV3TurnRuntime({ ...options, dependencies: { ...options.dependencies,
    preparePdfHelper: settings => preparePdfHelper({ ...settings, signal: controller.signal }) } }),
}) }).then(value => {
  host = value;
  // Normal close must send its receipt before the parent disconnects IPC.
  if (controller.signal.aborted) stop();
}).catch(error => {
  if (process.connected) { process.send(unavailableFrame(error, 'bench-setup')); process.disconnect(); }
});
