import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Frozen from our own d3db241c relay, snapshot and picker implementations. No Git history is needed at test time.
export const defaultReadBaseline = JSON.parse(readFileSync(new URL('default-read-replies-d3db241c.json', import.meta.url)));
export const sha256 = text => createHash('sha256').update(text).digest('hex');
