// Where a task's app had its windows while Claude worked: on the current
// Space, or only off it. Off it covers another Space, minimized, hidden, and
// windows an app keeps off screen (TextEdit with no documents has a 500×500
// one), so only onScreen is a clean signal. A background
// drag refuses an app on another Space, and a pass only measures sleight while
// the benchmark apps show on the current one (LAWS), so each run records it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Counts each app's real windows (menu bar strips are 33 points tall) and how
// many are on screen. CoreGraphics gives owner names, bounds and on-screen state
// without Screen Recording.
const PROBE = `ObjC.import('CoreGraphics');
const counts = {};
for (const w of ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)).js) {
  const o = w.js;
  if (o.kCGWindowLayer.js !== 0 || o.kCGWindowBounds.js.Height.js <= 40) continue;
  const c = counts[o.kCGWindowOwnerName.js] ??= [0, 0];
  c[0]++;
  if (o.kCGWindowIsOnscreen?.js) c[1]++;
}
JSON.stringify(counts)`;

// "DeviceHub" owns its windows as "Device Hub".
const key = name => name.replace(/\s/g, '').toLowerCase();

async function sample(app) {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', PROBE], { timeout: 5000 });
  const entry = Object.entries(JSON.parse(stdout)).find(([owner]) => key(owner) === key(app));
  const [windows, onScreen] = entry?.[1] ?? [0, 0];
  return { windows, onScreen };
}

// Samples every few seconds until stop(), which resolves to how many samples
// found the app's windows on screen, only off screen, or none at all.
export function watchAppWindows(app, everyMs = 5000) {
  const tally = { samples: 0, onScreen: 0, offScreenOnly: 0, none: 0 };
  let timer;
  let pending = Promise.resolve();
  const tick = () => {
    pending = sample(app).then(({ windows, onScreen }) => {
      tally.samples++;
      if (onScreen) tally.onScreen++;
      else if (windows) tally.offScreenOnly++;
      else tally.none++;
    }, () => {}); // a slow probe skips its sample
    timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, 1000);
  return async () => { clearTimeout(timer); await pending; return tally; };
}
