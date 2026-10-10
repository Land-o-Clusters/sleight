import { serveShopPage, checkShop, checkRealShop, captureCartShot, SHOP_INSTRUCTIONS, REAL_SHOP } from './shop.mjs';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';

async function closePage(ctx) {
  try { await closeFixtures(ctx); }
  finally { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
}

const shopTask = (id, app, bundle) => ({
  id, app,
  prepare: ctx => serveShopPage(ctx),
  setup: async ctx => {
    await serveShopPage(ctx);
    await acquireFixture(ctx, 'browser', () => openFixture(ctx, { app, bundle, target: ctx.url, token: ctx.nonce, mode: 'window' }));
  },
  prompt: ctx => `Using computer use, work only in the new ${app} window showing ${ctx.url}. ${SHOP_INSTRUCTIONS} ` +
    'Leave this window open for cleanup. Do not read, list, switch to or close any other tabs or windows.',
  check: checkShop, cleanup: closePage,
});

const smokeTask = id => {
  const spec = REAL_SHOP[id];
  return {
    id, app: 'Safari', smoke: true,
    prepare: ctx => { ctx.shopSmoke = id; ctx.url = spec.url; },
    setup: async ctx => {
      ctx.shopSmoke = id;
      ctx.url = spec.url;
      await acquireFixture(ctx, 'browser', () => openFixture(ctx, {
        app: 'Safari', bundle: 'com.apple.Safari', target: spec.url, token: spec.token, mode: 'window',
      }));
    },
    prompt: () => `Using computer use, work only in the new Safari window showing ${spec.url}. ` +
      `This is a smoke task on the real ${spec.site} site. Set the store for ZIP ${spec.zip}, then add these three items to the cart: ` +
      spec.items.map(item => `${item.name} (${item.option})`).join('; ') +
      '. Decline non-essential cookies and newsletter or account popups. Never sign in. Never start checkout. ' +
      'If you see a CAPTCHA or bot check, stop immediately and say so. Do not solve it. ' +
      'Leave the cart page visible. In your answer, name the three items, their options, and the ZIP. ' +
      'Leave this window open for cleanup. Do not read, list, switch to or close any other tabs or windows.',
    capture: captureCartShot,
    check: checkRealShop,
    cleanup: closeFixtures,
  };
};

export const shopTasks = [
  shopTask('safari-shop', 'Safari', 'com.apple.Safari'),
  shopTask('helium-shop', 'Helium', 'net.imput.helium'),
  smokeTask('real-shop-target'),
  smokeTask('real-shop-bestbuy'),
];
