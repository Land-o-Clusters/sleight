// Launcher-owned osascript children share the relay's own-host refusal until collected.
const children = new Set();

export function ownHelper(child) {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

export const ownedHelperChildren = () => [...children];
export const ownedHelperPid = pid => Number.isSafeInteger(pid) && pid > 0 && [...children].some(child => child.pid === pid);
