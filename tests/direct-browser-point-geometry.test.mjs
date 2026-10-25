import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedPointWords } from '../plugins/sleight/lib/direct-browser/points.mjs';

// Names must guard independently of role, listeners or pointer-event eligibility.
for (const text of ['Pay', 'Buy now', 'Place order', 'Place\norder', 'Place\u00a0order', 'Subscribe', 'Checkout', 'Confirm purchase', 'Complete purchase', 'Confirm payment', 'Add payment', 'Donate',
  'Payer', 'Acheter', 'Pagar', 'Comprar', 'Bezahlen', 'Kaufen', 'Acquista', 'Betalen', 'Оплатить', '支付', '購入', '결제', 'شراء', 'Ｐａｙ', 'P\u200bay', 'B\u200duy', 'Check\u2060out', 'Pa\u00ady', 'P\u202eay'])
  test('point names guard ' + text, () => assert.equal(guardedPointWords(text), true));
for (const text of ['Plain', 'Canvas', 'Close X', 'Next page', 'Payton', 'buyer', 'paymentHistory', 'Savepoint', 'Yesterday', 'Save', 'Complete', 'Book', 'Send', 'Accept', 'Charge', 'Save the Children', 'Submit', 'Confirm', 'Agree', 'Allow all', 'Finish', 'Accept all cookies', '同意', '同意する', '동의'])
  test('point names keep plain target ' + text, () => assert.equal(guardedPointWords(text), false));
