import { execFileSync } from 'node:child_process';

// The benchmark's force-quit fallback returns without collecting Chess.
// Wait for absence, then bound retries of the observed LaunchServices -600.
export function restartChess({ quit, run = execFileSync } = {}) {
  quit();
  let exited = false;
  for (let n = 0; n < 40; n++) {
    try { run('/usr/bin/pgrep', ['-x', 'Chess'], { stdio: 'pipe', timeout: 2000 }); }
    catch (error) {
      if (error.status !== 1) throw error;
      exited = true; break;
    }
    run('/bin/sleep', ['0.25']);
  }
  if (!exited) throw new Error('Chess did not exit after quit; fresh launch stopped');
  for (let n = 0; n < 3; n++) {
    try {
      run('/usr/bin/open', ['-g', '-a', 'Chess', '--args', '-ApplePersistenceIgnoreState', 'YES'], { stdio: 'pipe', timeout: 15000 });
      return;
    } catch (error) {
      if (n === 2 || !/\b(?:Code|error)\s*[=:]?\s*-600\b/i.test(String(error.stderr ?? error.message))) throw error;
      run('/bin/sleep', ['0.5']);
    }
  }
}
