// Code-only test seam. Production never imports this module or accepts a home path from the environment.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
export function isolateUser(home) {
  const user = os.userInfo();
  os.userInfo = () => ({ ...user, homedir: home });
  syncBuiltinESMExports();
}
