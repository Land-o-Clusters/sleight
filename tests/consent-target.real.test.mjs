import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { skip } from './fixtures/cr4-real.mjs';
import { consentFixture as setup } from './fixtures/consent-runner.mjs';
import { checkConsent, verifyConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';

const bad = `onclick="document.body.dataset.accepted='yes'"`;
const close = `onclick="this.closest('section').remove()"`;
const wall = (controls, attrs = '') => `<!doctype html><meta charset="utf-8"><section ${attrs}><p>We use cookies and tracking.</p>${controls}</section><main><button onclick="document.body.dataset.next='yes'">Continue</button></main>`;
const accept = `<button ${bad}>Accept all</button>`;
const reject = `<button ${close}>Reject all</button>`;

for (const [label, attrs] of [['GOV.UK fixed region', 'role="region" aria-label="Cookies on this site" style="position:fixed"'], ['unnamed fixed container', 'style="position:fixed"']]) {
  test(`${label}: accept is blocked and the result names Reject all`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, wall(accept + reject, attrs));
    const result = await f.act('Accept all');
    assert.match(result, /not run:.*Reject all/);
    assert.equal(await f.entry.page.locator('body').getAttribute('data-accepted'), null, result);
  });
}

for (const [vendor, record, containerId, rejectId] of [['OneTrust', "document.cookie='OptanonConsent=groups%3DC0001%3A1%2CC0002%3A0;path=/'", 'onetrust-banner-sdk', 'onetrust-reject-all-handler'],
  ['Cookiebot', "document.cookie='CookieConsent=%7Bstamp%3Aabc%2Cnecessary%3Atrue%2Cpreferences%3Afalse%7D;path=/'", 'CybotCookiebotDialog', 'CybotCookiebotDialogBodyButtonDecline'],
  ['TCF', "localStorage.setItem('euconsent-v2','CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA')", 'cmpbox', 'cmp-reject-all']]) {
  test(`${vendor}: Reject closes the wall and reports decline despite vendor encoding`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, wall(`<div class="cmp-actions"><button id="${rejectId}" onclick="${record};this.closest('section').remove()">Reject all</button></div>`, `id="${containerId}" role="dialog"`));
    assert.match(await f.act('Reject all'), /decline confirmed/i);
    assert.doesNotMatch(await f.act('Continue'), /Cookie acceptance blocked/);
    assert.equal(await f.entry.page.locator('body').getAttribute('data-next'), 'yes');
  });
}

test('sticky recipe sidebar with cookies does not fence the recipe action', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, '<aside style="position:sticky;top:0"><h2>Cookies</h2><button>Manage preferences</button></aside><main><button onclick="document.body.dataset.next=\'yes\'">Continue</button></main>');
  assert.doesNotMatch(await f.act('Continue'), /Cookie acceptance blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-next'), 'yes');
});

for (const heading of ['OAuth permission', '同意', '동의', 'Zgoda']) {
  test(`${heading}: bare consent permits I consent`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, `<section role="dialog"><h1>${heading}</h1><p>Share your name with this account.</p><button onclick="document.body.dataset.next='yes'">I consent</button></section>`);
    assert.doesNotMatch(await f.act('I consent'), /Cookie acceptance blocked/);
    assert.equal(await f.entry.page.locator('body').getAttribute('data-next'), 'yes', await f.read());
  });
}

for (const [name, visible] of [['Reject all', 'Accept all'], ['Accept all', 'Reject all']]) {
  test(`accept mismatch: name ${name}, visible ${visible} blocks`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, wall(`<button aria-label="${name}" ${bad}>${visible}</button>${reject}`, 'role="dialog"'));
    assert.match(await f.act(name), /Cookie acceptance blocked/);
    assert.equal(await f.entry.page.locator('body').getAttribute('data-accepted'), null);
  });
}

for (const label of ['Refuser', 'Alles ablehnen', '拒絕全部', 'Reject optional cookies', 'Deny', 'Continue without accepting']) {
  test(`localized decline ${label} is reported`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, wall(`<button ${close}>${label}</button>`, 'role="dialog"'));
    assert.match(await f.act(label), /decline confirmed/i);
  });
}

