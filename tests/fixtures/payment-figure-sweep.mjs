// SA1O review sweep shape, rebuilt with explicit currency-prefix and currency-suffix cases.
const prices = ['$5', '$5.00', '$5,00', 'USD 5', 'USD 5.00', 'USD 5,00', 'EUR 5.00',
  '$0.50', '$0,50', 'USD 0.50', 'USD 0,50', '$0.304', '$0,304', 'EUR 0.50'];
const separators = [' ', '\u202f', "'", '’', '\u00a0', '\u2009', '  ', '\t'];
const trailing = ['1000 USD', '1000 dollars', '250 EUR', '$1000', '€250', '1 000 USD',
  '1\u202f000 USD', "1'000 CHF", '1’000 CHF', '1000 GBP', '1000 CHF', 'USD 1000', 'EUR 1000', 'USD1000', '1000 $'];
export const paymentFigureSweep = prices.flatMap(price => separators.flatMap(separator => trailing.map(total => ({
  text: price + separator + total, amount: /0[.,]/.test(price) ? '0.5' : '5',
}))));

// Glued codes must denominate the next figure too, on every serialized path.
export const gluedCodeSweep = ['$5.00USD', '$5USD', '5USD', '5.00USD', '€5.00USD', 'US$ 5.00USD', 'Rs 5.00USD']
  .flatMap(price => separators.map(separator => ({ text: price + separator + '1000', amount: '5' })));
export const sa1tAsks = [
  ...gluedCodeSweep,
  ...['$1,0000', '$1,00000', '$12,3456', '$1,1'].map(text => ({ text, amount: '5' })),
  ...['mil', 'mm', 'MM', 'm', 'grand', 'G', 'hundred', 'Mrd', 'Md'].map(word => ({ text: '$5 ' + word, amount: '5' })),
  ...['Total 5 Mrd €', '100,000 yen', '100000円', '1000 US dollars'].map(text => ({ text, amount: '5' })),
];

export const metadataRows = ['Qty 12 $5.00', 'Order 1042 $5.00', 'Card 4444 $5.00', 'Pay $5.00 USD 2026'];
export const groupingCases = [',', '.', ' ', '\u202f', "'"].flatMap(separator => {
  const raw = '1' + separator + '200';
  return [
    { raw, total: '$' + raw, allow: separator !== '.' },
    { raw, total: '$' + raw + '.00', allow: separator !== '.' },
    { raw, total: '$1,200.00', allow: separator === ',' },
    { raw, total: '$1,201.00', allow: false },
  ];
}).filter((row, i, rows) => rows.findIndex(other => other.raw === row.raw && other.total === row.total) === i);

// Rebuild the review's 27,900-row dimensions: 25 group shapes, 6 separators,
// 6 currency wrappers and 31 candidate amounts. Differential tooling supplies int26.
export const differentialRows = [];
for (let left = 1; left <= 5; left++) for (let right = 1; right <= 5; right++)
  for (const separator of [',', '.', ' ', '\u202f', "'", '’'])
    for (const wrap of [n => '$' + n, n => 'USD ' + n, n => n + ' USD', n => '€' + n, n => n + ' €', n => 'Total ' + n])
      for (const amount of ['0.5', '1', '1.1', '1.11', '1.111', '1.1111', '1.11111', '2', '5', '10', '11', '12', '20', '50',
        '100', '111', '112', '200', '500', '1000', '1111', '1112', '5000', '10000', '11111', '11112', '100000', '1000000', '10000000', '100000000', '1000000000'])
        differentialRows.push({ text: wrap('1'.repeat(left) + separator + '1'.repeat(right)), amount });

// SA1V removes label and year exceptions, including independently denominated suffixes.
export const sa1vAsks = [
  '$0,304', '$00,304',
  'Order 5000 USD', 'Card 5000 EUR', 'Gift card 5000 USD', '$5.00 Order 12 USD',
  '2026 USD $5.00', '$5.00 USD 2026 EUR', 'Qty 12 $5.00', 'Order 1042 $5.00',
  'Card 4444 $5.00', 'Pay $5.00 USD 2026', 'Total 2026 $', '$5.00 Total 2026 $',
  'Total 2026 $5.00', 'Order total 2026 $5.00',
  '$5.00 Total 1 000%', '$5.00 Total 1 000 items',
  ...['millions', 'millones', 'Milliarden', 'b', 'bil', 'tn', 'trillion', 'lacs', '万', '億', 'tys', 'mln', 'tausend', 'e3']
    .flatMap(word => ['$5 ' + word, '5 USD ' + word, '5' + word + ' USD']),
  ...['m', 'mm', 'g', 'G'].flatMap(word => ['$5 ' + word, '5 USD ' + word]),
];
export const sa1vUnits = ['Cable 2 m', 'Network 5G', 'Item 100 g', 'Cable 2 m $5.00', 'Network 5G $5.00', 'Item 100 g $5.00'];
