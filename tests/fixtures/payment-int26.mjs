import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as figures from './payment-int26/payment-figures.mjs';
import { moneyFigures } from '../../plugins/sleight/lib/payment-figures.mjs';
import { paymentWords, refundableName } from '../../plugins/sleight/lib/direct-browser/rules.mjs';

// Keep the historical payment sources unchanged; only their module wrapper is removed for this offline VM.
const source = readFileSync(new URL('payment-int26/payment-gate.txt', import.meta.url), 'utf8');
export const int26 = { ...figures, ...runInNewContext(source.replace(/^import .*$/gm, '').replace(/^export /gm, '') +
  ';({enginePayment,namedAmount})', { ...figures, paymentWords, refundableName }) };

const generic = { '$': ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'TWD'], '¥': ['JPY', 'CNY'], 'Rs': ['INR', 'PKR', 'LKR', 'NPR'] };
const same = (a, b) => !a || !b || a === b || !!generic[a]?.includes(b) || !!generic[b]?.includes(a);
const numeric = text => text.normalize('NFKC').replace(/\s/g, ' ').replace(/[^\d., '’]/g, '').trim();
const bound = (fs, amount, currency) => fs.every(f => !f.mark && Number.isFinite(f.value) && f.value <= amount + 0.005 && same(f.cur, currency)) &&
  fs.filter(f => f.chosen && !f.minus && Math.abs(f.value - amount) >= 0.005).reduce((sum, f) => sum + f.value, 0) <= amount + 0.005;

export function exactAmountMatch(lines, quote, currency, never = false) {
  const raw = numeric(String(quote));
  // Whole-number grouping may match exactly. A lone dot followed by three digits is never exempt.
  const european = /^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(raw);
  if (!european && !/^(?:\d+(?:\.\d{1,2})?|[1-9]\d{0,2}(?:[, '’]\d{3})+(?:\.\d{2})?)$/.test(raw)) return false;
  const value = Number(european ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/[, '’]/g, ''));
  const current = moneyFigures(lines).figures;
  const suffixYen = /(?:円|yen)\s*$/i.test(String(quote));
  const match = current.some(f => f.cur && Math.abs(f.value - value) < 0.005 && (!suffixYen || f.cur === 'JPY'));
  // The user's never setting already opts out of the other-figure and currency checks on int26.
  // Its exact-amount exception still needs a finite, denominated page figure and an unambiguous user value.
  const reference = /^[A-Z]{3}$/.test(currency ?? '') ? currency : current.find(f => f.cur && Math.abs(f.value - value) < 0.005)?.cur;
  return match && (never || bound(current, value, reference) && bound(figures.moneyFigures(lines).figures, value, reference));
}

export function statedYen(lines, quote, currency) {
  if (currency !== undefined && currency !== 'JPY') return false;
  if (!lines.some(line => /(?:円|\byen\b|\bJPY\b)/i.test(line))) return false;
  const current = moneyFigures(lines).figures, value = Number(String(quote).replace(/[, '’]/g, ''));
  return current.length > 0 && Number.isFinite(value) && current.every(f => f.cur === 'JPY') && bound(current, value, 'JPY');
}
