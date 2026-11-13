// Only fixed diagnostics may cross the helper/worker boundary. Never echo provider text.
const steps = new Set([
  'pid', 'process-start', 'window-id', 'bundle-id', 'title', 'bounds', 'app', 'url',
  'header-parse', 'read-id', 'expected-missing', 'observed-missing', 'lease-app', 'surface',
  'guard-runtime', 'guard-timeout', 'guard-refused', 'window-root', 'window-role',
  'window-inventory', 'window-metadata', 'capture-target', 'capture-window', 'capture-tree',
  'renderer-lease', 'renderer-process', 'renderer-parent', 'renderer-window', 'renderer-bounds',
  'renderer-token', 'release-pid', 'keyboard-pid', 'keyboard-field-pid', 'modifier-binding',
  'compound-recipient', 'compound-binding', 'drag-binding', 'drag-destination', 'drag-app',
  'drag-window', 'drag-pid', 'epoch', 'window', 'window-number', 'native-identity',
]);
export const macIdentityDiagnostics = () => [...steps].map(step => " step=" + step + ";");
export const macIdentityStep = value => steps.has(value) ? value : undefined;
export const identityFieldStep = key => ({ windowId: 'window-id', processStart: 'process-start',
  bundleId: 'bundle-id', appId: 'bundle-id', windowNumber: 'window-number' }[key] ?? macIdentityStep(key));
export function macIdentityError(step) {
  step = macIdentityStep(step) ?? 'guard-runtime';
  return Object.assign(Error('IDENTITY_CHANGED step=' + step), { code: 'IDENTITY_CHANGED', identityStep: step });
}
export function identityErrorStep(error) {
  return macIdentityStep(error?.identityStep) ?? macIdentityStep(/\bstep=([a-z-]+)\b/.exec(error?.message ?? '')?.[1]);
}
