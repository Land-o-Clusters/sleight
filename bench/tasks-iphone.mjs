import { openElectron, cleanupElectron } from './real-electron.mjs';

export const IPHONE_MIRRORING_BUNDLE = 'com.apple.ScreenContinuity';

export function checkIosVersion({ answer } = {}) {
  return /^\d+(\.\d+)*$/.test(String(answer ?? '')) || 'answer is not an iOS version';
}

export function prepareIphoneMirroring() {}

export async function setupIphoneMirroring(ctx, options = {}) {
  if (ctx.ownerPresent !== true) {
    throw Object.assign(new Error('IPHONE_MIRRORING_OWNER_PRESENT_UNPROVED: requires --owner-present; no iPhone Mirroring operation performed'), { noMutation: true });
  }
  await openElectron(ctx, { app: 'iPhone Mirroring', bundle: IPHONE_MIRRORING_BUNDLE, target: '' }, options);
}

export function promptIphoneMirroring() {
  return 'Using computer use in iPhone Mirroring, open the iPhone\'s Settings app. Go to General, then About. ' +
    'Read the iOS version shown there. In your answer, write only that version number, digits and dots, for example 18.6.2. ' +
    'Read only: do not tap outside Settings, General and About, do not enter text, and do not send anything. ' +
    'Leave iPhone Mirroring open.';
}

// iPhone Mirroring is not on the benchmark approval allowlist. The owner approves it at the prompt.
export const iphoneTasks = [{
  id: 'iphone-mirroring-settings', app: 'iPhone Mirroring', bundle: IPHONE_MIRRORING_BUNDLE,
  ownerPresent: true, noScreenshot: true,
  prepare: prepareIphoneMirroring, setup: setupIphoneMirroring, prompt: promptIphoneMirroring,
  check: checkIosVersion, cleanup: cleanupElectron,
}];
