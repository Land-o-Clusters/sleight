import { createHash } from 'node:crypto';

// Catalog identity needs no process inspection, helpers or browser connection.
export const selectedBrowserId = ({ profileRoot, executable }) =>
  'b' + createHash('sha256').update(profileRoot + '\0' + executable).digest('hex').slice(0, 32);
