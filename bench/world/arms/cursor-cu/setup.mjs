import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { armPaths, assertBundlePin, ordinaryPath, CURSOR_PIN, DESKTOP_BLOCKERS, requireOwnerFree } from './contract.mjs';
import { retryBusy } from './state.mjs';
import { scrubCursor } from './scrub.mjs';
const require = createRequire(import.meta.url);

export function inspectBundle(app, run = spawnSync) {
  ordinaryPath(app);
  const product = JSON.parse(readFileSync(join(app, 'Contents/Resources/app/product.json'), 'utf8'));
  const plist = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
  if (plist.error || plist.status !== 0 || !plist.stdout?.trim()) throw Error('Cursor Info.plist bundle identifier unavailable');
  const verified = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 60000 });
  if (verified.error || verified.status !== 0) throw Error('Cursor signature verification failed');
  // codesign metadata is written to stderr; the CLI's status and verified seal are separate checks.
  const result = run('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  if (result.error || result.status !== 0) throw Error('Cursor signature metadata unavailable');
  return assertBundlePin({ version: product.version, commit: product.commit, bundleId: plist.stdout.trim(),
    teamId: /^TeamIdentifier=(.+)$/m.exec(result.stderr)?.[1], cdhash: /^CDHash=(.+)$/m.exec(result.stderr)?.[1], signatureVerified: true });
}

export function setupPlan({ paths = armPaths() } = {}) {
  return { arm: 'cursor-cu', route: 'desktop', liveReady: false, blockers: DESKTOP_BLOCKERS, pin: CURSOR_PIN, paths, mutates: false,
    ownerSteps: [
      'Keep your installed /Applications/Cursor.app running with your existing login.',
      'When Cursor is free, explicitly pass --owner-says-cursor-free. Live fixtures also require --owner-away.',
      'Run supervised calibration once. Computer Use must already be enabled with its helper permissions granted.',
      'The harness saves model and Computer Use selections, opens a new chat and selects Grok 4.7 High, high effort, normal speed, This Mac.',
      'It restores the saved selections on success, failure and interruption, and leaves Cursor and every chat open.',
      'Only Allow in this chat cards for allowlisted apps may be answered. Always Allow needs the owner.',
    ] };
}

export function loginReadiness({ paths = armPaths(), authPresent = storedAuth, ownerSaysCursorFree = false } = {}) {
  requireOwnerFree({ ownerSaysCursorFree });
  const authStored = authPresent(paths);
  return { arm: 'cursor-cu', route: 'desktop', config: scrubCursor(paths.userData), loggedIn: 'unverified', authStored, ready: false,
    missing: [authStored ? 'live login validity' : 'owner desktop login', 'live helper permissions', 'live composer/model calibration'],
    fix: 'node bench/world/arms/cursor-cu/setup.mjs' };
}

function storedAuth(paths) {
  ordinaryPath(paths.database);
  if (!existsSync(paths.database)) return false;
  // Presence only, never select or display a credential. Load SQLite only for this arm.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(ordinaryPath(paths.database), { readOnly: true, timeout: 100 });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM ItemTable WHERE key = 'cursorAuth/accessToken' AND length(value) > 0").get();
    return row.n === 1;
  } finally { db.close(); }
}

export async function readLoginReadiness(paths = armPaths(), { ownerSaysCursorFree = false } = {}) { return retryBusy(() => loginReadiness({ paths, ownerSaysCursorFree })); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => !['--dry-run', '--readiness', '--owner-says-cursor-free'].includes(a))) throw Error('setup only prints steps; use --readiness for metadata');
  console.log(JSON.stringify(scrubCursor(args.includes('--readiness') ? await readLoginReadiness(undefined, { ownerSaysCursorFree: args.includes('--owner-says-cursor-free') }) : setupPlan()), null, 2));
}