for (const [words, label, decline] of [['Çerez kullanıyoruz', 'Tümünü kabul et', 'Tümünü reddet'], ['Vi använder kakor', 'Godkänn alla', 'Avvisa alla'],
  ['Käytämme evästeitä', 'Hyväksy kaikki', 'Hylkää kaikki'], ['Sütiket használunk', 'Összes elfogadása', 'Összes elutasítása']]) {
  test(`${words}: localized accept blocks and names the decline`, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, `<meta charset="utf-8"><section role="dialog"><p>${words}</p><button ${bad}>${label}</button><button ${close}>${decline}</button></section>`);
    assert.match(await f.act(label), new RegExp(decline));
    assert.equal(await f.entry.page.locator('body').getAttribute('data-accepted'), null);
    assert.match(await f.act(decline), /decline confirmed/i);
  });
}

test('a fading wall is confirmed once its transition finishes', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wall('<button onclick="const wall=this.closest(\'section\');wall.style.opacity=0;setTimeout(()=>wall.remove(),1200)">Reject all</button>', 'role="dialog" style="transition:opacity 1.2s"'));
  assert.match(await f.act('Reject all'), /decline confirmed/i);
});

test('persistent decline only reports unverified and later input passes', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wall('<button>Reject all</button>', 'role="dialog"'));
  assert.match(await f.act('Reject all'), /decline unverified/i);
  assert.doesNotMatch(await f.act('Continue'), /Cookie acceptance blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-next'), 'yes');
});

test('accept without a reject asks, while unrelated page input passes', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wall(accept, 'role="dialog"'));
  assert.match(await f.act('Accept all'), /no reject option.*ask/i);
  assert.doesNotMatch(await f.act('Continue'), /Cookie acceptance blocked/);
});

test('cross-origin Stripe field passes; a CMP frame blocks only its accept target', { skip, timeout: 30000 }, async t => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/stripe' ? '<label>Card number<input aria-label="Card number"></label>' : wall(accept + reject, 'role="dialog"'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const f = await setup(t, `<iframe title="Stripe" src="${origin}/stripe"></iframe><iframe title="CMP" src="${origin}/cmp"></iframe>`);
  await f.entry.page.waitForLoadState('load');
  const stripe = f.entry.page.frames().find(frame => frame.url().endsWith('/stripe'));
  const cmp = f.entry.page.frames().find(frame => frame.url().endsWith('/cmp'));
  const field = stripe.getByLabel('Card number');
  assert.equal(await checkConsent(field, 'fill', f.entry.state), false);
  await field.fill('fixture-card');
  assert.equal(await field.inputValue(), 'fixture-card');
  await assert.rejects(checkConsent(cmp.getByText('Accept all', { exact: true }), 'click', f.entry.state), /Reject all/);
  const decline = cmp.getByText('Reject all', { exact: true });
  await backgroundClick(f.entry, decline, async extra => {
    assert.equal(await checkConsent(decline, 'click', f.entry.state), true);
    return decline.click({ timeout: 1000, ...extra });
  });
  assert.match(await verifyConsent(f.entry.page, f.entry.state), /decline confirmed/i);
});

test('keyboard activation blocks an accept target but ordinary preference fill passes', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wall(`${accept}<label><input type="checkbox">Analytics</label>${reject}`, 'role="dialog"'));
  const before = await f.read();
  const result = await f.call('browser_act', { steps: [{ do: 'press', ref: f.ref(before, 'Accept all'), key: 'Enter' }] });
  assert.match(result, /Cookie acceptance blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-accepted'), null);
  const fill = await f.call('browser_fill', { fields: [{ ref: f.ref(before, 'Analytics'), value: true }] });
  assert.doesNotMatch(fill, /Cookie acceptance blocked/);
  assert.equal(await f.entry.page.locator('input').isChecked(), true);
});

test('a sibling cookie dialog does not supply context to an outside Continue button', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, '<section role="dialog"><p>Cookies</p><button>Accept all</button></section><button onclick="document.body.dataset.next=\'yes\'">Continue</button>');
  const result = await f.act('Continue');
  assert.doesNotMatch(result, /Cookie acceptance blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-next'), 'yes', result);
});

test('browser_fill submit reaches the same accept-target guard', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, wall('<label>Name<input aria-label="Name"></label>' + accept + reject, 'style="position:fixed"'));
  const before = await f.read();
  const result = await f.call('browser_fill', { fields: [{ ref: f.ref(before, 'Name'), value: 'Fixture' }], submit: f.ref(before, 'Accept all') });
  assert.match(result, /Cookie acceptance blocked/);
  assert.equal(await f.entry.page.locator('body').getAttribute('data-accepted'), null);
  assert.equal(await f.entry.page.getByLabel('Name').inputValue(), 'Fixture');
});
