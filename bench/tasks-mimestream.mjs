import { prepareMimestream, setupMimestream, promptMimestream, checkMimestream, cleanupMimestream,
  expectedMimestream, labelsMimestream } from './real-mimestream.mjs';

export const mimestreamTasks = ['label', 'message', 'thread', 'scroll', 'search'].map(kind => ({
  id: `mimestream-${kind}`, app: 'Mimestream', privateMail: true,
  prepare: prepareMimestream, setup: ctx => setupMimestream(ctx, kind),
  prompt: promptMimestream, check: checkMimestream, cleanup: cleanupMimestream,
  privateExpected: expectedMimestream, privateTerms: labelsMimestream,
}));
