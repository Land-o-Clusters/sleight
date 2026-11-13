import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { moneyFigures, moneyConflicts } from '../plugins/sleight/lib/payment-figures.mjs';
import { enginePayment, namedAmount, paymentAction, createPaymentMessages } from '../plugins/sleight/lib/payment-gate.mjs';
import { paymentWords, refundableName } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { rules, fixture, terms } from './direct-browser-rules-fixture.mjs';

const rows = [
  { quote: '$1 304', raw: '1 304', total: '$1.30', page: '1.30', currency: 'USD', ambiguous: true, requested: 'mismatch', browser: 'confirm' },
  { quote: '$1 304', raw: '1 304', total: '$1,304.00', page: '1,304.00', currency: 'USD', ambiguous: true, requested: 'over', browser: 'confirm' },
  { quote: '$1 304', raw: '1 304', total: '$1304', page: '1304', currency: 'USD', ambiguous: true, requested: 'over', browser: 'confirm' },
  { quote: '$1 304', raw: '1 304', total: '$1 304.00', page: '1 304.00', currency: 'USD', ambiguous: true, requested: 'message', browser: 'allow' },
  { quote: '$1,304', raw: '1,304', total: '$1,304.00', page: '1,304.00', currency: 'USD', ambiguous: false, requested: 'message', browser: 'allow' },
  { quote: '$13.04', raw: '13.04', total: '$13.04', page: '13.04', currency: 'USD', ambiguous: false, requested: 'message', browser: 'allow' },
  { quote: '$13.04', raw: '13.04', total: '$13.045', page: '13.045', currency: 'USD', ambiguous: false, requested: 'over', browser: 'confirm' },
  { quote: "1'304 CHF", raw: "1'304", total: "1'304.00 CHF", page: "1'304.00", currency: 'CHF', ambiguous: true, requested: 'message', browser: 'allow' },
  { quote: '1 304 €', raw: '1 304', total: '1 304.00 €', page: '1 304.00', currency: 'EUR', ambiguous: true, requested: 'message', browser: 'allow' },
  { quote: '$1\u202f304', raw: '1\u202f304', total: '$1\u202f304.00', page: '1\u202f304.00', currency: 'USD', ambiguous: true, requested: 'message', browser: 'allow' },
  { quote: '1’304 CHF', raw: '1’304', total: '1’304.00 CHF', page: '1’304.00', currency: 'CHF', ambiguous: true, requested: 'message', browser: 'allow' },
];
const tree = (total, extra = []) => ['1 standard window Checkout', '\t2 HTML content Checkout, URL: https://shop.invalid/checkout',
  '\t\t3 text field Card number', '\t\t4 text Total ' + total, ...extra.map((text, i) => '\t\t' + (10 + i) + ' text ' + text),
  '\t\t6 button Place order'].join('\n');
const payment = (setting, quote) => ({ setting, message: namedAmount('Pay ' + quote + ' with the card') });
const serialized = runInNewContext([moneyFigures, moneyConflicts, paymentAction, paymentWords, refundableName, enginePayment]
  .map(fn => 'const ' + fn.name + ' = (' + fn.toString() + ');').join('\n') + '\nenginePayment');
const decision = result => result?.allowed ?? result?.why;

for (const row of rows) {
  const label = row.quote + ' against ' + row.total;
  test('PQ1 quote readings: ' + label, () => {
    assert.equal(moneyConflicts(['Total ' + row.total], row.quote, row.currency, true), row.ambiguous);
  });
  for (const [name, engine] of [['node', enginePayment], ['serialized', serialized]]) {
    test('PQ1 ' + name + ' never: ' + label, () => {
      const result = engine('click', [6], tree(row.total), payment('never', row.quote));
      assert.equal(decision(result), row.ambiguous ? 'none' : 'never');
    });
    test('PQ1 ' + name + ' default unchanged: ' + label, () => {
      assert.equal(decision(engine('click', [6], tree(row.total), payment('requested', row.quote))), row.requested);
    });
    test('PQ1 ' + name + ' always unchanged: ' + label, () => {
      assert.equal(decision(engine('click', [6], tree(row.total), payment('always', row.quote))), 'always');
    });
  }
  for (const setting of ['requested', 'never', 'always']) test('PQ1 turbo ' + setting + ': ' + label, () => {
    const f = fixture({ ...terms, amount: row.raw, currency: row.currency });
    f.ctx.confirmPayments = setting;
    const target = f.pay({ terms: { page: { ...terms, amount: row.page, currency: row.currency }, method: terms.method } });
    const expected = setting === 'always' || setting === 'never' && row.ambiguous ? 'confirm' : row.browser;
    assert.equal(rules.check(f.ctx, 'click', target).verdict, expected);
  });
}

