// Money figures in rendered text, read the same way wherever sleight checks a payment: turbo's page read
// (direct-browser/v3-context.mjs readPaymentPage, run in the page's utility world) and the engine-path guard
// (payment-gate.mjs, run in the engine's REPL). Both functions are closure-free, so each runner defines them by name.

// Each figure in the lines: { value, cur, mark, chosen, minus, at, text }, and the parser the amount goes through.
export function moneyFigures(lines, maximum = true) {
  const CODES = 'USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW|RUB|PLN|CZK|TRY|ZAR|AED|SAR|THB|ILS|PHP|IDR|VND|NGN|TWD';
  const SIGNS = '€£¥₹₩₽₺₪฿₫₱₦';
  const MAGNITUDE = '(?:millions?|millones|milliarden|mio|mil|mm|mrd|md|mln|mn|m|bn|bil|billion|b|tn|trillion|thousand|tausend|tys|k|lakh|lacs|crore|grand|g|hundred|e3|万|億)';
  const magnitudeEnd = '(?![\\p{L}\\p{N}_])';
  // Grouping belongs to one figure, before currency association and bare-number filtering.
  const NUM = `\\d(?:[\\d.,\\s'’]*\\d)?(?:[.\\s]*${MAGNITUDE}${magnitudeEnd}\\.?)?`;
  const figure = new RegExp(
    `(?:\\b(${CODES})\\s*)?((?:US|CA|AU|NZ|HK|SG|MX|NT|A|C|S|R)?\\$|[${SIGNS}]|Rs\\.?)\\s*(${NUM})(?:\\s*(${CODES})(?![A-Za-z0-9]))?` +
    `|\\b(${CODES})\\s*(${NUM})` +
    `|(?<![\\w.,])(${NUM})\\s*(${CODES}(?![A-Za-z0-9])|\\$(?!\\s*\\d)|[${SIGNS}]|US dollars?\\b|dollars?\\b|euros?\\b|pounds?\\b|bucks\\b|yen\\b|円)` +
    `|(?<![\\w.,])(${NUM})` +
    `|(￼)` +
    `|\\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|and)[\\s-]+)+)(dollars?|euros?|pounds?|bucks)\\b`, 'giu');
  const SYMBOL = { '$': '$', 'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'NZ$': 'NZD', 'HK$': 'HKD', 'SG$': 'SGD', 'S$': 'SGD',
    'MX$': 'MXN', 'NT$': 'TWD', 'R$': 'BRL', '€': 'EUR', '£': 'GBP', '¥': '¥', '₹': 'INR', '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', '₪': 'ILS',
    '฿': 'THB', '₫': 'VND', '₱': 'PHP', '₦': 'NGN', 'rs': 'Rs', 'rs.': 'Rs', 'dollar': '$', 'dollars': '$', 'euro': 'EUR', 'euros': 'EUR',
    'pound': 'GBP', 'pounds': 'GBP', 'buck': '$', 'bucks': '$', 'us dollar': 'USD', 'us dollars': 'USD', 'yen': 'JPY', '円': 'JPY' };
  const currency = token => { const t = token?.replace(/\.$/, ''); return t && (SYMBOL[t] ?? SYMBOL[t.toUpperCase()] ?? SYMBOL[t.toLowerCase()] ?? t.toUpperCase()); };
  const GENERIC = { '$': ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'TWD'], '¥': ['JPY', 'CNY'], 'Rs': ['INR', 'PKR', 'LKR', 'NPR'] };
  const sameCurrency = (a, b) => !a || !b || a === b || !!GENERIC[a]?.includes(b) || !!GENERIC[b]?.includes(a);
  // A code consumed as the prior figure's suffix still denominates the next figure.
  const currencyToken = `(?:(?<![A-Za-z])(${CODES})(?![A-Za-z0-9])|((?:US|CA|AU|NZ|HK|SG|MX|NT|A|C|S|R)?\\$|[${SIGNS}]|\\bRs\\.?|\\bUS dollars?\\b\\.?|\\bdollars?\\b\\.?|\\beuros?\\b\\.?|\\bpounds?\\b\\.?|\\bbucks\\b\\.?|\\byen\\b\\.?|円))`;
  const currencyBefore = new RegExp(currencyToken + `[\\s'’]*$`, 'i');
  const currencyAfter = new RegExp(`^[\\s'’]*` + currencyToken, 'i');
  const currencyStart = new RegExp(`^[\\s'’]*(?:${CODES}|US dollars?|dollars?|euros?|pounds?|bucks|yen|円)`, 'i');
  const PAY = new Set('total amount due pay paying payment payable price cost charge charged charges charging billed billing bill owe owed owes invoice invoiced'.split(' '));
  const FILL = new Set('of is are will be only now today just about approx approximately currently a an the in on at for to your you re our we my this that it its s then also final full overall est estimated usd eur gbp cad aud'.split(' '));
  const COUNTED = /^(?:items?|pcs|pieces?|units?|qty|x|×|days?|hours?|mins?|minutes?|years?|months?|weeks?|payments?|installments?|points?|pts|interest|percent|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|st|nd|rd|th)$/i;
  const parse = (raw, maximum = true) => {
    if (!/^\d(?:[\d.,\s'’]*\d)?$/.test(String(raw).trim())) return Infinity;
    // Spaces and apostrophes group digits only. They cannot join a decimal to another figure.
    const run = String(raw).trim();
    if (/[\s'’]/.test(run) && !/^\d{1,3}(?:[.,\s'’]\d{3})+(?:[.,]\d+)?$/.test(run)) return Infinity;
    // For a user amount, a single separator can never increase the authorized value.
    const ambiguous = /^(\d+)[.,\s'’](\d{3})$/.exec(run);
    if (!maximum && ambiguous) return Number(ambiguous[1] + '.' + ambiguous[2]);
    const grouped = /^(\d+)(?:[.,\s'’]\d{3})+$/.exec(String(raw).trim());
    if (maximum && grouped && (Number(grouped[1]) > 0 || /[\s'’]/.test(run))) return Number(String(raw).replace(/[.,\s'’]/g, ''));
    let s = String(raw).replace(/[\s'’]/g, '');
    const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? ',' : '.', grouping = comma > dot ? '.' : ',';
      const parts = s.split(decimal);
      if (parts.length !== 2 || !/^\d+$/.test(parts[1]) ||
          !new RegExp('^\\d{1,3}(?:\\' + grouping + '\\d{3})+$').test(parts[0])) return Infinity;
      s = parts[0].split(grouping).join('') + '.' + parts[1];
    } else if (comma >= 0 || dot >= 0) {
      const parts = s.split(comma >= 0 ? ',' : '.');
      if (parts.some(p => !/^\d+$/.test(p))) return Infinity;
      if (parts.length > 2) return parts.slice(1).every(p => p.length === 3) ? Number(parts.join('')) : Infinity;
      const decimal = Number(parts.join('.'));
      // Leading-zero dot decimals stay fractions. Comma page figures retain int26's grouped reading.
      return maximum && (comma >= 0 && parts[1].length !== 2 || Number(parts[0]) > 0 && parts[1].length === 3) ? Number(parts.join('')) : decimal;
    }
    return Number(s);
  };
  const words = text => text.toLowerCase().match(/\p{L}+|×/gu) ?? [];
  const digit = ch => { const c = ch.codePointAt(0); let z = c; while (/\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--; return String((c - z) % 10); };
  // Preserve the reference marker's meaning before NFKC expands № to "No".
  const norm = text => String(text).split('№').map(part => part.normalize('NFKC')).join('№').replace(/[­​-‏⁠﻿]/g, '').replace(/\p{Nd}/gu, d => /[0-9]/.test(d) ? d : digit(d))
    .replace(/\.{2,}|…|_{2,}|-{3,}|[·•]/g, ' ').replace(/\s+/g, ' ').trim();
  const unparen = text => { let t = text; for (let before; before !== t;) { before = t; t = t.replace(/\([^()]*\)|\[[^\[\]]*\]/g, ' '); } return t; };
  const lastBreak = text => Math.max(...[...text.matchAll(/[.;!?](?=\s|$)/g)].map(x => x.index), -1);
  const before = text => { const t = unparen(text); return t.slice(lastBreak(t) + 1); };
  const after = text => { const t = unparen(text.replace(/^[\s)\]]+/, '')), hard = /[.;!?](?=\s|$)/.exec(t); return hard ? t.slice(0, hard.index) : t; };
  // U+E000 and U+E001 are private marks put on the text of chosen controls; they are not read.
  const figures = [];
  lines.forEach((rawText, i) => {
    const chosen = //.test(rawText), normalized = norm(rawText.replace(/[-]/g, ''));
    const prefixed = new Set();
    const text = normalized.replace(/[#№](\d+)/g, (whole, digits, at) => {
      const left = normalized.slice(0, at), right = normalized.slice(at + whole.length);
      // Only a plain reference integer may disappear. Currency on either side or a continuing
      // number makes this a figure, including an unlabelled grouped run such as #1 500.
      const reference = !/^[.,'’\p{L}\p{N}_]|^\s+\d/u.test(right) &&
        !new RegExp('^[.\\s]*' + MAGNITUDE + magnitudeEnd, 'iu').test(right) &&
        !currencyBefore.test(left) && !currencyAfter.test(right) && !currencyStart.test(right);
      if (reference) return whole[0] + ' '.repeat(digits.length);
      prefixed.add(at + 1);
      return whole;
    });
    const all = [...text.matchAll(figure)];
    let start = 0;
    all.forEach((m, k) => {
      // As before, an unlabelled two-decimal figure counts without a pay word.
      // A bare unit such as "2 m" or "5G" cannot borrow the next price's currency.
      const hasMagnitude = new RegExp(MAGNITUDE + magnitudeEnd + '\\.?$', 'iu').test(m[9] ?? '');
      // The marker separates a denomination from its number without hiding it (USD #1500).
      const preceding = currencyBefore.exec(text.slice(0, m.index).replace(/[#№]$/, ' '));
      const following = !hasMagnitude && currencyAfter.exec(text.slice(m.index + m[0].length));
      const adjacent = preceding || following;
      const bare = !adjacent && m[9] !== undefined && !/[.,]\d{2}(?!\d)/.test(m[9].replace(new RegExp('[.\\s]*' + MAGNITUDE + magnitudeEnd + '\\.?$', 'iu'), ''));
      const mark = m[10] !== undefined, spelled = m[11] !== undefined;
      const seg = text.slice(start, m.index), tail = text.slice(m.index + m[0].length, all[k + 1]?.index ?? text.length);
      if (bare && !prefixed.has(m.index)) {
        const label = words(before(seg)).filter(w => !FILL.has(w));
        // A grouped figure after a pay word still counts, even before "items" or "%".
        if (!PAY.has(label.at(-1)) || /^\d+$/.test(m[9]) && (COUNTED.test(words(after(tail))[0] ?? '') || /^\s*%/.test(tail))) return;
      }
      // A prefixed figure (#5) or a bare percent doesn't consume the pay word, so a later bare figure still counts (sa1z review).
      if (!prefixed.has(m.index) && !(bare && /^\s*%/.test(tail))) start = m.index + m[0].length;
      // A figure's own denomination wins. Conflicting own or neighbouring tokens make its value unreadable.
      const suffix = m[8] ?? m[12], own = [m[1], m[4], m[5], suffix, m[2]].filter(Boolean).map(currency);
      const neighbours = [preceding?.[1] ?? preceding?.[2], following?.[1] ?? following?.[2]].filter(Boolean).map(currency);
      const cur = own[0] ?? neighbours[0];
      const currencyConflict = [...own, ...neighbours].some(c => !sameCurrency(c, cur));
      // A letter straight after the digits ("$5OO.00") is a lookalike digit: a figure we cannot read.
      // № previously expanded to "No" here; keep that fail-closed boundary after an earlier figure.
      const glued = !bare && !mark && (/^[\p{L}\p{N}№]/u.test(text.charAt(m.index + m[0].length)) || /\dUS dollars?\b/i.test(m[0]));
      const brokenCurrency = prefixed.has(m.index) && currencyStart.test(text.slice(m.index + m[0].length)) && !following;
      const magnitude = !!cur && new RegExp('^[.\\s]*' + MAGNITUDE + magnitudeEnd, 'iu').test(tail);
      figures.push({ value: mark || spelled || glued || magnitude || currencyConflict || brokenCurrency ? Infinity : parse(m[3] ?? m[6] ?? m[7] ?? m[9], maximum), cur, mark, chosen, minus: /[-−–]$/.test(seg), at: i + ':' + m.index, text: m[0] });
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
// A number next to a currency sign or code counts in that currency, including a code shared by two figures.
// Other bare numbers count only straight after a pay word ("Total 500"), not as counts or dates.
// Known limit: a page that hides its real total, or states a smaller total than it charges, is not caught.
// quoteOnly checks whether the user's amount has one reading, without applying the page-figure ceiling.
// Never mode uses it before its opt-out. Other modes retain their existing figure comparison.
export function moneyConflicts(lines, amount, pageCurrency, quoteOnly = false) {
  const { figures, parse } = moneyFigures(lines);
  const GENERIC = { '$': ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'TWD'], '¥': ['JPY', 'CNY'], 'Rs': ['INR', 'PKR', 'LKR', 'NPR'] };
  const same = (a, b) => !a || !b || a === b || !!GENERIC[a]?.includes(b) || !!GENERIC[b]?.includes(a);
  const eps = 0.005;
  const entered = moneyFigures([String(amount)]).figures;
  const quoted = entered.length === 1 && entered[0].cur ? entered[0] : undefined;
  // Only the same whole-number grouping on a denominated page figure can settle a grouped user quote.
  // A dot stays decimal on the user side; 1.304 cannot borrow the larger reading of $1,304.00.
  const raw = (quoted ? String(amount).replace(/[^\d.,\s'’]/g, '').trim() : String(amount)).normalize('NFKC').replace(/\s/g, ' ');
  const groupedQuote = /^[1-9]\d{0,2}([, '’])\d{3}$/.test(raw) && (!quoteOnly || raw.includes(',')) && figures.some(f => f.cur && Number.isFinite(f.value) &&
    same(f.cur, pageCurrency ?? quoted?.cur) && [raw, raw + '.00'].includes(f.text.match(/\d(?:[\d.,\s'’]*\d)?/)?.[0]));
  const A = parse(raw, groupedQuote);
  if (!Number.isFinite(A) || quoted && !Number.isFinite(quoted.value)) return true;
  // Cent rounding cannot choose between different readings of the user's quote. A matching comma-grouped
  // whole number is settled above; a single space or apostrophe keeps both readings even on a matching page.
  if (quoteOnly) return !groupedQuote && parse(raw) !== parse(raw, false);
  const reference = /^[A-Za-z]{3}$/.test(pageCurrency ?? '') ? pageCurrency.toUpperCase() : figures.find(f => !f.mark && f.cur && Math.abs(f.value - A) < eps)?.cur;
  return figures.some(f => f.mark || !same(f.cur, reference) || !(f.value <= A + eps)) ||
    figures.filter(f => f.chosen && !f.minus && Math.abs(f.value - A) >= eps).reduce((sum, f) => sum + f.value, 0) > A + eps;
}
