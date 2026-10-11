import { openElectron, cleanupElectron } from './real-electron.mjs';

export const IPHONE_MIRRORING_BUNDLE = 'com.apple.ScreenContinuity';

export function checkIosVersion({ answer } = {}) {
  // The version alone, optionally followed by a blank line and a note (a mis-tap warning, 2026-10-11).
  return /^\d+(\.\d+)*(\n\n[\s\S]*\S[\s\S]*)?$/.test(String(answer ?? '')) || 'answer is not an iOS version';
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
    'If iPhone Mirroring shows that it is locked or connecting, it may be unlocking on its own: take another ' +
    'screenshot every few seconds for up to 30 seconds before you stop, and never enter or ask for a password. ' +
    'Leave iPhone Mirroring open.';
}

// iPhone Mirroring is approved only in --owner-present runs (bench/approve.mjs, owner 2026-10-11).
export const iphoneTasks = [{
  id: 'iphone-mirroring-settings', app: 'iPhone Mirroring', bundle: IPHONE_MIRRORING_BUNDLE,
  ownerPresent: true, noScreenshot: true,
  prepare: prepareIphoneMirroring, setup: setupIphoneMirroring, prompt: promptIphoneMirroring,
  check: checkIosVersion, cleanup: cleanupElectron,
}];
