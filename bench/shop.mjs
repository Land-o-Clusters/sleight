import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const SHOP_ZIP = '55401';
export const SHOP_STORE = 'lakeside';
export const SHOP_PAGE = 6;
export const SHOP_CART = [
  { id: 'lamp', option: 'Brass', quantity: 1 },
  { id: 'shoes', option: '10', quantity: 1 },
  { id: 'tote', option: 'Navy', quantity: 1 },
];
export const PRODUCTS = [
  { id: 'lamp', name: 'Cedar Desk Lamp', category: 'Lighting', options: { Color: ['Brass', 'Black'] } },
  { id: 'board', name: 'Oak Cutting Board', category: 'Kitchen', options: { Size: ['Small', 'Large'] } },
  { id: 'mug', name: 'Harbor Mug', category: 'Kitchen', options: { Color: ['Cream', 'Blue'] } },
  { id: 'bin', name: 'Pine Storage Bin', category: 'Home', options: { Size: ['Medium', 'Large'] } },
  { id: 'frame', name: 'Maple Picture Frame', category: 'Home', options: { Color: ['Walnut', 'White'] } },
  { id: 'pillow', name: 'Willow Throw Pillow', category: 'Home', options: { Color: ['Sage', 'Sand'] } },
  { id: 'tote', name: 'Canvas Tote', category: 'Accessories', options: { Color: ['Navy', 'Natural'] } },
  { id: 'notebook', name: 'Birch Notebook', category: 'Accessories', options: { Size: ['A5', 'A4'] } },
  { id: 'candle', name: 'Spruce Candle', category: 'Home', options: { Scent: ['Pine', 'Citrus'] } },
  { id: 'coasters', name: 'Elm Coasters', category: 'Accessories', options: { Color: ['Oak', 'Black'] } },
  { id: 'planter', name: 'Aspen Planter', category: 'Home', options: { Size: ['Small', 'Medium'] } },
  { id: 'soap', name: 'Juniper Soap', category: 'Bath', options: { Scent: ['Mint', 'Lavender'] } },
  { id: 'shoes', name: 'Trail Running Shoes', category: 'Outdoor', options: { Size: ['8', '9', '10', '11'] }, searchOnly: true },
];
export const STORES = [
  { id: 'lakeside', name: 'Lakeside Superstore', zip: '55401' },
  { id: 'riverwalk', name: 'Riverwalk Outlet', zip: '55402' },
  { id: 'midtown', name: 'Midtown Depot', zip: '55403' },
];
export const REAL_SHOP = {
  'real-shop-target': {
    site: 'Target', url: 'https://www.target.com/', zip: SHOP_ZIP, token: 'Target',
    items: [
      { name: 'up&up Paper Towels', option: '6 Giant Rolls' },
      { name: 'Goodfellow & Co Crewneck T-Shirt', option: 'size M' },
      { name: 'Threshold Cozy Knit Throw', option: 'Gray' },
    ],
  },
  'real-shop-bestbuy': {
    site: 'Best Buy', url: 'https://www.bestbuy.com/', zip: SHOP_ZIP, token: 'Best Buy',
    items: [
      { name: 'Duracell Coppertop AA batteries', option: '16-pack' },
      { name: 'Anker USB-C to USB-C cable', option: '6 ft' },
      { name: 'SanDisk Ultra USB flash drive', option: '64GB' },
    ],
  },
};

const escape = value => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

