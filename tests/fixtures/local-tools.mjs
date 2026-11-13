// Keep the real admission and helper code. Synthetic app resolution is the
// only replacement, so offline helper tests never query the owner's apps.
import { callLocalTool as call } from '../../plugins/sleight/lib/launch.mjs';
export * from '../../plugins/sleight/lib/launch.mjs';
export function callLocalTool(name, args, approve, run, resolved, prepared, options = {}) {
  return call(name, args, approve, run, resolved, prepared,
    { resolve: async () => 'org.test.fixture', ...options });
}
