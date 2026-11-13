import { handHostBuilt } from '../direct-browser/host-cache.mjs';
import { createUiChannel } from '../direct-browser/ui-channel.mjs';
import { walkAncestors } from './darwin-ancestry.mjs';
import { createUnixRendererSink } from './darwin-cursor.mjs';
import { darwinPaths, darwinEnvironment } from './paths.mjs';
import { darwinFilePermissions } from './file-permissions.mjs';
import { posix } from 'node:path';

// Importing settings, ancestry or events never loads the compiler/spawn implementation.
const host = () => import('../direct-browser/host.mjs');
export const darwin = Object.freeze({
  id: 'darwin', paths: darwinPaths, join: posix.join,
  hand: Object.freeze({ supported: true }),
  nativeHost: Object.freeze({ built: handHostBuilt,
    prepare: async options => (await host()).prepareHandHost(options),
    createFrameChannel: createUiChannel, environment: darwinEnvironment }),
  cursorSink: Object.freeze({ transport: 'unix-socket', create: createUnixRendererSink }),
  person: Object.freeze({ walkAncestors, prepareConfirm: async options => (await host()).prepareConfirmHost(options) }),
  filePermissions: darwinFilePermissions,
});
