import test from 'node:test';
import assert from 'node:assert/strict';
import { listedProducts, storesForZip, addCartItem, checkShop, checkRealShop, serveShopPage,
  selectSuiteTasks, assertShopSmokeRuns, attachCartShot, SHOP_CART, SHOP_ZIP, REAL_SHOP } from '../bench/shop.mjs';
import * as benchmark from '../bench/tasks.mjs';

const getTask = id => {
  const task = benchmark.getTasks('real').find(item => item.id === id);
  assert.ok(task, `real suite must provide ${id}`);
  return task;
};
const shot = { bytes: Buffer.alloc(800, 1) };

test('catalog listing hides search-only items until a query, and paginates the rest', () => {
  const first = listedProducts();
  assert.equal(first.pages, 2);
  assert.deepEqual(first.items.map(item => item.id), ['lamp', 'board', 'mug', 'bin', 'frame', 'pillow']);
  assert.ok(!first.items.some(item => item.id === 'shoes' || item.id === 'tote'));
  const second = listedProducts('', '', 2);
  assert.ok(second.items.some(item => item.id === 'tote'));
  const accessories = listedProducts('', 'Accessories');
  assert.ok(accessories.items.some(item => item.id === 'tote'));
  assert.deepEqual(listedProducts('trail').items.map(item => item.id), ['shoes']);
  assert.deepEqual(storesForZip(SHOP_ZIP).map(item => item.id), ['lakeside', 'riverwalk', 'midtown']);
  assert.deepEqual(storesForZip('00000'), []);
});

test('local shop check requires the exact store and cart, not the agent answer', async t => {
  const ctx = { nonce: 'abc123' };
  await serveShopPage(ctx);
  t.after(() => ctx.closeServer());
  const home = await fetch(ctx.url);
  const html = await home.text();
  assert.match(html, /Set your store/);
  assert.match(html, /Harbor Market/);
  assert.doesNotMatch(html, /Target|Best Buy|bestbuy/i);
  assert.notEqual(checkShop({ ...ctx, answer: 'Cart is ready' }), true);
  await fetch(ctx.url + 'store', { method: 'POST', body: new URLSearchParams({ zip: SHOP_ZIP }) });
  await fetch(ctx.url + 'store/select', { method: 'POST', body: new URLSearchParams({ store: 'lakeside' }) });
  assert.notEqual(checkShop(ctx), true);
  for (const item of SHOP_CART) {
    await fetch(ctx.url + 'cart', { method: 'POST', body: new URLSearchParams(item) });
  }
  assert.equal(checkShop(ctx), true);
});

test('local shop check rejects the wrong store, option, extra item or quantity', async t => {
  const ctx = { nonce: 'abc123' };
  await serveShopPage(ctx);
  t.after(() => ctx.closeServer());
  await fetch(ctx.url + 'store', { method: 'POST', body: new URLSearchParams({ zip: SHOP_ZIP }) });
  await fetch(ctx.url + 'store/select', { method: 'POST', body: new URLSearchParams({ store: 'riverwalk' }) });
  for (const item of SHOP_CART) await fetch(ctx.url + 'cart', { method: 'POST', body: new URLSearchParams(item) });
  assert.notEqual(checkShop(ctx), true);
  ctx.page.storeId = 'lakeside';
  ctx.page.cart = addCartItem([], 'lamp', 'Black');
  assert.notEqual(checkShop(ctx), true);
  ctx.page.cart = SHOP_CART.concat({ id: 'mug', option: 'Cream', quantity: 1 });
  assert.notEqual(checkShop(ctx), true);
  ctx.page.cart = SHOP_CART.map(item => item.id === 'lamp' ? { ...item, quantity: 2 } : item);
  assert.notEqual(checkShop(ctx), true);
});

