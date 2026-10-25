// Script-owned entry only. Reuses the benchmark's installed worker providers and refusing confirmation UI.
import { startBenchWorker, realBrowserDependencies } from './turbo/v3-worker.mjs';
import { unavailableFrame, createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareNativeHelpers, preparePdfHelper } from '../plugins/sleight/lib/direct-browser/host.mjs';
if (!process.send || !process.env.SLEIGHT_TURBO_REAL_BROWSER) throw Error('LC1_PARENT_REQUIRED');
const controller = new AbortController();
let host;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  controller.abort(Error('LC1_WORKER_STOPPED'));
  // Close the host, then leave: a lingering handle must not keep this worker alive past the runner's 5 s wait.
  // Exit code 3 tells the runner the host didn't finish closing, so its native helper cleanup is unproved.
  const leave = code => { if (process.connected) process.disconnect(); setTimeout(() => process.exit(code), 200).unref(); };
  const deadline = setTimeout(() => leave(3), 3000); deadline.unref();
  (host ? host.close() : Promise.resolve()).then(() => 0, () => 3).then(code => { clearTimeout(deadline); leave(code); });
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
