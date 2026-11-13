import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as head from '../plugins/sleight/lib/payment-figures.mjs';
import * as gate from '../plugins/sleight/lib/payment-gate.mjs';
import { int26, exactAmountMatch, statedYen } from './fixtures/payment-int26.mjs';

const numberShapes = ['5','5.00','5,00','1000','1,000','1.000','1 000','1,000.00','1.304','1,304.00','12','2026','0.5','0,304','99999','1 000',"1'000",'100','1e3','50','500','4444','1042',
  '1.500,00', '1 500.00', '1 500,00', '1’500'];
const codes = ['USD','EUR','GBP','JPY','CAD','usd','Usd'];
const signs = ['$','€','£','¥','US$','Rs','₹','CA$','A$'];
const words = ['dollars','euros','yen','円','US dollars','bucks','pounds'];

// Byte-for-byte git show 1aa8c4598039b2d72087ac7c0879dc72da5b2fcf copies.
test('SA1X int26 comparison sources stay frozen', () => {
  for (const [file, hash] of [
    ['payment-figures.mjs', '786a73a3b8129e7efb46e8bb263b666e8ab50df299b3494d2314086601cdac52'],
    ['payment-gate.txt', 'bdef5da25b255c7103cface247c6a64ee1a592c9944fbc904502f32bdf5e1710'],
  ]) assert.equal(createHash('sha256').update(readFileSync(new URL('fixtures/payment-int26/' + file, import.meta.url))).digest('hex'), hash);
});

// SA1V's honest exceptions: an exact user amount, or a page figure that itself states yen.
// The predicates also bound the old figures, so dropping a large price or a foreign sign cannot pass as an exception.
test('SA1X seeded compose-and-compare, 300000 rows against int26', t => {
  // A seeded sample of page shapes compared against frozen int26, not a proof: new shapes get added here when a review finds them.
  const started = performance.now();
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick=a=>a[Math.floor(rnd()*a.length)];
  const nums = numberShapes;
  const mags=['m','mm','g','G','k','K','b','B','bn','mil','Mio','Mrd','million','millions','万','億','lakh','crore','thousand','grand','hundred','tn','e3','tys','mln','M','bil'];
  const labels=['Total','Qty','Order','Card','Year','Item','Pay','Amount due','Ref','No.','Fee','Tax','Gift card','Order #','Cable','Network','Subtotal','Shipping','Price'];
  const joins=[' ','  ',', ',' + ',' / ',': ',' - ',' | ','\t',' and ','; ','. ',' ','',' x ',' → '];
  const tok=()=>{
    // Every generated shape may have a marker glued to its digits, inside either currency placement.
    const n=pick(['', '', '#', '№'])+pick(nums), t=rnd();
    if(t<0.15) return pick(signs)+(rnd()<.5?' ':'')+n;
    if(t<0.28) return n+(rnd()<.5?' ':'')+pick(codes);
    if(t<0.40) return pick(codes)+(rnd()<.5?' ':'')+n;
    if(t<0.48) return n+(rnd()<.5?' ':'')+pick(signs);
    if(t<0.55) return rnd()<.5 ? n+' '+pick(words) : pick(words)+' '+n;
    if(t<0.70) return n+(rnd()<.5?' ':'')+pick(mags);
    if(t<0.78) return pick(signs)+n+(rnd()<.5?' ':'')+pick(mags);
    if(t<0.84) return pick(labels)+' '+n;
    if(t<0.88) return pick(labels)+' '+n+' '+pick(codes);
    if(t<0.92) return n+' '+pick(mags)+' '+pick(codes);
    if(t<0.96) return n+' '+pick(mags)+' '+pick(signs);
    // Glued prefixes (sa1x review): #299.00 is a charge, #1042 an order number.
    if(t<0.985) return (rnd()<.5?pick(labels)+' ':'')+pick(['#','#','№','(','*','~'])+n;
    return pick(labels);
  };
  const rows = 300000, exceptions = { exactAmount: 0, statedYen: 0 }, failures = [];
  let engineRows = 0, engineFailures = [], asksHead = 0, asksInt26 = 0;
  for (let k = 0; k < rows; k++) {
    const count = rnd() < .7 ? 1 : 2, lines = [];
    for (let l = 0; l < count; l++) {
      const tokens = 1 + Math.floor(rnd() * 3);
      let line = '';
      for (let q = 0; q < tokens; q++) line += (q ? pick(joins) : '') + tok();
      lines.push(line);
    }
    const a = pick(['5', '5.00', '1000', '1,000', '1.000', '1,000.00', '1.304', '1304', '12', '2026', '100']);
    const c = pick([undefined, undefined, 'USD', 'EUR', 'JPY']);
    const h = head.moneyConflicts(lines, a, c), i = int26.moneyConflicts(lines, a, c);
    asksHead += h; asksInt26 += i;
    if (!h && i) {
      if (exactAmountMatch(lines, a, c)) exceptions.exactAmount++;
      else if (statedYen(lines, a, c)) exceptions.statedYen++;
      else if (failures.length < 20) failures.push({ k, lines, amount: a, currency: c });
    }
    // Every thousandth composed page also crosses the full engine gate, on all settings.
    // The figure comparison above still checks every one of the 300000 generated rows.
    if (k % 1000 === 0) for (const setting of ['requested', 'never', 'always']) {
      engineRows++;
      const text = 'Pay ' + (c ?? 'USD') + ' ' + a + ' with the card';
      const tree = ['1 standard window Checkout', '\t2 HTML content Shop, URL: https://shop.invalid/checkout',
        '\t\t3 text field Card number', ...lines.map((line, j) => '\t\t' + (j + 4) + ' text ' + line),
        '\t\t99 button Pay now'].join('\n');
      const result = mod => mod.enginePayment('click', [99], tree, { setting, message: mod.namedAmount(text) });
      if (result(gate)?.allowed && !result(int26)?.allowed && !exactAmountMatch(lines, a, c ?? 'USD', setting === 'never') && !statedYen(lines, a, c ?? 'USD')) {
        if (engineFailures.length < 20) engineFailures.push({ k, setting, lines, text });
      }
    }
  }
  t.diagnostic(JSON.stringify({ seed: 1, rows, asksHead, asksInt26, exceptions, failures: failures.length,
    engineRows, engineFailures: engineFailures.length, durationMs: Math.round(performance.now() - started) }));
  assert.deepEqual(failures, [], 'head allows a composed page that int26 asks about');
  assert.deepEqual(engineFailures, [], 'head engine allows where int26 asks');
});

