// This module runs only in offline launcher children, before production modules are evaluated.
// Keep every OS-user settings reader in the caller's mktemp bank without a production HOME override.
import { dirname } from 'node:path';
import { isolateUser } from './isolated-user.mjs';
isolateUser(dirname(process.argv[2]));
