// The architect's 23 probe pages, followed by the B1/security-review rows and reference controls.
export const hashProbe = [
  ['#1.500,00', false], ['#1 500.00', false], ['#1500 Rs', false], ['#1500 USD', false],
  ['#1500 $', false], ['#1500$', false], ['#1500 €', false], ['#1500 dollars', false], ['USD #1500', false],
  ['#1,500.00', false], ['#299.00', false], ['Order #1042', true], ['Invoice #1042 1500', false],
  ['#1500', true], ['#1 500', false], ['№1.500,00', false], ['#1500 EUR', false], ['#1500 yen', false],
  ['#1500円', false], ['#1 500,00 €', false], ['#12.99USD', false], ['№1,304.00 €', false], ['#1500 Rs.', false],
];
export const hashCases = [...hashProbe,
  ['Ref #299.00', false], ['Order #1,304.00', false], ['Order #12.99 2 m', false], ['Order #13.42 pcs', false],
  ['Invoice #1042, 1500', false], ['Total #3 1299', false], ['Pay #1 2,500', false],
  ['Total #5', true], ['Item #7', true], ['Ref №1042', true], ['Total №5', true], ['Item №7', true],
  ['№1042 1500', false], ['№1 500', false], ['#1’500', false], ["#1'500", false],
  ['#1 million', false], ['#1e3', false], ['USD #1500 USD', false], ['Rs. #1500', false],
  ['dollars #1500', false], ['円 #1500', false], ['Total $5.00 Order #1042', true],
  ['#50 euros1 000 US$', false], ['Pay #100 usdUSD1000Pay', false], ['Total #4444 JPYCAD #4444', false],
  ['Pay #12 | 1,000mln', false], ['Qty №5,00 Usd1e3', false], ['#5.00US dollars', false],
  ['#5,00US dollars', false], ['Total 1 000 ¥№1000. Item 99999', false],
];

// Every token the parser accepts next to a figure, before and after either marker.
const codes = 'USD EUR GBP CAD AUD NZD JPY CNY INR CHF SEK NOK DKK MXN BRL HKD SGD KRW RUB PLN CZK TRY ZAR AED SAR THB ILS PHP IDR VND NGN TWD'.split(' ');
const signs = ['$', 'US$', 'CA$', 'AU$', 'NZ$', 'HK$', 'SG$', 'MX$', 'NT$', 'A$', 'C$', 'S$', 'R$',
  ...'€£¥₹₩₽₺₪฿₫₱₦', 'Rs', 'Rs.'];
const words = ['US dollar', 'US dollars', 'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'bucks', 'yen', '円'];
export const currencyHashCases = [];
for (const prefix of ['#', '№']) for (const currency of [...codes, ...signs, ...words])
  for (const space of ['', ' ']) for (const side of ['before', 'after']) {
    const text = side === 'before' ? currency + space + prefix + '1500' : prefix + '1500' + space + currency;
    currencyHashCases.push([text, false]);
  }
