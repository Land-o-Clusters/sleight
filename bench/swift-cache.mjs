import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One module cache for every benchmark helper compile. A fresh cache per compile cost about 230 MB
// of disk and a full module build each time, and a killed test left it behind: 35 of them held
// 6.5 GB of the temp folder on 2026-10-10. Concurrent swiftc runs share a module cache safely.
export function swiftModuleCache(home = homedir()) {
  const path = join(home, 'Library', 'Caches', 'sleight-bench', 'swift-module-cache');
  mkdirSync(path, { recursive: true });
  return path;
}
