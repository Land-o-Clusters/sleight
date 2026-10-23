import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { armPaths, assertBundlePin, ordinaryPath, CURSOR_PIN, DESKTOP_BLOCKERS } from './contract.mjs';
const require = createRequire(import.meta.url);

export function inspectBundle(app, run = spawnSync) {
  ordinaryPath(app);
  const product = JSON.parse(readFileSync(join(app, 'Contents/Resources/app/product.json'), 'utf8'));
  const verified = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 60000 });
  if (verified.error || verified.status !== 0) throw Error('Cursor signature verification failed');
  // codesign metadata is written to stderr; the CLI's status and verified seal are separate checks.
  const result = run('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw Error('Cursor signature metadata unavailable');
  return assertBundlePin({ version: product.version, commit: product.commit, bundleId: product.darwinBundleIdentifier,
    teamId: /^TeamIdentifier=(.+)$/m.exec(result.stderr)?.[1], cdhash: /^CDHash=(.+)$/m.exec(result.stderr)?.[1], signatureVerified: true });
}

export function launchPlan(paths = armPaths()) {
  Object.values(paths).forEach(ordinaryPath);
  return { executablePath: join(paths.app, 'Contents/MacOS/Cursor'), args: [
    `--user-data-dir=${paths.userData}`, `--extensions-dir=${paths.extensions}`, '--new-window', '--skip-welcome',
    '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--skip-add-to-recently-opened', paths.workspace],
    env: { HOME: paths.home, CUA_APP_SUPPORT_DIR: paths.helperSupport, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ...Object.fromEntries(['USER', 'LOGNAME', 'TMPDIR', 'LANG'].filter(k => typeof process.env[k] === 'string').map(k => [k, process.env[k]])) } };
}

export function setupPlan({ paths = armPaths() } = {}) {
  return { arm: 'cursor-cu', route: 'desktop', liveReady: false, blockers: DESKTOP_BLOCKERS, pin: CURSOR_PIN, paths, launch: launchPlan(paths), mutates: false,
    ownerSteps: [
      `Copy /Applications/Cursor.app to ${paths.app} with ditto. Keep its signature; the runner verifies it before every launch.`,
      'Launch only the copied executable with the printed arguments and environment. Do not use the global cursor URL handler.',
      'Log in once in that isolated desktop profile. Keep the profile between runs.',
      'Trust only the empty benchmark workspace if Cursor asks.',
      'STOP before enabling Computer Use until helper launch isolation is resolved. The desktop launch environment alone does not isolate the helper.',
      'After that gate is resolved: enable Computer Use, target This Mac, in the agent composer and install the signed helper in benchmark storage.',
      'Grant Cursor Computer Use Accessibility and Screen Recording in System Settings. Complete any Enable Computer Use click yourself.',
      'Select Grok 4.7 High, high effort, normal speed. The probe refuses missing or different recorded parameters.',
      'App cards say Allow Cursor to use <app>?, with Allow once or Allow in this chat and Always Allow. Automatic answers default off.',
      'Quit the isolated copy before the probe; never grant it Always Allow through the harness.',
    ] };
}

export function loginReadiness({ paths = armPaths(), authPresent = storedAuth } = {}) {
  const authStored = authPresent(paths);
  return { arm: 'cursor-cu', route: 'desktop', config: paths.userData, loggedIn: 'unverified', authStored, ready: false,
    missing: [authStored ? 'live login validity' : 'isolated desktop login', 'live helper permissions', 'live composer/model calibration'],
    fix: 'node bench/world/arms/cursor-cu/setup.mjs' };
}

function storedAuth(paths) {
  ordinaryPath(paths.database);
  if (!existsSync(paths.database)) return false;
  // Presence only, never select or display a credential. Load SQLite only for this arm.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(ordinaryPath(paths.database), { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM ItemTable WHERE key = 'cursorAuth/accessToken' AND length(value) > 0").get();
    return row.n === 1;
  } finally { db.close(); }
}

export async function readLoginReadiness(paths = armPaths()) { return loginReadiness({ paths }); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => !['--dry-run', '--readiness'].includes(a))) throw Error('setup only prints steps; use --readiness for metadata');
  console.log(JSON.stringify(args.includes('--readiness') ? await readLoginReadiness() : setupPlan(), null, 2));
}
