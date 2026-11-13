import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyFigures, moneyConflicts } from '../plugins/sleight/lib/payment-figures.mjs';

// Two adjacent figures must survive as separate figures or make the reading unreadable.
const adjacentPrices = ['$5.00', '$5,00', '$1.20', '$1,20', 'USD 5.00', 'USD 5,00',
  'USD 1.20', 'USD 1,20', 'EUR 5.00', 'EUR 5,00', 'EUR 1.20', 'EUR 1,20'];
const adjacentTotals = [['1000 USD', 1000], ['1000 dollars', 1000], ['250 EUR', 250], ['$1000', 1000],
  ['€250', 250], ['1000 GBP', 1000], ['1000 CHF', 1000], ['1000 CAD', 1000], ['1 000 USD', 1000],
  ['1\u202f000 USD', 1000], ["1'000 CHF", 1000], ['1’000 CHF', 1000], ['250 pounds', 250]];
for (const price of adjacentPrices) for (const [total, larger] of adjacentTotals)
  test(`SA1O 156-row adjacent-figure sweep: ${price} ${total}`, () => {
    const lines = ['Total ' + price + ' ' + total];
    const { figures } = moneyFigures(lines);
    assert.ok(figures.some(f => f.value >= larger) || moneyConflicts(lines, '5'), 'keep the larger part or ask');
    assert.equal(moneyConflicts(lines, '5'), true);
  });

for (const text of ['$5.00 1000 USD', '$5.00 1000 dollars', '$5,00 1000 USD',
  'USD 5.00 250 EUR', 'Total $5.00 1 000 USD'])
  test(`SA1O review regression asks: ${text}`, () => {
    assert.equal(moneyConflicts([text], '5', 'USD'), true);
  });

for (const separator of [' ', '\u202f', "'", '’']) {
  test(`SA1O zero-leading mixed groups cannot hide a later figure: ${JSON.stringify(separator)}`, () => {
    const text = '$0.304' + separator + '567 USD';
    assert.ok(moneyFigures([text]).figures.some(f => f.value >= 567));
    assert.equal(moneyConflicts([text], '5', 'USD'), true);
  });
  for (const raw of [`5.00${separator}1000`, `5,00${separator}250`, `1234${separator}567`,
    `5${separator}20`, `1${separator}23`, `1${separator}234.00.50`])
    test(`SA1O malformed grouping is unreadable: ${raw}`, () => {
      const { parse } = moneyFigures([]);
      assert.equal(parse(raw), Infinity);
      assert.equal(parse(raw, false), Infinity);
    });
  for (const [raw, value, userValue = value] of [[`1${separator}234`, 1234, 1.234], [`12${separator}345${separator}678`, 12345678],
    [`123${separator}456.78`, 123456.78], [`1${separator}234,50`, 1234.5]])
    test(`SA1O clean grouping stays readable: ${raw}`, () => {
      const { parse } = moneyFigures([]);
      assert.equal(parse(raw), value);
      assert.equal(parse(raw, false), userValue);
    });
}

// Replacing the page maximum with the decimal reading, or splitting a grouped run, must fail these cases.
for (const [text, value, currency] of [
  ['1.304 €', 1304, 'EUR'], ['12.345 €', 12345, 'EUR'], ['1.304.567 €', 1304567, 'EUR'],
  ['1,304 €', 1304, 'EUR'], ['1.304,00 €', 1304, 'EUR'], ['$1,304.00', 1304, '$'],
  ['1 304,00 €', 1304, 'EUR'], ['1\u202f304,00 €', 1304, 'EUR'], ["1'304.00 CHF", 1304, 'CHF'],
  ['1’304.00 CHF', 1304, 'CHF'], ['€1 304', 1304, 'EUR'], ['€1\u202f304', 1304, 'EUR'],
  ["CHF 1'304", 1304, 'CHF'], ['CHF 1’304', 1304, 'CHF'], ['USD 1.304', 1304, 'USD'],
  ['Total 1 304', 1304, undefined], ['Total 1\u202f304', 1304, undefined],
  ['1.304 567 €', 1304567, 'EUR'], ['1.304\u202f567 €', 1304567, 'EUR'],
  ["1.304'567 CHF", 1304567, 'CHF'], ['1,304 567 €', 1304567, 'EUR'],
]) test(`SA1B page keeps the whole grouped figure: ${text}`, () => {
  const { figures } = moneyFigures([text]);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].value, value);
  assert.equal(figures[0].cur, currency);
  assert.equal(moneyConflicts([text, 'Item 5,00 €'], '5'), true);
});

// A fix that treats every third decimal as grouping must fail for zero-leading decimals.
for (const [text, value] of [['1.30 €', 1.3], ['0.304 €', 0.304], ['0.3040 €', 0.304]])
  test(`SA1B decimal control stays below five: ${text}`, () => {
    assert.equal(moneyFigures([text]).figures[0].value, value);
    assert.equal(moneyConflicts([text, 'Item 5,00 €'], '5', 'EUR'), false);
  });

