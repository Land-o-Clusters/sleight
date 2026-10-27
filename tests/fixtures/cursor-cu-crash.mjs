// Offline crash fixture. Every host boundary is replaced; no app or host is started.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armPaths, composerPlan, CURSOR_PIN } from '../../bench/world/arms/cursor-cu/contract.mjs';
import { DesktopDriver } from '../../bench/world/arms/cursor-cu/desktop.mjs';

const paths = armPaths({ home: process.argv[2] });
const previous = { model: 'Other model', effort: 'Medium', speed: 'Normal', attachment: 'None', target: 'Cloud' };
const owner = { pid: 42, bundleId: CURSOR_PIN.bundleId, executable: '/Applications/Cursor.app/Contents/MacOS/Cursor', launchAt: 1000 };
let enabled = false, selection = previous, state = { composers: [], bubbles: {} };
const driver = new DesktopDriver({ inspect: () => CURSOR_PIN, readiness: async () => ({ authStored: true }), exists: () => false,
  processes: async () => [owner], readState: async () => state,
  ui: { window: 7, composerId: 'original', bind: async () => {}, bindCurrentChat: async () => {},
    accessibilityState: async () => enabled, setAccessibility: async value => { enabled = value; },
    readiness: async () => ({ loggedIn: true, busy: false }), selection: async () => selection,
    newChat: async () => { state = { composers: [{ composerId: 'run', fullConversationHeadersOnly: [] }], bubbles: { run: [] } }; },
    bindChat: async () => {}, fill: async () => {}, select: async value => {
      selection = value; writeFileSync(join(process.argv[2], 'simulated-selection.json'), JSON.stringify(value));
      // Abrupt exit skips every finally block, like a lost runtime after the set.
      process.exit(23);
    } },
});
try {
  await driver.open(composerPlan({ paths, prompt: 'Edit.', ownerSaysCursorFree: true }), { calibration: true });
  if (process.argv[3] === 'restart') throw Error('restart should refuse');
  await driver.setup({ prompt: 'Edit.' });
} catch (error) {
  if (process.argv[3] === 'restart' && /journal.*recover/i.test(error.message)) process.exit(24);
  throw error;
}