export function listedProducts(query = '', filter = '', page = 1) {
  const q = String(query).trim().toLowerCase();
  const f = String(filter).trim();
  let items = PRODUCTS.filter(product => !product.searchOnly || q);
  if (q) items = items.filter(product => product.name.toLowerCase().includes(q));
  if (f) items = items.filter(product => product.category === f);
  const pages = Math.max(1, Math.ceil(items.length / SHOP_PAGE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { items: items.slice((current - 1) * SHOP_PAGE, current * SHOP_PAGE), page: current, pages, total: items.length };
}

export function storesForZip(zip) {
  return String(zip) === SHOP_ZIP ? STORES : [];
}

export function addCartItem(cart, id, option, quantity = 1) {
  const product = PRODUCTS.find(item => item.id === id);
  const allowed = product && Object.values(product.options).flat().includes(option);
  const count = Number(quantity);
  if (!allowed || !Number.isInteger(count) || count < 1 || count > 9) return cart;
  const next = cart.map(item => ({ ...item }));
  const found = next.find(item => item.id === id && item.option === option);
  if (found) found.quantity = Math.min(9, found.quantity + count);
  else next.push({ id, option, quantity: count });
  return next;
}

export function cartMatches(cart) {
  const got = [...(cart ?? [])].map(item => ({ id: item.id, option: item.option, quantity: item.quantity }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.option.localeCompare(b.option));
  const want = [...SHOP_CART].sort((a, b) => a.id.localeCompare(b.id) || a.option.localeCompare(b.option));
  return isDeepStrictEqual(got, want);
}

export function checkShop(ctx) {
  const page = ctx.page;
  return page?.zip === SHOP_ZIP && page.storeId === SHOP_STORE && cartMatches(page.cart) ||
    'server cart or store does not match the three required items for ZIP 55401';
}

export function shopSmokeHost(host) {
  return host === 'www.target.com' || host === 'www.bestbuy.com';
}

export function selectSuiteTasks(suiteTasks, wanted) {
  if (wanted) {
    const selected = suiteTasks.filter(task => wanted.includes(task.id));
    if (!selected.length) throw new Error(`no tasks match ${wanted}`);
    if (wanted.some(id => !suiteTasks.some(task => task.id === id))) throw new Error('unknown task in selected suite');
    return selected;
  }
  return suiteTasks.filter(task => !task.smoke);
}

export function assertShopSmokeRuns(selected, runs) {
  if (selected.some(task => task.smoke) && runs !== 1) throw new Error('shop smoke tasks require --runs 1');
}

export function attachCartShot(ctx, response = {}) {
  if (ctx.cartShot?.bytes?.length >= 800) return ctx.cartShot;
  const shot = response.cartShot ?? response.screenshot;
  const bytes = Buffer.isBuffer(shot) ? shot : shot?.bytes;
  if (bytes?.length >= 800) return ctx.cartShot = { bytes };
  return ctx.cartShot;
}

function safariWindowId(pid, token) {
  const script = `ObjC.import('CoreGraphics');
const list = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
const rows = ObjC.deepUnwrap(list) || [];
const match = rows.find(row => row.kCGWindowOwnerPID === ${Number(pid)} && String(row.kCGWindowName || '').includes(${JSON.stringify(token)}));
match ? String(match.kCGWindowNumber) : ''`;
  try {
    const id = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 8000 }).trim();
    return /^\d+$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

export async function captureCartShot(ctx, response = {}) {
  attachCartShot(ctx, response);
  if (ctx.cartShot?.bytes?.length >= 800) return ctx.cartShot;
  const dest = ctx.dir ? join(ctx.dir, 'cart.png') : undefined;
  const pid = ctx.browser?.pid;
  const token = REAL_SHOP[ctx.shopSmoke]?.token;
  if (!dest || !pid || !token) return ctx.cartShot;
  try {
    const id = safariWindowId(pid, token);
    if (!id) return ctx.cartShot;
    execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-t', 'png', '-l', id, dest], { timeout: 8000 });
    const bytes = readFileSync(dest);
    if (bytes.length >= 800) ctx.cartShot = { bytes };
  } catch {}
  return ctx.cartShot;
}

export function checkRealShop(ctx) {
  const spec = REAL_SHOP[ctx.shopSmoke];
  if (!spec) return 'unknown smoke shop task';
  const answer = String(ctx.answer ?? '');
  if (/\b(captcha|bot check|unusual traffic|are you a human)\b/i.test(answer)) {
    return 'stopped at a CAPTCHA or bot check';
  }
  const missing = spec.items.filter(item => !answer.toLowerCase().includes(item.name.toLowerCase()));
  if (missing.length) return `answer does not name ${missing.map(item => item.name).join(', ')}`;
  if (!answer.includes(spec.zip)) return 'answer does not name the store ZIP';
  const shot = ctx.cartShot;
  if (!shot?.bytes || shot.bytes.length < 800) return 'no cart-page screenshot';
  return true;
}

function shell(title, body) {
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<style>
body{font:16px system-ui;margin:0;color:#1b2430;background:#f4f1ea}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 20px;background:#1b3a4b;color:#fff}
header a,header button{color:#fff}
main{display:grid;grid-template-columns:220px 1fr;gap:20px;padding:20px}
.filters a,.results a{display:block;margin:8px 0}
.card{padding:12px;border:1px solid #c5c0b5;background:#fff}
button,input,select{font:inherit}
dialog{max-width:420px}
.cart{position:fixed;right:16px;bottom:16px;background:#fff;border:1px solid #c5c0b5;padding:12px}
</style>${body}`;
}

function chrome(state, prefix, inner) {
  const store = STORES.find(item => item.id === state.storeId);
  return `<header>
  <strong>Harbor Market</strong>
  <form method="post" action="${prefix}store">
    <label>Set your store <input name="zip" inputmode="numeric" autocomplete="off" value="${escape(state.zip)}"></label>
    <button>Find stores</button>
  </form>
  <span>${store ? `Store: ${escape(store.name)}` : 'No store set'}</span>
  <form method="get" action="${prefix}search"><label>Search <input name="q" type="search"></label><button>Search</button></form>
  <a href="${prefix}cart">Cart (${state.cart.reduce((n, item) => n + item.quantity, 0)})</a>
</header>
${state.found?.length ? `<section class="card"><h2>Stores near ${escape(state.zip)}</h2>${state.found.map(item =>
    `<form method="post" action="${prefix}store/select"><input type="hidden" name="store" value="${escape(item.id)}"><button>Shop ${escape(item.name)}</button></form>`).join('')}</section>` : ''}
${inner}
${!state.cookie ? `<dialog open><p>Harbor Market uses cookies for the cart and store.</p>
<form method="post" action="${prefix}popup/cookie"><button>Decline non-essential cookies</button></form></dialog>` : ''}
${state.cookie && !state.newsletter ? `<dialog open><p>Get the Harbor Market newsletter?</p>
<form method="post" action="${prefix}popup/newsletter"><button>No thanks</button></form></dialog>` : ''}
<div class="cart"><a href="${prefix}cart">View cart</a></div>`;
}

function productForm(product, prefix) {
  const [kind, values] = Object.entries(product.options)[0];
  return `<form method="post" action="${prefix}cart">
<input type="hidden" name="id" value="${escape(product.id)}">
<label>${escape(kind)} <select name="option">${values.map(value => `<option>${escape(value)}</option>`).join('')}</select></label>
<button>Add to cart</button></form>`;
}

function render(state, prefix, route, query) {
  if (route === 'cart') {
    const rows = state.cart.map(item => {
      const product = PRODUCTS.find(entry => entry.id === item.id);
      return `<li>${escape(product?.name ?? item.id)} — ${escape(item.option)} × ${item.quantity}</li>`;
    }).join('') || '<li>Cart is empty</li>';
    return shell('Cart · Harbor Market', chrome(state, prefix, `<main><section><h1>Cart</h1><ul>${rows}</ul></section></main>`));
  }
  const product = PRODUCTS.find(item => route === `product/${item.id}`);
  if (product) {
    return shell(`${product.name} · Harbor Market`, chrome(state, prefix, `<main><article>
<h1>${escape(product.name)}</h1>
<p>Category: ${escape(product.category)}</p>
<div id="options">Loading options…</div>
<div id="similar">Loading similar items…</div>
<script>
setTimeout(() => fetch(${JSON.stringify(prefix + 'product/' + product.id + '/details')}).then(r => r.text()).then(html => {
  document.getElementById('options').innerHTML = html;
}), 400);
setTimeout(() => { document.getElementById('similar').textContent = 'Similar items appear after the options load.'; }, 800);
</script></article></main>`));
  }
  const listing = listedProducts(query.q, query.filter, query.page);
  const filters = [...new Set(PRODUCTS.map(item => item.category))];
  const results = listing.items.map(item => `<article class="card"><a href="${prefix}product/${escape(item.id)}">${escape(item.name)}</a><p>${escape(item.category)}</p></article>`).join('');
  const pages = Array.from({ length: listing.pages }, (_, i) => {
    const page = String(i + 1);
    const params = new URLSearchParams({ ...query, page });
    return `<a href="${prefix}search?${params}">Page ${page}</a>`;
  }).join(' ');
  return shell('Harbor Market', chrome(state, prefix, `<main>
<nav class="filters"><h2>Filters</h2>${filters.map(name =>
    `<a href="${prefix}search?${new URLSearchParams({ ...query, filter: name, page: '1' })}">${escape(name)}</a>`).join('')}</nav>
<section class="results"><h1>Results</h1>${results}<p>${pages}</p></section>
</main>`));
}

export async function serveShopPage(ctx) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(ctx.nonce)) throw new Error('invalid shop fixture nonce');
  if (ctx.closeServer) throw new Error('shop fixture server already exists');
  const prefix = `/${ctx.nonce}/`;
  const state = { zip: '', storeId: null, found: [], cart: [], cookie: false, newsletter: false };
  let origin;
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    const route = new URL(req.url, 'http://localhost');
    const path = route.pathname;
    if (req.headers.host !== origin?.slice(7) || !path.startsWith(prefix)) { res.writeHead(404).end(); return; }
    if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    const screen = path.slice(prefix.length);
    const finish = (status, html, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type }).end(html);
    };
    const redirect = to => { res.writeHead(303, { location: to }).end(); };
    let body = '', size = 0, tooLarge = false;
    req.on('data', chunk => { size += chunk.length; if (size > 8192) { if (!tooLarge) res.writeHead(413).end(); tooLarge = true; } else body += chunk; });
    req.on('end', () => {
      if (tooLarge) return;
      const fields = Object.fromEntries(new URLSearchParams(body));
      if (req.method === 'POST' && screen === 'store') {
        state.zip = String(fields.zip ?? '').replace(/\D/g, '').slice(0, 5);
        state.found = storesForZip(state.zip);
        state.storeId = null;
        return finish(200, render(state, prefix, 'search', {}));
      }
      if (req.method === 'POST' && screen === 'store/select') {
        const chosen = state.found.find(item => item.id === fields.store);
        if (chosen) { state.storeId = chosen.id; state.zip = chosen.zip; state.found = []; }
        return redirect(prefix);
      }
      if (req.method === 'POST' && screen === 'cart') {
        state.cart = addCartItem(state.cart, fields.id, fields.option, Number(fields.quantity ?? 1));
        return redirect(prefix + 'cart');
      }
      if (req.method === 'POST' && screen === 'popup/cookie') { state.cookie = true; return redirect(prefix); }
      if (req.method === 'POST' && screen === 'popup/newsletter') { state.newsletter = true; return redirect(prefix); }
      if (req.method !== 'GET') { res.writeHead(404).end(); return; }
      const details = screen.match(/^product\/([a-z]+)\/details$/)?.[1];
      if (details) {
        const product = PRODUCTS.find(item => item.id === details);
        if (!product) { res.writeHead(404).end(); return; }
        return finish(200, productForm(product, prefix));
      }
      if (screen === '' || screen === 'search' || screen === 'cart' || /^product\/[a-z]+$/.test(screen)) {
        return finish(200, render(state, prefix, screen === '' ? 'search' : screen, {
          q: route.searchParams.get('q') ?? '',
          filter: route.searchParams.get('filter') ?? '',
          page: route.searchParams.get('page') ?? '1',
        }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  ctx.page = state;
  ctx.url = origin + prefix;
  let closing;
  ctx.closeServer = () => closing ??= new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export const SHOP_INSTRUCTIONS = 'Set the store for ZIP 55401 and choose Lakeside Superstore. ' +
  'Add these three items with these options to the cart: Cedar Desk Lamp in Brass, Trail Running Shoes in size 10, and Canvas Tote in Navy. ' +
  'Cedar Desk Lamp is on the first results page. Trail Running Shoes needs a search. Canvas Tote is on the second page of the default catalog, or under the Accessories filter. ' +
  'Dismiss cookie and newsletter popups if they appear. Wait for product options to finish loading before adding. Leave the cart visible.';
