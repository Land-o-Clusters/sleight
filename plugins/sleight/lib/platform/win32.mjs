import { createRequire } from 'node:module';
import { win32Paths, win32Environment } from './paths.mjs';
import { win32 as path } from 'node:path';
import { createWindowsFilePermissions } from '../direct-browser/windows-gates.mjs';
import { walkWindowsAncestors, prepareWindowsConfirmation, prepareWindowsGate, windowsPersonPresence } from './win32-person.mjs';

// Node 24 can synchronously load this ESM factory without importing it on macOS.
const require = createRequire(import.meta.url);
const createCursorSink = options => require('./win32-cursor.mjs').createWindowsRendererSink(options);

const missing = (item, capability) => () => {
  throw Object.assign(Error(`NOT_IMPLEMENTED: ${item} must implement Windows ${capability}.`), { code: 'NOT_IMPLEMENTED', item, capability });
};

// Paths are data only. POSIX mode bits and successful Node file opens never prove a Windows DACL is private.
export const win32 = Object.freeze({
  id: 'win32', paths: win32Paths, join: path.join,
  hand: Object.freeze({ supported: true }),
  nativeHost: Object.freeze({ built: missing('WIN3', 'native host build lookup'), prepare: missing('WIN3', 'native host build and spawn'),
    createFrameChannel: missing('WIN3', 'native host frame channel'), environment: win32Environment }),
  cursorSink: Object.freeze({ transport: 'named-pipe', create: createCursorSink }),
  person: Object.freeze({ walkAncestors: walkWindowsAncestors, prepareGate: prepareWindowsGate,
    prepareConfirm: prepareWindowsConfirmation, presence: windowsPersonPresence }),
  filePermissions: createWindowsFilePermissions(),
});