test('local shop page exposes search, filters, pagination, options and popups', async t => {
  const ctx = { nonce: 'abc123' };
  await serveShopPage(ctx);
  t.after(() => ctx.closeServer());
  const home = await (await fetch(ctx.url)).text();
  assert.match(home, /Cedar Desk Lamp/);
  assert.doesNotMatch(home, /Canvas Tote|Trail Running Shoes/);
  assert.match(home, /Page 2/);
  assert.match(home, /Accessories/);
  assert.match(home, /Decline non-essential cookies/);
  const page2 = await (await fetch(ctx.url + 'search?page=2')).text();
  assert.match(page2, /Canvas Tote/);
  const search = await (await fetch(ctx.url + 'search?q=trail')).text();
  assert.match(search, /Trail Running Shoes/);
  const product = await (await fetch(ctx.url + 'product/lamp')).text();
  assert.match(product, /Loading options/);
  const details = await (await fetch(ctx.url + 'product/lamp/details')).text();
  assert.match(details, /Add to cart/);
  assert.match(details, /Brass/);
});

for (const id of ['safari-shop', 'helium-shop']) {
  test(`${id} is a local shop task both arms can run`, () => {
    const task = getTask(id);
    assert.equal(typeof task.prepare, 'function');
    assert.equal(typeof task.setup, 'function');
    assert.equal(task.smoke, undefined);
    assert.match(task.prompt({ url: 'http://127.0.0.1:9/abc123/', nonce: 'abc123' }), /55401/);
    assert.doesNotMatch(task.prompt({ url: 'http://127.0.0.1:9/abc123/', nonce: 'abc123' }), /sleight|mcp__|getApp/);
    assert.equal(task.check, checkShop);
  });
}

for (const id of ['real-shop-target', 'real-shop-bestbuy']) {
  test(`${id} is a Safari smoke task whose check reads the answer and cart shot`, () => {
    const task = getTask(id);
    const spec = REAL_SHOP[id];
    assert.equal(task.app, 'Safari');
    assert.equal(task.smoke, true);
    const ctx = { nonce: 'abc123' };
    task.prepare(ctx);
    assert.equal(ctx.url, spec.url);
    const prompt = task.prompt(ctx);
    assert.match(prompt, /Never sign in/);
    assert.match(prompt, /CAPTCHA/);
    assert.match(prompt, new RegExp(spec.zip));
    for (const item of spec.items) assert.match(prompt, new RegExp(item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const answer = `${spec.items.map(item => item.name).join(', ')} at ZIP ${spec.zip}`;
    assert.notEqual(checkRealShop({ shopSmoke: id, answer }), true);
    assert.equal(checkRealShop({ shopSmoke: id, answer, cartShot: shot }), true);
    assert.notEqual(checkRealShop({ shopSmoke: id, answer: `${answer}. CAPTCHA blocked the cart.`, cartShot: shot }), true);
    assert.notEqual(checkRealShop({ shopSmoke: id, answer: `ZIP ${spec.zip}`, cartShot: shot }), true);
  });
}

test('default real selection excludes smoke shop tasks, and those tasks require one run', () => {
  const all = benchmark.getTasks('real');
  const selected = selectSuiteTasks(all);
  assert.ok(selected.some(task => task.id === 'safari-shop'));
  assert.ok(selected.every(task => !task.smoke));
  assert.throws(() => assertShopSmokeRuns(all.filter(task => task.smoke), 3), /runs 1/);
  assert.doesNotThrow(() => assertShopSmokeRuns(all.filter(task => task.smoke), 1));
  assert.deepEqual(selectSuiteTasks(all, ['real-shop-target']).map(task => task.id), ['real-shop-target']);
});

test('a supplied cart screenshot attaches without capturing the screen', () => {
  const ctx = {};
  const attached = attachCartShot(ctx, { screenshot: shot });
  assert.equal(attached.bytes, shot.bytes);
  assert.equal(ctx.cartShot.bytes, shot.bytes);
});

// Safari exposes no document URL, so the fixture finds the window by the nonce in its title.
test('every shop page title carries the run nonce', async t => {
  const ctx = { nonce: 'nonce42' };
  await serveShopPage(ctx);
  t.after(() => ctx.closeServer());
  for (const path of ['', 'cart', `product/${listedProducts().items[0].id}`]) {
    const html = await (await fetch(ctx.url + path)).text();
    assert.match(html, /<title>[^<]*nonce42<\/title>/, path || 'home');
  }
});