test('SA1Z every number shape with a glued marker and currency on either side compares against int26', t => {
  let rows = 0, asksHead = 0, asksInt26 = 0;
  const failures = [], exceptions = { exactAmount: 0, statedYen: 0 };
  for (const n of numberShapes) for (const prefix of ['#', '№'])
    for (const currency of [...codes, ...signs, ...words]) for (const space of ['', ' '])
      for (const side of ['before', 'after']) {
        const text = side === 'before' ? currency + space + prefix + n : prefix + n + space + currency;
        const lines = ['Total $5.00', text];
        rows++;
        const h = head.moneyConflicts(lines, '5', 'USD'), old = int26.moneyConflicts(lines, '5', 'USD');
        asksHead += h; asksInt26 += old;
        // Removing the marker cannot reveal a larger denominated figure than the prefixed page read.
        const plain = head.moneyFigures([text.replace(prefix, '')]).figures;
        const marked = head.moneyFigures([text]).figures;
        assert.ok(plain.every(f => marked.some(m => m.value >= f.value)), text + ' lost a figure');
        if (!h && old) {
          if (exactAmountMatch(lines, '5', 'USD')) exceptions.exactAmount++;
          else if (statedYen(lines, '5', 'USD')) exceptions.statedYen++;
          else failures.push({ text });
        }
      }
  t.diagnostic(JSON.stringify({ rows, asksHead, asksInt26, exceptions, failures: failures.length }));
  assert.equal(rows, numberShapes.length * 2 * (codes.length + signs.length + words.length) * 4);
  assert.deepEqual(failures, []);
});

test('SA1X exact-amount and stated-yen exceptions reject hidden prices and foreign figures', () => {
  assert.equal(exactAmountMatch(["$1'200.00"], '1200', 'USD'), true);
  assert.equal(exactAmountMatch(['Total $5.00', 'Plan 299.00 12 months'], '5', 'USD'), false);
  assert.equal(exactAmountMatch(['Total $5.00', '5 € USD'], '5', 'USD'), false);
  assert.equal(exactAmountMatch(['$1,304.00'], '1.304', 'USD'), false);
  assert.equal(exactAmountMatch(['1.000 GBP'], '1000', 'EUR', true), true);
  assert.equal(exactAmountMatch(['$1,304.00'], '1304円', 'JPY', true), false);
  assert.equal(statedYen(['1,11円'], '2', undefined), true);
  assert.equal(statedYen(['1,11円'], '2', 'USD'), false);
  assert.equal(statedYen(['$1.11'], '2', undefined), false);
  assert.equal(statedYen(['3円'], '2', undefined), false);
});

test('SA1X full engine comparison, 1716 setting-total-message rows against int26', t => {
  const sol = readFileSync(new URL('fixtures/payment-gate/firefox-checkout-sol.txt', import.meta.url), 'utf8');
  const beforePay = sol.split('\n').filter(line => !/^\t*(?:89|9[0-7]) /.test(line)).join('\n');
  const totals = ['$1,304.00','$1,304','$1.304,00','$1 304.00','$1 304.00',"$1'304.00",'1.304,00 €','$5.00','$5','$0,304','€1,304.00','$1,200.00','$12,000.00','$1.304.00','$13,04.00','$1304.00','1 304,00 €','¥1,304','1,304 円','$5.00 Order 12 USD','$5.00 2 m','$5.00 + 1000 m USD'];
  const users = ['$1.304','$1,304','1.304','1,304','1304','$1304','1.304 €','$1.200','$1,200','$5','5','$5.00','$0.304','$0,304','1 304','1 304','$1.304,00','USD 1.304','1,304 USD','5 USD','$5 m','¥1304','1304円','$1.30','$12.345','$1,0000'];

  let rows = 0, exactMatches = 0, yen = 0, failures = [];
  for (const setting of ['requested', 'never', 'always']) for (const total of totals) for (const user of users) {
    rows++;
    const tree = beforePay.replace(/\$[\d,.]+/g, total), text = 'Pay ' + user + ' with the card';
    const result = mod => mod.enginePayment('click', [88], tree, { setting, message: mod.namedAmount(text) });
    if (result(gate)?.allowed && !result(int26)?.allowed) {
      const currency = gate.namedAmount(text).currency;
      if (exactAmountMatch([total], user, currency, setting === 'never')) exactMatches++;
      else if (statedYen([total], user, currency)) yen++;
      else failures.push({ setting, total, user });
    }
  }
  t.diagnostic(JSON.stringify({ rows, exactMatches, yen, failures: failures.length }));
  assert.equal(rows, 1716);
  assert.deepEqual(failures, []);
});
