// Default task prompts and checks, with the real suite's retained app observers.
// A comparison containing a generic arm uses this setup for every arm.
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bootedIPhone, serveForm, closeForm, simctl } from './tasks.mjs';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';

export function genericTask(task, { open = openFixture } = {}) {
  const bundles = { Calculator: 'com.apple.calculator', TextEdit: 'com.apple.TextEdit', Chess: 'com.apple.Chess' };
  const prepare = ctx => {
    if (['textedit-edit', 'textedit-drag'].includes(task.id)) {
      ctx.document = join(ctx.dir, `${ctx.nonce}-${task.id.split('-')[1]}.txt`);
      writeFileSync(ctx.document, 'alpha beta gamma\n');
    }
    if (task.id === 'simulator-form') ctx.sim = { name: 'iPhone (selected at setup)', app: 'Simulator' };
  };
  return { ...task, prepare,
    setup: async ctx => {
      if (['chess-drag', 'simulator-form'].includes(task.id) && !ctx.ownerAway) throw new Error('this task requires --owner-away');
      prepare(ctx);
      await ctx.beforeFixtureCleanup?.();
      ctx.signal?.throwIfAborted();
      if (task.id === 'simulator-form') {
        const modern = existsSync('/Applications/Xcode.app/Contents/Applications/DeviceHub.app');
        await acquireFixture(ctx, 'simViewer', () => open(ctx, { app: modern ? 'DeviceHub' : 'Simulator',
          bundle: modern ? 'com.apple.dt.Devices' : 'com.apple.iphonesimulator', target: '', mode: 'inherit', stopOnAppDialog: true }, {
          launch: async beginLaunch => {
            await ctx.beforeFixtureCleanup?.(); ctx.signal?.throwIfAborted();
            await acquireFixture(ctx, 'sim', () => bootedIPhone({ trackOwnership: true, beforeViewerLaunch: beginLaunch }));
            await ctx.beforeFixtureCleanup?.(); ctx.signal?.throwIfAborted();
            ctx.url = await serveForm(ctx.nonce);
            ctx.closeServer = () => closeForm(ctx.nonce);
            await ctx.beforeFixtureCleanup?.(); ctx.signal?.throwIfAborted();
            simctl('openurl', ctx.sim.udid, ctx.url);
          },
        }));
      } else {
        if (!bundles[task.app]) throw new Error(`no generic fixture for ${task.app}`);
        await acquireFixture(ctx, 'app', () => open(ctx, { app: task.app, bundle: bundles[task.app],
          target: ctx.document ?? '', token: ctx.document && basename(ctx.document), mode: ctx.document ? 'document' : 'inherit', stopOnAppDialog: true }));
      }
    },
    cleanup: async ctx => {
      try { await closeFixtures(ctx); }
      finally { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
    },
  };
}