test('SA1V leading-zero comma keeps the int26 page reading', () => {
  assert.equal(moneyFigures(['0,304 €']).figures[0].value, 304);
  assert.equal(moneyConflicts(['0,304 €', 'Item 5,00 €'], '5', 'EUR'), true);
  assert.equal(moneyConflicts(['$0,003'], '0.5', 'USD'), true);
});

for (const magnitude of ['million', 'mio', 'mn', 'bn', 'billion', 'thousand', 'k', 'lakh', 'crore'])
  test(`SA1B unlabelled decimals still count with a magnitude: ${magnitude}`, () => {
    const lines = ['Gesamt 1.20 ' + magnitude, 'Item $5.00'];
    assert.equal(moneyFigures(lines).figures[0].value, Infinity);
    assert.equal(moneyConflicts(lines, '5', 'USD'), true);
  });

// Omitting any magnitude spelling, or checking only glued letters, must fail a case below.
for (const magnitude of ['million', 'mio', 'mn', 'bn', 'billion', 'thousand', 'k', 'lakh', 'crore'])
  for (const [text, currency] of [
    [`$1.2 ${magnitude}`, '$'], [`€1,2 ${magnitude.toUpperCase()}.`, 'EUR'],
    [`₹5${magnitude}`, 'INR'], [`5.${magnitude} €`, 'EUR'], [`5 ${magnitude} €`, 'EUR'],
    [`Total 5 ${magnitude}`, undefined],
  ]) test(`SA1B magnitude is unreadable: ${text}`, () => {
    const { figures } = moneyFigures([text]);
    assert.equal(figures.length, 1);
    assert.equal(figures[0].value, Infinity);
    assert.equal(figures[0].cur, currency);
    assert.equal(moneyConflicts([text, 'Item $5.00'], '5', currency), true);
  });

for (const amount of ['1.304', '1,304']) test(`SA1B bare user ambiguity uses the smaller reading: ${amount}`, () => {
  assert.equal(moneyConflicts(['Total 1.304,00 €'], amount, 'EUR'), true);
  assert.equal(moneyConflicts(['Total 1.304 €'], amount, 'EUR'), true);
  assert.equal(moneyConflicts(['Total 1,30 €'], amount, 'EUR'), false);
});

test('SA1P an explicitly denominated ambiguous amount keeps the smaller reading', () => {
  assert.equal(moneyConflicts(['Total 1.304,00 €'], '1.304 €', 'EUR'), true);
  assert.equal(moneyConflicts(['Total 1,304.00 EUR'], '1,304 €', 'EUR'), false);
  assert.equal(moneyConflicts(['Total 1,30 €'], '1.304 €', 'EUR'), false);
  assert.equal(moneyConflicts(['Total 500,00 €'], '1.304 €', 'EUR'), true);
  assert.equal(moneyConflicts(['Total 1.305,00 €'], '1.304 €', 'EUR'), true);
  assert.equal(moneyConflicts(['Total 1.304,00 USD'], '1.304 €', 'EUR'), true);
});

// Keep currency and chosen-add-on enforcement when the main figure is grouped.
test('SA1B grouping preserves currency conflicts and chosen sums', () => {
  assert.equal(moneyConflicts(['Total USD 1.304', 'Fee 1 EUR'], '1304', 'USD'), true);
  assert.equal(moneyConflicts(['Total 1.304 €', '\uE000Add-on 700 €\uE001', '\uE000Add-on 700 €\uE001'], '1304', 'EUR'), true);
  assert.equal(moneyConflicts(['Total 1.304 €', '\uE000Discount -700 €\uE001', '\uE000Add-on 700 €\uE001'], '1304', 'EUR'), false);
});

// Currency text between two numbers belongs to both neighboring figures.
for (const [text, currency] of [['$5 USD 1000', 'USD'], ['$5.00 EUR 1000', 'EUR'],
  ['USD 1000', 'USD'], ['1000 USD', 'USD'], ['$ 1000', '$'], ['1000 $', '$'],
  ['5 USD 1000', 'USD'], ["5 USD'1000", 'USD'], ['5 USD’1000', 'USD']])
  test(`SA1P currency adjacency keeps the bare figure: ${text}`, () => {
    assert.ok(moneyFigures([text]).figures.some(f => f.value >= 1000 && f.cur === currency));
    assert.equal(moneyConflicts([text], '5'), true);
  });

for (const separator of ['.', ',', ' ', '\u202f', '\u00a0'])
  test(`SA1P user ambiguity cannot borrow a larger page reading: ${JSON.stringify(separator)}`, () => {
    const amount = '1' + separator + '304';
    for (const user of [amount, '$' + amount, amount + ' USD']) {
      assert.equal(moneyConflicts(['Amount ' + amount, 'Total $1,304.00'], user, 'USD'), separator !== ',');
    }
  });

