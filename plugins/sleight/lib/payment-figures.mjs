// Money figures in rendered text, read the same way wherever sleight checks a payment: turbo's page read
// (direct-browser/v3-context.mjs readPaymentPage, run in the page's utility world) and the engine-path guard
// (payment-gate.mjs, run in the engine's REPL). Both functions are closure-free, so each runner defines them by name.

// Each figure in the lines: { value, cur, mark, chosen, minus, at, text }, and the parser the amount goes through.
export function moneyFigures(lines) {
  const CODES = 'USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW|RUB|PLN|CZK|TRY|ZAR|AED|SAR|THB|ILS|PHP|IDR|VND|NGN|TWD';
  const SIGNS = '€£¥₹₩₽₺₪฿₫₱₦', NUM = '\\d(?:[\\d.,]*\\d)?';
  const figure = new RegExp(
    `(?:\\b(${CODES})\\s*)?((?:US|CA|AU|NZ|HK|SG|MX|NT|A|C|S|R)?\\$|[${SIGNS}]|Rs\\.?)\\s*(${NUM})(?:\\s*(${CODES})(?![A-Za-z]))?` +
    `|\\b(${CODES})\\s*(${NUM})` +
    `|(?<![\\w.,])(${NUM})\\s*(${CODES}(?![A-Za-z])|[${SIGNS}]|dollars?\\b|euros?\\b|pounds?\\b|bucks\\b)` +
    `|(?<![\\w.,])(\\d[\\d,]*[.,]\\d{2})(?!\\d)` +
    `|(?<![#№\\w.,])(${NUM})` +
    `|(￼)` +
    `|\\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|and)[\\s-]+)+)(dollars?|euros?|pounds?|bucks)\\b`, 'giu');
  const SYMBOL = { '$': '$', 'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'NZ$': 'NZD', 'HK$': 'HKD', 'SG$': 'SGD', 'S$': 'SGD',
    'MX$': 'MXN', 'NT$': 'TWD', 'R$': 'BRL', '€': 'EUR', '£': 'GBP', '¥': '¥', '₹': 'INR', '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', '₪': 'ILS',
    '฿': 'THB', '₫': 'VND', '₱': 'PHP', '₦': 'NGN', 'rs': 'Rs', 'rs.': 'Rs', 'dollar': '$', 'dollars': '$', 'euro': 'EUR', 'euros': 'EUR',
    'pound': 'GBP', 'pounds': 'GBP', 'buck': '$', 'bucks': '$' };
  const PAY = new Set('total amount due pay paying payment payable price cost charge charged charges charging billed billing bill owe owed owes invoice invoiced'.split(' '));
  const FILL = new Set('of is are will be only now today just about approx approximately currently a an the in on at for to your you re our we my this that it its s then also final full overall est estimated usd eur gbp cad aud'.split(' '));
  const COUNTED = /^(?:items?|pcs|pieces?|units?|qty|x|×|days?|hours?|mins?|minutes?|years?|months?|weeks?|payments?|installments?|points?|pts|interest|percent|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|st|nd|rd|th)$/i;
  const parse = raw => {
    let s = String(raw).replace(/\s/g, '');
    const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (comma >= 0) s = /,\d{2}$/.test(s) && s.indexOf(',') === comma ? s.replace(',', '.') : s.replace(/,/g, '');
    else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
    return Number(s);
  };
  const words = text => text.toLowerCase().match(/\p{L}+|×/gu) ?? [];
  const digit = ch => { const c = ch.codePointAt(0); let z = c; while (/\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--; return String((c - z) % 10); };
  const norm = text => String(text).normalize('NFKC').replace(/[­​-‏⁠﻿]/g, '').replace(/\p{Nd}/gu, d => /[0-9]/.test(d) ? d : digit(d))
    .replace(/\.{2,}|…|_{2,}|-{3,}|[·•]/g, ' ').replace(/\s+/g, ' ').trim();
  const unparen = text => { let t = text; for (let before; before !== t;) { before = t; t = t.replace(/\([^()]*\)|\[[^\[\]]*\]/g, ' '); } return t; };
  const lastBreak = text => Math.max(...[...text.matchAll(/[.;!?](?=\s|$)/g)].map(x => x.index), -1);
  const before = text => { const t = unparen(text); return t.slice(lastBreak(t) + 1); };
  const after = text => { const t = unparen(text.replace(/^[\s)\]]+/, '')), hard = /[.;!?](?=\s|$)/.exec(t); return hard ? t.slice(0, hard.index) : t; };
  // U+E000 and U+E001 are private marks put on the text of chosen controls; they are not read.
  const figures = [];
  lines.forEach((rawText, i) => {
    const chosen = //.test(rawText), text = norm(rawText.replace(/[-]/g, '')), all = [...text.matchAll(figure)];
    let start = 0;
    all.forEach((m, k) => {
      const bare = m[10] !== undefined, mark = m[11] !== undefined, spelled = m[12] !== undefined;
      const seg = text.slice(start, m.index), tail = text.slice(m.index + m[0].length, all[k + 1]?.index ?? text.length);
      if (bare) {
        const label = words(before(seg)).filter(w => !FILL.has(w));
        if (!PAY.has(label.at(-1)) || COUNTED.test(words(after(tail))[0] ?? '') || /^\s*%/.test(tail)) return;
      }
      start = m.index + m[0].length;
      const suffix = m[8] ?? m[13], code = m[1] ?? m[4] ?? m[5] ?? (suffix && /^[A-Za-z]{3}$/.test(suffix) ? suffix : undefined);
      const sign = m[2] ?? (suffix && !/^[A-Za-z]{3}$/.test(suffix) ? suffix : undefined);
      const cur = code ? code.toUpperCase() : sign ? SYMBOL[sign] ?? SYMBOL[sign.toUpperCase()] ?? SYMBOL[sign.toLowerCase()] : undefined;
      // A letter straight after the digits ("$5OO.00") is a lookalike digit: a figure we cannot read.
      const glued = !bare && !mark && /^\p{L}/u.test(text.charAt(m.index + m[0].length));
      figures.push({ value: mark || spelled || glued ? Infinity : parse(m[3] ?? m[6] ?? m[7] ?? m[9] ?? m[10]), cur, mark, chosen, minus: /[-−–]$/.test(seg), at: i + ':' + m.index, text: m[0] });
    });
  });
  return { figures, parse };
}

