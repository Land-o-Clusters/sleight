import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { acquireFixture } from '../real-run.mjs';
import { openFixture, closeFixtures, webBrowsers } from '../real-fixture.mjs';
import { startServer } from '../fowl/site/server.mjs';
import { ccBase, checkCCFixture, createCCFixture } from '../fowl/site/cc-held-out.mjs';
import { realBrowserPlan, launchRealBrowser } from '../fowl/real-browser.mjs';

export const ccCatalog = JSON.parse(readFileSync(new URL('./tasks/cc-held-out.json', import.meta.url)));

function browserTask(row, launchBrowser) {
  const browser = webBrowsers.find(browser => browser.id === row.browser);
  const prepare = async ctx => {
    if (ctx.closeServer) throw Error('CC fixture server already exists');
    ctx.cc = createCCFixture(row.kind, ctx);
    const server = await startServer({ port: 0, ccFixtures: [ctx.cc] });
    ctx.closeServer = server.close;
    ctx.url = `http://127.0.0.1:${server.port}${ccBase(ctx.cc)}`;
  };
  return { id: row.task, app: browser.app, half: 'browser', heldOut: true, requiredProfile: 'fresh', prepare,
    setup: async ctx => {
      if (ctx.realProfile !== 'fresh') throw Error('CC_ISOLATED_PROFILE_REQUIRED: select --real-profile fresh');
      if (ctx.ownerAway !== true) throw Error('CC_OWNER_AWAY_REQUIRED');
      ctx.signal?.throwIfAborted();
      await prepare(ctx);
      const plan = realBrowserPlan({ browser: row.browser, round: `cc-${row.browser}-${ctx.nonce}`, profile: ctx.realProfile });
      await acquireFixture(ctx, 'browser', () => launchBrowser(plan, {
        initialPage: { url: ctx.url, title: `Held-out ${row.kind} ${ctx.nonce}` },
      }));
    },
    prompt: ctx => row.prompt.replaceAll('{url}', ctx.url).replaceAll('{target}', ctx.cc.target.label),
    check: ctx => checkCCFixture(ctx.cc, ctx.answer), cleanup: async ctx => {
      if (!ctx.browser) return;
      await ctx.beforeFixtureCleanup?.();
      ctx.cleanupSignal?.throwIfAborted();
      const receipt = await ctx.browser.stop();
      if (receipt?.browserClosed !== true) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
    },
  };
}

const content = (ctx, row) => `Collection ${ctx.nonce} ${ctx.cc.token}\n${row.name}\n`;
function prepareNative(ctx) {
  ctx.cc = createCCFixture('list', ctx);
  ctx.folder = join(ctx.dir, `Collections-${ctx.nonce}-${randomBytes(8).toString('hex')}`);
  mkdirSync(ctx.folder, { mode: 0o700 });
  for (const row of ctx.cc.rows) writeFileSync(join(ctx.folder, row.file), content(ctx, row), { flag: 'wx', mode: 0o600 });
}

export function checkNativeList(ctx) {
  try {
    const names = readdirSync(ctx.folder).filter(name => name !== '.DS_Store').sort();
    const expected = ctx.cc.rows.map(row => row === ctx.cc.target ? 'Chosen.txt' : row.file).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) return 'CC_NATIVE_LIST_NAMES_MISMATCH';
    for (const row of ctx.cc.rows) {
      const path = join(ctx.folder, row === ctx.cc.target ? 'Chosen.txt' : row.file), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(path, 'utf8') !== content(ctx, row)) return 'CC_NATIVE_LIST_CONTENT_MISMATCH';
    }
    return true;
  } catch { return 'CC_NATIVE_LIST_UNAVAILABLE'; }
}

function nativeTask(row, open) {
  return { id: row.task, app: 'Finder', half: 'native', heldOut: true, prepare: prepareNative,
    setup: async ctx => {
      prepareNative(ctx);
      await acquireFixture(ctx, 'finder', () => open(ctx, { app: 'Finder', bundle: 'com.apple.finder', target: ctx.folder,
        token: basename(ctx.folder), mode: 'folder' }));
    },
    prompt: ctx => row.prompt.replaceAll('{folder}', ctx.folder).replaceAll('{file}', ctx.cc.target.file),
    check: checkNativeList, cleanup: closeFixtures,
  };
}

export const ccHeldOutTasks = (open = openFixture, { launchBrowser = launchRealBrowser } = {}) =>
  ccCatalog.map(row => row.half === 'native' ? nativeTask(row, open) : browserTask(row, launchBrowser));