for (const [name, engine] of [['node', enginePayment], ['serialized', serialized]]) {
  test('PQ1 ' + name + ' residual near match asks before cent tolerance', () => {
    const result = engine('click', [6], tree('1.30 US dollars', ['Total $2000.00']), payment('never', '$1 304'));
    assert.equal(result?.why, 'none');
    assert.equal(result?.allowed, undefined);
  });
  test('PQ1 ' + name + ' unambiguous cents retain rounding tolerance', () => {
    assert.equal(engine('click', [6], tree('$13.0449'), payment('never', '$13.04'))?.allowed, 'never');
    assert.equal(engine('click', [6], tree('$13.0450'), payment('never', '$13.04'))?.allowed, 'never');
    assert.equal(engine('click', [6], tree('$13.0451'), payment('never', '$13.04'))?.why, 'mismatch');
    for (const total of ['$13.045 million', '$13.046', '$13.045,00', '$1,304.00'])
      assert.equal(engine('click', [6], tree(total), payment('never', '$13.04'))?.why, 'mismatch');
  });
  test('PQ1 ' + name + ' one card answer permits the ambiguous action once', () => {
    const messages = createPaymentMessages();
    messages.set('Pay $1 304 with the card');
    const first = engine('click', [6], tree('$1 304.00'), messages.guard('never'));
    assert.equal(first?.why, 'none');
    messages.allowed(first);
    const second = engine('click', [6], tree('$1 304.00'), messages.guard('never'));
    assert.equal(second?.allowed, 'card');
    messages.paid(second);
    assert.equal(engine('click', [6], tree('$1 304.00'), messages.guard('never'))?.why, 'second');
  });
}

test('PQ1 turbo one card answer permits an ambiguous payment once, including unchecked terms', () => {
  for (const unchecked of [false, true]) {
    const f = fixture({ ...terms, amount: '1 304' });
    f.ctx.confirmPayments = 'never';
    let ticket = false, consumes = 0;
    f.ctx.consent = { consume() { consumes++; const allowed = ticket; ticket = false; return allowed; } };
    const page = { ...terms, amount: '1 304.00' };
    const target = f.pay({ terms: { page: unchecked ? { ...page, amount: undefined } : page,
      ...(unchecked ? { unchecked: page } : {}), method: terms.method } });
    assert.equal(rules.check(f.ctx, 'click', target).verdict, 'confirm');
    ticket = true;
    assert.equal(rules.check(f.ctx, 'click', target).verdict, 'allow');
    assert.equal(rules.check(f.ctx, 'click', target).verdict, 'confirm');
    assert.equal(consumes, 3);
  }
});

test('PQ1 quote-only check retains never opt-out for larger page figures', () => {
  const lines = ['Total $13.04', 'Fee $2000.00'];
  assert.equal(moneyConflicts(lines, '$13.04', 'USD'), true);
  assert.equal(moneyConflicts(lines, '$13.04', 'USD', true), false);
  assert.equal(enginePayment('click', [6], tree('$13.04', ['Fee $2000.00']), payment('never', '$13.04'))?.allowed, 'never');
});

// The page ceiling retains its grouped reading. Never mode may match a fraction after proving the user's quote has one reading.
test('PQ1 three-decimal rounding changes only never amount matching', () => {
  assert.equal(moneyFigures(['$13.045']).figures[0].value, 13045);
  assert.equal(moneyConflicts(['$13.045'], '$13.04', 'USD'), true);
  assert.equal(enginePayment('click', [6], tree('$13.045'), payment('never', '$13.04'))?.allowed, 'never');
  assert.equal(enginePayment('click', [6], tree('$13.045'), payment('requested', '$13.04'))?.why, 'over');
});