// Does any rendered figure show more than the amount? The rule reads no wording. Every money figure in the payment context (any
// currency, any label, any sign) that is larger than the amount asks, so a part, a unit price, a discount or a tax at or below the
// amount does not, and a figure above it never does, whatever its label says. Also asking:
//   a currency that differs from the page's currency (or from the one the amount is written in), however small the figure;
//   a mark (an image or canvas that may hold a figure), a spelled-out number and digits with a letter glued on, which we cannot read;
//   a figure that cannot be parsed;
//   chosen controls (checked box or radio, aria-checked, selected option...) whose figures, the amount itself aside, together
//   exceed the amount: a chosen figure at or below the amount is a part of the total, but the add-ons the user will pay add up.
// A bare number with no currency counts only straight after a pay word ("Total 500"), and not as a count or a date.
// Known limit: a page that hides its real total, or states a smaller total than it charges, is not caught.
export function moneyConflicts(lines, amount, pageCurrency) {
  const { figures, parse } = moneyFigures(lines);
  const GENERIC = { '$': ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'TWD'], '¥': ['JPY', 'CNY'], 'Rs': ['INR', 'PKR', 'LKR', 'NPR'] };
  const same = (a, b) => !a || !b || a === b || !!GENERIC[a]?.includes(b) || !!GENERIC[b]?.includes(a);
  const eps = 0.005;
  const A = parse(String(amount).replace(/[^\d.,]/g, ''));
  const reference = /^[A-Za-z]{3}$/.test(pageCurrency ?? '') ? pageCurrency.toUpperCase() : figures.find(f => !f.mark && f.cur && Math.abs(f.value - A) < eps)?.cur;
  return figures.some(f => f.mark || !same(f.cur, reference) || !(f.value <= A + eps)) ||
    figures.filter(f => f.chosen && !f.minus && Math.abs(f.value - A) >= eps).reduce((sum, f) => sum + f.value, 0) > A + eps;
}
