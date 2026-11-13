// For tests whose spawn callback returns an inert EventEmitter. This models
// startup capability without forking a Node executable or granting permissions.
export const fakeReplNode = () => ({
  execPath: process.execPath,
  flags: new Set(['--permission', '--allow-net']),
});