const { paymentFigureSweep } = await import('./fixtures/payment-figure-sweep.mjs');
for (const { text, amount } of paymentFigureSweep)
  test(`SA1P 1680-row parser sweep: ${JSON.stringify(text)}`, () => {
    assert.equal(moneyConflicts([text], amount), true);
  });

const { sa1tAsks, metadataRows, groupingCases } = await import('./fixtures/payment-figure-sweep.mjs');
for (const { text, amount } of sa1tAsks) test(`SA1T parser asks: ${JSON.stringify(text)}`, () => {
  assert.equal(moneyConflicts([text], amount), true);
  assert.ok(moneyFigures([text]).figures.some(f => f.value > Number(amount)));
});
for (const row of metadataRows) test(`SA1V metadata counts beside prices: ${row}`, () => {
  assert.equal(moneyConflicts([row], '5', 'USD'), true);
  assert.equal(moneyConflicts([row, 'Fee $6.00'], '5', 'USD'), true);
  assert.equal(moneyConflicts([row.replace('5.00', '6.00')], '5', 'USD'), true);
});
for (const label of ['Qty', 'Order', 'Card']) test(`SA1T ${label} cannot erase a denominated figure`, () => {
  assert.equal(moneyConflicts([label + ' $1000.00', 'Total $5.00'], '5', 'USD'), true);
  assert.equal(moneyConflicts([label + ' USD 1000', 'Total $5.00'], '5', 'USD'), true);
});
for (const { raw, total, allow } of groupingCases) test(`SA1T grouping ${raw} against ${total}`, () => {
  assert.equal(moneyConflicts(['Total ' + total], '$' + raw, 'USD'), !allow);
  assert.equal(moneyConflicts(['Total ' + total, 'Fee $2000.00'], '$' + raw, 'USD'), true);
});

const { sa1vAsks, sa1vUnits } = await import('./fixtures/payment-figure-sweep.mjs');
for (const text of sa1vAsks) test(`SA1V parser asks: ${text}`, () => {
  assert.equal(moneyConflicts([text, 'Total $5.00'], '5', 'USD'), true);
});
for (const text of sa1vUnits) test(`SA1V bare units allow: ${text}`, () => {
  assert.equal(moneyConflicts([text, 'Total $5.00'], '5', 'USD'), false);
});

const { joinedDecimals, conflictingCurrencies, compatibleCurrencies } = await import('./fixtures/payment-sa1x.mjs');
for (const text of [...joinedDecimals, ...conflictingCurrencies]) test(`SA1X parser asks: ${text}`, () => {
  assert.equal(moneyConflicts([text], '5', 'USD'), true);
  // Ambiguous figures stay unreadable; a #-prefixed two-decimal charge is read at its full value (sa1x review).
  assert.ok(moneyFigures([text]).figures.some(f => !Number.isFinite(f.value) || f.value > 5), 'the larger figure is unreadable or read in full');
});
for (const text of compatibleCurrencies) test(`SA1X compatible own currency: ${text}`, () => {
  const currency = text.includes('€') ? 'EUR' : 'USD';
  assert.equal(moneyConflicts([text], '5', currency), false);
  assert.equal(moneyFigures([text]).figures[0].value, 5);
});
test('SA1X bare network and card identifiers stay outside money figures', () => {
  assert.equal(moneyConflicts(['127.0.0.1', '5555 5555 5555 4444', 'Total $5.00'], '5', 'USD'), false);
});

test('SA1X own sign or code wins over an adjacent currency token', () => {
  assert.equal(moneyFigures(['5 € USD']).figures[0].cur, 'EUR');
  assert.equal(moneyFigures(['5 USD €']).figures[0].cur, 'USD');
  assert.equal(moneyConflicts(['5 € USD'], '1000', 'USD'), true);
});

const { hashCases, currencyHashCases } = await import('./fixtures/payment-sa1z.mjs');
for (const [text, allow] of [...hashCases, ...currencyHashCases]) test(`SA1Z parser ${allow ? 'allows' : 'asks'}: ${text}`, () => {
  assert.equal(moneyConflicts(['Total $5.00', text], '5', 'USD'), !allow);
  if (!allow) assert.ok(moneyFigures([text]).figures.some(f => f.value > 5), 'retain the larger figure or mark it unreadable');
});
test('SA1Z masking keeps figure positions and the following denomination', () => {
  const line = 'Order #1042 Total $5.00', figure = moneyFigures([line]).figures[0];
  assert.equal(figure.at, '0:' + line.indexOf('$'));
  assert.equal(figure.value, 5);
  assert.equal(figure.cur, '$');
});
