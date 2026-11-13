// Keep these rows unlabelled. Adding "Total" would hide the joined-decimal bug.
export const joinedDecimals = ['Plan 299.00 12 months', 'Cable 12.99 2 m', '12.99 5G', 'Ref #299.00', 'Order #1,304.00', 'Order #12.99 2 m', '#299.00', 'Invoice #1042 1500', 'Total #5 $ / 50', 'Pay #7 $)99999', 'Total #5.0 / 50', 'Pay #0.5 / 99999', 'Invoice 0.5%, 1500', 'Total 0.5% 2,500', 'Invoice #1042, 1500', 'Total #3 1299', 'Pay #1 2,500',
  '12.99 2', '299.00 12m', '299.00 5k', '1,304.00 5G', '12.99 2 items',
  '12.99, 2 m', '12.99\t2 m', '12.99 2 m 5.00'];
export const conflictingCurrencies = ['5 € USD', '€5 USD', '5 USD €', '$5 EUR',
  '0,304USD £ 50', '500EUR ₹500', '100 JPY US$ 5', '1,000GBP €1000', '5.00 EUR $ 1,304.00', '50 US dollars 4444 M', '5 US dollars. 99999 grand A$',
  'Rs. 1 000 euros'];
export const compatibleCurrencies = ['5 USD $', '$5 USD', 'USD $5', '5 € EUR', '€5 EUR', '5 EUR €'];
